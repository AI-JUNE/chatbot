// 상담원 연결(에스컬레이션) 접수 API — 고객용(위젯에서 호출).
// 인메모리 스텁 — [승인 필요] 실제 상담원 알림·DB 영구 저장.
import { NextRequest } from 'next/server';
import { createTicket, getTicket, STATUS_LABELS } from '@/lib/escalation';
import { rateGuard } from '@/lib/ratelimit';
import { ok, fail, readJson, optStr, reqQuery } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const limited = rateGuard('escalation', req.headers, 20);
  if (limited) return limited;

  const parsed = await readJson<Record<string, unknown>>(req);
  if (!parsed.ok) return parsed.res;

  const sessionId = optStr(parsed.data.sessionId, 'sessionId', 60, 'anon');
  if (!sessionId.ok) return sessionId.res;
  const reason = optStr(parsed.data.reason, 'reason', 60, 'user_request');
  if (!reason.ok) return reason.res;
  const message = optStr(parsed.data.message, 'message', 1000);
  if (!message.ok) return message.res;
  const contact = optStr(parsed.data.contact, 'contact', 100);
  if (!contact.ok) return contact.res;

  const { ticket, created } = createTicket({
    sessionId: sessionId.value,
    reason: reason.value,
    message: message.value,
    contact: contact.value || undefined,
  });
  return ok(
    {
      created,
      ticket: { id: ticket.id, status: ticket.status, statusLabel: STATUS_LABELS[ticket.status], createdAt: ticket.createdAt },
    },
    created ? 201 : 200,
  );
}

export async function GET(req: NextRequest) {
  const id = reqQuery(req, 'id');
  if (!id.ok) return id.res;
  const t = getTicket(id.value);
  if (!t) return fail('not_found', '해당 접수번호가 없습니다.');
  return ok({
    ticket: { id: t.id, status: t.status, statusLabel: STATUS_LABELS[t.status], createdAt: t.createdAt, updatedAt: t.updatedAt },
  });
}
