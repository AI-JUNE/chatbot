// 웹 챗 대화 API. 표준 오류 포맷·입력 검증은 lib/http, 유량 제한은 lib/ratelimit.
import { NextRequest } from 'next/server';
import { replyTo } from '@/lib/chat';
import { logTurn } from '@/lib/convlog';
import { rateGuard } from '@/lib/ratelimit';
import { ok, readJson, optStr } from '@/lib/http';

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
  const result = replyTo(message, sessionId);

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
