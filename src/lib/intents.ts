// 대화 표시명(주제·채널·응답 근거) — 운영자 화면·이관 요약·내려받기 파일이 함께 쓰는 단일 출처.
//
// 왜 필요한가: 인텐트 코드(`pricing` · `kb:환불` · `cr_m1x2y3` · `form:reservation:datetime`)는
// 엔진 안에서만 뜻이 통하는 식별자다. 종전에는 관리 콘솔이 **따로 적어 둔 사전 9개**로 이름을
// 붙이고 없으면 코드를 그대로 그렸다. 그 사전에는 엔진이 한 번도 내지 않는 키(`price`·`handoff`·
// `unknown`·`faq`)가 들어 있었고, 정작 가장 흔한 세 경로 — 등록 자료로 답한 대화(`kb:*`),
// 아직 분류되지 않은 대화(`fallback`), 운영자가 직접 만든 규칙(`cr_*`) — 에는 이름이 없어
// 운영자 화면에 영문 코드가 그대로 떴다.
//
// 그래서 이름은 **코드 어휘를 아는 쪽**에서 붙인다 — 내장 룰은 `RULES[].label`(콘솔 「시나리오 규칙」
// 탭이 이미 보여주는 그 이름)을 그대로 재사용하므로 룰을 하나 더 만들어도 사전을 고칠 일이 없다.
import { RULES } from '@/lib/rules';

/** 룰·자료·폼이 아닌 자리에서 엔진이 직접 붙이는 인텐트(`src/lib/chat.ts`). */
const ENGINE_LABELS: Record<string, string> = {
  empty: '빈 메시지',
  fallback: '분류 전',
  llm: 'AI 생성 답변',
  contact_captured: '연락처 받음',
  contact_skipped: '연락처 없이 진행',
  error: '연결 오류',
};

/**
 * 멀티턴 접수 폼 제목 — `src/lib/slots.ts` 의 `FORMS[].id`·`title` 과 같아야 한다.
 * 여기서 `slots.ts` 를 직접 불러오지 않는 이유: `slots → handoff → intents` 로 이미 이어져 있어
 * 되돌아 불러오면 모듈 순환이 된다. 대신 테스트가 두 쪽을 대조해 어긋나면 실패시킨다.
 */
const FORM_TITLES: Record<string, string> = {
  reservation: '예약 접수',
  trouble: '장애 신고 접수',
};

/** 이름을 붙일 수 없는 코드의 표시명 — 화면에 코드를 그대로 내보내지 않는다. */
export const UNKNOWN_INTENT_LABEL = '기타';

const RULE_LABELS: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const r of RULES) out[r.intent] = r.label;
  return out;
})();

/** `form:<폼 id>:<단계>` — 어느 접수가 어디까지 갔는지로 읽는다. */
function formLabel(rest: string): string {
  const parts = rest.split(':');
  const title = FORM_TITLES[parts[0]] ?? '접수';
  const stage = parts.slice(1).join(':');
  if (stage === 'start') return `${title} 시작`;
  if (stage === 'complete') return `${title} 완료`;
  if (stage === 'cancelled') return `${title} 중단`;
  if (stage === 'max_retry') return `${title} · 상담원 연결`;
  return `${title} 진행 중`;
}

/**
 * 인텐트 코드 → 사람이 읽는 주제명. 어떤 입력에도 **코드를 되돌려주지 않는다**.
 * @param extra 운영자가 만든 규칙(`cr_*`)처럼 런타임에만 아는 이름(`intentLabelMap()` 참고)
 */
export function intentLabel(intent: string, extra?: Record<string, string>): string {
  const code = (intent || '').trim();
  if (!code) return UNKNOWN_INTENT_LABEL;
  const custom = extra?.[code];
  if (custom) return custom;
  if (RULE_LABELS[code]) return RULE_LABELS[code];
  if (ENGINE_LABELS[code]) return ENGINE_LABELS[code];
  if (code.startsWith('kb:')) {
    const category = code.slice(3).trim();
    return category ? `자료 안내 · ${category}` : '자료 안내';
  }
  if (code.startsWith('form:')) return formLabel(code.slice(5));
  return UNKNOWN_INTENT_LABEL;
}

/**
 * 채널·응답 근거 표시명 — 관리 콘솔 표가 쓰는 말과 같아야 한다(테스트가 콘솔 쪽 사전과 대조한다).
 * 콘솔은 클라이언트 번들이라 lib 을 불러오지 않으므로 같은 값을 옮겨 적고, 어긋나면 테스트가 잡는다
 * (`MAX_DOC_CHARS`·`kstMonthNow` 와 같은 방식).
 */
export const CHANNEL_LABELS: Record<string, string> = {
  web: '홈페이지',
  kakao: '카카오톡',
  call: '전화',
};

export const SOURCE_LABELS: Record<string, string> = {
  rule: '시나리오 규칙',
  kb: '등록 자료',
  llm: 'AI 생성',
  context: '이어지는 대화',
  fallback: '기본 안내',
  empty: '내용 없음',
  error: '연결 오류',
};

/** 규칙 목록을 `{인텐트: 이름}` 으로 — 운영자가 만든 규칙의 이름을 주제에 붙이는 데 쓴다. */
export function intentLabelMap(rules: readonly { intent: string; label: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rules) {
    if (r.intent && r.label) out[r.intent] = r.label;
  }
  return out;
}
