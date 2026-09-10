// 테넌트 프리셋 — 같은 대화 엔진을 고객사별 화면·문구·지식으로 바꿔 끼우기 위한 순수 설정.
// 데이터(FAQ JSON) 로딩은 @/lib/tenantKB 가 담당한다. 이 파일은 의존성 없는 순수 모듈로 유지한다
// (런타임 테스트가 tsc로 단독 컴파일해 검증한다).
//
// 원칙
// - 답변 근거(FAQ 번호)를 반드시 표시한다 → faqToKB()가 source 를 "이음 FAQ 3. 활동 시간" 형태로 채운다.
// - 모르는 질문은 단정하지 않는다 → unknownReply 는 추측 대신 담당자 연결로 안내한다.
// - AI 고지를 유지한다 → aiNotice 를 위젯 헤더에 상시 노출한다.
import type { KBEntry } from '@/lib/knowledge';

/** FAQ 원본 1건(data/*.json 스키마). */
export interface TenantFAQ {
  no: number;
  id: string;
  topic: string;
  category: string;
  question: string;
  keywords: string[];
  answer: string;
}

/** 답변 끝에 붙는 행동 유도 버튼. url 은 환경변수로 덮어쓸 수 있다. */
export interface TenantCTA {
  label: string;
  url: string;
  /** 버튼 옆(또는 아래)에 붙는 한 줄 설명. */
  hint: string;
  /** 이 값이 설정돼 있으면 url 대신 사용한다(배포 환경별 신청 주소). */
  urlEnv?: string;
}

export interface TenantPreset {
  id: string;
  name: string;
  /** 위젯 기본 색(브랜드). */
  brandColor: string;
  /** 헤더 아이콘에 넣는 한 글자. */
  badge: string;
  headerTitle: string;
  headerNote: string;
  greeting: string;
  /** 답을 찾지 못했을 때의 문구 — 추측하지 않고 담당자 연결로 넘긴다. */
  unknownReply: string;
  /** 상담원 연결 트리거로 안내할 단어(채널 공통 문구에 쓴다). */
  agentKeyword: string;
  /** 화면 하단 AI 고지. */
  aiNotice: string;
  cta: TenantCTA;
  /** 근거 표시 접두사 — "이음 FAQ 3. 활동 시간" */
  citationPrefix: string;
  /**
   * 이 테넌트에서 살려 둘 공통 인텐트 룰.
   * 나머지 룰(고원 영업 안내 등)은 건너뛰고 테넌트 FAQ가 답하게 한다 — 다른 브랜드 문구 유출 방지.
   */
  allowedRuleIntents: string[];
  /** 공통 룰 응답문을 테넌트 문구로 교체(키: intent). */
  ruleReplies?: Record<string, string>;
}

export const EUM_APPLY_URL_DEFAULT = 'https://eum-app.vercel.app';

export const EUM_TENANT: TenantPreset = {
  id: 'eum',
  name: '이음',
  brandColor: '#BE5535',
  badge: '이',
  headerTitle: '이음 안내 챗봇',
  headerNote: 'AI가 등록된 안내 자료로 답변합니다',
  greeting:
    '안녕하세요! 이음 안내 챗봇입니다. 신청 방법·참여 자격·활동 시간·활동확인서 등 등록된 안내 자료를 근거로 답변드려요. 무엇이 궁금하세요?',
  unknownReply:
    '이 질문은 제가 가진 안내 자료에 없어서 정확히 답변드리기 어려워요. 잘못 안내드릴 수 있어 추측하지 않겠습니다. 담당 코디네이터에게 연결해 드릴까요? "담당자"라고 입력해 주시면 문의를 접수해 드릴게요.',
  agentKeyword: '담당자',
  aiNotice: 'AI 자동응답 · 등록된 안내 자료 기반 · 정확한 확인은 담당자 연결',
  cta: {
    label: '이음 참여 신청하기',
    url: EUM_APPLY_URL_DEFAULT,
    hint: '신청은 이 버튼으로 하실 수 있어요.',
    urlEnv: 'EUM_APPLY_URL',
  },
  citationPrefix: '이음 FAQ',
  allowedRuleIntents: ['greeting', 'thanks', 'bye', 'agent', 'urgent', 'complaint'],
  ruleReplies: {
    greeting: '안녕하세요! 이음 안내 챗봇입니다. 신청·활동·확인서 관련해 궁금한 점을 물어봐 주세요.',
    thanks: '도움이 되었다니 다행이에요. 더 궁금한 점이 있으면 언제든 물어봐 주세요.',
    bye: '이용해 주셔서 감사합니다. 활동 중 궁금한 점이 생기면 언제든 다시 찾아 주세요.',
    agent: '담당 코디네이터에게 연결해 드릴게요.',
    urgent: '급하신 상황으로 확인했습니다. 담당 코디네이터에게 우선 전달할게요.',
    complaint: '불편을 드려 죄송합니다. 정확히 확인해 도와드릴 수 있도록 담당 코디네이터에게 연결해 드릴게요.',
  },
};

