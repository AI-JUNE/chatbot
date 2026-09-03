// 멀티턴 슬롯 수집(폼) 엔진 — 예약 접수·장애 신고처럼 "여러 항목을 차례로 받아야 하는" 대화를 처리한다.
//
// 왜 필요한가: 룰·FAQ는 한 번의 질문에 한 번의 답을 준다. 그런데 실제 콜센터 업무의 절반은
// "무엇을, 언제, 누구에게 연락" 같은 항목을 받아 접수하는 일이다. 이 파일은 그 수집 절차를
// 결정적(deterministic) 규칙으로 처리한다 — LLM 없이도 동작하고, 실패 경로가 예측 가능하다.
//
// 설계 원칙
// - 순수 함수만 둔다. 세션 저장·티켓 생성 같은 부수효과는 호출자(src/lib/chat.ts)가 맡는다.
// - 사용자는 언제든 빠져나갈 수 있다: "취소"(중단) · "이전"(직전 항목 다시) · "건너뛰기"(선택 항목).
// - 잘못된 입력은 삼키지 않는다. 어느 항목이 왜 틀렸는지 + 입력 예시를 함께 돌려준다.
// - 재시도 한도(MAX_SLOT_RETRIES)를 넘으면 상담원 이관(max_retry) — 고객을 무한 재질문에 가두지 않는다.
// - 개인정보 슬롯(pii)은 확인 문구에서 마스킹해 보여준다(src/lib/handoff maskPii 재사용).
//
// [승인 필요] 관리 콘솔에서 폼을 편집·추가하는 기능, 수집 결과의 외부 업무시스템 전송.
import { maskPii } from '@/lib/handoff';
import { compact, keywordHit, prepare } from '@/lib/normalize';

/** 슬롯 값의 종류. 종류마다 검증·정규화 규칙이 다르다. */
export type SlotKind = 'text' | 'contact' | 'datetime' | 'choice';

export interface SlotSpec {
  key: string;
  /** 화면·요약에 쓰는 한국어 라벨 */
  label: string;
  kind: SlotKind;
  /** 이 항목을 물어보는 문구 */
  prompt: string;
  /** 입력 예시(오류 안내에 함께 노출) */
  hint: string;
  /** 기본 true. false면 "건너뛰기"로 넘어갈 수 있다. */
  required?: boolean;
  /** 개인정보 여부 — 확인 문구·요약에서 마스킹한다. */
  pii?: boolean;
  /** kind==='choice' 일 때 선택지(번호로도 고를 수 있다). */
  choices?: string[];
}

export interface FormSpec {
  id: string;
  /** 진행 표시에 쓰는 제목 */
  title: string;
  /** 이 폼을 시작시키는 인텐트 룰 id(src/lib/rules.ts) */
  triggerIntents: string[];
  slots: SlotSpec[];
  /** 완료 시 접수 티켓의 이관 사유 코드 */
  handoffReason: 'customer_request' | 'policy';
  /** 완료 안내 문구 앞머리 */
  doneLead: string;
}

/** 같은 항목에서 이만큼 연속으로 인식 실패하면 상담원에게 넘긴다(정책 상수, 성능 지표 아님). */
export const MAX_SLOT_RETRIES = 3;

/** 진행 중인 수집 상태. 세션(src/lib/session.ts)에 그대로 저장된다. */
export interface FormState {
  formId: string;
  /** 지금 물어보고 있는 슬롯 key */
  asked: string;
  /** 확정된 값(정규화 완료). 건너뛴 선택 항목은 키 자체가 없다. */
  values: Record<string, string>;
  /** 현재 슬롯에서 연속 인식 실패 횟수 */
  retries: number;
  startedAt: string;
}

// ---- 폼 정의 ----
// 코드에서만 수정한다(관리 콘솔 편집은 [승인 필요]). 룰 인텐트와 1:1로 연결해
// 기존 시나리오 흐름을 깨지 않고 "안내 → 접수"로 자연스럽게 이어지게 한다.

