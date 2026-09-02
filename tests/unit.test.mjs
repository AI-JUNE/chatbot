/**
 * 챗봇 순수 로직 불변식 테스트 (의존성 0, 빌드 불필요).
 * TypeScript 소스를 텍스트로 읽어 계약·규정 준수를 검증한다.
 * 실제 실행 동작 검증은 tests/runtime.test.mjs(컴파일 후 import)가 담당한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const has = (p) => existsSync(new URL(`../${p}`, import.meta.url));

/** 전체 API 라우트 목록(라우트 규칙 검사용). */
const ROUTES = [
  'src/app/api/chat/route.ts',
  'src/app/api/health/route.ts',
  'src/app/api/escalation/route.ts',
  'src/app/api/kakao/webhook/route.ts',
  'src/app/api/shared/scenario/route.ts',
  'src/app/api/admin/auth/route.ts',
  'src/app/api/admin/audit/route.ts',
  'src/app/api/admin/backup/route.ts',
  'src/app/api/admin/escalations/route.ts',
  'src/app/api/admin/kb/route.ts',
  'src/app/api/admin/kb/import/route.ts',
  'src/app/api/admin/logs/export/route.ts',
  'src/app/api/admin/rules/route.ts',
].filter(has);

/* ── 안전 플래그: build now, activate on approval ── */
test('LLM 실연동은 플래그로 차단되어 있다', () => {
  const s = read('src/lib/chat.ts');
  assert.match(s, /CHAT_LLM_LIVE/, 'LLM_LIVE 플래그가 있어야 한다');
  assert.match(s, /process\.env\.CHAT_LLM_LIVE === 'true'/, '기본값은 비활성이어야 한다');
});

test('관리자 인증 게이트가 플래그로 제어된다', () => {
  const s = read('src/lib/http.ts');
  assert.match(s, /ADMIN_AUTH_REQUIRED/);
});

test('시크릿이 소스에 하드코딩되어 있지 않다', () => {
  for (const f of ['src/lib/chat.ts', 'src/lib/http.ts', 'src/lib/kakao.ts']) {
    const s = read(f);
    assert.equal(/sk-[A-Za-z0-9]{16,}/.test(s), false, `${f}에 API 키로 보이는 문자열이 있다`);
  }
});

/* ── AI 고지 (AI기본법 §10.1) ── */
test('랜딩에 AI 응대 고지가 있다', () => {
  assert.match(read('src/app/page.tsx'), /인공지능\(AI\)이 응대합니다/);
});

test('채팅 위젯이 AI임을 밝힌다', () => {
  const s = read('src/components/ChatWidget.tsx');
  assert.match(s, /인공지능\(AI\)/, '첫 인사말에 AI 고지가 있어야 한다');
  assert.match(s, /AI가 응대합니다/, '헤더에 AI 고지가 있어야 한다');
});

/* ── 대화 엔진 계약 ── */
test('연락처 추출은 전화번호와 이메일을 모두 지원한다', () => {
  const s = read('src/lib/chat.ts');
  assert.match(s, /export function extractContact/);
  assert.match(s, /PHONE_RE/);
  assert.match(s, /EMAIL_RE/);
});

test('건너뛰기 의사표현을 인식한다', () => {
  assert.match(read('src/lib/chat.ts'), /SKIP_RE/);
});

test('응답 출처(source)가 분류되어 있다', () => {
  const s = read('src/lib/chat.ts');
  for (const src of ['rule', 'kb', 'llm', 'fallback', 'empty', 'context']) {
    assert.match(s, new RegExp(`'${src}'`), `source '${src}' 가 정의되어야 한다`);
  }
});

test('빈 입력을 안전하게 처리한다', () => {
  assert.match(read('src/lib/chat.ts'), /intent: 'empty'/);
});

/* ── 상담원 폴백 ── */
test('에스컬레이션 상태 4종이 정의되어 있다', () => {
  const s = read('src/lib/escalation.ts');
  for (const st of ['open', 'in_progress', 'resolved', 'canceled']) {
    assert.match(s, new RegExp(`'${st}'`));
  }
});

test('티켓 생성·조회 API가 있다', () => {
  const s = read('src/lib/escalation.ts');
  assert.match(s, /export function createTicket/);
  assert.match(s, /export function listTickets/);
});

/* ── 표준 에러·입력검증 ── */
test('표준 에러 응답과 본문 크기 상한이 있다', () => {
  const s = read('src/lib/http.ts');
  assert.match(s, /export function fail/);
  assert.match(s, /MAX_BODY_BYTES/);
  assert.match(s, /MAX_IMPORT_BYTES/);
});

