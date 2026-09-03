// 관리 작업 감사 로그 — 링버퍼(최근 500건) + 영속화(`@/lib/storage`의 audit 네임스페이스).
// 감사 이벤트에는 개인정보·시크릿이 없다(대상 식별자와 요약 문자열만) → 승인 없이 저장한다.
// 저장이 막히거나 실패하면 메모리 링버퍼로 계속 동작하고, 사유는 storageStatus()에 남는다.
// [승인 필요] 외부 SIEM 전송.
// 토큰 값 등 시크릿은 절대 기록하지 않는다(인증 사용 여부만 boolean으로 기록).
import { loadJson, scheduleSave } from '@/lib/storage';

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
  | 'account.upsert';

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

function csvCell(v: string | boolean): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 전체 보존분 CSV(시간순) — 엑셀 호환 UTF-8 BOM은 라우트에서 붙인다. */
export function auditToCsv(): string {
  const header = 'id,at,action,target,detail,authed';
  const rows = events.map((e) => [e.id, e.at, e.action, e.target, e.detail, e.authed].map(csvCell).join(','));
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
  'partner.upsert', 'partner.delete', 'account.upsert',
]);

/** 스냅샷 복원. 알 수 없는 action·형식 위반 항목은 건너뛴다. */
export function importAudit(input: unknown): { ok: true; count: number } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: '유효한 JSON 객체가 아닙니다.' };
  const snap = input as Partial<AuditSnapshot>;
  if (!Array.isArray(snap.events)) return { ok: false, error: 'events 배열이 필요합니다.' };
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
