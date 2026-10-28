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
// - **접수한 값은 그대로 쓸 수 있어야 한다**: 지난 날짜·시각은 받지 않고, 날짜·시간 중 반쪽만
//   알아들었으면 확정하지 않고 모르는 쪽만 다시 묻는다(DS 30-1·30-2). 반쪽짜리 예약은
//   운영자가 다시 전화해 물어야 하는 일거리이고, 지난 시각 예약은 접수된 적 없는 약속이다.
// - 재시도 한도(MAX_SLOT_RETRIES)를 넘으면 상담원 이관(max_retry) — 고객을 무한 재질문에 가두지 않는다.
// - 개인정보 슬롯(pii)은 확인 문구에서 마스킹해 보여준다(src/lib/handoff maskPii 재사용).
//
// [승인 필요] 관리 콘솔에서 폼을 편집·추가하는 기능, 수집 결과의 외부 업무시스템 전송.
import { maskPii } from '@/lib/handoff';
import { takeContact } from '@/lib/pii';
import { compact } from '@/lib/normalize';
import { interpretControl, pickChoice, pickNumber, type Control } from '@/lib/choice';
import { compareYmd, isRealYmd, kstTime, kstYmd, normalizeYmd, ymdToString } from '@/lib/kst';
import { CONTACT_SHAPE_MESSAGE, josa, phoneShapeMessage } from '@/lib/refusal';

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

/** 알아들은 날짜('YYYY-MM-DD')·시각('HH:MM') 각각. 한쪽만 알아들었으면 다른 쪽이 null 이다. */
export interface DateTimeParts {
  date: string | null;
  time: string | null;
  /**
   * 고객이 말한 날이 **달력에 없는 날**일 때, 그 날을 고객이 말한 그대로 (DS 68-1).
   *
   * 「못 알아들었다」(둘 다 null)와 다른 사실이다 — 무엇을 말했는지는 알고, 그 날이 없다는
   * 것까지 안다. 그래서 되묻는 문장도 다르다(「날짜·시간을 알아보지 못했어요」가 아니라
   * 「2월 31일은 달력에 없는 날이에요」). 이 칸이 있으면 `date` 는 반드시 null 이다 —
   * 없는 날을 **가까운 있는 날로 옮기지 않는다**(그 날은 고객이 말한 날이 아니다).
   */
  impossible?: string;
}

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
  /**
   * 날짜·시간 중 **한쪽만** 알아들은 채 같은 항목을 다시 묻고 있을 때 그 한쪽(DS 30-2).
   * 다음 턴 입력과 합쳐서 푼다 — 사람은 「내일」 · 「오후 2시」로 나눠 말한다.
   * 항목이 바뀌거나 값이 확정되면 비운다(남으면 다른 날짜에 지난 시각이 따라붙는다).
   */
  partial?: DateTimeParts;
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

/**
 * 빠져나가는 말을 가리는 자는 **`lib/choice` 한 곳**이다 (DS 69-3).
 *
 * 종전에는 이 파일과 `lib/chat` 에 한 벌씩 있었고 말 목록이 서로 달랐다 — 폼 쪽은 「아니요」·
 * 「나중에」를 몰랐고, 연락처 수집 턴 쪽은 「생략」을 몰랐으며 그쪽 식은 **문장 어디서든** 걸려
 * 고객의 보통 질문을 건너뛰기로 삼켰다. 같은 제품이 같은 질문을 하면서 받아 주는 말이 둘로
 * 갈려 있던 자리다.
 */
export { interpretControl };
export type { Control };

/**
 * 수집 중에도 "사람과 이야기하고 싶다"는 요청은 최우선으로 존중한다.
 * 다만 폼 진행 중에는 룰의 광범위 패턴(예: '연결')을 쓰지 않는다 —
 * "연결이 안 돼요" 같은 증상 설명이 이관으로 새는 것을 막기 위해 좁은 패턴만 본다.
 */
export const AGENT_REQUEST_RE = /(상담원|상담사|(사람|직원|담당자)\s*(이랑|하고|과|와)?\s*(연결|바꿔|바꾸|통화))/;

// ---- 값 검증 ----

