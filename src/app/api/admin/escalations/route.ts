// 관리 콘솔 에스컬레이션 API — 목록·상태 변경 + 운영 통계(자동처리율).
// 인증: lib/http requireAdmin. 시크릿은 Vercel 환경변수로만.
import { NextRequest } from 'next/server';
import { listTickets, updateTicket, getTicket, escalationStats, ESCALATION_STATUSES, STATUS_LABELS, EscalationStatus } from '@/lib/escalation';
import { convStats, listTurns } from '@/lib/convlog';
import { intentLabel, intentLabelMap } from '@/lib/intents';
import { listCustomRules } from '@/lib/adminStore';
import { logAudit } from '@/lib/audit';
import { ok, fail, readJson, reqStr, optStr, requireAdmin, isAdminAuthed } from '@/lib/http';

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
  return ok({
    tickets: listTickets(),
    stats: {
      escalation: escalationStats(),
      // 대시보드 「주제별 분포」 막대도 같은 이름을 쓴다(집계값 `intent` 는 그대로 둔다 — 기계가 보는 쪽이다).
      conversation: {
        ...conversation,
        topIntents: conversation.topIntents.map((t) => ({ ...t, label: intentLabel(t.intent, labels) })),
      },
    },
    ...(withLogs
      ? { recentTurns: listTurns(30).map((t) => ({ ...t, intentLabel: intentLabel(t.intent, labels) })) }
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
