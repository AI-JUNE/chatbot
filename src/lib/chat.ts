// 대화 엔진. 우선순위: 세션 문맥(연락처 수집·번호 선택) → 인텐트 룰 → 지식베이스(FAQ) → LLM(스텁) → 폴백.
// LLM 실키는 CHAT_LLM_LIVE=true 승인 후에만 사용. [승인 필요] 전까지 스텁 유지.
// 멀티턴: 세션 문맥(src/lib/session.ts)으로 폴백 제안 번호 선택("1"/"2번")과
// 에스컬레이션 접수 후 연락처 수집을 지원한다(웹·카카오 공통, 서버 측 처리).
// 표기 흔들림(동의어·띄어쓰기·오타)은 src/lib/normalize 에서 흡수한다 — 룰은 원문과 압축형 양쪽에 시도.
// 상담원 전환은 (1) 고객 요청 (2) 정책 키워드(불만·긴급) (3) 신뢰도 임계 미만 연속 발생 세 경로로 일어나며,
// 이관 시 규칙 기반 대화 요약(src/lib/handoff)을 티켓에 붙인다 — 사유 코드는 AICC-Core 어휘를 따른다.
import { matchKnowledge, searchKnowledge, buildCitation, type Citation, type KBEntry } from '@/lib/knowledge';
import { resolveTenant } from '@/lib/tenantKB';
import { resolveCTA, tenantLabel, type TenantPreset } from '@/lib/tenants';
import { RULES, type Rule } from '@/lib/rules';
import { keywordHit, prepare } from '@/lib/normalize';
import { listKB, getRuleOverride, listCustomRules, matchCustomRule } from '@/lib/adminStore';
import { intentLabelMap } from '@/lib/intents';
import { josa } from '@/lib/refusal';
import { appendTurn, getSession, setSlot, updateSession } from '@/lib/session';
import { createTicket, queuePosition } from '@/lib/escalation';
import { buildHandoffSummary, maskPii, type HandoffReason } from '@/lib/handoff';
import { findContact } from '@/lib/pii';
import { generateGroundedAnswer, type CompleteOptions, type GroundingDoc, type LLMFailureReason, type LLMMessage } from '@/lib/llm';
import {
  AGENT_REQUEST_RE,
  applyInput,
  collectedSlots,
  formForIntent,
  getForm,
  promptFor,
  renderCollected,
  startForm,
  stepInfo,
  type FormSpec,
  type SlotSpec,
} from '@/lib/slots';

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

/** 진행 중인 슬롯 수집 단계 — 위젯 진행 표시용(성능 지표가 아니라 화면 상태값이다). */
export interface FormProgress {
  id: string;
  title: string;
  step: number;
  total: number;
  /** 지금 묻고 있는 항목 라벨 */
  label: string;
  /** 이 항목을 "건너뛰기"로 넘길 수 있는지 */
  canSkip: boolean;
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
  /** 멀티턴 슬롯 수집이 진행 중일 때의 단계 정보(완료·취소 턴에는 없다). */
  form?: FormProgress;
  /** 테넌트 CTA(예: 이음 참여 신청) — 위젯이 버튼으로 렌더한다. 테넌트 대화에만 채워진다. */
  cta?: { label: string; url: string; hint: string };
}

/** 테넌트 대화 문맥 — 프리셋(문구·CTA)과 그 테넌트 전용 지식. */
export interface TenantContext {
  preset: TenantPreset;
  kb: KBEntry[];
}