export const MAX_SLOT_VALUE_LEN = 200;

/**
 * 검증 결과. 거절할 때 `parts` 가 있으면 **한쪽은 알아들었다**는 뜻이다 —
 * 부르는 쪽이 그 한쪽을 들고 있다가 다음 턴 입력과 합친다(DS 30-2).
 */
export type SlotResult = { ok: true; value: string } | { ok: false; message: string; parts?: DateTimeParts };

/**
 * 상대 날짜 표현 → 오늘로부터의 일수.
 *
 * **긴 말을 먼저 본다** (DS 45-3). 위에서부터 첫 번째로 걸리는 것을 쓰므로, 종전 차례
 * (오늘 → 내일 → 모레)에서는 「내일모레」가 **「내일」에 먼저 걸려 하루 당겨졌다** — 고객이
 * 「내일모레 2시」라고 말하면 봇이 「10월 20일, 맞습니다」라고 되읽고 그 날짜로 접수했다.
 * 고객이 말하지 않은 날짜를 우리가 지어내 되읽어 준 자리다(§13).
 *
 * 「낼」은 **앞 글자가 한글이면 보지 않는다** — 「보낼게요」·「알아낼게요」의 꼬리가 「내일」로
 * 읽히던 자리다(날짜를 묻는 칸에서 「자료 보낼게요」가 오늘로 확정됐다). 뒤돌아보기(lookbehind)
 * 대신 「앞이 글머리이거나 한글이 아닌 자리」로 적는다 — 같은 뜻이고 더 오래된 런타임에서도 돈다.
 */
const RELATIVE_DAYS: [RegExp, number][] = [
  [/글피/, 3],
  [/내일모레|모레/, 2],
  [/오늘|금일/, 0],
  [/내일|명일|(?:^|[^가-힣])낼/, 1],
];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 「몇 시」의 **분**은 분이라고 적힌 것만 분이다 (DS 68-2).
 *
 * 종전 식(`(\d{1,2})\s*[:시]\s*(?:(\d{1,2})\s*(?:분)?|(반))?`)은 「시」 뒤의 **맨 수**를 분으로
 * 읽었다. 그런데 예약 말투에서 그 자리에 오는 수는 분보다 **인원·개수**일 때가 훨씬 많다 —
 * 「내일 오후 2시 4명이요」가 **오후 2시 4분**으로, 「내일 2시 10명」이 **2시 10분**으로 확정됐다.
 * 고객은 2시를 말했고 접수에는 2시 4분이 적힌다(§13 — 우리가 만든 수다).
 *
 * 사람이 분을 말할 때는 거의 늘 「분」을 붙이거나(「2시 30분」) 「반」이라 하거나(「2시 반」)
 * 콜론으로 적는다(「14:30」). 세 가지만 분으로 받는다 — 놓치는 쪽의 손해는 고객이 분을 한 번 더
 * 말하는 것이고, 단정하는 쪽의 손해는 말하지 않은 시각으로 접수되는 것이다.
 */
const HOUR_KO = /(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분|\s*(반))?/;
const HOUR_COLON = /(\d{1,2})\s*:\s*(\d{1,2})/;

/**
 * 「몇 시」에 딸린 때 가림말의 종류 (DS 68-3).
 *  - `am` 오전·아침·새벽 — 12시는 자정(0시)
 *  - `pm` 오후·저녁 — 12시 미만이면 12를 더한다
 *  - `night` 밤·자정 — 12시는 **그 날이 끝나는 자리**(다음 날 0시)
 *  - `day` 낮·정오 — 1~6시만 오후로 본다(「낮 2시」=14시 · 「낮 11시」=11시 · 「정오 12시」=12시)
 */
type Meridiem = 'am' | 'pm' | 'night' | 'day';

const MERIDIEM_RE = /오전|아침|새벽|자정|오후|저녁|정오|낮|밤/g;
const MERIDIEM_KIND: Record<string, Meridiem> = {
  오전: 'am', 아침: 'am', 새벽: 'am',
  오후: 'pm', 저녁: 'pm',
  자정: 'night', 밤: 'night',
  정오: 'day', 낮: 'day',
};

