/**
 * AICC-Core 채널 어댑터 — 챗봇 저장소가 Core를 실제로 소비하는 지점.
 *
 * 역할 분담(설계서 §1.2·§5.3·§6.2)
 * - Core(`aicc-core/channels/basePort`)가 세션·시나리오·이벤트·폴백·마스킹·종료 멱등을 책임진다.
 * - 이 저장소가 책임지는 것은 **매체로 내보내는 한 가지**뿐이다: 렌더된 단계를 챗 메시지로 바꿔
 *   전송기(sink)에 넘긴다. 그래서 이 파일에는 세션도 상태도 없다.
 *
 * 왜 Core 타입을 import 하지 않는가
 * - 이 파일은 Next 빌드에 포함되므로, Core 패키지가 설치되지 않은 환경(빌드 전용 이미지 등)에서도
 *   타입 검증이 통과해야 한다. 그래서 계약을 **구조적으로만** 선언한다.
 * - 계약이 실제로 맞는지는 CI에서 Core의 적합성 실행기(`npm run conformance:aicc`)가 판정한다.
 *   문서나 주석이 아니라 실행기가 드리프트를 잡는다.
 *
 * build now, activate on approval
 * - 기본은 dry_run 이다. `CHATBOT_AICC_LIVE=true` 와 승인 근거(`CHATBOT_AICC_APPROVAL_REF`)가
 *   **둘 다** 있어야 live 로 올라간다. 둘 중 하나만 있으면 켜지지 않는다 — **[승인 필요]**
 * - 실제 카카오·웹 위젯 전송은 sink 구현이 하며, 이 파일은 sink 를 호출만 한다.
 */

/* ── Core 계약(구조적 선언) ─────────────────────────────────────────────────── */

export type AiccDeliveryKind = 'present' | 'transfer' | 'routeToLegacyIvr' | 'invite' | 'end';

export interface AiccRenderedStep {
  channel: string;
  nodeId: string;
  kind: string;
  /** 표시 텍스트. 이미 Core에서 마스킹을 거친 값이다(§10.3) — 여기서 다시 가공하지 않는다. */
  text: string;
  ui?: { type: 'buttons' | 'form' | 'confirm'; items?: { label: string; value: string }[]; slot?: string };
  /** 표시할 것이 없는 단계(Api 대기). 렌더하지 않는다. */
  silent?: boolean;
  transferTo?: string;
}

export interface AiccDeliveryEnvelope {
  interactionId: string;
  adapter: string;
  channel: string;
  kind: AiccDeliveryKind;
  steps?: readonly AiccRenderedStep[];
  queue?: string;
  /** 상담사에게 넘길 마스킹된 요약. **고객 화면에 그대로 뿌리지 않는다.** */
  summaryMasked?: string;
  reasonKo?: string;
  target?: string;
}

/* ── 아웃바운드 메시지 ──────────────────────────────────────────────────────── */

export type OutboundMessageKind = 'say' | 'choice' | 'form' | 'notice';

export interface OutboundMessage {
  interactionId: string;
  kind: OutboundMessageKind;
  text: string;
  /** 버튼. 챗 채널은 richUi=true 이므로 선택지를 번호로 읽어 주지 않는다. */
  quickReplies?: { label: string; value: string }[];
  /** 폼 입력을 받을 슬롯 이름. */
  slot?: string;
  /** 상담사 이관 대기열. 고객 화면에는 표시하지 않고 위젯이 상태 표시에 쓴다. */
  queue?: string;
}

/** 고객에게 보이는 문구. 시나리오 텍스트가 아닌 것은 여기 한 곳에만 둔다. */
export const AICC_NOTICE_KO = {
  transfer: '상담사에게 연결하고 있습니다. 잠시만 기다려 주세요.',
  end: '상담을 종료했습니다. 이용해 주셔서 감사합니다.',
} as const;

/**
 * 지시 → 챗 메시지. 순수 함수이므로 전송 없이 그대로 테스트한다.
 *
 * 두 가지를 반드시 지킨다.
 *  1) `silent` 단계는 내보내지 않는다. 내부 API 대기를 고객에게 빈 말풍선으로 보여 주지 않는다.
 *  2) `summaryMasked` 는 **절대 고객 메시지에 넣지 않는다**. 마스킹을 거쳤더라도 그것은
 *     상담사용 요약이지 고객에게 읽어 줄 문장이 아니다(§2·§10.3).
 */
export function renderEnvelope(env: AiccDeliveryEnvelope): OutboundMessage[] {
  const id = env.interactionId;
  switch (env.kind) {
    case 'present': {
      const steps = env.steps ?? [];
      const out: OutboundMessage[] = [];
      for (const s of steps) {
        if (s.silent === true) continue;
        if (typeof s.text !== 'string' || s.text.length === 0) continue;
        if (s.ui?.type === 'buttons' || s.ui?.type === 'confirm') {
          out.push({
            interactionId: id,
            kind: 'choice',
            text: s.text,
            quickReplies: (s.ui.items ?? []).map((i) => ({ label: i.label, value: i.value })),
          });
          continue;
        }
        if (s.ui?.type === 'form') {
          out.push({
            interactionId: id, kind: 'form', text: s.text,
            ...(s.ui.slot !== undefined ? { slot: s.ui.slot } : {}),
          });
          continue;
        }
        out.push({ interactionId: id, kind: 'say', text: s.text });
      }
      return out;
    }
    case 'transfer':
      return [{
        interactionId: id, kind: 'notice', text: AICC_NOTICE_KO.transfer,
        ...(env.queue !== undefined ? { queue: env.queue } : {}),
      }];
    case 'end':
      return [{ interactionId: id, kind: 'notice', text: AICC_NOTICE_KO.end }];
    default:
      // routeToLegacyIvr·invite 는 챗 채널의 능력이 아니다(profiles: routeToLegacyIvr=false,
      // crossChannelInvite=false). Core가 부를 일이 없지만, 불려도 고객에게 엉뚱한 말을 하지 않는다.
      return [];
  }
}

