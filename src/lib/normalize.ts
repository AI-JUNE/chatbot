// 한국어 입력 정규화 — 동의어 확장 + 자모(초·중·종성) 분해 기반 오타 허용 매칭.
// 목적: LLM 없이도 "카톡/카카오톡", "삼담원/상담원", "가겨/가격" 같은 표기 흔들림을 흡수한다.
// 순수 함수만 두어 서버·테스트 어디서나 동일하게 동작하게 한다(외부 의존 없음).

// ---- 기본 정규화 ----

/** 소문자화 + 유니코드 NFC + 3회 이상 반복 문자 축약("좋아요오오오" → "좋아요오"). */
export function basicNormalize(s: string): string {
  return (s || '').normalize('NFC').toLowerCase().replace(/(.)\1{2,}/gu, '$1$1');
}

/** 비교용 압축형 — 기본 정규화 후 공백·구두점·기호 제거(띄어쓰기/문장부호 차이 흡수). */
export function compact(s: string): string {
  return basicNormalize(s).replace(/[\s.,!?~·・…"'"'()[\]{}<>:;/\\|@#$%^&*+=_-]/gu, '');
}

// ---- 한글 자모 분해 ----

const CHO = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
const JUNG = ['ㅏ','ㅐ','ㅑ','ㅒ','ㅓ','ㅔ','ㅕ','ㅖ','ㅗ','ㅘ','ㅙ','ㅚ','ㅛ','ㅜ','ㅝ','ㅞ','ㅟ','ㅠ','ㅡ','ㅢ','ㅣ'];
const JONG = ['','ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];

const HANGUL_BASE = 0xac00;
const HANGUL_LAST = 0xd7a3;

/**
 * 완성형 한글을 자모열로 분해한다. 한글이 아닌 문자는 그대로 둔다.
 * 오타는 대개 자모 1개 차이라서, 자모 단위 편집거리가 음절 단위보다 훨씬 잘 잡힌다.
 */
export function decomposeJamo(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= HANGUL_BASE && code <= HANGUL_LAST) {
      const idx = code - HANGUL_BASE;
      out += CHO[Math.floor(idx / 588)] + JUNG[Math.floor((idx % 588) / 28)] + JONG[idx % 28];
    } else {
      out += ch;
    }
  }
  return out;
}

// ---- 근사 부분문자열 매칭(Sellers 알고리즘) ----

const MAX_HAYSTACK_JAMO = 1200; // 성능 상한(약 400자) — 초과분은 잘라서 비교

/**
 * needle이 haystack 안에 최대 maxDist 오차로 등장하는지(부분문자열 근사 매칭).
 * 시작 위치를 자유롭게 두고(dp[0][j]=0) 끝 위치별 최소 편집거리를 본다.
 */
export function approxIncludes(haystack: string, needle: string, maxDist: number): boolean {
  if (!needle) return false;
  if (maxDist <= 0) return haystack.includes(needle);
  const h = haystack.length > MAX_HAYSTACK_JAMO ? haystack.slice(0, MAX_HAYSTACK_JAMO) : haystack;
  const n = needle.length;
  if (n > h.length + maxDist) return false;

  let prev = new Array<number>(h.length + 1).fill(0); // 시작 위치 자유
  const cur = new Array<number>(h.length + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= h.length; j += 1) {
      const cost = needle[i - 1] === h[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > maxDist) return false; // 남은 행에서도 회복 불가
    prev = cur.slice();
  }
  for (let j = 0; j <= h.length; j += 1) if (prev[j] <= maxDist) return true;
  return false;
}

/** 키워드 길이(자모 기준)에 따른 오타 허용치. 짧은 말은 오탐이 커서 0으로 둔다. */
export function toleranceFor(jamoLen: number): number {
  if (jamoLen >= 15) return 2;
  if (jamoLen >= 7) return 1;
  return 0;
}

// ---- 동의어 ----

/**
 * 동의어 그룹. 같은 그룹의 어떤 표기가 들어와도 서로를 대신할 수 있다고 본다.
 * 원문을 치환하지 않고 "키워드를 넓히는" 방식이라 문맥을 훼손하지 않는다.
 * (예: '취소'를 '해지'로 바꿔버리면 '예약 취소'가 왜곡되므로 치환은 쓰지 않는다.)
 */
export const SYNONYM_GROUPS: string[][] = [
  ['카카오', '카카오톡', '카톡', '플러스친구', '플친', '카카오채널', 'kakao'],
  ['상담원', '상담사', '오퍼레이터', '상담직원', '담당자', '사람상담'],
  ['요금', '가격', '비용', '금액', '요금제', '단가', '견적', '얼마'],
  ['해지', '해약', '계약해지', '중도해지'],
  ['환불', '환급', '반환', '리펀드'],
  ['운영시간', '영업시간', '업무시간', '근무시간', '오픈시간', '상담시간'],
  ['개인정보', '프라이버시', '정보보호'],
  ['오류', '에러', '버그', '장애', '먹통', '고장', 'error'],
  ['챗봇', '쳇봇', '채팅봇', 'chatbot', '봇'],
  ['콜봇', '보이스봇', '음성봇', '전화봇', 'ars', '아르에스'],
  ['도입', '신청', '가입', '계약', '온보딩', '개통'],
  ['문의', '질문', '여쭤', '물어보'],
  ['위젯', '스크립트', 'embed', '임베드', '설치코드'],
  ['홈페이지', '웹사이트', '사이트', '누리집'],
  ['예약', '예약접수', '부킹', 'booking'],
  ['배송', '택배', '발송', '출고'],
  ['영수증', '세금계산서', '계산서', '증빙'],
];

const GROUP_OF = new Map<string, number>();
for (let i = 0; i < SYNONYM_GROUPS.length; i += 1) {
  for (const term of SYNONYM_GROUPS[i]) GROUP_OF.set(compact(term), i);
}

/** term과 같은 뜻으로 취급할 표기 목록(자기 자신 포함, 압축형). */
export function variantsOf(term: string): string[] {
  const key = compact(term);
  if (!key) return [];
  const gi = GROUP_OF.get(key);
  if (gi === undefined) return [key];
  const set = new Set<string>([key]);
  for (const t of SYNONYM_GROUPS[gi]) set.add(compact(t));
  return [...set];
}

// ---- 키워드 매칭 ----

export type MatchKind = 'exact' | 'synonym' | 'fuzzy' | 'none';

export interface KeywordHit {
  kind: MatchKind;
  /** 실제로 일치한 표기(압축형). 근거 표시·디버깅용. */
  term: string;
}

const NONE: KeywordHit = { kind: 'none', term: '' };

/**
 * 키워드가 문장에 나타나는지 판정한다. 정확 일치 → 동의어 일치 → 자모 오타 허용 순으로 완화한다.
 * @param textCompact compact()로 압축한 사용자 문장
 * @param textJamo    decomposeJamo(textCompact) 결과(호출자가 캐시해 재사용)
 */
export function keywordHit(textCompact: string, textJamo: string, keyword: string, allowFuzzy = true): KeywordHit {
  const key = compact(keyword);
  if (!key) return NONE;
  if (textCompact.includes(key)) return { kind: 'exact', term: key };

  const variants = variantsOf(keyword);
  for (const v of variants) {
    if (v !== key && textCompact.includes(v)) return { kind: 'synonym', term: v };
  }
  if (!allowFuzzy) return NONE;

  for (const v of variants) {
    const jamo = decomposeJamo(v);
    const tol = toleranceFor(jamo.length);
    if (tol > 0 && approxIncludes(textJamo, jamo, tol)) return { kind: 'fuzzy', term: v };
  }
  return NONE;
}

/** 매칭 종류별 가중치 — 정확 일치를 가장 높게 두어 오타 보정이 정답을 밀어내지 않게 한다. */
export const MATCH_WEIGHT: Record<MatchKind, number> = { exact: 1, synonym: 0.8, fuzzy: 0.5, none: 0 };

/** 문장을 매칭 준비 형태로 한 번만 변환한다(반복 호출 비용 절감). */
export interface PreparedText {
  raw: string;
  compact: string;
  jamo: string;
}

export function prepare(text: string): PreparedText {
  const c = compact(text);
  return { raw: basicNormalize(text), compact: c, jamo: decomposeJamo(c) };
}
