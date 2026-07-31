// 관리 콘솔 KB API. 인메모리 스토어(스텁) — [승인 필요] DB 영구 저장.
// ADMIN_TOKEN 환경변수가 설정된 경우 x-admin-token 헤더 필수(시크릿은 Vercel 환경변수로만).
import { NextRequest, NextResponse } from 'next/server';
import { listKB, upsertKB, deleteKB, resetKB } from '@/lib/adminStore';

export const dynamic = 'force-dynamic';

function unauthorized(req: NextRequest): NextResponse | null {
  const token = process.env.ADMIN_TOKEN;
  if (token && req.headers.get('x-admin-token') !== token) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  return null;
}

export async function GET(req: NextRequest) {
  const u = unauthorized(req);
  if (u) return u;
  return NextResponse.json({ ok: true, entries: listKB() });
}

export async function POST(req: NextRequest) {
  const u = unauthorized(req);
  if (u) return u;
  let body: { reset?: boolean } & Parameters<typeof upsertKB>[0];
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }
  if (body.reset === true) {
    resetKB();
    return NextResponse.json({ ok: true, entries: listKB() });
  }
  const result = upsertKB(body);
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result, { status: result.created ? 201 : 200 });
}

export async function DELETE(req: NextRequest) {
  const u = unauthorized(req);
  if (u) return u;
  const id = req.nextUrl.searchParams.get('id') || '';
  if (!id) return NextResponse.json({ ok: false, error: 'id가 필요합니다.' }, { status: 400 });
  const removed = deleteKB(id);
  if (!removed) return NextResponse.json({ ok: false, error: '해당 id가 없습니다.' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
