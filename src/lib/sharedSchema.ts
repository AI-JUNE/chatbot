// 공용 지식/시나리오 스키마 v1 — 챗봇(웹/카카오)·콜봇(전화)이 같은 지식·시나리오를 쓰기 위한 채널 중립 스키마.
// 콜봇(Callbot voice-agent)은 /api/shared/scenario 를 주기 폴링(또는 배포 시 1회 페치)해 이 번들을 소비한다.
// [승인 필요] 실서비스 동기화(콜봇이 운영 URL 폴링) — 전까지 스키마·엑스포트만 제공(읽기 전용, 개인정보 없음).
import type { KBEntry } from '@/lib/knowledge';
import { RULES } from '@/lib/rules';
import { listKB, getRuleOverride, listCustomRules } from '@/lib/adminStore';
import { HANDOFF_REASONS, type HandoffReason } from '@/lib/handoff';

export const SHARED_SCHEMA_VERSION = 1 as const;

/** 지원 채널. 콜봇 음성 채널은 'call'. */
export type SharedChannel = 'web' | 'kakao' | 'call';

// ---- AICC-Core 정합(§5.3 Flow · 채널 렌더러) ----
// 출처: Dev\6. AICC-Core `src/flow/types.ts`(NodeKind·RenderedStep), `src/channels/contract.ts`(채널 계약).
// Core를 npm 패키지로 공유하기 전까지는 타입을 미러링하고, 아래 상수로 드리프트를 감지한다.
// [승인 필요] Core를 사내 패키지로 배포해 직접 import 하기 — 전까지 이 파일이 단일 정합 지점이다.

/** Core `ChannelKind`. 채널 렌더러가 분기하는 축은 '매체'이지 '채널 상품'이 아니다. */
export type CoreChannelKind = 'voice' | 'visual' | 'chat';

/** 공용 채널 → Core 매체 매핑. 웹·카카오는 둘 다 말풍선(chat) 렌더러를 쓴다. */
export const CORE_CHANNEL_KIND: Record<SharedChannel, CoreChannelKind> = {
  web: 'chat',
  kakao: 'chat',
  call: 'voice',
};

/** Core `NodeKind` 6종. 값·순서를 Core와 동일하게 유지한다. */
export const CORE_FLOW_NODE_KINDS = ['Say', 'Collect', 'Choice', 'Confirm', 'Transfer', 'Api'] as const;
export type SharedNodeKind = (typeof CORE_FLOW_NODE_KINDS)[number];

/** Core `src/channels/contract.ts` CHANNEL_CONTRACT_VERSION. 불일치 시 번들 소비자가 거부해야 한다. */
export const CORE_CHANNEL_CONTRACT_VERSION = 1;

export interface SharedFlowNodeBase {
  id: string;
  kind: SharedNodeKind;
  next?: string;
}
export interface SharedSayNode extends SharedFlowNodeBase { kind: 'Say'; text: string }
export interface SharedCollectNode extends SharedFlowNodeBase { kind: 'Collect'; slot: string; prompt: string; maxRetry?: number }
export interface SharedChoiceNode extends SharedFlowNodeBase { kind: 'Choice'; prompt: string; options: { label: string; value: string; next?: string }[] }
export interface SharedConfirmNode extends SharedFlowNodeBase { kind: 'Confirm'; prompt: string; onYes?: string; onNo?: string }
export interface SharedTransferNode extends SharedFlowNodeBase { kind: 'Transfer'; queue: string; reason?: HandoffReason }
export interface SharedApiNode extends SharedFlowNodeBase { kind: 'Api'; connectorId: string; waitText?: string; onError?: string }

export type SharedFlowNode =
  | SharedSayNode
  | SharedCollectNode
  | SharedChoiceNode
  | SharedConfirmNode
  | SharedTransferNode
  | SharedApiNode;

export interface SharedFlow {
  id: string;
  version: number;
  startNodeId: string;
  nodes: Record<string, SharedFlowNode>;
}

/** Core `RenderedStep` 미러. 채널 어댑터는 이 값을 자기 표현으로 바꾸기만 한다. */
export interface SharedRenderedStep {
  channel: CoreChannelKind;
  nodeId: string;
  kind: SharedNodeKind;
  text: string;
  ui?: { type: 'buttons' | 'form' | 'confirm'; items?: { label: string; value: string }[]; slot?: string };
  acceptDtmf?: boolean;
  transferTo?: string;
  silent?: boolean;
  awaitConnectorId?: string;
}

/**
 * 노드 렌더 — Core `renderNode()`와 동일한 분기 규칙.
 * "하나의 Flow를 렌더러만 바꿔 실행한다"는 약속이 저장소마다 갈라지지 않도록 로직까지 맞춘다.
 */
