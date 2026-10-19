// 관리 콘솔 KB API. 인메모리 스토어(스텁) — [승인 필요] DB 영구 저장.
// 인증: lib/http requireAdmin(ADMIN_TOKEN + ADMIN_AUTH_REQUIRED 게이트). 시크릿은 Vercel 환경변수로만.
import { NextRequest } from 'next/server';
import { listKB, upsertKB, deleteKB, resetKB, kbRev, saveAdminNow } from '@/lib/adminStore';
import { logAudit } from '@/lib/audit';
import { ok, fail, readJson, reqQuery, requireAdmin, isAdminAuthed } from '@/lib/http';
import { STALE_TARGET_MESSAGE } from '@/lib/refusal';

export const dynamic = 'force-dynamic';

/**
 * 목록에 **그때의 모습**(`rev`)을 함께 싣는다 (DS 46-1).
 * 저장소에 적는 값이 아니라 내용에서 만드는 값이라, 백업·스냅샷 모양은 그대로다.
 */
export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  return ok({ entries: listKB().map((e) => ({ ...e, rev: kbRev(e) })) });
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
    return ok({ entries: listKB(), saved: saveAdminNow() });
  }
  const result = upsertKB(body);
  if (!result.ok) {
    // 그 사이 다른 화면에서 바뀐 것은 **입력이 틀린 것이 아니다** (DS 46-1) — 화면이 적던 글을
    // 버리지 않고 다음 길(지금 값 불러오기·그대로 덮어쓰기)을 주도록 사유와 현재 값을 함께 보낸다.
    if (result.conflict) {
      return fail('conflict', result.error, {
        conflict: result.conflict,
        ...(result.current ? { current: { ...result.current, rev: kbRev(result.current) } } : {}),
      });
    }
    return fail('invalid_input', result.error);
  }
  logAudit({
    action: 'kb.upsert',
    target: result.entry.id,
    detail: `${result.created ? '생성' : '수정'}: ${result.entry.question.slice(0, 60)}`,
    authed: isAdminAuthed(req),
  });
  // 「저장되었습니다」는 **디스크를 보고 나온 말**이어야 한다 (DS 47-1) — 보관이 막혔거나
  // 실패했으면 화면이 그 사실을 말할 수 있게 결과를 함께 보낸다.
  return ok(
    { entry: { ...result.entry, rev: kbRev(result.entry) }, created: result.created, saved: saveAdminNow() },
    result.created ? 201 : 200,
  );
}

export async function DELETE(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const id = reqQuery(req, 'id');
  if (!id.ok) return id.res;
  if (!deleteKB(id.value)) return fail('not_found', STALE_TARGET_MESSAGE);
  logAudit({ action: 'kb.delete', target: id.value, authed: isAdminAuthed(req) });
  return ok({ saved: saveAdminNow() });
}
