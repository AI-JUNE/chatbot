// 관리 작업 감사 로그(스텁) — 인메모리 링버퍼(최근 500건).
// [승인 필요] DB 영구 저장·외부 SIEM 전송 — 전까지 서버 메모리에만 유지(재시작 시 소실).
// 토큰 값 등 시크릿은 절대 기록하지 않는다(인증 사용 여부만 boolean으로 기록).

export type AuditAction =
  | 'kb.upsert'
  | 'kb.delete'
  | 'kb.reset'
  | 'rule.override'
  | 'rule.custom.upsert'
  | 'rule.custom.delete'
  | 'escalation.update'
  | 'backup.restore';

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
}
