// 웹 챗 대화 API. 표준 오류 포맷·입력 검증은 lib/http, 유량 제한은 lib/ratelimit.
import { NextRequest } from 'next/server';
import { replyTo } from '@/lib/chat';
import { logTurn } from '@/lib/convlog';
import { rateGuard } from '@/lib/ratelimit';
import { ok, readJson, optStr } from '@/lib/http';
import { captureError } from '@/lib/monitoring';

export const dynamic = 'force-dynamic';

// Next.js route 파일은 HTTP 메서드 외 export를 허용하지 않는다(빌드 실패 원인). 모듈 내부 상수로 유지.
const MAX_MESSAGE_LEN = 2000;

export async function POST(req: NextRequest) {
  const limited = rateGuard('chat', req.headers, 60);
  if (limited) return limited;

  const parsed = await readJson<{ message?: unknown; sessionId?: unknown }>(req);
  if (!parsed.ok) return parsed.res;

  const msg = optStr(parsed.data.message, 'message', MAX_MESSAGE_LEN);
  if (!msg.ok) return msg.res;
  const sid = optStr(parsed.data.sessionId, 'sessionId', 60, 'anon');
  if (!sid.ok) return sid.res;

  const message = msg.value;
  const sessionId = sid.value || 'anon';

  let result;
  try {
    result = replyTo(message, sessionId);
  } catch (e) {
    // 대화 엔진 오류는 모니터링에 보고하되, 고객에게는 안전한 안내로 응답한다.
    await captureError(e, { route: '/api/chat', method: 'POST', sessionId });
    return ok({
      sessionId,
      reply: '일시적인 오류가 발생했어요. 잠시 후 다시 시도해 주시거나 "상담원"이라고 입력해 주세요.',
      intent: 'error',
      escalate: true,
      source: 'fallback' as const,
    });
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
    });
  }
  return ok({ sessionId, ...result });
}