/**
 * 그 시각에 **딸린** 가림말을 고른다 (DS 68-3).
 *
 * 종전에는 문장 **어디에든** 「오후」가 있으면 오후로 읽었다(`/오후|저녁|밤|pm/i.test(t)`).
 * 그래서 「오후는 안 되고 오전 10시요」가 **오후 10시**로 확정됐다 — 고객이 안 된다고 말한
 * 바로 그 반나절로 접수된다. 「낮」은 어느 표에도 없어 「낮 2시」가 **새벽 2시**였다.
 *
 * 고르는 차례: 수 바로 뒤의 `am`·`pm`(가장 또렷한 표시) → 수 **앞의 가장 가까운** 가림말
 * → (앞에 없으면) 뒤의 첫 가림말. 앞을 먼저 보는 까닭은 한국어가 「오후 2시」처럼 앞에
 * 붙이는 말이어서다 — 뒤에 있는 말은 다른 수의 것일 때가 많다.
 */
function meridiemFor(text: string, from: number, to: number): Meridiem | null {
  const ascii = /^\s*([ap])\.?\s?m\.?/i.exec(text.slice(to));
  if (ascii) return ascii[1].toLowerCase() === 'p' ? 'pm' : 'am';
  let before: Meridiem | null = null;
  let after: Meridiem | null = null;
  for (const m of text.matchAll(MERIDIEM_RE)) {
    const kind = MERIDIEM_KIND[m[0]];
    if (!kind) continue;
    const at = m.index ?? 0;
    if (at < from) before = kind;
    else if (after === null) after = kind;
  }
  return before ?? after;
}

/**
 * 한국어 날짜·시간 표현에서 **알아들은 쪽만** 뽑는다(둘 다 못 찾으면 둘 다 null).
 * 지원: 오늘/내일/모레(내일모레)/글피 · YYYY-MM-DD · M/D · M월 D일 · HH시(분·반) · 오전·오후 · HH:MM
 *
 * **고객이 말하지 않은 때를 만들지 않는다** (DS 45-3). 이 함수가 돌려준 값은 그대로 되읽히고
 * (「10월 20일, 몇 시가 좋을까요?」) 접수 요약에 적혀 운영자에게 간다 — 틀리게 알아들으면
 * 고객은 자기가 말한 약속을 확인받았다고 믿은 채 **다른 날**에 기다린다.
 *
 * "오늘"·"내일"·연도 없는 "9/30" 은 **한국 시간 달력**으로 푼다(@/lib/kst) — 서버가 UTC 로 돌면
 * 한국 자정~오전 9시에 말한 "오늘"이 어제가 되어 지난 날짜로 예약이 접수된다.
 *
 * 한쪽만 알아들은 결과를 **버리지 않고 돌려주는** 이유: 사람은 날짜와 시간을 한 번에 말하지
 * 않는다(「내일」 → 「오후 2시」). 합치는 일은 부르는 쪽(validateSlot)이 맡는다.
 */
