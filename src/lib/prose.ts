/**
 * **글의 뼈대를 짐작하는 자** — 어디서 문장이 끝나고, 어느 줄이 제목인가 (DS 66-1·66-2·66-3).
 *
 * 59차는 글을 **자르는** 자리를 한 벌로 모았고(`lib/limits` — 몇 칸까지 담을 수 있는가),
 * 63차는 글을 **받는** 자리를 모았다(`lib/text` — 보이는 글자가 있는가). 이번에 보는 것은
 * 그 사이에 남아 있던 일이다: 우리는 사람이 적은 글에서 **구조를 읽어 낸다** — 「여기서 문장이
 * 끝났다」·「이 줄은 제목이다」. 그 판정이 자리마다 손으로 적혀 있었고, 셋 다 틀린 자리가 있었다.
 *
 * 세 자리 모두 **사람이 그 결과를 읽는다**:
 *  - 운영자가 올린 문서를 조각으로 나눌 때(`lib/ingest`) — 제목이라 읽은 줄은 **본문에서 사라진다**
 *  - 답변에서 근거 한 문장을 떠올 때(`lib/knowledge`) — 그 문장이 말풍선의 「근거」 줄이 된다
 *  - 긴 답변을 카카오 말풍선으로 나눌 때(`lib/kakao`) — 끊은 자리가 고객이 읽는 줄 끝이 된다
 *
 * 무엇이 틀렸던가: 세 자리가 모두 **마침표 하나를 문장 끝으로** 읽었다. 그런데 우리 글에는
 * 문장을 끝내지 않는 마침표가 흔하다 — 소수(`1.5배`)·주소(`www.gowon.co.kr`)·파일 이름
 * (`index.html`)·약어(`A.S.`)·날짜(`2026. 10. 25.`)·번호 매김(`1.`). 그래서 고객은
 * 「근거: 초과 사용분은 1.」을 읽고(원문은 「1.5배로 계산합니다」다), 말풍선은 「… 1.」 에서 끊겨
 * 다음 말풍선이 「5배로 계산합니다」로 시작했다 — 앞 말풍선만 읽은 사람은 **1배로 읽는다**.
 * §13 이 금지한 「없는 수」가 우리 손으로 만들어지는 자리다.
 *
 * 판정의 방향(두 틀림의 크기가 다르다):
 *  - 문장 끝을 **놓치는** 쪽의 손해는 발췌가 길어지는 것뿐이다(자르는 자가 뒤에서 상한을 지킨다).
 *  - 아닌 자리를 문장 끝이라 **단정하는** 쪽은 수와 주소를 반으로 쪼갠다.
 *  - 제목을 **못 알아보는** 쪽의 손해는 제목 경로 한 줄이 비는 것이다(글은 본문에 그대로 남는다).
 *  - 본문을 **제목이라 단정하는** 쪽은 그 줄을 지식베이스에서 통째로 지운다(DS 66-1).
 * 그래서 두 판정 모두 **단정하지 않는 쪽**으로 기운다.
 */

/** 문장을 끝낼 수 있는 글자(전각 표기 포함 — 붙여 넣은 글에 섞여 들어온다). */
const TERMINAL = new Set(['.', '!', '?', '。', '！', '？']);

/** 문장 끝에 **붙어 있는** 닫는 묶음표·인용표 — 앞 문장의 것이다(「…합니다.)」). */
const CLOSER = /[)\]}'"”’»〉》」』】]/;

const DIGIT = /[0-9]/;
/** 점 뒤에 띄어쓰기 없이 이어지면 주소·파일 이름·번호다(`co.kr`·`index.html`·`No.1`). */
const ASCII_WORD = /[0-9A-Za-z]/;
const LATIN = /[A-Za-z]/;

/** 줄머리가 **번호 매김뿐인가**(`1.`·`3.1.`·`2026. 10. 25`) — 그 점들은 문장을 끝내지 않는다. */
const NUMBERING_HEAD = /^[\s\d.)\-]*$/;

/** 줄머리의 번호 매김 한 토막 — 떼어 내고 「남은 글이 문장인가」를 본다. */
const LEADING_NUMBER = /^제?\s?\d+(?:[.\-]\d+)*\s?(?:조|장|절)?[.)]?\s*/;

/**
 * 한국어 종결 어미로 끝나는가 — 「…합니다」·「…해요」·「…인가요」·「…했음」.
 * 제목은 대개 이름(명사)으로 끝난다(「환불 규정」·「설치 방법」).
 */
const PREDICATE_TAIL = /(?:다|요|죠|까|함|임|음|오)$/;

