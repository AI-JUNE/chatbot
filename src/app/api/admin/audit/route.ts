// 감사 로그 API — 최근 관리 작업 이력 조회(JSON)·CSV 다운로드.
// 인증: x-admin-token 헤더 또는 CSV 다운로드용 ?token= (lib/http requireAdmin, allowQueryToken).
import { NextRequest, NextResponse } from 'next/server';
import { listAudit, auditActionLabel, auditToCsv } from '@/lib/audit';
import { ok, intQuery, requireAdmin } from '@/lib/http';
import { kstStamp } from '@/lib/kst';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req, { allowQueryToken: true });
  if (denied) return denied;

  if (req.nextUrl.searchParams.get('format') === 'csv') {
    // 파일 이름의 날짜는 받는 사람(한국의 운영자)이 읽는 날짜다 — 서버 시간대가 아니라 KST.
    const date = kstStamp();
    return new NextResponse('\uFEFF' + auditToCsv(), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="chatbot-audit-${date}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  }
  // 작업 이름은 코드 어휘를 아는 쪽(`@/lib/audit`)에서 붙여 보낸다 — 화면이 사전을 따로 들고 있으면
  // 작업 종류가 늘 때 영문 코드가 그대로 표·필터에 남는다.
  const events = listAudit(intQuery(req, 'limit', 100, 1, 500)).map((e) => ({
    ...e,
    actionLabel: auditActionLabel(e.action),
  }));
  return ok({ events });
}
