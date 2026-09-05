// 역할 기반 접근 제어(RBAC) — 관리자 / 파트너 담당자.
//
// 왜 필요한가: 파트너(운영 대행사) 담당자에게 관리 콘솔을 열어 주려면 "자기가 유치한 고객사만"
// 보이게 해야 한다. 전체 고객사 목록이 그대로 보이면 그 자체가 계약 정보 유출이다.
//
// 설계 원칙
// - **기본 OFF**: `PARTNER_PORTAL_ENABLED=true` 가 아니면 파트너 토큰을 아예 조회하지 않는다.
//   (build now, activate on approval — 파트너 계정 개설은 계약서 확정 후 [승인 필요])
// - 파트너 담당자는 **읽기 전용**이다. 귀속·계약 정보를 파트너가 스스로 고칠 수 있으면
//   정산 근거의 신뢰가 무너진다(쓰기는 고원 관리자만).
// - 토큰 비교는 **상수 시간**이며, 일치 항목을 찾아도 순회를 끝까지 돈다(타이밍으로 항목 수·위치가 새지 않게).
// - 토큰 값은 어떤 경로로도 로그·오류 메시지에 남기지 않는다.
import { safeEqual } from '@/lib/webhookAuth';

export type Role = 'admin' | 'partner_admin';

export interface Principal {
  role: Role;
  /** partner_admin이면 소속 파트너 id. admin이면 null(=전체 범위). */
  partnerId: string | null;
  /** 토큰 검증을 실제로 통과했는지(감사 로그 authed 표기용). 개방 모드는 false. */
  authed: boolean;
}

export const ADMIN_PRINCIPAL: Principal = { role: 'admin', partnerId: null, authed: true };
/** 토큰 미설정 개발 모드 — 인증을 거치지 않은 관리자 취급. */
export const OPEN_PRINCIPAL: Principal = { role: 'admin', partnerId: null, authed: false };

/** 파트너 포털(파트너 계정 로그인) 활성 여부. 기본 OFF. [승인 필요] */
export function partnerPortalEnabled(): boolean {
  return process.env.PARTNER_PORTAL_ENABLED === 'true';
}

/** 너무 짧은 토큰은 사실상 무방비다 — 설정되어 있어도 받아들이지 않는다. */
export const MIN_PARTNER_TOKEN_LENGTH = 16;

export interface PartnerCredential {
  partnerId: string;
  token: string;
}

/**
 * `PARTNER_TOKENS` 파싱. 형식: `PTR-0001:토큰,PTR-0002:토큰2`
 * - 형식이 어긋나거나 너무 짧은 항목은 조용히 버린다(값을 오류 메시지에 담지 않기 위해).
 * - 같은 partnerId가 두 번 나오면 **먼저 나온 것만** 쓴다(설정 실수로 권한이 넓어지지 않게).
 */
export function parsePartnerTokens(raw: string | undefined): PartnerCredential[] {
  if (!raw) return [];
  const out: PartnerCredential[] = [];
  const seen = new Set<string>();
  for (const chunk of raw.split(',')) {
    const idx = chunk.indexOf(':');
    if (idx <= 0) continue;
    const partnerId = chunk.slice(0, idx).trim();
    const token = chunk.slice(idx + 1).trim();
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(partnerId)) continue;
    if (token.length < MIN_PARTNER_TOKEN_LENGTH) continue;
    if (seen.has(partnerId)) continue;
    seen.add(partnerId);
    out.push({ partnerId, token });
  }
  return out;
}

/** 설정 점검 결과 — /api/health·관리 콘솔에서 "왜 파트너 로그인이 안 되는가"를 설명하기 위한 값. */
export interface RbacStatus {
  portalEnabled: boolean;
  /** 유효하게 등록된 파트너 자격 수(토큰 값은 노출하지 않는다). */
  credentials: number;
  /** 형식 오류·길이 미달로 버려진 항목 수. */
  rejected: number;
}