export const TENANTS: Record<string, TenantPreset> = { [EUM_TENANT.id]: EUM_TENANT };

/** 임베드·쿼리로 들어오는 값이라 형식을 먼저 제한한다(경로·스크립트 주입 방지). */
export const TENANT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function isValidTenantId(value: unknown): value is string {
  return typeof value === 'string' && TENANT_ID_RE.test(value);
}

/** 알 수 없는 테넌트는 null — 호출부는 기본(고원) 동작으로 되돌아간다. */
export function getTenantPreset(id: unknown): TenantPreset | null {
  if (!isValidTenantId(id)) return null;
  return TENANTS[id] ?? null;
}

/** http(s) 절대 URL만 허용한다(javascript: 등 차단). */
export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** CTA 확정 — 환경변수(urlEnv)가 유효한 http(s) URL이면 그것을 쓴다. */
export function resolveCTA(preset: TenantPreset, env: Record<string, string | undefined> = {}): TenantCTA {
  const override = preset.cta.urlEnv ? safeHttpUrl(env[preset.cta.urlEnv]) : null;
  const url = override ?? safeHttpUrl(preset.cta.url) ?? EUM_APPLY_URL_DEFAULT;
  return { label: preset.cta.label, url, hint: preset.cta.hint };
}

/** 근거 라벨 — 답변에 표시되는 FAQ 번호. */
export function citationLabel(preset: TenantPreset, faq: TenantFAQ): string {
  return `${preset.citationPrefix} ${faq.no}. ${faq.topic}`;
}

/**
 * FAQ 원본 → 대화 엔진 KB 항목.
 * source 에 FAQ 번호를 넣어 답변에 근거가 항상 따라붙게 한다.
 * 형식이 어긋난 항목은 조용히 버리지 않고 건너뛴 사유를 돌려준다.
 */
export function faqToKB(preset: TenantPreset, faq: unknown): { entries: KBEntry[]; skipped: string[] } {
  const entries: KBEntry[] = [];
  const skipped: string[] = [];
  const list = Array.isArray(faq) ? faq : [];
  for (const [i, raw] of list.entries()) {
    if (!raw || typeof raw !== 'object') {
      skipped.push(`${i + 1}번 항목: 객체가 아닙니다.`);
      continue;
    }
    const f = raw as Partial<TenantFAQ>;
    const keywords = Array.isArray(f.keywords) ? f.keywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean) : [];
    if (!f.id || !f.question || !f.answer || !keywords.length || typeof f.no !== 'number') {
      skipped.push(`${i + 1}번 항목: id·no·question·answer·keywords가 모두 필요합니다.`);
      continue;
    }
    // 질문 문구 자체도 키워드로 넣어 "질문을 그대로 붙여넣는" 사용 패턴을 잡는다.
    const withQuestion = keywords.includes(String(f.question).toLowerCase())
      ? keywords
      : [...keywords, String(f.question).toLowerCase()];
    entries.push({
      id: String(f.id),
      category: String(f.category || preset.name),
      question: String(f.question),
      keywords: withQuestion,
      answer: String(f.answer),
      source: citationLabel(preset, f as TenantFAQ),
    });
  }
  return { entries, skipped };
}

/** 위젯(클라이언트)에 내려보내는 공개 설정 — 비밀값이 섞이지 않도록 화이트리스트로 만든다. */
export interface PublicTenant {
  id: string;
  name: string;
  brandColor: string;
  badge: string;
  headerTitle: string;
  headerNote: string;
  greeting: string;
  aiNotice: string;
  cta: { label: string; url: string; hint: string };
  /**
   * 대화를 시작하기 전 위젯에 보여줄 빠른 답장 칩(등록된 FAQ 질문 문구 그대로).
   * 값은 @/lib/tenantKB 가 실제 적재된 KB에서 채운다 — 여기서 지어내지 않는다.
   */
  starters?: string[];
}

export function publicTenant(preset: TenantPreset, env: Record<string, string | undefined> = {}): PublicTenant {
  return {
    id: preset.id,
    name: preset.name,
    brandColor: preset.brandColor,
    badge: preset.badge,
    headerTitle: preset.headerTitle,
    headerNote: preset.headerNote,
    greeting: preset.greeting,
    aiNotice: preset.aiNotice,
    cta: resolveCTA(preset, env),
  };
}
