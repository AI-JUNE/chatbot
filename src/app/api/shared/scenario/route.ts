// 공용 시나리오 번들 엑스포트 API — 콜봇(Callbot) 등 타 채널이 동일 지식/시나리오를 소비.
// 읽기 전용·개인정보 없음. ADMIN_TOKEN 설정 시 x-admin-token 헤더 필수(시크릿은 Vercel 환경변수로만).
// [승인 필요] 콜봇 실서비스가 운영 URL을 폴링하는 실동기화 — 전까지 수동 페치/테스트만.
import { NextRequest, NextResponse } from 'next/server';
import { exportScenarioBundle } from '@/lib/sharedSchema';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const token = process.env.ADMIN_TOKEN;
  if (token && req.headers.get('x-admin-token') !== token) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  const scenarioId = req.nextUrl.searchParams.get('scenarioId') || 'gowon-cc';
  return NextResponse.json({ ok: true, bundle: exportScenarioBundle(scenarioId) });
}
