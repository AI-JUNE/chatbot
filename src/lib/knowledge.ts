// 지식베이스(FAQ). 키워드 스코어링 매칭 — LLM 없이 동작(폴백 전 단계).
// 추후 관리 콘솔에서 편집 가능하도록 순수 데이터 + 순수 함수로 유지.
// 매칭은 src/lib/normalize 의 동의어 확장·자모 오타 보정을 거친다(정확 일치 가중치가 가장 높다).
import { ellipsize } from '@/lib/limits';
import { MATCH_WEIGHT, compact, keywordHit, prepare, type PreparedText, type MatchKind } from '@/lib/normalize';
import { splitSentences } from '@/lib/prose';

export interface KBEntry {
  id: string;
  category: string;
  question: string;
  keywords: string[]; // 소문자 키워드(부분 일치)
  answer: string;
  /** 출처 표시용(문서 업로드로 생성된 항목 등). 없으면 대표 질문을 출처로 쓴다. */
  source?: string;
}

export const KB: KBEntry[] = [
  {
    id: 'service_intro',
    category: '서비스',
    question: '어떤 서비스인가요?',
    keywords: ['어떤 서비스', '뭐하는', '뭐 하는', '무슨 서비스', '소개', '챗봇이 뭐'],
    answer:
      '고원은 무인 콜센터 솔루션이에요. 웹 챗봇·카카오 채널·전화 콜봇이 24시간 1차 응대를 하고, 복잡한 문의만 상담원에게 연결합니다.',
  },
  {
    id: 'onboarding',
    category: '도입',
    question: '도입 절차와 기간은 어떻게 되나요?',
    keywords: ['도입', '절차', '기간', '얼마나 걸', '시작하려면', '신청'],
    answer:
      '도입은 상담 → 시나리오 설계 → 시험 운영 → 오픈 순서로 진행되며, 기본 시나리오 기준 1~2주면 시작할 수 있어요.',
  },
  {
    id: 'channels',
    category: '채널',
    question: '어떤 채널을 지원하나요?',
    keywords: ['채널', '웹사이트', '홈페이지에', '멀티채널', '어디서 쓸'],
    answer:
      '웹사이트 챗 위젯, 카카오톡 채널, 전화(콜봇)를 지원해요. 하나의 시나리오·지식베이스로 모든 채널에 동일하게 응대합니다.',
  },
  {
    id: 'kakao',
    category: '채널',
    question: '카카오톡 연동이 되나요?',
    keywords: ['카카오', '카톡', '플러스친구', '채널톡'],
    answer:
      '네, 카카오톡 채널과 연동해 같은 챗봇이 카톡에서도 응대하도록 준비 중이에요. 자세한 일정은 상담원을 통해 안내드릴게요.',
  },
  {
    id: 'callbot',
    category: '채널',
    question: '전화(콜봇)도 되나요?',
    keywords: ['콜봇', '전화', '음성', 'ars', '통화'],
    answer:
      '네, 전화 문의는 콜봇이 음성으로 응대해요. 챗봇과 같은 지식베이스를 사용해 채널이 달라도 답변이 일관됩니다.',
  },
  {
    id: 'escalation',
    category: '상담',
    question: '상담원 연결은 어떻게 되나요?',
    keywords: ['상담원 연결', '사람이랑', '직원이랑', '에스컬레이션'],
    answer:
      '챗봇이 해결하지 못하는 문의는 상담원 연결을 제안해요. 운영시간(평일 09:00~18:00)에는 즉시 연결, 그 외에는 접수 후 순차 회신됩니다.',
  },
  {
    id: 'security',
    category: '보안',
    question: '대화 내용과 개인정보는 안전한가요?',
    keywords: ['보안', '개인정보', '안전', '데이터', '유출'],
    answer:
      '대화 데이터는 암호화되어 저장되며, 개인정보는 최소한으로 수집하고 보관 기간이 지나면 파기합니다.',
  },
  {
    id: 'trial',
    category: '요금',
    question: '무료 체험이 있나요?',
    keywords: ['체험', '데모', '무료', '테스트해', '써볼'],
    answer:
      '네, 지금 이 챗봇이 데모예요. 자사 시나리오로 시험 운영을 원하시면 "상담원"이라고 입력해 도입 상담을 신청해 주세요.',
  },
  {
    id: 'billing',
    category: '요금',
    question: '결제는 어떻게 하나요?',
    keywords: ['결제', '청구', '카드', '세금계산서', '인보이스'],
    answer:
      '월 단위 후불 청구이며 카드·계좌이체, 세금계산서 발행을 지원해요. 자세한 조건은 견적과 함께 안내드립니다.',
  },
  {
    id: 'cancel',
    category: '요금',
    question: '해지나 환불은 어떻게 하나요?',
    keywords: ['해지', '환불', '취소', '탈퇴'],
    answer:
      '해지는 언제든 가능하며 약정 위약금은 없어요. 이용 기간 외 선결제분은 규정에 따라 환불됩니다. 상담원 연결로 바로 처리해 드릴게요.',
  },
  {
    id: 'support',
    category: '지원',
    question: '장애나 기술 문의는 어디로 하나요?',
    keywords: ['장애', '오류', '안돼요', '안 돼요', '기술지원', '먹통'],
    answer:
      '불편을 드려 죄송해요. 발생 화면과 시각을 알려주시면 기술팀이 확인합니다. 급한 장애는 상담원 연결을 이용해 주세요.',
  },
  {
    id: 'custom',
    category: '도입',
    question: '우리 회사 업무에 맞게 바꿀 수 있나요?',
    keywords: ['커스터마이징', '맞춤', '시나리오', '우리 회사', '업종'],
    answer:
      '네, 업종별 시나리오와 FAQ를 함께 설계해 드려요. 기존 상담 이력이 있으면 지식베이스로 변환해 초기 품질을 높일 수 있습니다.',
  },
];

