// 테넌트 지식 로더 — data/*.json(FAQ 원본)을 대화 엔진 KB로 변환해 캐시한다.
// 프리셋·변환 규칙은 @/lib/tenants(순수 모듈), 데이터 결합만 여기서 한다.
// JSON은 정적 import 한다 — 서버리스 배포에서 파일 경로 접근에 의존하지 않기 위해서다.
import eumFaqDoc from '../../data/eum-faq.json';
import type { KBEntry } from '@/lib/knowledge';
import { listKB } from '@/lib/adminStore';
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

/** 빠른 답장 칩에 쓸 대표 질문 수 — 위젯 폭(375px)에서 두 줄을 넘기지 않는 개수. */
const STARTER_COUNT = 4;

function topQuestions(entries: KBEntry[]): string[] {
  return entries
    .slice(0, STARTER_COUNT)
    .map((e) => e.question)
    .filter((q) => typeof q === 'string' && q.trim().length > 0);
}

/**
 * 위젯에 내려보낼 공개 설정(환경변수 반영).
 * 빠른 답장 칩은 **실제 적재된 FAQ 질문 문구**에서 앞 STARTER_COUNT 건을 그대로 쓴다.
 * 지식이 비어 있으면 칩도 비운다(없는 안내를 만들어 보여주지 않는다).
 */
export function tenantConfig(id: unknown): PublicTenant | null {
  const preset = getTenantPreset(id);
  if (!preset) return null;
  const starters = topQuestions(tenantKB(preset));
  return { ...publicTenant(preset, process.env), ...(starters.length ? { starters } : {}) };
}

/**
 * 테넌트가 없는 기본(GOWON) 위젯의 빠른 답장 — 관리 콘솔 지식베이스(`listKB()`)에서 뽑는다.
 * tenantConfig 는 `id` 가 등록된 프리셋(예: eum)일 때만 값을 돌려주므로, 기본 위젯은 이 함수가
 * 없으면 항상 칩 없이 뜬다(DS 19-1 — 「빠른 답장」이 이음 프리셋에만 연결돼 있던 문제).
 * 등록된 테넌트 대화에는 절대 섞이지 않는다 — 호출부가 tenant 가 없을 때만 이 값을 쓴다(격리 유지).
 */
export function fallbackStarters(): string[] {
  return topQuestions(listKB());
}

export function tenantLoadWarnings(): string[] {
  return [...loadWarnings];
}

/**
 * 자료 id → **지금 그 자료의 이름** (DS 43-2).
 *
 * 평가(`@/lib/feedback`)는 「어느 자료에 대한 평가인가」를 id 로 들고 있고, 이름은 집계할 때
 * 여기서 붙인다 — 이름은 운영자가 고치면 바뀌는 값이라 기록해 두면 같은 자료의 평가가 갈라진다
 * (「이름은 어휘를 아는 쪽이 붙인다」 — DS 36-2·39-2 와 같은 규칙).
 *
 * 이름 규칙은 근거 라벨(`buildCitation` → `entry.source || entry.question`)과 **같아야 한다** —
 * 운영자가 답변 아래에서 본 그 이름이 목록에 떠야 한다. 기본 구성(관리 콘솔 KB)과 등록된
 * 모든 고객사 FAQ 를 함께 담는다(평가에는 고객사를 적지 않으므로 어느 쪽 id 든 찾아야 한다).
 */
export function kbLabelMap(): Record<string, string> {
  const map: Record<string, string> = {};
  const put = (entries: KBEntry[]) => {
    for (const e of entries) {
      if (!e || typeof e.id !== 'string' || !e.id) continue;
      const label = (e.source || '').trim() || (e.question || '').trim();
      if (label) map[e.id] = label;
    }
  };
  put(listKB());
  for (const id of Object.keys(TENANTS)) put(tenantKB(TENANTS[id]));
  return map;
}

/** 테넌트 1건의 적재 상태 — 비밀값 없음(FAQ 본문도 싣지 않는다). */
export interface TenantLoadStatus {
  id: string;
  name: string;
  /**
   * 위젯 브랜드색·헤더 한 글자 — 공개 설정값이다(`publicTenant` 와 같은 값).
   * 「응답 테스트」가 고른 고객사의 상담창을 **그 고객사 모습으로** 미리 보여주기 위해 함께 내려보낸다
   * (DS 36-3 — 종전에는 미리보기가 언제나 고원 헤더였다).
   */
  brandColor: string;
  badge: string;
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
      brandColor: preset.brandColor,
      badge: preset.badge,
      entries,
      skipped,
      ctaUrl: cta.url,
      ctaFromEnv: Boolean(envUrl && envUrl === cta.url),
    });
  }
  return list;
}

/** 관리 콘솔에 보여줄 FAQ 1건(공개 안내 문구 — 개인정보·비밀값 없음). */
export interface TenantFAQView {
  id: string;
  /** 답변에 붙는 근거 라벨 그대로 — "이음 FAQ 3. 활동 시간" */
  citation: string;
  category: string;
  question: string;
  answer: string;
  /** 매칭에 쓰이는 키워드(질문 문구 자동 추가분 포함). */
  keywords: string[];
}

export interface TenantDetail {
  status: TenantLoadStatus;
  /** 위젯이 받는 공개 설정과 동일한 값(문구·색·CTA). */
  config: PublicTenant;
  faq: TenantFAQView[];
  /** 형식 오류로 건너뛴 항목 사유. 비어 있어야 정상이다. */
  warnings: string[];
}

/**
 * 관리 콘솔용 테넌트 상세.
 * 편집 기능은 없다 — 테넌트 FAQ는 파일(data/*.json)이 원본이고, 콘솔은 "지금 배포본이 무엇을 근거로 답하는가"를
 * 확인하는 읽기 전용 창구다. 알 수 없는 id면 null.
 */
export function tenantDetail(id: unknown, env: Record<string, string | undefined> = process.env): TenantDetail | null {
  const preset = getTenantPreset(id);
  if (!preset) return null;
  const status = tenantStatus(env).find((t) => t.id === preset.id);
  if (!status) return null;
  return {
    status,
    config: publicTenant(preset, env),
    faq: tenantKB(preset).map((e) => ({
      id: e.id,
      citation: e.source || '',
      category: e.category,
      question: e.question,
      answer: e.answer,
      keywords: e.keywords,
    })),
    warnings: loadWarnings.filter((w) => w.startsWith(`[${preset.id}]`)),
  };
}

/** 등록된 테넌트 id 목록(콘솔 탭 선택용). */
export function tenantIds(): string[] {
  return Object.keys(TENANTS);
}
