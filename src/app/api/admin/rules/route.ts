// 관리 콘솔 시나리오(인텐트 룰) API.
// 내장 룰: 활성화·응답문만 편집(패턴은 코드 관리). 커스텀 룰: 키워드 기반 추가/수정/삭제(POST/DELETE).
import { NextRequest } from 'next/server';
import { RULES } from '@/lib/rules';
import { shadowOfRule } from '@/lib/chat';
import { getRuleOverride, setRuleOverride, listCustomRules, upsertCustomRule, deleteCustomRule, customRuleRev, ruleOverrideRev, overrideConflict, saveAdminNow, MAX_RULE_REPLY_LEN, CustomRuleInput, type CustomRule } from '@/lib/adminStore';
import { logAudit } from '@/lib/audit';
import { ok, fail, readJson, reqQuery, optStr, requireAdmin, isAdminAuthed } from '@/lib/http';
import { CHANGED_TARGET_MESSAGE, STALE_TARGET_MESSAGE, tooLongMessage } from '@/lib/refusal';

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
    /** 지금 보고 있는 모습 — 답변을 고쳐 저장할 때 그대로 돌려보낸다 (DS 46-1). */
    rev: ruleOverrideRev(r.intent),
  };
}

/**
 * 커스텀 룰 한 건 — **지금 이 규칙이 쓰이는가**를 함께 말한다 (DS 44-3).
 * 판정은 엔진 자신(`shadowOfRule`)이 한다. 화면이 패턴을 다시 해석하면 실제와 어긋난다.
 */
function customRuleView(r: CustomRule) {
  // `rev` 는 **지금 보고 있는 모습**이다 (DS 46-1) — 편집 폼이 이 값을 들고 있다가 저장할 때 돌려보낸다.
  return { ...r, rev: customRuleRev(r), shadowedBy: r.enabled ? shadowOfRule(r.keywords, r.intent) : null };
}

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  return ok({ rules: RULES.map((r) => ruleView(r.intent)), customRules: listCustomRules().map(customRuleView) });
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
    // 이 문장들은 콘솔 토스트에 그대로 뜬다 — 「룰」·「intent」·「reply」는 DS 2-5 가 화면에서
    // 걷어낸 코드 어휘다(화면 문자열 검사가 서버 문장까지 보지 못했다 — DS 29-3).
    return fail('conflict', '기본 규칙과 같은 이름은 쓸 수 없습니다. 규칙 이름을 바꿔 주세요.', undefined, { status: 400 });
  }
  const result = upsertCustomRule(parsed.data);
  if (!result.ok) {
    // 그 사이 다른 화면에서 바뀌었거나 지워진 규칙 (DS 46-1) — 적던 글을 버리지 않게 사유를 함께 보낸다.
    if (result.conflict) {
      return fail('conflict', result.error, {
        conflict: result.conflict,
        ...(result.current ? { current: customRuleView(result.current) } : {}),
      });
    }
    return fail('invalid_input', result.error);
  }
  logAudit({
    action: 'rule.custom.upsert',
    target: result.rule.intent,
    detail: `${result.created ? '생성' : '수정'}: ${result.rule.label.slice(0, 60)}`,
    authed: isAdminAuthed(req),
  });
  // 저장은 됐지만 **쓰이지 않을** 수 있다 — 그 사실을 저장한 자리에서 바로 말한다(DS 44-3).
  // 같은 자리에서 **보관되었는지**도 함께 말한다 — 「저장되었습니다」가 가리키는 것이
  // 화면 속 메모리뿐일 수 있다(DS 47-1).
  return ok({ rule: customRuleView(result.rule), created: result.created, shadowedBy: customRuleView(result.rule).shadowedBy, saved: saveAdminNow() });
}

// 커스텀 룰 삭제: DELETE /api/admin/rules?intent=cr_xxx
export async function DELETE(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const intent = reqQuery(req, 'intent');
  if (!intent.ok) return intent.res;
  if (!deleteCustomRule(intent.value)) return fail('not_found', STALE_TARGET_MESSAGE);
  logAudit({ action: 'rule.custom.delete', target: intent.value, authed: isAdminAuthed(req) });
  return ok({ saved: saveAdminNow() });
}

export async function PATCH(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const parsed = await readJson<{ intent?: unknown; enabled?: unknown; reply?: unknown; baseRev?: unknown }>(req);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;

  const intentField = optStr(body.intent, 'intent', 60);
  if (!intentField.ok) return intentField.res;
  const intent = intentField.value;
  if (!RULES.some((r) => r.intent === intent)) return fail('not_found', STALE_TARGET_MESSAGE);
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    return fail('invalid_input');
  }
  if (body.reply !== undefined && body.reply !== null && typeof body.reply !== 'string') {
    return fail('invalid_input');
  }
  if (typeof body.reply === 'string' && body.reply.length > MAX_RULE_REPLY_LEN) {
    return fail('invalid_input', tooLongMessage('reply', MAX_RULE_REPLY_LEN));
  }

  const enabled = body.enabled as boolean | undefined;
  const reply = body.reply as string | null | undefined;
  // 답변을 덮어쓰는 저장만 **내가 본 모습**을 들고 온다 (DS 46-1) — 켜기/끄기는 한 칸 패치라
  // 겨룰 글이 없다. 들고 왔는데 다르면 거절하고 지금 값을 함께 보낸다.
  const baseRev = typeof body.baseRev === 'string' ? body.baseRev : undefined;
  if (overrideConflict(intent, baseRev)) {
    return fail('conflict', CHANGED_TARGET_MESSAGE, { conflict: 'changed', current: ruleView(intent) });
  }
  setRuleOverride(intent, { enabled, reply });

  const parts: string[] = [];
  if (enabled !== undefined) parts.push(enabled ? '활성화' : '비활성화');
  if (reply !== undefined) parts.push(reply === null ? '응답문 기본값 복원' : '응답문 변경');
  logAudit({ action: 'rule.override', target: intent, detail: parts.join(', '), authed: isAdminAuthed(req) });
  return ok({ rule: ruleView(intent), saved: saveAdminNow() });
}
