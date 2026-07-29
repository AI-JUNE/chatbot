import { NextRequest, NextResponse } from 'next/server';
import { replyTo } from '@/lib/chat';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: { message?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }
  const result = replyTo(body.message ?? '');
  return NextResponse.json({ ok: true, ...result });
}
