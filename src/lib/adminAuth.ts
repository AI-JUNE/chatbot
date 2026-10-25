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
import { clamp, envNumber } from '@/lib/num';

/**
 * 설정값을 수로 읽는 자는 `lib/num` 하나다 (DS 65-3) — 빈 값(`ADMIN_LOCK_MINUTES=`)은
 * **설정하지 않음**이지 0 이 아니다(0 은 아래 범위에 당겨져 잠금 시간을 최솟값으로 바꾼다).
 * 범위 밖을 당기는 것은 종전 그대로다(정책 상수).
 */
function envInt(name: string, fallback: number, min: number, max: number): number {
  const v = envNumber(name);
  return clamp(v === null ? fallback : Math.trunc(v), min, max);
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

/**
 * 자리를 비운다 — **잠금은 마지막에 지운다** (DS 51-1).
 *
 * 종전에는 상한에 닿으면 삽입 순서 맨 앞을 그대로 지웠다. 그 자리에 **지금 잠겨 있는 키**가
 * 있으면 잠금이 말없이 풀렸다 — 열쇠를 바꿔 가며 2,000칸을 채우면 다른 사람의 10분 잠금을
 * 밀어낼 수 있었다(열쇠가 요청자의 손에 있던 것이 종전 문제의 뿌리다 — `lib/ratelimit.clientIp`).
 * 잠기지 않은 자리를 먼저 쓰고, 전부 잠겨 있으면 **가장 먼저 풀리는 잠금**부터 지운다
 * (지우지 않고 멈추면 새 실패를 세지 못해, 자리를 가득 채운 쪽이 그 뒤로 마음껏 시도한다).
 */
function sweep(now: number): void {
  if (attempts.size < MAX_KEYS) return;
  for (const [k, v] of attempts) if (now - v.at > IDLE_RESET_MS && now >= v.lockedUntil) attempts.delete(k);
  while (attempts.size >= MAX_KEYS) {
    let victim: string | undefined;
    let soonest = Infinity;
    for (const [k, v] of attempts) {
      if (now >= v.lockedUntil) {
        victim = k;
        break;
      }
      if (v.lockedUntil < soonest) {
        soonest = v.lockedUntil;
        victim = k;
      }
    }
    if (victim === undefined) break;
    attempts.delete(victim);
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
