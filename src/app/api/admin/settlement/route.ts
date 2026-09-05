// 파트너 정산 리포트 조회·CSV 내보내기.
// 권한: 고원 관리자는 전체, 파트너 담당자는 자기 파트너 범위만(lib/rbac.scopeAccountFilter).
// 금액은 사람이 입력한 월 이용료와 설정된 수수료율이 있을 때만 산출한다 — 근거가 없으면 빈 값이다.
// [승인 필요] 실제 청구·지급 연동.
import { NextRequest, NextResponse } from 'next/server';
import { buildSettlement, settlementToCsv, currentMonth } from '@/lib/settlement';
import { queryAccounts, type AccountQuery } from '@/lib/partners';
import { scopeAccountFilter } from '@/lib/rbac';
import { logAudit } from '@/lib/audit';
import { ok, fail, requirePrincipal } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  // CSV는 브라우저 다운로드 링크로 열리므로 쿼리 토큰을 허용한다(감사 로그로 접근을 남긴다).
  const wantsCsv = req.nextUrl.searchParams.get('format') === 'csv';
  const auth = requirePrincipal(req, { allowQueryToken: wantsCsv });
  if (!auth.ok) return auth.res;
  const { principal } = auth;

  const month = (req.nextUrl.searchParams.get('month') || currentMonth()).trim();
  const partnerId = (req.nextUrl.searchParams.get('partnerId') || '').trim();

  const base: AccountQuery = {};
  if (partnerId && partnerId !== 'direct') base.partnerId = partnerId;
  const filter = scopeAccountFilter(principal, base);

  const r = buildSettlement({ month, accounts: queryAccounts(filter) });
  if (!r.ok) return fail('invalid_input', r.error);

  if (wantsCsv) {
    logAudit({
      action: 'settlement.export',
      target: month,
      detail: `범위 ${principal.role === 'admin' ? partnerId || '전체' : principal.partnerId} / 대상 ${r.report.totals.accounts}건`,
      authed: principal.authed,
    });
    // UTF-8 BOM: 엑셀 한글 깨짐 방지
    return new NextResponse('\uFEFF' + settlementToCsv(r.report), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="settlement-${month}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  return ok({ role: principal.role, scopePartnerId: principal.partnerId, report: r.report });
}
