// 지식 문서 인제스트 — 텍스트/마크다운 문서를 청크로 나눠 KB 후보로 변환한다.
// 벡터 검색·임베딩 없이(비용·의존성 0) 제목 계층 + 문단 경계로 자르고 키워드를 뽑는 방식.
// [승인 필요] 임베딩 기반 시맨틱 검색·외부 스토리지 업로드 — 전까지 서버 메모리·관리 콘솔 등록만.
import type { KBEntry } from '@/lib/knowledge';
import { cut, cutEnd, ellipsize, KB_QUESTION_LEN, KB_SOURCE_LEN, KEYWORD_LEN } from '@/lib/limits';
import { compact, toNfc } from '@/lib/normalize';
import { compareText } from '@/lib/order';
import { readsAsSentence, splitSentences } from '@/lib/prose';

export const MAX_DOC_CHARS = 100_000;

/**
 * 문서에서 떠온 **첫머리**를 보일 글자 수 — 대표 질문·빠진 조각 미리보기가 같은 수를 쓴다
 * (DS 62-2). 종전에는 한 쪽이 `slice(0, 39)`(결과 40자), 다른 쪽이 `slice(0, 40)`
 * (결과 41자)였고 주석에는 둘 다 「40자」라 적혀 있었다.
 */
export const DOC_HEAD_LEN = 40;
export const DEFAULT_CHUNK_CHARS = 500;
export const MIN_CHUNK_CHARS = 40;

/**
 * 운영자가 고를 수 있는 **「한 항목 길이」의 범위** (DS 65-1).
 *
 * 바로 위 `MIN_CHUNK_CHARS` 와는 **다른 수**다 — 그쪽은 「이보다 짧은 조각은 앞 조각에
 * 붙인다」는 내부 기준이고, 이쪽은 화면이 묻고 운영자가 적는 값의 한계다. 이름이 비슷해
 * 서로를 가렸다.
 *
 * 종전에는 이 두 수가 라우트 안에 `Math.min(Math.max(…, 120), 2000)` 으로 손으로 적혀
 * 있었고 콘솔에 또 한 벌 적혀 있었다. 라우트는 HTTP 메서드·설정 외 export 가 금지되어
 * (★ 안전 원칙) **다른 곳이 가져다 쓸 수 없는 자리**다 — 38차가 웹 발화 상한에서 본 것과
 * 같은 자리이고, 그래서 상한이 자리마다 손으로 적히면 갈라지는지 아무도 알 수 없다.
 */
export const CHUNK_CHARS_MIN = 120;
export const CHUNK_CHARS_MAX = 2000;

export interface DocChunk {
  /** 문서 내 순번(1부터) */
  index: number;
  /** 이 청크가 속한 제목 경로(예: "요금 안내 > 할인"). 제목이 없으면 빈 문자열. */
  heading: string;
  text: string;
}

export interface ChunkOptions {
  /**
   * 한 조각의 길이 **상한**(문자) — 운영자가 「한 항목 길이」로 고르는 값이다 (DS 74-2).
   *
   * 종전 주석은 「목표 길이 … 초과할 수 있다」였고, 실제로는 **얼마든지** 초과했다: 빈 줄 없이
   * 붙여 넣은 약관 한 덩이는 문단이 하나라 조각도 하나다(돌려서 받아 냈다 — 500자로 고른
   * 7,500자 문서가 7,499자 한 조각이 됐고, 그 글이 그대로 자료의 답변이 되어 고객 말풍선에
   * 한 덩이로 나갔다). 운영자가 미리보기에서 눈으로 확인하는 수가 이 값이므로, 이제는 **넘지
   * 않는다** — 문단이 길면 문장 경계에서, 한 문장이 그보다 길면 글자 경계에서 나눈다.
   */
  maxChars?: number;
  /** 이보다 짧은 청크는 앞 청크에 합친다(합쳐도 상한을 넘지 않을 때만). */
  minChars?: number;
}

const HEADING_RE = /^(#{1,6})\s+(.*\S)\s*$/;
/** "1. 제목", "1.2 제목", "제1조 (목적)" 형태의 번호 제목 */
const NUMBERED_HEADING_RE = /^(?:제?\s?\d+(?:[.\-]\d+)*\s?(?:조|장|절)?[.)]?)\s+\S.{0,60}$/;

