// 세션 문맥 스토어(인메모리 스텁) — 멀티턴 대화용.
// [승인 필요] 세션 영구 저장(DB/Redis) — 전까지 서버 메모리(TTL 30분, 최대 2000세션)만 유지.
import type { ChatSuggestion } from '@/lib/chat';
import type { HandoffReason, Speaker } from '@/lib/handoff';
import type { FormState } from '@/lib/slots';

/** 이관 요약용 최근 대화 버퍼 1턴. 원문 그대로 두고 요약 생성 시점에 마스킹한다. */
export interface SessionTurn {
  at: string;
  speaker: Speaker;
  text: string;
  intent?: string;
}

/** 세션당 보관하는 최근 턴 수(요약 표시용 설정값 — 성능 지표가 아니다). */
export const SESSION_TURN_BUFFER = 12;

export interface SessionContext {
  /** 직전 폴백에서 제안한 연관 FAQ — "1"/"2번" 등 번호 선택 처리용 */
  pendingSuggestions?: ChatSuggestion[];
  /** 에스컬레이션 접수 직후 연락처 수집 대기 상태 */
  awaitingContact?: boolean;
  /** 이 세션에서 생성/재사용된 에스컬레이션 티켓 id */
  ticketId?: string;
  /** 신뢰도 임계 미만 응답이 연속으로 몇 번 나왔는지(자동 전환 판정용) */
  lowConfidenceStreak?: number;
  /** 이 세션에서 확정된 이관 사유 코드(AICC-Core Handoff 어휘) */
  handoffReason?: HandoffReason;
  /** 이관 요약에 넣을 최근 대화(최대 SESSION_TURN_BUFFER턴) */
  turns?: SessionTurn[];
  /**
   * 이 대화에서 **주고받은 메시지 전부**의 수 (DS 71-2).
   *
   * `turns` 는 최근 12턴만 들고 있어 그 길이로는 대화의 길이를 알 수 없다 — 종전에는 이관
   * 요약이 그 길이를 그대로 「주고받은 메시지: 12개」라고 적어, 쉰 마디를 나눈 대화도 열세
   * 마디를 나눈 대화도 상담원에게 **같은 수**로 갔다. 버린 턴은 되돌릴 수 없지만 **몇 마디
   * 였는지는 셀 수 있다** — 세는 값만 따로 든다(DS 43-1 이 대화 기록에서 「언제부터 들고
   * 있는가」를 따로 든 것과 같은 자리다).
   */
  turnTotal?: number;
  /** 수집한 슬롯(연락처 등) — 요약 생성 시 마스킹된다. 영구 저장은 [승인 필요] */
  slots?: Record<string, string>;
  /** 진행 중인 멀티턴 슬롯 수집 상태(예약 접수·장애 신고 등). 완료·취소 시 비운다. */
  form?: FormState;
  /**
   * 이 대화가 들어온 채널. 이관 요약이 상담원에게 **어디로 회신해야 하는지**를 알리는 값이다
   * — 종전에는 요약 생성이 언제나 'web' 로 적어, 카카오톡에서 온 접수도 홈페이지 상담창이라 말했다.
   * 비어 있으면 웹 위젯으로 본다(기본 진입점).
   */
  channel?: 'web' | 'kakao';
  /**
   * 이 대화가 **어느 고객사(테넌트)의 위젯**에서 들어왔는가 (DS 36-1·36-2).
   * 비어 있으면 기본 구성(고원 자체 안내 자료)으로 답한 대화다.
   *
   * 채널(`channel`)과 같은 자리에 둔다 — 상담원에게 「어디로 회신해야 하는가」를 알리는 값이
   * 채널이라면, 「어느 회사 손님인가」를 알리는 값이 이것이다. 종전에는 테넌트가 요청 로그에만
   * 남아(`rl.end`) 사람이 보는 화면 어디에도 도달하지 않았고, 접수·대화 기록·대시보드가
   * 모든 고객사를 한 줄에 섞었다. **등록된 테넌트만** 담는다(`resolvedTenantId`).
   */
  tenantId?: string;
  updatedAt: number;
}

