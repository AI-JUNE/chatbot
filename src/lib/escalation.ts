// 상담원 폴백(에스컬레이션) 티켓 스토어.
// 영속화는 `@/lib/storage`의 `tickets` 네임스페이스에 위임한다. 티켓은 연락처·문의 내용을 담는
// **개인정보 포함 데이터**이므로 `PERSIST_PII=true` **[승인 필요]** 전까지 디스크에 쓰지 않는다
// (코드는 완성, 스위치만 잠금). 승인 전에는 기존과 동일하게 서버 메모리에만 유지된다.
// [승인 필요] 실제 상담원 알림(SMS/슬랙 등) 연동.
// 이관 사유 코드(reasonCode)와 요약(summary)은 AICC-Core `src/core/handoffSummary.ts` 어휘를 따른다.
import { isHandoffReason, type HandoffReason } from '@/lib/handoff';
import { loadJson, scheduleSave } from '@/lib/storage';

export type EscalationStatus = 'open' | 'in_progress' | 'resolved' | 'canceled';

export const ESCALATION_STATUSES: EscalationStatus[] = ['open', 'in_progress', 'resolved', 'canceled'];

export const STATUS_LABELS: Record<EscalationStatus, string> = {
  open: '접수',
  in_progress: '상담 중',
  resolved: '완료',
  canceled: '취소',
};