export interface KBMatch {
  entry: KBEntry;
  score: number;
  /** 매칭에 기여한 키워드와 매칭 종류(근거 표시·품질 분석용). 운영자가 적은 차례 그대로. */
  matched: { keyword: string; kind: MatchKind }[];
  /**
   * 질의에서 **실제로 설명한 글자 수** (DS 77-1) — 점수가 같을 때 무엇이 답할지 가리는 자다.
   * 겹치는 키워드를 거른 뒤의 값이라 「같은 글자를 여러 번 센 수」가 아니다(DS 77-3).
   */
  coverage: number;
}

/**
 * 키워드 1건의 기여 점수. 2자 이상은 2점, 1자는 1점을 매칭 종류 가중치로 감산한다.
 *
 * 길이는 **매칭이 보는 글자 수**로 잰다(`compact`) — 여기에 자기 정규화를 따로 적어 두면
 * 분해형 한글 「환불」(코드 6개)이 긴 키워드로 둔갑해 점수 기준이 매칭과 어긋난다(DS 42-1).
 */
function keywordScore(keyword: string, kind: MatchKind): number {
  const base = compact(keyword).length >= 2 ? 2 : 1;
  return base * MATCH_WEIGHT[kind];
}

interface Hit {
  keyword: string;
  kind: MatchKind;
  /** 실제로 걸린 표기(압축형) — 겹침은 **키워드가 아니라 이 글자**로 잰다. */
  term: string;
  points: number;
  /** 운영자가 적은 차례 — 화면에 돌려줄 때 이 순서를 지킨다. */
  order: number;
  /** 대표 질문이 걸린 것인가 — 근거 라벨로 돌려주지 않는다(키워드가 아니다). */
  fromQuestion?: boolean;
}

/** 두 표기가 질의의 **같은 자리**를 가리키는가 — 한쪽이 다른 쪽에 들어 있으면 같은 글자다. */
function overlaps(a: string, b: string): boolean {
  return a.includes(b) || b.includes(a);
}