export function parseDateTimeParts(input: string, now: Date = new Date()): DateTimeParts {
  const t = (input || '').trim();
  if (!t) return { date: null, time: null };

  let date: string | null = null;
  /** 달력에 없는 날을 말했다 — 「못 알아들었다」와 다른 사실이다 (DS 68-1). */
  let impossible: string | null = null;
  const iso = t.match(/(20\d{2})[-./](\d{1,2})[-./](\d{1,2})/);
  const md = t.match(/(?:^|[^\d])(\d{1,2})\s*(?:월|[/.\-])\s*(\d{1,2})\s*(?:일)?/);
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]);
    const d = Number(iso[3]);
    // 연도까지 적은 날은 **그 날이 달력에 있을 때만** 받는다 (DS 68-1) — 종전에는 「1~12월·
    // 1~31일」만 보고 `2026-02-30` 을 그대로 실어 보냈다(운영자 화면에 없는 날이 접수로 선다).
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      if (isRealYmd(y, m, d)) date = `${y}-${pad(m)}-${pad(d)}`;
      else impossible = `${y}년 ${m}월 ${d}일`;
    }
  } else if (md) {
    const m = Number(md[1]);
    const d = Number(md[2]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      // 연도 미기재 — 이미 지난 날짜면 내년으로 본다(예약은 미래가 기본).
      //
      // **없는 날을 넘기지 않는다** (DS 68-1): 종전에는 `normalizeYmd` 가 「2월 31일」을
      // 3월 3일로 넘겨 주었고, 그 날이 그대로 확정돼 고객에게 되읽혔다. 달력에 있는 해만
      // 고르고(윤년 2월 29일은 올해·내년에 없을 수 있다), 하나도 없으면 되묻는다.
      const today = kstYmd(now);
      const years = [today.y, today.y + 1].filter((y) => isRealYmd(y, m, d));
      if (!years.length) impossible = `${m}월 ${d}일`;
      else {
        const y = years.find((yy) => compareYmd({ y: yy, m, d }, today) >= 0) ?? years[years.length - 1];
        date = ymdToString({ y, m, d });
      }
    }
  } else {
    for (const [re, offset] of RELATIVE_DAYS) {
      if (re.test(t)) {
        const today = kstYmd(now);
        date = ymdToString(normalizeYmd(today.y, today.m, today.d + offset));
        break;
      }
    }
  }

  let time: string | null = null;
  // 「반」도 분이다 (DS 45-3) — 종전 식은 숫자만 봤으므로 「2시 반」이 **2시 00분**으로 확정됐고,
  // 봇은 그것을 「오후 2시」라고 되읽었다(30분 당겨진 약속이 접수된다). 「시」 바로 뒤의 「반」만
  // 본다. 「3시 반납」 같은 말은 30분으로 읽히지만, 그 값은 **되읽어 주므로** 고객이 고칠 수 있다
  // — 조용히 2시 00분으로 적어 두는 쪽(종전)이 고칠 기회조차 없다.
  //
  // 「시」 꼴과 콜론 꼴을 **따로** 본다 (DS 68-2) — 한 식으로 `[:시]` 를 묶으면 「시」 뒤의 맨 수가
  // 분이 된다. 둘 다 걸리면 **앞에 있는 것**을 쓴다(종전 식도 왼쪽부터 찾았다).
  const ko = t.match(HOUR_KO);
  const colon = t.match(HOUR_COLON);
  const hm = !ko ? colon : !colon ? ko : (ko.index ?? 0) <= (colon.index ?? 0) ? ko : colon;
  if (hm) {
    const spoken = Number(hm[1]);
    let h = spoken;
    const mnt = hm === ko ? (hm[3] ? 30 : hm[2] === undefined ? 0 : Number(hm[2])) : Number(hm[2]);
    const from = hm.index ?? 0;
    const half = meridiemFor(t, from, from + hm[0].length);
    if (half === 'pm' && h < 12) h += 12;
    else if (half === 'am' && h === 12) h = 0;
    else if (half === 'night') h = h === 12 ? 0 : h < 12 ? h + 12 : h;
    else if (half === 'day' && h >= 1 && h <= 6) h += 12;
    if (h >= 0 && h <= 23 && mnt >= 0 && mnt <= 59) {
      time = `${pad(h)}:${pad(mnt)}`;
      // 「밤 12시」·「자정」은 그 날이 **끝나는** 자리다 — 자정은 다음 날 0시다 (DS 68-3).
      // 종전에는 `pm && h < 12` 에 걸리지 않아 **정오**로 확정됐다(「오늘 밤 12시」가 점심때다).
      if (half === 'night' && spoken === 12 && date) {
        const [y, m, d] = date.split('-').map(Number);
        date = ymdToString(normalizeYmd(y, m, d + 1));
      }
    }
  }

  return { date, time, ...(impossible ? { impossible } : {}) };
}

/**
 * 위와 같은 파싱을 **한 문장**으로 적어 돌려준다(둘 다 못 찾으면 null).
 * 반쪽만 알아들은 경우의 표기(「(시간 미정)」·「날짜 미정」)는 그대로 둔다 — 사람에게 다시
 * 묻는 판단은 `validateSlot` 이 하고, 이 함수는 파싱 결과를 적는 자리다.
 */
