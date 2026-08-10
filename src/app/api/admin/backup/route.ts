// 관리 콘텐츠 백업·복원 API — KB·룰 오버라이드·커스텀 룰만 포함(개인정보 없음).
// GET: JSON 스냅샷 다운로드(x-admin-token 헤더 또는 ?token= 쿼리 — 브라우저 다운로드 지원).
// POST: 스냅샷 업로드로 전체 교체(무효 항목은 건너뜀). ADMIN_TOKEN 미설정 시 개방(게이트 OFF 기준).
import { NextRequest, NextResponse } from 'next/server';
import { exportSnapshot, importSnapshot } from '@/lib/adminStore';
import { logAudit } from '@/lib/audit';
import { ok, fail, readJson, requireAdmin, isAdminAuthed, MAX_IMPORT_BYTES } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req, { allowQueryToken: true });
  if (denied) return denied;
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return new NextResponse(JSON.stringify(exportSnapshot(), null, 2), {
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
  logAudit({
    action: 'backup.restore',
    detail: `스냅샷 복원(kb ${result.kb} · 오버라이드 ${result.overrides} · 커스텀룰 ${result.customRules})`,
    authed: isAdminAuthed(req, true),
  });
  return ok({ kb: result.kb, overrides: result.overrides, customRules: result.customRules });
}
