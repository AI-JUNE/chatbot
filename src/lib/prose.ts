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
 *
 * 76차에 같은 종류의 판정 셋이 더 왔다 (DS 79-1·79-2·79-3) — 「이 줄이 목록 항목인가」·「이 줄이
 * 표의 한 행인가」·「이 글자가 서식 표시인가」. 66차가 번호 매긴 목록에서 본 것과 **같은 결함**이
 * 글머리표·표에 남아 있었다: 우리는 제목(`#`)만 읽고 나머지 모양은 읽지 않았으므로, 운영자가
 * 붙여 넣은 목록·표는 공백 하나로 이어 붙고 그 표시(`-`·`|`·`---`·`**`)는 **고객 말풍선과
 * 「근거」 줄에 글자로** 갔다. 이 셋도 같은 방향으로 기운다 — 표의 머리 행은 구분선이 **증거로**
 * 있을 때만 머리라 보고(없으면 값끼리 나란히 적는다), 한 글자 강조는 건드리지 않는다.
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

// ---- 붙여 넣은 글의 모양 — 목록·표·서식 기호 (DS 79-1·79-2·79-3) ----

/**
 * 글머리표 한 줄인가 — 표시를 **사람이 읽는 글머리표**로 바꿔 돌려준다(아니면 null) (DS 79-1).
 *
 * 66차는 **번호 매긴** 목록을 한 문단으로 세웠다(이어 붙이면 번호가 줄바꿈을 잃으므로). 그런데
 * 같은 글에 그만큼 흔한 글머리표 목록(`-`·`*`·`•`)에는 그 자가 없었다 — 세 줄이 공백 하나로
 * 이어 붙고 표시는 **글자로 남았다**. 돌려서 받아 냈다:
 *
 *     - 수령 후 7일 이내: 전액 환불        → 「- 수령 후 7일 이내: 전액 환불 - 7일 초과
 *     - 7일 초과 14일 이내: 수수료 10% 차감    14일 이내: 수수료 10% 차감 * 사용 흔적이…」
 *     * 사용 흔적이 있으면 환불이 제한됩니다
 *
 * 이 한 줄이 고객 말풍선과 「근거」 줄에 그대로 간다. 표시가 글자로 남는 것보다 나쁜 것은
 * **항목 경계가 사라지는 것**이다 — 어느 조건이 어느 값인지 읽을 수 없다(「전액 환불 - 7일
 * 초과」가 한 문장처럼 이어진다). §13 이 금지한 「없는 수」와 같은 종류로, 원문에 없는 뜻이
 * 우리 손으로 만들어진다.
 *
 * 표시를 **떼고 하나로 모은다**: 아스키 표시(`-`·`*`·`+`)는 뒤에 띄어쓰기가 있을 때만 글머리표로
 * 본다(`*중요*`·`-5%`를 목록으로 읽지 않기 위해서다). 기호 표시(`•`·`·`…)는 띄어쓰기가 없어도
 * 글머리표다 — 붙여 넣은 글에서 그 글자가 줄머리에 올 다른 까닭이 없다.
 */
const ASCII_BULLET = /^([-*+])\s+(\S[\s\S]*)$/u;
const GLYPH_BULLET = /^([•·‣▪▫◦○●◆□■])\s*(\S[\s\S]*)$/u;

/** 고객이 읽는 글머리표 — 한국 문서가 열거에 쓰는 중간점이다. 자리는 이 한 곳이다. */
export const BULLET_MARK = '· ';

export function bulletLine(line: unknown): string | null {
  const t = String(line ?? '').trim();
  if (!t) return null;
  const m = t.match(ASCII_BULLET) ?? t.match(GLYPH_BULLET);
  return m ? `${BULLET_MARK}${m[2].trim()}` : null;
}

/**
 * 표 한 줄인가 — 칸으로 끊어 돌려준다(아니면 null) (DS 79-2).
 *
 * 마크다운 표(`| 구분 | 수수료 |`)와 탭으로 끊은 표(엑셀·한글 표를 복사하면 그 모양이 온다)
 * 둘을 함께 본다. 종전에는 둘 다 **보통 본문 줄**이어서 빈 줄까지 공백으로 이어 붙었다 —
 * 행이 뭉개지고 `|`·`---` 가 고객에게 글자로 갔다(돌려서 받아 냈다):
 *
 *     | 구분 | 수수료 |          → 「| 구분 | 수수료 | | --- | --- | | 7일 이내 | 없음 |
 *     | --- | --- |                | 14일 이내 | 10% |」
 *     | 7일 이내 | 없음 |
 *     | 14일 이내 | 10% |
 *
 * 다른 행의 값이 한 줄에 섞이므로 **「없음」이 어느 줄의 값인지** 알 수 없다 — 수수료를 물은
 * 고객이 읽는 글이다.
 */
const PIPE_ROW = /^\|(.+)\|$/;
/** 머리 행 아래의 구분선 칸(`---`·`:---:`) — 값이 아니라 「윗줄이 머리 행이다」는 표시다. */
const DIVIDER_CELL = /^:?-{2,}:?$/;

export function tableCells(line: unknown): string[] | null {
  const t = String(line ?? '').trim();
  if (!t) return null;
  const pipe = t.match(PIPE_ROW);
  if (pipe) {
    const cells = pipe[1].split('|').map((c) => c.trim());
    return cells.length >= 2 ? cells : null;
  }
  if (t.includes('\t')) {
    const cells = t.split('\t').map((c) => c.trim());
    return cells.filter(Boolean).length >= 2 ? cells : null;
  }
  return null;
}

