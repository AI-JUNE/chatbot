// 관리 콘솔 시나리오(인텐트 룰) API.
// 내장 룰: 활성화·응답문만 편집(패턴은 코드 관리). 커스텀 룰: 키워드 기반 추가/수정/삭제(POST/DELETE).
import { NextRequest } from 'next/server';
import { RULES } from '@/lib/rules';
import { shadowOfRule } from '@/lib/chat';
import { getRuleOverride, setRuleOverride, listCustomRules, upsertCustomRule, deleteCustomRule, customRuleRev, ruleOverrideRev, overrideConflict, saveAdminNow, MAX_RULE_REPLY_LEN, CustomRuleInput, type CustomRule } from '@/lib/adminStore';
import { logAudit } from '@/lib/audit';
import { ok, fail, readJson, reqQuery, optStr, requireAdmin, isAdminAuthed } from '@/lib/http';
import { AUDIT_NAME_LEN, ellipsize, KEYWORDS_LEN, RULE_LABEL_LEN } from '@/lib/limits';
import { toNfc } from '@/lib/normalize';
import { CHANGED_TARGET_MESSAGE, STALE_TARGET_MESSAGE } from '@/lib/refusal';

export const dynamic = 'force-dynamic';

/**
 * **내 규칙 한 건이 받는 칸과 그 상한** (DS 74-3).
 *
 * 바로 아래 `PATCH`(기본 규칙 답변 덮어쓰기)는 1000자를 재고 있었는데, 같은 화면의 바로 옆
 * 칸인 `POST`(내가 만드는 규칙)는 **아무것도 재지 않았다** — 같은 「답변」 칸을 두 창구가 다른
 * 자로 봤다. 돌려서 받아 냈다: 2만 자 답변과 5천 자 규칙 이름이 그대로 저장되고(그 이름은
 * 목록·전역 검색·변경 이력에 선다), 제로폭 공백 한 자만 적은 답변은 **빈 말풍선**으로 고객에게
 * 나간다(`matchCustomRule` 이 실제로 그 규칙을 돌려준다).
 *
 * 길이는 정규화 뒤에 잰다(`toNfc`) — 분해형 한글을 그냥 세면 멀쩡한 글이 상한에 먼저 걸린다.
 */
const RULE_FIELDS: readonly (readonly [string, number])[] = [
  ['label', RULE_LABEL_LEN],
  ['reply', MAX_RULE_REPLY_LEN],
  ['keywords', KEYWORDS_LEN],
  ['baseRev', 120],
];

function nfcIfText(v: unknown): unknown {
  return typeof v === 'string' ? toNfc(v) : v;
}

function ruleView(intent: string) {
  const r = RULES.find((x) => x.intent === intent)!;
  const ov = getRuleOverride(intent);
  return {
    intent: r.intent,
    label: r.label,
    // 조건은 **룰이 사람 말로 적어 둔 대표 표현**으로 보낸다 (DS 80-1) — 종전에는 정규식 원문
    // (`r.test.source`)을 그대로 실어 보내고 화면이 그것을 풀었다. 그러면 ① 중첩 괄호가 든 패턴에서
    // 안쪽 그룹이 잡혀 뜻 없는 글자가 떴고(「장애·오류 신고 → 돼, 되」) ② 콘솔이 내부 표기를 들고
    // 있게 된다. 작업 이름(`auditActionLabel`)·인텐트 이름(`lib/intents`)과 같은 모양이다.
    examples: [...r.examples],
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
  const body = parsed.data as Record<string, unknown>;

  const intentField = optStr(body.intent, 'intent', 60);
  if (!intentField.ok) return intentField.res;
  const intent = intentField.value;
  if (intent && RULES.some((r) => r.intent === intent)) {
    // 이 문장들은 콘솔 토스트에 그대로 뜬다 — 「룰」·「intent」·「reply」는 DS 2-5 가 화면에서
    // 걷어낸 코드 어휘다(화면 문자열 검사가 서버 문장까지 보지 못했다 — DS 29-3).
    return fail('conflict', '기본 규칙과 같은 이름은 쓸 수 없습니다. 규칙 이름을 바꿔 주세요.', undefined, { status: 400 });
  }

  // 들어온 칸을 재서 넘긴다 (DS 74-3) — 보내지 않은 칸은 보내지 않은 대로 둔다(수정에서
  // 빈 칸은 지금 값을 지킨다). 켜짐 여부·상담원 연결은 참/거짓이라 저장소가 그대로 가린다.
  const input: Record<string, unknown> = { ...(intent ? { intent } : {}) };
  for (const [key, max] of RULE_FIELDS) {
    if (body[key] === undefined) continue;
    const raw = key === 'keywords' && Array.isArray(body[key])
      ? (body[key] as unknown[]).map((k) => String(k)).join(',')
      : body[key];
    const f = optStr(nfcIfText(raw), key, max);
    if (!f.ok) return f.res;
    input[key] = f.value;
  }
  if (body.escalate !== undefined) input.escalate = body.escalate === true;
  if (body.enabled !== undefined) input.enabled = body.enabled !== false;
  const result = upsertCustomRule(input as CustomRuleInput);
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
    // 운영자가 적은 규칙 이름 — 줄일 때 **줄였다고 적는다** (DS 62-3).
    // 아무것도 바뀌지 않은 저장을 「수정」이라 적지 않는다 (DS 72-3).
    detail: `${result.duplicate ? '같은 내용이 이미 있어 새로 만들지 않음' : result.created ? '생성' : '수정'}: ${ellipsize(result.rule.label, AUDIT_NAME_LEN)}`,
    authed: isAdminAuthed(req),
  });
  // 저장은 됐지만 **쓰이지 않을** 수 있다 — 그 사실을 저장한 자리에서 바로 말한다(DS 44-3).
  // 같은 자리에서 **보관되었는지**도 함께 말한다 — 「저장되었습니다」가 가리키는 것이
  // 화면 속 메모리뿐일 수 있다(DS 47-1).
  return ok({
    rule: customRuleView(result.rule),
    created: result.created,
    // 「다시 시도」가 만들려던 쌍둥이를 막았다 (DS 72-3) — 화면이 다른 말을 적는다.
    ...(result.duplicate ? { duplicate: true } : {}),
    shadowedBy: customRuleView(result.rule).shadowedBy,
    saved: saveAdminNow(),
  });
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

  const enabled = body.enabled as boolean | undefined;
  /**
   * 답변 칸을 재는 자는 **내 규칙 쪽과 같다** (DS 74-3) — 종전에는 이 자리만 길이를 손으로
   * 재서(`body.reply.length`) 보이지 않는 글자를 글자로 셌고, 분해형 한글은 상한에 먼저 걸렸다.
   * `null` 은 「기본값으로 되돌린다」는 뜻이라 글자로 재지 않는다(아래 기록이 그 둘을 가른다).
   */
  let reply: string | null | undefined;
  if (body.reply === null) reply = null;
  else if (body.reply !== undefined) {
    const f = optStr(nfcIfText(body.reply), 'reply', MAX_RULE_REPLY_LEN);
    if (!f.ok) return f.res;
    reply = f.value;
  }
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