/**
 * 이 줄이 제목인가.
 *
 * `#` 은 글쓴이가 손으로 적은 표시라 그대로 믿는다. **번호 매김은 믿을 수 없다** (DS 66-1) —
 * 제목에도 붙고 목록 항목에도 붙는다. 종전에는 번호로 시작하는 줄을 전부 제목으로 읽었는데,
 * 제목으로 읽은 줄은 `chunkDocument` 에서 **본문에 담기지 않는다**(제목 경로로만 남는다).
 * 그래서 한국어 문서에 가장 흔한 모양 — 번호 매긴 규정·FAQ 목록 — 이 통째로 사라졌다:
 *
 *     환불 규정
 *     1. 구매 후 7일 이내에는 전액 환불됩니다.   ← 세 줄 모두 제목으로 읽혀
 *     2. 7일이 지나면 사용 기간을 제외합니다.      지식베이스에 남는 것은
 *     3. 프로모션 상품은 환불되지 않습니다.        「환불 규정」 넉 자뿐이었다
 *
 * 「빠진 조각」(DS 58-3)도 이것을 세지 않는다 — 조각이 **만들어지지 않았기** 때문이다. 목록만
 * 있는 문서는 조각이 0개가 되어 「본문이 너무 짧거나 키워드가 없습니다」로 거절됐다(DS 42-3 이
 * 분해형 한글에서 들었던 그 말이다 — 멀쩡한 문서를 올린 운영자가 사실이 아닌 사유를 읽는다).
 * 날짜로 시작하는 줄(`2026. 10. 25. 기준으로 …`)도 같은 길로 사라졌다.
 *
 * 그래서 번호 뒤에 **남은 글이 문장으로 읽히면 본문**으로 둔다(`lib/prose.readsAsSentence`).
 * 애매하면 본문이다 — 제목을 놓치면 제목 경로 한 줄이 비지만, 본문을 제목이라 읽으면 글이
 * 사라진다.
 */
function isHeadingLine(line: string): { level: number; title: string } | null {
  const md = line.match(HEADING_RE);
  if (md) return { level: md[1].length, title: md[2].trim() };
  const t = line.trim();
  if (t && t.length <= 70 && NUMBERED_HEADING_RE.test(t) && !readsAsSentence(t)) {
    return { level: 2, title: t };
  }
  return null;
}

/**
 * 번호로 시작하는 **목록 항목** 줄인가 — 제목 판정을 지난 뒤에 묻는다 (DS 66-1).
 *
 * 왜 따로 보는가: 본문 줄은 빈 줄까지 모아 **한 줄로 이어 붙인다**(`buf.join(' ')`). 그러면
 * 되살린 목록이 「1. … 2. … 3. …」 한 덩이가 되어, 고객이 받는 답변에서 번호가 줄바꿈을
 * 잃는다(규정·절차는 번호가 곧 읽는 순서다). 항목 하나를 **한 문단으로** 세워 두면 조각
 * 안에서 줄바꿈이 그대로 남고, 목록이 길면 「한 항목 길이」 기준으로 조각이 갈린다.
 */
const LIST_ITEM_RE = /^제?\s?\d+(?:[.\-]\d+)*\s?(?:조|장|절)?[.)]\s+\S/;

function headingPath(stack: string[]): string {
  return stack.filter(Boolean).join(' > ');
}

/**
 * 문단 하나를 **상한 안에 드는 토막들**로 나눈다 (DS 74-2).
 *
 * 어디서 끊는가(먼저 되는 쪽부터):
 *  ① 문장 경계 — `lib/prose.splitSentences` 가 가린다(소수 `1.5`·주소 `co.kr`·번호 매김의
 *    점을 문장 끝으로 읽지 않는 그 자다 · DS 66-2). 끊은 자리가 고객이 읽는 답변의 끝이므로
 *    말이 맺히는 자리여야 한다.
 *  ② 한 문장이 상한보다 길면 글자 경계 — `lib/limits.cut`(`cutEnd`)로 끊는다. 이모지·분해형
 *    한글의 **반쪽을 남기지 않는** 자다(DS 62-1). 표시(`…`)는 붙이지 않는다: 버리는 것이
 *    아니라 다음 토막으로 이어지므로, 표시를 붙이면 「여기서 끝났다」는 거짓말이 된다.
 */
