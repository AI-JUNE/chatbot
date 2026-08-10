// 인메모리 rate limit (고정 윈도) — 공통 런치 P0-6.
// 인스턴스 단위 스텁(서버리스는 인스턴스별 카운트). 전역 저장소(Redis 등) 연동은 [승인 필요].
// 순수 로직(rateCheck)은 주입식 now로 테스트 가능.

import { NextResponse } from 'next/server';
import { errorBody, fail } from '@/lib/http';

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

/** 요청 헤더에서 클라이언트 식별자(프록시 뒤 첫 IP, 없으면 'unknown'). */
export function clientIp(headers: Headers): string {
  const fwd = headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim().slice(0, 64) || 'unknown';
  return headers.get('x-real-ip')?.slice(0, 64) || 'unknown';
}

/** 라우트용 헬퍼: scope별 IP 기준 제한. 기본 60회/분. */
export function checkRate(scope: string, headers: Headers, limit = 60, windowMs = 60_000): RateResult {
  const now = Date.now();
  sweep(buckets, now);
  return rateCheck(buckets, `${scope}:${clientIp(headers)}`, limit, windowMs, now);
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
