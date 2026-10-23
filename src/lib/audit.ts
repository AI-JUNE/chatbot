// 관리 작업 감사 로그 — 링버퍼(최근 500건) + 영속화(`@/lib/storage`의 audit 네임스페이스).
// 감사 이벤트에는 개인정보·시크릿이 없다(대상 식별자와 요약 문자열만) → 승인 없이 저장한다.
// 저장이 막히거나 실패하면 메모리 링버퍼로 계속 동작하고, 사유는 storageStatus()에 남는다.
// [승인 필요] 외부 SIEM 전송.
// 토큰 값 등 시크릿은 절대 기록하지 않는다(인증 사용 여부만 boolean으로 기록).
import { loadJson, saveJson, savedInfo, scheduleSave, SavedInfo } from '@/lib/storage';
import { csvCell, csvRow } from '@/lib/csv';
import { KST_CSV_NOTE, isReadableInstant, kstDateTime, readInstant } from '@/lib/kst';
import { RESTORE_FORMAT_MESSAGE } from '@/lib/refusal';
import { RetentionInfo, retentionNotes } from '@/lib/retention';

export type AuditAction =
  | 'kb.upsert'
  | 'kb.delete'
  | 'kb.reset'
  | 'kb.import'
  | 'rule.override'
  | 'rule.custom.upsert'
  | 'rule.custom.delete'
  | 'escalation.update'
  | 'backup.restore'
  | 'backup.export'
  | 'conversation.export'
  | 'partner.upsert'
  | 'partner.delete'
  | 'account.upsert'
  | 'settlement.export';

/**
 * 작업 표시명 — 감사 로그 표·필터·CSV 가 **그대로** 보여주는 이름의 단일 출처.
 *
 * `Record<AuditAction, string>` 이므로 작업 종류를 하나 더 만들면 **타입 검사에서 막힌다** —
 * 종전에는 화면이 따로 적어 둔 사전 9개로 이름을 붙이고 없으면 코드를 그렸고, 「사업」 그룹에서
 * 새로 생긴 4종(`partner.upsert`·`partner.delete`·`account.upsert`·`settlement.export`)이
 * 사전에 추가되지 않아 파트너·고객사 편집과 정산 내려받기가 영문 코드로 남았다.
 * 말씨는 화면의 실제 메뉴·버튼 이름에 맞춘다(지식베이스=안내 자료, 기본 규칙/내가 만든 규칙).
 */
export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  'kb.upsert': '안내 자료 등록·수정',
  'kb.delete': '안내 자료 삭제',
  'kb.reset': '안내 자료 초기화',
  'kb.import': '문서 업로드 등록',
  'rule.override': '기본 규칙 변경',
  'rule.custom.upsert': '내가 만든 규칙 등록·수정',
  'rule.custom.delete': '내가 만든 규칙 삭제',
  'escalation.update': '상담원 요청 처리',
  'backup.restore': '백업 복원',
  'backup.export': '백업 내려받기',
  'conversation.export': '대화 기록 내려받기',
  'partner.upsert': '파트너 등록·수정',
  'partner.delete': '파트너 삭제',
  'account.upsert': '고객사 등록·수정',
  'settlement.export': '정산 리포트 내려받기',
};

/** 모르는 코드까지 화면에 코드로 내보내지 않는다(복원된 옛 스냅샷 대비). */
export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action as AuditAction] ?? '관리 작업';
}

export interface AuditEvent {
  id: string;
  at: string; // ISO
  action: AuditAction;
  target: string; // 대상 식별자(kb id, intent, 티켓 id 등)
  detail: string; // 사람이 읽는 요약(개인정보·시크릿 미포함)
  authed: boolean; // x-admin-token 인증을 거친 요청인지(토큰 값은 기록 안 함)
}

const MAX_EVENTS = 500;
let events: AuditEvent[] = [];
let seq = 0;