export const FORMS: FormSpec[] = [
  {
    id: 'reservation',
    title: '예약 접수',
    triggerIntents: ['reservation'],
    handoffReason: 'customer_request',
    doneLead: '예약 요청을 접수했어요.',
    slots: [
      { key: 'name', label: '예약자 성함', kind: 'text', prompt: '예약자 성함을 알려주세요.', hint: '예: 홍길동' },
      {
        key: 'datetime',
        label: '희망 일시',
        kind: 'datetime',
        prompt: '희망하시는 날짜와 시간을 알려주세요.',
        hint: '예: 내일 오후 2시 · 9월 10일 14시 · 2026-09-10 14:30',
      },
      {
        key: 'contact',
        label: '연락처',
        kind: 'contact',
        pii: true,
        prompt: '연락받으실 전화번호나 이메일을 알려주세요.',
        hint: '예: 010-1234-5678 · hong@example.com',
      },
    ],
  },
  {
    id: 'trouble',
    title: '장애 신고 접수',
    triggerIntents: ['trouble'],
    handoffReason: 'policy',
    doneLead: '장애 신고를 접수했어요.',
    slots: [
      {
        key: 'symptom',
        label: '증상',
        kind: 'text',
        prompt: '어떤 증상인지 한 줄로 알려주세요.',
        hint: '예: 위젯이 열리지 않아요 / 전송 버튼이 눌리지 않아요',
      },
      {
        key: 'channel',
        label: '발생 채널',
        kind: 'choice',
        choices: ['웹 챗봇', '카카오톡', '전화 콜봇', '기타'],
        prompt: '어느 채널에서 발생했나요?',
        hint: '번호(1~4)로 답하셔도 돼요',
      },
      {
        key: 'contact',
        label: '연락처',
        kind: 'contact',
        pii: true,
        required: false,
        prompt: '확인 결과를 받아보실 연락처를 알려주세요.',
        hint: '예: 010-1234-5678 · 필요 없으시면 "건너뛰기"',
      },
    ],
  },
];

export function getForm(id: string): FormSpec | null {
  return FORMS.find((f) => f.id === id) ?? null;
}

/** 인텐트로 시작할 폼을 찾는다(없으면 기존 룰 응답 그대로). */
export function formForIntent(intent: string): FormSpec | null {
  return FORMS.find((f) => f.triggerIntents.includes(intent)) ?? null;
}

export function slotOf(form: FormSpec, key: string): SlotSpec | null {
  return form.slots.find((s) => s.key === key) ?? null;
}

function isRequired(slot: SlotSpec): boolean {
  return slot.required !== false;
}

/** 아직 값이 없고 건너뛰지도 않은 다음 슬롯. 없으면 null(=수집 완료). */
export function nextPending(form: FormSpec, values: Record<string, string>, skipped: string[] = []): SlotSpec | null {
  return form.slots.find((s) => !(s.key in values) && !skipped.includes(s.key)) ?? null;
}

/** 진행 표시용 단계 번호(1부터). 존재하지 않는 키면 1을 준다. */
export function stepInfo(form: FormSpec, key: string): { step: number; total: number } {
  const idx = form.slots.findIndex((s) => s.key === key);
  return { step: idx < 0 ? 1 : idx + 1, total: form.slots.length };
}

// ---- 제어어(취소·이전·건너뛰기) ----

const CANCEL_RE = /^(취소|그만|중단|안 ?할래|안할래|처음으로|처음부터|나가기|종료|cancel|stop)\s*[.!]?$/i;
const BACK_RE = /^(이전|뒤로|back|다시|잘못 ?(입력|눌렀))\s*[.!]?$/i;
const SKIP_RE = /^(건너뛰|건너뛰기|스킵|skip|없어요|없습니다|괜찮아요|괜찮습니다|생략)\s*[.!]?$/i;

export type Control = 'cancel' | 'back' | 'skip' | 'value';

