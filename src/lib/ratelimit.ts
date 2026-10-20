// 인메모리 rate limit (고정 윈도) — 공통 런치 P0-6.
// 인스턴스 단위 스텁(서버리스는 인스턴스별 카운트). 전역 저장소(Redis 등) 연동은 [승인 필요].
// 순수 로직(rateCheck)은 주입식 now로 테스트 가능.

import { NextResponse } from 'next/server';
import { errorBody, fail } from '@/lib/http';
import { clientKey } from '@/lib/clientKey';

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const MAX_KEYS = 5000; // 메모리 상한 — 초과 시 만료분 정리 후 오래된 키 제거

export type RateResult = { allowed: boolean; remaining: number; retryAfterSec: number };

export function rateCheck(
  store: Map<string, Bucket>,
  key: string,
  limit: number,
  windowMs: number,
  now: number,
): RateResult {
  const b = store.get(key);
  if (!b || now >= b.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterSec: 0 };
  }
  if (b.count >= limit) {
    return { allowed: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  }
  b.count += 1;
  return { allowed: true, remaining: limit - b.count, retryAfterSec: 0 };
}

function sweep(store: Map<string, Bucket>, now: number) {
  if (store.size < MAX_KEYS) return;
  for (const [k, v] of store) if (now >= v.resetAt) store.delete(k);
  while (store.size >= MAX_KEYS) {
    const first = store.keys().next().value;
    if (first === undefined) break;
    store.delete(first);
  }
}

/**
 * 요청자를 가리는 열쇠는 **의존성 없는 모듈**에 있다 (DS 51-1) — 이 파일은 `next/server` 를
 * 끌어오므로 런타임 테스트가 닿지 못한다. 종전에는 그 안에 「요청자가 고칠 수 있는 값을
 * 그대로 쓴다」는 결함이 들어 있었고, 검사는 소스 텍스트 대조 두 줄뿐이었다.
 */
export { clientKey, looksLikeIp, UNKNOWN_CLIENT } from '@/lib/clientKey';

/** 라우트용 헬퍼: scope별 요청자 기준 제한. 기본 60회/분. */
export function checkRate(scope: string, headers: Headers, limit = 60, windowMs = 60_000): RateResult {
  const now = Date.now();
  sweep(buckets, now);
  return rateCheck(buckets, `${scope}:${clientKey(headers)}`, limit, windowMs, now);
}

/** 표준 429 응답 본문 — lib/http 표준 오류 포맷(code/error/message) 사용. */
export function rateLimitBody(r: RateResult) {
  return errorBody('rate_limited', undefined, { retryAfterSec: r.retryAfterSec });
}

/**
 * 라우트 가드: 제한 초과 시 표준 429 응답(Retry-After 포함), 통과하면 null.
 * 사용: `const limited = rateGuard('chat', req.headers, 60); if (limited) return limited;`
 */
export function rateGuard(scope: string, headers: Headers, limit = 60, windowMs = 60_000): NextResponse | null {
  const r = checkRate(scope, headers, limit, windowMs);
  if (r.allowed) return null;
  return fail('rate_limited', undefined, { retryAfterSec: r.retryAfterSec }, {
    headers: { 'Retry-After': String(r.retryAfterSec) },
  });
}
