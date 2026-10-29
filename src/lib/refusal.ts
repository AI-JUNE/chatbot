/**
 * 거절하는 문장 — 사람 말로 쓰는 한 곳 (DS 29-3).
 *
 * 서버가 거절하며 적어 보낸 문장은 **그대로 화면에 뜬다**: 콘솔은 `data.message || data.error`
 * 를 토스트·인라인 오류로 옮겨 적고(`failed()`), 위젯도 같은 본문을 읽는다.
 * 그래서 이 문장들은 「서버 메시지」가 아니라 화면 문구다 — 그런데 콘솔 문구 테스트는
 * 화면(JSX) 문자열만 훑기 때문에(DS 2-8) 이 자리는 줄곧 사각이었다. DS 22 가 이관 요약·
 * 대화 주제·감사 로그에서 고친 것과 같은 구조이고, 그때 훑지 않은 쪽이 「거절」이다.
 *
 * 규칙
 * - 입력 칸의 **사람 말 이름**은 여기 한곳에만 있다(코드 키와 떨어진 곳에 또 적으면 어긋난다).
 * - 이름이 없는 키는 **이름을 말하지 않는 문장**으로 떨어진다 — 코드 키를 그대로 보여 주는
 *   폴백은 두지 않는다(DS 22 의 「기타」와 같은 원칙). 고객이 적은 적도 없는 `sessionId`·
 *   `citation` 같은 자리는 이름을 말해도 도움이 되지 않는다.
 * - 문장에 들어가는 **수는 `lib/num.comma` 로 적는다**(DS 60-3) — 런타임의 ICU 에 맡기지 않는다.
 */
import { comma } from '@/lib/num';

/**
 * 끝 글자의 **받침** — 조사를 고르는 데 필요한 만큼만 셋으로 가른다 (DS 61-1).
 *
 *  - `none`  : 받침이 없다 → 는·가·를·와·로
 *  - `rieul` : ㄹ 받침 → 은·이·을·과이지만 **로**(「서울로」 — 「서울으로」가 아니다)
 *  - `other` : 그 밖의 받침 → 은·이·을·과·으로
 *  - `null`  : 읽을 수 없다(기호·한자 등) → 부르는 쪽이 받침 없는 쪽으로 떨어진다
 *
 * **한글 음절만 보지 않는다.** 종전 판정(`hasBatchim`)은 끝 글자가 한글 음절이 아니면 전부
 * 「모른다」로 두고 받침 없는 쪽을 썼다. 그런데 이 자리에 들어오는 값의 상당수는 접수번호
 * (`ESC-0001`)·가린 연락처(`010-****-5673`·`ab***@example.com`)·고객사 id(`eum`)처럼
 * **숫자·영문으로 끝난다** — 그래서 고객 말풍선에 「접수번호 ESC-0001는」이 적혔다.
 * 사람은 그 값을 **소리로 읽는다**:
 *  - 숫자 한 자의 한글 독음 — 0 영 · 1 일 · 2 이 · 3 삼 · 4 사 · 5 오 · 6 육 · 7 칠 · 8 팔 · 9 구
 *    (받침 있는 쪽이 0·1·3·6·7·8 여섯이고, 그중 1·7·8 은 ㄹ 받침이다)
 *  - 영문 한 자의 자모 이름 — l 엘 · m 엠 · n 엔만 받침이 있고 나머지는 모두 열린 소리다
 *    (a 에이 · b 비 · f 에프 · r 아르 · v 브이 · x 엑스 …)
 *
 * 값 뒤에 붙은 닫는 따옴표·괄호는 **소리가 없다** — 그 앞 글자로 판정한다(「「환불」은」).
 */
export type Batchim = 'none' | 'rieul' | 'other';

const DIGIT_BATCHIM: Batchim[] = ['other', 'rieul', 'none', 'other', 'none', 'none', 'other', 'rieul', 'rieul', 'none'];