/**
 * 수집 중에도 "사람과 이야기하고 싶다"는 요청은 최우선으로 존중한다.
 * 다만 폼 진행 중에는 룰의 광범위 패턴(예: '연결')을 쓰지 않는다 —
 * "연결이 안 돼요" 같은 증상 설명이 이관으로 새는 것을 막기 위해 좁은 패턴만 본다.
 */
export const AGENT_REQUEST_RE = /(상담원|상담사|(사람|직원|담당자)\s*(이랑|하고|과|와)?\s*(연결|바꿔|바꾸|통화))/;

export function interpretControl(text: string): Control {
  const t = (text || '').trim();
  if (CANCEL_RE.test(t)) return 'cancel';
  if (BACK_RE.test(t)) return 'back';
  if (SKIP_RE.test(t)) return 'skip';
  return 'value';
}

// ---- 값 검증 ----

const PHONE_RE = /(01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}|0\d{1,2}[-\s.]?\d{3,4}[-\s.]?\d{4})/;
const EMAIL_RE = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;

export const MAX_SLOT_VALUE_LEN = 200;

export type SlotResult = { ok: true; value: string } | { ok: false; message: string };

/** 상대 날짜 표현 → 오늘로부터의 일수. */
const RELATIVE_DAYS: [RegExp, number][] = [
  [/오늘|금일/, 0],
  [/내일|낼|명일/, 1],
  [/모레|내일모레/, 2],
  [/글피/, 3],
];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 한국어 날짜·시간 표현을 파싱한다.
 * 지원: 오늘/내일/모레/글피 · YYYY-MM-DD · M/D · M월 D일 · HH시(분) · 오전·오후 · HH:MM
 * 날짜와 시간 중 하나도 못 찾으면 null.
 */
export function parseDateTime(input: string, now: Date = new Date()): { value: string } | null {
  const t = (input || '').trim();
  if (!t) return null;

  let date: string | null = null;
  const iso = t.match(/(20\d{2})[-./](\d{1,2})[-./](\d{1,2})/);
  const md = t.match(/(?:^|[^\d])(\d{1,2})\s*(?:월|[/.\-])\s*(\d{1,2})\s*(?:일)?/);
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]);
    const d = Number(iso[3]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) date = `${y}-${pad(m)}-${pad(d)}`;
  } else if (md) {
    const m = Number(md[1]);
    const d = Number(md[2]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      // 연도 미기재 — 이미 지난 날짜면 내년으로 본다(예약은 미래가 기본).
      const y = now.getFullYear();
      const cand = new Date(y, m - 1, d);
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      date = fmtDate(cand.getTime() < today.getTime() ? new Date(y + 1, m - 1, d) : cand);
    }
  } else {
    for (const [re, offset] of RELATIVE_DAYS) {
      if (re.test(t)) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
        date = fmtDate(d);
        break;
      }
    }
  }

  let time: string | null = null;
  const hm = t.match(/(\d{1,2})\s*[:시]\s*(\d{1,2})?\s*(?:분)?/);
  if (hm) {
    let h = Number(hm[1]);
    const mnt = hm[2] === undefined || hm[2] === '' ? 0 : Number(hm[2]);
    const pm = /오후|저녁|밤|pm/i.test(t);
    const am = /오전|아침|새벽|am/i.test(t);
    if (pm && h < 12) h += 12;
    if (am && h === 12) h = 0;
    if (h >= 0 && h <= 23 && mnt >= 0 && mnt <= 59) time = `${pad(h)}:${pad(mnt)}`;
  }

  if (!date && !time) return null;
  if (date && time) return { value: `${date} ${time}` };
  if (date) return { value: `${date} (시간 미정)` };
  return { value: `날짜 미정 ${time}` };
}

