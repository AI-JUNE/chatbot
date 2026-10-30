// 받는 말·남기는 말의 글자 상한과 「잘랐다」는 표시 — 단일 출처 (DS 38-1·38-2·38-3).
//
// 왜 한 파일인가: 종전에는 상한이 입구마다 숫자로 흩어져 있었다(2000·500·300·4000). 숫자에 이름이
// 없으면 두 가지가 따라온다 — ① **창구마다 달라진다**(웹은 2000자에서 거절하는데 카카오는 발화를
// 그대로 받았다) ② **넘친 사실을 아무도 말하지 않는다**(`slice` 는 꼬리를 조용히 버린다).
// 34차 재감사가 카카오의 **나가는 말**에서 고친 바로 그 방식(「자르기」가 아니라 「나눠 담고,
// 그래도 넘치면 말하기」)이 **들어오는 말·남기는 말**에는 그대로 남아 있었다.
//
// 웹 상한이 라우트 안에 적혀 있던 것은 우연이 아니다 — `route.ts` 는 HTTP 메서드·설정 외
// export 를 할 수 없어서(빌드 실패) 애초에 **다른 창구가 가져다 쓸 수 없는 자리**였다.

/** 고객이 한 번에 보낼 수 있는 글자 수. 창구(웹·카카오)가 달라도 같은 말을 같게 받는다. */
export const MAX_MESSAGE_LEN = 2000;

/** 대화 기록 한 칸(고객의 말·답변)에 남기는 글자 수. */
export const TURN_TEXT_LEN = 500;

/** 접수 본문 — 접수 시점의 마지막 고객 메시지. */
export const TICKET_MESSAGE_LEN = 300;

/** 상담원 메모. */
export const TICKET_NOTE_LEN = 500;

/**
 * 접수에 적는 연락처 — 상담원이 전화를 걸 곳이다 (DS 54-1).
 *
 * 종전에는 이 수가 접수를 만드는 함수 안에 `slice(0, 100)` 두 번으로 적혀 있었고, **복원 경로
 * 에는 아예 없었다** — 저장분이 적어 온 글자가 길이째 그대로 들어와 큐 목록·상세 서랍·백업으로
 * 나갔다. 이름 없는 숫자는 입구마다 갈라진다는 것이 이 파일이 생긴 까닭이다.
 */
export const TICKET_CONTACT_LEN = 100;

/** 이관 요약 평문 전체 상한(접수에 저장되는 길이). */
export const SUMMARY_TEXT_LEN = 4000;

/** 이관 요약의 한 줄 — 직전 대화 한 마디·수집 정보 한 값. */
export const SUMMARY_LINE_LEN = 300;

/**
 * 관리 작업 기록의 「대상」·「내용」 — 운영자가 그대로 읽고 CSV 로 내려받는 칸이다 (DS 62-3).
 * 종전에는 이 두 수가 `lib/audit.ts` 안에 `slice(0, 100)`·`slice(0, 300)` 으로만 있었다.
 */
export const AUDIT_TARGET_LEN = 100;
export const AUDIT_DETAIL_LEN = 300;

/**
 * 기록 한 줄에 싣는 **사람이 적은 이름** 한 토막 (DS 62-3).
 *  - `AUDIT_NAME_LEN` : 한 값만 싣는 자리(자료 질문·규칙 이름·문서 제목)
 *  - `AUDIT_PART_LEN` : 여러 값을 이어 싣는 자리(파트너 이름 / 귀속 / 경로 / 메모)
 *
 * 왜 이름을 주는가: 종전에는 다섯 라우트에 `slice(0, 60)`·`slice(0, 40)` 으로 박혀 있었고,
 * **어느 것도 잘렸다고 말하지 않았다** — 이 파일이 생긴 까닭(이름 없는 숫자는 입구마다
 * 갈라지고, 넘친 사실을 아무도 말하지 않는다)이 그대로 남아 있던 자리다.
 */
export const AUDIT_NAME_LEN = 60;
export const AUDIT_PART_LEN = 40;