export function parseDateTime(input: string, now: Date = new Date()): { value: string } | null {
  const { date, time } = parseDateTimeParts(input, now);
  if (!date && !time) return null;
  if (date && time) return { value: `${date} ${time}` };
  if (date) return { value: `${date} (시간 미정)` };
  return { value: `날짜 미정 ${time}` };
}

/** 「10월 2일」 — 고객에게 되읽어 주는 날짜. 연도는 말하지 않는다(올해·내년을 이미 풀어 둔 값이다). */
function dateWords(date: string): string {
  const [, m, d] = date.split('-');
  return `${Number(m)}월 ${Number(d)}일`;
}

/** 「오후 2시」·「오전 9시 30분」 — 24시 표기를 사람이 말하는 대로 되읽는다. */
function timeWords(time: string): string {
  const [hh, mm] = time.split(':').map(Number);
  const half = hh < 12 ? '오전' : '오후';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return mm === 0 ? `${half} ${h12}시` : `${half} ${h12}시 ${mm}분`;
}

/**
 * 그 날짜·시각이 **한국 시간으로** 이미 지났는가. 둘 다 같은 형식이라 글자 비교로 앞뒤가 가려진다.
 * 날짜만 비교하면 오후 3시에 말한 「오늘 오전 9시」가 그대로 접수된다.
 */
function isPastKst(date: string, time: string, now: Date): boolean {
  const today = ymdToString(kstYmd(now));
  if (date !== today) return date < today;
  return time < kstTime(now);
}

/**
 * 선택지 매칭 — 번호(「2」·「2번」·「2번이요」·「②」·「두 번째」)와 표기(동의어·오타 허용) 양쪽을 받는다.
 *
 * 고르는 자는 **`lib/choice` 한 곳**이다 (DS 69-1·69-2) — 종전에는 번호를 읽는 식이 이 파일과
 * `chat.parsePick` 에 한 벌씩 있었고(둘 다 `^([1-9])\s*(번|\.)?$`), 말로 고르는 쪽은 **먼저
 * 걸리는 선택지**를 돌려줬다. 돌려주는 값은 종전과 같다(고른 선택지 또는 null) — 「알아들었는데
 * 그런 번호가 없다」를 따로 말해야 하는 자리는 `validateSlot` 이다.
 */
export function matchChoice(choices: string[], input: string): string | null {
  const num = pickNumber(input, choices.length);
  if (num.kind === 'picked') return choices[num.number - 1];
  if (num.kind === 'out_of_range') return null;
  return pickChoice(choices, input);
}

/**
 * 슬롯 1건 검증. 실패 시 "어느 항목이 왜 틀렸는지 + 예시"를 담은 안내를 돌려준다.
 * 안내는 **고객 말풍선에 그대로 뜬다** — 조사는 받침에 맞춰 고른다(DS 29-3).
 * 종전에는 「방문 희망일을(를) 입력해 주세요.」처럼 괄호가 그대로 보였다.
 *
 * @param carry 날짜·시간 중 앞 턴에 알아들은 한쪽(DS 30-2). 이번 입력에 없는 쪽만 메운다.
 */
