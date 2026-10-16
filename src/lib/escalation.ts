// 상담원 폴백(에스컬레이션) 티켓 스토어.
// 영속화는 `@/lib/storage`의 `tickets` 네임스페이스에 위임한다. 티켓은 연락처·문의 내용을 담는
// **개인정보 포함 데이터**이므로 `PERSIST_PII=true` **[승인 필요]** 전까지 디스크에 쓰지 않는다
// (코드는 완성, 스위치만 잠금). 승인 전에는 기존과 동일하게 서버 메모리에만 유지된다.
// [승인 필요] 실제 상담원 알림(SMS/슬랙 등) 연동.
// 이관 사유 코드(reasonCode)와 요약(summary)은 AICC-Core `src/core/handoffSummary.ts` 어휘를 따른다.
import { isHandoffReason, type HandoffReason } from '@/lib/handoff';
import { maskPii, mergeKinds } from '@/lib/pii';
import { SUMMARY_TEXT_LEN, TICKET_MESSAGE_LEN, TICKET_NOTE_LEN, clip } from '@/lib/limits';
import { loadJson, scheduleSave } from '@/lib/storage';
import { BAD_STATUS_MESSAGE, RESTORE_FORMAT_MESSAGE, STALE_TARGET_MESSAGE } from '@/lib/refusal';

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
  /**
   * 어느 고객사(테넌트)의 위젯에서 들어온 접수인가. 없으면 기본 구성(고원)이다 (DS 36-2).
   *
   * 상담원이 전화를 걸기 전에 가장 먼저 알아야 하는 값이다 — 이음 위젯은 「담당 코디네이터에게
   * 연결해 드릴게요」라고 약속하고 끝나므로, 이 값이 없으면 상담원은 어느 회사 이름으로 인사할지
   * 모른 채 전화를 건다. 종전에는 테넌트가 요청 로그에만 남아 큐·상세·이관 요약 어디에도 없었다.
   */
  tenant?: string;
  reason: string; // user_request | rule:agent | rule:complaint | fallback 등(원인 상세)
  /** AICC-Core Handoff 사유 코드. 채널·저장소가 달라도 같은 어휘로 집계된다. */
  reasonCode: HandoffReason;
  /**
   * 요청 시점 마지막 사용자 메시지 — **개인정보를 가린 뒤** 저장한다 (DS 39-2).
   *
   * 종전에는 원문이었다. 그래서 같은 접수 안에서 **「이관 요약」은 가려지고 바로 위 칸
   * 「고객이 마지막으로 한 말」은 원문**이라는 모양이 됐다(요약만 `buildHandoffSummary` 를
   * 지났다). 이 칸은 접수 큐 목록·상세 서랍·백업 스냅샷으로 그대로 나간다.
   */
  message: string;
  /**
   * 고객이 남긴 연락처(선택) — 개인정보 영구 저장은 [승인 필요].
   *
   * **이 칸은 가리지 않는다.** 상담원이 전화를 걸 대상이고, 가리면 접수가 쓸모를 잃는다.
   * 대신 ① 화면에서 기본 마스킹 + 「보기」(`maskContact`) ② 완료·취소 시 즉시 파기
   * (`contactPurgedAt`) ③ 고객에게 되읽을 때 마스킹(`chat.contactTail`) 세 겹으로 다룬다.
   * 「저장할 때 가린다」와 「받아서 쓰되 보여줄 때 가린다」는 다른 칸에 쓰는 다른 규칙이다.
   */
  contact?: string;
  /** 접수 본문에서 가린 개인정보의 종류(`@/lib/pii` 코드). 없으면 칸도 없다 (DS 39-2). */
  piiKinds?: string[];
  /**
   * 연락처를 파기한 시각(ISO). 개인정보처리방침 4조가 「상담원 연결을 위한 연락처는 상담 완료 후
   * 지체 없이 파기합니다」라고 약속하는데, 종전에는 그 약속을 지킬 경로가 코드에 없었다 —
   * 완료·취소로 바뀐 뒤에도 연락처가 티켓에 남아 목록·상세·백업·CSV 로 계속 나갔고,
   * 운영자가 지울 수 있는 유일한 수단은 티켓을 통째로 비우는 것(이관 근거까지 함께 사라진다)뿐이었다.
   * 이제 완료·취소 시 `contact` 를 지우고 **지웠다는 사실과 시각만** 남긴다 — 「처음부터 연락처가
   * 없던 접수」와 「받았다가 파기한 접수」는 다른 사실이라 화면에서 구분해야 한다.
   */
  contactPurgedAt?: string;
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
  if (!input || typeof input !== 'object') return { ok: false, error: RESTORE_FORMAT_MESSAGE };
  const snap = input as Partial<TicketSnapshot>;
  if (!Array.isArray(snap.tickets)) return { ok: false, error: RESTORE_FORMAT_MESSAGE };
  const restored: EscalationTicket[] = [];
  for (const t of snap.tickets) {
    if (!t || typeof t !== 'object') continue;
    const c = t as EscalationTicket;
    if (typeof c.id !== 'string' || !c.id.trim()) continue;
    if (typeof c.sessionId !== 'string' || !c.sessionId.trim()) continue;
    if (!ESCALATION_STATUSES.includes(c.status)) continue;
    // 파기된 연락처는 복원하지 않는다 — 파기 이전에 뜬 백업을 되돌리면 되살아나던 자리다.
    const purgedAt = typeof c.contactPurgedAt === 'string' && c.contactPurgedAt ? c.contactPurgedAt : undefined;
    // 복원 경로도 같은 관문을 지난다 (DS 39-2) — 마스킹 이전에 뜬 스냅샷에는 본문 원문이 있다.
    const body = maskPii(String(c.message ?? ''));
    const kinds = mergeKinds(Array.isArray(c.piiKinds) ? c.piiKinds : [], body.hits);
    const entry: EscalationTicket = {
      ...c,
      ...(purgedAt ? { contact: undefined, contactPurgedAt: purgedAt } : {}),
      // 옛 스냅샷에는 고객사가 없다 — 지어내지 않고 비워 둔다(화면이 「기본」이라 말한다).
      ...(typeof c.tenant === 'string' && c.tenant ? { tenant: c.tenant } : { tenant: undefined }),
      reason: typeof c.reason === 'string' && c.reason ? c.reason : 'user_request',
      reasonCode: isHandoffReason(c.reasonCode) ? c.reasonCode : toReasonCode(c.reason),
      message: clip(body.text, TICKET_MESSAGE_LEN),
      createdAt: typeof c.createdAt === 'string' ? c.createdAt : now(),
      updatedAt: typeof c.updatedAt === 'string' ? c.updatedAt : now(),
    };
    // 가린 종류는 우리가 센 값이다 — 옛 스냅샷의 알 수 없는 코드는 그대로 들고 오지 않는다.
    if (kinds.length) entry.piiKinds = kinds;
    else delete entry.piiKinds;
    restored.push(entry);
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
  /**
   * 어느 고객사의 접수인가(등록된 테넌트 id, 기본 구성이면 null) — **필수로 둔다** (DS 36-2).
   * 접수를 만드는 자리가 여섯 곳이라, 선택 항목으로 두면 새로 생긴 경로가 조용히 비워 둔다.
   * 타입 검사에서 막아 모든 자리가 「어느 회사 손님인가」를 적고 지나가게 한다.
   */
  tenant: string | null;
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
    if (input.contact) {
      existing.contact = String(input.contact).trim().slice(0, 100);
      // 다시 받은 연락처는 「파기됨」이 아니다(다시 열린 접수에 새로 남긴 경우).
      delete existing.contactPurgedAt;
    }
    // 요약은 항상 최신 대화 기준으로 갱신한다(상담원이 오래된 요약을 보면 이관이 무의미해진다).
    // 상한은 **요약을 만드는 쪽이** 지킨다(`renderSummaryText` — 마스킹 줄을 남기고 직전 대화를
    // 줄인다). 여기는 마지막 보호막이고, 걸리면 그 사실을 표시로 남긴다(DS 38-2).
    if (input.summary) existing.summary = clip(input.summary, SUMMARY_TEXT_LEN);
    // 재사용하는 접수에도 고객사를 채운다 — 세션이 먼저 적지 못한 채 접수가 생겼을 수 있다.
    if (input.tenant && !existing.tenant) existing.tenant = input.tenant;
    persist();
    return { ticket: { ...existing }, created: false };
  }
  seq += 1;
  const reason = (input.reason || 'user_request').trim() || 'user_request';
  // **가린 뒤에 자른다** (DS 39-1·39-2) — 먼저 자르면 상한 경계에 걸친 번호가 쪼개져 규칙에
  // 걸리지 않는다. 접수를 만드는 자리가 엔진·라우트에 걸쳐 일곱 곳이라, 가리는 몫은 그 자리마다
  // 적지 않고 **이 함수 하나**가 진다(고객사를 필수 인자로 둔 것과 같은 이유).
  const body = maskPii(String(input.message || '').trim());
  const ticket: EscalationTicket = {
    id: `ESC-${String(seq).padStart(4, '0')}`,
    sessionId,
    ...(input.tenant ? { tenant: input.tenant } : {}),
    reason,
    reasonCode: input.reasonCode ?? toReasonCode(reason),
    message: clip(body.text, TICKET_MESSAGE_LEN),
    ...(body.hits.length ? { piiKinds: body.hits } : {}),
    summary: input.summary ? clip(input.summary, SUMMARY_TEXT_LEN) : undefined,
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
  // 「티켓」·「상태값」은 코드 어휘다 — 운영자 화면은 「접수」라고 부른다(DS 29-3).
  if (!t) return { ok: false, error: STALE_TARGET_MESSAGE };
  if (patch.status !== undefined) {
    if (!ESCALATION_STATUSES.includes(patch.status)) return { ok: false, error: BAD_STATUS_MESSAGE };
    t.status = patch.status;
  }
  if (patch.note !== undefined) t.note = clip(String(patch.note).trim(), TICKET_NOTE_LEN) || undefined;
  // 상담이 끝났으면(완료·취소) 연락처를 그 자리에서 파기한다 — 방침 4조가 약속한 「지체 없이」다.
  // 되돌릴 수 없다: 다시 열어도 연락처는 돌아오지 않는다(고객이 새로 남기면 그때 다시 채워진다).
  // 이관 근거(사유·요약·대화)는 그대로 둔다 — 파기 대상은 개인정보인 연락처뿐이다.
  if ((t.status === 'resolved' || t.status === 'canceled') && t.contact) {
    delete t.contact;
    t.contactPurgedAt = now();
  }
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
