/**
 * LLM 어댑터 — 프로바이더 인터페이스 · 실패 폴백 · 토큰/호출 상한.
 *
 * 설계 원칙 (build now, activate on approval)
 * - `CHAT_LLM_LIVE=true` 가 아니면 네트워크 호출을 **하지 않는다**. 기본 OFF. [승인 필요]
 * - 실패는 절대 throw 하지 않고 `{ ok:false, reason }` 으로 돌려준다.
 *   호출부(대화 엔진)는 룰·KB 기반 결정적 답변으로 되돌아간다 — 오류를 삼키고 빈 화면을 주지 않는다.
 * - 외부로 나가는 본문은 전송 전 PII를 마스킹한다(monitoring.scrub 재사용).
 * - 입력 문자 상한·출력 토큰 상한·분당 호출 상한으로 비용 폭주를 막는다.
 * - API 키는 환경변수에서만 읽는다(하드코딩 금지). 키가 없으면 not_configured 로 즉시 실패.
 * - 연속 실패가 쌓이면 짧게 차단(circuit breaker)해 장애 중인 업스트림을 두들기지 않는다.
 */
import { scrub } from '@/lib/monitoring';

export type LLMProviderName = 'anthropic' | 'openai';

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LLMRequest {
  system: string;
  messages: LLMMessage[];
  maxOutputTokens: number;
}

/** 실패 사유 — 재시도 가능 여부 판단과 로그 코드로 쓴다(고객에게 노출하지 않는다). */
export type LLMFailureReason =
  | 'disabled' // CHAT_LLM_LIVE=false (기본)
  | 'not_configured' // API 키·모델 미설정
  | 'input_too_large' // 상한을 넘겨 잘라도 남지 않음
  | 'budget_exceeded' // 분당 호출 상한 초과
  | 'circuit_open' // 연속 실패로 일시 차단 중
  | 'timeout'
  | 'rate_limited'
  | 'upstream_error'
  | 'network'
  | 'empty'; // 응답이 비어 있음

export type LLMResult =
  | { ok: true; text: string; provider: LLMProviderName; model: string; inputChars: number; attempts: number }
  | { ok: false; reason: LLMFailureReason; detail?: string; retryable: boolean; attempts: number };

export interface LLMProvider {
  readonly name: LLMProviderName;
  readonly model: string;
  complete(req: LLMRequest, signal: AbortSignal): Promise<LLMResult>;
}

// ---- 설정 ----

export const LLM_LIVE = process.env.CHAT_LLM_LIVE === 'true';

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(Math.trunc(raw), min), max);
}

export interface LLMConfig {
  live: boolean;
  provider: LLMProviderName;
  model: string;
  apiKey: string;
  baseUrl: string;
  /** 프로바이더로 보내는 총 문자 수 상한(시스템+대화). 초과분은 오래된 턴부터 버린다. */
  maxInputChars: number;
  /** 생성 토큰 상한. */
  maxOutputTokens: number;
  timeoutMs: number;
  /** 재시도 가능 실패에 한한 추가 시도 횟수(총 시도 = retries + 1). */
  retries: number;
  /** 프로세스 인스턴스당 분당 호출 상한(비용 안전장치). */
  maxCallsPerMinute: number;
}

const DEFAULT_MODEL: Record<LLMProviderName, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
};

const DEFAULT_BASE: Record<LLMProviderName, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
};