/**
 * **「누구인지 모른다」를 가리키던 값들** (DS 51-2).
 *
 * 세션 식별자는 이 대화의 유일한 열쇠다(DS 49-3) — 서버는 이 글자 하나로 최근 12턴·수집한
 * 연락처·진행 중인 접수를 찾고, 접수 조회는 이 값으로 **주인을 가린다**(DS 49-1). 그런데
 * 세션을 보내지 않은 요청은 전부 `'anon'` 한 칸을 함께 썼고(카카오는 `kakao:kakao-anon`),
 * 그 값은 **코드에 적혀 있는 글자**다. 그래서 세 가지가 어긋났다:
 *  - 세션을 보내지 않은 두 손님은 **같은 사람**이 된다 — 한쪽이 남긴 연락처가 다른 쪽의 이관
 *    요약에 들어가고, 한쪽이 접수한 번호를 다른 쪽이 받는다. `awaitingContact` 도 공유되므로
 *    뒤에 온 사람의 **보통 질문이 연락처로 저장**된다(DS 35-3 이 한 세션 안에서 고친 그 모양이
 *    서로 모르는 사람 사이에서 일어난다).
 *  - 관리 콘솔 「응답 테스트」가 바로 그 칸을 쓰고 있었다 — 운영자의 시험 대화와 밖에서 온
 *    요청이 한 세션에 섞이고, 시험으로 생긴 접수가 `'anon'` 의 것으로 남는다.
 *  - 그래서 접수 주인 확인이 **알려진 글자 하나로 열린다**: `?id=ESC-0001&sessionId=anon`.
 *    49차가 접수번호 훑기를 막으려고 세운 문인데, 그 문에 공용 열쇠가 꽂혀 있었다.
 *
 * 이 값들은 「열쇠」로 쓰지 않는다 — 가리는 자리(`escalation.getTicketForSession`)가 거절하고,
 * 창구(라우트)는 세션을 들고 오지 않은 요청에 **한 번 쓰는 식별자**를 발급한다.
 */
const SHARED_SESSION_KEYS = new Set(['', 'anon', 'kakao-anon', 'kakao:', 'kakao:anon', 'kakao:kakao-anon']);

/** 여러 사람이 함께 쓰는(= 아무것도 지키지 못하는) 세션 값인가. */
export function isSharedSessionKey(id: unknown): boolean {
  if (typeof id !== 'string') return true;
  return SHARED_SESSION_KEYS.has(id.trim().toLowerCase());
}

/** 난수원이 없는 런타임의 마지막 그물 — **자릿수를 채운다**(DS 49-3 과 같은 규칙). */
function fallbackHex(bytes: number): string {
  let out = '';
  for (let i = 0; i < bytes * 2; i += 1) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

/**
 * 세션을 들고 오지 않은 요청에 **서버가 한 번 쓰는 식별자**를 발급한다 (DS 51-2).
 *
 * 이어지지 않는다 — 세션을 보내지 않았으면 이 대화에는 문맥이 없는 것이 사실이고, 그 사실을
 * 공용 칸으로 메우면 **남의 대화**가 문맥이 된다. 모양은 서버 입력 상한(60자) 안이고,
 * 추측할 수 없는 값이다(위젯의 식별자와 같은 난수원 · DS 49-3).
 */
export function newVisitorSessionId(prefix = 'web'): string {
  const c: Crypto | undefined = typeof globalThis.crypto === 'undefined' ? undefined : globalThis.crypto;
  let hex = '';
  if (c && typeof c.randomUUID === 'function') hex = c.randomUUID().replace(/-/g, '');
  else if (c && typeof c.getRandomValues === 'function') {
    const buf = new Uint8Array(16);
    c.getRandomValues(buf);
    hex = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
  } else hex = fallbackHex(16);
  return `${prefix}_${hex}`;
}

const TTL_MS = 30 * 60 * 1000; // 30분
const MAX_SESSIONS = 2000;

const store = new Map<string, SessionContext>();

function sweep(): void {
  const now = Date.now();
  for (const [k, v] of store) {
    if (now - v.updatedAt > TTL_MS) store.delete(k);
  }
  // 과밀 시 오래된 것부터 제거(Map은 삽입 순서 유지)
  while (store.size > MAX_SESSIONS) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

export function getSession(sessionId: string): SessionContext {
  sweep();
  const key = sessionId || 'anon';
  let ctx = store.get(key);
  if (!ctx || Date.now() - ctx.updatedAt > TTL_MS) {
    ctx = { updatedAt: Date.now() };
    store.set(key, ctx);
  }
  return ctx;
}

export function updateSession(sessionId: string, patch: Partial<Omit<SessionContext, 'updatedAt'>>): void {
  const key = sessionId || 'anon';
  const prev = store.get(key) ?? { updatedAt: Date.now() };
  // 삽입 순서 갱신(최근 사용 세션이 뒤로 가도록 재삽입)
  store.delete(key);
  store.set(key, { ...prev, ...patch, updatedAt: Date.now() });
}

/**
 * 최근 대화 버퍼에 1턴 추가(오래된 턴은 버린다).
 * 버리더라도 **세어는 둔다** — 그 수가 이관 요약의 「주고받은 메시지」다 (DS 71-2).
 */
export function appendTurn(sessionId: string, turn: SessionTurn): void {
  const ctx = getSession(sessionId);
  const turns = [...(ctx.turns ?? []), turn].slice(-SESSION_TURN_BUFFER);
  updateSession(sessionId, { turns, turnTotal: (ctx.turnTotal ?? 0) + 1 });
}

/** 슬롯 병합(빈 값은 무시). */
export function setSlot(sessionId: string, key: string, value: string): void {
  const v = (value || '').trim();
  if (!key || !v) return;
  const ctx = getSession(sessionId);
  updateSession(sessionId, { slots: { ...(ctx.slots ?? {}), [key]: v } });
}

export function resetSessions(): void {
  store.clear();
}
