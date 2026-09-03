// 대화 엔진. 우선순위: 세션 문맥(연락처 수집·번호 선택) → 인텐트 룰 → 지식베이스(FAQ) → LLM(스텁) → 폴백.
// LLM 실키는 CHAT_LLM_LIVE=true 승인 후에만 사용. [승인 필요] 전까지 스텁 유지.
// 멀티턴: 세션 문맥(src/lib/session.ts)으로 폴백 제안 번호 선택("1"/"2번")과
// 에스컬레이션 접수 후 연락처 수집을 지원한다(웹·카카오 공통, 서버 측 처리).
// 표기 흔들림(동의어·띄어쓰기·오타)은 src/lib/normalize 에서 흡수한다 — 룰은 원문과 압축형 양쪽에 시도.
// 상담원 전환은 (1) 고객 요청 (2) 정책 키워드(불만·긴급) (3) 신뢰도 임계 미만 연속 발생 세 경로로 일어나며,
// 이관 시 규칙 기반 대화 요약(src/lib/handoff)을 티켓에 붙인다 — 사유 코드는 AICC-Core 어휘를 따른다.
import { matchKnowledge, searchKnowledge, buildCitation, type Citation, type KBEntry } from '@/lib/knowledge';
import { RULES, type Rule } from '@/lib/rules';
import { prepare } from '@/lib/normalize';
import { listKB, getRuleOverride, matchCustomRule } from '@/lib/adminStore';
import { appendTurn, getSession, setSlot, updateSession } from '@/lib/session';
import { createTicket, queuePosition } from '@/lib/escalation';
import { buildHandoffSummary, type HandoffReason } from '@/lib/handoff';
import { generateGroundedAnswer, type CompleteOptions, type GroundingDoc, type LLMFailureReason, type LLMMessage } from '@/lib/llm';

export const LLM_LIVE = process.env.CHAT_LLM_LIVE === 'true';

/** 실행 시점에 게이트를 다시 읽는다(모듈 로드 후 환경이 바뀌는 테스트·재구성 대응). [승인 필요] */
function llmEnabled(): boolean {
  return process.env.CHAT_LLM_LIVE === 'true';
}

export type ReplySource = 'rule' | 'kb' | 'llm' | 'fallback' | 'empty' | 'context';

/** 폴백 시 사용자에게 제안하는 연관 FAQ 후보. */
export interface ChatSuggestion {
  id: string; // KB 항목 id
  question: string; // 그대로 재전송하면 KB가 답하는 질문 문구
}

export interface ChatReply {
  reply: string;
  intent: string;
  escalate: boolean; // 상담원 연결 제안 여부
  source: ReplySource;
  kbId?: string; // 지식베이스 매칭 시 항목 id(로그·품질 분석용)
  suggestions?: ChatSuggestion[]; // 폴백 시 연관 FAQ 제안(최대 3)
  ticketId?: string; // 이 턴에서 접수(또는 재사용)된 에스컬레이션 티켓 id
  citation?: Citation; // KB 답변의 근거(출처 항목 + 원문 문장) — 생성 요약이 아니라 원문 인용
  /**
   * 엔진 내부 신뢰도(0~1). 상담원 자동 전환 판정에만 쓰는 정책값이며,
   * 측정된 정확도·성능 지표가 아니다(화면에 성능 수치로 표기하지 않는다).
   */
  confidence: number;
  /** 접수 대기 상태 — 접수순 표시용(예상 대기시간을 계산하지 않는다). */
  queue?: { position: number; waiting: number };
  /** 이관 사유 코드(AICC-Core Handoff 어휘). 에스컬레이션이 일어난 턴에만 채워진다. */
  handoffReason?: HandoffReason;
  /** LLM 경로가 실패해 결정적 폴백으로 되돌아간 사유(로그·모니터링용, 고객에게 노출하지 않는다). */
  llmFailure?: LLMFailureReason;
}

// ---- 신뢰도·자동 전환 정책 ----
// 값은 운영 정책 상수다. 측정된 품질 지표가 아니며 화면에 성능 수치로 노출하지 않는다.
// 환경변수로 테넌트별 조정이 가능하도록 열어 둔다.

function envNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(raw, min), max);
}

/** 이 값 미만이면 '자신 없는 응답'으로 본다. */
export const CONFIDENCE_THRESHOLD = envNumber('CHAT_CONFIDENCE_THRESHOLD', 0.4, 0, 1);
/** 자신 없는 응답이 이만큼 연속되면 상담원으로 자동 전환한다. */
export const LOW_CONFIDENCE_STREAK_LIMIT = Math.round(envNumber('CHAT_LOW_CONFIDENCE_STREAK', 2, 1, 10));

