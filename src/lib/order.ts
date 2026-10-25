/**
 * **이름으로 줄을 세우는 자** — 목록의 순서를 정하는 단일 출처 (DS 64-2).
 *
 * 왜 한 곳인가: 고치기 전 이 저장소는 같은 질문(「ㄱ 다음은 무엇인가」)에 **네 가지로** 답했다.
 *
 *  ① 코드포인트 순 — `[...cats].sort()` (안내 자료 탭의 분류 거르개)
 *  ② 런타임 기본 로케일 — `a.localeCompare(b)` (`convlog` 고객사·`feedback` 근거·
 *     `ingest` 표현·`settlement` 고객사 코드). 로케일을 적지 않은 `localeCompare` 는
 *     **그 서버에 켜진 로케일**로 센다 — 개발 PC 는 `ko-KR`, 배포 환경은 대개 `en-US` 다.
 *  ③ `ko` — `settlement` 의 파트너 이름
 *  ④ `ko` + `numeric` — 콘솔 표의 머리칸 정렬(`compareCell`)
 *
 * 같은 목록이 자리마다 다른 순서로 선다. 돌려서 본 모습:
 *   코드포인트 : 10차 안내 , 2차 안내 , A/S , Zebra , apple , as , 가입 , 요금
 *   ko+numeric : 2차 안내 , 10차 안내 , 가입 , 요금 , A/S , apple , as , Zebra
 * 안내 자료 탭에서는 **거르개 목록과 바로 밑 표의 분류 열이 서로 다른 차례**로 서고
 * (한쪽은 영문이 앞, 한쪽은 한글이 앞), 정산 표는 머리칸을 **누르기 전과 누른 뒤**가
 * 다른 차례가 된다(「2차 안내」와 「10차 안내」가 자리를 바꾼다). 운영자는 같은 화면 안에서
 * 두 번 다른 순서를 보고, 어느 쪽이 제품의 뜻인지 알 길이 없다.
 *
 * 무엇을 정했는가: **한국어 사전 순 + 자리수대로(`numeric`)**. 콘솔 표가 이미 그 자였고
 * (DS 31-1), 이 제품의 목록은 거의 전부 한국어 이름이다. 「2건」과 「10건」이 자리수대로 서는
 * 쪽이 사람이 읽는 순서다.
 *
 * 남는 것: 글자표(collation) 자체는 런타임의 것이다 — 한국어 사전 순을 손으로 적는 것은
 * `lib/num.comma`·`lib/kst.kstMinute` 가 서식에서 한 일과 **크기가 다르다**(수천 글자의 표다).
 * 대신 **무엇을 묻는지**를 한 곳에 못박아, 자리마다 다른 답이 나오는 일은 없게 한다.
 */

/** 정렬이 쓰는 로케일·옵션 — 콘솔 사본(`compareText`)도 같은 값을 적는다. */
export const ORDER_LOCALE = 'ko';
export const ORDER_OPTIONS: Intl.CollatorOptions = { numeric: true };

/**
 * 이름 두 개의 앞뒤(음수면 `a` 가 먼저). 빈 값·`null` 은 빈 문자열로 본다 —
 * 「뒤로 보낼 것인가」는 표가 정한다(`compareCell` 이 그 판단을 들고 있다).
 */
export function compareText(a: string | null | undefined, b: string | null | undefined): number {
  return String(a ?? '').localeCompare(String(b ?? ''), ORDER_LOCALE, ORDER_OPTIONS);
}
