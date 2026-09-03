// 파트너(채널)·고객사 귀속 관리 API. 조회·등록·수정만 제공한다.
// 고객사는 삭제하지 않는다 — 귀속 근거가 사라지면 정산 분쟁을 막을 수 없다(해지는 status='churned').
// 파트너 삭제는 연결된 고객사가 없을 때만 가능하다(lib/partners.deletePartner에서 판정).
// [승인 필요] 실제 정산·청구, 파트너 계정 로그인(partner_admin 권한).
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
import { ok, fail, readJson, reqQuery, requireAdmin, isAdminAuthed } from '@/lib/http';

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
  const denied = requireAdmin(req);
  if (denied) return denied;
  return ok({
    partners: listPartners(),
    accounts: queryAccounts(parseQuery(req)),
    rollup: rollupByPartner(),
    defaultFeeRateBp: defaultFeeRateBp(),
    labels: { source: LEAD_SOURCE_LABELS, accountStatus: ACCOUNT_STATUS_LABELS, partnerStatus: PARTNER_STATUS_LABELS },
  });
}

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const parsed = await readJson<{ kind?: unknown } & Record<string, unknown>>(req);
  if (!parsed.ok) return parsed.res;
  const authed = isAdminAuthed(req);
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
  const denied = requireAdmin(req);
  if (denied) return denied;
  const id = reqQuery(req, 'partnerId');
  if (!id.ok) return id.res;
  const r = deletePartner(id.value);
  if (!r.ok) return fail('conflict', r.error);
  logAudit({ action: 'partner.delete', target: id.value, authed: isAdminAuthed(req) });
  return ok({});
}