function fitParagraph(para: string, maxChars: number): string[] {
  if (para.length <= maxChars) return [para];
  const out: string[] = [];
  let cur = '';
  const flush = () => {
    if (cur) out.push(cur);
    cur = '';
  };
  for (const sentence of splitSentences(para)) {
    let rest = sentence;
    // 한 문장이 상한보다 길면 글자 경계에서 나눈다(한 글자도 쪼개지 않는다).
    while (rest.length > maxChars) {
      flush();
      const head = cut(rest, maxChars);
      // 상한이 한 글자도 담을 수 없을 만큼 좁으면 더 나눌 수 없다 — 그 자리는 그대로 둔다.
      if (!head) break;
      out.push(head);
      rest = rest.slice(head.length).trimStart();
    }
    if (!rest) continue;
    if (cur && cur.length + 1 + rest.length > maxChars) flush();
    cur = cur ? `${cur} ${rest}` : rest;
  }
  flush();
  return out.length ? out : [para];
}

/**
 * 문서를 청크로 나눈다.
 * 1) 마크다운/번호 제목에서 무조건 끊고, 제목 경로를 청크에 붙인다.
 * 2) 제목 사이 본문은 빈 줄(문단) 경계로 모아 maxChars 근처에서 끊는다.
 * 3) minChars 미만 조각은 직전 청크에 흡수한다(문맥 파편화 방지).
 */
export function chunkDocument(raw: string, opts: ChunkOptions = {}): DocChunk[] {
  const maxChars = Math.max(CHUNK_CHARS_MIN, opts.maxChars ?? DEFAULT_CHUNK_CHARS);
  const minChars = Math.max(10, opts.minChars ?? MIN_CHUNK_CHARS);
  // 유니코드 정규화를 **자르기 전에** 한다 — 분해형 한글은 한 글자가 코드 2~3개라,
  // 먼저 자르면 ① 글자 수 상한이 실제보다 일찍 걸리고 ② 자른 자리가 음절 한가운데가 되어
  // 마지막 글자가 자모 조각으로 남는다. 제목 판정(`제1조`)·키워드 추출의 한글 범위도
  // 완성형만 보므로, 이 한 줄이 없으면 아래 전부가 분해형 문서에서 조용히 빈손이 된다(DS 42-3).
  //
  // 정규화가 **덮지 못하는** 쪽은 따로 막는다 (DS 62-1) — 이모지는 NFC 로 합쳐지지 않는
  // 두 칸 글자라, 상한이 그 가운데 떨어지면 마지막 글자가 반쪽으로 남는다. 그 반쪽은 미리보기
  // 첫머리·대표 질문을 타고 지식베이스에 그대로 저장된다.
  const nfc = toNfc(raw);
  const text = nfc.slice(0, cutEnd(nfc, MAX_DOC_CHARS)).replace(/\r\n?/g, '\n');

  const stack: string[] = [];
  const chunks: { heading: string; parts: string[] }[] = [];
  let cur: { heading: string; parts: string[] } | null = null;
  let curLen = 0;

  const flush = () => {
    if (cur && cur.parts.length) chunks.push(cur);
    cur = null;
    curLen = 0;
  };
  /**
   * 문단 하나를 담는다 — **담은 뒤에 넘치는지 보지 않고, 넘칠 것 같으면 먼저 끊는다** (DS 74-2).
   *
   * 종전에는 담고 나서 `curLen >= maxChars` 면 끊었다. 그래서 상한을 **넘은 뒤에야** 끊겼고,
   * 조각 하나가 상한의 두 배 가까이 되는 일이 늘 있었다(문단 400자 + 400자 = 801자 한 조각이
   * 「500자로 나눠 주세요」의 답이었다). 넘지 않게 담는 쪽으로 돌리면 조각마다 상한이 지켜진다 —
   * 문단은 `fitParagraph` 가 이미 상한 안에 들게 나눠 둔다.
   */
  const push = (paragraph: string) => {
    const whole = paragraph.trim();
    if (!whole) return;
    for (const para of fitParagraph(whole, maxChars)) {
      // 줄로 이어 붙일 자리(`parts.join('\n')`)까지 세어 상한을 넘기지 않는다.
      if (cur && curLen + 1 + para.length > maxChars) flush();
      if (!cur) {
        cur = { heading: headingPath(stack), parts: [] };
        curLen = 0;
      }
      cur.parts.push(para);
      curLen += (cur.parts.length > 1 ? 1 : 0) + para.length;
    }
  };

  let buf: string[] = [];
  const flushBuf = () => {
    if (buf.length) push(buf.join(' '));
    buf = [];
  };

  for (const line of text.split('\n')) {
    const h = isHeadingLine(line);
    if (h) {
      flushBuf();
      flush();
      stack.length = Math.max(0, h.level - 1);
      stack[h.level - 1] = h.title;
      continue;
    }
    if (!line.trim()) {
      flushBuf();
      continue;
    }
    // 목록 항목은 **한 문단**이다 (DS 66-1) — 이어 붙이면 번호가 줄바꿈을 잃는다.
    if (LIST_ITEM_RE.test(line.trim())) {
      flushBuf();
      push(line.trim());
      continue;
    }
    buf.push(line.trim());
  }
  flushBuf();
  flush();

  // 짧은 조각 병합 — **합쳐서 상한을 넘으면 합치지 않는다** (DS 74-2).
  // 종전에는 이 자리가 상한을 보지 않아, 꽉 찬 조각 뒤의 한 줄짜리 꼬리가 상한을 넘겼다.
  const merged: { heading: string; text: string }[] = [];
  for (const c of chunks) {
    const body = c.parts.join('\n');
    const prev = merged[merged.length - 1];
    if (prev && body.length < minChars && prev.heading === c.heading && prev.text.length + 1 + body.length <= maxChars) {
      prev.text = `${prev.text}\n${body}`;
    } else {
      merged.push({ heading: c.heading, text: body });
    }
  }

  return merged
    .filter((c) => c.text.trim().length > 0)
    .map((c, i) => ({ index: i + 1, heading: c.heading, text: c.text.trim() }));
}

