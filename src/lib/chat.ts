// 대화 엔진(순수). 우선순위: 인텐트 룰 → 지식베이스(FAQ) → LLM(스텁) → 폴백.
// LLM 실키는 CHAT_LLM_LIVE=true 승인 후에만 사용. [승인 필요] 전까지 스텁 유지.
import { matchKnowledge } from '@/lib/knowledge';
import { RULES } from '@/lib/rules';
import { listKB, getRuleOverride } from '@/lib/adminStore';

export const LLM_LIVE = process.env.CHAT_LLM_LIVE === 'true';

export type ReplySource = 'rule' | 'kb' | 'llm' | 'fallback' | 'empty';

export interface ChatReply {
  reply: string;
  intent: string;
  escalate: boolean; // 상담원 연결 제안 여부
  source: ReplySource;
  kbId?: string; // 지식베이스 매칭 시 항목 id(로그·품질 분석용)
}

export function replyTo(message: string): ChatReply {
  const text = (message || '').trim();
  if (!text) return { reply: '메시지를 입력해 주세요.', intent: 'empty', escalate: false, source: 'empty' };

  // 1) 인텐트 룰(관리 콘솔 오버라이드 반영: 비활성화 스킵·응답문 교체)
  for (const r of RULES) {
    const ov = getRuleOverride(r.intent);
    if (ov && ov.enabled === false) continue;
    if (r.test.test(text)) {
      return { reply: ov?.reply || r.reply, intent: r.intent, escalate: r.escalate === true, source: 'rule' };
    }
  }

  // 2) 지식베이스(FAQ) 매칭 — 관리 콘솔 편집분(런타임 스토어) 사용
  const kb = matchKnowledge(text, 2, listKB());
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