/**
 * 종결 어미만으로 본문이라 단정하기에 **짧은** 줄 — 「1. 개요」·「5. 기타 사항 모음」처럼
 * 어미와 같은 글자로 끝나는 제목이 있다. 문장부호로 끝나는 줄은 길이를 보지 않는다.
 */
const SENTENCE_MIN_CHARS = 12;

/**
 * `i` 자리의 글자가 문장을 끝내는가 — 끝내면 **문장이 끝나는 자리**(그 뒤 인덱스)를, 아니면 0 을
 * 돌려준다. 돌려주는 값은 `slice` 에 그대로 넣을 수 있는 끝 자리다(뒤따르는 묶음표·물음표까지
 * 같은 문장으로 삼킨다 — 그러지 않으면 「진짜?!」 가 「진짜?」와 「!」 두 문장이 된다).
 */
export function sentenceEndAt(text: unknown, i: number): number {
  const v = String(text ?? '');
  const ch = v[i];
  if (!ch || !TERMINAL.has(ch)) return 0;
  // 마침표만 까다롭다 — `!`·`?`·`。` 는 글 가운데 올 까닭이 없다.
  if (ch === '.' && !periodEndsSentence(v, i)) return 0;
  let j = i + 1;
  while (j < v.length && (TERMINAL.has(v[j]) || CLOSER.test(v[j]))) j += 1;
  return j;
}

/** 마침표 하나가 문장을 끝내는가 — 숫자·주소·약어·번호 매김의 가운데 점은 아니다. */
function periodEndsSentence(v: string, i: number): boolean {
  const prev = v[i - 1] ?? '';
  const next = v[i + 1] ?? '';
  // 1.5 · 1,250.50 — 숫자와 숫자 사이
  if (DIGIT.test(prev) && DIGIT.test(next)) return false;
  // www.gowon.co.kr · index.html · No.1 — 띄어쓰기 없이 영문·숫자가 이어진다
  if (ASCII_WORD.test(next)) return false;
  // A.S. · e.g. — 영문 한 글자 뒤의 점(약어)
  if (LATIN.test(prev) && !LATIN.test(v[i - 2] ?? '')) return false;
  // 「1.」·「2026. 10. 25.」 — 줄머리의 번호·날짜. 문장은 그 뒤에서 시작한다.
  if (DIGIT.test(prev) && NUMBERING_HEAD.test(v.slice(0, i).split('\n').pop() as string)) return false;
  return true;
}

function pushPart(out: string[], s: string): void {
  const t = s.trim();
  if (t) out.push(t);
}

/**
 * 글을 문장 단위로 나눈다(줄바꿈도 경계다). 빈 조각은 담지 않는다.
 * 근거 발췌(`lib/knowledge`)가 쓰는 자이고, 끊을 자리를 찾는 쪽(`lib/kakao`)은 같은
 * 판정(`sentenceEndAt`)을 자리만 물어 쓴다 — 두 벌로 적으면 한쪽만 고쳐진다.
 */
export function splitSentences(text: unknown): string[] {
  const v = String(text ?? '');
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < v.length; i += 1) {
    if (v[i] === '\n') {
      pushPart(out, v.slice(start, i));
      start = i + 1;
      continue;
    }
    const end = sentenceEndAt(v, i);
    if (!end) continue;
    pushPart(out, v.slice(start, end));
    i = end - 1;
    start = end;
  }
  pushPart(out, v.slice(start));
  return out;
}

/**
 * 이 줄이 **문장으로 읽히는가** — 그렇다면 제목이 아니라 본문이다 (DS 66-1).
 *
 * 번호 매김(`1.`·`제3조`)은 제목에도 붙고 목록 항목에도 붙는다. 가르는 것은 **남은 글**이다:
 * 문장부호로 끝나거나(제목에는 마침표를 붙이지 않는다), 종결 어미로 끝나면서 제목이라기에
 * 긴 줄이면 본문으로 본다. 애매하면 **본문**이다 — 제목으로 잘못 읽은 줄은 사라진다.
 */
export function readsAsSentence(line: unknown): boolean {
  const rest = String(line ?? '').trim().replace(LEADING_NUMBER, '').trim();
  if (!rest) return false;
  // 끝의 닫는 묶음표를 걷어 낸 자리에 문장부호가 있으면 문장이다(「…합니다.」·「…인가요?」).
  const bare = rest.replace(/[)\]}'"”’»〉》」』】]+$/u, '');
  if (bare && TERMINAL.has(bare[bare.length - 1])) return true;
  return rest.length >= SENTENCE_MIN_CHARS && PREDICATE_TAIL.test(rest);
}
