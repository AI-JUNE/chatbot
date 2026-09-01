// 지식베이스(FAQ). 키워드 스코어링 매칭 — LLM 없이 동작(폴백 전 단계).
// 추후 관리 콘솔에서 편집 가능하도록 순수 데이터 + 순수 함수로 유지.
// 매칭은 src/lib/normalize 의 동의어 확장·자모 오타 보정을 거친다(정확 일치 가중치가 가장 높다).
import { MATCH_WEIGHT, keywordHit, prepare, type PreparedText, type MatchKind } from '@/lib/normalize';

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
  /** 매칭에 기여한 키워드와 매칭 종류(근거 표시·품질 분석용). */
  matched: { keyword: string; kind: MatchKind }[];
}

/** 한글 비교용 정규화 — 소문자화 + 공백 제거(띄어쓰기 차이 흡수). */
function normalize(s: string): string {
  return (s || '').toLowerCase().replace(/\s+/g, '');
}

/** 키워드 1건의 기여 점수. 2자 이상은 2점, 1자는 1점을 매칭 종류 가중치로 감산한다. */
function keywordScore(keyword: string, kind: MatchKind): number {
  const base = normalize(keyword).length >= 2 ? 2 : 1;
  return base * MATCH_WEIGHT[kind];
}

/** 항목 1건을 준비된 질의에 대해 채점한다. */
function scoreEntry(pre: PreparedText, entry: KBEntry, allowFuzzy: boolean): KBMatch {
  let score = 0;
  const matched: { keyword: string; kind: MatchKind }[] = [];
  for (const kw of entry.keywords) {
    if (!kw) continue;
    const hit = keywordHit(pre.compact, pre.jamo, kw, allowFuzzy);
    if (hit.kind === 'none') continue;
    score += keywordScore(kw, hit.kind);
    matched.push({ keyword: kw, kind: hit.kind });
  }
  return { entry, score, matched };
}

/**
 * 키워드 부분일치 스코어링(띄어쓰기 무시 + 동의어 + 자모 오타 보정).
 * minScore 미만이면 null(폴백으로 넘어감).
 */
export function matchKnowledge(message: string, minScore = 2, entries: KBEntry[] = KB): KBMatch | null {
  if (!message || !message.trim()) return null;
  const pre = prepare(message);
  if (!pre.compact) return null;
  let best: KBMatch | null = null;
  for (const entry of entries) {
    const m = scoreEntry(pre, entry, true);
    if (m.score > 0 && (!best || m.score > best.score)) best = m;
  }
  return best && best.score >= minScore ? best : null;
}

/** 간단 검색(관리 콘솔·연관질문 노출용). 동의어·오타 보정 포함. */
export function searchKnowledge(query: string, limit = 3, entries: KBEntry[] = KB): KBEntry[] {
  if (!query || !query.trim()) return [];
  const pre = prepare(query);
  if (!pre.compact) return [];
  return entries
    .map((entry) => {
      const m = scoreEntry(pre, entry, true);
      let score = m.matched.reduce((acc, x) => acc + MATCH_WEIGHT[x.kind], 0);
      const q = normalize(entry.question);
      if (q.includes(pre.compact) || pre.compact.includes(q)) score += 2;
      return { entry, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
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

/** 답변 텍스트를 문장 단위로 자른다(한국어 종결·구두점·줄바꿈 기준). */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let buf = '';
  for (const ch of text || '') {
    if (ch === '\n') {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
    if (ch === '.' || ch === '!' || ch === '?' || ch === '。') {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/**
 * 답변에서 질의와 가장 관련 있는 문장을 골라 인용 근거를 만든다.
 * LLM 생성 요약이 아니라 원문 문장을 그대로 쓰므로 사실 왜곡 위험이 없다.
 */
export function buildCitation(entry: KBEntry, query: string, matched: { keyword: string }[] = []): Citation {
  const sentences = splitSentences(entry.answer);
  const pre = prepare(query);
  let bestSentence = sentences[0] ?? entry.answer;
  let bestScore = -1;
  for (const sentence of sentences) {
    const sPre = prepare(sentence);
    let score = 0;
    for (const kw of entry.keywords) {
      if (keywordHit(sPre.compact, sPre.jamo, kw, false).kind !== 'none') score += 1;
    }
    // 질의 자체와 겹치는 부분이 있으면 가산
    if (pre.compact && sPre.compact.includes(pre.compact)) score += 2;
    if (score > bestScore) {
      bestScore = score;
      bestSentence = sentence;
    }
  }
  const snippet = bestSentence.length > MAX_SNIPPET ? `${bestSentence.slice(0, MAX_SNIPPET - 1)}…` : bestSentence;
  return {
    kbId: entry.id,
    source: entry.source?.trim() || entry.question,
    category: entry.category,
    snippet,
    keywords: matched.slice(0, 3).map((m) => m.keyword),
  };
}
