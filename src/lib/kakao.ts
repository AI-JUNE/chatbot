// 카카오 i 오픈빌더 스킬 서버 어댑터(순수 함수) — 스텁.
// [승인 필요] 카카오 비즈니스 채널 등록·오픈빌더 스킬 URL 실연동 — 전까지 KAKAO_CHANNEL_LIVE=false 유지.
// 시크릿(KAKAO_SKILL_TOKEN)은 Vercel 환경변수로만 관리(코드 하드코딩 금지).
import type { ChatReply } from '@/lib/chat';

export const KAKAO_LIVE = process.env.KAKAO_CHANNEL_LIVE === 'true';

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
