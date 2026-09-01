// 대화 엔진. 우선순위: 세션 문맥(연락처 수집·번호 선택) → 인텐트 룰 → 지식베이스(FAQ) → LLM(스텁) → 폴백.
// LLM 실키는 CHAT_LLM_LIVE=true 승인 후에만 사용. [승인 필요] 전까지 스텁 유지.
// 멀티턴: 세션 문맥(src/lib/session.ts)으로 폴백 제안 번호 선택("1"/"2번")과
// 에스컬레이션 접수 후 연락처 수집을 지원한다(웹·카카오 공통, 서버 측 처리).
// 표기 흔들림(동의어·띄어쓰기·오타)은 src/lib/normalize 에서 흡수한다 — 룰은 원문과 압축형 양쪽에 시도.
import { matchKnowledge, searchKnowledge, buildCitation, type Citation, type KBEntry } from '@/lib/knowledge';
import { RULES, type Rule } from '@/lib/rules';
import { prepare } from '@/lib/normalize';
import { listKB, getRuleOverride, matchCustomRule } from '@/lib/adminStore';
import { getSession, updateSession } from '@/lib/session';
import { createTicket } from '@/lib/escalation';

export const LLM_LIVE = process.env.CHAT_LLM_LIVE === 'true';

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
}

/** KB 항목으로 응답을 만들 때 근거 인용을 함께 붙인다. */
function kbReply(entry: KBEntry, query: string, matched: { keyword: string }[] = []): ChatReply {
  return {
    reply: entry.answer,
    intent: `kb:${entry.category}`,
    escalate: false,
    source: 'kb',
    kbId: entry.id,
    citation: buildCitation(entry, query, matched),
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

export function replyTo(message: string, sessionId = 'anon'): ChatReply {
  const text = (message || '').trim();
  if (!text) return { reply: '메시지를 입력해 주세요.', intent: 'empty', escalate: false, source: 'empty' };

  const ctx = getSession(sessionId);

  // 0-a) 연락처 수집 대기 중이면 이번 턴을 연락처/건너뛰기로 우선 해석
  if (ctx.awaitingContact) {
    const contact = extractContact(text);
    if (contact) {
      // 열린 티켓에 연락처 첨부(세션당 열린 티켓 재사용) — 영구 저장은 [승인 필요]
      const { ticket } = createTicket({ sessionId, contact });
      updateSession(sessionId, { awaitingContact: false, ticketId: ticket.id });
      return {
        reply: `연락처가 접수번호 ${ticket.id}에 등록됐어요. 상담원이 순서대로 연락드릴게요. 그동안 다른 궁금한 점도 편하게 물어봐 주세요.`,
        intent: 'contact_captured',
        escalate: false,
        source: 'context',
        ticketId: ticket.id,
      };
    }
    if (SKIP_RE.test(text)) {
      updateSession(sessionId, { awaitingContact: false });
      return {
        reply: '네, 알겠습니다. 접수는 유지되니 이 창을 열어두시면 상담원이 순서대로 응대해 드릴게요. 다른 궁금한 점이 있으면 말씀해 주세요.',
        intent: 'contact_skipped',
        escalate: false,
        source: 'context',
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
      return replyTo(chosen.question, sessionId);
    }
  }

  // 에스컬레이션 룰은 서버에서 즉시 접수하고 연락처를 요청한다.
  // 웹 위젯뿐 아니라 카카오 등 버튼이 없는 채널에서도 접수가 완결되도록 엔진에서 처리.
  const escalateWith = (baseReply: string, intentName: string): ChatReply => {
    const { ticket, created } = createTicket({ sessionId, reason: `rule:${intentName}`, message: text });
    updateSession(sessionId, { awaitingContact: true, ticketId: ticket.id, pendingSuggestions: undefined });
    const tail = created
      ? `\n접수번호는 ${ticket.id}입니다. 연락받으실 전화번호나 이메일을 남겨주시면 순서대로 연락드릴게요. (원치 않으시면 "건너뛰기"라고 입력해 주세요)`
      : `\n이미 접수된 요청(${ticket.id})이 있어 이어서 도와드릴게요. 연락처를 남겨주시면 더 빠르게 연락드릴 수 있어요. (건너뛰려면 "건너뛰기")`;
    return { reply: baseReply + tail, intent: intentName, escalate: true, source: 'rule', ticketId: ticket.id };
  };

  // 1) 인텐트 룰(관리 콘솔 오버라이드 반영: 비활성화 스킵·응답문 교체)
  const pre = prepare(text);
  for (const r of RULES) {
    const ov = getRuleOverride(r.intent);
    if (ov && ov.enabled === false) continue;
    if (matchRule(r, text, pre.compact)) {
      const baseReply = ov?.reply || r.reply;
      if (r.escalate === true) return escalateWith(baseReply, r.intent);
      updateSession(sessionId, { pendingSuggestions: undefined });
      return { reply: baseReply, intent: r.intent, escalate: false, source: 'rule' };
    }
  }

  // 1-b) 커스텀 시나리오 룰(관리 콘솔에서 키워드로 추가한 룰) — 내장 룰 다음, KB 이전
  const cr = matchCustomRule(text);
  if (cr) {
    if (cr.escalate) return escalateWith(cr.reply, cr.intent);
    updateSession(sessionId, { pendingSuggestions: undefined });
    return { reply: cr.reply, intent: cr.intent, escalate: false, source: 'rule' };
  }

  // 2) 지식베이스(FAQ) 매칭 — 관리 콘솔 편집분(런타임 스토어) 사용
  const entries = listKB();
  const kb = matchKnowledge(text, 2, entries);
  if (kb) {
    updateSession(sessionId, { pendingSuggestions: undefined });
    return kbReply(kb.entry, text, kb.matched);
  }

  // 정답 확신은 없지만 근접한 FAQ가 있으면 후보로 제안(확신 매칭보다 낮은 문턱)
  const suggestions: ChatSuggestion[] = searchKnowledge(text, 3, entries).map((e) => ({ id: e.id, question: e.question }));
  updateSession(sessionId, { pendingSuggestions: suggestions.length ? suggestions : undefined });

  // 3) LLM 폴백(스텁). [승인 필요] 실키 연동 전까지 안전 응답만.
  if (LLM_LIVE) {
    return {
      reply: '(LLM 준비 중) 질문을 확인했어요. 조금 더 자세히 말씀해 주시겠어요?',
      intent: 'llm_pending',
      escalate: false,
      source: 'llm',
      ...(suggestions.length ? { suggestions } : {}),
    };
  }

  // 4) 최종 폴백 + 연관질문 제안(번호로도 선택 가능) + 상담원 제안
  return {
    reply: suggestions.length
      ? '정확한 답을 찾지 못했어요. 혹시 아래 질문 중 찾으시는 내용이 있나요? 번호(1~' + suggestions.length + ')로 답하셔도 돼요. 없다면 "상담원"이라고 입력해 주세요.'
      : '아직 제가 정확히 이해하지 못했어요. 조금 더 구체적으로 말씀해 주시거나, 상담원 연결을 원하시면 "상담원"이라고 입력해 주세요.',
    intent: 'fallback',
    escalate: true,
    source: 'fallback',
    ...(suggestions.length ? { suggestions } : {}),
  };
}
