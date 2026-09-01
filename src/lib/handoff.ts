// 상담원 이관(핸드오프) 요약 — AICC-Core `src/core/handoffSummary.ts`·`src/core/policyGuard.ts`와 구조 정합.
//
// 왜 필요한가: 챗봇이 5턴 물어본 내용이 상담원에게 넘어가지 않으면 고객이 "아까 다 말했는데요"를 반복한다.
// 이관 순간 필요한 것은 대화 전문이 아니라 (1) 왜 넘어왔는지 (2) 무엇을 이미 받았는지
// (3) 무엇이 비었는지 (4) 직전 몇 마디 — 네 가지다. Core와 같은 구조로 고정한다.
//
// 규칙 기반 순수 함수다. LLM을 호출하지 않으므로 결정적이고 이관 지연이 모델에 좌우되지 않는다.
// [승인 필요] LLM 추상 요약, 요약 영구 저장·상담사 시스템(CTI/슬랙) 실전송.

/** 이관 사유 — AICC-Core `Handoff['reason']` 어휘와 동일하게 유지한다(교차 저장소 리포트 정합). */
export type HandoffReason = 'low_confidence' | 'customer_request' | 'policy' | 'error' | 'max_retry';

export const HANDOFF_REASONS: HandoffReason[] = ['low_confidence', 'customer_request', 'policy', 'error', 'max_retry'];

export const HANDOFF_REASON_LABELS: Record<HandoffReason, string> = {
  low_confidence: '인식 신뢰도 부족',
  customer_request: '고객이 상담원 연결을 요청',
  policy: '정책상 상담원 처리 대상',
  error: '시스템 오류',
  max_retry: '재시도 한도 초과',
};

export function isHandoffReason(v: unknown): v is HandoffReason {
  return typeof v === 'string' && (HANDOFF_REASONS as string[]).includes(v);
}

// ---- 개인정보 마스킹(AICC-Core policyGuard §10.3 규칙 이식) ----
// 규칙 순서 = 우선순위. 좁은 패턴(주민·카드·휴대폰)을 먼저, 가장 넓은 계좌 패턴을 마지막에 둔다.
// 순서를 바꾸면 휴대폰이 계좌로 분류되어 마스킹 종류 통계가 틀어진다.

const MASK_RULES: { name: string; re: RegExp; mask: (m: string) => string }[] = [
  { name: 'rrn', re: /\b(\d{6})[-\s]?([1-4]\d{6})\b/g, mask: (m) => `${m.slice(0, 6)}-*******` },
  { name: 'card', re: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g, mask: (m) => `${m.slice(0, 4)}-****-****-${m.slice(-4)}` },
  { name: 'phone', re: /\b01[0-9][-\s]?\d{3,4}[-\s]?\d{4}\b/g, mask: (m) => `${m.slice(0, 3)}-****-${m.slice(-4)}` },
  { name: 'email', re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, mask: (m) => `${m.slice(0, 2)}***@${m.split('@')[1] ?? ''}` },
  { name: 'account', re: /\b\d{2,3}-?\d{2,6}-?\d{2,6}\b/g, mask: () => '***-****-****' },
];

/** 이미 마스킹된 구간을 뒤 규칙이 다시 잡지 않도록 자리표시자로 보호한다.
 *  숫자를 g~p 문자로 바꾸고 U+0001로 감싸 본문 글자와 겹치지 않게 한다(Core policyGuard와 동일 기법). */
const PLACEHOLDER = (i: number) => `\u0001${String(i).replace(/\d/g, (d) => String.fromCharCode(103 + Number(d)))}\u0001`;

export interface MaskResult {
  text: string;
  masked: boolean;
  hits: string[];
}

export function maskPii(input: string): MaskResult {
  let out = input || '';
  const hits: string[] = [];
  const vault: string[] = [];
  for (const rule of MASK_RULES) {
    const re = new RegExp(rule.re.source, 'g');
    let hit = false;
    out = out.replace(re, (m) => {
      hit = true;
      vault.push(rule.mask(m));
      return PLACEHOLDER(vault.length - 1);
    });
    if (hit) hits.push(rule.name);
  }
  out = out.replace(/\u0001([g-p]+)\u0001/g, (_m, k: string) => {
    const idx = Number(String(k).replace(/[g-p]/g, (c) => String(c.charCodeAt(0) - 103)));
    return vault[idx] ?? '';
  });
  return { text: out, masked: hits.length > 0, hits };
}

// ---- 요약 ----

export type Speaker = 'customer' | 'bot' | 'agent';

const SPEAKER_LABELS: Record<Speaker, string> = { customer: '고객', bot: 'AI', agent: '상담원' };

export interface SummaryLine {
  at: string;
  speaker: Speaker;
  text: string; // 마스킹 완료
  intent?: string;
}

export interface SummarySlot {
  key: string;
  label: string;
  value: string; // 마스킹 완료
  masked: boolean;
}