/**
 * 겹치는 키워드는 **한 번만 센다** (DS 77-3).
 *
 * 콘솔의 키워드 칸은 쉼표로 구분한 자유 글이고 문서 등록(`lib/ingest`)은 제목·소제목에서
 * 표현을 자동으로 만든다 — 그래서 `환불, 환불 규정, 규정` 처럼 **같은 글자를 품은 표현**이
 * 흔하다. 종전에는 그 셋이 모두 더해져 「환불 규정」 질의 하나에 6점이 나왔고, 같은 질문에
 * 똑같이 들어맞는 다른 자료(2점)를 세 배로 눌렀다 — 표현을 많이 적은 자료가 이기는 셈이라
 * 점수가 「얼마나 들어맞는가」가 아니라 「운영자가 몇 번 적었는가」를 재고 있었다.
 *
 * 겹치는 것끼리는 **기여가 가장 큰 하나**만 센다(길이가 아니라 기여로 고르는 까닭: 정확 일치가
 * 오타 보정에 밀리면 `MATCH_WEIGHT` 가 세운 선이 무너진다 — 「환불」 정확 일치 2점이
 * 「환불 규정」 오타 보정 1점에 자리를 내주면 확신도까지 함께 떨어진다).
 */
function pickHits(hits: Hit[]): Hit[] {
  const ranked = [...hits].sort(
    (a, b) => b.points - a.points || b.term.length - a.term.length || a.order - b.order,
  );
  const kept: Hit[] = [];
  for (const h of ranked) {
    if (kept.some((k) => overlaps(k.term, h.term))) continue;
    kept.push(h);
  }
  return kept.sort((a, b) => a.order - b.order);
}

/**
 * 대표 질문이 질의와 겹치는 자리를 **표현 하나로** 본다 (DS 77-2).
 *
 * 종전에는 이것이 점수 밖의 가산 2점이었다(`q.includes(질의) || 질의.includes(q)` → `+2`).
 * 그래서 ① 대표 질문이 「정산」처럼 짧으면 그 글자를 품은 **아무 질의에나** 2점이 붙고,
 * ② 그 자료가 같은 글자를 키워드로도 적어 두었으면 **같은 글자를 두 번** 받았다. 둘이 겹쳐,
 * 「위약금 정산 어떻게 되나요」를 물으면 실제로 답하는 자료(「위약금 정산 기준」)가 2번으로
 * 밀렸다 — 고객이 번호로 고르는 줄의 1번이 가장 엉뚱한 자료였다.
 *
 * 이제는 **겹친 글자가 곧 표현**이고, 키워드와 같은 저울(`keywordScore`)·같은 겹침 거르기
 * (`pickHits`)를 지난다. 「환불되나요」 ↔ 「환불 되나요?」처럼 표기만 다른 자리는 그대로
 * 지켜진다(DS 42-1) — 그때 겹친 글자는 질문 전체이므로 가장 무거운 표현이 된다.
 */
function questionHit(questionCompact: string, queryCompact: string, order: number): Hit | null {
  if (!questionCompact || !queryCompact) return null;
  const short = questionCompact.length <= queryCompact.length ? questionCompact : queryCompact;
  const long = short === questionCompact ? queryCompact : questionCompact;
  if (!long.includes(short)) return null;
  return {
    keyword: short,
    kind: 'exact',
    term: short,
    points: keywordScore(short, 'exact'),
    order,
    fromQuestion: true,
  };
}

/**
 * 항목 1건을 준비된 질의에 대해 채점한다.
 * @param withQuestion 대표 질문의 겹침까지 표현으로 볼 것인가(연관 질문 목록 쪽 · DS 77-2)
 */
function scoreEntry(pre: PreparedText, entry: KBEntry, allowFuzzy: boolean, withQuestion = false): KBMatch {
  const hits: Hit[] = [];
  entry.keywords.forEach((kw, order) => {
    if (!kw) return;
    const hit = keywordHit(pre.compact, pre.jamo, kw, allowFuzzy);
    if (hit.kind === 'none') return;
    hits.push({ keyword: kw, kind: hit.kind, term: hit.term, points: keywordScore(kw, hit.kind), order });
  });
  if (withQuestion) {
    const qh = questionHit(compact(entry.question), pre.compact, entry.keywords.length);
    if (qh) hits.push(qh);
  }
  const kept = pickHits(hits);
  return {
    entry,
    score: kept.reduce((acc, h) => acc + h.points, 0),
    matched: kept.filter((h) => !h.fromQuestion).map((h) => ({ keyword: h.keyword, kind: h.kind })),
    coverage: kept.reduce((acc, h) => acc + h.term.length, 0),
  };
}

