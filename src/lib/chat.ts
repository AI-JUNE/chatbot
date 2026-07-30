// 대화 엔진(순수). 우선순위: 인텐트 룰 → 지식베이스(FAQ) → LLM(스텁) → 폴백.
// LLM 실키는 CHAT_LLM_LIVE=true 승인 후에만 사용. [승인 필요] 전까지 스텁 유지.
import { matchKnowledge } from '@/lib/knowledge';

export const LLM_LIVE = process.env.CHAT_LLM_LIVE === 'true';

export type ReplySource = 'rule' | 'kb' | 'llm' | 'fallback' | 'empty';

export interface ChatReply {
  reply: string;
  intent: string;
  escalate: boolean; // 상담원 연결 제안 여부
  source: ReplySource;
  kbId?: string; // 지식베이스 매칭 시 항목 id(로그·품질 분석용)
}

interface Rule {
  intent: string;
  test: RegExp;
  reply: string;
  escalate?: boolean;
}

const RULES: Rule[] = [
  { intent: 'greeting', test: /(안녕|하이|hello|반가)/i, reply: '안녕하세요! 고원 상담 챗봇이에요. 무엇을 도와드릴까요?' },
  { intent: 'thanks', test: /(감사|고마워|고맙|thank)/i, reply: '도움이 되었다니 기뻐요! 더 궁금한 점이 있으면 언제든 물어봐 주세요.' },
  { intent: 'bye', test: /(잘 ?가|안녕히|종료|끝낼|바이)/, reply: '이용해 주셔서 감사합니다. 필요하실 때 언제든 다시 찾아 주세요!' },
  { intent: 'hours', test: /(영업시간|운영시간|몇 ?시|언제.*(열|여))/, reply: '상담 운영시간은 평일 09:00~18:00입니다. 그 외 시간에도 챗봇이 24시간 안내해 드려요.' },
  { intent: 'pricing', test: /(요금|가격|비용|얼마|견적)/, reply: '요금은 이용 규모에 따라 달라집니다. 원하시는 업무와 통화량을 알려주시면 맞춰 안내드릴게요.' },
  { intent: 'agent', test: /(상담원|사람|직원|연결)/, reply: '상담원 연결을 도와드릴게요. 잠시만 기다려 주세요.', escalate: true },
  { intent: 'complaint', test: /(불만|항의|화가|짜증|최악|민원)/, reply: '불편을 드려 정말 죄송합니다. 상황을 정확히 확인해 도와드릴 수 있도록 상담원 연결을 도와드릴게요.', escalate: true },
];

export function replyTo(message: string): ChatReply {
  const text = (message || '').trim();
  if (!text) return { reply: '메시지를 입력해 주세요.', intent: 'empty', escalate: false, source: 'empty' };

  // 1) 인텐트 룰
  for (const r of RULES) {
    if (r.test.test(text)) {
      return { reply: r.reply, intent: r.intent, escalate: r.escalate === true, source: 'rule' };
    }
  }

  // 2) 지식베이스(FAQ) 매칭
  const kb = matchKnowledge(text);
  if (kb) {
    return { reply: kb.entry.answer, intent: `kb:${kb.entry.category}`, escalate: false, source: 'kb', kbId: kb.entry.id };
  }

  // 3) LLM 폴백(스텁). [승인 필요] 실키 연동 전까지 안전 응답만.
  if (LLM_LIVE) {
    return { reply: '(LLM 준비 중) 질문을 확인했어요. 조금 더 자세히 말씀해 주시겠어요?', intent: 'llm_pending', escalate: false, source: 'llm' };
  }

  // 4) 최종 폴백 + 상담원 제안
  return {
    reply: '아직 제가 정확히 이해하지 못했어요. 조금 더 구체적으로 말씀해 주시거나, 상담원 연결을 원하시면 "상담원"이라고 입력해 주세요.',
    intent: 'fallback',
    escalate: true,
    source: 'fallback',
  };
}