// ---- 키워드 추출 ----

/** 조사·접미 제거 대상(긴 것부터 시도). 형태소 분석기 없이 쓰는 근사 규칙. */
const PARTICLES = [
  '으로부터', '에서부터', '이라고', '라고', '으로서', '으로써', '에게서', '한테서',
  '까지', '부터', '에서', '에게', '한테', '으로', '이나', '이란', '이라', '보다', '처럼', '만큼',
  '들의', '와의', '과의', '의', '은', '는', '이', '가', '을', '를', '에', '로', '와', '과', '도', '만', '요',
];

const STOPWORDS = new Set([
  '그리고', '그러나', '하지만', '또는', '또한', '경우', '대한', '대해', '위해', '통해', '해당', '관련',
  '있습니다', '없습니다', '합니다', '됩니다', '입니다', '수', '것', '등', '및', '이런', '저런', '그런',
  '때문', '하여', '하며', '한다', '있다', '없다', '한', '두', '세', '내용', '사항', '다음', '아래', '위',
]);

/** 용언 어미 — "운영합니다" → "운영"처럼 검색어로 쓸모없는 꼬리를 떼기 위한 근사 규칙. */
const ENDINGS = [
  '하겠습니다', '되었습니다', '있었습니다', '드리겠습니다', '드립니다', '했습니다', '합니다', '입니다', '습니다',
  '됩니다', '십니다', '하세요', '해주세요', '주세요', '해요', '이다', '한다', '된다', '하는', '되는', '하고', '되고',
];

function stripOnce(token: string, list: string[]): string {
  for (const suffix of list) {
    if (token.length > suffix.length + 1 && token.endsWith(suffix)) return token.slice(0, -suffix.length);
  }
  return token;
}

/** 조사·어미를 더 이상 줄지 않을 때까지(최대 3회) 떼어낸다("결제일로부터" → "결제일"). */
function stripParticles(token: string): string {
  let t = stripOnce(token, ENDINGS);
  for (let i = 0; i < 3; i += 1) {
    const next = stripOnce(t, PARTICLES);
    if (next === t) break;
    t = next;
  }
  return t;
}

/**
 * 문서 청크에서 검색 키워드를 뽑는다(빈도 + 길이 가중).
 * 형태소 분석 없이 조사 제거 + 불용어 필터로 근사한다 — 운영자가 콘솔에서 보정하는 전제.
 *
 * 토큰 경계의 한글 범위(`가-힣`)는 **완성형 음절만** 가리킨다. 분해형(ㅎ+ㅏ+ㄴ)으로 들어온
 * 본문은 모든 한글이 구분자로 읽혀 토큰이 **0개**가 되고, 그러면 `documentToCandidates` 가
 * 모든 청크를 버려 업로드가 「본문이 너무 짧거나 키워드가 없습니다」로 끝난다 — 운영자는
 * 수만 자짜리 한글 문서를 올려 놓고 그 말을 듣는다. 세는 글자를 먼저 맞춘다(DS 42-3).
 */
