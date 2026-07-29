// 대화 엔진(순수). LLM 실키는 CHAT_LLM_LIVE=true 승인 후에만 사용.
export const LLM_LIVE = process.env.CHAT_LLM_LIVE === 'true';

export interface ChatReply {
  reply: string;
  intent: string;
  escalate: boolean; // 상담원 연결 제안 여부
}

interface Rule { intent: string; test: RegExp; reply: string }

const RULES: Rule[] = [
  { intent: 'greeting', test: /(안녕|하이|hello|반가)/i, reply: '안녕하세요! 고원 상담 챗봇이에요. 무엇을 도와드릴까요?' },
  { intent: 'hours', test: /(영업시간|운영시간|몇 ?시|언제.*(열|여))/, reply: '상담 운영시간은 평일 09:00~18:00입니다. 그 외 시간에도 챗봇이 24시간 안내해 드려요.' },
  { intent: 'pricing', test: /(요금|가격|비용|얼마|견적)/, reply: '요금은 이용 규모에 따라 달라집니다. 원하시는 업무와 통화량을 알려주시면 맞춰 안내드릴게요.' },
  { intent: 'agent', test: /(상담원|사람|직원|연결)/, reply: '상담원 연결을 도와드릴게요. 잠시만 기다려 주세요.' },
];

const ESCALATE_INTENTS = new Set(['agent']);

export function replyTo(message: string): ChatReply {
  const text = (message || '').trim();
  if (!text) return { reply: '메시지를 입력해 주세요.', intent: 'empty', escalate: false };

  for (const r of RULES) {
    if (r.test.test(text)) {
      return { reply: r.reply, intent: r.intent, escalate: ESCALATE_INTENTS.has(r.intent) };
    }
  }

  // 룰 미매칭 → (LLM 준비 시 여기서 호출) 지금은 안전한 폴백 + 상담원 제안
  if (LLM_LIVE) {
    // [승인 필요] 실제 LLM 연동 지점. 키·호출은 승인 후 활성화.
    return { reply: '(LLM 준비 중) 질문을 확인했어요. 조금 더 자세히 말씀해 주시겠어요?', intent: 'llm_pending', escalate: false };
  }
  return {
    reply: '아직 제가 정확히 이해하지 못했어요. 조금 더 구체적으로 말씀해 주시거나, 상담원 연결을 원하시면 "상담원"이라고 입력해 주세요.',
    intent: 'fallback',
    escalate: true,
  };
}