export function batchimOf(word: string): Batchim | null {
  const last = String(word ?? '').replace(/[\s」』〉》"'”’»›)\]}]+$/, '').slice(-1);
  if (!last) return null;
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) {
    const jong = (code - 0xac00) % 28;
    return jong === 0 ? 'none' : jong === 8 ? 'rieul' : 'other';
  }
  if (last >= '0' && last <= '9') return DIGIT_BATCHIM[Number(last)];
  const alpha = last.toLowerCase();
  if (alpha >= 'a' && alpha <= 'z') return alpha === 'l' ? 'rieul' : alpha === 'm' || alpha === 'n' ? 'other' : 'none';
  return null;
}

/**
 * 조사 한 짝에서 **붙일 글자만** 고른다 — 값과 조사 사이에 다른 글자가 끼는 자리
 * (「「${keyword}」은」)는 `josa` 로는 적을 수 없다 (DS 61-3).
 *
 * ㄹ 받침은 **「으」로 시작하는 짝**에서만 받침 없는 쪽을 쓴다: 「으로」처럼 매개모음 「으」가
 * 끼는 조사는 ㄹ 받침 뒤에서 그 「으」가 빠진다(「서울로」·「ESC-0001로」). 은/는·이/가·
 * 을/를·과/와는 그렇지 않다 — 그래서 받침 유무 하나로는 두 무리를 함께 고를 수 없다.
 */
export function particle(word: string, withBatchim: string, withoutBatchim: string): string {
  const b = batchimOf(word);
  if (b === null || b === 'none') return withoutBatchim;
  if (b === 'rieul' && withBatchim.startsWith('으')) return withoutBatchim;
  return withBatchim;
}

/**
 * 조사를 골라 붙인다 — 화면에 「은(는)」 같은 괄호를 남기지 않는다.
 * 판정할 수 없는 끝 글자에는 받침 없는 쪽을 쓴다(읽을 때 덜 어색한 쪽이다).
 */
export function josa(word: string, withBatchim: string, withoutBatchim: string): string {
  return `${word}${particle(word, withBatchim, withoutBatchim)}`;
}

/**
 * 거절 문장에 쓸 수 있는 입력 칸 이름.
 * 키는 API 본문의 필드 이름(코드 어휘)이고, 값은 **그 칸의 화면 라벨과 같은 말**이다 —
 * 운영자가 「문서 본문」이라고 적힌 칸을 보고 있을 때 「text」라고 말하면 서로 다른 제품이 된다.
 */
export const FIELD_LABELS: Readonly<Record<string, string>> = {
  title: '문서명',
  text: '문서 본문',
  category: '카테고리',
  note: '메모',
  status: '상태',
  message: '메시지',
  contact: '연락처',
  reply: '답변',
  // 지식베이스 한 자료·내 규칙 한 건의 칸 (DS 74-1·74-3) — 종전에는 이 칸들이 거절 문장을
  // 가질 일이 없었다(아무도 재지 않았으므로 거절도 없었다). 이름은 **그 칸의 화면 라벨**이다:
  // 「답변」은 자료 쪽과 규칙 쪽이 같은 말이라 `reply` 와 같은 글자를 쓴다.
  question: '대표 질문',
  answer: '답변',
  keywords: '고객이 쓸 표현',
  label: '규칙 이름',
};

/** 화면에 적어도 되는 이름. 없으면 null — 부르는 쪽이 이름 없는 문장으로 떨어진다. */
export function fieldLabel(key: string): string | null {
  return FIELD_LABELS[key] ?? null;
}

/** 「…을 입력해 주세요」 — 빠진 칸. */
export function requiredMessage(field: string): string {
  const name = fieldLabel(field);
  return name ? `${josa(name, '을', '를')} 입력해 주세요.` : '빠진 항목이 있습니다. 다시 확인해 주세요.';
}

/**
 * 「…은 n자까지 적을 수 있습니다」 — 길이 상한. 자릿수는 천 단위로 끊어 읽기 쉽게 적는다.
 * 끊는 자는 `lib/num.comma` 하나다 (DS 60-3) — 종전에는 `toLocaleString('ko-KR')` 이라
 * ICU 가 작은 런타임에서 「2000자」가 됐고, 같은 상한을 알리는 카카오 쪽 문장은 쉼표를 손으로
 * 넣어 「2,000자」였다. 같은 수를 창구에 따라 다르게 적지 않는다.
 */
export function tooLongMessage(field: string, max: number): string {
  const limit = `${comma(max)}자까지 적을 수 있습니다.`;
  const name = fieldLabel(field);
  return name ? `${josa(name, '은', '는')} ${limit}` : `${limit} 길이를 줄여 다시 시도해 주세요.`;
}

/**
 * **연락처를 받지 못한 까닭** — 세 가지가 서로 다른 말을 한다 (DS 70-2).
 *
 * 한 문장으로 뭉치면 고칠 수가 없다(QUALITY_BAR §1 「어느 항목이 왜 틀렸는지」). 자리 하나가
 * 빠진 번호에 「형식을 알아보지 못했어요」라고 하면 고객은 **같은 번호를 다시 적는다** — 모양은
 * 맞았고 자리 수가 틀렸으니, 틀린 것이 무엇인지 말해 주어야 고칠 수 있다.
 *
 * 번호 전체를 되읽지 않는다 — 앞가지와 자리 수만 적는다. 이 문장은 고객 말풍선·접수 폼·
 * 접수 API 거절에 **같은 말로** 쓰이고, 그 글은 대화 기록에 그대로 남는다.
 */
export function phoneShapeMessage(issue: 'prefix' | 'digits', head: string, plan: readonly number[], length: number): string {
  if (issue === 'prefix') {
    // 조사는 **앞가지를 읽는 소리**에 맞춘다 — 「010으로」·「012로」(DS 61-2 의 자 그대로).
    return `${josa(head, '으로', '로')} 시작하는 전화번호는 없어요. 휴대폰(010)·지역번호(02·031)·인터넷전화(070) 중 하나로 알려주세요.`;
  }
  return `${head} 번호는 ${plan.join('·')}자리인데 ${length}자리로 적어 주셨어요. 번호를 다시 확인해 주세요.`;
}

/** 전화번호도 이메일도 찾지 못한 자리 — 무엇을 받는지 먼저 말한다. */
export const CONTACT_SHAPE_MESSAGE = '연락처 형식을 알아보지 못했어요. 전화번호 또는 이메일로 알려주세요.';

/** 글자가 아닌 값이 온 자리(정상 화면에서는 생기지 않는다 — 그래도 코드 어휘를 보이지 않는다). */
export function notTextMessage(field: string): string {
  const name = fieldLabel(field);
  return name ? `${name} 칸에는 글자만 적을 수 있습니다.` : '입력한 값이 올바르지 않습니다. 다시 확인해 주세요.';
}

/**
 * 백업 파일이 아닌 것을 올렸을 때 — 복원 경로 5곳(안내 자료·감사 로그·대화·접수·파트너)이
 * 같은 말을 한다. 종전에는 네임스페이스마다 다른 코드 어휘(「kb·customRules 배열」·
 * 「events 배열」…)를 적어 보내, 운영자가 받는 안내가 파일마다 달라졌다.
 */
export const RESTORE_FORMAT_MESSAGE = '백업 파일 형식이 아닙니다. 콘솔에서 내려받은 백업 파일을 그대로 올려주세요.';

/** 목록에서 이미 사라진 대상을 가리키고 있을 때 — 「없는 id」 대신 다음에 할 일을 말한다. */
export const STALE_TARGET_MESSAGE = '이미 지워졌거나 목록에서 사라진 대상입니다. 목록을 새로 불러온 뒤 다시 시도해 주세요.';

/** 고를 수 없는 상태 — 허용값 목록(코드)을 늘어놓지 않는다. */
export const BAD_STATUS_MESSAGE = '고를 수 없는 상태입니다. 목록에서 다시 골라 주세요.';

/**
 * 내가 열어 둔 사이에 **다른 화면에서 바뀐 것** (DS 46-1).
 *
 * 관리 콘솔은 여러 사람이 같은 토큰으로 들어오는 화면이다. 편집 폼은 연 순간의 사진이고,
 * 저장은 그 사진을 통째로 덮어쓴다 — 거절하지 않으면 그 사이 남이 고친 것이 말없이 사라진다.
 * 「충돌」·「버전」 같은 말은 쓰지 않는다. 일어난 일과 다음에 할 일만 적는다.
 */
export const CHANGED_TARGET_MESSAGE =
  '그 사이 다른 화면에서 이 항목이 바뀌었습니다. 지금 저장된 내용을 불러와 확인한 뒤 다시 저장해 주세요.';

/**
 * 지우려던 것이 그 사이 **바뀌었을 때** (DS 57-1).
 *
 * `CHANGED_TARGET_MESSAGE` 를 그대로 쓰지 않는 까닭: 그 문장은 「다시 저장해 주세요」로 끝난다 —
 * 지우는 자리에서 할 말이 아니다. 여기서 운영자가 먼저 알아야 하는 것은 **아무것도 지워지지
 * 않았다**는 사실이고(되돌릴 수 없는 동작이라 더 그렇다), 다음 할 일은 새로 불러온 내용을
 * 보고 **다시 고르는** 것이다. 「충돌」·「버전」 같은 말은 여기서도 쓰지 않는다.
 */
export const CHANGED_DELETE_TARGET_MESSAGE =
  '그 사이 다른 화면에서 이 항목이 바뀌었습니다. 아무것도 지우지 않았습니다 — 새로 불러온 내용을 확인한 뒤 다시 선택해 주세요.';

/**
 * 접수는 상태 이름이 곧 사실이다 — **무엇으로 바뀌었는지**까지 말한다 (DS 46-2).
 * 「완료」로 바뀐 접수를 되돌리면 이미 파기된 연락처는 돌아오지 않는다(개인정보처리방침 4조).
 */
export function changedStatusMessage(statusLabel: string): string {
  return `그 사이 다른 화면에서 이 접수가 ${josa(statusLabel, '으로', '로')} 바뀌었습니다. 목록을 새로 불러온 뒤 다시 처리해 주세요.`;
}
