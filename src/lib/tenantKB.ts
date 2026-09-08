// 테넌트 지식 로더 — data/*.json(FAQ 원본)을 대화 엔진 KB로 변환해 캐시한다.
// 프리셋·변환 규칙은 @/lib/tenants(순수 모듈), 데이터 결합만 여기서 한다.
// JSON은 정적 import 한다 — 서버리스 배포에서 파일 경로 접근에 의존하지 않기 위해서다.
import eumFaqDoc from '../../data/eum-faq.json';
import type { KBEntry } from '@/lib/knowledge';
import { faqToKB, getTenantPreset, publicTenant, type PublicTenant, type TenantPreset } from '@/lib/tenants';

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