test('rate limit 유틸이 있다', () => {
  const s = read('src/lib/ratelimit.ts');
  assert.match(s, /export function checkRate/);
  assert.match(s, /Retry-After|retryAfter/i);
});

/* ── 필수 라우트 ── */
test('핵심 API 라우트가 존재한다', () => {
  for (const p of [
    'src/app/api/chat/route.ts',
    'src/app/api/health/route.ts',
    'src/app/api/escalation/route.ts',
    'src/app/api/kakao/webhook/route.ts',
    'src/app/api/admin/auth/route.ts',
  ]) {
    assert.equal(has(p), true, `${p} 가 있어야 한다`);
  }
});

test('법적 문서 페이지가 있다', () => {
  assert.equal(has('src/app/terms/page.tsx'), true);
  assert.equal(has('src/app/privacy/page.tsx'), true);
});

/* ── 규정: 임의 성과 수치 금지 (설계서 §13-2·13-3) ── */
test('랜딩에 근거 없는 성과 수치를 넣지 않는다', () => {
  const s = read('src/app/page.tsx');
  assert.equal(/300ms/.test(s), false, '300ms 표기는 금지');
  assert.equal(/99\.9\s*%/.test(s), false, '99.9% 가용성 표기는 금지');
});

/* ── 대화 품질: 동의어·오타 보정 ── */
test('정규화 모듈이 자모 분해와 동의어 그룹을 제공한다', () => {
  const s = read('src/lib/normalize.ts');
  assert.match(s, /export function decomposeJamo/, '자모 분해 함수가 있어야 한다');
  assert.match(s, /export function approxIncludes/, '근사 부분문자열 매칭이 있어야 한다');
  assert.match(s, /SYNONYM_GROUPS/, '동의어 그룹이 있어야 한다');
  assert.match(s, /카톡/, '카카오톡 표기 흔들림이 동의어에 포함되어야 한다');
});

test('정확 일치 가중치가 오타 보정보다 높다', () => {
  const s = read('src/lib/normalize.ts');
  const m = s.match(/MATCH_WEIGHT[^=]*=\s*{([^}]*)}/);
  assert.ok(m, 'MATCH_WEIGHT 정의가 있어야 한다');
  const exact = Number(m[1].match(/exact:\s*([\d.]+)/)[1]);
  const fuzzy = Number(m[1].match(/fuzzy:\s*([\d.]+)/)[1]);
  assert.ok(exact > fuzzy, '오타 보정 매칭이 정확 일치를 밀어내면 안 된다');
});

test('KB·커스텀 룰 매칭이 정규화 모듈을 사용한다', () => {
  assert.match(read('src/lib/knowledge.ts'), /from '@\/lib\/normalize'/);
  assert.match(read('src/lib/adminStore.ts'), /from '@\/lib\/normalize'/);
});

/* ── 근거 문장 인용 ── */
test('KB 답변에 근거 인용이 붙는다', () => {
  const k = read('src/lib/knowledge.ts');
  assert.match(k, /export function buildCitation/, '인용 생성 함수가 있어야 한다');
  assert.match(k, /export interface Citation/);
  assert.match(read('src/lib/chat.ts'), /citation\?: Citation/, 'ChatReply에 citation이 있어야 한다');
  assert.match(read('src/components/ChatWidget.tsx'), /근거/, '위젯이 근거를 표시해야 한다');
});

