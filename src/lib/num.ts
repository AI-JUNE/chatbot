/**
 * 사람이 읽는 **수**를 적는 단일 출처 (DS 60-3).
 *
 * 왜 `toLocaleString('ko-KR')` 을 쓰지 않는가: 이 저장소는 이미 한 자리에서 그 판단을 내렸다 —
 * `lib/kakao.ts` 는 발화 상한을 알리는 문장에서 천 단위 쉼표를 **손으로** 넣으면서
 * 「`toLocaleString` 은 런타임의 ICU 설치에 따라 「2000」이 되기도 한다」고 적어 두었다.
 * 그런데 같은 상한(`MAX_MESSAGE_LEN`)을 **웹 창구**에서 알리는 문장(`lib/refusal.tooLongMessage`)과
 * 파트너 월 이용료 검증(`lib/partners`)은 `toLocaleString` 을 그대로 썼다. 둘은 같은 서버
 * 런타임에서 돈다 — 즉 ICU 가 작은 빌드에서는 **카카오는 「2,000자」, 웹은 「2000자」** 가 된다.
 * 같은 수를 창구에 따라 다르게 적는 것 자체가 어긋남이고(`KAKAO_UTTERANCE_LIMIT` 주석이 세운 규칙),
 * 어느 쪽이 될지가 배포 환경에 달려 있다는 것은 `lib/kst.ts` 가 「며칠인가」를 고정한 것과 같은 문제다.
 *
 * 그래서 **우리가 적는다**: 정수부만 세 자리씩 끊고, 소수점 뒤·부호는 건드리지 않는다.
 * 계산식은 Intl 을 쓰지 않으므로 서버·브라우저·테스트가 같은 글자를 낸다.
 *
 * 콘솔 화면(`src/app/admin/page.tsx`)은 lib 을 불러오지 않는 규약이라 이 식을 옮겨 적고,
 * 테스트가 두 결과를 맞춰 고정한다(`kstMonthNow`·`MAX_DOC_CHARS` 와 같은 방식).
 */
import { cleanText } from '@/lib/text';

/**
 * 천 단위로 끊어 적는다. `1234.5` → `1,234.5` · `-1200` → `-1,200`.
 * 수가 아닌 값(NaN·Infinity)은 **지어내지 않고** 받은 그대로 글자로 돌려준다
 * (`kstDateTime` 이 읽을 수 없는 시각에 지금을 지어내지 않는 것과 같은 규칙).
 */
