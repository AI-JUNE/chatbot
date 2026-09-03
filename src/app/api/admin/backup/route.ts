// 관리 콘텐츠 백업·복원 API — KB·룰 오버라이드·커스텀 룰 + 파트너·계약 귀속(모두 개인정보 없음).
// 파트너 스냅샷은 `partners` 키에 통째로 담는다. 이 키가 없는 예전 백업도 그대로 복원되며(하위 호환),
// 그 경우 기존 파트너 데이터를 지우지 않는다 — 복원이 조용한 데이터 삭제가 되면 안 된다.
// GET: JSON 스냅샷 다운로드(x-admin-token 헤더 또는 ?token= 쿼리 — 브라우저 다운로드 지원).
// POST: 스냅샷 업로드로 전체 교체(무효 항목은 건너뜀). ADMIN_TOKEN 미설정 시 개방(게이트 OFF 기준).
import { NextRequest, NextResponse } from 'next/server';
import { exportSnapshot, importSnapshot } from '@/lib/adminStore';
import { exportPartners, importPartners } from '@/lib/partners';
import { logAudit } from '@/lib/audit';
import { ok, fail, readJson, requireAdmin, isAdminAuthed, MAX_IMPORT_BYTES } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req, { allowQueryToken: true });
  if (denied) return denied;
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return new NextResponse(JSON.stringify({ ...exportSnapshot(), partners: exportPartners() }, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="chatbot-admin-backup-${date}.json"`,
      'Cache-Control': 'no-store',
    },
  });
}

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req, { allowQueryToken: true });
  if (denied) return denied;

  const parsed = await readJson<Record<string, unknown>>(req, MAX_IMPORT_BYTES);
  if (!parsed.ok) return parsed.res;

  const result = importSnapshot(parsed.data);
  if (!result.ok) return fail('invalid_input', result.error);

  // 파트너 스냅샷은 있을 때만 복원한다(없으면 기존 데이터 유지). 실패해도 사유를 응답에 담아 삼키지 않는다.
  let partners: { partners: number; accounts: number } | null = null;
  let partnersError: string | null = null;
  const raw = (parsed.data as { partners?: unknown }).partners;
  if (raw && typeof raw === 'object') {
    const r = importPartners(raw);
    if (r.ok) partners = { partners: r.partners, accounts: r.accounts };
    else partnersError = r.error;
  }

  logAudit({
    action: 'backup.restore',
    detail:
      `스냅샷 복원(kb ${result.kb} · 오버라이드 ${result.overrides} · 커스텀룰 ${result.customRules}` +
      (partners ? ` · 파트너 ${partners.partners} · 고객사 ${partners.accounts}` : '') +
      (partnersError ? ' · 파트너 복원 실패' : '') +
      ')',
    authed: isAdminAuthed(req, true),
  });
  return ok({
    kb: result.kb,
    overrides: result.overrides,
    customRules: result.customRules,
    ...(partners ? { partners: partners.partners, accounts: partners.accounts } : {}),
    ...(partnersError ? { partnersError } : {}),
  });
}