test('근거 문장은 원문에서 그대로 뽑는다(생성 요약 금지)', () => {
  const k = read('src/lib/knowledge.ts');
  assert.match(k, /splitSentences/, '답변을 문장 단위로 잘라 고른다');
  assert.equal(/CHAT_LLM_LIVE|fetch\(/.test(k), false, '지식 매칭 계층은 외부 호출을 하지 않아야 한다');
});

/* ── 문서 업로드·청킹 ── */
test('문서 인제스트가 상한과 승인 게이트를 지킨다', () => {
  assert.ok(has('src/lib/ingest.ts'), 'ingest 모듈이 있어야 한다');
  const s = read('src/lib/ingest.ts');
  assert.match(s, /MAX_DOC_CHARS/, '문서 크기 상한이 있어야 한다');
  assert.match(s, /\[승인 필요\]/, '임베딩·외부 스토리지는 승인 대상으로 표시되어야 한다');
});

test('문서 등록 API는 기본이 미리보기(dry-run)다', () => {
  const p = 'src/app/api/admin/kb/import/route.ts';
  assert.ok(has(p), '문서 등록 라우트가 있어야 한다');
  const s = read(p);
  assert.match(s, /requireAdmin/, '관리자 게이트를 거쳐야 한다');
  assert.match(s, /body\.commit !== true/, 'commit=true 가 아니면 저장하지 않아야 한다');
  assert.match(s, /committed: false/, '미리보기 응답이 있어야 한다');
});

/* ── 오류 모니터링 (상용 필수) ── */
test('모니터링은 DSN 미설정 시 no-op 이다', () => {
  const s = read('src/lib/monitoring.ts');
  assert.match(s, /MONITORING_ENABLED/);
  assert.match(s, /if \(!TARGET\) return;/, 'DSN 없으면 즉시 반환해야 한다');
});

test('모니터링 전송 전 PII를 마스킹한다', () => {
  const s = read('src/lib/monitoring.ts');
  assert.match(s, /export function scrub/);
  for (const k of ['주민등록번호', '카드', '휴대전화', '이메일', '계좌']) {
    assert.match(s, new RegExp(k), `${k} 마스킹 규칙이 있어야 한다`);
  }
});

test('모니터링 실패가 서비스에 영향을 주지 않는다', () => {
  const s = read('src/lib/monitoring.ts');
  // captureError 본문만 검사한다(withMonitoring은 의도적으로 재던짐).
  const body = (s.split('export async function captureError')[1] ?? '').split('export async function withMonitoring')[0];
  assert.notEqual(body, '', 'captureError 정의를 찾지 못했다');
  assert.equal(/throw/.test(body), false, 'captureError는 예외를 밖으로 던지지 않아야 한다');
  assert.match(body, /catch/, '전송 예외를 흡수해야 한다');
});

test('DSN이 소스에 하드코딩되어 있지 않다', () => {
  const s = read('src/lib/monitoring.ts');
  assert.equal(/ingest\.[a-z]*\.?sentry\.io/.test(s), false, 'DSN은 환경변수로만 주입해야 한다');
  assert.match(s, /process\.env\.SENTRY_DSN/);
});

test('대화 API가 엔진 오류를 모니터링에 보고한다', () => {
  const s = read('src/app/api/chat/route.ts');
  assert.match(s, /captureError/);
});

test('헬스체크가 모니터링 상태와 빌드 정보를 노출한다', () => {
  const s = read('src/app/api/health/route.ts');
  assert.match(s, /MONITORING_ENABLED/);
  assert.match(s, /commit:/);
  // DSN 값 자체는 절대 노출하지 않는다
  assert.equal(/SENTRY_DSN\s*[,}]/.test(s.replace(/process\.env\.SENTRY_DSN/g, '')), false);
});

/* ── 신뢰도 임계 기반 상담원 자동 전환 ── */
test('신뢰도 임계·연속 한도가 정책 상수로 노출된다', () => {
  const s = read('src/lib/chat.ts');
  assert.match(s, /export const CONFIDENCE_THRESHOLD/);
  assert.match(s, /export const LOW_CONFIDENCE_STREAK_LIMIT/);
  assert.match(s, /CHAT_CONFIDENCE_THRESHOLD/, '환경변수로 조정 가능해야 한다');
});

test('신뢰도는 성능 지표가 아님을 코드가 명시한다', () => {
  const s = read('src/lib/chat.ts');
  assert.match(s, /측정된 정확도·성능 지표가 아니다|측정된 품질 지표가 아니다/);
});

test('대기 순번은 접수순 표시일 뿐 예상 대기시간을 만들지 않는다', () => {
  const s = read('src/lib/escalation.ts');
  assert.match(s, /export function queuePosition/);
  assert.match(s, /예상 대기시간을 계산하지 않는다/);
  assert.equal(/예상 대기\s*(시간)?\s*[:=]\s*\d/.test(s), false, '임의 대기시간 수치를 넣으면 안 된다');
});

