// 표준 HTTP 응답 · 입력 검증 · 관리자 인증 게이트 — 공통 런치 P0-7.
// 목적: 라우트마다 흩어진 { ok:false, error } 형태와 인증 로직을 한곳으로 모은다.
//
// 표준 오류 본문:
//   { ok:false, code:'invalid_input', error:'<한국어 메시지>', message:'<한국어 메시지>', ...extra }
//   - code    : 기계 판독용 안정 식별자(신규)
//   - error   : 기존 소비자(관리 콘솔 등)가 그대로 표시하던 필드 → 한국어 메시지 유지
//   - message : error와 동일(신규 소비자용 명시적 필드)
import { NextRequest, NextResponse } from 'next/server';

export type ErrorCode =
  | 'invalid_json'
  | 'invalid_input'
  | 'unauthorized'
  | 'not_found'
  | 'payload_too_large'
  | 'rate_limited'
  | 'conflict'
  | 'internal';

const STATUS: Record<ErrorCode, number> = {
  invalid_json: 400,
  invalid_input: 400,
  unauthorized: 401,
  not_found: 404,
  payload_too_large: 413,
  rate_limited: 429,
  conflict: 409,
  internal: 500,
};

const DEFAULT_MESSAGE: Record<ErrorCode, string> = {
  invalid_json: '요청 형식이 올바르지 않습니다(JSON 파싱 실패).',
  invalid_input: '입력값이 올바르지 않습니다.',
  unauthorized: '인증이 필요합니다.',
  not_found: '대상을 찾을 수 없습니다.',
  payload_too_large: '요청 본문이 너무 큽니다.',
  rate_limited: '요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.',
  conflict: '요청을 처리할 수 없는 상태입니다.',
  internal: '일시적인 오류가 발생했습니다.',
};

export interface ErrorBody {
  ok: false;
  code: ErrorCode;
  error: string;
  message: string;
  [k: string]: unknown;
}

/** 표준 오류 본문 생성(응답 객체 없이 본문만 필요할 때). */
export function errorBody(code: ErrorCode, message?: string, extra?: Record<string, unknown>): ErrorBody {
  const msg = message || DEFAULT_MESSAGE[code];
  return { ok: false, code, error: msg, message: msg, ...(extra || {}) };
}

/** 표준 오류 응답. status는 code별 기본값을 사용하되 init.status로 덮어쓸 수 있다. */
export function fail(
  code: ErrorCode,
  message?: string,
  extra?: Record<string, unknown>,
  init?: { status?: number; headers?: Record<string, string> },
): NextResponse {
  return NextResponse.json(errorBody(code, message, extra), {
    status: init?.status ?? STATUS[code],
    headers: init?.headers,
  });
}

/** 성공 응답(항상 ok:true 포함). */
export function ok<T extends Record<string, unknown>>(data: T, status = 200): NextResponse {
  return NextResponse.json({ ok: true, ...data }, { status });
}

// ---- 본문 파싱 ----

export const MAX_BODY_BYTES = 32 * 1024; // 일반 API 기본 상한(32KB)
export const MAX_IMPORT_BYTES = 1024 * 1024; // 백업 복원 등 대용량 업로드(1MB)

export type Parsed<T> = { ok: true; data: T } | { ok: false; res: NextResponse };

/** JSON 본문을 크기 제한과 함께 안전하게 파싱한다. 객체가 아니면 invalid_input. */
export async function readJson<T extends Record<string, unknown>>(
  req: NextRequest,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<Parsed<T>> {
  const declared = Number(req.headers.get('content-length') || 0);
  const tooBig = (n: number) =>
    fail('payload_too_large', `요청 본문이 너무 큽니다(최대 ${Math.floor(maxBytes / 1024)}KB).`);
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, res: tooBig(declared) };

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return { ok: false, res: fail('invalid_json') };
  }
  if (raw.length > maxBytes) return { ok: false, res: tooBig(raw.length) };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || 'null');
  } catch {
    return { ok: false, res: fail('invalid_json') };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, res: fail('invalid_input', 'JSON 객체 형식의 본문이 필요합니다.') };
  }
  return { ok: true, data: parsed as T };
}

