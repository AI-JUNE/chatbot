// 테넌트(고객사 프리셋) 지식 조회 — 읽기 전용.
// 배포된 인스턴스가 "지금 무엇을 근거로 답하는가"를 관리 콘솔에서 확인하기 위한 창구다.
// 편집은 제공하지 않는다(원본은 data/*.json 파일). 응답에 비밀값·개인정보는 없다.
import { NextRequest } from 'next/server';
import { ok, fail, requireAdmin } from '@/lib/http';
import { tenantDetail, tenantIds, tenantStatus } from '@/lib/tenantKB';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const id = req.nextUrl.searchParams.get('id');
  if (!id) return ok({ tenants: tenantStatus(), ids: tenantIds() });

  const detail = tenantDetail(id);
  if (!detail) return fail('not_found', '등록되지 않은 테넌트입니다.');
  return ok({ tenant: detail });
}