export function validateSlot(slot: SlotSpec, input: string, now: Date = new Date(), carry?: DateTimeParts): SlotResult {
  const raw = (input || '').trim();
  if (!raw) return { ok: false, message: `${josa(slot.label, '을', '를')} 입력해 주세요. ${slot.hint}` };
  if (raw.length > MAX_SLOT_VALUE_LEN) {
    return { ok: false, message: `${josa(slot.label, '이', '가')} 너무 길어요(${MAX_SLOT_VALUE_LEN}자 이내). 짧게 다시 알려주세요.` };
  }

  if (slot.kind === 'contact') {
    /**
     * 고르는 자는 **가리는 쪽에 한 벌**로 있다(`pii.takeContact` · DS 53-1 · DS 70-2).
     *
     * 종전에는 이 자리에 전화번호·이메일 패턴이 손으로 한 번 더 적혀 있었다 — 엔진의 연락처
     * 수집(`chat.extractContact`)·가리는 쪽(`pii`)과 함께 **세 벌**이었고, 이쪽 사본에는
     * 가리는 쪽이 쓰는 경계(`\b`)도 관문(`@` 가 붙으면 전화번호가 아니다)도 없었다. 그래서
     * 접수 폼의 연락처 칸은 `0212345678@example.com` 을 「전화번호 0212345678」로 받아 적었다.
     *
     * **자리 수가 맞지 않는 번호는 거절하고 그 사실을 말한다** (DS 70-2) — 종전에는 모양만
     * 보아 `010-123-4567`(열 자리)을 그대로 접수했고, 되읽는 문구가 가운데를 가리므로
     * (`010-****-4567`) 고객은 빠진 자리를 볼 길이 없었다.
     */
    const got = takeContact(raw);
    if (got.ok) return { ok: true, value: got.value };
    if (got.kind === 'phone') {
      return { ok: false, message: `${phoneShapeMessage(got.issue, got.head, got.plan, got.length)} ${slot.hint}` };
    }
    return { ok: false, message: `${CONTACT_SHAPE_MESSAGE} ${slot.hint}` };
  }

  if (slot.kind === 'datetime') {
    // 이번 입력에서 알아들은 쪽이 먼저고, 비어 있는 쪽만 앞 턴에서 알아들은 값으로 메운다.
    const got = parseDateTimeParts(raw, now);

    /**
     * 달력에 없는 날은 **가까운 있는 날로 옮기지 않는다** (DS 68-1).
     *
     * 들고 있던 반쪽 날짜로 메우지도 않는다 — 고객은 방금 **다른 날**을 말했고(그 날이 없을
     * 뿐이다), 앞 턴의 날짜로 확정하면 말하지 않은 날로 접수된다. 알아들은 **시각**은 들고
     * 있는다(DS 30-2 의 규칙 그대로 — 모르는 쪽만 다시 묻는다).
     */
    if (got.impossible) {
      const time = got.time ?? carry?.time ?? null;
      return {
        ok: false,
        message: `${josa(got.impossible, '은', '는')} 달력에 없는 날이에요. 날짜를 다시 알려주세요. ${slot.hint}`,
        ...(time ? { parts: { date: null, time } } : {}),
      };
    }

    const date = got.date ?? carry?.date ?? null;
    const time = got.time ?? carry?.time ?? null;

    // 반쪽만으로는 확정하지 않는다 — 「날짜 미정」인 예약 접수는 운영자가 다시 전화해 물어야
    // 하는 일거리이고, 그러면 챗봇이 접수한 의미가 사라진다. 알아들은 쪽은 되읽어 주고
    // 모르는 쪽만 묻는다(처음부터 다시 말하게 하지 않는다).
    if (date !== null && time === null) return { ok: false, parts: { date, time: null }, message: `${dateWords(date)}, 몇 시가 좋을까요?` };
    if (date === null && time !== null) return { ok: false, parts: { date: null, time }, message: `${timeWords(time)}, 며칠이 좋을까요?` };
    if (date === null || time === null) return { ok: false, message: `날짜·시간을 알아보지 못했어요. ${slot.hint}` };

    // 지난 때는 받지 않는다. 받아 두면 운영자에게 **이미 끝난 시각**으로 적힌 예약이 가고,
    // 고객은 접수됐다고 믿는다(연도를 적은 날짜는 「지났으면 내년」 보정이 닿지 않는 자리였다).
    if (isPastKst(date, time, now)) {
      return { ok: false, message: `${josa(`${dateWords(date)} ${timeWords(time)}`, '은', '는')} 이미 지났어요. 앞으로의 날짜·시간으로 알려주세요.` };
    }
    return { ok: true, value: `${date} ${time}` };
  }

  if (slot.kind === 'choice') {
    const choices = slot.choices ?? [];
    /**
     * **없는 번호를 「못 알아들었다」고 하지 않는다** (DS 69-1).
     *
     * 선택지가 넷인데 「5번」이라고 답한 고객은 번호로 고르는 길을 **제대로 쓴** 사람이다 —
     * 그에게 「발생 채널을 알아보지 못했어요」는 사실이 아니고, 무엇이 잘못됐는지도 말해 주지
     * 않는다(29차의 「거절은 무엇이 틀렸는지 밝힌다」). 알아들은 수를 되읽어 준다.
     */
    const num = pickNumber(raw, choices.length);
    if (num.kind === 'picked') return { ok: true, value: choices[num.number - 1] };
    if (num.kind === 'out_of_range') {
      return { ok: false, message: `${num.number}번 선택지는 없어요. ${renderChoices(choices)} 중에서 골라주세요.` };
    }
    const picked = pickChoice(choices, raw);
    if (picked) return { ok: true, value: picked };
    return { ok: false, message: `${josa(slot.label, '을', '를')} 알아보지 못했어요. ${renderChoices(choices)} 중에서 골라주세요.` };
  }

  // text — 의미 없는 한 글자·기호만 입력은 되묻는다.
  if (compact(raw).length < 2) {
    return { ok: false, message: `${josa(slot.label, '을', '를')} 조금 더 자세히 알려주세요. ${slot.hint}` };
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
    // 앞 항목으로 돌아가면 들고 있던 반쪽 날짜·시간은 버린다(다른 항목에 따라붙지 않게).
    return { kind: 'progress', state: { ...state, asked: prev.key, values, retries: 0, partial: undefined }, slot: prev, back: true };
  }

  if (control === 'skip') {
    if (isRequired(slot)) {
      const retries = state.retries + 1;
      if (retries >= MAX_SLOT_RETRIES) return { kind: 'max_retry', state: { ...state, retries }, slot };
      return {
        kind: 'invalid',
        state: { ...state, retries },
        slot,
        message: `${josa(slot.label, '은', '는')} 접수에 꼭 필요해서 건너뛸 수 없어요.`,
      };
    }
    return advance(form, { ...state, values: { ...state.values }, retries: 0 }, slot, { skipped: true });
  }

  // 날짜·시간은 앞 턴에 알아들은 반쪽을 함께 넘긴다 — 그러지 않으면 「내일」 → 「오후 2시」로
  // 나눠 말한 고객이 같은 질문을 세 번 받고 상담원으로 넘어간다(DS 30-2).
  const res = validateSlot(slot, text, clock, slot.kind === 'datetime' ? state.partial : undefined);
  if (!res.ok) {
    const retries = state.retries + 1;
    if (retries >= MAX_SLOT_RETRIES) return { kind: 'max_retry', state: { ...state, retries }, slot };
    // 알아들은 반쪽은 들고 있는다 — 알아듣지 못한 턴이 끼어도(「아무때나요」) 날짜를 다시
    // 말하게 하지 않는다. 합친 결과가 **지난 때**면 반쪽을 돌려받지 않으므로 여기서 비워진다:
    // 그 경우 틀린 쪽이 날짜인지 시각인지 알 수 없어, 한쪽만 남겨 두면 다음 턴에 지난 때가
    // 조용히 확정될 수 있다.
    return { kind: 'invalid', state: { ...state, retries, partial: res.parts }, slot, message: res.message };
  }

  const values = { ...state.values, [slot.key]: res.value };
  return advance(form, { ...state, values, retries: 0 }, slot, {});
}

/** 다음 미수집 슬롯으로 이동하거나 완료 처리한다. 건너뛴 항목은 다시 묻지 않는다. */
function advance(form: FormSpec, state: FormState, current: SlotSpec, opts: { skipped?: boolean }): ApplyResult {
  const idx = form.slots.findIndex((s) => s.key === current.key);
  const rest = form.slots.slice(idx + 1);
  const next = rest.find((s) => !(s.key in state.values)) ?? null;
  // 값이 확정됐거나 건너뛰었으면 들고 있던 반쪽 날짜·시간은 비운다(DS 30-2).
  if (!next) return { kind: 'complete', state: { ...state, asked: '', partial: undefined }, values: state.values };
  const nextState: FormState = { ...state, asked: next.key, retries: 0, partial: undefined };
  return opts.skipped
    ? { kind: 'progress', state: nextState, slot: next, skipped: true }
    : { kind: 'progress', state: nextState, slot: next };
}