// ---- 입력 검증 헬퍼 ----

export type Field<T> = { ok: true; value: T } | { ok: false; res: NextResponse };

/** 선택 문자열: undefined/null이면 fallback. 문자열이 아니면 400. 길이 초과 시 400. */
export function optStr(v: unknown, field: string, max: number, fallback = ''): Field<string> {
  if (v === undefined || v === null) return { ok: true, value: fallback };
  if (typeof v !== 'string') return { ok: false, res: fail('invalid_input', `${field}은(는) 문자열이어야 합니다.`) };
  const s = v.trim();
  if (s.length > max) return { ok: false, res: fail('invalid_input', `${field}은(는) ${max}자 이하여야 합니다.`) };
  return { ok: true, value: s };
}

/** 필수 문자열: 비어 있으면 400. */
export function reqStr(v: unknown, field: string, max: number): Field<string> {
  const r = optStr(v, field, max);
  if (!r.ok) return r;
  if (!r.value) return { ok: false, res: fail('invalid_input', `${field}이(가) 필요합니다.`) };
  return r;
}

/** 쿼리스트링 필수 값. */
export function reqQuery(req: NextRequest, name: string, max = 120): Field<string> {
  return reqStr(req.nextUrl.searchParams.get(name) ?? undefined, name, max);
}

/** 정수 쿼리(범위 클램프). 값이 없거나 숫자가 아니면 def. */
export function intQuery(req: NextRequest, name: string, def: number, min: number, max: number): number {
  const raw = Number(req.nextUrl.searchParams.get(name) ?? def);
  if (!Number.isFinite(raw)) return def;
  return Math.min(Math.max(Math.trunc(raw), min), max);
}

// ---- 관리자 인증 게이트 ----

/**
 * ADMIN_AUTH_REQUIRED=true 이면 ADMIN_TOKEN이 반드시 설정되어야 하고 모든 관리 API에 토큰을 요구한다.
 * 기본값 false(플래그 OFF) — 현재 동작(토큰 미설정 시 개방)을 그대로 유지한다.
 * [승인 필요] 운영에서 ADMIN_AUTH_REQUIRED=true 전환(관리 콘솔 로그인 UX 확정 후).
 */
export const ADMIN_AUTH_REQUIRED = process.env.ADMIN_AUTH_REQUIRED === 'true';

function presentedToken(req: NextRequest, allowQueryToken: boolean): string | null {
  return req.headers.get('x-admin-token') || (allowQueryToken ? req.nextUrl.searchParams.get('token') : null);
}

/** 토큰이 설정되어 있고 실제로 일치했는지(감사 로그 authed 표기용). */
export function isAdminAuthed(req: NextRequest, allowQueryToken = false): boolean {
  const token = process.env.ADMIN_TOKEN;
  return Boolean(token) && presentedToken(req, allowQueryToken) === token;
}

/**
 * 관리 API 접근 검사. 통과하면 null, 차단되면 표준 401 응답을 반환한다.
 * - ADMIN_TOKEN 미설정 + 게이트 OFF → 개방(개발 편의)
 * - ADMIN_TOKEN 미설정 + 게이트 ON  → 전면 차단(설정 누락을 사고로 만들지 않기 위해)
 */
export function requireAdmin(req: NextRequest, opts?: { allowQueryToken?: boolean }): NextResponse | null {
  const allowQueryToken = opts?.allowQueryToken === true;
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    if (!ADMIN_AUTH_REQUIRED) return null;
    return fail('unauthorized', '관리자 인증이 활성화되었으나 ADMIN_TOKEN이 설정되지 않았습니다.');
  }
  if (presentedToken(req, allowQueryToken) !== token) {
    return fail('unauthorized', '관리자 토큰이 필요합니다.');
  }
  return null;
}