/** 환경변수에서 설정을 읽는다. 키 값 자체는 어디에도 로그하지 않는다. */
export function readConfig(env: Record<string, string | undefined> = process.env): LLMConfig {
  const provider: LLMProviderName = env.CHAT_LLM_PROVIDER === 'openai' ? 'openai' : 'anthropic';
  const apiKey = (provider === 'openai' ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY) || '';
  return {
    live: env.CHAT_LLM_LIVE === 'true',
    provider,
    model: env.CHAT_LLM_MODEL || DEFAULT_MODEL[provider],
    apiKey,
    baseUrl: (env.CHAT_LLM_BASE_URL || DEFAULT_BASE[provider]).replace(/\/+$/, ''),
    maxInputChars: envInt('CHAT_LLM_MAX_INPUT_CHARS', 6000, 500, 40000),
    maxOutputTokens: envInt('CHAT_LLM_MAX_OUTPUT_TOKENS', 400, 32, 4000),
    timeoutMs: envInt('CHAT_LLM_TIMEOUT_MS', 8000, 1000, 30000),
    retries: envInt('CHAT_LLM_RETRIES', 1, 0, 3),
    maxCallsPerMinute: envInt('CHAT_LLM_MAX_CALLS_PER_MINUTE', 60, 1, 10000),
  };
}

// ---- 토큰·입력 상한 ----

/**
 * 대략적인 토큰 수 추정(한국어는 문자당 토큰 비중이 높다).
 * 정확한 과금 수치가 아니라 상한을 걸기 위한 보수적 근사값이다.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const ch of String(text)) tokens += /[가-힣㄰-㆏一-鿿぀-ヿ]/.test(ch) ? 1 : 0.28;
  return Math.ceil(tokens);
}

/**
 * 입력 상한 적용 — 시스템 프롬프트는 보존하고 **오래된 대화 턴부터** 버린다.
 * 마지막 사용자 메시지는 반드시 남긴다(남길 수 없으면 잘라서라도 남긴다).
 */
export function clampMessages(
  system: string,
  messages: LLMMessage[],
  maxInputChars: number,
): { system: string; messages: LLMMessage[]; dropped: number; chars: number } {
  const sys = system.slice(0, Math.max(200, Math.floor(maxInputChars * 0.8)));
  let budget = maxInputChars - sys.length;
  const kept: LLMMessage[] = [];
  let dropped = 0;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.content.length <= budget) {
      kept.unshift(m);
      budget -= m.content.length;
      continue;
    }
    // 마지막(가장 최근) 메시지는 잘라서라도 살린다
    if (kept.length === 0 && budget > 80) {
      kept.unshift({ role: m.role, content: `${m.content.slice(0, budget - 1)}…` });
      budget = 0;
      dropped += i;
      break;
    }
    dropped += i + 1;
    break;
  }

  const chars = sys.length + kept.reduce((n, m) => n + m.content.length, 0);
  return { system: sys, messages: kept, dropped, chars };
}

// ---- 호출 상한 · 서킷 브레이커 ----

const callWindow: number[] = [];
let consecutiveFailures = 0;
let circuitOpenUntil = 0;

/** 연속 실패가 이 횟수에 도달하면 아래 시간만큼 호출을 차단한다. */
export const CIRCUIT_FAILURE_LIMIT = 4;
export const CIRCUIT_COOLDOWN_MS = 30_000;

/** 테스트·운영 재기동용 상태 초기화. */
export function resetLLMState(): void {
  callWindow.length = 0;
  consecutiveFailures = 0;
  circuitOpenUntil = 0;
}

/** 현재 어댑터 상태(관리 콘솔·/api/health 노출용. 키·본문은 담지 않는다). */
export function llmState(now: number = Date.now()): {
  callsLastMinute: number;
  consecutiveFailures: number;
  circuitOpen: boolean;
  circuitOpensForMs: number;
} {
  const since = now - 60_000;
  return {
    callsLastMinute: callWindow.filter((t) => t > since).length,
    consecutiveFailures,
    circuitOpen: now < circuitOpenUntil,
    circuitOpensForMs: Math.max(0, circuitOpenUntil - now),
  };
}

function reserveCall(limit: number, now: number): boolean {
  const since = now - 60_000;
  while (callWindow.length && callWindow[0]! <= since) callWindow.shift();
  if (callWindow.length >= limit) return false;
  callWindow.push(now);
  return true;
}

