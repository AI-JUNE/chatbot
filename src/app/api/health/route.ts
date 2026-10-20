// 헬스체크 — 공통 런치 P0-5. 민감정보 없음(플래그 상태만).
//
// **우리 문이 어떻게 잠겨 있는지는 아무에게나 말하지 않는다** (DS 49-2).
// 이 응답은 인증 없이 누구나 읽는 자리인데, 종전에는 `adminAuthRequired`·`adminTokenConfigured`·
// 파트너 자격 수를 그대로 실어 보냈다 — 지금 배포본의 그 값은 둘 다 false 이므로
// (`ADMIN_TOKEN` 미설정 + 게이트 OFF → `requireAdmin` 이 개방으로 통과시킨다 · [승인 필요])
// 이 응답 한 줄이 **「관리 콘솔에 토큰이 걸려 있지 않다」를 밖에 알리는** 안내문이었다.
// 라이브 주소를 아는 사람이면 누구든 읽을 수 있고, 아무 기록도 남지 않는다.
// 그래서 **토큰이 실제로 맞았을 때만**(`isAdminAuthed`) 그 칸을 적는다 — 게이트가 OFF 여서
// 통과되는 경우(`requireAdmin`)는 토큰을 맞춘 것이 아니므로 여기서는 세지 않는다.
//
// 저장소·테넌트 상태(`dependencies`)는 종전대로 공개한다 — 외부 감시(`scripts/smoke.mjs`)와
// 관리 콘솔의 저장소 상태 패널이 읽는 자리이고, 「문이 잠겼는가」와는 다른 종류의 값이다.
import { NextRequest } from 'next/server';
import { KAKAO_LIVE } from '@/lib/kakao';
import { ok, isAdminAuthed, ADMIN_AUTH_REQUIRED } from '@/lib/http';
import { MONITORING_ENABLED } from '@/lib/monitoring';
import { storageStatus } from '@/lib/storage';
import { rbacStatus } from '@/lib/rbac';
import { tenantStatus } from '@/lib/tenantKB';

export const dynamic = 'force-dynamic';

const startedAt = Date.now();

export async function GET(req: NextRequest) {
  // 토큰을 맞춘 사람에게만 적는 칸이 있다 (DS 49-2).
  const authed = isAdminAuthed(req);
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
      monitoring: MONITORING_ENABLED, // SENTRY_DSN 설정 여부(값은 노출하지 않음)
      // ── 여기부터는 **토큰을 맞춘 사람에게만** 적는다 (DS 49-2) ──
      // 「관리 콘솔에 인증이 걸려 있는가」는 우리 자물쇠의 상태다. 값 자체는 시크릿이 아니지만,
      // 그 사실을 밖에 알리는 것은 잠기지 않은 문에 안내판을 세우는 일이다.
      ...(authed
        ? {
            adminAuthRequired: ADMIN_AUTH_REQUIRED, // [승인 필요] 전까지 false
            adminTokenConfigured: Boolean(process.env.ADMIN_TOKEN), // 값은 노출하지 않음
            // 파트너 담당자 로그인(partner_admin). [승인 필요] 전까지 false이며,
            // 등록된 자격 "개수"만 노출한다(토큰 값·파트너 id는 노출하지 않음).
            partnerPortal: rbacStatus(),
          }
        : {}),
    },
    build: {
      env: process.env.VERCEL_ENV || 'local',
      commit: (process.env.VERCEL_GIT_COMMIT_SHA || 'dev').slice(0, 7),
    },
  });
}