/**
 * **운영자가 적어 고객에게 나가는 글**의 상한 — 지식베이스 한 자료·내 규칙 한 건 (DS 74-1·74-3).
 *
 * 왜 이 파일에 와야 했는가: 이 제품은 **받는 말**(고객 발화 2000자)과 **남기는 말**(기록·요약·
 * 감사 로그)은 전부 이 파일에서 재는데, 정작 **우리가 내보내는 말**은 아무도 재지 않았다.
 * 돌려서 받아 냈다 — 3만 자 답변과 2만 자 규칙 답변이 그대로 저장되고, 그 글은 고객 말풍선에
 * 한 덩이로 나간다. 고객이 한 번에 보낼 수 있는 글자는 2000자인데(`MAX_MESSAGE_LEN`) 우리가
 * 보내는 글에는 상한이 없었다 — 같은 대화의 두 쪽을 다른 자로 재고 있었다.
 *
 * 수를 왜 이렇게 두는가:
 *  - `KB_ANSWER_LEN` 은 `MAX_MESSAGE_LEN`·문서 등록의 「한 항목 길이」 상한(`CHUNK_CHARS_MAX`)과
 *    **같은 2000**이다. 문서를 조각으로 나눠 등록하는 길과 손으로 적어 넣는 길이 같은 상한을
 *    쓰지 않으면, 한쪽으로 들어온 자료만 다른 쪽에서 고칠 수 없게 된다.
 *  - `KEYWORDS_LEN` 은 **칸 하나**의 상한이다(화면은 쉼표로 이어 적는 한 칸이다). 낱말 하나의
 *    상한(`KEYWORD_LEN`)은 문서에서 뽑을 때만 쓴다 — 띄어쓰기 없는 긴 덩이가 검색어가 되면
 *    어떤 질문에도 걸리지 않는다. 두 수는 **함께 맞춰 둔다**: 문서에서 뽑는 검색어는 8개까지라
 *    (`ingest.extractKeywords` 의 기본값) 8×30 + 쉼표 7 = 254 자로 칸 하나에 들어간다 —
 *    그래야 문서로 들어온 자료를 콘솔에서 **다시 저장할 수 있다**(한 칸으로 보내므로).
 */
export const KB_QUESTION_LEN = 200;
export const KB_ANSWER_LEN = 2000;
export const KB_CATEGORY_LEN = 40;
export const KB_SOURCE_LEN = 300;
export const KEYWORDS_LEN = 300;
export const KEYWORD_LEN = 30;
export const RULE_LABEL_LEN = 80;
/** 규칙 답변 — 종전 이름(`MAX_RULE_REPLY_LEN`)으로 `lib/adminStore` 가 그대로 내보낸다. */
export const RULE_REPLY_LEN = 1000;

/**
 * 잘랐을 때 그 자리에 남기는 표시.
 *
 * 왜 필요한가: 운영자는 「환불 수수료가 궁금한데 저번에 주문한」에서 **고객이 거기서 멈춘 것인지
 * 우리가 버린 것인지** 알 수 없다. 그 글은 「답하지 못한 질문」 목록이 되어 새 안내 자료의
 * 원문이 되고, 접수 본문이 되어 상담원이 전화하기 전에 읽는 문장이 된다(QUALITY_BAR §3).
 */
export const CLIP_MARK = '…(이하 생략)';

/** 화면 한 칸에 맞춰 줄일 때의 표시 — 보일 글자가 귀한 자리에서는 한 글자로 말한다 (DS 62-2). */
export const ELLIPSIS = '…';

/**
 * 앞 글자에 **붙어서 한 글자를 이루는** 코드포인트 (DS 62-1).
 *
 *  - `\p{M}`           : 결합 기호 — 키캡 `1️⃣` 의 U+20E3, 라틴 악센트, 한글 옛 방점
 *  - U+200D            : 이음표(ZWJ) — 가족 이모지 `👩‍👩‍👧` 를 한 글자로 묶는 글자
 *  - U+FE0E·U+FE0F     : 변형 선택자 — `✔️` 의 뒷글자(이것만 떨어지면 `✔` 가 흑백으로 바뀐다)
 *  - U+1F3FB~U+1F3FF   : 피부색 수정자 — `👍🏻`
 *  - U+E0020~U+E007F   : 태그 글자 — 잉글랜드 깃발 `🏴󠁧󠁢󠁥󠁮󠁧󠁿`
 *  - U+1160~U+11FF     : 분해형 한글의 중성·종성 — `ᄀ`+`ᅡ` 사이에서 자르면 `ᄀ` 만 남는다
 *                        (DS 42-3 이 검색에서 만난 그 분해형이다 — 맥에서 올린 파일·입력기가 보낸다)
 */
const JOINS_LEFT = /^(?:\p{M}|[‍︎️]|[\u{1F3FB}-\u{1F3FF}]|[\u{E0020}-\u{E007F}]|[ᅠ-ᇿ])$/u;

/** 지역 표시자 — 둘이 모여 국기 하나(`🇰🇷`)가 된다. 하나만 남으면 글자가 아니라 알파벳 `🇰` 가 보인다. */
const REGIONAL = /^[\u{1F1E6}-\u{1F1FF}]$/u;

/** `i` 자리의 코드포인트를 글자 하나로 — 서로게이트 쌍이면 두 칸이다. */
function cpAt(v: string, i: number): string {
  return String.fromCodePoint(v.codePointAt(i) as number);
}

