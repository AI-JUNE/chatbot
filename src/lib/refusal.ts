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
 */

/** 받침이 있으면 true. 한글 음절이 아니면(영문·숫자·기호) 판정하지 않는다(null). */
function hasBatchim(word: string): boolean | null {
  const last = word.trim().slice(-1);
  if (!last) return null;
  const code = last.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return null;
  return (code - 0xac00) % 28 !== 0;
}

/**
 * 조사를 골라 붙인다 — 화면에 「은(는)」 같은 괄호를 남기지 않는다.
 * 판정할 수 없는 끝 글자에는 받침 없는 쪽을 쓴다(읽을 때 덜 어색한 쪽이다).
 */
export function josa(word: string, withBatchim: string, withoutBatchim: string): string {
  return `${word}${hasBatchim(word) ? withBatchim : withoutBatchim}`;
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

/** 「…은 n자까지 적을 수 있습니다」 — 길이 상한. 자릿수는 천 단위로 끊어 읽기 쉽게 적는다. */
export function tooLongMessage(field: string, max: number): string {
  const limit = `${max.toLocaleString('ko-KR')}자까지 적을 수 있습니다.`;
  const name = fieldLabel(field);
  return name ? `${josa(name, '은', '는')} ${limit}` : `${limit} 길이를 줄여 다시 시도해 주세요.`;
}

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
