// 카카오 오픈빌더 스킬 웹훅(스텁) — build now, activate on approval.
// [승인 필요] 카카오 채널 실연동(오픈빌더에 이 URL 등록) — 전까지 KAKAO_CHANNEL_LIVE=false로 테스트만.
// KAKAO_SKILL_TOKEN 설정 시 x-skill-token 헤더 일치 필수(시크릿은 Vercel 환경변수로만).
import { NextRequest, NextResponse } from 'next/server';
import { replyTo } from '@/lib/chat';
import { logTurn } from '@/lib/convlog';
import { KAKAO_LIVE, parseKakaoPayload, toKakaoResponse, kakaoErrorResponse } from '@/lib/kakao';
import { checkRate } from '@/lib/ratelimit';
import { ok, fail, readJson } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET() {
  // 헬스체크·상태 확인용(민감정보 없음)
  return ok({ channel: 'kakao', live: KAKAO_LIVE, mode: KAKAO_LIVE ? 'live' : 'stub' });
}

export async function POST(req: NextRequest) {
  // 카카오는 4xx/5xx를 스킬 오류로 처리해 사용자에게 실패 화면을 보여주므로,
  // rate limit 초과도 429 대신 200 + 안내 말풍선으로 응답한다(처리 스킵으로 부하는 동일하게 차단).
  const rate = checkRate('kakao', req.headers, 120);
  if (!rate.allowed) {
    return NextResponse.json(kakaoErrorResponse('요청이 많아 잠시 쉬고 있어요. 잠시 후 다시 말씀해 주세요.'));
  }

  const token = process.env.KAKAO_SKILL_TOKEN;
  if (token && req.headers.get('x-skill-token') !== token) {
    return fail('unauthorized', '스킬 토큰이 올바르지 않습니다.');
  }

  // 카카오는 4xx를 재시도/오류로 처리하므로, 본문 문제는 200 + 안내 말풍선으로 응답한다.
  const parsedBody = await readJson<Record<string, unknown>>(req);
  if (!parsedBody.ok) return NextResponse.json(kakaoErrorResponse('잘못된 요청 형식입니다.'));

  const parsed = parseKakaoPayload(parsedBody.data);
  if (!parsed) return NextResponse.json(kakaoErrorResponse('발화를 확인하지 못했어요.'));

  const result = replyTo(parsed.utterance, `kakao:${parsed.userId}`);

  // 대화 로그(인메모리 스텁) — 영구 저장은 [승인 필요]. 사용자 id는 세션 구분용으로만 사용.
  if (result.source !== 'empty') {
    logTurn({
      sessionId: `kakao:${parsed.userId}`,
      channel: 'kakao',
      message: parsed.utterance,
      reply: result.reply,
      intent: result.intent,
      source: result.source,
      escalate: result.escalate,
    });
  }

  return NextResponse.json(toKakaoResponse(result));
}
