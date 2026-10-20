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
import { revOf } from '@/lib/rev';
import { safeEqual } from '@/lib/webhookAuth';
import { BAD_STATUS_MESSAGE, RESTORE_FORMAT_MESSAGE, STALE_TARGET_MESSAGE, changedStatusMessage } from '@/lib/refusal';

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
    /**
     * 「고객이 마지막으로 한 말」을 **다시 요청할 때마다** 갱신한다 (DS 50-3).
     *
     * 세션당 열린 접수는 재사용되므로 한 접수가 30분짜리 대화 전체를 덮을 수 있다. 종전에는
     * 이 칸이 **첫 접수 때의 말**에서 멈췄고, 바로 아래 「이관 요약」만 최신 대화로 갱신됐다 —
     * 한 접수 안에서 10:00 의 「배송이 안 와요」와 10:25 의 「그냥 환불해 주세요」가 서로 다른
     * 칸에 적힌 티켓이 된다. 상담원이 전화를 걸기 전에 읽는 칸은 **이름이 「마지막」이라고 적힌
     * 쪽**이고, 그 값이 거기서 가장 오래된 말이었다(DS 20-3 이 이 칸이 비는 것을 고친 그 자리 —
     * 그때 본 것은 「비었다」이고, 이번에 본 것은 「멈췄다」다).
     *
     * 빈 값으로는 덮지 않는다 — 되살린 대화에 고객 말이 없으면(`lastUserText` 가 빈 문자열)
     * 적어 둔 말을 지우는 쪽이 더 나쁘다. 가리는 관문도 **같은 함수 안에서** 지난다(DS 39-2):
     * 이 자리를 그냥 대입하면 재사용 경로만 마스킹을 건너뛰어, 번호가 든 본문이 운영자 화면·
     * 백업·CSV 로 원문째 나간다.
     */
    const resaid = String(input.message || '').trim();
    if (resaid) {
      const body = maskPii(resaid);
      existing.message = clip(body.text, TICKET_MESSAGE_LEN);
      // 가린 종류는 **지금 본문의 것**이다 — 본문이 바뀌었으므로 앞 본문의 종류를 들고 있으면
      // 화면이 「가린 것이 있다」고 말하는데 정작 그 자리가 없다.
      if (body.hits.length) existing.piiKinds = body.hits;
      else delete existing.piiKinds;
    }
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

/**
 * **이 접수가 이 세션의 것인가** — 고객이 자기 접수를 조회하는 유일한 길 (DS 49-1).
 *
 * 접수번호는 연번(`ESC-0001`)이라 그 자체로는 아무것도 지키지 못한다. 종전에 고객용 조회
 * 창구(`GET /api/escalation`)는 번호만 받아 상태·이관 사유·접수 시각·대기 인원을 돌려줬고,
 * 인증도 횟수 제한도 없었다 — 밖에서 1번부터 훑으면 접수가 몇 건이고 언제 들어왔고 무엇
 * 때문에 넘어간 건인지가 그대로 읽혔다.
 *
 * 가리는 자는 **한 벌**이다(DS 42-2·46-1 과 같은 규칙) — 라우트가 「찾기」와 「주인 확인」을
 * 따로 적으면 조회 자리가 늘어날 때 한쪽이 빠진다. 없는 번호와 남의 번호는 **같은 답**
 * (`undefined`)으로 돌려준다: 다르게 거절하면 그 차이가 곧 「있다/없다」를 알려 주는 자다.
 * 비교는 상수 시간으로 한다(`safeEqual` — 세션 식별자도 이 대화의 열쇠다 · DS 49-3).
 */
export function getTicketForSession(id: string, sessionId: string): EscalationTicket | undefined {
  const sid = String(sessionId || '').trim();
  if (!sid) return undefined;
  const t = tickets.find((x) => x.id === id);
  if (!t || !safeEqual(t.sessionId, sid)) return undefined;
  return { ...t };
}

export function listTickets(): EscalationTicket[] {
  return [...tickets].reverse().map((t) => ({ ...t }));
}

/** 한 번에 내려보내는 접수 수의 기본값·상한 (DS 43-3). */
export const TICKET_PAGE_DEFAULT = 200;
export const TICKET_PAGE_MAX = 1000;

