// 지식 문서 인제스트 — 텍스트/마크다운 문서를 청크로 나눠 KB 후보로 변환한다.
// 벡터 검색·임베딩 없이(비용·의존성 0) 제목 계층 + 문단 경계로 자르고 키워드를 뽑는 방식.
// [승인 필요] 임베딩 기반 시맨틱 검색·외부 스토리지 업로드 — 전까지 서버 메모리·관리 콘솔 등록만.
import type { KBEntry } from '@/lib/knowledge';
import { compact, toNfc } from '@/lib/normalize';

export const MAX_DOC_CHARS = 100_000;
export const DEFAULT_CHUNK_CHARS = 500;
export const MIN_CHUNK_CHARS = 40;

export interface DocChunk {
  /** 문서 내 순번(1부터) */
  index: number;
  /** 이 청크가 속한 제목 경로(예: "요금 안내 > 할인"). 제목이 없으면 빈 문자열. */
  heading: string;
  text: string;
}

export interface ChunkOptions {
  /** 청크 목표 길이(문자). 문단 경계를 우선하므로 초과할 수 있다. */
  maxChars?: number;
  /** 이보다 짧은 청크는 앞 청크에 합친다. */
  minChars?: number;
}

const HEADING_RE = /^(#{1,6})\s+(.*\S)\s*$/;
/** "1. 제목", "1.2 제목", "제1조 (목적)" 형태의 번호 제목 */
const NUMBERED_HEADING_RE = /^(?:제?\s?\d+(?:[.\-]\d+)*\s?(?:조|장|절)?[.)]?)\s+\S.{0,60}$/;

function isHeadingLine(line: string): { level: number; title: string } | null {
  const md = line.match(HEADING_RE);
  if (md) return { level: md[1].length, title: md[2].trim() };
  const t = line.trim();
  if (t && t.length <= 70 && NUMBERED_HEADING_RE.test(t)) return { level: 2, title: t };
  return null;
}

function headingPath(stack: string[]): string {
  return stack.filter(Boolean).join(' > ');
}

/**
 * 문서를 청크로 나눈다.
 * 1) 마크다운/번호 제목에서 무조건 끊고, 제목 경로를 청크에 붙인다.
 * 2) 제목 사이 본문은 빈 줄(문단) 경계로 모아 maxChars 근처에서 끊는다.
 * 3) minChars 미만 조각은 직전 청크에 흡수한다(문맥 파편화 방지).
 */
export function chunkDocument(raw: string, opts: ChunkOptions = {}): DocChunk[] {
  const maxChars = Math.max(120, opts.maxChars ?? DEFAULT_CHUNK_CHARS);
  const minChars = Math.max(10, opts.minChars ?? MIN_CHUNK_CHARS);
  // 유니코드 정규화를 **자르기 전에** 한다 — 분해형 한글은 한 글자가 코드 2~3개라,
  // 먼저 자르면 ① 글자 수 상한이 실제보다 일찍 걸리고 ② 자른 자리가 음절 한가운데가 되어
  // 마지막 글자가 자모 조각으로 남는다. 제목 판정(`제1조`)·키워드 추출의 한글 범위도
  // 완성형만 보므로, 이 한 줄이 없으면 아래 전부가 분해형 문서에서 조용히 빈손이 된다(DS 42-3).
  const text = toNfc(raw).slice(0, MAX_DOC_CHARS).replace(/\r\n?/g, '\n');

  const stack: string[] = [];
  const chunks: { heading: string; parts: string[] }[] = [];
  let cur: { heading: string; parts: string[] } | null = null;
  let curLen = 0;

  const flush = () => {
    if (cur && cur.parts.length) chunks.push(cur);
    cur = null;
    curLen = 0;
  };
  const push = (paragraph: string) => {
    const para = paragraph.trim();
    if (!para) return;
    if (!cur) {
      cur = { heading: headingPath(stack), parts: [] };
      curLen = 0;
    }
    cur.parts.push(para);
    curLen += para.length;
    if (curLen >= maxChars) flush();
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
    buf.push(line.trim());
  }
  flushBuf();
  flush();

  // 짧은 조각 병합
  const merged: { heading: string; text: string }[] = [];
  for (const c of chunks) {
    const body = c.parts.join('\n');
    const prev = merged[merged.length - 1];
    if (prev && body.length < minChars && prev.heading === c.heading) {
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
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));

  const freq = new Map<string, number>();
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);

  return [...freq.entries()]
    .map(([term, n]) => ({ term, weight: n + Math.min(term.length, 6) * 0.3 }))
    .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))
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
  const short = firstLine.length > 40 ? `${firstLine.slice(0, 39)}…` : firstLine;
  return short || `${title} 안내`;
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
  /** 본문 첫머리(40자). 제목이 없는 조각은 이 글자가 유일한 단서다. */
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
        head: flat.length > 40 ? `${flat.slice(0, 40)}…` : flat,
      });
      continue;
    }
    candidates.push({
      id: `${prefix}_${String(chunk.index).padStart(3, '0')}`,
      category,
      question: toQuestion(chunk, title),
      keywords,
      answer: chunk.text,
      source: chunk.heading ? `${title} — ${chunk.heading}` : title,
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
