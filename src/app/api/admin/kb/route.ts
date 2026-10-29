// 관리 콘솔 KB API. 인메모리 스토어(스텁) — [승인 필요] DB 영구 저장.
// 인증: lib/http requireAdmin(ADMIN_TOKEN + ADMIN_AUTH_REQUIRED 게이트). 시크릿은 Vercel 환경변수로만.
import { NextRequest } from 'next/server';
import { listKB, upsertKB, deleteKB, resetKB, kbRev, saveAdminNow, type KBUpsertInput } from '@/lib/adminStore';
import { logAudit } from '@/lib/audit';
import { ok, fail, readJson, reqQuery, optStr, requireAdmin, isAdminAuthed } from '@/lib/http';
import {
  AUDIT_NAME_LEN,
  ellipsize,
  KB_ANSWER_LEN,
  KB_CATEGORY_LEN,
  KB_QUESTION_LEN,
  KB_SOURCE_LEN,
  KEYWORDS_LEN,
} from '@/lib/limits';
import { toNfc } from '@/lib/normalize';
import { STALE_TARGET_MESSAGE } from '@/lib/refusal';

export const dynamic = 'force-dynamic';

/**
 * **이 창구가 받는 칸과 그 상한** (DS 74-1).
 *
 * 종전에는 이 라우트가 들어온 본문을 그대로 `upsertKB` 에 넘겼다 — 길이도, 보이지 않는 글자도,
 * 글자가 아닌 값도 아무도 재지 않았다. 돌려서 받아 냈다: 3만 자 답변이 그대로 저장되고(고객
 * 말풍선에 한 덩이로 나간다), 제로폭 공백 한 자만 적은 질문이 필수 검사를 통과하고,
 * `{"question": 123}` 은 `.trim is not a function` 으로 **표준 오류 본문도 없는 500** 이 된다.
 * 이 제품의 거의 모든 쓰기 경로가 지나는 자(`optStr` — `cleanText` + 상한 · DS 63-1)를
 * 이 한 창구만 지나지 않고 있었다.
 */
const KB_FIELDS: readonly (readonly [string, number])[] = [
  ['id', 60],
  ['category', KB_CATEGORY_LEN],
  ['question', KB_QUESTION_LEN],
  ['answer', KB_ANSWER_LEN],
  ['source', KB_SOURCE_LEN],
  ['baseRev', 120],
];

/**
 * 길이는 **정규화 뒤에** 잰다 — 분해형 한글은 한 음절이 코드 2~3개다(DS 42-3).
 * 문서 등록 창구가 본문을 재는 방식과 같은 자다(`toNfc` → `reqStr`).
 */
function nfcIfText(v: unknown): unknown {
  return typeof v === 'string' ? toNfc(v) : v;
}

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

  const parsed = await readJson<Record<string, unknown> & { reset?: boolean }>(req);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;

  if (body.reset === true) {
    resetKB();
    logAudit({ action: 'kb.reset', detail: '기본 KB로 초기화', authed: isAdminAuthed(req) });
    return ok({ entries: listKB(), saved: saveAdminNow() });
  }

  // 들어온 칸을 재서 넘긴다 (DS 74-1) — **보내지 않은 칸은 보내지 않은 대로** 둔다
  // (`upsertKB` 는 「없는 칸」과 「빈 칸」을 다르게 다룬다: 수정에서 빈 칸은 지금 값을 지킨다).
  const input: Record<string, string> = {};
  for (const [key, max] of KB_FIELDS) {
    if (body[key] === undefined) continue;
    const f = optStr(nfcIfText(body[key]), key, max);
    if (!f.ok) return f.res;
    input[key] = f.value;
  }
  if (body.keywords !== undefined) {
    // 화면은 **한 칸에 쉼표로** 적는다 — 그래서 상한도 칸 하나의 수다(배열로 보내는 호출자는
    // 같은 칸에 적은 것과 같게 잰다). 쪼개고 소문자로 내리는 일은 저장소가 한다.
    const raw = Array.isArray(body.keywords) ? body.keywords.map((k) => String(k)).join(',') : body.keywords;
    const f = optStr(nfcIfText(raw), 'keywords', KEYWORDS_LEN);
    if (!f.ok) return f.res;
    input.keywords = f.value;
  }
  const result = upsertKB(input as KBUpsertInput);
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