/** 응답 경로별 기본 신뢰도(정책 상수). */
const SOURCE_CONFIDENCE: Record<ReplySource, number> = {
  context: 0.9,
  rule: 0.85,
  kb: 0.7,
  llm: 0.3,
  fallback: 0.15,
  empty: 1,
};

/** 정책상 상담원이 처리해야 하는 인텐트(고객 '요청'이 아니라 회사 정책으로 넘기는 경우). */
const POLICY_INTENTS = new Set(['complaint', 'urgent']);

/** KB 매칭 점수·매칭 종류로 신뢰도를 보정한다. 오타 보정만으로 걸린 답은 낮게 본다. */
function kbConfidence(score: number, matched: { kind: string }[]): number {
  const base = Math.min(0.45 + score * 0.1, 0.95);
  const fuzzyOnly = matched.length > 0 && matched.every((m) => m.kind === 'fuzzy');
  return Math.round((fuzzyOnly ? base * 0.7 : base) * 100) / 100;
}

/** KB 항목으로 응답을 만들 때 근거 인용을 함께 붙인다. */
function kbReply(entry: KBEntry, query: string, matched: { keyword: string; kind: string }[] = [], score = 3): ChatReply {
  return {
    reply: entry.answer,
    intent: `kb:${entry.category}`,
    escalate: false,
    source: 'kb',
    kbId: entry.id,
    citation: buildCitation(entry, query, matched),
    confidence: kbConfidence(score, matched),
  };
}

/**
 * 룰 매칭 — 원문과 압축형(공백·구두점 제거) 양쪽에 시도해 "상 담원" 같은 표기도 잡는다.
 * deny 패턴이 걸리면 매칭하지 않는다(예: '환불 얼마'가 요금 인텐트로 새는 것 방지).
 */
export function matchRule(rule: Rule, text: string, compactText: string): boolean {
  if (rule.deny && (rule.deny.test(text) || rule.deny.test(compactText))) return false;
  return rule.test.test(text) || rule.test.test(compactText);
}

// ---- 연락처 수집(에스컬레이션 후속 턴) ----
const PHONE_RE = /(01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}|0\d{1,2}[-\s.]?\d{3,4}[-\s.]?\d{4})/;
const EMAIL_RE = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
const SKIP_RE = /(건너뛰|괜찮|없어요|없습니다|아니요|아니오|나중에|스킵|skip)/i;

/** 메시지에서 전화번호/이메일 추출. 없으면 null. */
export function extractContact(text: string): string | null {
  const phone = text.match(PHONE_RE)?.[0];
  if (phone) return phone.replace(/\s+/g, '');
  const email = text.match(EMAIL_RE)?.[0];
  return email ?? null;
}