export interface EscalationTicket {
  id: string;
  sessionId: string;
  reason: string; // user_request | rule:agent | rule:complaint | fallback 등(원인 상세)
  /** AICC-Core Handoff 사유 코드. 채널·저장소가 달라도 같은 어휘로 집계된다. */
  reasonCode: HandoffReason;
  message: string; // 요청 시점 마지막 사용자 메시지(요약용)
  contact?: string; // 고객이 남긴 연락처(선택) — 개인정보 영구 저장은 [승인 필요]
  status: EscalationStatus;
  note?: string; // 상담원 메모
  /** 규칙 기반 이관 요약(마스킹 완료 평문). lib/handoff.buildHandoffSummary 산출물. */
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

/** 원인 상세 문자열을 Core 사유 코드로 매핑한다(알 수 없으면 정책 처리 대상으로 본다). */
export function toReasonCode(reason: string | undefined): HandoffReason {
  const r = (reason || '').trim();
  if (isHandoffReason(r)) return r;
  if (r === 'user_request' || r === 'rule:agent') return 'customer_request';
  if (r === 'rule:complaint' || r === 'rule:urgent') return 'policy';
  if (r.startsWith('fallback') || r === 'low_confidence') return 'low_confidence';
  if (r === 'max_retry') return 'max_retry';
  if (r === 'error') return 'error';
  return 'policy';
}

let tickets: EscalationTicket[] = [];
let seq = 0;

function now(): string {
  return new Date().toISOString();
}

export const TICKETS_NS = 'tickets';

export interface TicketSnapshot {
  version: 1;
  savedAt: string;
  seq: number;
  tickets: EscalationTicket[];
}

export function exportTickets(): TicketSnapshot {
  return { version: 1, savedAt: now(), seq, tickets: listTickets().reverse() };
}

function persist(): void {
  scheduleSave(TICKETS_NS, exportTickets);
}

/** 스냅샷 복원. 형식이 어긋난 항목은 건너뛰고 개수를 돌려준다. */
export function importTickets(input: unknown): { ok: true; count: number } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: '유효한 JSON 객체가 아닙니다.' };
  const snap = input as Partial<TicketSnapshot>;
  if (!Array.isArray(snap.tickets)) return { ok: false, error: 'tickets 배열이 필요합니다.' };
  const restored: EscalationTicket[] = [];
  for (const t of snap.tickets) {
    if (!t || typeof t !== 'object') continue;
    const c = t as EscalationTicket;
    if (typeof c.id !== 'string' || !c.id.trim()) continue;
    if (typeof c.sessionId !== 'string' || !c.sessionId.trim()) continue;
    if (!ESCALATION_STATUSES.includes(c.status)) continue;
    restored.push({
      ...c,
      reason: typeof c.reason === 'string' && c.reason ? c.reason : 'user_request',
      reasonCode: isHandoffReason(c.reasonCode) ? c.reasonCode : toReasonCode(c.reason),
      message: String(c.message ?? '').slice(0, 300),
      createdAt: typeof c.createdAt === 'string' ? c.createdAt : now(),
      updatedAt: typeof c.updatedAt === 'string' ? c.updatedAt : now(),
    });
  }
  tickets = restored;
  const maxSeq = restored.reduce((m, t) => {
    const n = Number(String(t.id).replace(/[^0-9]/g, ''));
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  seq = typeof snap.seq === 'number' && snap.seq > maxSeq ? snap.seq : maxSeq;
  return { ok: true, count: restored.length };
}

/** 세션당 열린 티켓(open/in_progress)이 있으면 재사용해 중복 접수를 막는다. */
export function createTicket(input: {
  sessionId?: string;
  reason?: string;
  /** 호출자가 사유 코드를 이미 알고 있을 때 지정(예: 슬롯 수집 폼). 없으면 reason 문자열로 추론한다. */
  reasonCode?: HandoffReason;
  message?: string;
  contact?: string;
  summary?: string;
}): {
  ticket: EscalationTicket;
  created: boolean;
} {
  const sessionId = (input.sessionId || 'anon').trim() || 'anon';
  const existing = tickets.find((t) => t.sessionId === sessionId && (t.status === 'open' || t.status === 'in_progress'));
  if (existing) {
    existing.updatedAt = now();
    if (input.contact) existing.contact = String(input.contact).trim().slice(0, 100);
    // 요약은 항상 최신 대화 기준으로 갱신한다(상담원이 오래된 요약을 보면 이관이 무의미해진다).
    if (input.summary) existing.summary = String(input.summary).slice(0, 4000);
    persist();
    return { ticket: { ...existing }, created: false };
  }
  seq += 1;
  const reason = (input.reason || 'user_request').trim() || 'user_request';
  const ticket: EscalationTicket = {
    id: `ESC-${String(seq).padStart(4, '0')}`,
    sessionId,
    reason,
    reasonCode: input.reasonCode ?? toReasonCode(reason),
    message: String(input.message || '').trim().slice(0, 300),
    summary: input.summary ? String(input.summary).slice(0, 4000) : undefined,
    contact: input.contact ? String(input.contact).trim().slice(0, 100) : undefined,
    status: 'open',
    createdAt: now(),
    updatedAt: now(),
  };
  tickets.push(ticket);
  persist();
  return { ticket: { ...ticket }, created: true };
}

export function getTicket(id: string): EscalationTicket | undefined {
  const t = tickets.find((x) => x.id === id);
  return t ? { ...t } : undefined;
}

export function listTickets(): EscalationTicket[] {
  return [...tickets].reverse().map((t) => ({ ...t }));
}

export type UpdateTicketResult = { ok: true; ticket: EscalationTicket } | { ok: false; error: string };

export function updateTicket(id: string, patch: { status?: EscalationStatus; note?: string }): UpdateTicketResult {
  const t = tickets.find((x) => x.id === id);
  if (!t) return { ok: false, error: '해당 티켓이 없습니다.' };
  if (patch.status !== undefined) {
    if (!ESCALATION_STATUSES.includes(patch.status)) return { ok: false, error: '잘못된 상태값입니다.' };
    t.status = patch.status;
  }
  if (patch.note !== undefined) t.note = String(patch.note).trim().slice(0, 500) || undefined;
  t.updatedAt = now();
  persist();
  return { ok: true, ticket: { ...t } };
}

/**
 * 대기열 순번 — 접수(open) 상태 티켓을 접수순으로 세어 몇 번째인지 돌려준다.
 * 실제 상담사 배정 큐가 아니라 접수 순서 표시용이다(운영 KPI·예상 대기시간을 계산하지 않는다).
 * 상담 중(in_progress)·완료 티켓은 대기열에서 빠진다.
 */
export function queuePosition(id: string): { position: number; waiting: number } | null {
  const waitingList = tickets.filter((t) => t.status === 'open');
  const idx = waitingList.findIndex((t) => t.id === id);
  if (idx < 0) return null;
  return { position: idx + 1, waiting: waitingList.length };
}

export function escalationStats(): {
  total: number;
  open: number;
  inProgress: number;
  resolved: number;
  canceled: number;
  byReason: Record<HandoffReason, number>;
} {
  const c = (s: EscalationStatus) => tickets.filter((t) => t.status === s).length;
  const byReason = { low_confidence: 0, customer_request: 0, policy: 0, error: 0, max_retry: 0 } as Record<HandoffReason, number>;
  for (const t of tickets) byReason[t.reasonCode] = (byReason[t.reasonCode] ?? 0) + 1;
  return {
    total: tickets.length,
    open: c('open'),
    inProgress: c('in_progress'),
    resolved: c('resolved'),
    canceled: c('canceled'),
    byReason,
  };
}

export function resetTickets(): void {
  tickets = [];
  seq = 0;
  persist();
}

// 기동 시 복원 — 승인 전(PERSIST_PII 미설정)에는 storage가 차단하므로 아무 일도 일어나지 않는다.
(function loadPersisted() {
  const r = loadJson(TICKETS_NS);
  if (!r.ok) return;
  importTickets(r.data);
})();