/* ── 이관 요약·마스킹 ── */
test('이관 요약은 규칙 기반이며 LLM을 부르지 않는다', () => {
  const s = read('src/lib/handoff.ts');
  assert.match(s, /export function buildHandoffSummary/);
  assert.match(s, /generator: 'rule'/);
  assert.equal(/fetch\(|CHAT_LLM_LIVE/.test(s), false, '요약 경로에 외부 호출이 있으면 안 된다');
});

test('요약 본문이 개인정보 마스킹을 통과한다', () => {
  const s = read('src/lib/handoff.ts');
  assert.match(s, /export function maskPii/);
  for (const kind of ['rrn', 'card', 'phone', 'email', 'account']) {
    assert.match(s, new RegExp(`name: '${kind}'`), `${kind} 마스킹 규칙이 있어야 한다`);
  }
  assert.match(read('src/lib/escalation.ts'), /summary\?: string/, '티켓이 요약을 보관해야 한다');
});

/* ── AICC-Core 정합 (§5.3 Flow · 채널 계약) ── */
test('Core Flow 노드 6종을 그대로 미러링한다', () => {
  const s = read('src/lib/sharedSchema.ts');
  assert.match(s, /CORE_FLOW_NODE_KINDS = \['Say', 'Collect', 'Choice', 'Confirm', 'Transfer', 'Api'\]/);
  assert.match(s, /export function renderSharedNode/, '채널 렌더러가 있어야 한다');
  assert.match(s, /export function validateFlow/);
});

test('이관 사유 어휘가 Core Handoff와 같다', () => {
  const s = read('src/lib/handoff.ts');
  assert.match(s, /'low_confidence' \| 'customer_request' \| 'policy' \| 'error' \| 'max_retry'/);
  assert.match(read('src/lib/escalation.ts'), /reasonCode: HandoffReason/);
});

test('공용 번들이 Core 계약 메타를 실어 드리프트를 감지한다', () => {
  const s = read('src/lib/sharedSchema.ts');
  assert.match(s, /coreContract\?: SharedCoreContract/);
  assert.match(s, /채널 계약 버전 불일치/, '버전 불일치를 검증해야 한다');
  assert.match(s, /flows\?: SharedFlow\[\]/, 'v1 소비자 호환을 위해 옵셔널이어야 한다');
  assert.match(s, /SHARED_SCHEMA_VERSION = 1/, '기존 소비자를 깨지 않도록 버전은 유지한다');
});

/* ── 구조화 로깅 (상용 필수) ── */
test('로그 화이트리스트에 대화 본문·연락처·세션ID 원문이 없다', () => {
  const s = read('src/lib/logger.ts');
  assert.match(s, /export const ALLOWED_FIELDS/);
  const list = (s.split('ALLOWED_FIELDS = [')[1] ?? '').split(']')[0];
  assert.notEqual(list, '', 'ALLOWED_FIELDS 정의를 찾지 못했다');
  for (const banned of ['message', 'reply', 'contact', 'sessionId', 'summary']) {
    assert.equal(new RegExp(`'${banned}'`).test(list), false, `${banned}는 로그에 허용하면 안 된다`);
  }
  assert.match(list, /'requestId'|'route'/, '요청 추적 필드는 허용되어야 한다');
  assert.match(s, /scrub/, '허용 필드도 마스킹을 거쳐야 한다');
});

test('공개 API가 요청 로그와 x-request-id 응답 헤더를 남긴다', () => {
  for (const f of ['src/app/api/chat/route.ts', 'src/app/api/escalation/route.ts']) {
    const s = read(f);
    assert.match(s, /startRequest\(/, `${f}에 요청 로거가 없다`);
    assert.match(s, /withRequestId\(/, `${f}가 요청 ID를 응답에 싣지 않는다`);
    // rl.end({...}) 인자에 본문·연락처 필드를 그대로 넘기지 않는지(속성 접근 e.message 는 제외)
    for (const call of s.match(/rl\.end\(\{[\s\S]*?\}\)/g) ?? []) {
      for (const banned of ['message', 'contact', 'reply', 'summary', 'sessionId']) {
        assert.equal(
          new RegExp(`(?<![.\\w])${banned}\\s*[,:}]`).test(call),
          false,
          `${f}가 ${banned}를 로그에 넘긴다`,
        );
      }
    }
  }
  assert.match(read('src/app/api/chat/route.ts'), /sessionHash/, '세션은 해시로만 남겨야 한다');
});

test('요청 로그는 라우트 파일 export 규칙을 깨지 않는다', () => {
  // route.ts에 HTTP 메서드·설정 외 export가 있으면 Next 빌드가 실패한다.
  const allowed = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'dynamic', 'revalidate', 'runtime', 'maxDuration']);
  for (const f of ROUTES) {
    const s = read(f);
    for (const m of s.matchAll(/^export (?:const|function|async function) ([A-Za-z_]+)/gm)) {
      assert.ok(allowed.has(m[1]), `${f}에 허용되지 않은 export가 있다: ${m[1]}`);
    }
  }
});
