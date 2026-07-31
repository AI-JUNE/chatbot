// 상담원 폴백(에스컬레이션) 티켓 스토어 — 인메모리 스텁.
// [승인 필요] DB 영구 저장·실제 상담원 알림(SMS/슬랙 등) 연동 — 전까지 서버 메모리에만 유지.

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
  reason: string; // user_request | rule:agent | rule:complaint | fallback 등
  message: string; // 요청 시점 마지막 사용자 메시지(요약용)
  contact?: string; // 고객이 남긴 연락처(선택) — 개인정보 영구 저장은 [승인 필요]
  status: EscalationStatus;
  note?: string; // 상담원 메모
  createdAt: string;
  updatedAt: string;
}

let tickets: EscalationTicket[] = [];
let seq = 0;

function now(): string {
  return new Date().toISOString();
}

/** 세션당 열린 티켓(open/in_progress)이 있으면 재사용해 중복 접수를 막는다. */
export function createTicket(input: { sessionId?: string; reason?: string; message?: string; contact?: string }): {
  ticket: EscalationTicket;
  created: boolean;
} {
  const sessionId = (input.sessionId || 'anon').trim() || 'anon';
  const existing = tickets.find((t) => t.sessionId === sessionId && (t.status === 'open' || t.status === 'in_progress'));
  if (existing) {
    existing.updatedAt = now();
    if (input.contact) existing.contact = String(input.contact).trim().slice(0, 100);
    return { ticket: { ...existing }, created: false };
  }
  seq += 1;
  const ticket: EscalationTicket = {
    id: `ESC-${String(seq).padStart(4, '0')}`,
    sessionId,
    reason: (input.reason || 'user_request').trim() || 'user_request',
    message: String(input.message || '').trim().slice(0, 300),
    contact: input.contact ? String(input.contact).trim().slice(0, 100) : undefined,
    status: 'open',
    createdAt: now(),
    updatedAt: now(),
  };
  tickets.push(ticket);
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
  return { ok: true, ticket: { ...t } };
}

export function escalationStats(): { total: number; open: number; inProgress: number; resolved: number; canceled: number } {
  const c = (s: EscalationStatus) => tickets.filter((t) => t.status === s).length;
  return { total: tickets.length, open: c('open'), inProgress: c('in_progress'), resolved: c('resolved'), canceled: c('canceled') };
}

export function resetTickets(): void {
  tickets = [];
  seq = 0;
}
