// 지식 문서 업로드 → 청킹 → KB 후보 변환/등록 API.
// 기본은 미리보기(dry-run)이고, commit:true 일 때만 실제 KB에 반영한다(오등록 방지).
// [승인 필요] 파일 스토리지 업로드·임베딩 색인 — 현재는 텍스트 본문만 받아 인메모리 KB에 등록한다.
import { NextRequest } from 'next/server';
import { bulkUpsertKB, docOverlap, saveAdminNow } from '@/lib/adminStore';
import { logAudit } from '@/lib/audit';
import { ingestDocument, docIdPrefix, MAX_DOC_CHARS, DEFAULT_CHUNK_CHARS, CHUNK_CHARS_MIN, CHUNK_CHARS_MAX } from '@/lib/ingest';
import { parseNumber } from '@/lib/num';
import { AUDIT_NAME_LEN, ellipsize } from '@/lib/limits';
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

  // 수를 읽는 자는 `lib/num.parseNumber` 하나다 (DS 65-1). 종전에는 `Number()` 로 읽고
  // 범위를 **조용히 당겼다** — 「한 항목 길이」는 운영자가 고른 값이고, 그 값으로 나눈 결과를
  // 미리보기에서 눈으로 확인하는 자리다(DS 44-2). 다른 값으로 나눠 놓고 아무 말도 하지 않으면
  // 화면이 보여 준 것과 등록되는 것이 달라진다. 비어 있으면 기본값, 틀렸으면 그렇게 말한다.
  const chunk = parseNumber(body.maxChars, { min: CHUNK_CHARS_MIN, max: CHUNK_CHARS_MAX, integer: true });
  if (!chunk.ok && chunk.issue !== 'blank') {
    return fail('invalid_input', `한 항목 길이는 ${CHUNK_CHARS_MIN}~${CHUNK_CHARS_MAX} 사이 숫자로 적어주세요.`);
  }
  const maxChars = chunk.ok ? chunk.value : DEFAULT_CHUNK_CHARS;

  /**
   * 나눈 조각과 **빠진 조각**을 함께 받는다 (DS 58-3).
   *
   * 검색어를 하나도 뽑지 못한 조각은 후보에서 걸러진다 — 거르는 것은 맞지만, 종전에는 그 수가
   * 응답에 없어 화면이 「후보 N개」만 적었다. 운영자는 올린 문서가 통째로 들어간 줄 알았고,
   * 빠진 대목(숫자·기호·한 글자만 있는 표, 첫 제목 앞의 머리글)을 물어 온 손님은 계속 기본
   * 안내를 받았다. 미리보기 번호(`#n`)에 난 구멍이 유일한 단서였다.
   */
  const ingested = ingestDocument(text.value, {
    title: title.value,
    category: category.value,
    maxChars,
  });
  const candidates = ingested.candidates;
  if (candidates.length === 0) {
    // 전부 걸러진 경우에는 **그렇게 말한다** — 「본문이 너무 짧다」는 사실이 아니다(DS 42-3 이
    // 분해형 한글에서 들었던 그 말이다). 왜 걸렸는지와 무엇을 고치면 되는지를 함께 적는다.
    return fail(
      'invalid_input',
      ingested.chunks > 0
        ? `문서를 ${ingested.chunks}조각으로 나눴지만 모든 조각에서 검색에 쓸 낱말을 찾지 못했습니다. 조각마다 두 글자 이상인 낱말이 하나는 있어야 등록됩니다(숫자·기호·한 글자만 있는 표는 등록되지 않습니다).`
        : '문서에서 등록할 만한 내용을 찾지 못했습니다. 본문이 너무 짧거나 키워드가 없습니다.',
    );
  }
  if (candidates.length > MAX_CANDIDATES) {
    return fail('invalid_input', `문서가 너무 커서 ${MAX_CANDIDATES}개를 넘는 항목이 생깁니다(현재 ${candidates.length}개). 나눠서 올려주세요.`);
  }

  // 이 문서를 등록하면 지식베이스에서 **무엇이 바뀌는가** (DS 44-1).
  // 미리보기와 등록이 같은 값을 보게 반드시 `bulkUpsertKB` **전에** 잰다 — 등록 뒤에 재면
  // 갈아 끼운 항목이 「남는 조각」과 구분되지 않는다.
  const overlap = docOverlap(docIdPrefix(title.value), candidates.map((c) => c.id), title.value);

  // 미리보기(기본) — 저장하지 않고 후보만 돌려준다. 「무엇이 빠졌는가」도 같이 간다(DS 58-3).
  if (body.commit !== true) {
    return ok({ committed: false, count: candidates.length, candidates, overlap, chunks: ingested.chunks, dropped: ingested.dropped });
  }

  const result = bulkUpsertKB(
    candidates.map(({ chunkIndex, ...entry }) => {
      void chunkIndex;
      return entry;
    }),
  );
  logAudit({
    action: 'kb.import',
    // 운영자가 적은 문서 제목 — 줄일 때 **줄였다고 적는다** (DS 62-3).
    target: ellipsize(title.value, AUDIT_NAME_LEN),
    // 남는 조각은 등록 이력에도 남긴다 — 「그때 무엇이 남았는지」를 나중에 감사 로그에서 찾는다.
    detail:
      `문서 등록: 신규 ${result.created.length} · 갱신 ${result.updated.length} · 실패 ${result.errors.length}` +
      (overlap.stale.length ? ` · 지난 등록분 ${overlap.stale.length}건 남음` : '') +
      // 들어가지 않은 조각도 남긴다 (DS 58-3) — 「그때 무엇이 빠졌는지」를 나중에 묻게 되는 자리다.
      (ingested.dropped.length ? ` · 검색어 없어 제외 ${ingested.dropped.length}조각` : ''),
    authed: isAdminAuthed(req),
  });
  return ok({
    committed: true,
    created: result.created.length,
    updated: result.updated.length,
    errors: result.errors,
    overlap,
    // 등록한 뒤에도 같은 자리에서 「무엇이 빠졌는가」를 말한다 (DS 58-3 · DS 44-1 과 같은 규칙).
    chunks: ingested.chunks,
    dropped: ingested.dropped,
    // 여러 건을 한 번에 넣었어도 쓰기는 한 번이다 — 그 한 번의 결과를 함께 말한다(DS 47-1).
    saved: saveAdminNow(),
  });
}