export function extractKeywords(text: string, limit = 8): string[] {
  const tokens = toNfc(text)
    .toLowerCase()
    .split(/[^0-9a-z가-힣]+/u)
    .map(stripParticles)
    // 낱말 하나가 상한을 넘으면 버린다 (DS 74-2) — 띄어쓰기 없이 붙어 온 긴 덩이(표·코드·
    // 주소에서 온다)는 어떤 질문에도 걸리지 않는 검색어이고, 그 글자가 자료의 검색어 칸을
    // 통째로 먹는다(화면은 그 칸을 「고객이 쓸 표현」이라고 부른다).
    .filter((t) => t.length >= 2 && t.length <= KEYWORD_LEN && !STOPWORDS.has(t));

  const freq = new Map<string, number>();
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);

  return [...freq.entries()]
    .map(([term, n]) => ({ term, weight: n + Math.min(term.length, 6) * 0.3 }))
    // 같은 무게면 이름순 — 줄 세우는 자는 `lib/order` 한 곳이다 (DS 64-2).
    .sort((a, b) => b.weight - a.weight || compareText(a.term, b.term))
    .slice(0, limit)
    .map((x) => x.term);
}

// ---- KB 후보 변환 ----

export interface IngestOptions extends ChunkOptions {
  /** 출처 라벨(문서명). 필수 — 근거 인용에 그대로 노출된다. */
  title: string;
  category?: string;
  /** id 접두사. 비우면 문서명 기반 슬러그. */
  idPrefix?: string;
  keywordLimit?: number;
}

export interface KBCandidate extends KBEntry {
  source: string;
  /** 원본 청크 순번 — 콘솔 미리보기에서 순서 확인용. */
  chunkIndex: number;
}

function slugify(s: string): string {
  const base = compact(s).replace(/[^0-9a-z가-힣]/gu, '').slice(0, 24);
  return base || 'doc';
}

/**
 * 문서 하나가 쓰는 **id 앞자리** — `doc_<문서명 슬러그>` (DS 44-1).
 *
 * 왜 내보내는가: 같은 문서명으로 다시 올리면 후보 id 가 그대로 겹친다(그래서 수정판이
 * 덮어써지는 것은 의도다). 문제는 **줄어든 문서**다 — 지난번 10조각 중 4조각만 남긴 수정판을
 * 올리면 5~10번 조각이 지식베이스에 **그대로 남아** 봇이 두 판본을 섞어 답한다. 그걸 화면이
 * 말해 주려면 「이 문서가 쓰는 자리」를 등록하는 쪽(`adminStore.docOverlap`)도 같은 식으로
 * 계산할 수 있어야 한다. 두 벌로 적으면 어긋나는 날 경고가 조용히 사라진다.
 */
export function docIdPrefix(title: string): string {
  return `doc_${slugify((title || '').trim() || '업로드 문서')}`;
}

/** 청크 첫 문장(또는 제목)을 대표 질문으로 만든다. */
function toQuestion(chunk: DocChunk, title: string): string {
  const head = chunk.heading.split(' > ').pop()?.trim();
  if (head) return `${head}에 대해 알려주세요`;
  const firstLine = chunk.text.split('\n')[0].trim();
  return ellipsize(firstLine, DOC_HEAD_LEN) || `${title} 안내`;
}

/**
 * 키워드를 뽑지 못해 **등록되지 않는 조각** (DS 58-3).
 *
 * 본문은 싣지 않는다 — 운영자가 「어느 대목인가」를 찾는 데 필요한 만큼(제목·순번·길이·첫
 * 글자)만 돌려준다. 이 값은 보관되지 않고 미리보기·등록 응답에만 실린다.
 */
export interface DroppedChunk {
  /** 문서 내 순번 — 미리보기 목록의 `#n` 과 **같은 수**다(빠진 번호가 곧 이 조각이다). */
  index: number;
  /** 그 조각의 제목 경로. 빈 문자열이면 첫 제목보다 앞에 있던 글이다. */
  heading: string;
  /** 본문 길이(자) — 「한 줄짜리인가 한 쪽인가」로 운영자가 급한 정도를 가린다. */
  chars: number;
  /** 본문 첫머리(`DOC_HEAD_LEN` 자 이하, 줄였으면 `…`). 제목이 없는 조각은 이 글자가 유일한 단서다. */
  head: string;
}

