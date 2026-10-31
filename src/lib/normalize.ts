// 한국어 입력 정규화 — 동의어 확장 + 자모(초·중·종성) 분해 기반 오타 허용 매칭.
// 목적: LLM 없이도 "카톡/카카오톡", "삼담원/상담원", "가겨/가격" 같은 표기 흔들림을 흡수한다.
// 순수 함수만 두어 서버·테스트 어디서나 동일하게 동작하게 한다(보이지 않는 글자를 지우는 자
// `lib/text` 외에는 의존하지 않는다).
import { stripForMatch } from '@/lib/text';

// ---- 기본 정규화 ----

/**
 * **유니코드 정규화만** 한다(대소문자·공백·문장부호는 그대로 둔다).
 *
 * 한글은 같은 글자를 두 가지 코드로 적을 수 있다 — 완성형 「한」(U+D55C, 1자)과
 * 자모 분해형 「ㅎ+ㅏ+ㄴ」(U+1112 U+1161 U+11AB, 3자)이다. 화면에는 똑같이 보이지만
 * 문자열 비교·정규식에는 **다른 글자**다. 분해형은 macOS 파일명·PDF 에서 긁어온 본문·
 * 일부 업무 시스템 내보내기에 흔하다 — 운영자가 붙여 넣는 글의 상당수가 그 경로로 온다.
 *
 * 그래서 이 저장소에서 **보관하는 값에 유니코드 정규화를 적는 자리는 여기 한 곳**이다
 * (문서 업로드·KB 가져오기). 「같은 말인가」를 묻는 쪽은 한 걸음 더 간다 — `toMatchForm`
 * 이 호환 문자까지 모은다(DS 64-1). 바꾸는 것은 **비교**뿐이고, 저장되는 글자는 NFC 그대로다.
 */
export function toNfc(s: string): string {
  return (s || '').normalize('NFC');
}

/**
 * **비교용 정규화 — NFKC** (DS 64-1). 보관하는 값은 건드리지 않는다(`toNfc` 가 그쪽이다).
 *
 * NFC 는 「같은 글자의 다른 코드」만 합친다. 한국 업무 문서가 실어 오는 것은 그 바깥쪽 —
 * **호환 문자**다: `㈜`(U+321C 한 글자)와 `(주)`(세 글자), 전각 `Ａ／Ｓ`·`？`·`：`·`～`,
 * 로마 숫자 `Ⅰ`, 단위 기호 `㎡`, 반각 가타카나. 한글(HWP)·PDF·사내 시스템 내보내기에서
 * 붙여 넣은 자료에 그대로 들어오고, 모바일 키보드의 「한자」 변환으로 고객 쪽에서도 온다.
 * 눈에는 같은 글자인데 비교에서는 다른 말이라, 운영자가 `㈜고원` 으로 적어 둔 자료는
 * `(주)고원` 으로 친 검색에 걸리지 않는다(DS 63-2 가 제로폭 공백에서 닫은 자리의 옆칸이다).
 *
 * **한글 호환 자모(U+3130~U+318F)는 지나간다.** NFKC 는 `ㄱ`(U+3131)을 조합용 초성
 * `ᄀ`(U+1100)으로 바꾼다 — 그러면 자모 오타 보정(`decomposeJamo`)이 쓰는 글자표와
 * 갈라져, 같은 `ㄱ` 이 두 가지 코드로 돌아다니게 된다. 그 구간만 건너뛰고 나머지 토막에만
 * NFKC 를 건다(호환 자모가 없는 글에서는 `s.normalize('NFKC')` 와 글자까지 같다).
 */
const NOT_COMPAT_JAMO = /[^\u{3130}-\u{318f}]+/gu;
export function toMatchForm(s: string): string {
  return (s || '').replace(NOT_COMPAT_JAMO, (run) => run.normalize('NFKC'));
}

/**
 * 늘여 쓴 말을 줄이는 자 — 「ㅋㅋㅋㅋ」·「아아아」·「~~~」는 같은 말이다.
 *
 * **숫자는 빼 둔다** (DS 64-3). 늘여 쓴 말과 달리 숫자는 **값**이다. 종전 식(`(.)\1{2,}`)은
 * 「1000원」을 「100원」으로 줄여, 두 금액이 비교에서 **같은 말**이 됐다 — 「100원짜리 있나요」가
 * 1,000원 요금제 자료에 **정확 일치**로 걸리고(`keywordHit` 이 `exact` 를 돌려준다),
 * 「답하지 못한 질문」 묶음이 서로 다른 금액의 질문을 한 줄로 셌다.
 */
