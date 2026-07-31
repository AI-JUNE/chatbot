// 지식베이스(FAQ). 키워드 스코어링 매칭 — LLM 없이 동작(폴백 전 단계).
// 추후 관리 콘솔에서 편집 가능하도록 순수 데이터 + 순수 함수로 유지.

export interface KBEntry {
  id: string;
  category: string;
  question: string;
  keywords: string[]; // 소문자 키워드(부분 일치)
  answer: string;
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
}

/** 키워드 부분일치 스코어링. minScore 미만이면 null(폴백으로 넘어감). */
export function matchKnowledge(message: string, minScore = 2, entries: KBEntry[] = KB): KBMatch | null {
  const text = (message || '').toLowerCase();
  if (!text) return null;
  let best: KBMatch | null = null;
  for (const entry of entries) {
    let score = 0;
    for (const kw of entry.keywords) {
      if (kw && text.includes(kw)) score += kw.length >= 2 ? 2 : 1;
    }
    if (score > 0 && (!best || score > best.score)) best = { entry, score };
  }
  return best && best.score >= minScore ? best : null;
}

/** 간단 검색(관리 콘솔·연관질문 노출용). */
export function searchKnowledge(query: string, limit = 3, entries: KBEntry[] = KB): KBEntry[] {
  const text = (query || '').toLowerCase();
  if (!text) return [];
  return entries.map((entry) => {
    let score = 0;
    for (const kw of entry.keywords) if (kw && text.includes(kw)) score += 1;
    if (entry.question.toLowerCase().includes(text)) score += 2;
    return { entry, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.entry);
}
