// 관리 콘텐츠 백업·복원 API — KB·룰 오버라이드·커스텀 룰 + 파트너·계약 귀속(모두 개인정보 없음).
// 파트너 스냅샷은 `partners` 키에 통째로 담는다. 이 키가 없는 예전 백업도 그대로 복원되며(하위 호환),
// 그 경우 기존 파트너 데이터를 지우지 않는다 — 복원이 조용한 데이터 삭제가 되면 안 된다.
// GET: JSON 스냅샷 다운로드(x-admin-token 헤더 또는 ?token= 쿼리 — 브라우저 다운로드 지원).
// POST: 스냅샷 업로드로 전체 교체(무효 항목은 건너뜀). ADMIN_TOKEN 미설정 시 개방(게이트 OFF 기준).
import { NextRequest, NextResponse } from 'next/server';
import { exportSnapshot, importSnapshot } from '@/lib/adminStore';
import { exportPartners, importPartners } from '@/lib/partners';
import { logAudit, exportAudit, mergeAudit } from '@/lib/audit';
import { ok, fail, readJson, requireAdmin, isAdminAuthed, MAX_IMPORT_BYTES } from '@/lib/http';
import { kstStamp } from '@/lib/kst';
import type { SavedInfo } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req, { allowQueryToken: true });
  if (denied) return denied;
  // 파일 이름의 날짜는 받는 사람(한국의 운영자)이 읽는 날짜다 — 서버 시간대가 아니라 KST.
  // 운영자는 이 파일들을 이름순으로 정리한다(백업은 날짜가 곧 식별자다).
  const date = kstStamp();
  const snapshot = exportSnapshot();
  const partners = exportPartners();
  // 되돌린 일(`backup.restore`)만 남기고 **꺼내 간 일**은 남기지 않았다 (DS 40-3) — 이 파일
  // 하나로 배포 전체를 다른 곳에 세울 수 있다(안내 자료·규칙·파트너·고객사 계약 귀속).
  logAudit({
    action: 'backup.export',
    detail: `스냅샷 내려받기(안내 자료 ${snapshot.kb.length}건 · 파트너 ${partners.partners.length} · 고객사 ${partners.accounts.length})`,
    authed: isAdminAuthed(req, true),
  });
  /**
   * 변경 이력도 함께 싣는다 (DS 48-3). **기록을 남긴 뒤에** 뜨므로 이 파일은 자기 자신을
   * 꺼내 간 사실까지 담는다.
   *
   * 종전에는 이 파일에 안내 자료·규칙·파트너만 들어 있었다. 그런데 보관이 막힌 환경(읽기전용
   * FS — 서버리스의 기본값)에서 저장소 상태 카드와 저장 실패 안내가 운영자에게 하라고 말하는
   * 일이 바로 「백업 내려받기」다(DS 47-1). 즉 **그 말을 따라도 변경 이력은 들고 나올 수 없었다** —
   * 「누가 무엇을 바꿨는가」의 증거만 인스턴스 메모리에 남아 다음 콜드 스타트에 사라졌다.
   */
  const audit = exportAudit();
  return new NextResponse(JSON.stringify({ ...snapshot, partners, audit }, null, 2), {
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
  let partners: { partners: number; accounts: number; orphans: number } | null = null;
  let partnersError: string | null = null;
  let partnersSaved: SavedInfo | null = null;
  const raw = (parsed.data as { partners?: unknown }).partners;
  if (raw && typeof raw === 'object') {
    const r = importPartners(raw);
    if (r.ok) {
      partners = { partners: r.partners, accounts: r.accounts, orphans: r.orphans };
      partnersSaved = r.saved ?? null;
    } else partnersError = r.error;
  }

  /**
   * 변경 이력은 **덮지 않고 합친다** (DS 48-3) — 파일에만 있는 기록만 더한다.
   *
   * 다른 칸과 달리 이 칸은 통째로 갈아 끼우지 않는다. 변경 이력은 「누가 무엇을 바꿨는가」의
   * 증거라, 복원이 이것을 덮으면 **백업을 뜬 뒤에 일어난 모든 일의 기록이 사라진다** — 복원
   * 자체가 그 기록을 지우는 일이 된다. 이 키가 없는 예전 백업은 아무 일도 하지 않는다.
   */
  let auditAdded = 0;
  let auditSaved: SavedInfo | null = null;
  const rawAudit = (parsed.data as { audit?: unknown }).audit;
  if (rawAudit && typeof rawAudit === 'object') {
    const a = mergeAudit(rawAudit);
    if (a.ok) {
      auditAdded = a.added;
      auditSaved = a.saved ?? null;
    }
    // 합치지 못한 사유는 따로 말하지 않는다 — 안내 자료·규칙은 이미 복원되었고, 이 칸은
    // 「더하지 못했다」가 전부다(기존 기록은 그대로다). 결과의 `auditAdded 0` 이 그 사실이다.
  }

  // 복원한 것이 **디스크까지 갔는가** (DS 47-1). 하나라도 보관되지 않으면 보관되지
  // 않았다고 말한다 — 화면은 「복원 완료」 뒤에 그 사실을 덧붙인다.
  const saved = !result.saved?.persisted
    ? result.saved
    : partnersSaved && !partnersSaved.persisted
      ? partnersSaved
      : auditSaved && !auditSaved.persisted
        ? auditSaved
        : { persisted: true };

  logAudit({
    action: 'backup.restore',
    detail:
      `스냅샷 복원(kb ${result.kb} · 오버라이드 ${result.overrides} · 커스텀룰 ${result.customRules}` +
      (partners ? ` · 파트너 ${partners.partners} · 고객사 ${partners.accounts}` : '') +
      // 귀속이 가리키는 파트너가 이 파일에 없는 고객사는 **말해야 한다** (DS 53-3) —
      // 종전에는 그 건들을 직접 계약으로 바꿔 두고 복원 기록에도 한 글자 남기지 않았다.
      (partners && partners.orphans ? ` · 귀속 파트너 없음 ${partners.orphans}` : '') +
      (auditAdded ? ` · 변경 이력 ${auditAdded} 추가` : '') +
      (partnersError ? ' · 파트너 복원 실패' : '') +
      (saved && !saved.persisted ? ' · 서버 보관 실패' : '') +
      ')',
    authed: isAdminAuthed(req, true),
  });
  return ok({
    kb: result.kb,
    overrides: result.overrides,
    customRules: result.customRules,
    ...(partners ? { partners: partners.partners, accounts: partners.accounts } : {}),
    /** 귀속이 가리키는 파트너를 이 파일에서 찾을 수 없는 고객사 수 — 화면이 그 사실을 적는다 (DS 53-3). */
    ...(partners && partners.orphans ? { orphanAccounts: partners.orphans } : {}),
    ...(partnersError ? { partnersError } : {}),
    /** 덮은 것이 아니라 **더한** 수다 — 화면이 그 말로 적는다 (DS 48-3). */
    auditAdded,
    ...(saved ? { saved } : {}),
  });
}
