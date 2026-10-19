// 헬스체크 — 공통 런치 P0-5. 민감정보 없음(플래그 상태만).
import { KAKAO_LIVE } from '@/lib/kakao';
import { ok, ADMIN_AUTH_REQUIRED } from '@/lib/http';
import { MONITORING_ENABLED } from '@/lib/monitoring';
import { storageStatus } from '@/lib/storage';
import { rbacStatus } from '@/lib/rbac';
import { tenantStatus } from '@/lib/tenantKB';

export const dynamic = 'force-dynamic';

const startedAt = Date.now();

export async function GET() {
  const storage = storageStatus();
  // 의존성 상태: 현재 외부 DB·외부 API 의존성은 없고 저장소만 있다.
  //
  // **보관해야 하는데 못 하는 것**만 degraded 로 센다 (DS 47-2). 종전에는 `error` 만 세어,
  // 읽기전용 환경(Vercel 기본 FS)에서 모든 쓰기가 실패하는 동안에도 밖에서 보는 신호등은
  // 초록이었다 — 이 응답은 사람이 아니라 외부 감시가 읽는 자리라 아무도 알아채지 못한다.
  // 반대로 `awaiting_approval`·`disabled` 는 **그렇게 하기로 정한 설정**이므로 degraded 가
  // 아니다(계속 degraded 로 두면 신호등이 영영 노랑이라 아무 뜻이 없어진다). 그 둘은
  // `piiApproved`·네임스페이스 `health` 로 응답에 그대로 적힌다.
  const failing = storage.namespaces.filter((n) => n.health === 'error' || n.health === 'readonly');
  // 테넌트 지식(이음 FAQ 등) 적재 상태. FAQ가 0건이면 답변 근거가 없다는 뜻이라 degraded로 본다.
  const tenants = tenantStatus();
  const brokenTenant = tenants.some((t) => t.entries === 0 || t.skipped > 0);
  return ok({
    service: 'chatbot',
    status: failing.length || brokenTenant ? 'degraded' : 'ok',
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    now: new Date().toISOString(),
    dependencies: {
      storage: {
        driver: storage.driver, // memory | file
        piiApproved: storage.piiApproved, // [승인 필요] PERSIST_PII
        namespaces: storage.namespaces.map((n) => ({
          ns: n.ns,
          // 사람이 읽는 이름은 **서버가 보낸다** (DS 47-3) — 화면이 베껴 적으면 저장 영역이
          // 늘어날 때마다 그쪽에서 영문 코드가 그려진다.
          label: n.label,
          // `persisted` 는 「보관한 적이 있는가」다 — **사유를 아는 칸은 `health` 하나**다(DS 47-2).
          persisted: n.persisted,
          health: n.health,
          lastSavedAt: n.lastSavedAt,
          lastError: n.lastError, // 경로·개인정보가 제거된 요약 문자열
        })),
      },
      // 테넌트 지식 — 공개 가능한 값만(FAQ 본문·비밀값 없음).
      tenants,
    },
    flags: {
      kakaoLive: KAKAO_LIVE, // [승인 필요] 전까지 false
      llm: 'stub', // LLM 실키 연동은 [승인 필요]
      adminAuthRequired: ADMIN_AUTH_REQUIRED, // [승인 필요] 전까지 false
      adminTokenConfigured: Boolean(process.env.ADMIN_TOKEN), // 값은 노출하지 않음
      monitoring: MONITORING_ENABLED, // SENTRY_DSN 설정 여부(값은 노출하지 않음)
      // 파트너 담당자 로그인(partner_admin). [승인 필요] 전까지 false이며,
      // 등록된 자격 "개수"만 노출한다(토큰 값·파트너 id는 노출하지 않음).
      partnerPortal: rbacStatus(),
    },
    build: {
      env: process.env.VERCEL_ENV || 'local',
      commit: (process.env.VERCEL_GIT_COMMIT_SHA || 'dev').slice(0, 7),
    },
  });
}
