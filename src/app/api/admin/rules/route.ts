// 관리 콘솔 시나리오(인텐트 룰) API.
// 내장 룰: 활성화·응답문만 편집(패턴은 코드 관리). 커스텀 룰: 키워드 기반 추가/수정/삭제(POST/DELETE).
import { NextRequest } from 'next/server';
import { RULES } from '@/lib/rules';
import { getRuleOverride, setRuleOverride, listCustomRules, upsertCustomRule, deleteCustomRule, CustomRuleInput } from '@/lib/adminStore';
import { logAudit } from '@/lib/audit';
import { ok, fail, readJson, reqQuery, optStr, requireAdmin, isAdminAuthed } from '@/lib/http';

export const dynamic = 'force-dynamic';

function ruleView(intent: string) {
  const r = RULES.find((x) => x.intent === intent)!;
  const ov = getRuleOverride(intent);
  return {
    intent: r.intent,
    label: r.label,
    pattern: r.test.source,
    escalate: r.escalate === true,
    defaultReply: r.reply,
    enabled: ov ? ov.enabled : true,
    replyOverride: ov?.reply ?? null,
    effectiveReply: ov?.reply || r.reply,
  };
}

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  return ok({ rules: RULES.map((r) => ruleView(r.intent)), customRules: listCustomRules() });
}

// 커스텀 룰 생성/수정(키워드 기반). intent 미지정 시 자동 생성.
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const parsed = await readJson<CustomRuleInput & Record<string, unknown>>(req);
  if (!parsed.ok) return parsed.res;

  const intentField = optStr(parsed.data.intent, 'intent', 60);
  if (!intentField.ok) return intentField.res;
  const intent = intentField.value;
  if (intent && RULES.some((r) => r.intent === intent)) {
    return fail('conflict', '내장 룰과 같은 intent는 사용할 수 없습니다.', undefined, { status: 400 });
  }
  const result = upsertCustomRule(parsed.data);
  if (!result.ok) return fail('invalid_input', result.error);
  logAudit({
    action: 'rule.custom.upsert',
    target: result.rule.intent,
    detail: `${result.created ? '생성' : '수정'}: ${result.rule.label.slice(0, 60)}`,
    authed: isAdminAuthed(req),
  });
  return ok({ rule: result.rule, created: result.created });
}

// 커스텀 룰 삭제: DELETE /api/admin/rules?intent=cr_xxx
export async function DELETE(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const intent = reqQuery(req, 'intent');
  if (!intent.ok) return intent.res;
  if (!deleteCustomRule(intent.value)) return fail('not_found', '존재하지 않는 커스텀 룰입니다.');
  logAudit({ action: 'rule.custom.delete', target: intent.value, authed: isAdminAuthed(req) });
  return ok({});
}

export async function PATCH(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const parsed = await readJson<{ intent?: unknown; enabled?: unknown; reply?: unknown }>(req);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;

  const intentField = optStr(body.intent, 'intent', 60);
  if (!intentField.ok) return intentField.res;
  const intent = intentField.value;
  if (!RULES.some((r) => r.intent === intent)) return fail('not_found', '존재하지 않는 intent입니다.');
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    return fail('invalid_input', 'enabled는 true/false여야 합니다.');
  }
  if (body.reply !== undefined && body.reply !== null && typeof body.reply !== 'string') {
    return fail('invalid_input', 'reply는 문자열 또는 null이어야 합니다.');
  }
  if (typeof body.reply === 'string' && body.reply.length > 1000) {
    return fail('invalid_input', 'reply는 1000자 이하여야 합니다.');
  }

  const enabled = body.enabled as boolean | undefined;
  const reply = body.reply as string | null | undefined;
  setRuleOverride(intent, { enabled, reply });

  const parts: string[] = [];
  if (enabled !== undefined) parts.push(enabled ? '활성화' : '비활성화');
  if (reply !== undefined) parts.push(reply === null ? '응답문 기본값 복원' : '응답문 변경');
  logAudit({ action: 'rule.override', target: intent, detail: parts.join(', '), authed: isAdminAuthed(req) });
  return ok({ rule: ruleView(intent) });
}
