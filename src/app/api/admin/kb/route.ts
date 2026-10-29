// 관리 콘솔 KB API. 인메모리 스토어(스텁) — [승인 필요] DB 영구 저장.
// 인증: lib/http requireAdmin(ADMIN_TOKEN + ADMIN_AUTH_REQUIRED 게이트). 시크릿은 Vercel 환경변수로만.
import { NextRequest } from 'next/server';
import { listKB, upsertKB, deleteKB, resetKB, kbRev, saveAdminNow } from '@/lib/adminStore';
import { logAudit } from '@/lib/audit';
import { ok, fail, readJson, reqQuery, requireAdmin, isAdminAuthed } from '@/lib/http';
import { AUDIT_NAME_LEN, ellipsize } from '@/lib/limits';
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
    // 운영자가 적은 질문은 길이가 열려 있다 — 줄일 때 **줄였다고 적는다** (DS 62-3).
    // 아무것도 바뀌지 않은 저장을 「수정」이라 적지 않는다 (DS 72-3) — 변경 이력은 **일어난 일**이다.
    detail: `${result.duplicate ? '같은 내용이 이미 있어 새로 만들지 않음' : result.created ? '생성' : '수정'}: ${ellipsize(result.entry.question, AUDIT_NAME_LEN)}`,
    authed: isAdminAuthed(req),
  });
  // 「저장되었습니다」는 **디스크를 보고 나온 말**이어야 한다 (DS 47-1) — 보관이 막혔거나
  // 실패했으면 화면이 그 사실을 말할 수 있게 결과를 함께 보낸다.
  return ok(
    {
      entry: { ...result.entry, rev: kbRev(result.entry) },
      created: result.created,
      // 「다시 시도」가 만들려던 쌍둥이를 막았다는 사실 (DS 72-3) — 화면이 다른 말을 적는다.
      ...(result.duplicate ? { duplicate: true } : {}),
      saved: saveAdminNow(),
    },
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
