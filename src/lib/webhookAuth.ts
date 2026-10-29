/**
 * 웹훅 인증 공통 모듈 — HMAC 서명 검증 · 리플레이 차단.
 *
 * 왜 필요한가
 * - 스킬 URL은 공개 엔드포인트다. 토큰만으로는 본문 위·변조를 막지 못한다.
 *
 * 원칙
 * - 시크릿은 환경변수에서만 읽는다(하드코딩 금지). 미설정이면 검증을 '미구성'으로 명확히 구분한다.
 * - 비교는 항상 상수 시간(timingSafeEqual). 길이 차이로도 정보가 새지 않도록 해시 후 비교한다.
 * - 서명·시크릿 값은 어떤 로그·응답에도 남기지 않는다.
 *
 * 재시도(중복 전달) 멱등 처리는 **`@/lib/idem` 한 곳**으로 내렸다 (DS 72-1) — 그 판정은 서명과
 * 아무 상관이 없는 일인데 이 파일에 있었던 탓에, 웹 창구(`/api/chat`·`/api/feedback`)는 같은
 * 일을 할 자를 **가져다 쓸 생각조차 하지 못했다**(발화 상한이 `route.ts` 에 있어 카카오가 쓸 수
 * 없었던 것과 같은 모양 · DS 38-1). 부르던 쪽이 바뀌지 않게 이름은 여기서도 그대로 내보낸다.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export {
  DEFAULT_DEDUPE_TTL_MS,
  dedupeCheck,
  dedupeRelease,
  dedupeRemember,
  eventKey,
  resetDedupe,
  type DedupeRecord,
} from '@/lib/idem';

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

// ---- 재시도(중복 전달) 멱등 처리는 `@/lib/idem` 이 한다 (DS 72-1) ----
// 위의 `export { … } from '@/lib/idem'` 가 그 이름들을 그대로 다시 내보낸다 — 저장소도 판정도
// 한 벌이다(두 벌이면 같은 재전달을 창구마다 다르게 읽는다).
