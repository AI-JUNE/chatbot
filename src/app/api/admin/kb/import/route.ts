// 지식 문서 업로드 → 청킹 → KB 후보 변환/등록 API.
// 기본은 미리보기(dry-run)이고, commit:true 일 때만 실제 KB에 반영한다(오등록 방지).
// [승인 필요] 파일 스토리지 업로드·임베딩 색인 — 현재는 텍스트 본문만 받아 인메모리 KB에 등록한다.
import { NextRequest } from 'next/server';
import { bulkUpsertKB } from '@/lib/adminStore';
import { logAudit } from '@/lib/audit';
import { documentToCandidates, MAX_DOC_CHARS, DEFAULT_CHUNK_CHARS } from '@/lib/ingest';
import { ok, fail, readJson, reqStr, optStr, requireAdmin, isAdminAuthed, MAX_IMPORT_BYTES } from '@/lib/http';

export const dynamic = 'force-dynamic';

const MAX_CANDIDATES = 200;

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const parsed = await readJson<{
    text?: unknown;
    title?: unknown;
    category?: unknown;
    maxChars?: unknown;
    commit?: unknown;
  }>(req, MAX_IMPORT_BYTES);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;

  const text = reqStr(body.text, 'text', MAX_DOC_CHARS);
  if (!text.ok) return text.res;
  const title = reqStr(body.title, 'title', 120);
  if (!title.ok) return title.res;
  const category = optStr(body.category, 'category', 40, '문서');
  if (!category.ok) return category.res;

  const rawMax = Number(body.maxChars ?? DEFAULT_CHUNK_CHARS);
  const maxChars = Number.isFinite(rawMax) ? Math.min(Math.max(Math.trunc(rawMax), 120), 2000) : DEFAULT_CHUNK_CHARS;

  const candidates = documentToCandidates(text.value, {
    title: title.value,
    category: category.value,
    maxChars,
  });
  if (candidates.length === 0) {
    return fail('invalid_input', '문서에서 등록할 만한 내용을 찾지 못했습니다. 본문이 너무 짧거나 키워드가 없습니다.');
  }
  if (candidates.length > MAX_CANDIDATES) {
    return fail('invalid_input', `문서가 너무 커서 ${MAX_CANDIDATES}개를 넘는 항목이 생깁니다(현재 ${candidates.length}개). 나눠서 올려주세요.`);
  }

  // 미리보기(기본) — 저장하지 않고 후보만 돌려준다.
  if (body.commit !== true) {
    return ok({ committed: false, count: candidates.length, candidates });
  }

  const result = bulkUpsertKB(
    candidates.map(({ chunkIndex, ...entry }) => {
      void chunkIndex;
      return entry;
    }),
  );
  logAudit({
    action: 'kb.import',
    target: title.value.slice(0, 60),
    detail: `문서 등록: 신규 ${result.created.length} · 갱신 ${result.updated.length} · 실패 ${result.errors.length}`,
    authed: isAdminAuthed(req),
  });
  return ok({
    committed: true,
    created: result.created.length,
    updated: result.updated.length,
    errors: result.errors,
  });
}