/** tenantId 문자열을 문맥으로 바꾼다. 알 수 없는 값이면 null(기본 고원 동작). */
export function tenantContext(tenantId?: string | null): TenantContext | null {
  return tenantId ? resolveTenant(tenantId) : null;
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

/** 이 대화가 참조할 지식 — 테넌트 대화는 해당 테넌트 FAQ만 본다(다른 고객사 답변 유출 방지). */
function entriesFor(tenant: TenantContext | null): KBEntry[] {
  return tenant ? tenant.kb : listKB();
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

/** 「이 표현은 먼저 걸리는 규칙이 있어 쓰이지 않는다」 (DS 44-3). */
export interface RuleShadow {
  /** 먼저 답하는 쪽 — 기본 규칙인가, 먼저 만든 내 규칙인가 */
  kind: 'builtin' | 'custom';
  intent: string;
  label: string;
  /** 가려지는 표현(운영자가 적은 그대로) */
  keyword: string;
}

/**
 * 커스텀 규칙이 **영원히 걸리지 않는** 상태인지 가린다 (DS 44-3).
 *
 * 이 엔진의 순서는 「기본 규칙 → 내가 만든 규칙(만든 순서) → 안내 자료」다. 그래서 운영자가
 * 「배송」·「요금」처럼 기본 규칙이 이미 쓰는 표현으로 규칙을 만들면 그 규칙은 **한 번도
 * 쓰이지 않는다**. 종전에는 그 사실을 어디서도 말하지 않았다 — 콘솔은 저장에 성공했다고 하고,
 * 규칙 미리보기는 「이 규칙이 적용됩니다」라고 적었다. 돌려서 확인했다: 「배송」 규칙을 만들어도
 * 「배송 언제 와요」에는 기본 규칙 「배송 조회」의 문구가 나간다.
 *
 * 재는 자는 엔진과 **같은 것**을 쓴다 — 기본 규칙은 `matchRule`(deny·압축형 포함), 내 규칙은
 * `keywordHit`(동의어·자모 오타 보정). 여기에 따로 비교식을 적으면 경고가 실제와 어긋난다
 * (DS 42-2 「같은 말을 재는 자는 한 벌」).
 *
 * 표현 하나를 **고객이 보낸 문장**처럼 넣어 본다: 기본 규칙 패턴은 부분 일치라 그 표현이 든
 * 문장은 대개 같은 판정을 받는다.
 *
 * @param selfIntent 지금 저장하려는 규칙의 식별자. 목록에서 **자기 자리까지만** 본다 —
 *   뒤에 있는 규칙은 이 규칙을 가리지 못한다(아직 없는 규칙이면 끝까지 본다).
 */
export function shadowOfRule(keywords: readonly string[], selfIntent = ''): RuleShadow | null {
  for (const raw of keywords) {
    const text = String(raw ?? '').trim();
    if (!text) continue;
    const pre = prepare(text);
    if (!pre.compact) continue;
    for (const r of RULES) {
      const ov = getRuleOverride(r.intent);
      if (ov && ov.enabled === false) continue; // 끈 기본 규칙은 가리지 않는다 — 그것이 운영자의 길이다
      if (matchRule(r, text, pre.compact)) return { kind: 'builtin', intent: r.intent, label: r.label, keyword: text };
    }
    for (const c of listCustomRules()) {
      if (c.intent === selfIntent) break;
      if (!c.enabled) continue;
      if (c.keywords.some((k) => keywordHit(pre.compact, pre.jamo, k).kind !== 'none')) {
        return { kind: 'custom', intent: c.intent, label: c.label, keyword: text };
      }
    }
  }
  return null;
}

// ---- 연락처 수집(에스컬레이션 후속 턴) ----
const SKIP_RE = /(건너뛰|괜찮|없어요|없습니다|아니요|아니오|나중에|스킵|skip)/i;

/**
 * 메시지에서 전화번호/이메일 추출. 없으면 null.
 *
 * **고르는 자는 가리는 쪽에 한 벌로 있다**(`pii.findContact` · DS 53-1). 49차(DS 52-1)는
 * 패턴 **속**만 끌어와(`new RegExp(PHONE_PATTERN)`) 가리는 쪽이 쓰는 경계(`\b`)와 관문
 * (`@` 가 뒤에 붙으면 전화번호가 아니다)을 빠뜨렸다 — 그래서 두 쪽이 같은 글을 다르게 읽었다:
 * 고객이 남긴 `0212345678@example.com` 을 이쪽은 「전화번호 0212345678」로 받아 적고,
 * 가리는 쪽은 「이메일」로 읽었다. 저장된 것은 **고객이 준 적 없는 번호**이고, 이 경로의 답변은
 * 저장한 값을 되읽지 않아 고칠 기회조차 없었다(상담원은 그 번호로 전화한다 · DS 35-3·§13).
 */
export function extractContact(text: string): string | null {
  return findContact(text)?.value ?? null;
}

/**
 * 이 메시지가 **연락처 하나뿐**인가 (DS 37-1).
 *
 * 서버가 먼저 묻지 않았는데 연락처를 받아 적는 자리는 여기 하나다. 그래서 「문장에 번호가
 * 섞여 있다」가 아니라 **「보낸 것이 번호뿐이다」**를 조건으로 둔다 — 「매장 번호 02-123-4567로
 * 전화했는데 안 받아요」가 고객의 연락처로 저장되던 자리(DS 35-3)를 다시 열지 않기 위해서다.
 * 조금이라도 다른 글자가 섞이면 받지 않는다: 틀리게 받아 적는 것보다 못 알아듣는 쪽이 낫다
 * (못 알아들으면 고객이 다시 말하지만, 틀리게 적으면 아무도 모른 채 다른 사람에게 전화한다).
 */
export function isOnlyContact(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  const c = extractContact(t);
  if (!c) return false;
  return t.replace(/\s+/g, '') === c.replace(/\s+/g, '');
}

/**
 * 접수 안내 뒤에 붙는 연락처 문구 — **이 접수에 회신할 곳이 남아 있는가**로 가른다 (DS 37-1).
 *
 * 종전에는 접수 안내를 할 때마다 조건 없이 연락처를 물었다(`awaitingContact: true`). 그런데
 * 세션당 열린 접수는 재사용되므로(`createTicket`), 이미 연락처를 남긴 사람이 뒤에 다시
 * 「상담원」이라고 말하면 **서버가 아는 번호를 서버가 다시 묻는** 자리가 됐다. 그 물음은 한 턴을
 * 삼킨다 — 다음에 하는 보통 질문이 연락처 수집 턴으로 먼저 해석되어, 「…없어요?」는 건너뛰기로
 * 읽히고 문장에 섞인 남의 번호는 **고객이 남긴 번호를 덮어쓴다**(DS 35-3 과 같은 종류의 해).
 *
 * 판정값은 티켓의 연락처다 — 위젯 접수 완료 카드가 쓰는 `contactOnFile`(DS 34-2)과 같은 사실이고,
 * 세션 슬롯이 아니라 **접수에 실제로 붙어 있는 값**이다(완료 후 파기된 접수는 다시 물어야 한다).
 * 번호 자체는 마스킹해서 보여 준다 — 같은 문장이 대화 기록·운영자 화면에 그대로 남는다.
 */
function contactTail(ticket: { contact?: string }, ask: string): string {
  if (!ticket.contact) return ask;
  return (
    ` 남겨 주신 연락처(${maskPii(ticket.contact).text})로 순서대로 연락드릴게요.` +
    ' 다른 연락처로 받으시려면 전화번호나 이메일만 보내 주세요.'
  );
}

/**
 * **올 수 없는 답을 기다리게 하지 않는다** (DS 45-1).
 *
 * 연락처를 남기지 않은 고객에게 종전 문구는 「접수는 유지되니 **이 창을 열어두시면** 상담원이
 * 순서대로 응대해 드릴게요」였고, 위젯 접수 카드는 「연락처를 남기지 않으셔서, **이 대화창으로**
 * 안내드립니다」였다. 둘 다 **상담원이 이 창에 말을 걸 수 있다**고 말하는데, 이 제품에는 그 길이
 * 없다 — 상담원이 고객 쪽으로 글을 보내는 창구가 없고(접수 알림 연동도 [승인 필요]), 위젯은
 * 자기가 보낸 요청의 답만 받는다(`/api/chat`·`/api/feedback`·`/api/escalation` 셋뿐이다).
 * 그래서 연락처 없이 접수한 사람은 창을 지키고 앉아 **영영 오지 않는 답**을 기다린다
 * (QUALITY_BAR §1 「핵심 흐름이 처음부터 끝까지 끊기지 않는다」·§13 「하지 못하는 일을
 * 할 수 있다고 말하지 않는다」).
 *
 * 그래서 사실과 **다음에 할 일**을 함께 적는다: 지금은 먼저 연락드릴 수 없다는 사실 + 번호만
 * 보내면 이 접수에 붙는다는 길(실제로 열려 있는 길이다 — `computeReply` 0-a2, DS 37-1).
 */
export function noContactLine(): string {
  return (
    ' 다만 연락받으실 곳을 남기지 않으셔서, 저희가 먼저 연락드릴 방법은 없어요.' +
    ' 전화번호나 이메일만 보내 주시면 이 접수에 붙여 두고 순서대로 연락드릴게요.'
  );
}

/**
 * **번호가 바뀐 것을 말한다** (DS 50-2).
 *
 * 세션당 열린 접수는 재사용되지만(`createTicket`), 운영자가 완료·취소로 닫은 뒤에 같은 대화가
 * 다시 접수하면 번호는 **새로 발급된다**(`created === true`). 종전에는 그 자리마다 `created` 를
 * 버리거나 잘못 읽어, 고객이 들고 있는 번호와 다른 번호를 **같은 번호인 척** 말했다:
 *  - 연락처만 보낸 사람에게 「접수번호 ESC-0003 **그대로** 상담원이 연락드릴게요」
 *    (고객이 받아 적은 번호는 ESC-0002 이고, 「그대로」는 사실이 아니다)
 *  - 연락처 수집 대기에서 번호를 남긴 사람에게 「연락처가 접수번호 ESC-0005에 등록됐어요」
 *    (바뀐 사실을 말하지 않아, 고객은 앞 번호가 그 접수인 줄 안다)
 * 접수번호는 고객이 받아 적어 전화로 읽어 주는 **단 하나의 값**이다 — 그것이 조용히 갈리면
 * 상담원은 없는 번호를 찾고, 고객은 자기 접수가 사라졌다고 듣는다(QUALITY_BAR §13).
 *
 * **까닭은 말하지 않는다**: `created` 가 참이라는 사실만으로는 앞 접수가 완료된 것인지 취소된
 * 것인지(또는 운영자가 저장분을 되돌린 것인지) 알 수 없다. 어느 쪽이든 고객에게 참인 것은
 * 「그 번호로는 더 진행되지 않는다」 하나다.
 *
 * 새 번호는 **부르는 쪽이 이미 적는다** — 여기서 한 번 더 적으면 한 문장에 같은 번호가 두 번
 * 나온다. 이 문장이 보태는 사실은 「앞 번호는 끝났다」 하나다.
 *
 * @param prevId 이 대화에 **앞서 알려 준** 접수번호(`session.ticketId`). 없으면 알린 적이 없다.
 * @param nextId 이번에 쓰는 접수번호 — 앞 번호와 같으면 알릴 것이 없다.
 */
function renumberedLine(prevId: string | undefined, nextId: string, created: boolean): string {
  if (!created || !prevId || prevId === nextId) return '';
  return ` 앞서 안내드린 접수번호 ${prevId}는 더 진행되지 않아 새로 접수했어요.`;
}

/** 폴백 제안 번호 선택("1", "2번", "3.") 파싱. 범위 밖이면 null. */
function parsePick(text: string, max: number): number | null {
  const m = text.match(/^([1-9])\s*(번|\.)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= max ? n : null;
}

/**
 * 이 대화가 어느 고객사(테넌트)의 위젯에서 왔는가 — 세션이 들고 있다(DS 36-2).
 * 엔진 안에서 접수를 만드는 자리가 다섯 곳이라, 그 값을 읽는 곳도 한 곳으로 모은다.
 */
function tenantOf(sessionId: string): string | null {
  return getSession(sessionId).tenantId ?? null;
}

/**
 * 「이 대화는 어느 고객사의 위젯에서 왔다」를 세션에 적어 둔다 (DS 36-1·36-2).
 *
 * 접수·요약을 만드는 자리는 테넌트를 인자로 받지 않는다(채널과 같다 — 엔진 안쪽은 모른 채 돈다).
 * 그래서 **답을 만들기 전에** 세션에 적는다 — 이 턴에서 바로 접수가 생길 수 있기 때문이다.
 * 등록된 프리셋으로 해석된 값만 적는다. 알 수 없는 값이면 엔진은 기본 자료로 답하므로,
 * 그 턴을 그 고객사의 것이라고 적으면 **기록이 답한 근거와 어긋난다**.
 *
 * 기본 구성으로 답한 턴에서는 **적어 둔 값을 거둔다.** 실제 위젯 한 대의 세션은 고객사가 바뀌지
 * 않지만, 관리 콘솔 「응답 테스트」는 같은 세션으로 기준을 바꿔 가며 시험한다(DS 36-3) — 거두지
 * 않으면 기본 구성으로 시험해 생긴 접수가 앞서 고른 고객사의 것으로 기록된다.
 */
function rememberTenant(sessionId: string, tenant: TenantContext | null): void {
  const next = tenant ? tenant.preset.id : undefined;
  if (getSession(sessionId).tenantId === next) return;
  updateSession(sessionId, { tenantId: next });
}

/** 세션 문맥 + 현재 티켓 상태로 규칙 기반 이관 요약을 만든다(마스킹 완료 평문). */
function summaryFor(
  sessionId: string,
  reason: HandoffReason,
  opts: { ticketId?: string; pendingSlots?: string[]; slotLabels?: Record<string, string> } = {},
): string {
  const ctx = getSession(sessionId);
  const pending = opts.pendingSlots ?? (ctx.slots?.contact ? [] : ['contact']);
  return buildHandoffSummary({
    sessionId,
    // 어디로 회신해야 하는지는 세션이 알고 있다 — 엔진은 채널을 모른 채 같은 함수로 돈다.
    channel: ctx.channel ?? 'web',
    // 어느 회사 손님인가 — 요약은 상담원이 전화를 걸기 전에 읽는 평문이다(DS 36-2).
    ...(ctx.tenantId ? { tenantLabel: tenantLabel(ctx.tenantId) } : {}),
    reason,
    turns: ctx.turns ?? [],
    slots: ctx.slots ?? {},
    pendingSlots: pending,
    // 운영자가 만든 규칙으로 답한 대화면 그 규칙 이름을 요약의 「직전 주제」에 쓴다(코드 `cr_…` 대신).
    intentLabels: intentLabelMap(listCustomRules()),
    ...(opts.slotLabels ? { slotLabels: opts.slotLabels } : {}),
    ...(opts.ticketId ? { ticketId: opts.ticketId } : {}),
  }).text;
}

/** 슬롯 수집 기능 게이트. 기본 ON, `CHAT_SLOT_FORMS=false`로 끌 수 있다(운영 중 즉시 회피용). */
function slotFormsEnabled(): boolean {
  return process.env.CHAT_SLOT_FORMS !== 'false';
}

/** 폼 정의의 라벨을 이관 요약에 그대로 쓰기 위한 맵. */
function labelsOf(form: FormSpec): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of form.slots) out[s.key] = s.label;
  return out;
}

function progressOf(form: FormSpec, slot: SlotSpec): FormProgress {
  const { step, total } = stepInfo(form, slot.key);
  return { id: form.id, title: form.title, step, total, label: slot.label, canSkip: slot.required === false };
}

function computeReply(message: string, sessionId = 'anon', tenant: TenantContext | null = null): ChatReply {
  const text = (message || '').trim();
  if (!text) return { reply: '메시지를 입력해 주세요.', intent: 'empty', escalate: false, source: 'empty', confidence: 1 };

  const ctx = getSession(sessionId);

  // 0-0) 멀티턴 슬롯 수집 진행 중 — 이번 턴을 해당 항목의 답변으로 우선 해석한다.
  //      (번호 선택·연락처 수집보다 앞선다. 폼 안에서 번호·연락처를 물어보는 단계가 있기 때문이다.)
  if (ctx.form && slotFormsEnabled()) {
    const form = getForm(ctx.form.formId);
    if (!form) {
      // 코드에서 폼 정의가 사라진 경우(배포 중 변경) — 상태를 정리하고 일반 흐름으로 계속한다.
      updateSession(sessionId, { form: undefined });
    } else if (AGENT_REQUEST_RE.test(text)) {
      // 고객이 사람을 원하면 수집을 즉시 중단하고 일반 흐름(상담원 룰)으로 넘긴다.
      updateSession(sessionId, { form: undefined });
    } else {
      const res = applyInput(form, ctx.form, text);

      if (res.kind === 'cancelled') {
        updateSession(sessionId, { form: undefined, pendingSuggestions: undefined });
        return {
          /**
           * **지키지 못할 약속을 하지 않는다** (DS 45-2).
           *
           * 종전 문구는 「입력하신 내용은 저장하지 않았습니다」였다. 접수(티켓)를 만들지 않는
           * 것은 사실이지만, 수집 중에 고객이 친 말은 **턴마다** 대화 기록에 적힌다
           * (`/api/chat` → `logTurn`) — 그 글은 관리 콘솔의 최근 대화·전역 검색·「답하지 못한
           * 질문」·내려받기 CSV·백업 스냅샷으로 나가고, 뒤에 상담원을 부르면 이관 요약의
           * 「직전 대화」로 상담원에게도 간다. 「저장하지 않았다」는 말을 믿고 이름·연락처를
           * 적은 뒤 취소한 사람에게 그것은 사실이 아니다(§13).
           *
           * 그래서 **일어난 일 그대로** 적는다: 접수는 만들지 않았고, 대화는 남으며, 전화번호·
           * 이메일 같은 값은 가려서 보관한다(`lib/pii` — DS 39-1 이 세운 저장 관문).
           */
          reply:
            `${form.title}를 중단했어요. 접수는 만들지 않았습니다.` +
            ' 지금까지 나눈 대화는 상담 기록에 남고, 전화번호·이메일 같은 값은 가려서 보관합니다.' +
            ' 다시 필요하시면 언제든 말씀해 주세요.',
          intent: `form:${form.id}:cancelled`,
          escalate: false,
          source: 'context',
          confidence: SOURCE_CONFIDENCE.context,
        };
      }

      if (res.kind === 'invalid') {
        updateSession(sessionId, { form: res.state });
        return {
          reply: promptFor(form, res.slot, { retryMessage: res.message }),
          intent: `form:${form.id}:${res.slot.key}:retry`,
          escalate: false,
          source: 'context',
          confidence: SOURCE_CONFIDENCE.context,
          form: progressOf(form, res.slot),
        };
      }

      if (res.kind === 'max_retry') {
        // 같은 항목에서 계속 못 알아들으면 고객을 붙잡아 두지 않고 상담원에게 넘긴다.
        for (const [k, v] of Object.entries(res.state.values)) setSlot(sessionId, k, v);
        const pending = form.slots.filter((sl) => !(sl.key in res.state.values)).map((sl) => sl.key);
        const { ticket, created } = createTicket({
          sessionId,
          tenant: tenantOf(sessionId),
          reason: 'max_retry',
          reasonCode: 'max_retry',
          message: text,
          summary: summaryFor(sessionId, 'max_retry', { pendingSlots: pending, slotLabels: labelsOf(form) }),
        });
        // 접수에 이미 붙어 있는 연락처도 함께 본다 (DS 37-1) — 열린 접수는 세션당 재사용된다.
        const hasContact = Boolean(ticket.contact || res.state.values.contact || getSession(sessionId).slots?.contact);
        updateSession(sessionId, {
          form: undefined,
          ticketId: ticket.id,
          handoffReason: 'max_retry',
          awaitingContact: !hasContact,
          lowConfidenceStreak: 0,
        });
        const q = queuePosition(ticket.id);
        return {
          reply:
            `제가 ${josa(res.slot.label, '을', '를')} 계속 알아듣지 못해서 상담원에게 연결해 드릴게요. 접수번호는 ${ticket.id}입니다.` +
            // 앞서 알려 준 번호가 있었다면 바뀐 사실을 함께 적는다 (DS 50-2).
            renumberedLine(ctx.ticketId, ticket.id, created) +
            (q ? ` 현재 접수 순번은 ${q.position}번입니다.` : '') +
            ' 지금까지 입력하신 내용은 상담원에게 함께 전달됩니다.' +
            contactTail(ticket, hasContact ? '' : ' 연락받으실 전화번호나 이메일을 남겨주시면 순서대로 연락드릴게요. (원치 않으시면 "건너뛰기")'),
          intent: `form:${form.id}:max_retry`,
          escalate: true,
          source: 'context',
          ticketId: ticket.id,
          handoffReason: 'max_retry',
          confidence: SOURCE_CONFIDENCE.context,
          ...(q ? { queue: q } : {}),
        };
      }

      if (res.kind === 'progress') {
        updateSession(sessionId, { form: res.state });
        const lead = res.back ? '앞 항목으로 돌아갈게요.' : res.skipped ? '이 항목은 건너뛸게요.' : '';
        return {
          reply: promptFor(form, res.slot, lead ? { retryMessage: lead } : {}),
          intent: `form:${form.id}:${res.slot.key}`,
          escalate: false,
          source: 'context',
          confidence: SOURCE_CONFIDENCE.context,
          form: progressOf(form, res.slot),
        };
      }

      // 수집 완료 — 접수 티켓을 만들고 수집 내용을 요약에 싣는다(연락처는 마스킹되어 표시).
      const values = collectedSlots(form, res.values);
      for (const [k, v] of Object.entries(values)) setSlot(sessionId, k, v);
      const pending = form.slots.filter((sl) => !(sl.key in values)).map((sl) => sl.key);
      const { ticket, created } = createTicket({
        sessionId,
        tenant: tenantOf(sessionId),
        reason: `form:${form.id}`,
        reasonCode: form.handoffReason,
        message: text,
        ...(values.contact ? { contact: values.contact } : {}),
        summary: summaryFor(sessionId, form.handoffReason, { pendingSlots: pending, slotLabels: labelsOf(form) }),
      });
      updateSession(sessionId, {
        form: undefined,
        ticketId: ticket.id,
        handoffReason: form.handoffReason,
        awaitingContact: false,
        pendingSuggestions: undefined,
        lowConfidenceStreak: 0,
      });
      const q = queuePosition(ticket.id);
      return {
        reply:
          `${form.doneLead} 접수번호는 ${ticket.id}입니다.` +
          // 앞서 알려 준 번호가 있었다면 바뀐 사실을 함께 적는다 (DS 50-2).
          renumberedLine(ctx.ticketId, ticket.id, created) +
          (q ? ` 현재 접수 순번은 ${q.position}번입니다.` : '') +
          `\n${renderCollected(form, values)}\n` +
          (created ? '' : '이미 접수된 요청에 이어서 기록했어요. ') +
          // 연락처를 건너뛴 접수(장애 신고의 연락처는 선택 항목이다)에 「연락드릴게요」라고
          // 적으면 그 약속을 지킬 길이 없다 — 접수에 붙어 있는 값으로 가른다 (DS 45-1).
          (ticket.contact ? '상담원이 확인 후 순서대로 연락드릴게요.' : `상담원이 확인하도록 접수해 두었어요.${noContactLine()}`) +
          ' 내용을 고치시려면 "상담원"이라고 입력해 주세요.',
        intent: `form:${form.id}:complete`,
        escalate: false,
        source: 'context',
        ticketId: ticket.id,
        handoffReason: form.handoffReason,
        confidence: SOURCE_CONFIDENCE.context,
        ...(q ? { queue: q } : {}),
      };
    }
  }

  // 0-a) 연락처 수집 대기 중이면 이번 턴을 연락처/건너뛰기로 우선 해석
  if (ctx.awaitingContact) {
    const contact = extractContact(text);
    if (contact) {
      // 열린 티켓에 연락처 첨부(세션당 열린 티켓 재사용) — 영구 저장은 [승인 필요]
      setSlot(sessionId, 'contact', contact);
      const reasonCode = ctx.handoffReason ?? 'customer_request';
      const { ticket, created } = createTicket({ sessionId, tenant: tenantOf(sessionId), contact, summary: summaryFor(sessionId, reasonCode) });
      updateSession(sessionId, { awaitingContact: false, ticketId: ticket.id });
      const q = queuePosition(ticket.id);
      return {
        reply:
          /**
           * **받아 적은 것을 되읽는다** (DS 53-1) — 0-a2(연락처만 보낸 길)가 이미 그렇게 적는
           * 문장이고, 이 길만 「연락처가」로 뭉뚱그려 **무엇을 저장했는지 말하지 않았다**.
           * 받아 적는 자가 틀릴 수 있는 자리라면(이메일을 전화번호로 읽던 자리다) 고객이
           * 그 자리에서 고칠 수 있어야 한다 — 다른 연락처로 받는 길은 바로 아래 0-a2 다.
           */
          `연락처 ${maskPii(contact).text}가 접수번호 ${ticket.id}에 등록됐어요.` +
          // 앞 접수가 닫혀 번호가 새로 발급됐으면 그 사실을 먼저 말한다 (DS 50-2).
          renumberedLine(ctx.ticketId, ticket.id, created) +
          ' 상담원이 순서대로 연락드릴게요.' +
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
        // 접수는 남는다는 사실은 그대로 두고, **창을 지키면 답이 온다**는 말만 거둔다 (DS 45-1).
        reply: `네, 알겠습니다. 접수는 그대로 남아 있어요.${noContactLine()} 다른 궁금한 점이 있으면 말씀해 주세요.`,
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

  // 0-a2) 접수한 뒤에 **연락처만** 보내면 그 접수의 연락처로 받는다 (DS 37-1).
  //       서버는 이미 받은 연락처를 다시 캐묻지 않는다(위 contactTail) — 그래서 마음이 바뀐
  //       사람이 번호만 보내는 길을 대신 열어 둔다. 조건은 「보낸 것이 연락처뿐」이다.
  if (ctx.ticketId && isOnlyContact(text)) {
    const contact = extractContact(text) as string;
    const before = ctx.slots?.contact;
    setSlot(sessionId, 'contact', contact);
    const reasonCode = ctx.handoffReason ?? 'customer_request';
    const { ticket, created } = createTicket({ sessionId, tenant: tenantOf(sessionId), contact, summary: summaryFor(sessionId, reasonCode) });
    updateSession(sessionId, { awaitingContact: false, ticketId: ticket.id });
    const masked = maskPii(contact).text;
    // 번호가 새로 발급됐으면 「그대로」가 아니다 (DS 50-2) — 그 자리에는 바뀐 사실을 적는다.
    const renumbered = renumberedLine(ctx.ticketId, ticket.id, created);
    return {
      reply:
        before && before !== contact
          ? renumbered
            // 번호가 갈렸으면 「그대로」를 쓸 수 없다 — 새 번호를 말하고 앞 번호가 끝났음을 밝힌다.
            ? `연락처를 ${masked}로 바꿨어요.${renumbered} 새 접수번호는 ${ticket.id}입니다. 상담원이 순서대로 연락드릴게요.`
            : `연락처를 ${masked}로 바꿨어요. 접수번호 ${ticket.id} 그대로 상담원이 순서대로 연락드릴게요.`
          : `연락처 ${masked}가 접수번호 ${ticket.id}에 등록됐어요.${renumbered} 상담원이 순서대로 연락드릴게요.`,
      intent: before && before !== contact ? 'contact_updated' : 'contact_captured',
      escalate: false,
      source: 'context',
      ticketId: ticket.id,
      confidence: SOURCE_CONFIDENCE.context,
    };
  }

  // 0-b) 직전 폴백 제안의 번호 선택("1", "2번") 처리
  const pending = ctx.pendingSuggestions ?? [];
  if (pending.length) {
    const pick = parsePick(text, pending.length);
    if (pick !== null) {
      const chosen = pending[pick - 1];
      const entry = entriesFor(tenant).find((e) => e.id === chosen.id);
      updateSession(sessionId, { pendingSuggestions: undefined });
      if (entry) return kbReply(entry, chosen.question);
      // 편집으로 항목이 사라진 경우 — 원래 질문 문구로 재처리
      return computeReply(chosen.question, sessionId, tenant);
    }
  }

  // 에스컬레이션 룰은 서버에서 즉시 접수하고 연락처를 요청한다.
  // 웹 위젯뿐 아니라 카카오 등 버튼이 없는 채널에서도 접수가 완결되도록 엔진에서 처리.
  const escalateWith = (baseReply: string, intentName: string, reasonCode: HandoffReason = 'customer_request'): ChatReply => {
    const reason = intentName.startsWith('rule:') ? intentName : `rule:${intentName}`;
    const { ticket, created } = createTicket({
      sessionId,
      tenant: tenantOf(sessionId),
      reason,
      message: text,
      summary: summaryFor(sessionId, reasonCode),
    });
    updateSession(sessionId, {
      // 이미 회신할 곳이 붙어 있는 접수에는 다시 묻지 않는다 (DS 37-1) — 그 물음이 다음 턴을 삼킨다.
      awaitingContact: !ticket.contact,
      ticketId: ticket.id,
      pendingSuggestions: undefined,
      handoffReason: reasonCode,
      lowConfidenceStreak: 0,
    });
    const q = queuePosition(ticket.id);
    const wait = q ? ` 현재 접수 순번은 ${q.position}번입니다.` : '';
    const tail = created
      // 앞서 알려 준 번호가 있었다면 바뀐 사실을 함께 적는다 (DS 50-2).
      ? `\n접수번호는 ${ticket.id}입니다.${renumberedLine(ctx.ticketId, ticket.id, created)}${wait}${contactTail(ticket, ' 연락받으실 전화번호나 이메일을 남겨주시면 순서대로 연락드릴게요. (원치 않으시면 "건너뛰기"라고 입력해 주세요)')}`
      // 「더 빠르게」는 **느린 길이 있다**는 말이다 — 연락처가 없으면 느린 길도 없다 (DS 45-1).
      : `\n이미 접수된 요청(${ticket.id})이 있어 이어서 도와드릴게요.${wait}${contactTail(ticket, ' 연락받으실 전화번호나 이메일을 남겨주시면 순서대로 연락드릴게요. (건너뛰려면 "건너뛰기")')}`;
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
    // 테넌트 대화에서는 허용된 인텐트(인사·상담원 전환 등)만 쓴다.
    // 나머지는 테넌트 FAQ가 답해야 한다 — 다른 브랜드의 안내 문구가 새어 나가지 않게.
    if (tenant && !tenant.preset.allowedRuleIntents.includes(r.intent)) continue;
    const ov = getRuleOverride(r.intent);
    if (ov && ov.enabled === false) continue;
    if (matchRule(r, text, pre.compact)) {
      const baseReply = tenant?.preset.ruleReplies?.[r.intent] || ov?.reply || r.reply;
      if (r.escalate === true) return escalateWith(baseReply, r.intent, POLICY_INTENTS.has(r.intent) ? 'policy' : 'customer_request');

      // 이 인텐트에 접수 폼이 연결돼 있으면 안내에 이어 첫 항목을 물어본다(안내 → 접수로 이어지게).
      const form = slotFormsEnabled() ? formForIntent(r.intent) : null;
      if (form) {
        const started = startForm(form);
        updateSession(sessionId, { form: started.state, pendingSuggestions: undefined });
        return {
          reply: `${baseReply}\n\n${promptFor(form, started.slot)}`,
          intent: `form:${form.id}:start`,
          escalate: false,
          source: 'context',
          confidence: SOURCE_CONFIDENCE.context,
          form: progressOf(form, started.slot),
        };
      }

      updateSession(sessionId, { pendingSuggestions: undefined });
      return { reply: baseReply, intent: r.intent, escalate: false, source: 'rule', confidence: SOURCE_CONFIDENCE.rule };
    }
  }

  // 1-b) 커스텀 시나리오 룰(관리 콘솔에서 키워드로 추가한 룰) — 내장 룰 다음, KB 이전.
  //      테넌트 대화에는 적용하지 않는다(콘솔 룰은 기본 테넌트 소유).
  const cr = tenant ? null : matchCustomRule(text);
  if (cr) {
    if (cr.escalate) return escalateWith(cr.reply, cr.intent, 'policy');
    updateSession(sessionId, { pendingSuggestions: undefined });
    return { reply: cr.reply, intent: cr.intent, escalate: false, source: 'rule', confidence: SOURCE_CONFIDENCE.rule };
  }

  // 2) 지식베이스(FAQ) 매칭 — 관리 콘솔 편집분(런타임 스토어) 사용
  const entries = entriesFor(tenant);
  const kb = matchKnowledge(text, 2, entries);
  if (kb) {
    updateSession(sessionId, { pendingSuggestions: undefined });
    return kbReply(kb.entry, text, kb.matched, kb.score);
  }

  // 정답 확신은 없지만 근접한 FAQ가 있으면 후보로 제안(확신 매칭보다 낮은 문턱)
  const suggestions: ChatSuggestion[] = searchKnowledge(text, 3, entries).map((e) => ({ id: e.id, question: e.question }));
  updateSession(sessionId, { pendingSuggestions: suggestions.length ? suggestions : undefined });

  // 결정적 폴백 문구 — LLM이 없거나 실패해도 이 답변이 항상 남는다(빈 화면·무반응 금지).
  const fallbackReply = tenant
    ? tenant.preset.unknownReply +
      (suggestions.length
        ? `\n\n혹시 아래 질문 중 찾으시는 내용이 있나요? 번호(1~${suggestions.length})로 답하셔도 돼요.`
        : '')
    : suggestions.length
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
async function augmentWithLLM(
  text: string,
  sessionId: string,
  base: ChatReply,
  opts: CompleteOptions,
  tenant: TenantContext | null = null,
): Promise<ChatReply> {
  const entries = entriesFor(tenant);
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
export function replyTo(message: string, sessionId = 'anon', tenantId?: string | null): ChatReply {
  const text = (message || '').trim();
  if (text) appendTurn(sessionId, { at: new Date().toISOString(), speaker: 'customer', text });
  const tenant = tenantContext(tenantId);
  rememberTenant(sessionId, tenant);
  return finalize(text, sessionId, computeReply(message, sessionId, tenant), tenant);
}

/**
 * 비동기 진입점 — 룰·KB로 답이 나오지 않고 LLM 게이트가 켜져 있을 때만 생성 모델을 호출한다.
 * LLM이 꺼져 있거나 실패하면 replyTo와 완전히 동일한 결정적 답변을 돌려준다(라우트는 항상 이 함수를 쓴다).
 */
export async function replyToAsync(
  message: string,
  sessionId = 'anon',
  opts: CompleteOptions & { tenantId?: string | null } = {},
): Promise<ChatReply> {
  const text = (message || '').trim();
  if (text) appendTurn(sessionId, { at: new Date().toISOString(), speaker: 'customer', text });

  const tenant = tenantContext(opts.tenantId);
  rememberTenant(sessionId, tenant);
  let result = computeReply(message, sessionId, tenant);
  if (result.source === 'llm') result = await augmentWithLLM(text, sessionId, result, opts, tenant);
  return finalize(text, sessionId, result, tenant);
}

/** CTA를 본문 끝에 붙이는 응답 경로 — 안내성 답변에만 붙인다(접수 진행 중 턴에는 붙이지 않는다). */
const CTA_SOURCES = new Set<ReplySource>(['kb', 'rule', 'llm', 'fallback']);

/**
 * 테넌트 CTA 부착 — 위젯은 cta 객체로 버튼을, 버튼이 없는 채널(카카오 등)은 본문 끝 문구를 쓴다.
 * 접수가 일어난 턴(ticketId)에는 문구를 덧붙이지 않는다(접수 안내가 우선).
 */
function withTenantCTA(result: ChatReply, tenant: TenantContext | null): ChatReply {
  if (!tenant || result.source === 'empty') return result;
  const cta = resolveCTA(tenant.preset, process.env);
  const inline = CTA_SOURCES.has(result.source) && !result.ticketId;
  return { ...result, cta, ...(inline ? { reply: `${result.reply}\n\n${cta.hint}` } : {}) };
}

/** 공통 마무리 — 신뢰도 기반 자동 전환 판정 후 봇 턴을 문맥 버퍼에 적재한다. */
function finalize(text: string, sessionId: string, result: ChatReply, tenant: TenantContext | null = null): ChatReply {
  const auto = withTenantCTA(maybeAutoEscalate(text, sessionId, result), tenant);
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
    tenant: tenantOf(sessionId),
    reason: 'low_confidence',
    message: text,
    summary: summaryFor(sessionId, 'low_confidence'),
  });
  updateSession(sessionId, {
    // 접수에 회신할 곳이 이미 있으면 다시 묻지 않는다 (DS 37-1 — escalateWith 와 같은 규칙).
    awaitingContact: !ticket.contact,
    ticketId: ticket.id,
    handoffReason: 'low_confidence',
    lowConfidenceStreak: 0,
  });
  const q = queuePosition(ticket.id);
  const wait = q ? ` 현재 접수 순번은 ${q.position}번입니다.` : '';
  const lead = created
    // 앞서 알려 준 번호가 있었다면 바뀐 사실을 함께 적는다 (DS 50-2 — escalateWith 와 같은 규칙).
    ? `제가 계속 정확히 답변드리지 못하고 있어 상담원에게 연결해 드릴게요. 접수번호는 ${ticket.id}입니다.${renumberedLine(ctx.ticketId, ticket.id, created)}${wait}`
    : `이미 접수된 요청(${ticket.id})으로 상담원이 이어서 도와드릴게요.${wait}`;
  return {
    ...result,
    reply:
      `${result.reply}\n\n${lead} 지금까지 나눈 대화는 상담원에게 함께 전달됩니다.` +
      contactTail(ticket, ' 연락받으실 전화번호나 이메일을 남겨주시면 순서대로 연락드릴게요. (원치 않으시면 "건너뛰기")'),
    escalate: true,
    ticketId: ticket.id,
    handoffReason: 'low_confidence',
    ...(q ? { queue: q } : {}),
  };
}
