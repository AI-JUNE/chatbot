/**
 * 웹훅 인증 공통 모듈 — HMAC 서명 검증 · 리플레이 차단 · 재시도(중복 전달) 멱등 처리.
 *
 * 왜 필요한가
 * - 스킬 URL은 공개 엔드포인트다. 토큰만으로는 본문 위·변조를 막지 못한다.
 * - 채널 플랫폼은 응답이 늦으면 **같은 이벤트를 다시 보낸다**. 그대로 처리하면
 *   티켓이 중복 접수되고 대화 로그가 두 번 쌓인다. 같은 이벤트는 같은 응답을 돌려줘야 한다.
 *
 * 원칙
 * - 시크릿은 환경변수에서만 읽는다(하드코딩 금지). 미설정이면 검증을 '미구성'으로 명확히 구분한다.
 * - 비교는 항상 상수 시간(timingSafeEqual). 길이 차이로도 정보가 새지 않도록 해시 후 비교한다.
 * - 서명·시크릿 값은 어떤 로그·응답에도 남기지 않는다.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** 프로세스마다 새로 만드는 비교용 키 — 길이·내용 어느 쪽으로도 타이밍이 새지 않게 한다. */
const COMPARE_KEY = randomBytes(32);

/** 상수 시간 문자열 비교. 길이가 달라도 즉시 반환하지 않는다. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHmac('sha256', COMPARE_KEY).update(String(a)).digest();
  const hb = createHmac('sha256', COMPARE_KEY).update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

/** 서명 대상 문자열 — 버전·타임스탬프·본문을 묶어 리플레이와 본문 교체를 함께 막는다. */
export function signingBase(timestamp: string, rawBody: string): string {
  return `v1:${timestamp}:${rawBody}`;
}

/** HMAC-SHA256 서명 생성(hex). 발신 측 구현·테스트에서 사용. */
export function signPayload(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(signingBase(timestamp, rawBody)).digest('hex');
}

export type SignatureFailure =
  | 'no_secret' // 서버에 시크릿 미설정 — 검증을 수행할 수 없음
  | 'missing_signature'
  | 'missing_timestamp'
  | 'bad_timestamp' // 숫자가 아님
  | 'expired' // 허용 시간창 밖(리플레이 의심)
  | 'mismatch';

export type SignatureResult = { ok: true } | { ok: false; reason: SignatureFailure };

/** 허용 시간창 기본값(초). 앞뒤 양방향으로 적용한다(시계 오차 대응). */
export const DEFAULT_TOLERANCE_SEC = 300;

export interface VerifyInput {
  secret: string | undefined;
  signature: string | null | undefined;
  timestamp: string | null | undefined;
  rawBody: string;
  nowMs?: number;
  toleranceSec?: number;
}

/**
 * 서명 검증. 실패 사유는 서버 로그용이며 **호출자에게 그대로 노출하지 않는다**
 * (어느 단계에서 틀렸는지 알려주면 공격자에게 힌트가 된다).
 */
export function verifySignature(input: VerifyInput): SignatureResult {
  const secret = input.secret || '';
  if (!secret) return { ok: false, reason: 'no_secret' };

  const sig = (input.signature || '').trim();
  if (!sig) return { ok: false, reason: 'missing_signature' };

  const ts = (input.timestamp || '').trim();
  if (!ts) return { ok: false, reason: 'missing_timestamp' };

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || tsNum <= 0) return { ok: false, reason: 'bad_timestamp' };

  // 초·밀리초 양쪽 표기를 받아들인다
  const tsMs = ts.length >= 13 ? tsNum : tsNum * 1000;
  const now = input.nowMs ?? Date.now();
  const tolerance = (input.toleranceSec ?? DEFAULT_TOLERANCE_SEC) * 1000;
  if (Math.abs(now - tsMs) > tolerance) return { ok: false, reason: 'expired' };

  // `v1=<hex>` / `sha256=<hex>` / 순수 hex 모두 허용
  const presented = sig.replace(/^(v1|sha256)=/i, '').toLowerCase();
  const expected = signPayload(secret, ts, input.rawBody);
  return safeEqual(presented, expected) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

// ---- 재시도(중복 전달) 멱등 처리 ----

export interface DedupeRecord {
  at: number;
  response?: unknown;
}

/** 인스턴스 단위 캐시. 서버리스는 인스턴스별이므로 완전한 전역 멱등은 [승인 필요](공유 저장소 도입 후). */
const seen = new Map<string, DedupeRecord>();
const MAX_KEYS = 2000;
export const DEFAULT_DEDUPE_TTL_MS = 60_000;

/** 이벤트 식별 키 — 원문(발화·사용자 id)을 그대로 남기지 않도록 해시한다. */
export function eventKey(parts: Array<string | undefined | null>): string {
  return createHmac('sha256', COMPARE_KEY).update(parts.map((p) => p ?? '').join('|')).digest('hex').slice(0, 32);
}

function sweep(store: Map<string, DedupeRecord>, now: number, ttlMs: number): void {
  for (const [k, v] of store) if (now - v.at > ttlMs) store.delete(k);
  while (store.size >= MAX_KEYS) {
    const first = store.keys().next().value;
    if (first === undefined) break;
    store.delete(first);
  }
}

/**
 * 중복 전달 검사 — 처음 보는 이벤트면 자리를 예약(duplicate:false)하고,
 * TTL 내 재전달이면 duplicate:true 와 (있다면) 이전 응답을 돌려준다.
 */
export function dedupeCheck(
  key: string,
  opts: { now?: number; ttlMs?: number; store?: Map<string, DedupeRecord> } = {},
): { duplicate: boolean; response?: unknown } {
  const store = opts.store ?? seen;
  const now = opts.now ?? Date.now();
  const ttl = opts.ttlMs ?? DEFAULT_DEDUPE_TTL_MS;
  sweep(store, now, ttl);

  const hit = store.get(key);
  if (hit && now - hit.at <= ttl) {
    return hit.response === undefined ? { duplicate: true } : { duplicate: true, response: hit.response };
  }
  store.set(key, { at: now });
  return { duplicate: false };
}

/** 처리 결과를 기록해 재전달 시 같은 응답을 돌려줄 수 있게 한다. */
export function dedupeRemember(
  key: string,
  response: unknown,
  opts: { now?: number; store?: Map<string, DedupeRecord> } = {},
): void {
  const store = opts.store ?? seen;
  store.set(key, { at: opts.now ?? Date.now(), response });
}

/** 테스트·재기동용 초기화. */
export function resetDedupe(): void {
  seen.clear();
}