/**
 * **무엇이 답하는가**를 가리는 자 — 한 벌이다 (DS 77-1·77-2).
 *
 * 종전에는 두 벌이었다. 확신 매칭(`matchKnowledge`)은 `score > best.score` 라 **동점이면
 * 먼저 등록한 자료**가 답했고(코드 기본값 12건이 목록 앞에 있으니, 운영자가 더 또렷한 자료를
 * 새로 넣어도 옛 자료가 계속 답한다), 연관 질문(`searchKnowledge`)은 **키워드 길이를 보지
 * 않는 다른 점수**로 줄을 세웠다 — 고객이 번호로 고르는 목록의 차례와 실제로 답하는 자료가
 * 서로 다른 자로 정해졌다.
 *
 * 동점을 가리는 차례
 *  1) 점수 — 정확 일치·동의어·오타 보정의 가중치가 들어간 수
 *  2) **질의를 더 많이 설명한 쪽**(`coverage`) — 「요금」 한 마디로 걸린 자료보다
 *     「환불 수수료」로 걸린 자료가 그 질문을 더 많이 설명한다
 *  3) 걸린 표현이 더 많은 쪽
 *  4) **나중에 등록한 쪽** — 여기까지 같으면 가릴 근거가 없다. 운영자가 자료를 새로 넣는
 *     까닭은 대개 「지금 나가는 답이 아쉬워서」이므로, 근거가 없을 때는 새로 적은 쪽을 따른다
 *     (어느 쪽이든 **순서가 아니라 규칙**으로 정해져, 목록 차례가 바뀌어도 답이 흔들리지 않는다).
 */
function better(a: KBMatch & { index: number }, b: KBMatch & { index: number }): boolean {
  if (a.score !== b.score) return a.score > b.score;
  if (a.coverage !== b.coverage) return a.coverage > b.coverage;
  if (a.matched.length !== b.matched.length) return a.matched.length > b.matched.length;
  return a.index > b.index;
}

/**
 * 키워드 부분일치 스코어링(띄어쓰기 무시 + 동의어 + 자모 오타 보정).
 * minScore 미만이면 null(폴백으로 넘어감).
 */
export function matchKnowledge(message: string, minScore = 2, entries: KBEntry[] = KB): KBMatch | null {
  if (!message || !message.trim()) return null;
  const pre = prepare(message);
  if (!pre.compact) return null;
  let best: (KBMatch & { index: number }) | null = null;
  for (let index = 0; index < entries.length; index += 1) {
    const m = { ...scoreEntry(pre, entries[index], true), index };
    if (m.score > 0 && (best === null || better(m, best))) best = m;
  }
  if (best === null || best.score < minScore) return null;
  return { entry: best.entry, score: best.score, matched: best.matched, coverage: best.coverage };
}

/**
 * 간단 검색(관리 콘솔·연관질문 노출용). 동의어·오타 보정 포함.
 *
 * 채점·줄 세우기는 확신 매칭과 **같은 자**를 쓴다 (DS 77-2) — 이 목록은 고객이 번호로 고르는
 * 줄이라(「번호(1~3)로 답하셔도 돼요」) 차례가 곧 추천이다. 다른 점은 하나뿐이다: 확신 매칭이
 * 보지 않는 **대표 질문의 겹침**까지 표현으로 센다(`withQuestion`) — 문턱(`minScore`)을 넘지
 * 못한 자료를 후보로 보여 주는 자리이므로, 키워드를 적어 두지 않은 자료도 걸려야 한다.
 */
export function searchKnowledge(query: string, limit = 3, entries: KBEntry[] = KB): KBEntry[] {
  if (!query || !query.trim()) return [];
  const pre = prepare(query);
  if (!pre.compact) return [];
  return entries
    .map((entry, index) => ({ ...scoreEntry(pre, entry, true, true), index }))
    .filter((x) => x.score > 0)
    .sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0))
    .slice(0, limit)
    .map((x) => x.entry);
}

// ---- 근거 문장 인용 ----

export interface Citation {
  kbId: string;
  /** 출처 라벨 — 업로드 문서명 또는 대표 질문. */
  source: string;
  category: string;
  /** 답변 중 질의와 가장 관련 높은 문장(그대로 인용). */
  snippet: string;
  /** 근거로 삼은 키워드(최대 3개). */
  keywords: string[];
}

