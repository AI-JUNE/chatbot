// 상담원 연결(에스컬레이션) 접수 API — 고객용(위젯에서 호출).
// 인메모리 스텁 — [승인 필요] 실제 상담원 알림·DB 영구 저장.
import { NextRequest } from 'next/server';
import { createTicket, getTicket, queuePosition, toReasonCode, STATUS_LABELS } from '@/lib/escalation';
import { buildHandoffSummary } from '@/lib/handoff';
import { getSession, updateSession } from '@/lib/session';
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

  // 이관 요약은 세션 문맥(최근 대화·수집 슬롯)에서 규칙 기반으로 생성한다. 본문은 마스킹을 통과한다.
  const reasonCode = toReasonCode(reason.value);
  const ctx = getSession(sessionId.value);
  const slots = { ...(ctx.slots ?? {}), ...(contact.value ? { contact: contact.value } : {}) };
  const summary = buildHandoffSummary({
    sessionId: sessionId.value,
    channel: 'web',
    reason: reasonCode,
    turns: ctx.turns ?? [],
    slots,
    pendingSlots: slots.contact ? [] : ['contact'],
  }).text;

  const { ticket, created } = createTicket({
    sessionId: sessionId.value,
    reason: reason.value,
    message: message.value,
    contact: contact.value || undefined,
    summary,
  });
  updateSession(sessionId.value, { ticketId: ticket.id, handoffReason: reasonCode, ...(contact.value ? { slots } : {}) });

  const q = queuePosition(ticket.id);
  return ok(
    {
      created,
      ticket: {
        id: ticket.id,
        status: ticket.status,
        statusLabel: STATUS_LABELS[ticket.status],
        reasonCode: ticket.reasonCode,
        createdAt: ticket.createdAt,
      },
      ...(q ? { queue: q } : {}),
    },
    created ? 201 : 200,
  );
}

export async function GET(req: NextRequest) {
  const id = reqQuery(req, 'id');
  if (!id.ok) return id.res;
  const t = getTicket(id.value);
  if (!t) return fail('not_found', '해당 접수번호가 없습니다.');
  const q = queuePosition(t.id);
  return ok({
    ticket: {
      id: t.id,
      status: t.status,
      statusLabel: STATUS_LABELS[t.status],
      reasonCode: t.reasonCode,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    },
    ...(q ? { queue: q } : {}),
  });
}
