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
import { clip, cut, ellipsize } from '@/lib/limits';
import { scrub } from '@/lib/monitoring';
import { clamp, envNumber } from '@/lib/num';

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

/**
 * 설정값을 수로 읽는 자는 `lib/num` 하나다 (DS 65-3) — 빈 값(`CHAT_LLM_TIMEOUT_MS=`)은
 * **설정하지 않음**이지 0 이 아니다. 범위 밖을 당기는 것은 종전 그대로다(예산 상수).
 */
function envInt(name: string, fallback: number, min: number, max: number): number {
  const v = envNumber(name);
  return clamp(v === null ? fallback : Math.trunc(v), min, max);
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
 * 시스템 프롬프트가 쓸 수 있는 글자 수 — **이 수를 아는 자는 한 곳이다**.
 *
 * 왜 이름을 주는가: 프롬프트를 **만드는 쪽**(`buildSystemPrompt`)과 **재는 쪽**(`clampMessages`)이
 * 각자 수를 들고 있으면, 만드는 쪽이 넘긴 글을 재는 쪽이 글자 가운데에서 끊는다 (DS 75-3).
 */
export function systemBudget(maxInputChars: number): number {
  return Math.max(200, Math.floor(maxInputChars * 0.8));
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
  const sys = cut(system, systemBudget(maxInputChars));
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
      kept.unshift({ role: m.role, content: ellipsize(m.content, budget) });
      budget = 0;
      dropped += i;
      break;
    }
    dropped += i + 1;
    break;
  }

  /**
   * 보내는 **첫 마디는 고객 차례**여야 한다 (DS 75-1).
   *
   * 위 고리는 뒤에서부터 담으므로, 예산이 모자라면 남는 것이 「상담원 차례 → 고객 차례」로
   * 시작할 수 있다. 그 모양은 보낼 수 없는 본문이다 — Anthropic 창구는 첫 마디가 고객
   * (`user`) 이 아니면 본문 전체를 400 으로 거절한다. 그러면 우리가 받는 것은 「자료를
   * 못 찾았다」가 아니라 **아무 답도 없는 upstream_error** 이고, 고객에게는 결정적 폴백이
   * 그대로 나간다(생성이 통째로 사라진 줄 아무도 모른다 — 재시도 대상도 아니다).
   * 돌려서 받아 냈다: 1,800자 네 턴 + 질문 하나를 넣으면 보낸 차례가
   * `assistant,user,assistant,user` 였다.
   *
   * 고치는 길은 **더 버리는 것**이다 — 앞머리의 상담원 차례는 짝이 되는 고객의 말이 이미
   * 버려진 조각이라, 들고 가도 모델이 무엇에 대한 답인지 알 수 없다. 버린 수는 `dropped` 에
   * 함께 센다(얼마를 버렸는지 말하는 자가 하나여야 한다).
   */
  while (kept.length && kept[0]!.role !== 'user') {
    kept.shift();
    dropped += 1;
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

  const req: LLMRequest = {
    system: clamped.system,
    messages: clamped.messages,
    maxOutputTokens: cfg.maxOutputTokens,
  };

  let last: LLMResult = fail('upstream_error', true, 0);
  const total = cfg.retries + 1;
  for (let attempt = 1; attempt <= total; attempt += 1) {
    /**
     * 4) 분당 호출 상한 — **실제로 나가는 호출마다** 센다 (DS 75-2).
     *
     * 종전에는 이 줄이 고리 **앞**에 한 번 있었다. 그래서 상한은 「프롬프트 수」를 셌고
     * 재시도는 공짜로 나갔다 — 재시도는 같은 본문을 **다시 과금**하는 호출이다. 돌려서
     * 받아 냈다: 상한 2 · 재시도 3 으로 두면 업스트림 호출이 **8번** 나가고
     * (`maxCallsPerMinute` 의 4배), 「지금 몇 번 불렀나」를 묻는 자(`llmState`)는 2 라고
     * 답했다. 비용 안전장치라고 적어 둔 수가 실제로는 (재시도+1)배까지 헐거웠다.
     *
     * 첫 시도조차 예산이 없으면 그 사실을 사유로 돌려준다(종전과 같은 `budget_exceeded`).
     * 재시도 차례에 바닥나면 **직전 실패를 그대로** 돌려준다 — 상한은 비용을 막는 자이므로
     * 예산이 없을 때 더 두들기지 않는 쪽이 맞고, 고객에게는 어느 쪽이든 결정적 폴백이 간다.
     */
    if (!reserveCall(cfg.maxCallsPerMinute, now())) {
      if (attempt === 1) return fail('budget_exceeded', false, 0);
      break;
    }
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

const PROMPT_HEAD = [
  '너는 한국어 고객센터 상담 도우미다. 아래 "자료"에 있는 내용만 근거로 답한다.',
  '규칙:',
  '1. 자료에 없는 내용은 추측하지 말고 "제가 확인할 수 없는 내용"이라고 밝힌 뒤 상담원 연결을 안내한다.',
  '2. 금액·기간·수치는 자료에 적힌 값만 사용한다. 임의로 만들지 않는다.',
  '3. 3문장 이내로 간결하게, 존댓말로 답한다.',
  '4. 개인정보(주민등록번호·카드번호 등)를 되묻거나 반복해서 적지 않는다.',
  '',
  '자료:',
].join('\n');

const NO_DOCS = '(제공된 자료 없음)';

/**
 * 자료 한 건을 실을 때 **최소한 이만큼은** 들어가야 한다 — 그만큼도 못 되면 싣지 않는다.
 * 두 문장도 안 되는 토막은 근거가 아니라 오해의 재료다.
 */
const MIN_DOC_ANSWER = 200;

/** 자료가 빠졌을 때 프롬프트에 적는 한 줄 — 모델이 이 목록을 전부로 읽지 않게 한다. */
function omittedNote(total: number, kept: number): string {
  return `(등록된 자료 ${total}건 중 ${kept}건만 실었습니다 — 나머지는 길이 때문에 빠졌습니다. 실리지 않은 자료는 근거로 쓸 수 없습니다.)`;
}

/**
 * 근거 기반 시스템 프롬프트 — 자료에 없으면 지어내지 말고 모른다고 답하게 한다.
 *
 * **자료를 반 토막으로 싣지 않는다** (DS 75-3). 종전에는 이 함수가 상한을 몰랐고, 넘친 글은
 * 저 아래 `clampMessages` 가 `cut` 으로 글자 가운데에서 끊었다. 돌려서 받아 냈다: 자료 두 건을
 * 넣으면 프롬프트가 「… 환불 수수료는 12,0」에서 끝났고, 뒤 자료는 머리줄째 사라졌다. 바로
 * 위에 적힌 규칙이 「금액·기간·수치는 자료에 적힌 값만 사용한다」인데, 그 자료에 적힌 값이
 * **12,0원** 이 된 것이다 — §13 이 금한 「없는 수」를 우리 프롬프트가 만들어 건넨 자리다.
 *
 * 그래서 담는 쪽이 상한을 안다: 통째로 들어가는 자료만 싣고, 마지막 한 건이 남는 자리에
 * 걸치면 **잘랐다고 적어**(`clip` 의 「…(이하 생략)」 · DS 62-2) 싣는다. 빠진 건이 있으면
 * 그 수를 한 줄로 말한다 — 모델이 이 목록을 전부로 읽으면 「자료에 없으면 모른다고 답한다」가
 * 거짓 근거가 된다. 자료가 **한 건도** 들어가지 않으면 부르는 쪽이 호출을 접는다.
 *
 * 밖으로 나가는 글은 여기서 이미 마스킹한다(`scrub`) — 상한을 재는 자와 보내는 자가 같은
 * 글자를 세야 한다(마스킹이 길이를 늘릴 수 있다 · `***@***`).
 */
export function buildSystemPrompt(
  docs: GroundingDoc[],
  maxChars = Infinity,
): { system: string; kept: number; omitted: number } {
  const blocks: string[] = [];
  // 빠진 자료가 생기면 그 사실을 적어야 하므로, 그 한 줄의 자리를 미리 비워 둔다
  // (실은 건수의 자리수가 가장 긴 모양으로 재 둔다 — 비워 둔 자리보다 긴 줄을 적지 않는다).
  const reserve = docs.length ? omittedNote(docs.length, docs.length).length + 2 : 0;
  let left = maxChars - PROMPT_HEAD.length - 1 - reserve;

  for (const d of docs) {
    const label = `[자료 ${blocks.length + 1}] Q. ${scrub(d.question)}\nA. `;
    const answer = scrub(d.answer);
    const room = left - (blocks.length ? 2 : 0) - label.length;
    if (room >= answer.length) {
      blocks.push(label + answer);
      left = room - answer.length;
      continue;
    }
    if (room >= MIN_DOC_ANSWER) blocks.push(label + clip(answer, room));
    break;
  }

  const omitted = docs.length - blocks.length;
  const note = omitted > 0 ? `\n\n${omittedNote(docs.length, blocks.length)}` : '';
  return {
    system: `${PROMPT_HEAD}\n${blocks.length ? blocks.join('\n\n') : NO_DOCS}${note}`,
    kept: blocks.length,
    omitted,
  };
}

/**
 * 생성 답변 후처리 — 길이 상한, 마스킹, 빈 응답 차단.
 *
 * 상한에 걸린 답변은 **잘렸다고 말한다** (DS 62-2). 종전에는 `slice(0, maxChars)` 였다 —
 * 고객은 문장 중간에서 끊긴 답을 읽고 그것이 답의 전부인 줄 알았고(카카오의 `CUT_NOTICE` 가
 * 같은 창구에서 이미 막아 둔 모양이다), 상한이 이모지 가운데 떨어지면 끝 글자가 `�` 였다.
 */
export function sanitizeAnswer(text: string, maxChars = 900): string {
  return clip(scrub(String(text).trim()), maxChars);
}

/**
 * 대화 엔진이 쓰는 진입점. 실패하면 `null` 을 돌려주고, 호출부는 결정적 폴백을 유지한다.
 *
 * 프롬프트를 **상한 안에서** 만든다 (DS 75-3) — 상한을 아는 자는 `systemBudget` 하나이고,
 * 자료가 한 건도 들어가지 않으면 **근거 없이 묻지 않는다**(결정적 폴백을 그대로 둔다 —
 * 근거가 없을 때 호출하지 않는 것은 `augmentWithLLM` 이 이미 세운 환각 방지 규칙이다).
 */
export async function generateGroundedAnswer(
  input: { question: string; docs: GroundingDoc[]; history?: LLMMessage[] },
  opts: CompleteOptions = {},
): Promise<{ text: string; provider: LLMProviderName; model: string } | { failed: LLMFailureReason }> {
  const cfg = opts.config ?? readConfig();
  const history = (input.history ?? []).slice(-6);
  const prompt = buildSystemPrompt(input.docs, systemBudget(cfg.maxInputChars));
  if (input.docs.length > 0 && prompt.kept === 0) return { failed: 'input_too_large' };
  const res = await complete(
    {
      system: prompt.system,
      messages: [...history, { role: 'user', content: input.question }],
    },
    { ...opts, config: cfg },
  );
  if (!res.ok) return { failed: res.reason };
  const text = sanitizeAnswer(res.text);
  if (!text) return { failed: 'empty' };
  return { text, provider: res.provider, model: res.model };
}