const MAX_SNIPPET = 140;

/**
 * 답변 텍스트를 문장 단위로 자른다(구두점·줄바꿈 기준).
 *
 * 판정은 `lib/prose` 한 곳이다 (DS 66-2) — 종전에는 이 자리에서 **마침표 하나를 문장 끝으로**
 * 읽었다. 그래서 「초과 사용분은 1.5배로 계산합니다」가 두 문장이 되고, 고객 말풍선의 「근거」
 * 줄에 **「초과 사용분은 1.」** 이 떴다(원문에 없는 수다 · §13). 주소가 든 답변은 「www.」·
 * 「gowon.」·「co.」 로 쪼개져 그 조각이 근거로 뽑히기도 했다. 끊을 자리를 찾는 카카오 말풍선
 * 나누기(`lib/kakao`)가 같은 판정을 **또 한 벌** 들고 있었고, 두 벌이라 한쪽만 고쳐졌다.
 */
export { splitSentences };

/**
 * 답변에서 질의와 가장 관련 있는 문장을 골라 인용 근거를 만든다.
 * LLM 생성 요약이 아니라 원문 문장을 그대로 쓰므로 사실 왜곡 위험이 없다.
 *
 * 고르는 기준은 **고객이 물은 것**이다 (DS 77-4). 종전에는 자료에 적힌 키워드 **전부**로
 * 문장을 채점했다 — 그래서 「요금과 환불」 두 가지를 적어 둔 자료에서 환불을 물으면
 * 「요금은 월 9만원입니다」가 근거로 떴다(두 문장이 각각 키워드 하나씩 걸려 동점이 되고,
 * 동점이면 **첫 문장**이 이겼다). 근거 줄은 고객이 「이 답의 출처」로 읽는 글이라, 묻지 않은
 * 금액이 거기 뜨는 것은 §13 이 금한 「없는 수」와 같은 종류의 거짓이다. 질의에 걸린 표현만
 * 보고, 길이로 무게를 둔다(짧은 한 글자가 긴 표현과 같은 값을 갖지 않게 · DS 77-3 과 같은 자).
 *
 * `matched` 는 **라벨에만** 쓴다 — 부르는 쪽이 넘기지 않아도 문장 선택이 흔들리지 않게,
 * 걸린 표현은 질의에서 다시 센다(연관 질문·테넌트 경로는 그 칸을 비워 부른다).
 */
export function buildCitation(entry: KBEntry, query: string, matched: { keyword: string }[] = []): Citation {
  const sentences = splitSentences(entry.answer);
  const pre = prepare(query);
  const asked = entry.keywords.filter((kw) => kw && keywordHit(pre.compact, pre.jamo, kw, true).kind !== 'none');
  // 질의에 걸린 표현이 하나도 없으면(출처 라벨만 필요한 자리) 종전처럼 자료의 표현 전부로 본다.
  const terms = asked.length ? asked : entry.keywords.filter(Boolean);
  let bestSentence = sentences[0] ?? entry.answer;
  let bestScore = -1;
  for (const sentence of sentences) {
    const sPre = prepare(sentence);
    let score = 0;
    for (const kw of terms) {
      if (keywordHit(sPre.compact, sPre.jamo, kw, false).kind !== 'none') score += Math.max(1, compact(kw).length);
    }
    // 질의 자체와 겹치는 부분이 있으면 가산
    if (pre.compact && sPre.compact.includes(pre.compact)) score += 2;
    if (score > bestScore) {
      bestScore = score;
      bestSentence = sentence;
    }
  }
  // 발췌는 **고객이 읽는 글**이다(말풍선의 「근거」 줄·카카오 말풍선). 자르는 자는 한 곳이다
  // (`lib/limits.ellipsize` · DS 62-2) — 운영자가 적은 답변에는 이모지가 들어온다.
  const snippet = ellipsize(bestSentence, MAX_SNIPPET);
  return {
    kbId: entry.id,
    source: entry.source?.trim() || entry.question,
    category: entry.category,
    snippet,
    keywords: matched.slice(0, 3).map((m) => m.keyword),
  };
}
