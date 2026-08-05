import { NextRequest, NextResponse } from 'next/server';
import { replyTo } from '@/lib/chat';
import { logTurn } from '@/lib/convlog';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: { message?: string; sessionId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }
  const message = body.message ?? '';
  const sessionId = (body.sessionId || 'anon').trim().slice(0, 60) || 'anon';
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
  return NextResponse.json({ ok: true, sessionId, ...result });
}