/* ── 전송기 ─────────────────────────────────────────────────────────────────── */

/**
 * 실제 매체로 내보내는 구현. 카카오 응답·웹 위젯 SSE 등이 여기 들어온다.
 * **실패는 반드시 던진다.** 삼키면 고객은 무응답을 보고, Core는 성공으로 기록한다(품질기준 §3).
 */
export type OutboundSink = (messages: OutboundMessage[]) => Promise<void>;

export interface AiccTransport {
  readonly name: string;
  deliver(env: AiccDeliveryEnvelope): Promise<void>;
}

export interface AiccTransportOptions {
  sink: OutboundSink;
  /** 로그·기록에 남는 이름. 개인정보를 넣지 않는다. */
  name?: string;
}

/**
 * Core의 `ChannelTransport` 구현. Core가 `deliver` 하나만 요구하므로 이 파일도 하나만 노출한다.
 * 내보낼 메시지가 없으면 sink 를 호출하지 않는다 — 빈 전송은 매체에 따라 빈 말풍선이 된다.
 */
export function createAiccTransport(opts: AiccTransportOptions): AiccTransport {
  if (typeof opts.sink !== 'function') {
    throw new Error('AICC transport: sink 구현이 필요합니다. 내보낼 매체가 없습니다.');
  }
  return {
    name: opts.name ?? 'chatbot-outbound',
    async deliver(env: AiccDeliveryEnvelope): Promise<void> {
      const messages = renderEnvelope(env);
      if (messages.length === 0) return;
      await opts.sink(messages);
    },
  };
}

/* ── 활성화 ─────────────────────────────────────────────────────────────────── */

export interface AiccActivationState {
  activation: 'dry_run' | 'live';
  approvalRef?: string;
  /** 왜 live 가 아닌지. 화면·기동 로그에 그대로 쓴다. */
  reasonKo?: string;
}

/**
 * 환경변수 → 활성화 상태. 기본은 dry_run 이고, **플래그와 승인 근거가 둘 다** 있어야 live 다.
 * 플래그 하나로 실전송이 열리면, 배포 설정 실수 한 번이 곧 고객 발송 사고가 된다.
 */
export function aiccActivation(env: Record<string, string | undefined>): AiccActivationState {
  const flag = env.CHATBOT_AICC_LIVE === 'true';
  const approvalRef = env.CHATBOT_AICC_APPROVAL_REF;
  const hasApproval = typeof approvalRef === 'string' && approvalRef.trim().length > 0;
  if (flag && hasApproval) return { activation: 'live', approvalRef: approvalRef.trim() };
  if (flag && !hasApproval) {
    return { activation: 'dry_run', reasonKo: '[승인 필요] CHATBOT_AICC_APPROVAL_REF 가 없어 실전송을 켜지 않았습니다.' };
  }
  return { activation: 'dry_run', reasonKo: '기본값(dry_run)입니다. 실전송은 [승인 필요].' };
}

/**
 * Core의 `createChannelPort` 에 그대로 넘길 옵션을 만든다.
 * 이 함수는 Core를 import 하지 않는다 — 옵션 객체만 만들고, 조립은 `ci/aicc-port.mjs` 와
 * 런타임 진입점이 한다. 그래야 Next 빌드가 Core 설치 여부에 묶이지 않는다.
 */
export function aiccPortOptions(
  env: Record<string, string | undefined>,
  sink?: OutboundSink,
): {
  id: 'chatbot';
  activation: 'dry_run' | 'live';
  approvalRef?: string;
  transport?: AiccTransport;
  timeoutMs?: number;
  reasonKo?: string;
} {
  const state = aiccActivation(env);
  const raw = env.CHATBOT_AICC_TIMEOUT_MS;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  // 예산은 계약값이다. 값이 없거나 해석 불가면 **만들어 넣지 않는다**(§13-3).
  const timeoutMs = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;

  // live 인데 sink 가 없으면 실전송이 불가하므로 dry_run 으로 내린다. 조용히 성공한 척하지 않는다.
  const live = state.activation === 'live' && typeof sink === 'function';
  const reasonKo = state.activation === 'live' && sink === undefined
    ? 'live 로 선언됐으나 전송기(sink)가 없어 dry_run 으로 내렸습니다.'
    : state.reasonKo;

  return {
    id: 'chatbot',
    activation: live ? 'live' : 'dry_run',
    ...(live && state.approvalRef !== undefined ? { approvalRef: state.approvalRef } : {}),
    ...(sink !== undefined ? { transport: createAiccTransport({ sink }) } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(reasonKo !== undefined ? { reasonKo } : {}),
  };
}
