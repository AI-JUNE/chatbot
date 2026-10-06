// 관리 작업 감사 로그 — 링버퍼(최근 500건) + 영속화(`@/lib/storage`의 audit 네임스페이스).
// 감사 이벤트에는 개인정보·시크릿이 없다(대상 식별자와 요약 문자열만) → 승인 없이 저장한다.
// 저장이 막히거나 실패하면 메모리 링버퍼로 계속 동작하고, 사유는 storageStatus()에 남는다.
// [승인 필요] 외부 SIEM 전송.
// 토큰 값 등 시크릿은 절대 기록하지 않는다(인증 사용 여부만 boolean으로 기록).
import { loadJson, scheduleSave } from '@/lib/storage';
import { csvRow } from '@/lib/csv';
import { RESTORE_FORMAT_MESSAGE } from '@/lib/refusal';

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
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  scheduleSave(AUDIT_NS, exportAudit);
  return { ...e };
}

/** 최신순 목록(기본 100건). */
export function listAudit(limit = 100): AuditEvent[] {
  return events.slice(-limit).reverse().map((e) => ({ ...e }));
}

/**
 * 전체 보존분 CSV(시간순) — 엑셀 호환 UTF-8 BOM은 라우트에서 붙인다.
 * 열 이름은 받는 사람(한국의 운영자)이 읽는 말로 적고, 작업은 이름과 코드를 함께 싣는다
 * — 사람은 이름을 읽고, 다른 시스템에 옮겨 담을 때는 코드를 쓴다.
 */
export function auditToCsv(): string {
  const header = csvRow(['번호', '시각', '작업', '작업코드', '대상', '내용', '인증']);
  const rows = events.map((e) =>
    csvRow([e.id, e.at, auditActionLabel(e.action), e.action, e.target, e.detail, e.authed ? '로그인됨' : '인증 없이 수행']),
  );
  return [header, ...rows].join('\r\n');
}

export function resetAudit(): void {
  events = [];
  seq = 0;
  scheduleSave(AUDIT_NS, exportAudit);
}

export const AUDIT_NS = 'audit';

export interface AuditSnapshot {
  version: 1;
  savedAt: string;
  seq: number;
  events: AuditEvent[];
}

export function exportAudit(): AuditSnapshot {
  return { version: 1, savedAt: new Date().toISOString(), seq, events: events.map((e) => ({ ...e })) };
}

const ACTIONS = new Set<string>([
  'kb.upsert', 'kb.delete', 'kb.reset', 'kb.import',
  'rule.override', 'rule.custom.upsert', 'rule.custom.delete',
  'escalation.update', 'backup.restore',
  'partner.upsert', 'partner.delete', 'account.upsert', 'settlement.export',
]);

/** 스냅샷 복원. 알 수 없는 action·형식 위반 항목은 건너뛴다. */
export function importAudit(input: unknown): { ok: true; count: number } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: RESTORE_FORMAT_MESSAGE };
  const snap = input as Partial<AuditSnapshot>;
  if (!Array.isArray(snap.events)) return { ok: false, error: RESTORE_FORMAT_MESSAGE };
  const restored: AuditEvent[] = [];
  for (const raw of snap.events) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as AuditEvent;
    if (typeof e.id !== 'string' || !e.id.trim()) continue;
    if (typeof e.action !== 'string' || !ACTIONS.has(e.action)) continue;
    restored.push({
      id: e.id,
      at: typeof e.at === 'string' && e.at ? e.at : new Date().toISOString(),
      action: e.action as AuditAction,
      target: String(e.target ?? '').slice(0, 100),
      detail: String(e.detail ?? '').slice(0, 300),
      authed: e.authed === true,
    });
  }
  events = restored.slice(-MAX_EVENTS);
  const maxSeq = events.reduce((m, e) => {
    const n = Number(String(e.id).replace(/[^0-9]/g, ''));
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  seq = typeof snap.seq === 'number' && snap.seq > maxSeq ? snap.seq : maxSeq;
  return { ok: true, count: events.length };
}

// 기동 시 복원(없거나 손상되면 빈 상태로 시작 — 사유는 storageStatus()에 남는다).
(function loadPersisted() {
  const r = loadJson(AUDIT_NS);
  if (!r.ok) return;
  importAudit(r.data);
})();
