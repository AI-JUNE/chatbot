/**
 * 관리자 인증 보조 — 실패 횟수 기반 잠금(brute force 방어).
 *
 * 유량 제한(rate limit)만으로는 "느리게 오래 시도하는" 대입을 막지 못한다.
 * 토큰이 **틀렸을 때만** 카운트를 올리고, 임계에 도달하면 일정 시간 잠근다.
 * 성공하면 즉시 카운트를 비운다.
 *
 * 범위: 인스턴스 단위(서버리스는 인스턴스별). 전역 공유 잠금은 [승인 필요](공유 저장소 도입 후).
 * 기록하는 것: 클라이언트 키(IP)와 실패 횟수뿐. 토큰 값은 어디에도 남기지 않는다.
 */

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(Math.trunc(raw), min), max);
}

/** 이 횟수만큼 연속 실패하면 잠근다. */
export function lockThreshold(): number {
  return envInt('ADMIN_LOCK_THRESHOLD', 5, 3, 100);
}

/** 잠금 지속 시간(ms). */
export function lockDurationMs(): number {
  return envInt('ADMIN_LOCK_MINUTES', 10, 1, 24 * 60) * 60_000;
}

interface Attempts {
  failures: number;
  lockedUntil: number;
  at: number;
}

const attempts = new Map<string, Attempts>();
const MAX_KEYS = 2000;
/** 이 시간 동안 아무 시도가 없으면 카운트를 잊는다. */
const IDLE_RESET_MS = 60 * 60_000;

function sweep(now: number): void {
  if (attempts.size < MAX_KEYS) return;
  for (const [k, v] of attempts) if (now - v.at > IDLE_RESET_MS && now >= v.lockedUntil) attempts.delete(k);
  while (attempts.size >= MAX_KEYS) {
    const first = attempts.keys().next().value;
    if (first === undefined) break;
    attempts.delete(first);
  }
}

export interface LockoutStatus {
  locked: boolean;
  failures: number;
  /** 잠금 해제까지 남은 초(잠겨 있지 않으면 0). */
  retryAfterSec: number;
  /** 잠기기까지 남은 시도 횟수. */
  remaining: number;
}

function statusOf(rec: Attempts | undefined, now: number): LockoutStatus {
  const threshold = lockThreshold();
  if (!rec || now - rec.at > IDLE_RESET_MS) return { locked: false, failures: 0, retryAfterSec: 0, remaining: threshold };
  const locked = now < rec.lockedUntil;
  return {
    locked,
    failures: rec.failures,
    retryAfterSec: locked ? Math.max(1, Math.ceil((rec.lockedUntil - now) / 1000)) : 0,
    remaining: Math.max(0, threshold - rec.failures),
  };
}

/** 시도하지 않고 현재 잠금 상태만 확인한다. */
export function lockoutStatus(key: string, now: number = Date.now()): LockoutStatus {
  return statusOf(attempts.get(key), now);
}

/**
 * 인증 시도 1건을 기록하고 결과 상태를 돌려준다.
 * 이미 잠겨 있으면 카운트를 더 올리지 않는다(잠금 연장 남용 방지).
 */
export function recordAttempt(key: string, success: boolean, now: number = Date.now()): LockoutStatus {
  sweep(now);
  const prev = attempts.get(key);
  const before = statusOf(prev, now);
  if (before.locked) return before;

  if (success) {
    attempts.delete(key);
    return { locked: false, failures: 0, retryAfterSec: 0, remaining: lockThreshold() };
  }

  const failures = (before.failures || 0) + 1;
  const threshold = lockThreshold();
  const lockedUntil = failures >= threshold ? now + lockDurationMs() : 0;
  attempts.set(key, { failures, lockedUntil, at: now });
  return statusOf(attempts.get(key), now);
}

/** 테스트·재기동용 초기화. */
export function resetLockouts(): void {
  attempts.clear();
}