/**
 * **언제부터의 기록을 들고 있는가** (DS 48-1) — 대화 기록(DS 43-1)과 같은 경계다.
 *
 * 왜 필요한가: 이 목록은 「누가 무엇을 바꿨는가」의 **증거**인데 최근 500건만 들고 있고,
 * 한도를 넘기면 가장 오래된 기록이 말없이 사라진다. 종전에는 그 사실을 어디에서도 말하지
 * 않았다 — 화면은 「최근 100건」이라고만 적었고(그 100건이 서버가 든 전부인지 일부인지
 * 말하지 않았다), 내려받은 파일은 한도를 한 글자도 말하지 않아 받는 사람이 전체 이력으로
 * 읽었다. 「그 기간에 아무 변경이 없었다」와 「그 기간 기록이 없다」는 전혀 다른 사실이다.
 *
 *  - 기동·초기화 직후: 지금(그 전의 일은 **모른다** — 재기동으로 통째로 비었을 수 있다)
 *  - 한도에 걸려 버린 순간: 남아 있는 가장 오래된 기록의 시각
 *  - 보관된 기록을 읽어 들인 직후: 그 파일이 적어 둔 경계(없는 옛 파일이면 남은 가장 오래된 기록)
 *  - 백업을 합친 직후: **그대로다** (DS 58-1) — 더하기만 하므로 경계 이후가 성한 것은 변하지
 *    않고, 경계보다 앞선 줄은 `mergedFrom` 으로 따로 적는다(뒤로 물리면 그 사이 구멍이
 *    「빠진 것이 없다」로 읽힌다)
 */
let knownFrom = new Date().toISOString();
/** 한도에 걸려 **버린 적이 있는가**. 화면이 사유를 달리 적는다. */
let droppedAny = false;
/**
 * 경계보다 **앞선 기록도 들고 있는가**(ISO, 없으면 null) — 합친 백업이 들고 온 것이다 (DS 58-1).
 * 경계와 이 시각 사이는 「빠진 것이 없다」가 아니라 **파일에 적혀 있던 것만** 있는 구간이다.
 */
let mergedFrom: string | null = null;

/**
 * 경계는 **앞으로만 간다** (DS 58-1).
 *
 * 뒤로 물리면 「이 시각 이후는 빠진 것이 없다」가 거짓이 된다 — 합치는 문은 더하기만 하므로
 * 파일이 들고 온 옛 기록과 지금 들고 있는 기록 사이에 빈 구간이 있을 수 있다.
 */
function advanceKnownFrom(at: string | undefined): void {
  if (at && at > knownFrom) knownFrom = at;
}

/** 경계보다 앞선 줄을 지금도 들고 있는가를 다시 센다 — 한도에 걸려 버려지면 사라진다. */
function syncMergedFrom(): void {
  const oldest = events[0]?.at;
  mergedFrom = oldest && oldest < knownFrom ? oldest : null;
}

/** 한도를 넘긴 만큼 가장 오래된 것을 버리고, 버렸으면 경계를 그 자리로 옮긴다. */
function trimToLimit(): void {
  if (events.length > MAX_EVENTS) {
    events = events.slice(-MAX_EVENTS);
    advanceKnownFrom(events[0]?.at);
    droppedAny = true;
  }
  syncMergedFrom();
}

export function logAudit(input: { action: AuditAction; target?: string; detail?: string; authed?: boolean }): AuditEvent {
  seq += 1;
  const e: AuditEvent = {
    id: `A-${String(seq).padStart(6, '0')}`,
    at: new Date().toISOString(),
    action: input.action,
    target: String(input.target ?? '').slice(0, 100),
    detail: String(input.detail ?? '').slice(0, 300),
    authed: input.authed === true,
  };
  events.push(e);
  trimToLimit();
  scheduleSave(AUDIT_NS, exportAudit);
  return { ...e };
}

/** 보관 중인 관리 작업 기록 수. 화면이 「전체 몇 건 중 몇 건」을 말할 때 쓴다. */
export function auditCount(): number {
  return events.length;
}

/**
 * 「언제부터 몇 건까지 들고 있는가」 (DS 48-1) — 화면·파일이 모수를 밝히는 단일 출처.
 * 대화 기록의 `turnRetention()` 과 **같은 모양**이다(두 화면이 같은 사실을 같은 틀로 말한다).
 */
export function auditRetention(): RetentionInfo {
  // 평소에는 이 칸이 없다 — 경계가 곧 가장 오래된 기록이다 (DS 58-1).
  return { limit: MAX_EVENTS, kept: events.length, knownFrom, dropped: droppedAny, ...(mergedFrom ? { mergedFrom } : {}) };
}

