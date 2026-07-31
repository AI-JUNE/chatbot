// 관리 콘솔 시나리오(인텐트 룰) API. 활성화·응답문만 편집(패턴은 코드 관리).
import { NextRequest, NextResponse } from 'next/server';
import { RULES } from '@/lib/rules';
import { getRuleOverride, setRuleOverride } from '@/lib/adminStore';

export const dynamic = 'force-dynamic';

function unauthorized(req: NextRequest): NextResponse | null {
  const token = process.env.ADMIN_TOKEN;
  if (token && req.headers.get('x-admin-token') !== token) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  return null;
}

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
  const u = unauthorized(req);
  if (u) return u;
  return NextResponse.json({ ok: true, rules: RULES.map((r) => ruleView(r.intent)) });
}

export async function PATCH(req: NextRequest) {
  const u = unauthorized(req);
  if (u) return u;
  let body: { intent?: string; enabled?: boolean; reply?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }
  const intent = (body.intent || '').trim();
  if (!RULES.some((r) => r.intent === intent)) {
    return NextResponse.json({ ok: false, error: '존재하지 않는 intent입니다.' }, { status: 404 });
  }
  setRuleOverride(intent, { enabled: body.enabled, reply: body.reply });
  return NextResponse.json({ ok: true, rule: ruleView(intent) });
}