export interface HandoffSummary {
  sessionId: string;
  ticketId?: string;
  generatedAt: string;
  generator: 'rule'; // [승인 필요] 'llm' 추상 요약
  channel: 'web' | 'kakao';
  reason: HandoffReason;
  reasonLabelKo: string;
  turnCount: number;
  lastIntent?: string;
  collectedSlots: SummarySlot[];
  pendingSlots: string[];
  recentTurns: SummaryLine[];
  piiMasked: boolean;
  piiKinds: string[];
  /** 상담원 화면에 그대로 붙일 수 있는 평문(이미 마스킹 통과). */
  text: string;
}

export interface SummaryInput {
  sessionId: string;
  ticketId?: string;
  channel: 'web' | 'kakao';
  reason: HandoffReason;
  turns: { at: string; speaker: Speaker; text: string; intent?: string }[];
  /** 수집한 슬롯(연락처 등). 값은 요약 생성 시 마스킹된다. */
  slots?: Record<string, string>;
  /** 시나리오상 받아야 하지만 아직 없는 슬롯 키. */
  pendingSlots?: string[];
  /** 표시할 최근 턴 수 — 화면 설정값이며 성능 지표가 아니다. */
  recentTurns?: number;
  now?: () => string;
}

const DEFAULT_RECENT_TURNS = 6;

const SLOT_LABELS: Record<string, string> = {
  contact: '연락처',
  name: '성함',
  orderId: '주문번호',
};

function labelOf(key: string): string {
  return SLOT_LABELS[key] ?? key;
}

/** 규칙 기반 이관 요약. 모든 본문이 maskPii를 통과한다. */
export function buildHandoffSummary(input: SummaryInput): HandoffSummary {
  const kinds = new Set<string>();

  const collectedSlots: SummarySlot[] = Object.entries(input.slots ?? {})
    .filter(([key, value]) => !key.startsWith('__') && String(value ?? '').trim())
    .map(([key, value]) => {
      const m = maskPii(String(value));
      for (const k of m.hits) kinds.add(k);
      return { key, label: labelOf(key), value: m.text, masked: m.masked };
    });

  const collected = new Set(collectedSlots.map((s) => s.key));
  const pendingSlots = (input.pendingSlots ?? []).filter((k) => !collected.has(k));

  const take = Math.max(0, input.recentTurns ?? DEFAULT_RECENT_TURNS);
  const window = take === 0 ? [] : input.turns.slice(Math.max(0, input.turns.length - take));
  const recentTurns: SummaryLine[] = window.map((t) => {
    const m = maskPii(t.text);
    for (const k of m.hits) kinds.add(k);
    return { at: t.at, speaker: t.speaker, text: m.text, ...(t.intent ? { intent: t.intent } : {}) };
  });

  const lastIntent = [...input.turns].reverse().find((t) => t.intent)?.intent;

  const summary: HandoffSummary = {
    sessionId: input.sessionId,
    generatedAt: (input.now ?? (() => new Date().toISOString()))(),
    generator: 'rule',
    channel: input.channel,
    reason: input.reason,
    reasonLabelKo: HANDOFF_REASON_LABELS[input.reason],
    turnCount: input.turns.length,
    collectedSlots,
    pendingSlots,
    recentTurns,
    piiMasked: kinds.size > 0,
    piiKinds: [...kinds].sort(),
    text: '',
    ...(input.ticketId ? { ticketId: input.ticketId } : {}),
    ...(lastIntent ? { lastIntent } : {}),
  };
  summary.text = renderSummaryText(summary);
  return summary;
}

/** 상담원 화면용 평문. 입력이 이미 마스킹된 요약이므로 재마스킹하지 않는다. */
export function renderSummaryText(s: HandoffSummary): string {
  const L: string[] = [];
  L.push(`[상담원 이관 요약] ${s.ticketId ?? s.sessionId} · 채널 ${s.channel}`);
  L.push(`이관 사유: ${s.reasonLabelKo} (${s.reason})`);
  L.push(`진행: ${s.turnCount}턴`);
  if (s.lastIntent) L.push(`직전 의도: ${s.lastIntent}`);

  L.push('수집 정보');
  if (s.collectedSlots.length === 0) L.push('  - 없음');
  else for (const c of s.collectedSlots) L.push(`  - ${c.label}: ${c.value}`);

  if (s.pendingSlots.length > 0) {
    L.push('미수집 정보');
    for (const p of s.pendingSlots) L.push(`  - ${labelOf(p)}`);
  }

  L.push('직전 대화');
  if (s.recentTurns.length === 0) L.push('  - 없음');
  else for (const t of s.recentTurns) L.push(`  [${SPEAKER_LABELS[t.speaker]}] ${t.text}`);

  L.push(`개인정보 마스킹: ${s.piiMasked ? s.piiKinds.join(', ') : '해당 없음'}`);
  return L.join('\n');
}
