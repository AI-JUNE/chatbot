// 상담원 연결(에스컬레이션) 접수 API — 고객용(위젯에서 호출).
// 인메모리 스텁 — [승인 필요] 실제 상담원 알림·DB 영구 저장.
import { NextRequest } from 'next/server';
import { createTicket, getTicket, queuePosition, toReasonCode, STATUS_LABELS } from '@/lib/escalation';
import { buildHandoffSummary } from '@/lib/handoff';
import { intentLabelMap } from '@/lib/intents';
import { tenantLabel } from '@/lib/tenants';
import { listCustomRules } from '@/lib/adminStore';
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
  /**
   * 어느 고객사의 접수인가 — **세션이 말하는 대로** 적는다 (DS 36-2).
   *
   * 위젯은 테넌트를 이 API 에 보내지 않는다(계약을 늘리지 않는다). 보낼 필요도 없다 —
   * 접수 카드는 챗봇이 답한 말풍선 아래에만 뜨므로 이 세션은 이미 `/api/chat` 을 지났고,
   * 그 자리에서 세션에 고객사가 적혔다. 고객이 보낸 값을 그대로 믿지 않는 쪽이기도 하다
   * (운영자 화면과 이관 요약에 그대로 그려지는 값이다).
   */
  const tenant = ctx.tenantId ?? null;
  const slots = { ...(ctx.slots ?? {}), ...(contact.value ? { contact: contact.value } : {}) };
  const summary = buildHandoffSummary({
    sessionId: sessionId.value,
    ...(tenant ? { tenantLabel: tenantLabel(tenant) } : {}),
    // 이 API 는 웹 위젯 전용이지만 채널은 세션이 말하는 대로 적는다(요약이 회신 창구를 지어내지 않게).
    channel: ctx.channel ?? 'web',
    reason: reasonCode,
    turns: ctx.turns ?? [],
    slots,
    pendingSlots: slots.contact ? [] : ['contact'],
    // 「직전 주제」에 운영자가 만든 규칙 이름을 쓴다 — 요약은 운영자가 그대로 읽는 평문이다.
    intentLabels: intentLabelMap(listCustomRules()),
  }).text;

  const { ticket, created } = createTicket({
    sessionId: sessionId.value,
    tenant,
    reason: reason.value,
    message: message.value,
    contact: contact.value || undefined,
    summary,
  });
  updateSession(sessionId.value, {
    ticketId: ticket.id,
    handoffReason: reasonCode,
    /**
     * 연락처를 묻는 상태를 **거둔다** (DS 35-3).
     *
     * 규칙 전환(`lib/chat.ts` 의 `escalateWith`)은 접수한 뒤 `awaitingContact` 를 켜고 대화창으로
     * 연락처를 묻는다. 그런데 그 직전 폴백 답변에는 위젯의 「상담원 연결하기」가 그대로 붙어 있어
     * (`escalate` 이면서 접수번호가 없는 답변이다), 고객은 그 버튼을 눌러 **카드에서** 연락처를
     * 남기거나 「연락처 없이 접수」를 고른다. 그러면 물은 것은 이미 답을 받았는데 서버는 계속
     * 기다리는 상태였다 — 다음에 고객이 하는 **보통 질문**이 연락처 수집 턴으로 먼저 해석된다:
     *  - 「환불 수수료는 없어요?」 → 건너뛰기로 읽혀 「네, 알겠습니다. 접수는 유지되니…」로 답한다
     *    (질문은 사라지고, 답처럼 생긴 글이 남는다)
     *  - 「매장 번호 02-123-4567로 전화했는데 안 받아요」 → 그 번호가 **고객의 연락처로 저장된다**
     *    (상담원은 고객이 주지 않은 번호로 전화한다 — §13 이 금지한 「없는 사실」이 접수에 들어간다)
     * 남겼든 남기지 않기로 했든 카드가 그 질문을 끝냈으므로, 대화창은 다시 묻지 않는다.
     */
    awaitingContact: false,
    ...(contact.value ? { slots } : {}),
  });

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
          /**
           * 이 접수에 **회신할 곳이 남아 있는가** (DS 34-2). 연락처 원문은 내려보내지 않는다 —
           * 위젯이 알아야 하는 것은 「연락을 받을 수 있는가」 하나뿐이다.
           *
           * 세션당 열린 접수는 재사용되므로(`createTicket`), 앞서 다른 길로 연락처를 남긴 사람이
           * (서버가 묻고 고객이 입력한 경우 — `lib/chat.ts` 의 연락처 수집) 뒤에 위젯에서
           * 「연락처 없이 접수」를 누르는 일이 생긴다. 그때 위젯은 자기가 방금 보낸 것만 알아서
           * 「연락처를 남기지 않으셔서 이 대화창으로 안내드립니다」라고 말했다 — 서버에는 연락처가
           * 그대로 있는데 고객에게는 아무도 연락하지 않는다고 알린 것이다.
           *
           * GET(접수번호 조회)에는 **싣지 않는다** — 그쪽은 인증이 없고 접수번호가 연번이라,
           * 번호를 훑으며 「연락처를 남긴 접수」를 골라낼 수 있다.
           */
          contactOnFile: Boolean(ticket.contact),
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
