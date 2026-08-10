// 감사 로그 API — 최근 관리 작업 이력 조회(JSON)·CSV 다운로드.
// 인증: x-admin-token 헤더 또는 CSV 다운로드용 ?token= (lib/http requireAdmin, allowQueryToken).
import { NextRequest, NextResponse } from 'next/server';
import { listAudit, auditToCsv } from '@/lib/audit';
import { ok, intQuery, requireAdmin } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req, { allowQueryToken: true });
  if (denied) return denied;

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
  return ok({ events: listAudit(intQuery(req, 'limit', 100, 1, 500)) });
}
