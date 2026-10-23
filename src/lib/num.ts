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