/**
 * `limit` 칸을 넘지 않으면서 **글자 하나를 쪼개지 않는** 마지막 자리 (DS 62-1).
 *
 * 왜 필요한가: 자바스크립트의 `length`·`slice` 는 글자가 아니라 UTF-16 **칸**을 센다. 이모지
 * 하나는 두 칸(서로게이트 쌍)이라, 상한이 그 가운데 떨어지면 반쪽(`\uD83D`)만 남는다. 반쪽은
 * 글자가 아니다 — UTF-8 로 적는 순간 `�` 로 바뀌고(CSV 내려받기·카카오 응답), 브라우저도
 * 같은 모양으로 그린다. 고객이 적은 말·운영자가 적은 이름·문서 본문이 모두 이 자를 지난다.
 *
 * 돌려주는 값은 `slice` 에 그대로 넣는 **끝 자리**다. 한 글자도 들어가지 않으면 0 이다
 * (표시만 남는 쪽이, 반쪽 글자를 남기는 쪽보다 낫다).
 */
export function cutEnd(text: unknown, limit: number): number {
  const v = String(text ?? '');
  if (limit <= 0) return 0;
  if (limit >= v.length) return v.length;

  let end = 0;
  let i = 0;
  while (i < v.length) {
    let j = i + cpAt(v, i).length;
    // 국기: 지역 표시자 둘이 한 글자다.
    if (REGIONAL.test(v.slice(i, j)) && j < v.length && REGIONAL.test(cpAt(v, j))) j += 2;
    // 뒤에 붙는 것(결합 기호·수정자·이음표)과 **이음표 바로 뒤의 글자**까지 같은 묶음으로 삼킨다.
    while (j < v.length) {
      const next = cpAt(v, j);
      if (JOINS_LEFT.test(next) || v.codePointAt(j - 1) === 0x200d) {
        j += next.length;
        continue;
      }
      break;
    }
    if (j > limit) break;
    end = j;
    i = j;
  }
  return end;
}

/**
 * 표시 없이 상한만 지킨다 — **표시를 붙이면 값이 망가지는 자리** (DS 62-1).
 *
 * 연락처(상담원이 그대로 눌러 전화를 거는 값)·모델에 보내는 프롬프트 전체처럼, 「줄였다」는
 * 글자가 섞이면 값 자체가 쓸 수 없게 되는 자리다. 그래도 **글자를 쪼개지는 않는다** — 반쪽
 * 글자는 값을 망가뜨리는 데다 사람이 읽을 수도 없다.
 *
 * 프롬프트에서 이 자가 닿는 것은 **울타리**뿐이다 (DS 75-3): 그 안의 근거 자료 한 건은
 * `clip` 으로 「…(이하 생략)」을 달아 싣는다 — 모델이 반 토막을 전부로 읽으면 자료에 적힌
 * 금액이 「12,0원」이 되기 때문이다. 이 자가 실제로 끊는 자리가 생기면 그것은 담는 쪽이
 * 상한을 잘못 셈한 것이다.
 */
export function cut(text: unknown, limit: number): string {
  const v = String(text ?? '');
  return v.length <= limit ? v : v.slice(0, cutEnd(v, limit));
}

/**
 * 상한에 맞춰 자르되 **잘랐다는 표시를 남긴다**. 결과 길이는 언제나 `limit` 이하다
 * (표시도 그 안에 들어간다 — 상한을 지키는 쪽이 저장·내려받기 계약이다).
 *
 * 상한이 표시보다 짧은 극단(설정 실수)에서는 표시 없이 자른다 — 표시만 남고 내용이 사라지는
 * 모양을 만들지 않는다. 자르는 자리는 `cutEnd` 가 고른다(글자를 쪼개지 않는다 — DS 62-1).
 */
export function clip(text: unknown, limit: number): string {
  const v = String(text ?? '');
  if (limit <= 0) return '';
  if (v.length <= limit) return v;
  if (limit <= CLIP_MARK.length) return v.slice(0, cutEnd(v, limit));
  return `${v.slice(0, cutEnd(v, limit - CLIP_MARK.length)).trimEnd()}${CLIP_MARK}`;
}

/**
 * 화면 한 칸에 맞춰 줄인다 — 표시는 한 글자(`…`) (DS 62-2).
 *
 * `clip` 과 무엇이 다른가: `clip` 은 **저장·내려받기**의 상한이라 「무엇이 잘렸는가」를 글로
 * 말할 값이 있다(`…(이하 생략)`). 이쪽은 목록 한 줄·말풍선 버튼 라벨처럼 **보일 글자가 귀한**
 * 자리다 — 표시가 여덟 칸을 먹으면 정작 내용이 사라진다. 결과 길이는 두 자 모두 `limit` 이하다.
 *
 * 종전에는 이 일을 아홉 자리가 손으로 적었고 **너비가 서로 달랐다** — 어떤 곳은 `n-1` 에서
 * 자르고(결과 `n`), 어떤 곳은 `n` 에서 자른 뒤 표시를 붙였다(결과 `n+1`). 주석에 「40자」라
 * 적어 두고 41자를 돌려주던 자리도 있었다.
 */
export function ellipsize(text: unknown, limit: number): string {
  const v = String(text ?? '');
  if (limit <= 0) return '';
  if (v.length <= limit) return v;
  return `${v.slice(0, cutEnd(v, limit - ELLIPSIS.length)).trimEnd()}${ELLIPSIS}`;
}