export interface TicketPage {
  /** 내려보낼 접수(최신순). */
  tickets: EscalationTicket[];
  /** 보관 중인 전체 접수 수 — **보여 준 수를 전체라고 말하지 않는다**(DS 31-3). */
  total: number;
  /** 이번에 적용한 상한. */
  limit: number;
  /** 전체를 담지 못했는가. */
  truncated: boolean;
}

/**
 * 접수 목록 한 묶음 (DS 43-3).
 *
 * 종전에는 조회 라우트가 `listTickets()` 로 **전부** 실어 보냈고, 관리 콘솔은 그것을 30초마다
 * 다시 받았다(`OPS_POLL_MS`). 접수는 고객이 만드는 데이터라 상한이 없다 — 운영 반년이면 수천 건이
 * 되고, 그때도 화면은 15행씩 나눠 그리므로(DS 31-1) **보이는 것은 그대로인데 받는 양만** 커진다.
 *
 * 자를 때 **먼저 손대야 하는 것은 버리지 않는다**: 대기·상담 중 접수를 먼저 담고 남은 자리에
 * 최신 완료·취소를 채운다. 최신순으로만 자르면 완료 더미가 상한을 채워 **대기 중인 접수가
 * 화면에서 사라진다** — 이 화면의 일이 바로 그것을 보여 주는 것이다.
 */
export function queryTickets(limit: number = TICKET_PAGE_DEFAULT): TicketPage {
  const n = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), TICKET_PAGE_MAX) : TICKET_PAGE_DEFAULT;
  const all = listTickets();
  if (all.length <= n) return { tickets: all, total: all.length, limit: n, truncated: false };
  const live = all.filter((t) => t.status === 'open' || t.status === 'in_progress');
  const rest = all.filter((t) => t.status !== 'open' && t.status !== 'in_progress');
  const picked = live.length >= n ? live.slice(0, n) : [...live, ...rest.slice(0, n - live.length)];
  // 고른 뒤 **최신순으로 되돌린다** — 표의 기본 순서(최신순)가 뜻을 가진 화면이다.
  const order = new Map(all.map((t, i) => [t.id, i]));
  picked.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return { tickets: picked, total: all.length, limit: n, truncated: true };
}

/**
 * 접수 한 건의 모습 (DS 46-2) — 목록에 실어 보내는 쪽과 바꾸기 직전에 견주는 쪽이 같은 식을 쓴다.
 *
 * 연락처는 **있는가만** 센다(원문을 해시에 넣을 까닭이 없다). `updatedAt` 이 들어 있어
 * 상태가 같은 값으로 되돌아온 경우에도 「그 사이 누가 손댔다」를 놓치지 않는다.
 */
export function ticketRev(t: EscalationTicket): string {
  return revOf({ id: t.id, status: t.status, note: t.note ?? '', hasContact: Boolean(t.contact), updatedAt: t.updatedAt });
}

export type UpdateTicketResult =
  | { ok: true; ticket: EscalationTicket }
  | { ok: false; error: string; conflict?: 'gone' | 'changed'; current?: EscalationTicket };

export function updateTicket(id: string, patch: { status?: EscalationStatus; note?: string; baseRev?: string }): UpdateTicketResult {
  const t = tickets.find((x) => x.id === id);
  // 「티켓」·「상태값」은 코드 어휘다 — 운영자 화면은 「접수」라고 부른다(DS 29-3).
  if (!t) return { ok: false, error: STALE_TARGET_MESSAGE, conflict: 'gone' };
  /**
   * 내가 보던 모습이 아니면 바꾸지 않는다 (DS 46-2).
   *
   * 접수 목록은 30초마다 갱신되지만 운영자의 손은 그 사이에도 움직인다. 종전에는 A 가 완료로
   * 바꿔 **연락처를 파기한** 접수를 B 의 묵은 화면이 「상담 시작」으로 되돌릴 수 있었다 —
   * 되돌아온 접수는 회신할 곳이 없고(파기는 되돌릴 수 없다), 큐에는 아무도 전화할 수 없는
   * 건이 하나 선다. 거절하면서 **지금 무엇인지**를 이름으로 말한다.
   */
  const base = String(patch.baseRev ?? '').trim();
  if (base && ticketRev(t) !== base) {
    return { ok: false, error: changedStatusMessage(STATUS_LABELS[t.status]), conflict: 'changed', current: { ...t } };
  }
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