function noteFailure(retryable: boolean, now: number): void {
  if (!retryable) return;
  consecutiveFailures += 1;
  if (consecutiveFailures >= CIRCUIT_FAILURE_LIMIT) circuitOpenUntil = now + CIRCUIT_COOLDOWN_MS;
}

function noteSuccess(): void {
  consecutiveFailures = 0;
  circuitOpenUntil = 0;
}

// ---- 프로바이더 구현 ----

type FetchLike = (input: string, init: Record<string, unknown>) => Promise<Response>;

function fail(reason: LLMFailureReason, retryable: boolean, attempts: number, detail?: string): LLMResult {
  return { ok: false, reason, retryable, attempts, ...(detail ? { detail: detail.slice(0, 200) } : {}) };
}

/** HTTP 상태 → 실패 사유. 429·5xx만 재시도 대상. */
export function classifyStatus(status: number): { reason: LLMFailureReason; retryable: boolean } {
  if (status === 429) return { reason: 'rate_limited', retryable: true };
  if (status >= 500) return { reason: 'upstream_error', retryable: true };
  return { reason: 'upstream_error', retryable: false };
}

function anthropicProvider(cfg: LLMConfig, fetchImpl: FetchLike): LLMProvider {
  return {
    name: 'anthropic',
    model: cfg.model,
    async complete(req, signal) {
      const res = await fetchImpl(`${cfg.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: req.maxOutputTokens,
          system: req.system,
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        }),
        signal,
      });
      if (!res.ok) {
        const c = classifyStatus(res.status);
        return fail(c.reason, c.retryable, 1, `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
      const text = (data.content ?? [])
        .filter((b) => b?.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
        .trim();
      if (!text) return fail('empty', false, 1);
      return { ok: true, text, provider: 'anthropic', model: cfg.model, inputChars: 0, attempts: 1 };
    },
  };
}

function openaiProvider(cfg: LLMConfig, fetchImpl: FetchLike): LLMProvider {
  return {
    name: 'openai',
    model: cfg.model,
    async complete(req, signal) {
      const res = await fetchImpl(`${cfg.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: req.maxOutputTokens,
          messages: [{ role: 'system', content: req.system }, ...req.messages],
        }),
        signal,
      });
      if (!res.ok) {
        const c = classifyStatus(res.status);
        return fail(c.reason, c.retryable, 1, `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = (data.choices?.[0]?.message?.content ?? '').trim();
      if (!text) return fail('empty', false, 1);
      return { ok: true, text, provider: 'openai', model: cfg.model, inputChars: 0, attempts: 1 };
    },
  };
}

/** 설정에 맞는 프로바이더를 만든다. 키가 없으면 null(호출 없이 not_configured 처리). */
export function createProvider(cfg: LLMConfig, fetchImpl?: FetchLike): LLMProvider | null {
  if (!cfg.apiKey || !cfg.model) return null;
  const f = fetchImpl ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike | undefined);
  if (!f) return null;
  return cfg.provider === 'openai' ? openaiProvider(cfg, f) : anthropicProvider(cfg, f);
}

// ---- 실행(상한·재시도·폴백 포함) ----

export interface CompleteOptions {
  config?: LLMConfig;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** 재시도 대기(테스트에서 0으로 주입). */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 프롬프트 1건 실행. **절대 throw 하지 않는다.**
 * 게이트 OFF·키 미설정·상한 초과·업스트림 장애는 모두 `{ ok:false }` 로 돌아간다.
 */
export async function complete(input: { system: string; messages: LLMMessage[] }, opts: CompleteOptions = {}): Promise<LLMResult> {
  const cfg = opts.config ?? readConfig();
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;

  // 1) 승인 게이트 — 실키 호출은 CHAT_LLM_LIVE=true 에서만. [승인 필요]
  if (!cfg.live) return fail('disabled', false, 0);

  const provider = createProvider(cfg, opts.fetchImpl);
  if (!provider) return fail('not_configured', false, 0);

  // 2) 서킷 브레이커
  const t0 = now();
  if (t0 < circuitOpenUntil) return fail('circuit_open', false, 0);

  // 3) PII 마스킹 후 상한 적용 — 외부로 원문 개인정보를 내보내지 않는다
  const masked = input.messages.map((m) => ({ role: m.role, content: scrub(m.content) }));
  const clamped = clampMessages(scrub(input.system), masked, cfg.maxInputChars);
  if (clamped.messages.length === 0) return fail('input_too_large', false, 0);

  // 4) 분당 호출 상한
  if (!reserveCall(cfg.maxCallsPerMinute, t0)) return fail('budget_exceeded', false, 0);

  const req: LLMRequest = {
    system: clamped.system,
    messages: clamped.messages,
    maxOutputTokens: cfg.maxOutputTokens,
  };

  let last: LLMResult = fail('upstream_error', true, 0);
  const total = cfg.retries + 1;
  for (let attempt = 1; attempt <= total; attempt += 1) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const r = await provider.complete(req, controller.signal);
      if (r.ok) {
        noteSuccess();
        return { ...r, inputChars: clamped.chars, attempts: attempt };
      }
      last = { ...r, attempts: attempt };
    } catch (e) {
      const aborted = controller.signal.aborted || (e as { name?: string })?.name === 'AbortError';
      last = fail(aborted ? 'timeout' : 'network', true, attempt, e instanceof Error ? e.message : String(e));
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!(last.ok === false && last.retryable) || attempt === total) break;
    await sleep(200 * attempt);
  }

  if (last.ok === false) noteFailure(last.retryable, now());
  return last;
}

// ---- 대화 엔진용 고수준 API ----

export interface GroundingDoc {
  id: string;
  question: string;
  answer: string;
}

/** 근거 기반 시스템 프롬프트 — 자료에 없으면 지어내지 말고 모른다고 답하게 한다. */
export function buildSystemPrompt(docs: GroundingDoc[]): string {
  const context = docs.length
    ? docs.map((d, i) => `[자료 ${i + 1}] Q. ${d.question}\nA. ${d.answer}`).join('\n\n')
    : '(제공된 자료 없음)';
  return [
    '너는 한국어 고객센터 상담 도우미다. 아래 "자료"에 있는 내용만 근거로 답한다.',
    '규칙:',
    '1. 자료에 없는 내용은 추측하지 말고 "제가 확인할 수 없는 내용"이라고 밝힌 뒤 상담원 연결을 안내한다.',
    '2. 금액·기간·수치는 자료에 적힌 값만 사용한다. 임의로 만들지 않는다.',
    '3. 3문장 이내로 간결하게, 존댓말로 답한다.',
    '4. 개인정보(주민등록번호·카드번호 등)를 되묻거나 반복해서 적지 않는다.',
    '',
    '자료:',
    context,
  ].join('\n');
}

/** 생성 답변 후처리 — 길이 상한, 마스킹, 빈 응답 차단. */
export function sanitizeAnswer(text: string, maxChars = 900): string {
  return scrub(String(text).trim()).slice(0, maxChars);
}

/**
 * 대화 엔진이 쓰는 진입점. 실패하면 `null` 을 돌려주고, 호출부는 결정적 폴백을 유지한다.
 */
export async function generateGroundedAnswer(
  input: { question: string; docs: GroundingDoc[]; history?: LLMMessage[] },
  opts: CompleteOptions = {},
): Promise<{ text: string; provider: LLMProviderName; model: string } | { failed: LLMFailureReason }> {
  const history = (input.history ?? []).slice(-6);
  const res = await complete(
    {
      system: buildSystemPrompt(input.docs),
      messages: [...history, { role: 'user', content: input.question }],
    },
    opts,
  );
  if (!res.ok) return { failed: res.reason };
  const text = sanitizeAnswer(res.text);
  if (!text) return { failed: 'empty' };
  return { text, provider: res.provider, model: res.model };
}
