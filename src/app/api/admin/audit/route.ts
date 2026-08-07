// 감사 로그 API — 최근 관리 작업 이력 조회(JSON)·CSV 다운로드.
// ADMIN_TOKEN 설정 시 x-admin-token 헤더(또는 CSV 다운로드용 ?token=) 필수.
import { NextRequest, NextResponse } from 'next/server';
import { listAudit, auditToCsv } from '@/lib/audit';

export const dynamic = 'force-dynamic';

function authorized(req: NextRequest): boolean {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return true;
  const given = req.headers.get('x-admin-token') || req.nextUrl.searchParams.get('token');
  return given === token;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  if (req.nextUrl.searchParams.get('format') === 'csv') {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return new NextResponse('\uFEFF' + auditToCsv(), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="chatbot-audit-${date}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  }
  const limitRaw = Number(req.nextUrl.searchParams.get('limit') || 100);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 500) : 100;
  return NextResponse.json({ ok: true, events: listAudit(limit) });
}