export function rbacStatus(): RbacStatus {
  const raw = process.env.PARTNER_TOKENS;
  const total = raw ? raw.split(',').filter((c) => c.trim()).length : 0;
  const parsed = partnerPortalEnabled() ? parsePartnerTokens(raw) : [];
  return {
    portalEnabled: partnerPortalEnabled(),
    credentials: parsed.length,
    rejected: partnerPortalEnabled() ? Math.max(0, total - parsed.length) : 0,
  };
}

/**
 * 제시된 토큰으로 주체를 판정한다.
 * @param presented 요청이 제시한 토큰(없으면 빈 문자열)
 * @returns 통과하면 Principal, 아니면 null
 *
 * 판정 순서
 *  1) ADMIN_TOKEN 미설정 + 관리자 게이트 OFF → 개방(개발 편의, 기존 동작 유지)
 *  2) ADMIN_TOKEN 일치 → admin
 *  3) 파트너 포털 ON + PARTNER_TOKENS 중 일치 → partner_admin(해당 파트너 범위)
 *  4) 그 외 → null
 */
export function resolvePrincipal(presented: string | null, opts?: { adminAuthRequired?: boolean }): Principal | null {
  const token = presented ?? '';
  const adminToken = process.env.ADMIN_TOKEN;
  const adminAuthRequired = opts?.adminAuthRequired === true;

  if (!adminToken) {
    // 관리자 토큰이 없는데 게이트가 켜져 있으면 전면 차단(설정 누락을 사고로 만들지 않는다).
    if (adminAuthRequired) return null;
    // 게이트 OFF + 토큰 미설정 → 기존 개방 동작. 파트너 토큰도 이 경우엔 의미가 없다.
    return OPEN_PRINCIPAL;
  }

  // 관리자 토큰 비교(상수 시간).
  let isAdmin = false;
  if (token) isAdmin = safeEqual(token, adminToken);

  // 파트너 토큰은 게이트가 켜져 있을 때만 조회한다.
  let partnerId: string | null = null;
  if (!isAdmin && token && partnerPortalEnabled()) {
    for (const cred of parsePartnerTokens(process.env.PARTNER_TOKENS)) {
      // 관리자 토큰과 같은 값을 파트너 자격으로 쓰는 설정은 거부한다(권한 혼동 방지).
      if (safeEqual(cred.token, adminToken)) continue;
      const hit = safeEqual(token, cred.token);
      // 일치해도 break 하지 않는다 — 순회 시간이 위치에 따라 달라지지 않게.
      if (hit && partnerId === null) partnerId = cred.partnerId;
    }
  }

  if (isAdmin) return ADMIN_PRINCIPAL;
  if (partnerId) return { role: 'partner_admin', partnerId, authed: true };
  return null;
}

/** 쓰기(등록·수정·삭제) 권한. 파트너 담당자는 읽기 전용이다. */
export function canWrite(principal: Principal): boolean {
  return principal.role === 'admin';
}

/**
 * 조회 필터에 권한 범위를 강제로 덧씌운다.
 * 호출자가 어떤 partnerId를 요청했든 **파트너 담당자는 자기 파트너로 고정**된다.
 * (queryAccounts 앞단의 단일 관문 — 새 조회 화면이 생겨도 이 함수만 지나면 범위가 샐 수 없다.)
 */
export function scopeAccountFilter<T extends { partnerId?: string | 'direct' | null }>(
  principal: Principal,
  filter: T,
): T {
  if (principal.role === 'admin') return filter;
  return { ...filter, partnerId: principal.partnerId };
}

/** 파트너 담당자에게 보이면 안 되는 다른 파트너 정보를 걸러낸다. */
export function scopePartners<T extends { id: string }>(principal: Principal, partners: T[]): T[] {
  if (principal.role === 'admin') return partners;
  return partners.filter((p) => p.id === principal.partnerId);
}
