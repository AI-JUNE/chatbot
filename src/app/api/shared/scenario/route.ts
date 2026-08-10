// 공용 시나리오 번들 엑스포트 API — 콜봇(Callbot) 등 타 채널이 동일 지식/시나리오를 소비.
// 읽기 전용·개인정보 없음. ADMIN_TOKEN 설정 시 x-admin-token 헤더 필수(시크릿은 Vercel 환경변수로만).
// [승인 필요] 콜봇 실서비스가 운영 URL을 폴링하는 실동기화 — 전까지 수동 페치/테스트만.
import { NextRequest } from 'next/server';
import { exportScenarioBundle } from '@/lib/sharedSchema';
import { ok, requireAdmin, optStr } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const sid = optStr(req.nextUrl.searchParams.get('scenarioId') ?? undefined, 'scenarioId', 60, 'gowon-cc');
  if (!sid.ok) return sid.res;
  return ok({ bundle: exportScenarioBundle(sid.value || 'gowon-cc') });
}