/** 최신순 목록(기본 100건). */
export function listAudit(limit = 100): AuditEvent[] {
  return events.slice(-limit).reverse().map((e) => ({ ...e }));
}

/**
 * 전체 보존분 CSV(시간순) — 엑셀 호환 UTF-8 BOM은 라우트에서 붙인다.
 * 열 이름은 받는 사람(한국의 운영자)이 읽는 말로 적고, 작업은 이름과 코드를 함께 싣는다
 * — 사람은 이름을 읽고, 다른 시스템에 옮겨 담을 때는 코드를 쓴다.
 *
 * 「시각」은 **한국 시간**이다 (DS 40-1). 종전에는 `at` 원문(ISO·UTC)을 그대로 실었다 —
 * 화면은 브라우저 시간대로 그리고 파일 이름도 한국 날짜인데 행만 UTC 여서, 한국 자정~오전 9시의
 * 작업은 엑셀에서 **전날**로 분류됐다. 기계가 보는 원문은 「시각(ISO)」 열에 그대로 남긴다.
 */
export function auditToCsv(): string {
  const header = csvRow(['번호', '시각', '작업', '작업코드', '대상', '내용', '인증', '시각(ISO)']);
  const rows = events.map((e) =>
    csvRow([
      e.id,
      kstDateTime(e.at),
      auditActionLabel(e.action),
      e.action,
      e.target,
      e.detail,
      e.authed ? '로그인됨' : '인증 없이 수행',
      e.at,
    ]),
  );
  // 파일이 제 시각 기준을 말하지 않으면 받는 사람은 9시간 어긋난 줄 모른 채 그 열로 거른다.
  // 「무엇까지 담겼는가」도 같은 자리에서 말한다 (DS 48-1) — 종전에는 한도를 한 글자도 적지
  // 않아, 받는 사람이 이 파일을 **전체 이력**으로 읽었다. 문장은 대화 기록 CSV 와 한 벌이다.
  const notes = [KST_CSV_NOTE, ...retentionNotes('관리 작업', auditRetention())];
  return [header, ...rows, '', ...notes.map((n) => csvCell(`# ${n}`))].join('\r\n');
}

export function resetAudit(): void {
  events = [];
  seq = 0;
  knownFrom = new Date().toISOString();
  droppedAny = false;
  mergedFrom = null;
  scheduleSave(AUDIT_NS, exportAudit);
}

export const AUDIT_NS = 'audit';

export interface AuditSnapshot {
  version: 1;
  savedAt: string;
  seq: number;
  /**
   * 들고 있던 **보관 경계**(ISO) — 「이 시각 이후는 빠진 것이 없다」 (DS 58-1).
   *
   * 왜 파일에 적는가: 이 파일에는 기록의 **목록**만 있어서, 읽어 들이는 쪽은 경계를 가장
   * 오래된 줄에서 미루어 짚는다(DS 48-1). 백업을 합쳐 경계보다 앞선 줄이 섞인 상태에서는
   * 그 짐작이 틀리고, 콜드 스타트 한 번에 그 사이 구간이 다시 「빠진 것이 없다」로 읽힌다.
   * 옛 파일에는 이 칸이 없다 — 그때는 종전대로 가장 오래된 줄을 경계로 본다.
   *
   * 사람이 올린 백업의 이 값은 **쓰지 않는다**(`mergeAudit` 은 목록만 읽는다) — 남의
   * 인스턴스가 들고 있던 경계이고, 합친 결과의 경계는 받는 쪽이 제 것으로 셈한다.
   */
  knownFrom?: string;
  events: AuditEvent[];
}

export function exportAudit(): AuditSnapshot {
  return { version: 1, savedAt: new Date().toISOString(), seq, knownFrom, events: events.map((e) => ({ ...e })) };
}

/**
 * 복원이 받아들이는 작업 코드 — **표시명 사전에서 끌어온다** (DS 40-3).
 *
 * 종전에는 같은 목록을 손으로 한 번 더 적어 두었다(두 벌). 작업 종류를 하나 더 만들면 타입
 * 검사는 `AUDIT_ACTION_LABELS` 만 보므로 통과하는데, 이 사본에 빠진 코드는 복원 때 **조용히
 * 버려졌다** — 백업을 되돌린 운영자는 그 작업을 누가 언제 했는지 영원히 알 수 없다.
 * 「규칙은 한 곳에」는 마스킹(DS 39-3)·상한(DS 38-x)에서 세운 것과 같은 규칙이다.
 */