export function renderSharedNode(node: SharedFlowNode, channel: CoreChannelKind): SharedRenderedStep {
  const base = { channel, nodeId: node.id, kind: node.kind };
  switch (node.kind) {
    case 'Say':
      return { ...base, text: node.text };
    case 'Collect':
      return channel === 'voice'
        ? { ...base, text: node.prompt, acceptDtmf: true }
        : { ...base, text: node.prompt, ui: { type: 'form', slot: node.slot } };
    case 'Choice': {
      const items = node.options.map((o) => ({ label: o.label, value: o.value }));
      return channel === 'voice'
        ? {
            ...base,
            text: `${node.prompt} ${node.options.map((o, i) => `${i + 1}번 ${o.label}`).join(', ')}`,
            acceptDtmf: true,
          }
        : { ...base, text: node.prompt, ui: { type: 'buttons', items } };
    }
    case 'Confirm':
      return channel === 'voice'
        ? { ...base, text: `${node.prompt} 맞으시면 1번을 눌러주세요.`, acceptDtmf: true }
        : { ...base, text: node.prompt, ui: { type: 'confirm' } };
    case 'Transfer':
      return { ...base, text: '상담원에게 연결해 드리겠습니다.', transferTo: node.queue };
    case 'Api': {
      const text = node.waitText ?? '';
      return { ...base, text, silent: text.trim() === '', awaitConnectorId: node.connectorId };
    }
  }
}

/** Flow 구조 검증(배포 전 사전 판정). 문제 목록을 반환하며 빈 배열이면 유효하다. */
export function validateFlow(flow: SharedFlow): string[] {
  const errs: string[] = [];
  const ids = new Set(Object.keys(flow.nodes));
  if (!ids.has(flow.startNodeId)) errs.push(`startNodeId '${flow.startNodeId}' 노드가 없습니다.`);
  for (const [id, node] of Object.entries(flow.nodes)) {
    if (node.id !== id) errs.push(`nodes['${id}'].id가 '${node.id}'로 불일치합니다.`);
    if (!(CORE_FLOW_NODE_KINDS as readonly string[]).includes(node.kind)) {
      errs.push(`${id}: 알 수 없는 노드 종류 '${String(node.kind)}'`);
      continue;
    }
    const refs: (string | undefined)[] = [node.next];
    if (node.kind === 'Choice') {
      if (node.options.length === 0) errs.push(`${id}: Choice 노드에 선택지가 없습니다.`);
      for (const o of node.options) refs.push(o.next);
    }
    if (node.kind === 'Confirm') refs.push(node.onYes, node.onNo);
    if (node.kind === 'Api') refs.push(node.onError);
    for (const r of refs) {
      if (r && !ids.has(r)) errs.push(`${id}: 존재하지 않는 노드를 가리킵니다 → '${r}'`);
    }
  }
  return errs;
}

/**
 * 챗봇의 상담원 접수 흐름을 Core Flow로 표현한 것.
 * 지금 엔진(src/lib/chat.ts)이 코드로 하는 일과 같은 구조를 Flow 노드로 선언해,
 * 콜봇·D-ARS가 같은 시나리오를 렌더러만 바꿔 실행할 수 있게 한다.
 */
export function escalationFlow(queue = 'default'): SharedFlow {
  return {
    id: 'escalation',
    version: 1,
    startNodeId: 'ack',
    nodes: {
      ack: { id: 'ack', kind: 'Say', text: '상담원 연결을 도와드릴게요.', next: 'contact' },
      contact: {
        id: 'contact',
        kind: 'Collect',
        slot: 'contact',
        prompt: '연락받으실 전화번호나 이메일을 남겨주세요. (원치 않으시면 "건너뛰기")',
        maxRetry: 1,
        next: 'confirm',
      },
      confirm: {
        id: 'confirm',
        kind: 'Confirm',
        prompt: '남겨주신 연락처로 상담원이 연락드릴까요?',
        onYes: 'transfer',
        onNo: 'transfer',
      },
      transfer: { id: 'transfer', kind: 'Transfer', queue, reason: 'customer_request' },
    },
  };
}

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

/** 공용 인텐트 룰 — 정규식은 문자열(source/flags)로 직렬화해 파이썬(콜봇) 쪽에서도 재구성 가능.
 * 커스텀 룰(관리 콘솔 키워드 룰)은 matchType='keywords'로 표시되며, 정규식만 아는 소비자를 위해
 * pattern에도 키워드 이스케이프 alternation을 함께 직렬화한다. */