/** 문서 하나를 후보로 바꾼 결과 — **버린 것까지 센다** (DS 58-3). */
export interface IngestResult {
  candidates: KBCandidate[];
  /** 문서를 나눈 조각 수(버린 것 포함). */
  chunks: number;
  /** 키워드가 없어 후보에서 빠진 조각. 비어 있으면 빠진 것이 없다. */
  dropped: DroppedChunk[];
}

/**
 * 문서 텍스트 → KB 후보 + **빠진 조각** (DS 58-3).
 *
 * 왜 따로 세는가: 키워드를 하나도 뽑지 못한 조각은 후보에서 걸러진다(검색어가 없으면 그 자료는
 * 어떤 질문에도 걸리지 않으므로 거르는 것 자체는 맞다). 그런데 **걸렀다고 말하는 자리가 없었다** —
 * 화면은 「후보 N개」라고만 적고, 운영자는 올린 문서가 통째로 들어간 줄 알았다. 실제로 빠지는
 * 대목은 숫자·기호·한 글자만 있는 표나 첫 제목 앞의 머리글처럼 **문서 안에서 눈에 잘 띄는
 * 묶음**이고, 그 자리를 물어 온 손님은 영원히 기본 안내를 받는다. 미리보기 목록의 `#n` 에
 * 구멍이 나 있는 것이 유일한 단서였다(그 구멍이 무엇인지는 어디에도 적혀 있지 않았다).
 *
 * 42차가 같은 필터 뒤에서 본 것은 **전부 빠진 경우**였고(DS 42-3 — 분해형 한글), 그때
 * 고친 것은 토큰 경계였다. 이번에 보는 것은 **일부만 빠지는 경우**다 — 그때는 거절 문장조차
 * 뜨지 않는다.
 */
export function ingestDocument(raw: string, opts: IngestOptions): IngestResult {
  const title = (opts.title || '').trim() || '업로드 문서';
  const category = (opts.category || '').trim() || '문서';
  const prefix = (opts.idPrefix || '').trim() || docIdPrefix(title);
  const chunks = chunkDocument(raw, opts);

  const candidates: KBCandidate[] = [];
  const dropped: DroppedChunk[] = [];
  for (const chunk of chunks) {
    const keywords = extractKeywords(`${chunk.heading} ${chunk.text}`, opts.keywordLimit ?? 8);
    if (keywords.length === 0) {
      const flat = chunk.text.replace(/\s+/g, ' ').trim();
      dropped.push({
        index: chunk.index,
        heading: chunk.heading,
        chars: chunk.text.length,
        head: ellipsize(flat, DOC_HEAD_LEN),
      });
      continue;
    }
    candidates.push({
      id: `${prefix}_${String(chunk.index).padStart(3, '0')}`,
      category,
      /**
       * 대표 질문·출처는 **자료 한 건의 칸 상한**을 지킨다 (DS 74-1·74-2).
       * 문서의 제목 한 줄은 길이가 열려 있다(`# …` 는 글쓴이가 적는 대로다) — 그 글자가 그대로
       * 질문·출처가 되면, 손으로 적어 넣는 길에서는 거절되는 길이가 문서로 들어오는 길에서는
       * 통과한다. 줄일 때는 **줄였다고 적는다**(`ellipsize` · DS 62-2·62-3).
       */
      question: ellipsize(toQuestion(chunk, title), KB_QUESTION_LEN),
      keywords,
      answer: chunk.text,
      source: ellipsize(chunk.heading ? `${title} — ${chunk.heading}` : title, KB_SOURCE_LEN),
      chunkIndex: chunk.index,
    });
  }
  return { candidates, chunks: chunks.length, dropped };
}

/**
 * 문서 텍스트 → KB 후보 목록. 등록 전 관리 콘솔에서 미리보기·수정하는 것을 전제로 한다.
 * 「무엇이 빠졌는가」까지 필요한 자리는 `ingestDocument` 를 쓴다 (DS 58-3) — 거르는 규칙은
 * 한 곳이다(두 벌로 적으면 세는 수와 거르는 수가 어긋난다).
 */
export function documentToCandidates(raw: string, opts: IngestOptions): KBCandidate[] {
  return ingestDocument(raw, opts).candidates;
}