const ACTIONS = new Set<string>(Object.keys(AUDIT_ACTION_LABELS));

/** 들어온 기록 중 **읽을 수 있는 것만** 골라 같은 모양으로. 형식이 아예 아니면 null. */
function readEvents(input: unknown): AuditEvent[] | null {
  if (!input || typeof input !== 'object') return null;
  const snap = input as Partial<AuditSnapshot>;
  if (!Array.isArray(snap.events)) return null;
  const out: AuditEvent[] = [];
  for (const raw of snap.events) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as AuditEvent;
    if (typeof e.id !== 'string' || !e.id.trim()) continue;
    if (typeof e.action !== 'string' || !ACTIONS.has(e.action)) continue;
    out.push({
      id: e.id,
      /**
       * 시각 칸은 **읽을 수 있을 때만** 들고 온다 (DS 54-3).
       *
       * 이 값이 걸려 있는 자리가 셋이다: 보관 경계(`knownFrom` → 내려받기 꼬리 주석), 파일의
       * 「시각」 칸(`kstDateTime` 은 읽을 수 없으면 **빈 칸**을 돌려준다 — 지어내지 않는다),
       * 그리고 합칠 때 줄을 세우는 자리(`mergeAudit` 는 글자 비교로 앞뒤를 가린다). 시각인 척하는
       * 글자가 한 줄 들어오면 셋이 함께 어긋나는데, 어긋났다고 말하는 화면은 어디에도 없다.
       */
      at: readInstant(e.at, new Date().toISOString()),
      action: e.action as AuditAction,
      target: String(e.target ?? '').slice(0, 100),
      detail: String(e.detail ?? '').slice(0, 300),
      authed: e.authed === true,
    });
  }
  return out;
}

/** 번호가 뒤에 다시 쓰이지 않게 — 들고 있는 가장 큰 번호 뒤에서 이어 센다. */
function syncSeq(snapSeq: unknown): void {
  const maxSeq = events.reduce((m, e) => {
    const n = Number(String(e.id).replace(/[^0-9]/g, ''));
    return Number.isFinite(n) && n > m ? n : m;
  }, seq);
  seq = typeof snapSeq === 'number' && snapSeq > maxSeq ? snapSeq : maxSeq;
}

/**
 * 보관된 기록 **읽어 들이기**(기동 때) — 들고 있는 것을 통째로 갈아 끼운다.
 * 디스크가 곧 그 인스턴스의 상태인 자리라서 덮어쓰는 것이 맞다. 사람이 올린 백업은
 * 이 문이 아니라 `mergeAudit` 을 지난다(증거를 덮는 경로를 열지 않는다 · DS 48-3).
 */
export function importAudit(input: unknown): { ok: true; count: number } | { ok: false; error: string } {
  const restored = readEvents(input);
  if (!restored) return { ok: false, error: RESTORE_FORMAT_MESSAGE };
  events = restored.slice(-MAX_EVENTS);
  /**
   * 경계는 **파일이 적어 두었으면 그것**이고, 없으면 남은 가장 오래된 기록이다
   * (DS 48-1 → 58-1). 옛 파일에는 이 칸이 없어 종전처럼 짐작한다.
   */
  const saved = (input as Partial<AuditSnapshot>).knownFrom;
  knownFrom = isReadableInstant(saved) ? readInstant(saved, '') : events[0]?.at || new Date().toISOString();
  droppedAny = restored.length > MAX_EVENTS;
  // 적어 둔 경계보다 앞선 줄이 섞여 있었다면 그 사실도 함께 되살아난다 (DS 58-1).
  syncMergedFrom();
  seq = 0;
  syncSeq((input as Partial<AuditSnapshot>).seq);
  return { ok: true, count: events.length };
}

/** 두 기록이 **같은 한 건인가** — 내용이 한 글자라도 다르면 다른 건이다(합칠 때만 쓴다). */
function identityOf(e: AuditEvent): string {
  return [e.id, e.at, e.action, e.target, e.detail, e.authed ? '1' : '0'].join('\u0000');
}

