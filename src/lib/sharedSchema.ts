// 공용 지식/시나리오 스키마 v1 — 챗봇(웹/카카오)·콜봇(전화)이 같은 지식·시나리오를 쓰기 위한 채널 중립 스키마.
// 콜봇(Callbot voice-agent)은 /api/shared/scenario 를 주기 폴링(또는 배포 시 1회 페치)해 이 번들을 소비한다.
// [승인 필요] 실서비스 동기화(콜봇이 운영 URL 폴링) — 전까지 스키마·엑스포트만 제공(읽기 전용, 개인정보 없음).
import type { KBEntry } from '@/lib/knowledge';
import { RULES } from '@/lib/rules';
import { listKB, getRuleOverride } from '@/lib/adminStore';

export const SHARED_SCHEMA_VERSION = 1 as const;

/** 지원 채널. 콜봇 음성 채널은 'call'. */
export type SharedChannel = 'web' | 'kakao' | 'call';

/** 공용 지식 항목 — KBEntry의 채널 중립 표현. voiceAnswer는 통화체(짧은 음성용) 별도 답변(없으면 answer 사용). */
export interface SharedKnowledgeItem {
  id: string;
  category: string;
  question: string;
  keywords: string[];
  answer: string;
  voiceAnswer?: string;
  channels: SharedChannel[]; // 노출 채널(기본 전 채널)
}

/** 공용 인텐트 룰 — 정규식은 문자열(source/flags)로 직렬화해 파이썬(콜봇) 쪽에서도 재구성 가능. */
export interface SharedIntentRule {
  intent: string;
  label: string;
  pattern: string; // RegExp.source
  flags: string; // RegExp.flags
  reply: string; // 관리 콘솔 오버라이드 반영본
  escalate: boolean;
  enabled: boolean;
  channels: SharedChannel[];
}

/** 에스컬레이션(상담원/코디네이터 연결) 채널별 매핑. */
export interface SharedEscalationPolicy {
  web: { type: 'ticket' }; // 웹: 상담 접수(에스컬레이션 큐)
  kakao: { type: 'quick_reply'; messageText: string }; // 카카오: 상담원 연결 퀵리플라이
  call: { type: 'transfer_or_callback'; tool: string }; // 콜봇: transfer_call 또는 콜백 약속
}

/** 챗봇↔콜봇 공용 시나리오 번들(엑스포트 단위). */
export interface SharedScenarioBundle {
  schemaVersion: typeof SHARED_SCHEMA_VERSION;
  scenarioId: string; // 예: 'gowon-cc' (콜봇 CALLBOT_SCENARIO와 매핑)
  exportedAt: string; // ISO
  rules: SharedIntentRule[];
  knowledge: SharedKnowledgeItem[];
  escalation: SharedEscalationPolicy;
}

const ALL_CHANNELS: SharedChannel[] = ['web', 'kakao', 'call'];

/** KBEntry → 공용 지식 항목. */
export function toSharedKnowledge(e: KBEntry): SharedKnowledgeItem {
  return {
    id: e.id,
    category: e.category,
    question: e.question,
    keywords: [...e.keywords],
    answer: e.answer,
    channels: [...ALL_CHANNELS],
  };
}

/** 현재 런타임 상태(관리 콘솔 편집 반영)를 공용 번들로 엑스포트. */
export function exportScenarioBundle(scenarioId = 'gowon-cc'): SharedScenarioBundle {
  const rules: SharedIntentRule[] = RULES.map((r) => {
    const ov = getRuleOverride(r.intent);
    return {
      intent: r.intent,
      label: r.label,
      pattern: r.test.source,
      flags: r.test.flags,
      reply: ov?.reply || r.reply,
      escalate: r.escalate === true,
      enabled: ov?.enabled !== false,
      channels: [...ALL_CHANNELS],
    };
  });
  return {
    schemaVersion: SHARED_SCHEMA_VERSION,
    scenarioId,
    exportedAt: new Date().toISOString(),
    rules,
    knowledge: listKB().map(toSharedKnowledge),
    escalation: {
      web: { type: 'ticket' },
      kakao: { type: 'quick_reply', messageText: '상담원' },
      call: { type: 'transfer_or_callback', tool: 'transfer_call' },
    },
  };
}

/** 외부(콜봇 등)에서 받은 번들의 최소 검증. 문제 목록 반환(빈 배열이면 유효). */
export function validateBundle(b: unknown): string[] {
  const errs: string[] = [];
  if (!b || typeof b !== 'object') return ['번들이 객체가 아닙니다.'];
  const x = b as Partial<SharedScenarioBundle>;
  if (x.schemaVersion !== SHARED_SCHEMA_VERSION) errs.push(`schemaVersion ${SHARED_SCHEMA_VERSION} 필요`);
  if (!x.scenarioId) errs.push('scenarioId 누락');
  if (!Array.isArray(x.rules)) errs.push('rules 배열 누락');
  else x.rules.forEach((r, i) => {
    if (!r.intent || !r.pattern || typeof r.reply !== 'string') errs.push(`rules[${i}] intent/pattern/reply 누락`);
  });
  if (!Array.isArray(x.knowledge)) errs.push('knowledge 배열 누락');
  else x.knowledge.forEach((k, i) => {
    if (!k.id || !k.question || !k.answer || !Array.isArray(k.keywords)) errs.push(`knowledge[${i}] 필드 누락`);
  });
  return errs;
}