const STRETCHED = /([^0-9])\1{2,}/gu;

/**
 * 소문자화 + 비교용 정규화(NFKC) + **보이지 않는 글자 제거** + 늘여 쓴 글자 축약.
 *
 * 보이지 않는 글자를 여기서 지우는 까닭 (DS 63-2): 「같은 말인가」를 묻는 자리는 전부 이 함수를
 * 지난다. 제로폭 공백 하나가 섞인 「환불​정책」은 눈에 「환불정책」과 똑같이 보이는데 비교에서는
 * 다른 말이 되어, 운영자가 PDF 에서 붙여 넣은 자료를 **검색으로 찾을 수 없고** 묶음 열쇠
 * (`convlog.questionKey`)가 같은 질문을 두 줄로 센다. 정규화는 같은 글자의 다른 표기를 합칠 뿐,
 * 글자가 아닌 것을 지우지는 않는다.
 *
 * 지우는 것을 **먼저** 한다 (DS 64-1): 분해형 한글 사이에 제로폭 공백이 끼면 정규화가
 * 합치지 못한다 — 턴 뒤에 합쳐야 한 글자가 된다.
 */
export function basicNormalize(s: string): string {
  return toMatchForm(stripForMatch(s)).toLowerCase().replace(STRETCHED, '$1$1');
}

/**
 * 비교용 압축형 — 기본 정규화 후 공백·구두점·기호 제거(띄어쓰기/문장부호 차이 흡수).
 *
 * **「같은 말인가」를 묻는 자리의 단일 기준**이다. 엔진(키워드 매칭)뿐 아니라
 * 묶음 열쇠(`convlog.questionKey`)·목록 검색(`partners.queryAccounts`)도 이 자를 쓴다 —
 * 자리마다 자기 규칙을 적으면 「엔진은 같은 질문으로 답했는데 목록은 다른 질문으로 센다」가 된다.
 * 관리 콘솔은 클라이언트 번들이라 lib 을 불러오지 않으므로 사본을 두고(`searchNorm`),
 * 테스트가 **두 자의 결과를 같은 입력으로 대조**해 갈라지면 실패시킨다(DS 42-1).
 *
 * 문장부호 표는 **한국어 문서가 쓰는 쪽까지** 적는다 (DS 64-1). 종전에는 아스키 반쪽만
 * 적어 두어 `「환불 정책」`·`요금。`·`요금ㆍ환불` 이 부호를 단 채로 남았다 — 같은 말을
 * 괄호 하나 때문에 못 찾는다. 전각 `（）？：／～` 는 앞 단계(NFKC)가 아스키로 모아 주므로
 * 여기 적지 않는다; 아스키 짝이 없는 것(`。、「」『』〈〉《》【】〔〕ㆍ`·각종 이음표)만 적는다.
 */
