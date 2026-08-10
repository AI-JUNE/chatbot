// 관리 콘솔 KB API. 인메모리 스토어(스텁) — [승인 필요] DB 영구 저장.
// 인증: lib/http requireAdmin(ADMIN_TOKEN + ADMIN_AUTH_REQUIRED 게이트). 시크릿은 Vercel 환경변수로만.
import { NextRequest } from 'next/server';
import { listKB, upsertKB, deleteKB, resetKB } from '@/lib/adminStore';
import { logAudit } from '@/lib/audit';
import { ok, fail, readJson, reqQuery, requireAdmin, isAdminAuthed } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  return ok({ entries: listKB() });
}

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const parsed = await readJson<Record<string, unknown> & { reset?: boolean } & Parameters<typeof upsertKB>[0]>(req);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;

  if (body.reset === true) {
    resetKB();
    logAudit({ action: 'kb.reset', detail: '기본 KB로 초기화', authed: isAdminAuthed(req) });
    return ok({ entries: listKB() });
  }
  const result = upsertKB(body);
  if (!result.ok) return fail('invalid_input', result.error);
  logAudit({
    action: 'kb.upsert',
    target: result.entry.id,
    detail: `${result.created ? '생성' : '수정'}: ${result.entry.question.slice(0, 60)}`,
    authed: isAdminAuthed(req),
  });
  return ok({ entry: result.entry, created: result.created }, result.created ? 201 : 200);
}

export async function DELETE(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const id = reqQuery(req, 'id');
  if (!id.ok) return id.res;
  if (!deleteKB(id.value)) return fail('not_found', '해당 id가 없습니다.');
  logAudit({ action: 'kb.delete', target: id.value, authed: isAdminAuthed(req) });
  return ok({});
}
