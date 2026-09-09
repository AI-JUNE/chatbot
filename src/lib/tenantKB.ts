// 테넌트 지식 로더 — data/*.json(FAQ 원본)을 대화 엔진 KB로 변환해 캐시한다.
// 프리셋·변환 규칙은 @/lib/tenants(순수 모듈), 데이터 결합만 여기서 한다.
// JSON은 정적 import 한다 — 서버리스 배포에서 파일 경로 접근에 의존하지 않기 위해서다.
import eumFaqDoc from '../../data/eum-faq.json';
import type { KBEntry } from '@/lib/knowledge';
import {
  TENANTS,
  faqToKB,
  getTenantPreset,
  publicTenant,
  resolveCTA,
  safeHttpUrl,
  type PublicTenant,
  type TenantPreset,
} from '@/lib/tenants';

/** 테넌트별 FAQ 원본. 새 테넌트는 여기에 한 줄 추가한다. */
const FAQ_SOURCES: Record<string, { faq: unknown }> = {
  eum: eumFaqDoc as { faq: unknown },
};

const cache = new Map<string, KBEntry[]>();

/** 변환 중 건너뛴 항목(형식 오류) — /api/health·기동 로그에서 확인용. */
const loadWarnings: string[] = [];

export function tenantKB(preset: TenantPreset): KBEntry[] {
  const cached = cache.get(preset.id);
  if (cached) return cached.map((e) => ({ ...e, keywords: [...e.keywords] }));

  const src = FAQ_SOURCES[preset.id];
  const { entries, skipped } = faqToKB(preset, src?.faq);
  for (const s of skipped) loadWarnings.push(`[${preset.id}] ${s}`);
  cache.set(preset.id, entries);
  return entries.map((e) => ({ ...e, keywords: [...e.keywords] }));
}

/** 테넌트 해석 + 지식 로드를 한 번에. 알 수 없는 id면 null(기본 동작으로 되돌아간다). */
export function resolveTenant(id: unknown): { preset: TenantPreset; kb: KBEntry[] } | null {
  const preset = getTenantPreset(id);
  if (!preset) return null;
  return { preset, kb: tenantKB(preset) };
}

/** 위젯에 내려보낼 공개 설정(환경변수 반영). */
export function tenantConfig(id: unknown): PublicTenant | null {
  const preset = getTenantPreset(id);
  return preset ? publicTenant(preset, process.env) : null;
}

export function tenantLoadWarnings(): string[] {
  return [...loadWarnings];
}

/** 테넌트 1건의 적재 상태 — 비밀값 없음(FAQ 본문도 싣지 않는다). */
export interface TenantLoadStatus {
  id: string;
  name: string;
  /** 대화 엔진 KB로 실제 들어간 FAQ 건수. 0이면 답변 근거가 없다는 뜻이라 degraded로 본다. */
  entries: number;
  /** 형식 오류로 건너뛴 항목 수(사유는 서버 경고 목록에만 남긴다). */
  skipped: number;
  /** 신청 CTA 주소 — 공개 값이며 환경변수 반영 결과다. 배포 환경에서 기본값인지 확인용. */
  ctaUrl: string;
  /** ctaUrl 이 환경변수(EUM_APPLY_URL 등)로 덮여 있는지. false면 코드 기본값을 쓰는 중이다. */
  ctaFromEnv: boolean;
}

/**
 * 등록된 모든 테넌트의 적재 상태.
 * 심사·운영 점검에서 "FAQ가 실제로 몇 건 로드됐는가"를 배포된 인스턴스에서 확인하기 위한 값이다.
 * KB를 실제로 만들어 세므로 JSON이 깨지면 여기서 드러난다.
 */
export function tenantStatus(env: Record<string, string | undefined> = process.env): TenantLoadStatus[] {
  const list: TenantLoadStatus[] = [];
  for (const id of Object.keys(TENANTS)) {
    const preset = TENANTS[id];
    // 먼저 적재한다 — 캐시가 비어 있으면 이 호출이 변환·경고 수집을 수행한다.
    const entries = tenantKB(preset).length;
    const skipped = loadWarnings.filter((w) => w.startsWith(`[${id}]`)).length;
    const cta = resolveCTA(preset, env);
    const envUrl = preset.cta.urlEnv ? safeHttpUrl(env[preset.cta.urlEnv]) : null;
    list.push({
      id: preset.id,
      name: preset.name,
      entries,
      skipped,
      ctaUrl: cta.url,
      ctaFromEnv: Boolean(envUrl && envUrl === cta.url),
    });
  }
  return list;
}