export function comma(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const s = String(n);
  const dot = s.indexOf('.');
  const head = dot < 0 ? s : s.slice(0, dot);
  const tail = dot < 0 ? '' : s.slice(dot);
  const sign = head.startsWith('-') ? '-' : '';
  const digits = sign ? head.slice(1) : head;
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${tail}`;
}

// ───────────────────────────────────────────────────────────────────────────
// 수를 **읽는** 자리 (DS 65-1)
//
// 위쪽은 수를 사람 글자로 **적는** 단일 출처다(60차). 그 반대쪽 — 사람이 적은 글자를 수로
// **읽는** 자리 — 에는 자가 없었고, 자리마다 `Number()` 가 손으로 적혀 있었다.
//
// `Number()` 가 하는 일을 받아 적으면 이렇다:
//   Number('')·Number(' ')·Number('\n')·Number(null)·Number([])·Number(false)  → **0**
//   Number(true) → 1 · Number(['300000']) → 300000 · Number('0x1f4') → 500 · Number('1e5') → 100000
// 즉 **비어 있는 것과 0 을 가르지 못한다**. 그 둘은 이 제품에서 전혀 다른 사실이다 —
// `lib/settlement` 의 첫 원칙이 「없는 숫자를 만들지 않는다 · 근거가 없으면 0으로 치지 않고
// 합계에서 뺀다」이고, 월 이용료 칸에 들어온 **공백 한 칸**이 바로 그 「없는 숫자」였다
// (0원짜리 계약으로 저장되어 정산 리포트에 「산출 완료 · 수수료 0원」으로 섰다).
// 63차가 글에서 「보이는 것이 없는데 글자로 세어지는 것」을 막은 것과 같은 종류의 어긋남이다.
//
// 그래서 **빈 값·수가 아닌 값·범위 밖**을 각각 다른 답으로 돌려준다 — 부르는 쪽이 「미입력」과
// 「잘못 적음」에 다른 말을 해야 하기 때문이다(29차의 「거절은 그 칸 아래에서 밝힌다」).

export type NumIssue = 'blank' | 'not_number' | 'too_small' | 'too_large';
/**
 * 두 갈래 모두 **같은 칸을 가진다**(`value`·`issue`) — 판별 유니언으로 두면 `strictNullChecks`
 * 가 꺼진 번들(콘솔 사본을 컴파일하는 테스트 하네스가 그렇다)에서 좁혀지지 않아, 사본과 원본이
 * 서로 다른 모양이 된다. 같은 자를 두 곳에 두기로 한 이상 모양도 같아야 한다.
 */
export type NumResult =
  | { ok: true; value: number; issue: null }
  | { ok: false; value: null; issue: NumIssue };

export interface NumRules {
  min?: number;
  max?: number;
  /** 정수 자리로 맞춘다(반올림). 범위는 **맞춘 뒤의 값**으로 본다. */
  integer?: boolean;
}

/**
 * 사람이 적은 10진 표기만 받는다 — 16진(`0x…`)·2진·8진·지수(`1e5`)·`Infinity` 는 수가 아니라
 * **다른 표기법**이고, 운영자가 금액 칸에 적을 글이 아니다(적었다면 오타다).
 * 전각 숫자·아랍 숫자는 `Number()` 도 거절하므로 여기서도 거절된다(같은 답을 유지한다).
 */
const DECIMAL = /^[+-]?\d+(?:\.\d+)?$/;

/**
 * **수를 받는 자** — 빈 값과 0 을 가른다.
 *
 * 글자에서 쉼표·공백을 턴다(`300,000`·`300 000` 은 붙여 넣은 문서에서 흔한 표기다).
 * 보이지 않는 글자도 먼저 턴다(`lib/text.cleanText` · DS 63-1) — 그러지 않으면 제로폭 공백
 * 하나가 든 칸이 「수가 아님」으로 거절되어, 운영자는 비어 보이는 칸을 앞에 두고 무엇을
 * 고쳐야 할지 모른다.
 */
export function parseNumber(v: unknown, rules: NumRules = {}): NumResult {
  const no = (issue: NumIssue): NumResult => ({ ok: false, value: null, issue });
  let n: number;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return no('not_number');
    n = v;
  } else if (typeof v === 'string') {
    const s = cleanText(v).replace(/[,\s]/g, '');
    if (s === '') return no('blank');
    if (!DECIMAL.test(s)) return no('not_number');
    n = Number(s);
    if (!Number.isFinite(n)) return no('not_number');
  } else if (v === undefined || v === null) {
    return no('blank');
  } else {
    // 참/거짓·배열·객체는 수가 아니다. `Number()` 는 이것들을 0·1 로 바꿔 놓는다.
    return no('not_number');
  }
  if (rules.integer) n = Math.round(n);
  if (rules.min !== undefined && n < rules.min) return no('too_small');
  if (rules.max !== undefined && n > rules.max) return no('too_large');
  return { ok: true, value: n, issue: null };
}

/** 범위 안으로 당긴다. **값을 바꾸는 일**이므로 부르는 쪽이 그래도 되는 자리인지 정한다. */
export function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

/**
 * **설정값(환경변수)을 수로 읽는 자** (DS 65-3).
 *
 * 설정값도 같은 문으로 들어온다 — 그런데 배포 화면에서 환경변수를 **빈 값으로 두는 것**은
 * 「설정하지 않음」을 뜻하는 가장 흔한 손짓이고, `Number('')` 은 그것을 **0** 으로 읽었다.
 * `PARTNER_DEFAULT_FEE_RATE_BP=` 하나로 모든 파트너의 기본 수수료율이 「미설정」이 아니라
 * **0%** 가 되어, 정산 리포트가 「산출 완료 · 수수료 0원」을 확정 수치로 적었다(미설정 경고도
 * 뜨지 않는다 — 근거가 「갖춰진」 행이기 때문이다).
 *
 * 값이 없거나 읽을 수 없으면 **null** 이다. 「없으면 무엇으로 할 것인가」(기본값으로 갈 것인가,
 * 범위 밖을 당길 것인가, 미설정으로 둘 것인가)는 설정마다 다르므로 부르는 쪽이 정한다.
 */
export function envNumber(name: string, rules: NumRules = {}): number | null {
  const r = parseNumber(process.env[name], rules);
  return r.ok ? r.value : null;
}