/** 선택지 매칭 — 번호("2", "2번")와 표기(동의어·오타 허용) 양쪽을 받는다. */
export function matchChoice(choices: string[], input: string): string | null {
  const t = (input || '').trim();
  const num = t.match(/^([1-9])\s*(번|\.)?$/);
  if (num) {
    const i = Number(num[1]);
    return i >= 1 && i <= choices.length ? choices[i - 1] : null;
  }
  const pre = prepare(t);
  if (!pre.compact) return null;
  for (const c of choices) {
    if (compact(c) === pre.compact) return c;
  }
  for (const c of choices) {
    // 선택지 전체가 아니라 의미 단어(공백 분리)로도 고를 수 있게 한다("카톡" → "카카오톡").
    for (const word of c.split(/\s+/)) {
      if (word.length >= 2 && keywordHit(pre.compact, pre.jamo, word).kind !== 'none') return c;
    }
  }
  return null;
}

/** 슬롯 1건 검증. 실패 시 "어느 항목이 왜 틀렸는지 + 예시"를 담은 안내를 돌려준다. */
export function validateSlot(slot: SlotSpec, input: string, now: Date = new Date()): SlotResult {
  const raw = (input || '').trim();
  if (!raw) return { ok: false, message: `${slot.label}을(를) 입력해 주세요. ${slot.hint}` };
  if (raw.length > MAX_SLOT_VALUE_LEN) {
    return { ok: false, message: `${slot.label}이(가) 너무 길어요(${MAX_SLOT_VALUE_LEN}자 이내). 짧게 다시 알려주세요.` };
  }

  if (slot.kind === 'contact') {
    const phone = raw.match(PHONE_RE)?.[0];
    if (phone) return { ok: true, value: phone.replace(/\s+/g, '') };
    const email = raw.match(EMAIL_RE)?.[0];
    if (email) return { ok: true, value: email };
    return { ok: false, message: `연락처 형식을 알아보지 못했어요. 전화번호 또는 이메일로 알려주세요. ${slot.hint}` };
  }

  if (slot.kind === 'datetime') {
    const parsed = parseDateTime(raw, now);
    if (parsed) return { ok: true, value: parsed.value };
    return { ok: false, message: `날짜·시간을 알아보지 못했어요. ${slot.hint}` };
  }

  if (slot.kind === 'choice') {
    const choices = slot.choices ?? [];
    const picked = matchChoice(choices, raw);
    if (picked) return { ok: true, value: picked };
    return { ok: false, message: `${slot.label}을(를) 알아보지 못했어요. ${renderChoices(choices)} 중에서 골라주세요.` };
  }

  // text — 의미 없는 한 글자·기호만 입력은 되묻는다.
  if (compact(raw).length < 2) {
    return { ok: false, message: `${slot.label}을(를) 조금 더 자세히 알려주세요. ${slot.hint}` };
  }
  return { ok: true, value: raw };
}

export function renderChoices(choices: string[]): string {
  return choices.map((c, i) => `${i + 1}) ${c}`).join(' ');
}

// ---- 질문 문구 ----

/** 다음 질문 1건을 만든다. 진행 단계와 빠져나가는 방법을 항상 함께 보여준다. */
export function promptFor(form: FormSpec, slot: SlotSpec, opts: { retryMessage?: string } = {}): string {
  const { step, total } = stepInfo(form, slot.key);
  const lines: string[] = [];
  if (opts.retryMessage) lines.push(opts.retryMessage);
  lines.push(`[${form.title} ${step}/${total}] ${slot.prompt}`);
  if (slot.kind === 'choice' && slot.choices?.length) lines.push(renderChoices(slot.choices));
  const escape = isRequired(slot)
    ? '(그만두시려면 "취소", 앞 항목을 고치려면 "이전")'
    : '(원치 않으시면 "건너뛰기", 그만두시려면 "취소")';
  lines.push(`${slot.hint} ${escape}`);
  return lines.join('\n');
}

/** 수집 결과 확인 문구 — 개인정보 슬롯은 마스킹해 보여준다. */
export function renderCollected(form: FormSpec, values: Record<string, string>): string {
  const lines = form.slots
    .filter((s) => values[s.key])
    .map((s) => `- ${s.label}: ${s.pii ? maskPii(values[s.key]).text : values[s.key]}`);
  return lines.length ? lines.join('\n') : '- 접수 내용 없음';
}