/** 폴백 제안 번호 선택("1", "2번", "3.") 파싱. 범위 밖이면 null. */
function parsePick(text: string, max: number): number | null {
  const m = text.match(/^([1-9])\s*(번|\.)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= max ? n : null;
}

/** 세션 문맥 + 현재 티켓 상태로 규칙 기반 이관 요약을 만든다(마스킹 완료 평문). */
function summaryFor(sessionId: string, reason: HandoffReason, ticketId?: string): string {
  const ctx = getSession(sessionId);
  return buildHandoffSummary({
    sessionId,
    channel: 'web',
    reason,
    turns: ctx.turns ?? [],
    slots: ctx.slots ?? {},
    pendingSlots: ctx.slots?.contact ? [] : ['contact'],
    ...(ticketId ? { ticketId } : {}),
  }).text;
}

function computeReply(message: string, sessionId = 'anon'): ChatReply {
  const text = (message || '').trim();
  if (!text) return { reply: '메시지를 입력해 주세요.', intent: 'empty', escalate: false, source: 'empty', confidence: 1 };

  const ctx = getSession(sessionId);

  // 0-a) 연락처 수집 대기 중이면 이번 턴을 연락처/건너뛰기로 우선 해석
  if (ctx.awaitingContact) {
    const contact = extractContact(text);
    if (contact) {
      // 열린 티켓에 연락처 첨부(세션당 열린 티켓 재사용) — 영구 저장은 [승인 필요]
      setSlot(sessionId, 'contact', contact);
      const reasonCode = ctx.handoffReason ?? 'customer_request';
      const { ticket } = createTicket({ sessionId, contact, summary: summaryFor(sessionId, reasonCode) });
      updateSession(sessionId, { awaitingContact: false, ticketId: ticket.id });
      const q = queuePosition(ticket.id);
      return {
        reply:
          `연락처가 접수번호 ${ticket.id}에 등록됐어요. 상담원이 순서대로 연락드릴게요.` +
          (q ? ` 현재 접수 순번은 ${q.position}번입니다.` : '') +
          ' 그동안 다른 궁금한 점도 편하게 물어봐 주세요.',
        intent: 'contact_captured',
        escalate: false,
        source: 'context',
        ticketId: ticket.id,
        confidence: SOURCE_CONFIDENCE.context,
        ...(q ? { queue: q } : {}),
      };
    }
    if (SKIP_RE.test(text)) {
      updateSession(sessionId, { awaitingContact: false });
      return {
        reply: '네, 알겠습니다. 접수는 유지되니 이 창을 열어두시면 상담원이 순서대로 응대해 드릴게요. 다른 궁금한 점이 있으면 말씀해 주세요.',
        intent: 'contact_skipped',
        escalate: false,
        source: 'context',
        confidence: SOURCE_CONFIDENCE.context,
        ...(ctx.ticketId ? { ticketId: ctx.ticketId } : {}),
      };
    }
    // 연락처도 건너뛰기도 아니면 일반 질문으로 간주하고 수집 상태 해제 후 계속 진행
    updateSession(sessionId, { awaitingContact: false });
  }

  // 0-b) 직전 폴백 제안의 번호 선택("1", "2번") 처리
  const pending = ctx.pendingSuggestions ?? [];
  if (pending.length) {
    const pick = parsePick(text, pending.length);
    if (pick !== null) {
      const chosen = pending[pick - 1];
      const entry = listKB().find((e) => e.id === chosen.id);
      updateSession(sessionId, { pendingSuggestions: undefined });
      if (entry) return kbReply(entry, chosen.question);
      // 편집으로 항목이 사라진 경우 — 원래 질문 문구로 재처리
      return computeReply(chosen.question, sessionId);
    }
  }

  // 에스컬레이션 룰은 서버에서 즉시 접수하고 연락처를 요청한다.
  // 웹 위젯뿐 아니라 카카오 등 버튼이 없는 채널에서도 접수가 완결되도록 엔진에서 처리.
  const escalateWith = (baseReply: string, intentName: string, reasonCode: HandoffReason = 'customer_request'): ChatReply => {
    const reason = intentName.startsWith('rule:') ? intentName : `rule:${intentName}`;
    const { ticket, created } = createTicket({
      sessionId,
      reason,
      message: text,
      summary: summaryFor(sessionId, reasonCode),
    });
    updateSession(sessionId, {
      awaitingContact: true,
      ticketId: ticket.id,
      pendingSuggestions: undefined,
      handoffReason: reasonCode,
      lowConfidenceStreak: 0,
    });
    const q = queuePosition(ticket.id);
    const wait = q ? ` 현재 접수 순번은 ${q.position}번입니다.` : '';
    const tail = created
      ? `\n접수번호는 ${ticket.id}입니다.${wait} 연락받으실 전화번호나 이메일을 남겨주시면 순서대로 연락드릴게요. (원치 않으시면 "건너뛰기"라고 입력해 주세요)`
      : `\n이미 접수된 요청(${ticket.id})이 있어 이어서 도와드릴게요.${wait} 연락처를 남겨주시면 더 빠르게 연락드릴 수 있어요. (건너뛰려면 "건너뛰기")`;
    return {
      reply: baseReply + tail,
      intent: intentName,
      escalate: true,
      source: 'rule',
      ticketId: ticket.id,
      confidence: SOURCE_CONFIDENCE.rule,
      handoffReason: reasonCode,
      ...(q ? { queue: q } : {}),
    };
  };

  // 1) 인텐트 룰(관리 콘솔 오버라이드 반영: 비활성화 스킵·응답문 교체)
  const pre = prepare(text);
  for (const r of RULES) {
    const ov = getRuleOverride(r.intent);
    if (ov && ov.enabled === false) continue;
    if (matchRule(r, text, pre.compact)) {
      const baseReply = ov?.reply || r.reply;
      if (r.escalate === true) return escalateWith(baseReply, r.intent, POLICY_INTENTS.has(r.intent) ? 'policy' : 'customer_request');
      updateSession(sessionId, { pendingSuggestions: undefined });
      return { reply: baseReply, intent: r.intent, escalate: false, source: 'rule', confidence: SOURCE_CONFIDENCE.rule };
    }
  }

  // 1-b) 커스텀 시나리오 룰(관리 콘솔에서 키워드로 추가한 룰) — 내장 룰 다음, KB 이전
  const cr = matchCustomRule(text);
  if (cr) {
    if (cr.escalate) return escalateWith(cr.reply, cr.intent, 'policy');
    updateSession(sessionId, { pendingSuggestions: undefined });
    return { reply: cr.reply, intent: cr.intent, escalate: false, source: 'rule', confidence: SOURCE_CONFIDENCE.rule };
  }

  // 2) 지식베이스(FAQ) 매칭 — 관리 콘솔 편집분(런타임 스토어) 사용
  const entries = listKB();
  const kb = matchKnowledge(text, 2, entries);
  if (kb) {
    updateSession(sessionId, { pendingSuggestions: undefined });
    return kbReply(kb.entry, text, kb.matched, kb.score);
  }

  // 정답 확신은 없지만 근접한 FAQ가 있으면 후보로 제안(확신 매칭보다 낮은 문턱)
  const suggestions: ChatSuggestion[] = searchKnowledge(text, 3, entries).map((e) => ({ id: e.id, question: e.question }));
  updateSession(sessionId, { pendingSuggestions: suggestions.length ? suggestions : undefined });

  // 결정적 폴백 문구 — LLM이 없거나 실패해도 이 답변이 항상 남는다(빈 화면·무반응 금지).
  const fallbackReply = suggestions.length
    ? '정확한 답을 찾지 못했어요. 혹시 아래 질문 중 찾으시는 내용이 있나요? 번호(1~' + suggestions.length + ')로 답하셔도 돼요. 없다면 "상담원"이라고 입력해 주세요.'
    : '아직 제가 정확히 이해하지 못했어요. 조금 더 구체적으로 말씀해 주시거나, 상담원 연결을 원하시면 "상담원"이라고 입력해 주세요.';
  const fallbackConfidence = suggestions.length ? 0.25 : SOURCE_CONFIDENCE.fallback;

  // 3) LLM 경로 — 실제 생성은 비동기 진입점(replyToAsync)에서 수행한다.
  //    여기서는 "LLM을 시도할 자리"임을 source로만 표시하고, reply에는 실패 시 그대로 쓸 결정적 폴백을 담는다.
  //    [승인 필요] CHAT_LLM_LIVE=true 전까지 이 분기는 실행되지 않는다.
  if (llmEnabled()) {
    return {
      reply: fallbackReply,
      intent: 'fallback',
      escalate: true,
      source: 'llm',
      confidence: fallbackConfidence,
      ...(suggestions.length ? { suggestions } : {}),
    };
  }

  // 4) 최종 폴백 + 연관질문 제안(번호로도 선택 가능) + 상담원 제안
  return {
    reply: fallbackReply,
    intent: 'fallback',
    escalate: true,
    source: 'fallback',
    confidence: fallbackConfidence,
    ...(suggestions.length ? { suggestions } : {}),
  };
}

/** AI 생성 답변임을 알리는 고지 — 화면·채널 공통으로 답변 끝에 붙인다. */
export const AI_ANSWER_NOTICE = '(AI가 등록된 자료를 근거로 만든 답변이에요. 정확한 확인이 필요하시면 "상담원"이라고 입력해 주세요.)';

/**
 * LLM 보강 — 근거 자료(KB 후보)가 있을 때만 생성하고, 실패하면 결정적 폴백을 그대로 유지한다.
 * 자료가 없으면 아예 호출하지 않는다(환각 방지). 실패 사유는 llmFailure로 남겨 라우트가 로그에 기록한다.
 */
async function augmentWithLLM(text: string, sessionId: string, base: ChatReply, opts: CompleteOptions): Promise<ChatReply> {
  const entries = listKB();
  const docs: GroundingDoc[] = (base.suggestions ?? [])
    .map((s) => entries.find((e) => e.id === s.id))
    .filter((e): e is KBEntry => Boolean(e))
    .map((e) => ({ id: e.id, question: e.question, answer: e.answer }));

  if (!docs.length) return { ...base, source: 'fallback', llmFailure: 'not_configured' };

  // 직전 대화 문맥(현재 질문 턴은 이미 버퍼에 들어가 있으므로 제외)
  const turns = (getSession(sessionId).turns ?? []).slice(0, -1).slice(-6);
  const history: LLMMessage[] = turns
    .filter((t) => Boolean(t.text))
    .map((t) => ({ role: t.speaker === 'customer' ? ('user' as const) : ('assistant' as const), content: t.text }));

  const res = await generateGroundedAnswer({ question: text, docs, history }, opts);
  if ('failed' in res) return { ...base, source: 'fallback', llmFailure: res.failed };

  return {
    ...base,
    reply: `${res.text}\n\n${AI_ANSWER_NOTICE}`,
    intent: 'llm',
    source: 'llm',
    escalate: false,
    confidence: 0.55,
  };
}


/**
 * 대화 1턴 처리 — 문맥 버퍼 적재 → 응답 계산 → 신뢰도 임계 기반 상담원 자동 전환 판정.
 *
 * 자동 전환은 "답을 못 찾은 상태로 고객을 계속 붙잡아 두지 않는다"는 §9.3 취지를 챗봇에 적용한 것이다.
 * 임계·연속 횟수는 정책 상수(CONFIDENCE_THRESHOLD·LOW_CONFIDENCE_STREAK_LIMIT)이며 측정 지표가 아니다.
 */
export function replyTo(message: string, sessionId = 'anon'): ChatReply {
  const text = (message || '').trim();
  if (text) appendTurn(sessionId, { at: new Date().toISOString(), speaker: 'customer', text });
  return finalize(text, sessionId, computeReply(message, sessionId));
}

/**
 * 비동기 진입점 — 룰·KB로 답이 나오지 않고 LLM 게이트가 켜져 있을 때만 생성 모델을 호출한다.
 * LLM이 꺼져 있거나 실패하면 replyTo와 완전히 동일한 결정적 답변을 돌려준다(라우트는 항상 이 함수를 쓴다).
 */
export async function replyToAsync(message: string, sessionId = 'anon', opts: CompleteOptions = {}): Promise<ChatReply> {
  const text = (message || '').trim();
  if (text) appendTurn(sessionId, { at: new Date().toISOString(), speaker: 'customer', text });

  let result = computeReply(message, sessionId);
  if (result.source === 'llm') result = await augmentWithLLM(text, sessionId, result, opts);
  return finalize(text, sessionId, result);
}

/** 공통 마무리 — 신뢰도 기반 자동 전환 판정 후 봇 턴을 문맥 버퍼에 적재한다. */
function finalize(text: string, sessionId: string, result: ChatReply): ChatReply {
  const auto = maybeAutoEscalate(text, sessionId, result);
  if (auto.source !== 'empty') {
    appendTurn(sessionId, { at: new Date().toISOString(), speaker: 'bot', text: auto.reply, intent: auto.intent });
  }
  return auto;
}

/** 신뢰도가 임계 미만인 응답이 연속되면 상담원 접수로 전환한다. 이미 접수 흐름이면 건드리지 않는다. */
function maybeAutoEscalate(text: string, sessionId: string, result: ChatReply): ChatReply {
  // escalate=true 는 "상담원 연결을 제안했다"는 뜻이지 접수가 끝났다는 뜻이 아니다.
  // 실제 접수(ticketId)가 생긴 턴만 판정에서 제외한다.
  if (result.source === 'empty' || result.ticketId) {
    if (result.source !== 'empty') updateSession(sessionId, { lowConfidenceStreak: 0 });
    return result;
  }

  const ctx = getSession(sessionId);
  if (result.confidence >= CONFIDENCE_THRESHOLD) {
    if (ctx.lowConfidenceStreak) updateSession(sessionId, { lowConfidenceStreak: 0 });
    return result;
  }

  const streak = (ctx.lowConfidenceStreak ?? 0) + 1;
  if (streak < LOW_CONFIDENCE_STREAK_LIMIT) {
    updateSession(sessionId, { lowConfidenceStreak: streak });
    return result;
  }

  // 임계 미만이 연속으로 한도에 도달 — 접수하고 연락처를 요청한다.
  const { ticket, created } = createTicket({
    sessionId,
    reason: 'low_confidence',
    message: text,
    summary: summaryFor(sessionId, 'low_confidence'),
  });
  updateSession(sessionId, {
    awaitingContact: true,
    ticketId: ticket.id,
    handoffReason: 'low_confidence',
    lowConfidenceStreak: 0,
  });
  const q = queuePosition(ticket.id);
  const wait = q ? ` 현재 접수 순번은 ${q.position}번입니다.` : '';
  const lead = created
    ? `제가 계속 정확히 답변드리지 못하고 있어 상담원에게 연결해 드릴게요. 접수번호는 ${ticket.id}입니다.${wait}`
    : `이미 접수된 요청(${ticket.id})으로 상담원이 이어서 도와드릴게요.${wait}`;
  return {
    ...result,
    reply: `${result.reply}\n\n${lead} 지금까지 나눈 대화는 상담원에게 함께 전달됩니다. 연락받으실 전화번호나 이메일을 남겨주시면 순서대로 연락드릴게요. (원치 않으시면 "건너뛰기")`,
    escalate: true,
    ticketId: ticket.id,
    handoffReason: 'low_confidence',
    ...(q ? { queue: q } : {}),
  };
}
