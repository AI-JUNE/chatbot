// 파트너(채널)·고객사 귀속 관리 API. 조회·등록·수정만 제공한다.
// 고객사는 삭제하지 않는다 — 귀속 근거가 사라지면 정산 분쟁을 막을 수 없다(해지는 status='churned').
// 파트너 삭제는 연결된 고객사가 없을 때만 가능하다(lib/partners.deletePartner에서 판정).
// 접근 권한: 고원 관리자는 전체, 파트너 담당자(partner_admin)는 **자기 파트너 범위만 조회**하고 쓰기는 못 한다.
// 범위 제한은 lib/rbac.scopeAccountFilter 한 곳에서만 걸린다(조회 화면이 늘어도 범위가 새지 않게).
// [승인 필요] 실제 정산·청구, 파트너 계정 활성화(PARTNER_PORTAL_ENABLED).
import { NextRequest } from 'next/server';
import {
  deletePartner,
  listPartners,
  queryAccounts,
  rollupByPartner,
  upsertAccount,
  upsertPartner,
  defaultFeeRateBp,
  ACCOUNT_STATUS_LABELS,
  LEAD_SOURCE_LABELS,
  PARTNER_STATUS_LABELS,
  type AccountQuery,
  type AccountInput,
  type PartnerInput,
  type AccountStatus,
  type LeadSource,
} from '@/lib/partners';
import { logAudit } from '@/lib/audit';
import { ok, fail, readJson, reqQuery, requirePrincipal, requireWrite } from '@/lib/http';
import { scopeAccountFilter, scopePartners } from '@/lib/rbac';

export const dynamic = 'force-dynamic';

function parseQuery(req: NextRequest): AccountQuery {
  const sp = req.nextUrl.searchParams;
  const partnerId = (sp.get('partnerId') || '').trim();
  const status = (sp.get('status') || '').trim();
  const source = (sp.get('source') || '').trim();
  const q = (sp.get('q') || '').trim().slice(0, 80);
  const filter: AccountQuery = {};
  if (partnerId) filter.partnerId = partnerId === 'direct' ? 'direct' : partnerId;
  if (status === 'prospect' || status === 'contracted' || status === 'churned') filter.status = status as AccountStatus;
  if (source) filter.source = source as LeadSource;
  if (q) filter.q = q;
  return filter;
}

export async function GET(req: NextRequest) {
  const auth = requirePrincipal(req);
  if (!auth.ok) return auth.res;
  const { principal } = auth;
  // 파트너 담당자는 요청한 partnerId와 무관하게 자기 파트너로 고정된다.
  const filter = scopeAccountFilter(principal, parseQuery(req));
  const rollup = rollupByPartner().filter(
    (r) => principal.role === 'admin' || r.partnerId === principal.partnerId,
  );
  return ok({
    role: principal.role,
    scopePartnerId: principal.partnerId,
    canWrite: principal.role === 'admin',
    partners: scopePartners(principal, listPartners()),
    accounts: queryAccounts(filter),
    rollup,
    defaultFeeRateBp: defaultFeeRateBp(),
    labels: { source: LEAD_SOURCE_LABELS, accountStatus: ACCOUNT_STATUS_LABELS, partnerStatus: PARTNER_STATUS_LABELS },
  });
}

export async function POST(req: NextRequest) {
  const auth = requirePrincipal(req);
  if (!auth.ok) return auth.res;
  const readOnly = requireWrite(auth.principal);
  if (readOnly) return readOnly;

  const parsed = await readJson<{ kind?: unknown } & Record<string, unknown>>(req);
  if (!parsed.ok) return parsed.res;
  const authed = auth.principal.authed;
  const kind = parsed.data.kind;

  if (kind === 'partner') {
    const r = upsertPartner(parsed.data as PartnerInput);
    if (!r.ok) return fail('invalid_input', r.error);
    logAudit({
      action: 'partner.upsert',
      target: r.partner.id,
      detail: `${r.created ? '등록' : '수정'}: ${r.partner.name.slice(0, 40)}`,
      authed,
    });
    return ok({ partner: r.partner, created: r.created });
  }

  if (kind === 'account') {
    const r = upsertAccount({ ...(parsed.data as AccountInput), authed });
    if (!r.ok) return fail('invalid_input', r.error);
    const last = r.account.attribution[r.account.attribution.length - 1];
    logAudit({
      action: 'account.upsert',
      target: r.account.id,
      detail: `${r.created ? '등록' : '수정'}: 귀속 ${r.account.partnerId ?? '직접'} / 경로 ${r.account.source}${last ? ` / ${last.note.slice(0, 40)}` : ''}`,
      authed,
    });
    return ok({ account: r.account, created: r.created });
  }

  return fail('invalid_input', 'kind는 "partner" 또는 "account"여야 합니다.');
}

// 파트너 삭제: DELETE /api/admin/partners?partnerId=PTR-0001
export async function DELETE(req: NextRequest) {
  const auth = requirePrincipal(req);
  if (!auth.ok) return auth.res;
  const readOnly = requireWrite(auth.principal);
  if (readOnly) return readOnly;
  const id = reqQuery(req, 'partnerId');
  if (!id.ok) return id.res;
  const r = deletePartner(id.value);
  if (!r.ok) return fail('conflict', r.error);
  logAudit({ action: 'partner.delete', target: id.value, authed: auth.principal.authed });
  return ok({});
}
