// 세션 문맥 스토어(인메모리 스텁) — 멀티턴 대화용.
// [승인 필요] 세션 영구 저장(DB/Redis) — 전까지 서버 메모리(TTL 30분, 최대 2000세션)만 유지.
import type { ChatSuggestion } from '@/lib/chat';

export interface SessionContext {
  /** 직전 폴백에서 제안한 연관 FAQ — "1"/"2번" 등 번호 선택 처리용 */
  pendingSuggestions?: ChatSuggestion[];
  /** 에스컬레이션 접수 직후 연락처 수집 대기 상태 */
  awaitingContact?: boolean;
  /** 이 세션에서 생성/재사용된 에스컬레이션 티켓 id */
  ticketId?: string;
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

export function resetSessions(): void {
  store.clear();
}
