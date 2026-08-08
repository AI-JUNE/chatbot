// 상담원 연결(에스컬레이션) 접수 API — 고객용(위젯에서 호출).
// 인메모리 스텁 — [승인 필요] 실제 상담원 알림·DB 영구 저장.
import { NextRequest, NextResponse } from 'next/server';
import { createTicket, getTicket, STATUS_LABELS } from '@/lib/escalation';
import { checkRate, rateLimitBody } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const rate = checkRate('escalation', req.headers, 20);
  if (!rate.allowed) return NextResponse.json(rateLimitBody(rate), { status: 429, headers: { 'Retry-After': String(rate.retryAfterSec) } });
  let body: { sessionId?: string; reason?: string; message?: string; contact?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }
  const { ticket, created } = createTicket(body);
  return NextResponse.json(
    { ok: true, created, ticket: { id: ticket.id, status: ticket.status, statusLabel: STATUS_LABELS[ticket.status], createdAt: ticket.createdAt } },
    { status: created ? 201 : 200 },
  );
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id') || '';
  if (!id) return NextResponse.json({ ok: false, error: 'id가 필요합니다.' }, { status: 400 });
  const t = getTicket(id);
  if (!t) return NextResponse.json({ ok: false, error: '해당 접수번호가 없습니다.' }, { status: 404 });
  return NextResponse.json({ ok: true, ticket: { id: t.id, status: t.status, statusLabel: STATUS_LABELS[t.status], createdAt: t.createdAt, updatedAt: t.updatedAt } });
}