export interface MergeAuditResult {
  ok: true;
  /** 이번에 더해진 건수. */
  added: number;
  /** 이미 들고 있어 더하지 않은 건수. */
  skipped: number;
  /** 합친 뒤 보관 중인 건수. */
  kept: number;
  /** 합친 결과가 디스크까지 갔는가(더한 것이 없으면 쓰지 않는다 · DS 47-1). */
  saved?: SavedInfo;
}

/**
 * 백업 속 변경 이력을 **합친다** (DS 48-3) — 덮어쓰지 않는다.
 *
 * 왜 합치는가: 변경 이력은 「누가 무엇을 바꿨는가」의 증거다. 복원이 이것을 갈아 끼우면
 * **백업을 뜬 뒤에 일어난 모든 일의 기록이 사라진다** — 복원 자체가 그 기록을 지우는 일이
 * 되어, 복원으로 무엇을 덮었는지 나중에 되짚을 수 없다. 고객사 삭제 API 를 만들지 않은 것과
 * 같은 규칙이다(정산 근거를 지울 수 있는 경로를 열지 않는다).
 *
 * 그래서 이 문은 **더하기만** 한다: 파일에만 있는 기록을 넣고, 이미 들고 있는 것은 건너뛰고,
 * 시각순으로 세운 뒤 한도를 넘긴 만큼만 가장 오래된 쪽을 버린다(그 사실은 경계에 남는다).
 * 번호(`id`)는 인스턴스마다 1번부터 다시 매겨지므로 같은 번호가 서로 다른 일을 가리킬 수
 * 있다 — 그래서 같은 건인지는 **번호가 아니라 내용 전체**로 가린다.
 */
export function mergeAudit(input: unknown): MergeAuditResult | { ok: false; error: string } {
  const incoming = readEvents(input);
  if (!incoming) return { ok: false, error: RESTORE_FORMAT_MESSAGE };
  const seen = new Set(events.map(identityOf));
  let added = 0;
  for (const e of incoming) {
    const key = identityOf(e);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(e);
    added += 1;
  }
  const skipped = incoming.length - added;
  if (added > 0) {
    // 시각순으로 세운다 — 목록·CSV·한도 버리기가 모두 「뒤가 최신」을 전제로 돈다.
    events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    /**
     * **경계는 뒤로 물리지 않는다** (DS 58-1).
     *
     * 종전에는 합친 뒤 가장 오래된 기록을 그대로 경계로 적었다(`knownFrom = events[0].at`).
     * 이 문은 **더하기만** 하므로, 1월에 뜬 백업을 10월에 올리면 들고 있는 것은 「1월 두 줄 +
     * 10월 몇 줄」인데 경계는 1월을 가리켰다 — 화면은 「1월 1일 이후」라고 적고 내려받은 파일은
     * 「그보다 앞선 날이 비어 있는 것은 기록 없음」이라고 적어, **1월부터 10월까지가 성한
     * 기록**으로 읽혔다. 그 사이는 한 줄도 들고 있지 않다(그 인스턴스는 그때 돌지 않았거나
     * 재시작으로 비었다). 「누가 무엇을 바꿨는가」의 증거에서 없는 것을 없다고 말하지 못하면
     * **그 사이에 아무 변경이 없었다**는 거짓이 남는다(§13 의 「없는 수」와 같은 자리다).
     *
     * 그래서 경계는 그대로 두고, 그보다 앞선 줄은 `mergedFrom` 으로 따로 적는다(`trimToLimit`
     * 이 다시 센다) — 화면·파일이 두 사실을 갈라 말한다.
     */
    trimToLimit();
    syncSeq((input as Partial<AuditSnapshot>).seq);
  }
  return {
    ok: true,
    added,
    skipped,
    kept: events.length,
    // 「합쳤습니다」는 디스크를 보고 나온 말이어야 한다 (DS 47-1).
    ...(added > 0 ? { saved: savedInfo(saveJson(AUDIT_NS, exportAudit())) } : {}),
  };
}

// 기동 시 복원(없거나 손상되면 빈 상태로 시작 — 사유는 storageStatus()에 남는다).
(function loadPersisted() {
  const r = loadJson(AUDIT_NS);
  if (!r.ok) return;
  importAudit(r.data);
})();
