// 세션 문맥 스토어(인메모리 스텁) — 멀티턴 대화용.
// [승인 필요] 세션 영구 저장(DB/Redis) — 전까지 서버 메모리(TTL 30분, 최대 2000세션)만 유지.
import type { ChatSuggestion } from '@/lib/chat';
import type { HandoffReason, Speaker } from '@/lib/handoff';

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
  /** 수집한 슬롯(연락처 등) — 요약 생성 시 마스킹된다. 영구 저장은 [승인 필요] */
  slots?: Record<string, string>;
  updatedAt: number;
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

/** 최근 대화 버퍼에 1턴 추가(오래된 턴은 버린다). */
export function appendTurn(sessionId: string, turn: SessionTurn): void {
  const ctx = getSession(sessionId);
  const turns = [...(ctx.turns ?? []), turn].slice(-SESSION_TURN_BUFFER);
  updateSession(sessionId, { turns });
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
