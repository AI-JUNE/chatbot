/**
 * 오류 모니터링 (Sentry) — 의존성 0 경량 리포터.
 *
 * 설계 원칙
 * - DSN(SENTRY_DSN)이 없으면 완전한 no-op. 로컬·미설정 환경에서 아무 동작도 하지 않는다.
 * - 개인정보는 전송 전 마스킹한다(계좌·주민등록번호·카드·전화·이메일).
 * - 전송 실패가 애플리케이션에 영향을 주지 않는다(모든 예외 흡수).
 * - 공식 SDK(@sentry/nextjs) 도입 시 이 모듈의 captureError만 교체하면 된다.
 */

const DSN = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN || '';
const ENV = process.env.VERCEL_ENV || process.env.NODE_ENV || 'development';
const RELEASE = process.env.VERCEL_GIT_COMMIT_SHA || 'dev';

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

/** 전송 전 PII 마스킹 — 오류 메시지에 개인정보가 섞여도 외부로 나가지 않게 한다. */
export function scrub(input: string): string {
  return String(input)
    .replace(/\b(\d{6})[-\s]?[1-4]\d{6}\b/g, '$1-*******')            // 주민등록번호
    .replace(/\b(?:\d{4}[-\s]?){3}\d{4}\b/g, '****-****-****-****')   // 카드
    .replace(/\b01[0-9][-\s]?\d{3,4}[-\s]?\d{4}\b/g, '01*-****-****') // 휴대전화
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '***@***')                // 이메일
    .replace(/\b\d{2,3}-\d{2,6}-\d{2,6}\b/g, '***-****-****');        // 계좌
}

export interface ErrorContext {
  route?: string;
  method?: string;
  requestId?: string;
  [k: string]: unknown;
}

/**
 * 오류 1건 전송. 실패해도 절대 throw 하지 않는다.
 * DSN 미설정이면 즉시 반환(no-op).
 */
export async function captureError(err: unknown, ctx: ErrorContext = {}): Promise<void> {
  if (!TARGET) return;
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
      extra: Object.fromEntries(
        Object.entries(ctx).map(([k, v]) => [k, typeof v === 'string' ? scrub(v).slice(0, 300) : v]),
      ),
    });
    const payload = `${header}\n${JSON.stringify({ type: 'event' })}\n${body}\n`;

    await fetch(TARGET.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${TARGET.key}, sentry_client=gowon-lite/1.0`,
      },
      body: payload,
      // 응답을 기다리며 요청을 막지 않는다
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // 모니터링 실패가 서비스에 영향을 주지 않는다
  }
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
