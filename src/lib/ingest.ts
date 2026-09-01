// 지식 문서 인제스트 — 텍스트/마크다운 문서를 청크로 나눠 KB 후보로 변환한다.
// 벡터 검색·임베딩 없이(비용·의존성 0) 제목 계층 + 문단 경계로 자르고 키워드를 뽑는 방식.
// [승인 필요] 임베딩 기반 시맨틱 검색·외부 스토리지 업로드 — 전까지 서버 메모리·관리 콘솔 등록만.
import type { KBEntry } from '@/lib/knowledge';
import { compact } from '@/lib/normalize';

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
  const text = (raw || '').slice(0, MAX_DOC_CHARS).replace(/\r\n?/g, '\n');

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
 */
export function extractKeywords(text: string, limit = 8): string[] {
  const tokens = (text || '')
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

/** 청크 첫 문장(또는 제목)을 대표 질문으로 만든다. */
function toQuestion(chunk: DocChunk, title: string): string {
  const head = chunk.heading.split(' > ').pop()?.trim();
  if (head) return `${head}에 대해 알려주세요`;
  const firstLine = chunk.text.split('\n')[0].trim();
  const short = firstLine.length > 40 ? `${firstLine.slice(0, 39)}…` : firstLine;
  return short || `${title} 안내`;
}

/** 문서 텍스트 → KB 후보 목록. 등록 전 관리 콘솔에서 미리보기·수정하는 것을 전제로 한다. */
export function documentToCandidates(raw: string, opts: IngestOptions): KBCandidate[] {
  const title = (opts.title || '').trim() || '업로드 문서';
  const category = (opts.category || '').trim() || '문서';
  const prefix = (opts.idPrefix || '').trim() || `doc_${slugify(title)}`;
  const chunks = chunkDocument(raw, opts);

  return chunks.map((chunk) => {
    const keywords = extractKeywords(`${chunk.heading} ${chunk.text}`, opts.keywordLimit ?? 8);
    return {
      id: `${prefix}_${String(chunk.index).padStart(3, '0')}`,
      category,
      question: toQuestion(chunk, title),
      keywords,
      answer: chunk.text,
      source: chunk.heading ? `${title} — ${chunk.heading}` : title,
      chunkIndex: chunk.index,
    };
  }).filter((c) => c.keywords.length > 0);
}
