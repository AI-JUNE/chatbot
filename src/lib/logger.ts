/**
 * 구조화 로깅 — 상용 필수(요청 ID·소요시간·에러코드).
 *
 * 설계 원칙
 * - **개인정보를 기록하지 않는다.** 필드는 화이트리스트로만 통과시키고, 통과한 문자열도
 *   모니터링과 동일한 마스킹(scrub)을 거친다. 대화 본문·연락처·세션ID 원문은 화이트리스트에 없다.
 * - 한 줄 JSON(NDJSON)으로 출력한다. Vercel/CloudWatch 등 어떤 수집기에서도 그대로 파싱된다.
 * - **로깅 실패가 요청을 깨뜨리지 않는다.** 모든 예외를 흡수한다.
 * - LOG_LEVEL(debug|info|warn|error, 기본 info)로 출력량을 조절한다. LOG_SILENT=true면 완전 침묵(테스트용).
 */
import { scrub } from '@/lib/monitoring';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 환경변수에서 최소 레벨을 읽는다. 알 수 없는 값이면 info. */
export function minLevel(raw?: string): LogLevel {
  const v = String(raw || '').toLowerCase();
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error' ? v : 'info';
}

/** 순수 함수(테스트 가능): 이 레벨을 출력해야 하는가. */
export function shouldLog(level: LogLevel, min: LogLevel): boolean {
  return ORDER[level] >= ORDER[min];
}

/**
 * 기록이 허용되는 필드 목록.
 * 여기에 없는 키는 값이 무엇이든 버린다(키 이름만 `dropped`에 남긴다).
 * 대화 본문(message/reply), 연락처(contact), 세션ID 원문(sessionId)은 **의도적으로 제외**한다.
 */
export const ALLOWED_FIELDS = [
  'route',
  'method',
  'status',
  'durationMs',
  'code',
  'error',
  'channel',
  'intent',
  'source',
  'escalate',
  'confidence',
  'ticketId',
  'sessionHash',
  'count',
  'limit',
  'retryAfterSec',
  'env',
  'commit',
  // 저장소(storage) — 모두 코드가 정한 상수·요약 문자열이며 사용자 데이터가 아니다
  'ns',
  'op',
  'driver',
] as const;

const ALLOWED = new Set<string>(ALLOWED_FIELDS as readonly string[]);

const MAX_STRING = 200;

/** 세션ID 등 식별자를 로그용 짧은 해시로 바꾼다(원문 복원 불가, 동일 세션 추적은 가능). */
export function hashId(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const s = String(input);
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 12);
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

/** 요청 ID: 상류(프록시·클라이언트)가 준 값이 형식에 맞으면 이어받고, 아니면 새로 만든다. */
export function newRequestId(incoming?: string | null): string {
  const v = String(incoming || '').trim();
  if (REQUEST_ID_RE.test(v)) return v;
  try {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  } catch {
    return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }
}

export interface LogEntry {
  ts: string;
  level: LogLevel;
  event: string;
  requestId?: string;
  dropped?: string[];
  [k: string]: unknown;
}

/**
 * 순수 함수(테스트 가능): 로그 1건을 만든다.
 * - 화이트리스트 밖 키는 버리고 이름만 `dropped`에 남긴다.
 * - 문자열 값은 마스킹 후 200자로 자른다.
 * - undefined/null 값은 넣지 않는다.
 */
export function buildEntry(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
  now: Date = new Date(),
): LogEntry {
  const entry: LogEntry = {
    ts: now.toISOString(),
    level,
    event: scrub(String(event)).slice(0, 80),
  };
  const dropped: string[] = [];

  for (const [k, v] of Object.entries(fields)) {
    if (k === 'requestId') {
      const id = String(v ?? '');
      if (id) entry.requestId = id.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
      continue;
    }
    if (!ALLOWED.has(k)) {
      dropped.push(k.slice(0, 40));
      continue;
    }
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') entry[k] = scrub(v).slice(0, MAX_STRING);
    else if (typeof v === 'number') entry[k] = Number.isFinite(v) ? v : null;
    else if (typeof v === 'boolean') entry[k] = v;
    else dropped.push(k.slice(0, 40)); // 객체·배열은 통째로 흘릴 위험이 있어 기록하지 않는다
  }

  if (dropped.length) entry.dropped = dropped.slice(0, 10);
  return entry;
}

/** 로그 1건 출력. 어떤 경우에도 예외를 던지지 않는다. */
export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  try {
    if (process.env.LOG_SILENT === 'true') return;
    if (!shouldLog(level, minLevel(process.env.LOG_LEVEL))) return;
    const line = JSON.stringify(buildEntry(level, event, fields));
    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
  } catch {
    // 로깅 실패는 서비스에 영향을 주지 않는다
  }
}

export interface RequestLog {
  requestId: string;
  /** 처리 종료 시 1건 기록. status>=500이면 error, >=400이면 warn, 그 외 info. */
  end(fields?: Record<string, unknown>): void;
}

/**
 * 요청 단위 로거. 시작 시각을 잡고, end()에서 소요시간·상태·에러코드를 함께 남긴다.
 *
 * ```ts
 * const rl = startRequest('/api/chat', 'POST', req.headers.get('x-request-id'));
 * ...
 * rl.end({ status: 200, source: result.source });
 * ```
 */
export function startRequest(route: string, method: string, incomingId?: string | null): RequestLog {
  const requestId = newRequestId(incomingId);
  const t0 = Date.now();
  let ended = false;
  return {
    requestId,
    end(fields: Record<string, unknown> = {}) {
      if (ended) return; // 중복 기록 방지
      ended = true;
      const status = typeof fields.status === 'number' ? fields.status : 200;
      const level: LogLevel = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
      log(level, 'request', { route, method, durationMs: Date.now() - t0, ...fields, requestId, status });
    },
  };
}
