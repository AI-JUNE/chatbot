// 헬스체크 — 공통 런치 P0-5. 민감정보 없음(플래그 상태만).
import { KAKAO_LIVE } from '@/lib/kakao';
import { ok, ADMIN_AUTH_REQUIRED } from '@/lib/http';
import { MONITORING_ENABLED } from '@/lib/monitoring';

export const dynamic = 'force-dynamic';

const startedAt = Date.now();

export async function GET() {
  return ok({
    service: 'chatbot',
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    now: new Date().toISOString(),
    flags: {
      kakaoLive: KAKAO_LIVE, // [승인 필요] 전까지 false
      llm: 'stub', // LLM 실키 연동은 [승인 필요]
      adminAuthRequired: ADMIN_AUTH_REQUIRED, // [승인 필요] 전까지 false
      adminTokenConfigured: Boolean(process.env.ADMIN_TOKEN), // 값은 노출하지 않음
      monitoring: MONITORING_ENABLED, // SENTRY_DSN 설정 여부(값은 노출하지 않음)
    },
    build: {
      env: process.env.VERCEL_ENV || 'local',
      commit: (process.env.VERCEL_GIT_COMMIT_SHA || 'dev').slice(0, 7),
    },
  });
}
