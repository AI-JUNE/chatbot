// 헬스체크 — 공통 런치 P0-5. 민감정보 없음(플래그 상태만).
import { KAKAO_LIVE } from '@/lib/kakao';
import { ok, ADMIN_AUTH_REQUIRED } from '@/lib/http';
import { MONITORING_ENABLED } from '@/lib/monitoring';
import { storageStatus } from '@/lib/storage';

export const dynamic = 'force-dynamic';

const startedAt = Date.now();

export async function GET() {
  const storage = storageStatus();
  // 의존성 상태: 현재 외부 DB·외부 API 의존성은 없고 저장소만 있다.
  // 저장이 막혔거나(승인 대기·비활성) 읽기전용이면 서비스는 계속 동작하므로 degraded로 본다.
  const failing = storage.namespaces.filter((n) => n.health === 'error');
  return ok({
    service: 'chatbot',
    status: failing.length ? 'degraded' : 'ok',
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    now: new Date().toISOString(),
    dependencies: {
      storage: {
        driver: storage.driver, // memory | file
        piiApproved: storage.piiApproved, // [승인 필요] PERSIST_PII
        namespaces: storage.namespaces.map((n) => ({
          ns: n.ns,
          persisted: n.persisted,
          health: n.health,
          lastSavedAt: n.lastSavedAt,
          lastError: n.lastError, // 경로·개인정보가 제거된 요약 문자열
        })),
      },
    },
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
