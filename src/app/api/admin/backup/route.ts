// 관리 콘텐츠 백업·복원 API — KB·룰 오버라이드·커스텀 룰만 포함(개인정보 없음).
// GET: JSON 스냅샷 다운로드(x-admin-token 헤더 또는 ?token= 쿼리 — 브라우저 다운로드 지원).
// POST: 스냅샷 업로드로 전체 교체(무효 항목은 건너뜀). ADMIN_TOKEN 미설정 시 개방.
import { NextRequest, NextResponse } from 'next/server';
import { exportSnapshot, importSnapshot } from '@/lib/adminStore';

export const dynamic = 'force-dynamic';

function authorized(req: NextRequest): boolean {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return true;
  const given = req.headers.get('x-admin-token') || req.nextUrl.searchParams.get('token');
  return given === token;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return new NextResponse(JSON.stringify(exportSnapshot(), null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="chatbot-admin-backup-${date}.json"`,
      'Cache-Control': 'no-store',
    },
  });
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }
  const result = importSnapshot(body);
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result);
}
