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
import { getSession, updateSession, newVisitorSessionId } from '@/lib/session';
import { getTicket, isClosedStatus } from '@/lib/escalation';
import {
  KAKAO_LIVE,
  KAKAO_TOO_LONG_TEXT,
  authenticateKakao,
  kakaoDedupe,
  kakaoErrorResponse,
  kakaoEventKey,
  parseKakaoPayload,
  rememberKakaoResponse,
  toKakaoResponse,
} from '@/lib/kakao';
import { checkRate } from '@/lib/ratelimit';
import { ok, fail, readJsonWithRaw, isAdminAuthed } from '@/lib/http';
import { startRequest, hashId } from '@/lib/logger';
import { captureError } from '@/lib/monitoring';

export const dynamic = 'force-dynamic';

/**
 * 헬스체크·상태 확인용(민감정보 없음). 시크릿 값은 노출하지 않고 설정 여부만 알린다.
 *
 * **서명 검증이 걸려 있는지는 아무에게나 말하지 않는다** (DS 49-2). 이 주소는 카카오가 부르는
 * 자리라 인증이 없고, 종전에는 `signature.configured`·`required` 를 그대로 실어 보냈다 —
 * 지금 배포본의 그 값은 둘 다 false 이므로(시크릿 미설정 · [승인 필요]) 이 응답은
 * 「서명 없이 보낸 요청도 받는다」를 밖에 알리는 안내문이었다. 그 사실을 아는 사람은
 * 가짜 대화를 넣어 **대화 기록·접수에 없는 사실을 남길 수 있다**(POST 는 시크릿이 없으면
 * 검증을 건너뛴다 — 그렇게 하기로 정한 설정이지만, 광고할 일은 아니다).
 * `live`·`mode` 는 그대로 둔다 — 등록한 쪽이 「이 URL 이 응답하는가」를 보는 값이다.
 */
export async function GET(req: NextRequest) {
  return ok({
    channel: 'kakao',
    live: KAKAO_LIVE,
    mode: KAKAO_LIVE ? 'live' : 'stub',
    // 토큰을 맞춘 사람에게만 적는다(게이트 OFF 로 통과되는 경우는 세지 않는다 · `/api/health` 와 같은 규칙).
    ...(isAdminAuthed(req)
      ? {
          signature: {
            configured: Boolean(process.env.KAKAO_WEBHOOK_SECRET),
            required: process.env.KAKAO_SIGNATURE_REQUIRED === 'true',
          },
        }
      : {}),
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
  if (!parsed.ok) {
    // 너무 긴 발화는 「확인하지 못했어요」가 아니다 — 상한을 말하고 다음 길을 준다(DS 38-1).
    // 잘라서 반쪽 질문에 답하지 않는다: 고객은 자기 말이 줄어든 줄 모른 채 다른 답을 받는다.
    const tooLong = parsed.reason === 'too_long';
    rl.end({ status: 200, code: tooLong ? 'utterance_too_long' : 'invalid_input', channel: 'kakao' });
    return NextResponse.json(kakaoErrorResponse(tooLong ? KAKAO_TOO_LONG_TEXT : '발화를 확인하지 못했어요.'));
  }

  /**
   * 사용자 id 가 없으면 **한 번 쓰는 식별자**를 발급한다 (DS 51-2).
   *
   * 종전에는 `parseKakaoPayload` 가 `'kakao-anon'` 을 지어내 `kakao:kakao-anon` 한 세션에
   * 전부 몰아넣었다 — id 를 보내지 않은 요청들이 서로의 최근 대화·연락처·접수를 공유했고,
   * 세션당 접수 재사용 규칙에 걸려 **서로 모르는 사람의 접수가 한 건으로 합쳐졌다**.
   * 중복 전달 판정 키(`kakaoEventKey`)는 페이로드의 값을 그대로 쓰므로 재전달에도 변하지 않는다.
   */
  const sessionId = parsed.userId ? `kakao:${parsed.userId}` : newVisitorSessionId('kakao');
  const sessionHash = hashId(sessionId);
  // 이 대화가 어디서 왔는지 세션에 남긴다 — 상담원 이관 요약이 회신 창구를 그대로 받아 쓴다.
  updateSession(sessionId, { channel: 'kakao' });

  // 재시도(중복 전달) — 같은 이벤트면 엔진을 다시 돌리지 않고 이전 응답을 그대로 돌려준다.
  const key = kakaoEventKey(req.headers, parsed.userId, parsed.utterance);
  const dup = kakaoDedupe(key);
  if (dup.duplicate) {
    rl.end({ status: 200, code: 'duplicate_delivery', channel: 'kakao', sessionHash });
    return NextResponse.json(dup.response ?? kakaoErrorResponse('앞서 보내주신 요청을 처리하고 있어요. 잠시만 기다려 주세요.'));
  }

  const startedAt = Date.now();
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
      // 카카오 채널에는 테넌트 임베드 옵션이 없다 — 기본 구성(고원 자료)으로 답한다(DS 36-1).
      tenant: null,
      message: parsed.utterance,
      reply: result.reply,
      intent: result.intent,
      source: result.source,
      escalate: result.escalate,
      confidence: result.confidence,
      latencyMs: Date.now() - startedAt,
    });
  }

  /**
   * 이 대화가 **이미 접수해 둔 상태인가** — 카카오에는 버튼을 숨기는 위젯 화면이 없으므로
   * 어댑터가 그 사실을 알아야 접수를 다시 권하지 않는다(DS 37-2, 위젯의 DS 35-2 와 같은 판정).
   *
   * 세션에 적힌 접수번호만 넘기지 않는다 (DS 51-3) — 그 값은 끝까지 남으므로, 운영자가 그
   * 접수를 완료·취소한 뒤에도 「상담원이 순서대로 연락드릴게요」라고 **현재형으로** 말하고
   * 「상담원 연결」 버튼까지 감췄다. 저장소에서 **지금 모습**을 읽어 넘긴다(이 창구는 서버 안이라
   * 위젯처럼 조회 API 를 거칠 일이 없다). 번호가 가리키는 접수가 사라졌으면 들고 있지 않는다.
   */
  const filedId = getSession(sessionId).ticketId;
  const filedTicket = filedId ? getTicket(filedId) : undefined;
  const res = toKakaoResponse(result, {
    filedTicket: filedTicket
      ? {
          id: filedTicket.id,
          closed: isClosedStatus(filedTicket.status),
          contactOnFile: Boolean(filedTicket.contact),
        }
      : null,
  });
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
