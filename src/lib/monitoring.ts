/**
 * 오류 모니터링 (Sentry) — 의존성 0 경량 리포터.
 *
 * 설계 원칙
 * - DSN(SENTRY_DSN)이 없으면 완전한 no-op. 로컬·미설정 환경에서 아무 동작도 하지 않는다.
 * - 개인정보는 전송 전 마스킹한다(계좌·주민등록번호·카드·전화·이메일).
 *   **글자만 가리는 것이 아니다** — 보내는 모양을 글자·수·참거짓으로 좁힌다(`safeExtra` · DS 76-1).
 * - 전송 실패가 애플리케이션에 영향을 주지 않는다(모든 예외 흡수).
 * - **응답을 기다리며 요청을 막지 않는다** — 리포트는 요청 경로 밖에서 나간다 (DS 76-2).
 * - **보낸 결과를 센다** — 「설정됐는가」와 「접수되는가」는 다른 값이다 (DS 76-3).
 * - 공식 SDK(@sentry/nextjs) 도입 시 이 모듈의 captureError만 교체하면 된다.
 */
import { maskPii } from '@/lib/pii';

const DSN = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN || '';
const ENV = process.env.VERCEL_ENV || process.env.NODE_ENV || 'development';
const RELEASE = process.env.VERCEL_GIT_COMMIT_SHA || 'dev';

/** 수집기 응답을 기다리는 상한. 이 기다림은 요청 경로 **밖**에서 일어난다 (DS 76-2). */
const SEND_TIMEOUT_MS = 3000;
/** 문맥 칸 한 값의 글자 상한. */
const MAX_EXTRA_CHARS = 300;

/** DSN → Sentry envelope 엔드포인트 파싱. 형식이 아니면 null. */
function parseDsn(dsn: string): { url: string; key: string } | null {
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\//, '');
    if (!u.username || !projectId) return null;
    return { url: `${u.protocol}//${u.host}/api/${projectId}/envelope/`, key: u.username };
  } catch {
    return null;
  }
}

const TARGET = DSN ? parseDsn(DSN) : null;
export const MONITORING_ENABLED = TARGET !== null;

/**
 * 전송 전 PII 마스킹 — 오류 메시지에 개인정보가 섞여도 외부로 나가지 않게 한다.
 *
 * 규칙은 `@/lib/pii` 한 곳에만 있다 (DS 39-3). 종전에는 이 파일이 규칙을 따로 들고 있었고,
 * 그 규칙이 이관 요약 쪽(`handoff.maskPii`)보다 **느슨했다** — 계좌 패턴에 하이픈을 필수로 둬서
 * 하이픈 없는 계좌번호(`1002123456789`)가 그대로 외부(오류 리포트·LLM 호출 본문)로 나갔다.
 * 안에서는 가리고 밖으로는 내보내는 모양이었다.
 *
 * 세기는 `opaque` — 받는 쪽이 우리 울타리 밖이므로 끝 네 자리도, 생년월일도 남기지 않는다.
 */
export function scrub(input: string): string {
  return maskPii(String(input), 'opaque').text;
}

export interface ErrorContext {
  route?: string;
  method?: string;
  requestId?: string;
  [k: string]: unknown;
}

/**
 * 문맥 칸(`extra`)을 **보내도 되는 모양으로** 고른다 (DS 76-1).
 *
 * 종전에는 `typeof v === 'string' ? scrub(v) : v` 였다 — 글자일 때만 가리고 **나머지는 그대로**
 * 실었다. 그래서 객체·배열 안에 든 글자는 가리는 자를 지나치지 않고 울타리를 넘었다.
 * 돌려서 받아 냈다: `{ detail: { email: 'hong@gowon.kr', phone: '010-1234-5678' } }` 가 원문
 * 그대로 나갔다. 같은 제품의 로거는 바로 이 자리에서 「객체·배열은 통째로 흘릴 위험이 있어
 * 기록하지 않는다」며 버리는데(`lib/logger` · `buildEntry`), **밖으로 나가는 쪽이 더 느슨했다**.
 *
 * 규칙은 로거와 같다 — 글자·유한수·참거짓만 싣고, 나머지는 **이름만** `dropped` 에 남긴다
 * (무엇을 버렸는지 말하지 않으면 리포트를 읽는 사람이 없는 칸을 찾게 된다).
 * 이 규칙은 직렬화도 함께 지킨다: 순환 참조·BigInt 가 `JSON.stringify` 를 깨뜨려
 * **리포트 전체가 조용히 사라지던** 길이 닫힌다 — 그 둘도 「나머지」다.
 */
export function safeExtra(ctx: Record<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(ctx)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') extra[k] = scrub(v).slice(0, MAX_EXTRA_CHARS);
    else if (typeof v === 'number') {
      if (Number.isFinite(v)) extra[k] = v;
      else dropped.push(k.slice(0, 40));
    } else if (typeof v === 'boolean') extra[k] = v;
    else dropped.push(k.slice(0, 40)); // 객체·배열·BigInt·함수는 통째로 흘릴 위험이 있어 보내지 않는다
  }
  if (dropped.length) extra.dropped = dropped.slice(0, 10);
  return extra;
}

/** 리포트가 접수되지 못한 사유. 화면 문장은 관리 콘솔이 들고 있다(닫힌 목록이다). */
export type ReportFailure = 'build' | 'network' | 'timeout' | 'rejected';

