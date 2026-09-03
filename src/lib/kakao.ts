// 카카오 i 오픈빌더 스킬 서버 어댑터(순수 함수) — 스텁.
// [승인 필요] 카카오 비즈니스 채널 등록·오픈빌더 스킬 URL 실연동 — 전까지 KAKAO_CHANNEL_LIVE=false 유지.
// 시크릿(KAKAO_SKILL_TOKEN)은 Vercel 환경변수로만 관리(코드 하드코딩 금지).
import type { ChatReply } from '@/lib/chat';
import { dedupeCheck, dedupeRemember, eventKey, safeEqual, verifySignature, type SignatureFailure } from '@/lib/webhookAuth';

export const KAKAO_LIVE = process.env.KAKAO_CHANNEL_LIVE === 'true';

/** 서명 헤더 이름(오픈빌더 커스텀 헤더 설정과 맞춘다). */
export const KAKAO_SIGNATURE_HEADER = 'x-kakao-signature';
export const KAKAO_TIMESTAMP_HEADER = 'x-kakao-timestamp';

// ---- 오픈빌더 v2 요청(사용하는 필드만 정의) ----
export interface KakaoSkillPayload {
  userRequest?: {
    utterance?: string;
    user?: { id?: string };
  };
}

/** 요청 페이로드에서 발화·사용자 id 추출. 유효하지 않으면 null. */
export function parseKakaoPayload(body: unknown): { utterance: string; userId: string } | null {
  if (!body || typeof body !== 'object') return null;
  const p = body as KakaoSkillPayload;
  const utterance = (p.userRequest?.utterance ?? '').trim();
  if (!utterance) return null;
  const userId = (p.userRequest?.user?.id ?? 'kakao-anon').trim().slice(0, 60) || 'kakao-anon';
  return { utterance, userId };
}

// ---- 오픈빌더 v2 응답 ----
interface KakaoQuickReply {
  label: string;
  action: 'message';
  messageText: string;
}

export interface KakaoSkillResponse {
  version: '2.0';
  template: {
    outputs: Array<{ simpleText: { text: string } }>;
    quickReplies?: KakaoQuickReply[];
  };
}

/** 대화엔진 결과를 오픈빌더 v2 simpleText 응답으로 변환.
 *  연관 FAQ 제안(suggestions)은 quickReplies로, escalate 시 상담원 연결 quickReply 추가(최대 10개).
 *  KB 답변이면 출처(근거) 한 줄을 덧붙인다 — 카카오는 말풍선 서식이 없어 텍스트로만 표기. */
export function toKakaoResponse(result: ChatReply): KakaoSkillResponse {
  const cite = result.citation ? `\n\n근거: ${result.citation.source}` : '';
  const body = `${result.reply}${cite}`;
  const res: KakaoSkillResponse = {
    version: '2.0',
    template: { outputs: [{ simpleText: { text: body.slice(0, 1000) } }] },
  };
  const quickReplies: KakaoQuickReply[] = [];
  for (const s of result.suggestions ?? []) {
    // 카카오 quickReply label은 14자 이하 권장 — 초과 시 말줄임표 처리
    const label = s.question.length > 14 ? `${s.question.slice(0, 13)}…` : s.question;
    quickReplies.push({ label, action: 'message', messageText: s.question });
  }
  // 이미 이번 턴에서 접수(ticketId 존재)된 경우 중복 접수 유도 방지
  if (result.escalate && !result.ticketId) {
    quickReplies.push({ label: '상담원 연결', action: 'message', messageText: '상담원' });
  }
  if (quickReplies.length) res.template.quickReplies = quickReplies.slice(0, 10);
  return res;
}

/** 에러 상황용 안전 응답(카카오는 200 + 정상 스키마를 기대). */
export function kakaoErrorResponse(text = '요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.'): KakaoSkillResponse {
  return { version: '2.0', template: { outputs: [{ simpleText: { text } }] } };
}


// ---- 웹훅 인증 · 재시도 처리 ----

export type KakaoAuthFailure = 'bad_token' | SignatureFailure;

export type KakaoAuthResult = { ok: true } | { ok: false; reason: KakaoAuthFailure };

/**
 * 스킬 요청 인증 — 토큰(있으면) + HMAC 서명(설정 시).
 *
 * 정책
 * - `KAKAO_SKILL_TOKEN` 설정 시 `x-skill-token` 일치 필수(상수 시간 비교).
 * - `KAKAO_WEBHOOK_SECRET` 설정 시 서명 검증 필수.
 * - `KAKAO_SIGNATURE_REQUIRED=true` 인데 시크릿이 없으면 **전면 차단**한다
 *   (설정 누락을 조용한 무방비 상태로 두지 않는다 — ADMIN_AUTH_REQUIRED와 같은 원칙).
 * - 실패 사유는 서버 로그용이며 응답 본문에 담지 않는다.
 */
export function authenticateKakao(
  headers: Headers,
  rawBody: string,
  env: Record<string, string | undefined> = process.env,
  nowMs?: number,
): KakaoAuthResult {
  const token = env.KAKAO_SKILL_TOKEN;
  if (token && !safeEqual(headers.get('x-skill-token') ?? '', token)) {
    return { ok: false, reason: 'bad_token' };
  }

  const secret = env.KAKAO_WEBHOOK_SECRET;
  const required = env.KAKAO_SIGNATURE_REQUIRED === 'true';
  if (!secret) return required ? { ok: false, reason: 'no_secret' } : { ok: true };

  const v = verifySignature({
    secret,
    signature: headers.get(KAKAO_SIGNATURE_HEADER),
    timestamp: headers.get(KAKAO_TIMESTAMP_HEADER),
    rawBody,
    ...(nowMs === undefined ? {} : { nowMs }),
  });
  return v.ok ? { ok: true } : { ok: false, reason: v.reason };
}

/**
 * 재시도(중복 전달) 판정 키.
 * 플랫폼이 이벤트 id를 주면 그것을, 없으면 사용자·발화·타임스탬프 조합을 해시해 쓴다.
 * 원문(발화·사용자 id)은 키에 평문으로 남지 않는다.
 */
export function kakaoEventKey(headers: Headers, userId: string, utterance: string): string {
  const explicit = headers.get('x-kakao-event-id') || headers.get('x-request-id');
  if (explicit) return eventKey(['evt', explicit]);
  return eventKey(['utt', userId, utterance, headers.get(KAKAO_TIMESTAMP_HEADER)]);
}

/** 같은 이벤트가 다시 들어왔는지 확인한다. 처음이면 자리를 예약한다. */
export function kakaoDedupe(key: string, nowMs?: number): { duplicate: boolean; response?: KakaoSkillResponse } {
  const r = dedupeCheck(key, nowMs === undefined ? {} : { now: nowMs });
  return r.response === undefined
    ? { duplicate: r.duplicate }
    : { duplicate: r.duplicate, response: r.response as KakaoSkillResponse };
}

/** 처리 결과를 기록해 재전달 시 동일 응답을 돌려준다(티켓·로그 중복 생성 방지). */
export function rememberKakaoResponse(key: string, response: KakaoSkillResponse, nowMs?: number): void {
  dedupeRemember(key, response, nowMs === undefined ? {} : { now: nowMs });
}
