// 관리 콘솔 에스컬레이션 API — 목록·상태 변경 + 운영 통계(자동처리율).
// ADMIN_TOKEN 설정 시 x-admin-token 헤더 필수(시크릿은 Vercel 환경변수로만).
import { NextRequest, NextResponse } from 'next/server';
import { listTickets, updateTicket, escalationStats, ESCALATION_STATUSES, EscalationStatus } from '@/lib/escalation';
import { convStats, listTurns } from '@/lib/convlog';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

function authed(req: NextRequest): boolean {
  return Boolean(process.env.ADMIN_TOKEN) && req.headers.get('x-admin-token') === process.env.ADMIN_TOKEN;
}

function unauthorized(req: NextRequest): NextResponse | null {
  const token = process.env.ADMIN_TOKEN;
  if (token && req.headers.get('x-admin-token') !== token) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  return null;
}

export async function GET(req: NextRequest) {
  const u = unauthorized(req);
  if (u) return u;
  const withLogs = req.nextUrl.searchParams.get('logs') === 'true';
  return NextResponse.json({
    ok: true,
    tickets: listTickets(),
    stats: { escalation: escalationStats(), conversation: convStats() },
    ...(withLogs ? { recentTurns: listTurns(30) } : {}),
  });
}

export async function PATCH(req: NextRequest) {
  const u = unauthorized(req);
  if (u) return u;
  let body: { id?: string; status?: string; note?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }
  const id = (body.id || '').trim();
  if (!id) return NextResponse.json({ ok: false, error: 'id가 필요합니다.' }, { status: 400 });
  if (body.status !== undefined && !ESCALATION_STATUSES.includes(body.status as EscalationStatus)) {
    return NextResponse.json({ ok: false, error: '잘못된 상태값입니다.' }, { status: 400 });
  }
  const result = updateTicket(id, { status: body.status as EscalationStatus | undefined, note: body.note });
  if (!result.ok) return NextResponse.json(result, { status: 404 });
  const parts: string[] = [];
  if (body.status !== undefined) parts.push(`상태→${body.status}`);
  if (body.note !== undefined) parts.push('메모 변경');
  logAudit({ action: 'escalation.update', target: id, detail: parts.join(', '), authed: authed(req) });
  return NextResponse.json(result);
}
