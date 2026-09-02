// 웹 챗 대화 API. 표준 오류 포맷·입력 검증은 lib/http, 유량 제한은 lib/ratelimit, 구조화 로깅은 lib/logger.
import { NextRequest } from 'next/server';
import { replyTo } from '@/lib/chat';
import { logTurn } from '@/lib/convlog';
import { rateGuard } from '@/lib/ratelimit';
import { ok, readJson, optStr, withRequestId } from '@/lib/http';
import { captureError } from '@/lib/monitoring';
import { startRequest, hashId } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// Next.js route 파일은 HTTP 메서드 외 export를 허용하지 않는다(빌드 실패 원인). 모듈 내부 상수로 유지.
const MAX_MESSAGE_LEN = 2000;

export async function POST(req: NextRequest) {
  // 요청 로그: 대화 본문·연락처는 기록하지 않는다(세션은 해시로만 남긴다).
  const rl = startRequest('/api/chat', 'POST', req.headers.get('x-request-id'));

  const limited = rateGuard('chat', req.headers, 60);
  if (limited) {
    rl.end({ status: 429, code: 'rate_limited' });
    return withRequestId(limited, rl.requestId);
  }

  const parsed = await readJson<{ message?: unknown; sessionId?: unknown }>(req);
  if (!parsed.ok) {
    rl.end({ status: parsed.res.status, code: 'invalid_json' });
    return withRequestId(parsed.res, rl.requestId);
  }

  const msg = optStr(parsed.data.message, 'message', MAX_MESSAGE_LEN);
  if (!msg.ok) {
    rl.end({ status: 400, code: 'invalid_input' });
    return withRequestId(msg.res, rl.requestId);
  }
  const sid = optStr(parsed.data.sessionId, 'sessionId', 60, 'anon');
  if (!sid.ok) {
    rl.end({ status: 400, code: 'invalid_input' });
    return withRequestId(sid.res, rl.requestId);
  }

  const message = msg.value;
  const sessionId = sid.value || 'anon';
  const sessionHash = hashId(sessionId);

  let result;
  try {
    result = replyTo(message, sessionId);
  } catch (e) {
    // 대화 엔진 오류는 모니터링·로그에 남기되, 고객에게는 안전한 안내로 응답한다(오류를 삼키지 않는다).
    await captureError(e, { route: '/api/chat', method: 'POST', requestId: rl.requestId });
    rl.end({
      status: 200,
      code: 'engine_error',
      sessionHash,
      source: 'fallback',
      error: e instanceof Error ? e.message : String(e),
    });
    return withRequestId(
      ok({
        sessionId,
        reply: '일시적인 오류가 발생했어요. 잠시 후 다시 시도해 주시거나 "상담원"이라고 입력해 주세요.',
        intent: 'error',
        escalate: true,
        source: 'fallback' as const,
        requestId: rl.requestId,
      }),
      rl.requestId,
    );
  }

  // 대화 로그(인메모리 스텁) — 영구 저장은 [승인 필요]
  if (result.source !== 'empty') {
    logTurn({
      sessionId,
      channel: 'web',
      message,
      reply: result.reply,
      intent: result.intent,
      source: result.source,
      escalate: result.escalate,
      confidence: result.confidence,
    });
  }

  rl.end({
    status: 200,
    sessionHash,
    channel: 'web',
    intent: result.intent,
    source: result.source,
    escalate: result.escalate,
    confidence: result.confidence,
  });
  return withRequestId(ok({ sessionId, ...result }), rl.requestId);
}
