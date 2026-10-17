// 관리 콘솔 에스컬레이션 API — 목록·상태 변경 + 운영 통계(자동처리율).
// 인증: lib/http requireAdmin. 시크릿은 Vercel 환경변수로만.
import { NextRequest } from 'next/server';
import { queryTickets, updateTicket, getTicket, escalationStats, ESCALATION_STATUSES, STATUS_LABELS, TICKET_PAGE_DEFAULT, TICKET_PAGE_MAX, EscalationStatus } from '@/lib/escalation';
import { convStats, listTurns, unansweredQuestions } from '@/lib/convlog';
import { feedbackSummary } from '@/lib/feedback';
import { intentLabel, intentLabelMap } from '@/lib/intents';
import { piiKindLabels } from '@/lib/pii';
import { tenantLabel } from '@/lib/tenants';
import { kbLabelMap } from '@/lib/tenantKB';
import { listCustomRules } from '@/lib/adminStore';
import { logAudit } from '@/lib/audit';
import { ok, fail, readJson, reqStr, optStr, intQuery, requireAdmin, isAdminAuthed } from '@/lib/http';
import { BAD_STATUS_MESSAGE } from '@/lib/refusal';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const withLogs = req.nextUrl.searchParams.get('logs') === 'true';
  // 주제(인텐트)는 엔진 식별자다 — 화면이 사전을 따로 들고 있으면 어휘가 늘 때마다 어긋나
  // 운영자에게 `kb:환불`·`cr_m1x2`·`form:reservation:datetime` 같은 코드가 그대로 보인다.
  // 이름은 어휘를 아는 서버에서 붙여 보낸다(`@/lib/intents`).
  const labels = intentLabelMap(listCustomRules());
  const conversation = convStats();
  // 접수는 고객이 만드는 데이터라 상한이 없다 — **전부 싣지 않는다**(DS 43-3).
  // 콘솔은 이 응답을 30초마다 다시 받는다. 「전체 몇 건인가」는 `ticketPage.total` 과
  // `stats.escalation`(상태별 전체 수)이 말하므로, 화면은 보여 준 수를 전체라고 말하지 않는다.
  const page = queryTickets(intQuery(req, 'tickets', TICKET_PAGE_DEFAULT, 1, TICKET_PAGE_MAX));
  return ok({
    // 고객사 이름도 같은 규칙으로 서버가 붙인다(`@/lib/tenants` → `tenantLabel` 필드) — 콘솔이
    // 사전을 따로 들고 있으면 테넌트가 늘 때마다 어긋나 운영자 화면에 `eum` 같은 코드가 뜬다(DS 36-2).
    // 「무엇을 가렸는가」의 이름도 서버가 붙인다(`@/lib/pii` → `piiLabels` · DS 39-2) —
    // 콘솔이 사전을 들고 있으면 종류가 늘 때 `rrn` 같은 코드가 운영자 화면에 그대로 뜬다.
    tickets: page.tickets.map((t) => ({
      ...t,
      tenantLabel: tenantLabel(t.tenant ?? null),
      piiLabels: piiKindLabels(t.piiKinds),
    })),
    /** 「전체 몇 건 중 몇 건을 보냈는가」 — 화면이 그 사실을 적는다 (DS 43-3). */
    ticketPage: { total: page.total, shown: page.tickets.length, limit: page.limit, truncated: page.truncated },
    stats: {
      escalation: escalationStats(),
      // 대시보드 「주제별 분포」 막대도 같은 이름을 쓴다(집계값 `intent` 는 그대로 둔다 — 기계가 보는 쪽이다).
      conversation: {
        ...conversation,
        topIntents: conversation.topIntents.map((t) => ({ ...t, label: intentLabel(t.intent, labels) })),
        byTenant: conversation.byTenant.map((t) => ({ ...t, label: tenantLabel(t.tenant) })),
      },
      // 고객이 누른 평가(👍/👎). 종전에는 받아 두고도 이 집계를 부르는 곳이 없어
      // 운영자가 볼 화면이 하나도 없었다(DS 32-1).
      // 「보완이 필요한 자료」의 이름은 **지금 KB 의 이름**을 붙여 보낸다(DS 43-2) — 평가는 자료
      // id 로 묶여 있고, 라벨은 운영자가 고치면 바뀐다. 지워진 자료는 `missing` 으로 드러난다.
      feedback: feedbackSummary(kbLabelMap()),
    },
    ...(withLogs
      ? {
          recentTurns: listTurns(30).map((t) => ({
            ...t,
            intentLabel: intentLabel(t.intent, labels),
            tenantLabel: tenantLabel(t.tenant ?? null),
            // 가린 종류의 이름 — 운영자가 `***-****-****` 를 보고 「고객이 그렇게 쓴 것인지
            // 우리가 가린 것인지」 알 수 있어야 한다 (DS 39-1).
            piiLabels: piiKindLabels(t.piiKinds),
          })),
          // 「기본 안내 n건」이라는 수를 **무엇을 더 써야 하는지**로 바꾸는 목록(DS 32-2).
          // 고객사별로 갈라 센다(DS 36-1) — 고칠 자료가 있는 곳이 고객사마다 다르다.
          unanswered: (() => {
            const u = unansweredQuestions(8);
            return { ...u, items: u.items.map((i) => ({ ...i, tenantLabel: tenantLabel(i.tenant) })) };
          })(),
        }
      : {}),
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
      // 허용값 목록은 코드 어휘다 — 늘어놓지 않고 다음에 할 일만 말한다(DS 29-3).
      return fail('invalid_input', BAD_STATUS_MESSAGE);
    }
    status = s.value as EscalationStatus;
  }

  let note: string | undefined;
  if (body.note !== undefined) {
    const n = optStr(body.note, 'note', 1000);
    if (!n.ok) return n.res;
    note = n.value;
  }

  // 파기 여부를 남기려면 바꾸기 **전**의 상태를 알아야 한다(완료·취소 시 연락처가 지워진다).
  const hadContact = Boolean(getTicket(id.value)?.contact);

  const result = updateTicket(id.value, { status, note });
  if (!result.ok) return fail('not_found', result.error);

  const parts: string[] = [];
  // 감사 로그의 「대상·내용」은 운영자가 그대로 읽는 칸이다 — 상태 코드(`in_progress`)가 아니라 이름으로 남긴다.
  if (status !== undefined) parts.push(`상태→${STATUS_LABELS[status]}`);
  if (note !== undefined) parts.push('메모 변경');
  // 개인정보 파기는 감사 로그에 남는다 — 연락처 원문은 싣지 않는다(§10.3).
  if (hadContact && !result.ticket.contact) parts.push('연락처 파기');
  logAudit({ action: 'escalation.update', target: id.value, detail: parts.join(', '), authed: isAdminAuthed(req) });
  return ok({ ticket: result.ticket });
}