export function compact(s: string): string {
  return basicNormalize(s).replace(/[\s.,!?~·・…"'"'()[\]{}<>:;/\\|@#$%^&*+=。、〈〉《》「」『』【】〔〕ㆍ‐‑‒–—―−※_-]/gu, '');
}

/**
 * 두 표현이 질의의 **같은 자리**를 가리키는가 — 한쪽이 다른 쪽에 들어 있으면 같은 글자다.
 *
 * 「같은 말인가」를 묻는 자리는 이 파일 한 곳이다(위의 `compact` 주석과 같은 까닭). 종전에는
 * 이 판정이 `knowledge.ts` 안에만 있어, **같은 겹침을 다른 곳에서 또 재야 할 때** 가져다 쓸
 * 수 없었다 (DS 78-1) — 문서 등록이 뽑아 주는 검색어에도 `환불`·`환불금` 처럼 한쪽이 다른
 * 쪽에 든 쌍이 섞이는데, 점수 쪽(DS 77-3)은 그 겹침을 한 번만 세고 뽑는 쪽은 그대로 두 칸을
 * 썼다. 두 쪽이 같은 자를 지나야 「겹친다」의 뜻이 한 가지로 남는다.
 */
export function overlapsTerm(a: string, b: string): boolean {
  const x = compact(a);
  const y = compact(b);
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
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
 * **숫자가 든 말은 오타 보정에서 뺀다** (DS 64-3).
 *
 * 자모 편집거리는 「ㄱ↔ㅋ」·「삼담원↔상담원」 같은 **손가락 실수**를 잡으려는 자다. 숫자는
 * 한 자만 달라도 **다른 값**이다 — 「1000원」(자모 7)과 「100원」은 편집거리 1, 「24시간」과
 * 「2시간」도 1 이라서 허용치 안에 들어온다. 그래서 1,000원 요금제 자료가 「100원짜리
 * 있나요」에 걸리고, 「24시간 상담」 자료가 「2시간」을 물은 고객에게 나갔다.
 * 정확 일치·동의어 일치는 그대로다 — 좁히는 것은 **보정**뿐이다.
 */
const HAS_DIGIT = /[0-9]/u;
const DIGIT = /[0-9]/u;

/**
 * 표현이 문장 안에 **그 수 그대로** 나타나는가 (DS 78-4).
 *
 * 64차는 숫자가 「값」임을 두 자리에서 지켰다 — 늘여 쓴 말 줄이기에서 숫자를 뺐고(「1000원」이
 * 「100원」으로 줄지 않게), 자모 오타 보정에서 숫자가 든 말을 뺐다(「24시간」과 「2시간」이
 * 편집거리 1 이라서). **정작 가장 흔한 길인 부분 일치(`includes`)는 그대로 두었다.** 그래서
 * 수의 꼬리·머리가 더 큰 수 안에서 그대로 걸렸다(돌려서 받아 냈다):
 *
 *     「3일」 자료  ← 「13일에 환불 신청했는데요」   「23일에 신청」
 *     「1월」 자료  ← 「11월 휴무 알려주세요」
 *     「100원」자료 ← 「1100원 결제했어요」
 *
 * 세 줄 모두 **정확 일치**로 걸려 확신 답변이 나갔다 — 64차가 막은 「다른 금액이 오타로 보이는
 * 것」과 같은 거짓이고, 날짜·금액·기간은 문서 등록이 가장 많이 뽑아 주는 표현이다(`3일`·`14일`·
 * `100원` 은 꾸민 값이 아니라 `ingest.extractKeywords` 가 실제로 돌려주는 검색어다).
 *
 * 그래서 **수가 표현의 머리·꼬리에 있을 때만** 그 자리가 수의 가운데가 아닌지 본다. 가운데 든
 * 숫자(`a1b`)는 어차피 양끝이 글자라 더 큰 수에 섞이지 않으므로 묻지 않는다 — 좁히는 것은
 * 수의 경계뿐이고, 글자만으로 된 표현은 종전 그대로 부분 일치다.
 */
export function includesTerm(textCompact: string, term: string): boolean {
  if (!term) return false;
  if (!HAS_DIGIT.test(term)) return textCompact.includes(term);
  const headDigit = DIGIT.test(term[0]);
  const tailDigit = DIGIT.test(term[term.length - 1]);
  for (let from = 0; ; from += 1) {
    const at = textCompact.indexOf(term, from);
    if (at < 0) return false;
    const before = at > 0 ? textCompact[at - 1] : '';
    const after = textCompact[at + term.length] ?? '';
    if ((!headDigit || !DIGIT.test(before)) && (!tailDigit || !DIGIT.test(after))) return true;
    from = at;
  }
}

/**
 * 키워드가 문장에 나타나는지 판정한다. 정확 일치 → 동의어 일치 → 자모 오타 허용 순으로 완화한다.
 * @param textCompact compact()로 압축한 사용자 문장
 * @param textJamo    decomposeJamo(textCompact) 결과(호출자가 캐시해 재사용)
 */
export function keywordHit(textCompact: string, textJamo: string, keyword: string, allowFuzzy = true): KeywordHit {
  const key = compact(keyword);
  if (!key) return NONE;
  if (includesTerm(textCompact, key)) return { kind: 'exact', term: key };

  const variants = variantsOf(keyword);
  for (const v of variants) {
    if (v !== key && includesTerm(textCompact, v)) return { kind: 'synonym', term: v };
  }
  if (!allowFuzzy || HAS_DIGIT.test(key)) return NONE;

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