/** 티켓 요약·업무 연계용 슬롯 맵(원문). 마스킹은 요약 생성 시 handoff가 수행한다. */
export function collectedSlots(form: FormSpec, values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of form.slots) if (values[s.key]) out[s.key] = values[s.key];
  return out;
}

// ---- 상태 전이 ----

export function startForm(form: FormSpec, now: () => string = () => new Date().toISOString()): { state: FormState; slot: SlotSpec } {
  const slot = form.slots[0];
  return {
    state: { formId: form.id, asked: slot.key, values: {}, retries: 0, startedAt: now() },
    slot,
  };
}

export type ApplyResult =
  | { kind: 'cancelled' }
  | { kind: 'invalid'; state: FormState; slot: SlotSpec; message: string }
  | { kind: 'max_retry'; state: FormState; slot: SlotSpec }
  | { kind: 'progress'; state: FormState; slot: SlotSpec; back?: true; skipped?: true }
  | { kind: 'complete'; state: FormState; values: Record<string, string> };

/**
 * 수집 중 한 턴을 처리한다. 부수효과 없음 — 새 상태를 돌려주고 저장은 호출자가 한다.
 * @param clock 날짜 파싱 기준 시각(테스트에서 고정 가능)
 */
export function applyInput(form: FormSpec, state: FormState, text: string, clock: Date = new Date()): ApplyResult {
  const slot = slotOf(form, state.asked) ?? form.slots[0];
  const control = interpretControl(text);

  if (control === 'cancel') return { kind: 'cancelled' };

  if (control === 'back') {
    const idx = form.slots.findIndex((s) => s.key === slot.key);
    const prev = idx > 0 ? form.slots[idx - 1] : null;
    if (!prev) {
      // 첫 항목에서 "이전"은 되돌릴 곳이 없다 — 취소 방법을 안내하고 같은 질문을 유지한다.
      return {
        kind: 'invalid',
        state: { ...state, retries: 0 },
        slot,
        message: '첫 항목이라 이전으로 돌아갈 수 없어요. 그만두시려면 "취소"라고 입력해 주세요.',
      };
    }
    const values = { ...state.values };
    delete values[prev.key];
    return { kind: 'progress', state: { ...state, asked: prev.key, values, retries: 0 }, slot: prev, back: true };
  }

  if (control === 'skip') {
    if (isRequired(slot)) {
      const retries = state.retries + 1;
      if (retries >= MAX_SLOT_RETRIES) return { kind: 'max_retry', state: { ...state, retries }, slot };
      return {
        kind: 'invalid',
        state: { ...state, retries },
        slot,
        message: `${slot.label}은(는) 접수에 꼭 필요해서 건너뛸 수 없어요.`,
      };
    }
    return advance(form, { ...state, values: { ...state.values }, retries: 0 }, slot, { skipped: true });
  }

  const res = validateSlot(slot, text, clock);
  if (!res.ok) {
    const retries = state.retries + 1;
    if (retries >= MAX_SLOT_RETRIES) return { kind: 'max_retry', state: { ...state, retries }, slot };
    return { kind: 'invalid', state: { ...state, retries }, slot, message: res.message };
  }

  const values = { ...state.values, [slot.key]: res.value };
  return advance(form, { ...state, values, retries: 0 }, slot, {});
}

/** 다음 미수집 슬롯으로 이동하거나 완료 처리한다. 건너뛴 항목은 다시 묻지 않는다. */
function advance(form: FormSpec, state: FormState, current: SlotSpec, opts: { skipped?: boolean }): ApplyResult {
  const idx = form.slots.findIndex((s) => s.key === current.key);
  const rest = form.slots.slice(idx + 1);
  const next = rest.find((s) => !(s.key in state.values)) ?? null;
  if (!next) return { kind: 'complete', state: { ...state, asked: '' }, values: state.values };
  const nextState: FormState = { ...state, asked: next.key, retries: 0 };
  return opts.skipped
    ? { kind: 'progress', state: nextState, slot: next, skipped: true }
    : { kind: 'progress', state: nextState, slot: next };
}
