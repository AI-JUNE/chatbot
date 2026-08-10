// 관리 콘솔 에스컬레이션 API — 목록·상태 변경 + 운영 통계(자동처리율).
// 인증: lib/http requireAdmin. 시크릿은 Vercel 환경변수로만.
import { NextRequest } from 'next/server';
import { listTickets, updateTicket, escalationStats, ESCALATION_STATUSES, EscalationStatus } from '@/lib/escalation';
import { convStats, listTurns } from '@/lib/convlog';
import { logAudit } from '@/lib/audit';
import { ok, fail, readJson, reqStr, optStr, requireAdmin, isAdminAuthed } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const withLogs = req.nextUrl.searchParams.get('logs') === 'true';
  return ok({
    tickets: listTickets(),
    stats: { escalation: escalationStats(), conversation: convStats() },
    ...(withLogs ? { recentTurns: listTurns(30) } : {}),
  });
}

export async function PATCH(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const parsed = await readJson<{ id?: unknown; status?: unknown; note?: unknown }>(req);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;

  const id = reqStr(body.id, 'id', 60);
  if (!id.ok) return id.res;

  let status: EscalationStatus | undefined;
  if (body.status !== undefined) {
    const s = optStr(body.status, 'status', 20);
    if (!s.ok) return s.res;
    if (!ESCALATION_STATUSES.includes(s.value as EscalationStatus)) {
      return fail('invalid_input', `잘못된 상태값입니다(허용: ${ESCALATION_STATUSES.join(', ')}).`);
    }
    status = s.value as EscalationStatus;
  }

  let note: string | undefined;
  if (body.note !== undefined) {
    const n = optStr(body.note, 'note', 1000);
    if (!n.ok) return n.res;
    note = n.value;
  }

  const result = updateTicket(id.value, { status, note });
  if (!result.ok) return fail('not_found', result.error);

  const parts: string[] = [];
  if (status !== undefined) parts.push(`상태→${status}`);
  if (note !== undefined) parts.push('메모 변경');
  logAudit({ action: 'escalation.update', target: id.value, detail: parts.join(', '), authed: isAdminAuthed(req) });
  return ok({ ticket: result.ticket });
}
