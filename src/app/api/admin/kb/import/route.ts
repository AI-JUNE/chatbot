// 지식 문서 업로드 → 청킹 → KB 후보 변환/등록 API.
// 기본은 미리보기(dry-run)이고, commit:true 일 때만 실제 KB에 반영한다(오등록 방지).
// [승인 필요] 파일 스토리지 업로드·임베딩 색인 — 현재는 텍스트 본문만 받아 인메모리 KB에 등록한다.
import { NextRequest } from 'next/server';
import { bulkUpsertKB, docOverlap } from '@/lib/adminStore';
import { logAudit } from '@/lib/audit';
import { documentToCandidates, docIdPrefix, MAX_DOC_CHARS, DEFAULT_CHUNK_CHARS } from '@/lib/ingest';
import { toNfc } from '@/lib/normalize';
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

  // 길이는 **사람이 보는 글자**로 잰다 — 분해형 한글은 한 음절이 코드 2~3개라, 정규화 전에
  // 재면 4만 자짜리 한글 문서가 12만 자로 읽혀 「너무 깁니다」로 돌아간다(DS 42-3).
  const text = reqStr(typeof body.text === 'string' ? toNfc(body.text) : body.text, 'text', MAX_DOC_CHARS);
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

  // 이 문서를 등록하면 지식베이스에서 **무엇이 바뀌는가** (DS 44-1).
  // 미리보기와 등록이 같은 값을 보게 반드시 `bulkUpsertKB` **전에** 잰다 — 등록 뒤에 재면
  // 갈아 끼운 항목이 「남는 조각」과 구분되지 않는다.
  const overlap = docOverlap(docIdPrefix(title.value), candidates.map((c) => c.id), title.value);

  // 미리보기(기본) — 저장하지 않고 후보만 돌려준다.
  if (body.commit !== true) {
    return ok({ committed: false, count: candidates.length, candidates, overlap });
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
    // 남는 조각은 등록 이력에도 남긴다 — 「그때 무엇이 남았는지」를 나중에 감사 로그에서 찾는다.
    detail:
      `문서 등록: 신규 ${result.created.length} · 갱신 ${result.updated.length} · 실패 ${result.errors.length}` +
      (overlap.stale.length ? ` · 지난 등록분 ${overlap.stale.length}건 남음` : ''),
    authed: isAdminAuthed(req),
  });
  return ok({
    committed: true,
    created: result.created.length,
    updated: result.updated.length,
    errors: result.errors,
    overlap,
  });
}