export function isTableDivider(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((c) => !c || DIVIDER_CELL.test(c));
}

/**
 * 표 한 덩이를 **고객이 읽는 줄**로 옮긴다 (DS 79-2) — 행마다 한 줄이다.
 *
 * 머리 행은 **구분선이 있을 때만** 머리로 삼는다. 탭으로 붙여 넣은 표는 첫 줄이 머리 행인 일이
 * 많지만 그것을 단정하면, 머리가 없는 표에서 **첫 데이터 행이 모든 줄의 이름**이 된다 —
 * 「7일 이내: 14일 이내」처럼 원문에 없는 짝이 만들어진다. 애매하면 단정하지 않는 쪽이 이 파일의
 * 규칙이다(위 제목·문장 판정과 같은 까닭).
 *
 * 빈 칸과 「-」(없음 표시)은 적지 않는다 — 「비고: -」는 고객에게 아무 뜻이 없다.
 */
export function tableLines(rows: readonly (readonly string[])[]): string[] {
  const body: string[][] = [];
  let header: string[] | null = null;
  for (const row of rows) {
    const cells = row.map((c) => String(c ?? '').trim());
    if (isTableDivider(cells)) {
      // 구분선 바로 위의 한 줄만 머리 행이다(그 위에 이미 값이 쌓였으면 머리로 보지 않는다).
      if (header === null && body.length === 1) header = body.pop() ?? null;
      continue;
    }
    body.push(cells);
  }
  const out: string[] = [];
  for (const cells of body) {
    const parts: string[] = [];
    cells.forEach((cell, i) => {
      if (!cell || cell === '-') return;
      const label = header?.[i]?.trim();
      parts.push(label && label !== cell ? `${label}: ${cell}` : cell);
    });
    if (parts.length) out.push(parts.join(' · '));
  }
  return out;
}

/**
 * 강조·링크·인라인 코드 **표시를 떼어** 글만 남긴다 (DS 79-3).
 *
 * 콘솔은 운영자에게 「안내문·약관·매뉴얼 텍스트를 붙여넣으면」이라 말하고 마크다운 제목(`#`)을
 * 읽는다. 그런데 읽는 것이 제목뿐이어서, 같은 글의 나머지 표시는 **고객 말풍선에 글자로**
 * 갔다(돌려서 받아 냈다): 「**중요**: 환불금은…」·「신청은 [고객센터](https://example.com/center)
 * 에서」. 운영자는 미리보기에서 그 글자를 보고도 자기가 지울 것인지 제품이 읽을 것인지 알 수 없다.
 *
 * 주소는 **남긴다** — 표시만 떼고 「고객센터(https://…)」로 적는다. 고객이 눌러 갈 곳이 그 글에
 * 든 유일한 길이므로 지우는 쪽이 더 큰 손해다(검색어로 세지 않는 것은 `stripAddresses` 가 한다).
 *
 * 한 글자 강조(`*글*`·`_글_`)는 그대로 둔다 — 떼는 규칙을 넓히면 `doc_001`·`A*B` 처럼 표시가
 * 아닌 별표·밑줄이 함께 지워진다. 애매하면 **글을 건드리지 않는 쪽**이다.
 */
const LINK_MARK = /!?\[([^\]\n]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
const STRONG_MARK = /(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g;
const CODE_MARK = /`+([^`\n]+)`+/g;

export function stripInlineMarks(s: unknown): string {
  return String(s ?? '')
    .replace(LINK_MARK, (_m, label: string, url: string) => {
      const text = label.trim();
      if (!text) return url;
      return text === url ? text : `${text}(${url})`;
    })
    .replace(STRONG_MARK, '$2')
    .replace(CODE_MARK, '$1');
}

/**
 * 주소·이메일·파일 이름 토막을 지운다 — **검색어를 뽑는 자리 전용**이다 (DS 79-3).
 *
 * 이 파일은 그 모양을 이미 안다: `periodEndsSentence` 가 「점 뒤에 띄어쓰기 없이 영문·숫자가
 * 이어지면 문장 끝이 아니다」로 주소·파일 이름을 가린다. 같은 사실이 **검색어를 뽑는 쪽**에는
 * 없어서, 주소 한 줄이 자료 한 건의 여덟 칸 중 다섯을 먹었다(돌려서 받아 냈다):
 *
 *     신청은 [고객센터](https://example.com/center)에서. 문의: help@gowon.co.kr
 *       → center · example · gowon · https · help  (여덟 칸 중 다섯)
 *       → 그 문서의 「환불」은 칸을 받지 못하고, 「https 보안 되나요」에 2점으로 답했다
 *
 * 고객은 주소를 글자로 치지 않는다. 지우는 것은 **점·@·: 로 이어 붙은 아스키 토막**뿐이고
 * (주소·이메일·파일 이름·시각), 한글은 그 토막의 글자가 아니므로 그대로 남는다.
 */
const ADDRESS_LIKE = /[0-9A-Za-z][0-9A-Za-z._%+\-:/?=&#]*[.@:][0-9A-Za-z._%+\-:/?=&#]*[0-9A-Za-z]/g;

export function stripAddresses(s: unknown): string {
  return String(s ?? '').replace(ADDRESS_LIKE, ' ');
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