export interface MonitoringState {
  /** DSN 이 설정·해석됐는가. 「접수되는가」는 아래 수가 말한다. */
  enabled: boolean;
  sent: number;
  failed: number;
  /** 수집기가 마지막으로 돌려준 응답 코드(닿지 못했거나 시간이 초과되면 null). */
  lastStatus: number | null;
  lastFailure: ReportFailure | null;
}

const counters = {
  sent: 0,
  failed: 0,
  lastStatus: null as number | null,
  lastFailure: null as ReportFailure | null,
};

/**
 * 리포트가 **실제로 접수되는지**를 말하는 자 (DS 76-3).
 *
 * 종전에 우리가 가진 값은 `MONITORING_ENABLED` 하나였다 — 「DSN 이 설정됐는가」다. 키가 틀려
 * 모든 리포트가 401 로 거절되는 동안에도 /api/health 는 같은 말(`monitoring: true`)을 했고,
 * `captureError` 는 응답을 읽지 않고 예외를 삼켰으므로 **아무 기록도 남지 않았다**.
 * 꺼진 것과 고장 난 것을 구분하지 못하는 신호등이었다.
 *
 * 이 수는 **지금 이 서버 1대**가 센 값이다(프로세스 메모리 · `llmState` 와 같은 성격).
 * 그 사실은 값을 보여 주는 화면이 함께 적는다.
 */
export function monitoringState(): MonitoringState {
  return { enabled: MONITORING_ENABLED, ...counters };
}

/** 센 수를 되돌린다(테스트·재기동용). */
export function resetMonitoringState(): void {
  counters.sent = 0;
  counters.failed = 0;
  counters.lastStatus = null;
  counters.lastFailure = null;
}

let inFlight: Promise<void> = Promise.resolve();

/**
 * 보내는 중인 리포트가 끝날 때까지 기다린다 — 테스트·일회성 스크립트용.
 * **요청 경로에서는 부르지 않는다**(그러면 DS 76-2 가 고친 것이 되돌아간다).
 */
export function pendingReports(): Promise<void> {
  return inFlight;
}

/** 리포트 1건 전송 — 결과를 세고, 어떤 경우에도 예외를 밖으로 내지 않는다. */
async function send(url: string, authKey: string, payload: string): Promise<void> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${authKey}, sentry_client=gowon-lite/1.0`,
      },
      body: payload,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (res && res.ok) {
      counters.sent += 1;
      counters.lastStatus = typeof res.status === 'number' ? res.status : null;
      return;
    }
    counters.failed += 1;
    counters.lastStatus = res && typeof res.status === 'number' ? res.status : null;
    counters.lastFailure = 'rejected';
  } catch (e) {
    counters.failed += 1;
    counters.lastStatus = null;
    // 상한(SEND_TIMEOUT_MS)에 걸린 것과 아예 닿지 못한 것은 운영자가 할 일이 다르다.
    counters.lastFailure = e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'network';
  }
}

/**
 * 오류 1건 전송. 실패해도 절대 throw 하지 않는다.
 * DSN 미설정이면 즉시 반환(no-op).
 *
 * **고객의 응답을 기다리게 하지 않는다** (DS 76-2). 종전에는 이 함수가 수집기의 응답까지
 * `await` 했고, 부르는 자리 둘(`/api/chat`·카카오 웹훅)이 그것을 다시 `await` 했다 —
 * 수집기가 응답하지 않으면 상한(3초)을 **고객이 기다렸다**(돌려서 받아 냈다). 카카오에서는
 * 그 3초가 재전달·실패 화면이 된다(이 저장소가 웹훅 머리에 적어 둔 그 지연이다).
 * 그래서 만드는 일만 여기서 하고, 보내는 일은 `inFlight` 에 맡기고 돌아온다 —
 * 오류가 났다는 **사실 자체는 서버 로그가 이미 적는다**(`code: 'engine_error'`).
 * 대가를 적어 둔다: 서버리스에서 응답 뒤 인스턴스가 얼려지면 그 리포트는 나가지 못할 수 있다.
 * 반드시 보내야 하는 자리(스크립트·배치)는 `pendingReports()` 를 기다린다.
 */
export async function captureError(err: unknown, ctx: ErrorContext = {}): Promise<void> {
  if (!TARGET) return;
  let payload: string;
  try {
    const e = err instanceof Error ? err : new Error(String(err));
    const eventId = crypto.randomUUID().replace(/-/g, '');
    const header = JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() });
    const body = JSON.stringify({
      event_id: eventId,
      timestamp: Date.now() / 1000,
      platform: 'javascript',
      level: 'error',
      environment: ENV,
      release: RELEASE,
      logger: 'chatbot',
      exception: {
        values: [{
          type: e.name,
          value: scrub(e.message).slice(0, 800),
          stacktrace: { frames: [] },
        }],
      },
      extra: safeExtra(ctx),
    });
    payload = `${header}\n${JSON.stringify({ type: 'event' })}\n${body}\n`;
  } catch {
    // 만들지도 못한 리포트는 보내지 않는다 — 그래도 **그 사실은 센다**(조용히 사라지지 않는다).
    counters.failed += 1;
    counters.lastStatus = null;
    counters.lastFailure = 'build';
    return;
  }

  // 보내는 일은 응답 경로 밖에서 끝난다. 겹쳐 들어온 리포트도 `pendingReports()` 하나로 기다린다.
  const job = send(TARGET.url, TARGET.key, payload);
  inFlight = Promise.allSettled([inFlight, job]).then(() => undefined);
}

/** API 라우트 공통 래퍼: 처리 중 오류를 리포트하고 다시 던진다. */
export async function withMonitoring<T>(ctx: ErrorContext, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    await captureError(e, ctx);
    throw e;
  }
}
