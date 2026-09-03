// 카카오 오픈빌더 스킬 웹훅 — build now, activate on approval.
// [승인 필요] 카카오 채널 실연동(오픈빌더에 이 URL 등록) — 전까지 KAKAO_CHANNEL_LIVE=false로 테스트만.
//
// 보안
// - KAKAO_SKILL_TOKEN 설정 시 x-skill-token 일치 필수(상수 시간 비교).
// - KAKAO_WEBHOOK_SECRET 설정 시 HMAC-SHA256 서명(x-kakao-signature/x-kakao-timestamp) 검증 필수.
// - KAKAO_SIGNATURE_REQUIRED=true 인데 시크릿이 없으면 전면 차단(설정 누락 = 사고).
// - 시크릿은 Vercel 환경변수로만 관리(코드 하드코딩 금지). 실패 사유는 응답에 담지 않는다.
//
// 재시도
// - 채널 플랫폼은 응답 지연 시 같은 이벤트를 다시 보낸다. 중복 전달은 엔진을 다시 돌리지 않고
//   이전 응답을 그대로 돌려준다(티켓 중복 접수·대화 로그 중복 방지).
import { NextRequest, NextResponse } from 'next/server';
import { replyToAsync } from '@/lib/chat';
import { logTurn } from '@/lib/convlog';
import {
  KAKAO_LIVE,
  authenticateKakao,
  kakaoDedupe,
  kakaoErrorResponse,
  kakaoEventKey,
  parseKakaoPayload,
  rememberKakaoResponse,
  toKakaoResponse,
} from '@/lib/kakao';
import { checkRate } from '@/lib/ratelimit';
import { ok, fail, readJsonWithRaw } from '@/lib/http';
import { startRequest, hashId } from '@/lib/logger';
import { captureError } from '@/lib/monitoring';

export const dynamic = 'force-dynamic';

export async function GET() {
  // 헬스체크·상태 확인용(민감정보 없음). 시크릿 값은 노출하지 않고 설정 여부만 알린다.
  return ok({
    channel: 'kakao',
    live: KAKAO_LIVE,
    mode: KAKAO_LIVE ? 'live' : 'stub',
    signature: {
      configured: Boolean(process.env.KAKAO_WEBHOOK_SECRET),
      required: process.env.KAKAO_SIGNATURE_REQUIRED === 'true',
    },
  });
}

export async function POST(req: NextRequest) {
  const rl = startRequest('/api/kakao/webhook', 'POST', req.headers.get('x-request-id'));

  // 카카오는 4xx/5xx를 스킬 오류로 처리해 사용자에게 실패 화면을 보여주므로,
  // rate limit 초과도 429 대신 200 + 안내 말풍선으로 응답한다(처리 스킵으로 부하는 동일하게 차단).
  const rate = checkRate('kakao', req.headers, 120);
  if (!rate.allowed) {
    rl.end({ status: 200, code: 'rate_limited', channel: 'kakao' });
    return NextResponse.json(kakaoErrorResponse('요청이 많아 잠시 쉬고 있어요. 잠시 후 다시 말씀해 주세요.'));
  }

  // 서명 검증은 파싱 전 원문에 대해 계산하므로 본문을 원문과 함께 한 번에 읽는다.
  const parsedBody = await readJsonWithRaw<Record<string, unknown>>(req);
  if (!parsedBody.ok) {
    rl.end({ status: 200, code: 'invalid_json', channel: 'kakao' });
    return NextResponse.json(kakaoErrorResponse('잘못된 요청 형식입니다.'));
  }

  // 인증 실패는 사용자 대화가 아니라 위조·오설정이므로 401로 명확히 거절한다.
  // 어느 단계에서 틀렸는지는 응답에 담지 않고 서버 로그로만 남긴다.
  const auth = authenticateKakao(req.headers, parsedBody.raw);
  if (!auth.ok) {
    rl.end({ status: 401, code: `kakao_auth_${auth.reason}`, channel: 'kakao' });
    return fail('unauthorized', '요청을 검증하지 못했습니다.');
  }

  const parsed = parseKakaoPayload(parsedBody.data);
  if (!parsed) {
    rl.end({ status: 200, code: 'invalid_input', channel: 'kakao' });
    return NextResponse.json(kakaoErrorResponse('발화를 확인하지 못했어요.'));
  }

  const sessionId = `kakao:${parsed.userId}`;
  const sessionHash = hashId(sessionId);

  // 재시도(중복 전달) — 같은 이벤트면 엔진을 다시 돌리지 않고 이전 응답을 그대로 돌려준다.
  const key = kakaoEventKey(req.headers, parsed.userId, parsed.utterance);
  const dup = kakaoDedupe(key);
  if (dup.duplicate) {
    rl.end({ status: 200, code: 'duplicate_delivery', channel: 'kakao', sessionHash });
    return NextResponse.json(dup.response ?? kakaoErrorResponse('앞서 보내주신 요청을 처리하고 있어요. 잠시만 기다려 주세요.'));
  }

  let result;
  try {
    result = await replyToAsync(parsed.utterance, sessionId);
  } catch (e) {
    // 오류를 삼키지 않는다: 모니터링·로그에 남기고 사용자에게는 안전한 안내 말풍선으로 응답한다.
    await captureError(e, { route: '/api/kakao/webhook', method: 'POST', requestId: rl.requestId });
    rl.end({
      status: 200,
      code: 'engine_error',
      channel: 'kakao',
      sessionHash,
      error: e instanceof Error ? e.message : String(e),
    });
    const res = kakaoErrorResponse();
    rememberKakaoResponse(key, res);
    return NextResponse.json(res);
  }

  // 대화 로그(인메모리 스텁) — 영구 저장은 [승인 필요]. 사용자 id는 세션 구분용으로만 사용.
  if (result.source !== 'empty') {
    logTurn({
      sessionId,
      channel: 'kakao',
      message: parsed.utterance,
      reply: result.reply,
      intent: result.intent,
      source: result.source,
      escalate: result.escalate,
      confidence: result.confidence,
    });
  }

  const res = toKakaoResponse(result);
  rememberKakaoResponse(key, res);
  rl.end({
    status: 200,
    channel: 'kakao',
    sessionHash,
    intent: result.intent,
    source: result.source,
    escalate: result.escalate,
    confidence: result.confidence,
    ...(result.llmFailure ? { code: `llm_${result.llmFailure}` } : {}),
  });
  return NextResponse.json(res);
}