export interface SharedIntentRule {
  intent: string;
  label: string;
  pattern: string; // RegExp.source
  flags: string; // RegExp.flags
  reply: string; // 관리 콘솔 오버라이드 반영본
  escalate: boolean;
  enabled: boolean;
  channels: SharedChannel[];
  matchType?: 'regex' | 'keywords'; // 기본 'regex'(내장 룰)
  keywords?: string[]; // matchType='keywords'일 때 원본 키워드
  origin?: 'builtin' | 'custom'; // 룰 출처(기본 'builtin')
}

/** 에스컬레이션(상담원/코디네이터 연결) 채널별 매핑. */
export interface SharedEscalationPolicy {
  web: { type: 'ticket' }; // 웹: 상담 접수(에스컬레이션 큐)
  kakao: { type: 'quick_reply'; messageText: string }; // 카카오: 상담원 연결 퀵리플라이
  call: { type: 'transfer_or_callback'; tool: string }; // 콜봇: transfer_call 또는 콜백 약속
  /** 이관 사유 코드 어휘(AICC-Core Handoff). 저장소가 달라도 같은 값으로 집계된다. */
  reasonCodes?: HandoffReason[];
}

/** 번들이 어떤 Core 계약에 맞춰 만들어졌는지 — 소비자가 드리프트를 즉시 감지하기 위한 메타. */
export interface SharedCoreContract {
  flowNodeKinds: readonly SharedNodeKind[];
  channelContractVersion: number;
  handoffReasons: readonly HandoffReason[];
  channelKindMap: Record<SharedChannel, CoreChannelKind>;
}

/** 챗봇↔콜봇 공용 시나리오 번들(엑스포트 단위). */
export interface SharedScenarioBundle {
  schemaVersion: typeof SHARED_SCHEMA_VERSION;
  scenarioId: string; // 예: 'gowon-cc' (콜봇 CALLBOT_SCENARIO와 매핑)
  exportedAt: string; // ISO
  rules: SharedIntentRule[];
  knowledge: SharedKnowledgeItem[];
  escalation: SharedEscalationPolicy;
  /** §5.3 Flow(선택). v1 소비자는 무시해도 되도록 옵셔널로 둔다. */
  flows?: SharedFlow[];
  /** Core 계약 메타(선택). 없으면 소비자가 v1 기본값으로 간주한다. */
  coreContract?: SharedCoreContract;
}

const ALL_CHANNELS: SharedChannel[] = ['web', 'kakao', 'call'];

/** 정규식 특수문자 이스케이프(키워드 → alternation 직렬화용). */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
  // 커스텀 시나리오 룰(관리 콘솔 키워드 룰) — 내장 룰 뒤에 등록순으로 붙인다(엔진 적용 순서와 동일).
  for (const c of listCustomRules()) {
    rules.push({
      intent: c.intent,
      label: c.label,
      pattern: c.keywords.map(escapeRegex).join('|'),
      flags: 'i',
      reply: c.reply,
      escalate: c.escalate,
      enabled: c.enabled,
      channels: [...ALL_CHANNELS],
      matchType: 'keywords',
      keywords: [...c.keywords],
      origin: 'custom',
    });
  }
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
      reasonCodes: [...HANDOFF_REASONS],
    },
    flows: [escalationFlow()],
    coreContract: {
      flowNodeKinds: CORE_FLOW_NODE_KINDS,
      channelContractVersion: CORE_CHANNEL_CONTRACT_VERSION,
      handoffReasons: [...HANDOFF_REASONS],
      channelKindMap: { ...CORE_CHANNEL_KIND },
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
  // Flow는 선택 필드지만, 들어 있으면 Core 규칙으로 검증한다.
  if (x.flows !== undefined) {
    if (!Array.isArray(x.flows)) errs.push('flows는 배열이어야 합니다.');
    else x.flows.forEach((f, i) => {
      for (const e of validateFlow(f)) errs.push(`flows[${i}](${f?.id ?? '?'}): ${e}`);
    });
  }
  if (x.coreContract !== undefined) {
    const c = x.coreContract;
    if (c.channelContractVersion !== CORE_CHANNEL_CONTRACT_VERSION) {
      errs.push(`채널 계약 버전 불일치: 번들 ${c.channelContractVersion} ≠ 로컬 ${CORE_CHANNEL_CONTRACT_VERSION}`);
    }
    const kinds = Array.isArray(c.flowNodeKinds) ? c.flowNodeKinds.join(',') : '';
    if (kinds !== CORE_FLOW_NODE_KINDS.join(',')) {
      errs.push(`Flow 노드 종류가 Core와 다릅니다: [${kinds}]`);
    }
  }
  return errs;
}
