// 상담원 연결(에스컬레이션) 접수 API — 고객용(위젯에서 호출).
// 인메모리 스텁 — [승인 필요] 실제 상담원 알림·DB 영구 저장.
import { NextRequest } from 'next/server';
import { createTicket, getTicketForSession, queuePosition, toReasonCode, STATUS_LABELS } from '@/lib/escalation';
import { buildHandoffSummary } from '@/lib/handoff';
import { intentLabelMap } from '@/lib/intents';
import { tenantLabel } from '@/lib/tenants';
import { listCustomRules } from '@/lib/adminStore';
import { getSession, updateSession, isSharedSessionKey, newVisitorSessionId } from '@/lib/session';
import { rateGuard } from '@/lib/ratelimit';
import { takeContact } from '@/lib/pii';
import { CONTACT_SHAPE_MESSAGE, phoneShapeMessage } from '@/lib/refusal';
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

  const sid = optStr(parsed.data.sessionId, 'sessionId', 60, '');
  if (!sid.ok) {
    rl.end({ status: 400, code: 'invalid_input' });
    return withRequestId(sid.res, rl.requestId);
  }
  /**
   * 세션을 들고 오지 않은 접수에는 **한 번 쓰는 식별자**를 발급한다 (DS 51-2).
   *
   * 종전 기본값은 `'anon'` 이었다 — 그 값으로 만든 접수는 세션당 재사용 규칙(`createTicket`)에
   * 걸려 **서로 모르는 사람의 접수가 한 건으로 합쳐지고**(뒤에 온 사람의 본문·요약·연락처가
   * 앞사람의 접수를 덮어쓴다), 그 접수는 `?id=ESC-0001&sessionId=anon` 으로 누구에게나 열렸다.
   */
  const sessionId = isSharedSessionKey(sid.value) ? newVisitorSessionId('web') : sid.value;
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
  /**
   * **접수에 붙는 연락처를 서버가 잰다** (DS 70-2).
   *
   * 종전에 이 창구는 연락처를 **길이만** 보고 그대로 저장했다 — 재는 자는 위젯 카드 안에만
   * 있었고(`ChatWidget.validContact`), 그 자는 서버가 아는 연락처와 **다른 답**을 냈다:
   * `123456789`(0 으로 시작하지 않는 아홉 자리)는 카드를 통과해 접수의 연락처 칸에 들어가고,
   * `contactOnFile: true` 가 되어 위젯은 「남겨 주신 연락처로 연락드릴게요」라고 말한다. 그
   * 값을 되읽는 문구(`chat.contactTail`)는 가리는 쪽에서 **계좌번호**로 읽어
   * 「남겨 주신 연락처(***-****-****)로…」가 된다 — 고객에게도 운영자에게도 뜻이 없는 글이고,
   * 상담원이 걸 수 있는 번호도 아니다. 자리 수가 맞지 않는 번호(`010-123-4567`)는 양쪽을 다
   * 통과했다.
   *
   * 재는 자를 `pii.takeContact` 한 벌로 모으고(폼·엔진·이 창구가 같은 자를 쓴다), 거절 문장은
   * `refusal` 한 곳에서 가져온다 — 위젯은 같은 규칙의 **사본**을 들고 있어 보내기 전에 그 칸
   * 아래에서 먼저 말한다(테스트가 두 자를 같은 값으로 대조한다 · DS 42-1).
   */
  const took = contact.value ? takeContact(contact.value) : null;
  if (took && !took.ok) {
    rl.end({ status: 400, code: 'invalid_input' });
    return withRequestId(
      fail(
        'invalid_input',
        took.kind === 'phone'
          ? phoneShapeMessage(took.issue, took.head, took.plan, took.length)
          : CONTACT_SHAPE_MESSAGE,
      ),
      rl.requestId,
    );
  }

  // 이관 요약은 세션 문맥(최근 대화·수집 슬롯)에서 규칙 기반으로 생성한다. 본문은 마스킹을 통과한다.
  const reasonCode = toReasonCode(reason.value);
  const ctx = getSession(sessionId);
  /**
   * 어느 고객사의 접수인가 — **세션이 말하는 대로** 적는다 (DS 36-2).
   *
   * 위젯은 테넌트를 이 API 에 보내지 않는다(계약을 늘리지 않는다). 보낼 필요도 없다 —
   * 접수 카드는 챗봇이 답한 말풍선 아래에만 뜨므로 이 세션은 이미 `/api/chat` 을 지났고,
   * 그 자리에서 세션에 고객사가 적혔다. 고객이 보낸 값을 그대로 믿지 않는 쪽이기도 하다
   * (운영자 화면과 이관 요약에 그대로 그려지는 값이다).
   */
  const tenant = ctx.tenantId ?? null;
  /**
   * 저장하는 것은 **받아 적은 값**이다 (DS 70-1·70-2) — 전각으로 적힌 번호는 아스키로 모이고
   * 공백 구분자는 떨어진다. 엔진이 받아 적는 값과 같은 모양이어야 운영자 화면·CSV·되읽는
   * 문구가 한 가지 모양만 읽는다(`pii.findContact` 의 규약 그대로).
   */
  const taken = took?.ok ? took.value : '';
  const slots = { ...(ctx.slots ?? {}), ...(taken ? { contact: taken } : {}) };
  const summary = buildHandoffSummary({
    sessionId: sessionId,
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
    sessionId: sessionId,
    tenant,
    reason: reason.value,
    message: message.value,
    contact: taken || undefined,
    summary,
  });
  updateSession(sessionId, {
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
    ...(taken ? { slots } : {}),
  });

  const q = queuePosition(ticket.id);
  rl.end({
    status: created ? 201 : 200,
    channel: 'web',
    sessionHash: hashId(sessionId),
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
           * GET(접수번호 조회)도 **같은 칸을 싣는다** (DS 50-1). 종전에 싣지 않은 까닭은 그쪽에
           * 인증이 없어 번호를 훑으며 「연락처를 남긴 접수」를 골라낼 수 있다는 것이었는데,
           * 이제 그 창구는 **접수를 만든 세션만** 지난다(`getTicketForSession` · DS 49-1).
           * 같은 주인에게 POST 가 이미 돌려주는 사실이라 새로 드러나는 것이 없고, 되살린
           * 접수 카드가 「연락드릴 수 있는가」를 **지금 기준으로** 말하려면 이 값이 필요하다 —
           * 완료·취소된 접수는 연락처가 그 자리에서 파기되므로(`updateTicket`), 접수할 때
           * 참이었던 값을 그대로 들고 있으면 카드가 오지 않을 연락을 약속한다.
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

/**
 * 접수 상태 조회 — **접수번호만으로는 열리지 않는다** (DS 49-1).
 *
 * 종전에는 번호 하나만 받아 상태·이관 사유·접수 시각·대기 인원을 돌려줬다. 이 창구는
 * 인증이 없고 접수번호는 **연번**(`ESC-0001`)이라, 밖에서 1번부터 훑으면 「접수가 몇 건
 * 있는지 · 언제 들어왔는지 · 무엇 때문에 상담원으로 넘어갔는지」가 그대로 읽혔다
 * (「없는 번호」는 404 라, 응답 자체가 접수가 어디까지 찼는지 알려 주는 자다). 횟수 제한도
 * 없어 훑는 일을 막는 것이 하나도 없었다 — 개인정보처리방침 §10 이 보호 조치로 적어 둔
 * 「요청 횟수 제한」이 정작 읽기 경로에는 걸려 있지 않았다.
 *
 * 그래서 **자기 접수인지**를 함께 묻는다: 접수를 만든 그 세션(`sessionId`)을 아는 사람만
 * 볼 수 있다. 위젯은 이 값을 이미 들고 있으므로(`sessionStorage`) 쓸 수 있는 길은 그대로다.
 *
 * 47차(DS 50-1)에 **이 창구를 실제로 쓰는 화면이 생겼다**: 위젯은 되살린 접수 카드의 처리
 * 상태를 여기서 한 번 되묻는다(되살린 값은 접수했을 때의 것이라, 그 사이 완료·취소된 접수에
 * 대고 「연락드립니다」라고 약속하던 자리다). 그래서 회신 가능 여부(`contactOnFile`)를 함께
 * 싣는다 — 주인 확인을 지난 뒤이고, 같은 주인에게 POST 가 이미 돌려주는 사실이다.
 * 가리는 자는 저장소에 **한 벌**로 둔다(`getTicketForSession`) — 없는 번호와 남의 번호를
 * 다른 말로 거절하면 그 차이가 곧 「있다/없다」를 알려 주는 자가 되므로, 거절은 한 문장이다.
 */
export async function GET(req: NextRequest) {
  const rl = startRequest('/api/escalation', 'GET', req.headers.get('x-request-id'));
  const limited = rateGuard('escalation-lookup', req.headers, 30);
  if (limited) {
    rl.end({ status: 429, code: 'rate_limited' });
    return withRequestId(limited, rl.requestId);
  }
  const id = reqQuery(req, 'id');
  if (!id.ok) {
    rl.end({ status: 400, code: 'invalid_input' });
    return withRequestId(id.res, rl.requestId);
  }
  // 두 값을 **모두 받은 뒤에** 찾는다 — 번호만으로 먼저 찾으면 그 응답이 존재를 알린다.
  const owner = reqQuery(req, 'sessionId', 60);
  if (!owner.ok) {
    rl.end({ status: 400, code: 'invalid_input' });
    return withRequestId(owner.res, rl.requestId);
  }
  const t = getTicketForSession(id.value, owner.value);
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
        // 「이 접수에 회신할 곳이 남아 있는가」 — POST 와 같은 사실, 같은 이름 (DS 50-1).
        // 연락처 원문은 어느 쪽에도 싣지 않는다.
        contactOnFile: Boolean(t.contact),
      },
      ...(q ? { queue: q } : {}),
    }),
    rl.requestId,
  );
}
