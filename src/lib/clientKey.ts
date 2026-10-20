/**
 * **요청자를 가리는 열쇠** — 횟수 제한·무차별 대입 잠금이 「누구의 것인가」를 세는 기준 (DS 51-1).
 *
 * 왜 따로 떼어냈는가: 이 판정은 종전에 `@/lib/ratelimit` 안에 있었고, 그 모듈은
 * `@/lib/http`(→ `next/server`)를 끌어온다. 그래서 런타임 테스트가 **닿을 수 없는 자리**였고,
 * 이 함수의 검증은 소스 텍스트 대조 두 줄뿐이었다 — 발화 상한이 `route.ts` 안에 있어 카카오
 * 창구가 가져다 쓸 수 없었던 것(DS 38-1)·CSV 를 만드는 코드가 라우트 안에 있어 값 검증이 0건
 * 이었던 것(DS 40-1)과 같은 모양이다. 의존성 없는 순수 모듈로 내려 **돌려 볼 수 있게** 했다.
 *
 * 무엇이 틀렸는가: 종전 식은 `x-forwarded-for` 의 **맨 앞**을 그대로 바구니 이름으로 썼다.
 * 그 자리는 프록시가 덮어쓰지 않는 한 **요청을 보낸 사람이 적는 칸**이다 — 한 줄만 바꿔
 * 보내면 열쇠가 매 요청 달라지고, 그 열쇠에 걸려 있던 것이 모두 함께 풀린다:
 *  - 관리 토큰 **무차별 대입 잠금**(`@/lib/adminAuth` — 5회 실패 시 10분). 열쇠가 바뀌면 실패
 *    횟수도 처음부터라, 「느리게 오래 시도하는 대입까지 막는다」고 적어 둔 자가 아무것도 막지 않았다
 *  - 고객용 **접수 조회 제한**(30회/분). 49차가 접수번호 훑기를 막으려고 건 바로 그 제한이다
 *    (접수번호는 연번이다 · DS 49-1)
 *  - 대화·접수·평가·웹훅의 분당 제한 전부
 * 게다가 모양을 보지 않고 64자로 자르기만 했으므로, 아무 글자나 보내면 **매번 빈 바구니**에서
 * 시작했다 — 세는 자가 있으나 세지 못한다.
 */

/** 요청자를 가릴 수 없을 때 쓰는 한 바구니 — 「모른다」는 값이고, 그래서 **함께** 센다. */
export const UNKNOWN_CLIENT = 'unknown';

/**
 * IP 모양인가 — 우리가 아는 주소의 모습이 아니면 열쇠로 쓰지 않는다.
 * 요청마다 새 바구니를 내주는 쪽이 한 바구니에 모으는 쪽보다 나쁘다(그때는 세는 일이 사라진다).
 */
export function looksLikeIp(v: string): boolean {
  const s = v.trim().replace(/^\[/, '').replace(/\]$/, '').replace(/^::ffff:/i, '');
  if (!s || s.length > 45) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return s.split('.').every((o) => Number(o) <= 255);
  return s.includes(':') && /^[0-9a-f:.]+$/i.test(s);
}

/** 플랫폼(앞단 프록시)이 자기 손으로 적는 칸 — 요청자가 보낸 값이 여기 남지 않는다. */
const TRUSTED_HEADERS = ['x-vercel-forwarded-for', 'x-real-ip'] as const;

/**
 * 이 요청을 어느 바구니에 셀 것인가.
 *
 * 순서: **플랫폼이 적는 헤더** → `x-forwarded-for` 의 **맨 뒤** → 「모른다」.
 * `x-forwarded-for` 에서 맨 뒤를 쓰는 까닭은 그 자리가 **가장 가까운 프록시가 덧붙이는 칸**
 * 이고 맨 앞이 요청자가 적는 칸이기 때문이다. 앞단이 아무 헤더도 적지 않는 환경에서는
 * 믿을 수 있는 출처가 아예 없으므로, 그때는 「모른다」 한 바구니로 모은다 — 여럿이 한 제한을
 * 나눠 쓰는 것은 아는 불편이고(사내망 공유 IP 와 같다), 요청마다 빈 바구니를 내주는 것은
 * 제한이 없는 것과 같다.
 */
export function clientKey(headers: Headers): string {
  for (const name of TRUSTED_HEADERS) {
    const v = headers.get(name);
    if (v && looksLikeIp(v)) return v.trim().slice(0, 64);
  }
  const fwd = headers.get('x-forwarded-for');
  if (fwd) {
    const parts = fwd.split(',').map((p) => p.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && looksLikeIp(last)) return last.slice(0, 64);
  }
  return UNKNOWN_CLIENT;
}
