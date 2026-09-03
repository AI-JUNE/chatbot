// 관리 토큰 검증 엔드포인트 — 관리 콘솔 로그인 UX(잠금 화면·토큰 피드백)용.
// 항상 200 + 상태 플래그로 응답한다(콘솔이 오류 분기 없이 상태를 그리기 위함).
// 민감정보 없음: 토큰 값은 반환하지 않고 설정 여부·일치 여부만 알린다.
import { NextRequest } from 'next/server';
import { ok, requireAdmin, isAdminAuthed, ADMIN_AUTH_REQUIRED } from '@/lib/http';
import { rateGuard, clientIp } from '@/lib/ratelimit';
import { lockoutStatus, recordAttempt } from '@/lib/adminAuth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  // 토큰 무차별 대입 방지 — IP당 30회/분.
  const limited = rateGuard('admin-auth', req.headers, 30);
  if (limited) return limited;

  const tokenConfigured = Boolean(process.env.ADMIN_TOKEN);
  const presented = Boolean(req.headers.get('x-admin-token'));
  const key = clientIp(req.headers);

  // 실패 누적 잠금 — 느린 대입까지 막는다. 잠긴 동안에는 토큰을 아예 검사하지 않는다.
  const locked = lockoutStatus(key);
  if (locked.locked) {
    return ok({
      authRequired: ADMIN_AUTH_REQUIRED,
      tokenConfigured,
      allowed: false,
      authed: false,
      locked: true,
      retryAfterSec: locked.retryAfterSec,
      reason: `인증 시도가 너무 많습니다. ${Math.ceil(locked.retryAfterSec / 60)}분 후 다시 시도해 주세요.`,
    });
  }

  const denied = requireAdmin(req) !== null;
  // 토큰을 실제로 제시한 시도만 실패로 센다(빈 화면 최초 진입을 잠금으로 만들지 않는다).
  const after = presented ? recordAttempt(key, !denied) : locked;

  let reason = '';
  if (denied) {
    if (!tokenConfigured) reason = '관리자 인증이 활성화되었으나 서버에 ADMIN_TOKEN이 설정되지 않았습니다. 운영자에게 문의하세요.';
    else if (!presented) reason = '관리 토큰을 입력해 주세요.';
    else if (after.locked) reason = `인증 시도가 너무 많습니다. ${Math.ceil(after.retryAfterSec / 60)}분 후 다시 시도해 주세요.`;
    else reason = `토큰이 올바르지 않습니다. 다시 확인해 주세요. (남은 시도 ${after.remaining}회)`;
  }

  return ok({
    authRequired: ADMIN_AUTH_REQUIRED,
    tokenConfigured,
    allowed: !denied,
    authed: isAdminAuthed(req),
    locked: after.locked,
    retryAfterSec: after.retryAfterSec,
    reason,
  });
}
