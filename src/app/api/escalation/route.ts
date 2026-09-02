// 상담원 연결(에스컬레이션) 접수 API — 고객용(위젯에서 호출).
// 인메모리 스텁 — [승인 필요] 실제 상담원 알림·DB 영구 저장.
import { NextRequest } from 'next/server';
import { createTicket, getTicket, queuePosition, toReasonCode, STATUS_LABELS } from '@/lib/escalation';
import { buildHandoffSummary } from '@/lib/handoff';
import { getSession, updateSession } from '@/lib/session';
import { rateGuard } from '@/lib/ratelimit';
import { ok, fail, readJson, optStr, reqQuery, withRequestId } from '@/lib/http';
import { startRequest, hashId } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  // 요청 로그: 상담 사유·연락처 원문은 기록하지 않는다(사유 코드와 세션 해시만).
  const rl = startRequest('/api/escalation', 'POST', req.headers.get('x-request-id'));

  const limited = rateGuard('escalation', req.headers, 20);
  if (limited) {
    rl.end({ status: 429, code: 'rate_limited' });
    return withRequestId(limited, rl.requestId);
  }

  const parsed = await readJson<Record<string, unknown>>(req);
  if (!parsed.ok) {
    rl.end({ status: parsed.res.status, code: 'invalid_json' });
    return withRequestId(parsed.res, rl.requestId);
  }

  const sessionId = optStr(parsed.data.sessionId, 'sessionId', 60, 'anon');
  if (!sessionId.ok) {
    rl.end({ status: 400, code: 'invalid_input' });
    return withRequestId(sessionId.res, rl.requestId);
  }
  const reason = optStr(parsed.data.reason, 'reason', 60, 'user_request');
  if (!reason.ok) {
    rl.end({ status: 400, code: 'invalid_input' });
    return withRequestId(reason.res, rl.requestId);
  }
  const message = optStr(parsed.data.message, 'message', 1000);
  if (!message.ok) {
    rl.end({ status: 400, code: 'invalid_input' });
    return withRequestId(message.res, rl.requestId);
  }
  const contact = optStr(parsed.data.contact, 'contact', 100);
  if (!contact.ok) {
    rl.end({ status: 400, code: 'invalid_input' });
    return withRequestId(contact.res, rl.requestId);
  }

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
  rl.end({
    status: created ? 201 : 200,
    channel: 'web',
    sessionHash: hashId(sessionId.value),
    ticketId: ticket.id,
    code: reasonCode,
  });
  return withRequestId(
    ok(
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
    ),
    rl.requestId,
  );
}

export async function GET(req: NextRequest) {
  const rl = startRequest('/api/escalation', 'GET', req.headers.get('x-request-id'));
  const id = reqQuery(req, 'id');
  if (!id.ok) {
    rl.end({ status: 400, code: 'invalid_input' });
    return withRequestId(id.res, rl.requestId);
  }
  const t = getTicket(id.value);
  if (!t) {
    rl.end({ status: 404, code: 'not_found' });
    return withRequestId(fail('not_found', '해당 접수번호가 없습니다.'), rl.requestId);
  }
  const q = queuePosition(t.id);
  rl.end({ status: 200, ticketId: t.id });
  return withRequestId(
    ok({
      ticket: {
        id: t.id,
        status: t.status,
        statusLabel: STATUS_LABELS[t.status],
        reasonCode: t.reasonCode,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      },
      ...(q ? { queue: q } : {}),
    }),
    rl.requestId,
  );
}
