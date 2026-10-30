/**
 * 챗봇 순수 로직 불변식 테스트 (의존성 0, 빌드 불필요).
 * TypeScript 소스를 텍스트로 읽어 계약·규정 준수를 검증한다.
 * 실제 실행 동작 검증은 tests/runtime.test.mjs(컴파일 후 import)가 담당한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const has = (p) => existsSync(new URL(`../${p}`, import.meta.url));

/** 전체 API 라우트 목록(라우트 규칙 검사용). */
const ROUTES = [
  'src/app/api/chat/route.ts',
  'src/app/api/health/route.ts',
  'src/app/api/escalation/route.ts',
  'src/app/api/feedback/route.ts',
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
  'src/app/api/admin/partners/route.ts',
  'src/app/api/admin/settlement/route.ts',
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
  // 고르는 자는 **가리는 쪽에 한 벌**로 있다 (DS 53-1) — 전화·이메일 모양을 여기 적지 않는다.
  assert.match(s, /findContact\(text\)\?\.value \?\? null/);
  const pii = read('src/lib/pii.ts');
  assert.match(pii, /export function findContact/);
  assert.match(pii, /PHONE_FIND = new RegExp\(PHONE_MATCH_PATTERN\)/);
  assert.match(pii, /EMAIL_FIND = new RegExp\(EMAIL_PATTERN\)/);
});

test('건너뛰기 의사표현을 인식한다', () => {
  // 가리는 자는 `lib/choice` 한 곳이다 (DS 69-3) — 종전에는 이 파일에 `SKIP_RE` 가 한 벌,
  // `lib/slots` 에 또 한 벌 있었고 말 목록까지 달랐다.
  assert.match(read('src/lib/chat.ts'), /isSkip\(text\)/);
  assert.match(read('src/lib/choice.ts'), /export function isSkip/);
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
  // 규칙은 `@/lib/pii` 하나에만 있다 (DS 39-3) — 이 파일이 자기 규칙을 들고 있던 동안에는
  // 이관 요약 쪽보다 느슨해서(계좌에 하이픈을 필수로 둠) 안에서는 가리고 밖으로는 내보냈다.
  assert.match(s, /import \{ maskPii \} from '@\/lib\/pii'/, '마스킹 단일 출처를 불러오지 않는다');
  assert.match(s, /maskPii\(String\(input\), 'opaque'\)\.text/, '울타리 밖으로 나가는 자리가 opaque 가 아니다');
  assert.equal(/\.replace\(\/\\b\(\\d\{6\}\)/.test(s), false, '마스킹 규칙을 따로 들고 있다');
  const pii = read('src/lib/pii.ts');
  for (const k of ['주민등록번호', '카드', '휴대폰 번호', '이메일', '계좌']) {
    assert.match(pii, new RegExp(k), `${k} 마스킹 규칙이 있어야 한다`);
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

/**
 * DS 76-1 — 울타리 밖으로 나가는 문맥 칸은 **글자만** 가리는 것이 아니다.
 * 「정말 그렇게 동작하는가」는 `tests/runtime.test.mjs` 가 돌려서 본다 — 여기서는 느슨한
 * 삼항(글자일 때만 가리고 나머지는 그대로)이 되돌아오지 않는지, 로거와 **같은 규칙**인지를 고정한다.
 */
test('오류 리포트의 문맥 칸이 로거와 같은 규칙으로 좁혀진다 (DS 76-1)', () => {
  const s = read('src/lib/monitoring.ts');
  assert.match(s, /export function safeExtra/, '문맥 칸을 고르는 자에 이름이 있어야 한다');
  assert.match(s, /extra: safeExtra\(ctx\)/, '리포트가 그 자를 지나야 한다');
  assert.equal(
    /typeof v === 'string' \? scrub\(v\)\.slice\([^)]*\) : v/.test(s),
    false,
    '글자일 때만 가리고 나머지를 그대로 싣는 식이 되돌아왔다',
  );
  // 두 쪽이 같은 규칙을 적는다 — 객체·배열은 **버리고 이름만** 남긴다.
  for (const f of ['src/lib/monitoring.ts', 'src/lib/logger.ts']) {
    const t = read(f);
    assert.match(t, /객체·배열[^\n]*기록하지 않는다|객체·배열[^\n]*보내지 않는다/, `${f} 에 객체를 버리는 규칙이 없다`);
    assert.match(t, /dropped\.push\(k\.slice\(0, 40\)\)/, `${f} 가 버린 칸의 이름을 남기지 않는다`);
  }
});

/**
 * DS 76-2 — 리포트를 보내는 일이 고객의 응답을 붙잡지 않는다.
 * 종전에는 `captureError` 가 수집기 응답까지 `await` 했고 부르는 자리가 그것을 또 기다렸다.
 */
test('리포트 전송이 응답 경로 밖에서 끝난다 (DS 76-2)', () => {
  const s = read('src/lib/monitoring.ts');
  const body = (s.split('export async function captureError')[1] ?? '').split('export async function withMonitoring')[0];
  assert.notEqual(body, '', 'captureError 정의를 찾지 못했다');
  assert.equal(/await fetch\(/.test(body), false, '만드는 자가 전송을 기다리고 있다');
  assert.match(body, /const job = send\(/, '보내는 일을 따로 맡겨야 한다');
  assert.equal((s.match(/await fetch\(/g) || []).length, 1, '전송하는 자리는 한 곳이어야 한다');
  assert.match(s, /export function pendingReports/, '반드시 보내야 하는 자리가 기다릴 길이 있어야 한다');
  assert.equal((s.match(/SEND_TIMEOUT_MS = /g) || []).length, 1, '전송 상한을 정하는 자리는 한 곳이어야 한다');
  assert.match(s, /AbortSignal\.timeout\(SEND_TIMEOUT_MS\)/, '전송 상한을 그 자리에 다시 적지 않아야 한다');
});

/**
 * DS 76-3 — 「설정됐는가」와 「접수되는가」는 다른 값이다.
 * 종전에는 전자만 있었고, 전송 결과는 읽지도 세지도 않았다.
 */
test('리포트 접수 결과를 세고 콘솔이 그 수를 사람 말로 적는다 (DS 76-3)', () => {
  const m = read('src/lib/monitoring.ts');
  assert.match(m, /export function monitoringState/, '접수 결과를 말하는 자가 있어야 한다');
  assert.match(m, /counters\.lastFailure = 'rejected'/, '수집기가 거절한 것을 세야 한다');
  assert.match(m, /e\.name === 'AbortError' \? 'timeout' : 'network'/, '닿지 못한 것과 시간 초과를 구분해야 한다');

  const h = read('src/app/api/health/route.ts');
  assert.match(h, /monitoringReports/, '헬스체크가 접수 결과를 적지 않는다');
  // 「리포트가 거절되고 있다」는 우리 설정의 상태다 — 토큰을 맞춘 사람에게만 적는다 (DS 49-2).
  const authedBlock = h.slice(h.indexOf('...(authed'));
  assert.match(authedBlock, /monitoringReports/, '접수 결과가 인증 없이 노출된다');
  // 수집기는 우리 서비스의 의존성이 아니다 — 신호등을 노랑으로 만들지 않는다.
  assert.equal(/failing\.length \|\| brokenTenant \|\| /.test(h), false, '수집기 상태가 서비스 신호등을 흔든다');

  const ui = read('src/app/admin/page.tsx');
  assert.match(ui, /aria-labelledby="monitor-h"/, '콘솔에 오류 수집 섹션이 없다');
  assert.match(ui, /const REPORT_FAILURE: Record<ReportFailureCode, string>/, '사유 문장을 사람 말로 들고 있어야 한다');
  assert.match(ui, /오류 수집처가 설정되지 않았습니다/, '미설정일 때 사실을 적어야 한다');
  assert.match(ui, /수집처에 접수되지 않았습니다/, '실패를 문장으로 적어야 한다');
  assert.match(ui, /서버 1대가 센 값/, '보여 준 수를 전부라고 말하지 않아야 한다 (DS 31-3)');
  // 응답 코드·환경변수명은 운영자 화면에 적지 않는다.
  const visible = ui.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/**')).join('\n');
  for (const leak of ['SENTRY', 'Sentry', 'envelope']) {
    assert.equal(visible.includes(leak), false, `콘솔 화면에 내부 문구 노출: ${leak}`);
  }
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
  // 규칙은 `@/lib/pii` 하나(DS 39-3). 요약은 그 함수를 **불러서** 쓴다 — 종전에는 이 파일이
  // 규칙을 들고 있어서, 외부로 나가는 쪽(`monitoring.scrub`)과 어긋나도 아무도 몰랐다.
  const pii = read('src/lib/pii.ts');
  assert.match(pii, /export function maskPii/);
  for (const kind of ['rrn', 'card', 'phone', 'email', 'account']) {
    assert.match(pii, new RegExp(`name: '${kind}'`), `${kind} 마스킹 규칙이 있어야 한다`);
  }
  const s = read('src/lib/handoff.ts');
  assert.match(s, /from '@\/lib\/pii'/, '요약이 마스킹 단일 출처를 불러오지 않는다');
  assert.equal(/const MASK_RULES/.test(s), false, '요약이 마스킹 규칙을 따로 들고 있다');
  assert.match(s, /const m = maskPii\(String\(value\)\)/, '수집 정보가 마스킹을 지나지 않는다');
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

/* ── 저장소 어댑터 (영속화) ── */
test('개인정보 포함 네임스페이스는 승인 플래그 없이 저장되지 않는다', () => {
  const s = read('src/lib/storage.ts');
  assert.match(s, /process\.env\.PERSIST_PII === 'true'/, '기본값은 비활성이어야 한다');
  // 티켓·대화로그는 pii:true 로 등록되어야 한다
  const nsBlock = (s.split('export const NAMESPACES')[1] ?? '').split('};')[0];
  for (const ns of ['tickets', 'convlog']) {
    assert.ok(new RegExp(`${ns}:[^\\n]*pii: true`).test(nsBlock), `${ns}는 pii:true 로 등록되어야 한다`);
  }
  // 평가는 평가값·근거 라벨·세션 해시뿐이라 개인정보가 없다(DS 32-1) — 승인 게이트 없이 저장한다.
  for (const ns of ['admin', 'audit', 'feedback']) {
    assert.ok(new RegExp(`${ns}:[^\\n]*pii: false`).test(nsBlock), `${ns}는 개인정보 없음(pii:false)으로 등록되어야 한다`);
  }
});

test('저장 실패를 조용히 삼키지 않는다(상태·로그에 남긴다)', () => {
  const s = read('src/lib/storage.ts');
  assert.match(s, /function recordFailure/, '실패 기록 경로가 있어야 한다');
  assert.match(s, /log\(/, '실패는 로그로 나가야 한다');
  assert.match(s, /captureError/, '예기치 못한 실패는 모니터링으로 보고해야 한다');
  assert.match(s, /export function storageStatus/, '운영자가 상태를 볼 수 있어야 한다');
  // 원자적 쓰기(tmp → rename)로 반쪽 파일을 남기지 않는다
  assert.match(s, /renameSync/, '원자적 쓰기여야 한다');
});

test('영속화가 필요한 스토어가 저장소 어댑터에 연결되어 있다', () => {
  for (const f of ['src/lib/adminStore.ts', 'src/lib/audit.ts', 'src/lib/escalation.ts', 'src/lib/convlog.ts']) {
    const s = read(f);
    assert.match(s, /from '@\/lib\/storage'/, `${f}가 저장소 어댑터를 쓰지 않는다`);
    assert.match(s, /loadJson\(/, `${f}에 복원 경로가 없다`);
  }
  // 직접 fs 접근은 저장소 어댑터에만 있어야 한다(드라이버 교체 가능성 유지)
  for (const f of ['src/lib/adminStore.ts', 'src/lib/audit.ts', 'src/lib/escalation.ts', 'src/lib/convlog.ts']) {
    assert.equal(/from 'fs'/.test(read(f)), false, `${f}가 파일시스템을 직접 다룬다`);
  }
});

test('/health가 저장소 의존성 상태를 노출한다(민감정보 제외)', () => {
  const s = read('src/app/api/health/route.ts');
  assert.match(s, /storageStatus\(\)/);
  assert.match(s, /dependencies/);
  assert.match(s, /driver/);
  assert.equal(/STORAGE_DIR|ADMIN_PERSIST_FILE|filePathFor/.test(s), false, '저장 경로는 노출하지 않는다');
});

test('관리 콘솔에 저장소 상태(빈 상태·오류 상태 포함) 화면이 있다', () => {
  const s = read('src/app/admin/page.tsx');
  assert.match(s, /저장소 상태/);
  assert.match(s, /awaiting_approval/, '승인 대기 상태를 설명해야 한다');
  assert.match(s, /다시 시도/, '오류 상태에 복구 행동이 있어야 한다');
  assert.match(s, /aria-labelledby="storage-h"|aria-live/, '스크린리더 안내가 있어야 한다');
});

/* ══════════ LLM 어댑터 · 웹훅 인증 · 관리자 잠금 (계약 검사) ══════════ */

test('LLM 실키는 승인 플래그 뒤에 있고 시크릿이 하드코딩되지 않았다', () => {
  const s = read('src/lib/llm.ts');
  assert.match(s, /CHAT_LLM_LIVE/, '승인 게이트가 있어야 한다');
  assert.match(s, /if \(!cfg\.live\) return fail\('disabled'/, '게이트 OFF면 호출 전에 즉시 반환해야 한다');
  // 키는 환경변수에서만 읽는다 — 소스에 키처럼 보이는 리터럴이 없어야 한다
  assert.equal(/sk-[A-Za-z0-9]{16,}/.test(s), false, 'API 키가 소스에 있으면 안 된다');
  assert.match(s, /env\.ANTHROPIC_API_KEY/);
  assert.match(s, /env\.OPENAI_API_KEY/);
});

test('LLM 어댑터는 상한(입력·출력·호출)을 모두 강제한다', () => {
  const s = read('src/lib/llm.ts');
  assert.match(s, /maxInputChars/, '입력 문자 상한');
  assert.match(s, /maxOutputTokens/, '출력 토큰 상한');
  assert.match(s, /maxCallsPerMinute/, '분당 호출 상한');
  assert.match(s, /export function clampMessages/, '상한 초과 시 잘라내는 경로가 있어야 한다');
  assert.match(s, /CIRCUIT_FAILURE_LIMIT/, '연속 실패 차단(서킷)이 있어야 한다');
});

test('분당 호출 상한을 재는 자리가 **재시도 고리 안**에 있다 (DS 75-2)', () => {
  const s = read('src/lib/llm.ts');
  const loop = s.indexOf('for (let attempt = 1');
  const reserve = s.indexOf('reserveCall(cfg.maxCallsPerMinute');
  assert.ok(loop > 0 && reserve > loop, '예산은 실제로 나가는 호출마다 세어야 한다(재시도도 과금이다)');
  assert.equal((s.match(/reserveCall\(/g) || []).length, 2, '예산을 재는 자리는 정의 1곳 + 호출 1곳이어야 한다');
});

test('시스템 프롬프트 상한을 **아는 자가 한 곳**이고, 자료를 반 토막으로 싣지 않는다 (DS 75-3)', () => {
  const s = read('src/lib/llm.ts');
  assert.match(s, /export function systemBudget/, '상한을 셈하는 자에 이름이 있어야 한다');
  assert.equal((s.match(/maxInputChars \* 0\.8/g) || []).length, 1, '그 수를 셈하는 자리는 한 곳이어야 한다');
  assert.match(s, /cut\(system, systemBudget\(maxInputChars\)\)/, '재는 쪽이 그 자를 써야 한다');
  assert.match(s, /buildSystemPrompt\(input\.docs, systemBudget\(cfg\.maxInputChars\)\)/, '만드는 쪽도 같은 자를 써야 한다');
  assert.match(s, /MIN_DOC_ANSWER/, '토막만 남는 자료는 싣지 않는 문턱이 있어야 한다');
  assert.match(s, /건만 실었습니다/, '싣지 못한 자료의 수를 프롬프트가 말해야 한다');
  assert.match(s, /prompt\.kept === 0\) return \{ failed: 'input_too_large' \}/, '근거가 한 건도 없으면 호출하지 않아야 한다');
});

test('외부로 보내는 대화의 첫 마디는 고객 차례다 (DS 75-1)', () => {
  const s = read('src/lib/llm.ts');
  assert.match(s, /while \(kept\.length && kept\[0\]!\.role !== 'user'\)/, '첫 마디가 고객 차례가 되도록 더 버려야 한다');
});

test('LLM 어댑터는 개인정보를 마스킹해 보내고, 실패를 삼키지 않는다', () => {
  const s = read('src/lib/llm.ts');
  assert.match(s, /import \{ scrub \} from '@\/lib\/monitoring'/, '전송 전 마스킹');
  assert.match(s, /scrub\(m\.content\)/, '대화 본문이 마스킹을 거쳐야 한다');
  // 호출부가 사유를 알 수 있도록 실패를 값으로 돌려준다(throw 금지)
  assert.match(s, /reason: LLMFailureReason/);
  assert.equal(/^\s*throw /m.test(s), false, 'LLM 어댑터는 throw 하지 않아야 한다');
});

test('대화 엔진은 LLM 실패 시 결정적 폴백으로 되돌아간다', () => {
  const s = read('src/lib/chat.ts');
  assert.match(s, /if \('failed' in res\) return \{ \.\.\.base, source: 'fallback'/, '실패 시 폴백 복귀');
  assert.match(s, /if \(!docs\.length\)/, '근거 자료가 없으면 생성하지 않는다(환각 방지)');
  assert.match(s, /AI_ANSWER_NOTICE/, 'AI 생성 고지가 있어야 한다');
  assert.match(s, /llmFailure/, '실패 사유가 로그로 전달되어야 한다');
});

test('웹훅 서명 검증은 상수 시간 비교 + 리플레이 차단을 한다', () => {
  const s = read('src/lib/webhookAuth.ts');
  assert.match(s, /timingSafeEqual/, '상수 시간 비교여야 한다');
  assert.equal(/presented === expected|sig === expected/.test(s), false, '단순 문자열 비교가 있으면 안 된다');
  assert.match(s, /toleranceSec/, '타임스탬프 허용 시간창(리플레이 차단)');
  assert.match(s, /signingBase/, '서명 대상에 타임스탬프가 포함되어야 한다');
  assert.equal(/console\.(log|error)\([^)]*secret/i.test(s), false, '시크릿을 로그에 남기면 안 된다');
});

test('카카오 웹훅이 서명 검증과 중복 전달 처리를 실제로 사용한다', () => {
  const s = read('src/app/api/kakao/webhook/route.ts');
  assert.match(s, /authenticateKakao\(req\.headers, parsedBody\.raw\)/, '원문 기준으로 서명을 검증해야 한다');
  assert.match(s, /return fail\('unauthorized'/, '검증 실패는 401로 거절해야 한다');
  assert.equal(/auth\.reason.*fail\('unauthorized'|unauthorized',\s*`.*\$\{auth\.reason\}/.test(s), false, '실패 사유를 응답에 담으면 안 된다');
  assert.match(s, /kakaoDedupe\(key\)/, '재시도(중복 전달) 판정이 있어야 한다');
  assert.match(s, /rememberKakaoResponse\(key/, '같은 이벤트에 같은 응답을 돌려줘야 한다');
  assert.match(s, /captureError/, '엔진 오류를 삼키지 않아야 한다');
});

test('시크릿 미설정 시 조용히 열지 않는다(필수 설정이면 차단)', () => {
  const s = read('src/lib/kakao.ts');
  assert.match(s, /KAKAO_SIGNATURE_REQUIRED/, '필수화 스위치가 있어야 한다');
  assert.match(s, /return required \? \{ ok: false, reason: 'no_secret' \} : \{ ok: true \}/, '설정 누락을 사고로 만든다');
  assert.equal(/KAKAO_WEBHOOK_SECRET\s*=\s*['"][^'"]+['"]/.test(s), false, '시크릿 하드코딩 금지');
});

test('관리 토큰 비교가 상수 시간이고 실패 누적 잠금이 있다', () => {
  const h = read('src/lib/http.ts');
  assert.match(h, /safeEqual\(presentedToken/, '토큰 비교는 상수 시간이어야 한다');
  assert.equal(/presentedToken\(req, allowQueryToken\) !== token/.test(h), false, '단순 비교가 남아 있으면 안 된다');

  const a = read('src/lib/adminAuth.ts');
  assert.match(a, /export function recordAttempt/);
  assert.match(a, /if \(before\.locked\) return before;/, '잠긴 동안 카운트를 더 올리지 않아야 한다');
  assert.equal(/ADMIN_TOKEN/.test(a), false, '잠금 모듈은 토큰 값을 다루지 않는다');

  const r = read('src/app/api/admin/auth/route.ts');
  assert.match(r, /lockoutStatus\(key\)/);
  assert.match(r, /recordAttempt\(key, !denied\)/);
  assert.match(r, /남은 시도/, '사용자에게 남은 시도를 알려줘야 한다');
});

/* ── 파트너(채널)·매출 귀속 ── */
test('파트너 API는 모든 메서드에서 관리자 게이트를 거친다', () => {
  const s = read('src/app/api/admin/partners/route.ts');
  const methods = [...s.matchAll(/export async function (GET|POST|DELETE|PATCH|PUT)\(/g)].map((m) => m[1]);
  assert.ok(methods.length >= 3, '조회·등록·삭제가 있어야 한다');
  // 인증 관문은 requireAdmin(관리자 전용) 또는 requirePrincipal(관리자+파트너 담당자) 중 하나여야 한다.
  const gates = (s.match(/require(Admin|Principal)\(req[,)]/g) || []).length;
  assert.equal(gates, methods.length, '메서드마다 인증 관문이 필요하다');
});

test('파트너 데이터는 연락처를 저장하지 않는다(개인정보 최소화)', () => {
  const s = read('src/lib/partners.ts');
  for (const field of ['phone', 'email', 'mobile', 'tel']) {
    assert.equal(new RegExp(`^\\s*${field}\\??:`, 'mi').test(s), false, `${field} 필드를 두면 개인정보 네임스페이스가 된다`);
  }
  // 담당자는 이름만 받는다
  assert.match(s, /managerName\??:/);
  assert.match(s, /ownerName\??:/);
});

test('수수료율은 하드코딩하지 않고 설정값으로 분리한다', () => {
  const s = read('src/lib/partners.ts');
  assert.match(s, /PARTNER_DEFAULT_FEE_RATE_BP/, '기본 수수료율은 환경변수여야 한다');
  assert.match(s, /feeRateBp: number \| null/, '미설정을 null로 표현해야 임의 수치가 생기지 않는다');
});

test('고객사 삭제 API는 존재하지 않는다(귀속 근거 보존)', () => {
  const s = read('src/app/api/admin/partners/route.ts');
  assert.equal(/deleteAccount/.test(s), false, '해지는 status로 표현하고 기록은 지우지 않는다');
});

test('백업에 파트너·귀속 데이터가 포함되고, 없는 백업도 복원된다(하위 호환)', () => {
  const s = read('src/app/api/admin/backup/route.ts');
  assert.match(s, /exportPartners\(\)/, '백업에 파트너 스냅샷이 들어가야 한다');
  assert.match(s, /if \(raw && typeof raw === 'object'\)/, 'partners 키가 없으면 건드리지 않아야 한다');
  assert.match(s, /partnersError/, '복원 실패를 삼키지 않고 응답에 알려야 한다');
});

/* ── 파트너 역할 권한(RBAC) ── */
test('파트너 포털(partner_admin 로그인)은 기본 OFF다', () => {
  const s = read('src/lib/rbac.ts');
  assert.match(s, /PARTNER_PORTAL_ENABLED === 'true'/, '명시적으로 true일 때만 켜져야 한다');
  assert.match(s, /MIN_PARTNER_TOKEN_LENGTH/, '짧은 토큰을 거르는 하한이 있어야 한다');
  assert.ok(!/console\.(log|error|warn)/.test(s), '토큰이 로그로 새지 않게 rbac은 로그를 찍지 않는다');
});

test('파트너 담당자는 읽기 전용이다(쓰기 라우트가 권한을 확인한다)', () => {
  const s = read('src/app/api/admin/partners/route.ts');
  const writeHandlers = s.split(/export async function /).filter((c) => /^(POST|PUT|PATCH|DELETE)\(/.test(c));
  assert.ok(writeHandlers.length >= 2, '쓰기 핸들러가 있어야 한다');
  for (const h of writeHandlers) {
    assert.match(h, /requireWrite/, `쓰기 핸들러가 requireWrite를 거치지 않는다: ${h.slice(0, 12)}`);
  }
  assert.match(read('src/lib/rbac.ts'), /canWrite[\s\S]*?role === 'admin'/, 'canWrite는 관리자만 허용해야 한다');
});

test('고객사 조회는 모두 권한 스코프 필터를 통과한다', () => {
  // 새 조회 화면이 생겨도 범위가 새지 않도록, queryAccounts를 쓰는 라우트는 scopeAccountFilter를 함께 써야 한다.
  for (const r of ROUTES) {
    const s = read(r);
    if (!s.includes('queryAccounts')) continue;
    assert.match(s, /scopeAccountFilter/, `${r} 가 조회 범위 필터를 거치지 않는다`);
  }
});

/* ── 정산 리포트 ── */
test('정산은 수수료율·금액을 하드코딩하지 않는다', () => {
  const s = read('src/lib/settlement.ts');
  assert.match(s, /effectiveFeeRateBp/, '수수료율은 파트너 설정·환경변수에서만 와야 한다');
  assert.ok(!/feeRateBp\s*=\s*\d/.test(s), '수수료율 리터럴 대입이 있으면 안 된다');
  assert.ok(!/(매출|성과|절감|만족도)\s*\d+%/.test(s), '근거 없는 성과 수치를 넣지 않는다');
});

test('근거가 없으면 0원이 아니라 미산출로 남긴다', () => {
  const s = read('src/lib/settlement.ts');
  assert.match(s, /issue === 'none'\s*\?/, '근거가 갖춰진 경우에만 금액을 계산해야 한다');
  assert.match(s, /partial: incomplete > 0/, '일부만 산출된 합계는 partial로 표시해야 한다');
  assert.match(s, /Math\.floor/, '수수료는 절사해야 한다(부풀림 금지)');
  assert.match(s, /청구서가 아닙니다/, '리포트가 청구서로 오인되지 않게 명시해야 한다');
});

test('정산 리포트 접근은 인증·감사 로그를 거친다', () => {
  const s = read('src/app/api/admin/settlement/route.ts');
  assert.match(s, /requirePrincipal/, '인증 없이 열려 있으면 안 된다');
  assert.match(s, /logAudit/, 'CSV 내보내기는 감사 로그에 남아야 한다');
  assert.match(s, /scopeAccountFilter/, '파트너 담당자 범위가 강제되어야 한다');
});

/* ══════════ 디자인 스프린트 — 위젯 화면 품질(DS 1-1·1-2·1-3·1-5) ══════════ */

test('디자인 토큰이 AICC Portal 팔레트를 쓴다', () => {
  const css = read('src/app/globals.css');
  for (const token of ['--brand:#2563EB', '--ink:#0F172A', '--line:#E2E8F0', '--bg:#F8FAFC']) {
    assert.ok(css.includes(token), `토큰 ${token} 이 없다`);
  }
  assert.match(css, /--shadow-card:/, '카드 그림자 규격이 토큰으로 있어야 한다');
  assert.match(css, /prefers-reduced-motion/, '모션 최소화 설정을 존중해야 한다');
  assert.match(css, /:focus-visible/, '키보드 초점 표시가 있어야 한다');
});

test('위젯 헤더에 아바타·AI 배지·최소화/닫기가 있다', () => {
  const s = read('src/components/ChatWidget.tsx');
  assert.match(s, /borderRadius: '50%'/, '원형 아바타가 있어야 한다');
  assert.match(s, /AI가 응대합니다/, '헤더 AI 고지 배지');
  assert.match(s, /aria-label="대화 최소화 \(대화 내용 유지\)"/, '최소화 버튼(대화 유지)');
  assert.match(s, /aria-label="대화 닫고 처음으로"/, '닫기 버튼(초기화)');
  assert.match(s, /brandVars\(tenant\?\.brandColor\)/, '테넌트 색이 위젯에 적용돼야 한다');
});

test('위젯이 타이핑 인디케이터·도착 애니메이션·시각을 렌더한다', () => {
  const s = read('src/components/ChatWidget.tsx');
  assert.match(s, /className="gw-dot"/, '타이핑 점이 있어야 한다');
  assert.match(s, /답변을 작성하고 있습니다/, '타이핑 상태에 스크린리더 라벨이 있어야 한다');
  assert.match(s, /className="gw-rise"/, '메시지 도착 애니메이션');
  assert.match(s, /toLocaleTimeString/, '말풍선에 시각 표시');
  assert.match(s, /mounted && m\.at/, '시각은 마운트 후에만 렌더해야 한다(hydration 불일치 방지)');
  const css = read('src/app/globals.css');
  assert.match(css, /@keyframes gw-blink/);
  assert.match(css, /@keyframes gw-rise/);
});

test('위젯이 빠른 답장 칩과 답변 평가를 제공한다', () => {
  const s = read('src/components/ChatWidget.tsx');
  assert.match(s, /이런 걸 물어보실 수 있어요/, '빠른 답장 안내');
  assert.match(s, /tenant \? \(tenant\.starters \?\? \[\]\) : \(fallbackStarters \?\? \[\]\)/, '빠른 답장은 서버가 준 실제 FAQ에서 와야 한다(테넌트 유무로 출처만 갈라져야 한다)');
  assert.match(s, /도움이 됐나요\?/, '답변 평가 문구');
  assert.match(s, /'\/api\/feedback'/, '평가는 서버에 기록돼야 한다');
  assert.match(s, /평가를 보내지 못했어요/, '실패를 삼키지 않고 알려야 한다');
  // 평가 요청에 대화 본문을 싣지 않는다(개인정보)
  assert.equal(/verdict, citation: m\.citation\?\.source \|\| ''/.test(s), true, '평가에는 근거 라벨만 보내야 한다');
});

test('빠른 답장은 실제 적재된 FAQ에서만 만들어진다', () => {
  const s = read('src/lib/tenantKB.ts');
  assert.match(s, /STARTER_COUNT/, '칩 개수 상수가 있어야 한다');
  // 테넌트(tenantConfig)·기본 위젯(fallbackStarters) 모두 같은 topQuestions() 한 곳에서 자른다 —
  // 두 출처가 각자 슬라이스를 하면 개수 규칙이 갈라질 수 있다(DS 19-1, DS 6-2 와 같은 단일 출처 원칙).
  assert.match(s, /function topQuestions\(entries: KBEntry\[\]\): string\[\] \{/, '슬라이스가 한 함수로 모여 있어야 한다');
  assert.match(s, /\.slice\(0, STARTER_COUNT\)/, '칩은 KB에서 잘라 써야 한다');
  assert.match(s, /export function tenantConfig[\s\S]*?topQuestions\(tenantKB\(preset\)\)/, 'tenantConfig 가 topQuestions 를 거치지 않는다');
  assert.match(s, /export function fallbackStarters\(\): string\[\] \{\s*\n\s*return topQuestions\(listKB\(\)\)/, 'fallbackStarters 가 topQuestions 를 거치지 않는다');
  assert.equal(/starters: \[\s*'/.test(s), false, '칩 문구를 코드에 지어 넣으면 안 된다');
});

test('위젯이 모바일 전체화면·포커스 트랩·ESC·aria-live를 지원한다', () => {
  const s = read('src/components/ChatWidget.tsx');
  assert.match(s, /MOBILE_MAX = 480/, '모바일 기준 폭');
  assert.match(s, /const fullscreen = open && mobile/, '전체화면 전환');
  assert.match(s, /e\.key === 'Escape'/, 'ESC 닫기');
  assert.match(s, /FOCUSABLE/, '포커스 트랩 대상 선택자');
  assert.match(s, /e\.key !== 'Tab'/, 'Tab 순환 처리');
  assert.match(s, /role="dialog"/, '대화창 역할');
  assert.match(s, /aria-live="polite"/, '새 메시지를 스크린리더에 알려야 한다');
  assert.match(s, /aria-label="메시지 입력"/);
  assert.match(s, /aria-label="메시지 전송"/);
});

test('임베드 스니펫이 호스트 폭을 위젯에 알려주고 전체화면을 적용한다', () => {
  const s = read('public/embed.js');
  assert.match(s, /gowon-chat-host/, '호스트→위젯 메시지가 있어야 한다');
  assert.match(s, /function sendViewport/, '뷰포트 폭 전달');
  assert.match(s, /applyPlacement/, '전체화면 배치 전환');
  // 기존 임베드 옵션 계약 유지
  assert.match(s, /data-tenant/);
  assert.match(s, /data-position/);
});

test('위젯 상담원 전환이 버튼→연락처 카드→접수 완료 흐름을 갖는다 (DS 1-4)', () => {
  const s = read('src/components/ChatWidget.tsx');
  // 버튼을 누르면 곧바로 접수하지 않고 카드를 연다(연락처 없이 접수되는 사고 방지)
  assert.match(s, /function openHandoff/, '카드를 여는 단계가 있어야 한다');
  assert.match(s, /stage: 'form' \| 'sending' \| 'done' \| 'error'/, '4개 상태를 모두 다뤄야 한다');
  assert.match(s, /aria-label="상담원 연결 접수"/, '카드에 이름이 있어야 한다(스크린리더)');
  assert.match(s, /htmlFor="gw-handoff-contact"/, '연락처 입력에 라벨이 있어야 한다');
  assert.match(s, /'gw-handoff-err gw-handoff-hint' : 'gw-handoff-hint'/, '이용 목적 안내가 입력과 연결돼야 한다');
  assert.match(s, /role="alert"/, '실패는 즉시 안내돼야 한다');
  assert.match(s, /다시 시도/, '실패 시 재시도 경로가 있어야 한다');
  assert.match(s, /접수번호/, '완료 상태에 접수번호가 보여야 한다');
  assert.match(s, /파기합니다/, '연락처 이용·파기 안내가 있어야 한다');
  // 계약 유지 — 서버 /api/escalation 은 contact 를 이미 받는다(계약 변경 금지)
  assert.match(s, /\{ contact: trimmed \}/, '연락처는 기존 계약 필드로 보내야 한다');
});

test('상담원 전환은 접수 중 중복 전송을 막는다', () => {
  const s = read('src/components/ChatWidget.tsx');
  assert.match(s, /if \(!handoff \|\| handoff\.stage === 'sending'\) return;/, '전송 중 재진입 차단');
  // 잠그되 초점은 빼앗지 않는다(DS 8-2) — `disabled` 는 그 순간 초점을 위젯 밖으로 떨어뜨린다.
  assert.match(s, /aria-disabled=\{handoff\.stage === 'sending' \|\| undefined\}/, '전송 중에는 버튼이 잠긴 모양이어야 한다');
  assert.match(s, /aria-busy=\{handoff\.stage === 'sending' \|\| undefined\}/, '진행 상태를 알려야 한다');
});

test('임베드 스니펫이 첫 로드 깜빡임 없이 나타난다 (DS 1-6)', () => {
  const s = read('public/embed.js');
  assert.match(s, /'opacity:0'/, '붙는 순간에는 보이지 않아야 한다');
  assert.match(s, /function reveal/, '나타내는 단계가 있어야 한다');
  assert.match(s, /d\.type === 'ready'/, '위젯 준비 신호를 받아야 한다');
  assert.match(s, /setTimeout\(reveal, 2500\)/, '신호가 없어도 폴백으로 반드시 보여야 한다');
  assert.match(s, /prefers-reduced-motion/, '모션 최소화 설정을 존중해야 한다');
  // 공개 계약은 그대로
  assert.match(s, /data-tenant/);
  assert.match(s, /data-position/);
  const w = read('src/components/ChatWidget.tsx');
  assert.match(w, /type: 'ready'/, '위젯이 준비 신호를 보내야 한다');
});

test('답변 평가 API는 개인정보를 받지 않는다', () => {
  const s = read('src/app/api/feedback/route.ts');
  assert.match(s, /rateGuard\('feedback'/, '유량 제한이 있어야 한다');
  assert.match(s, /hashId\(/, '세션은 해시로만 저장해야 한다');
  assert.equal(/parsed\.data\.message/.test(s), false, '대화 본문을 받으면 안 된다');
  const exports = [...s.matchAll(/^export (?:const|function|async function) ([A-Za-z_]+)/gm)].map((m) => m[1]);
  assert.deepEqual(exports.sort(), ['POST', 'dynamic'].sort(), `허용되지 않은 export: ${exports.join(',')}`);
});

test('위젯·콘솔 화면에 내부 구현 문구가 노출되지 않는다', () => {
  const INTERNAL = ['data/admin-store.json', '401이면', '서버 메모리 기준', 'process.env', 'localhost'];
  const s = read('src/components/ChatWidget.tsx');
  for (const w of INTERNAL) assert.equal(s.includes(w), false, `위젯에 내부 문구 노출: ${w}`);
});

/* ══════════ 브랜드 — 제품명·마크 (DS 3-2) ══════════ */

const BRAND_SCREENS = [
  'src/app/page.tsx',
  'src/app/layout.tsx',
  'src/app/admin/page.tsx',
  'src/app/widget/page.tsx',
  'src/components/ChatWidget.tsx',
  'src/app/terms/page.tsx',
  'src/app/privacy/page.tsx',
  'src/app/privacy/LegalLayout.tsx',
  'src/lib/rules.ts',
].filter(has);

test('제품명은 영문 GOWON Chat 하나로 통일돼 있다', () => {
  for (const f of BRAND_SCREENS) {
    const s = read(f);
    assert.equal(/고원 챗봇|고원 상담 챗봇/.test(s), false, `${f}에 옛 제품명이 남아 있다`);
  }
  // 실제로 쓰이는 곳에는 새 이름이 있어야 한다(지우기만 하고 끝내지 않는다)
  assert.match(read('src/app/page.tsx'), /GOWON Chat/);
  assert.match(read('src/app/admin/page.tsx'), /GOWON Chat/);
  assert.match(read('src/components/ChatWidget.tsx'), /'GOWON Chat'/);
  // 법인명은 약관·방침에 그대로 남는다(표기 변경은 제품명에 한정)
  assert.match(read('src/app/terms/page.tsx'), /주식회사 고원\(GOWON\)/);
});

test('랜딩에 「AICC 제품군」 배지가 없다', () => {
  for (const f of BRAND_SCREENS) {
    assert.equal(read(f).includes('AICC 제품군'), false, `${f}에 배지 문구가 남아 있다`);
  }
});

test('브랜드 마크(파비콘)가 있고 화면과 같은 도형을 쓴다', () => {
  assert.ok(has('src/app/icon.svg'), '파비콘(app/icon.svg)이 있어야 한다');
  const svg = read('src/app/icon.svg');
  const body = /d="(M7 2\.5h18[^"]+)"/.exec(svg)?.[1];
  const initial = /d="(M20\.9 9\.9[^"]+)"/.exec(svg)?.[1];
  assert.ok(body && initial, '말풍선 몸통·이니셜 경로가 있어야 한다');
  // 랜딩·콘솔의 마크가 파비콘과 같은 도형이어야 한다(브랜드가 화면마다 달라지지 않게)
  for (const f of ['src/app/page.tsx', 'src/app/admin/page.tsx', 'public/brand-mark.svg', 'src/components/BrandMark.tsx']) {
    const s = read(f);
    assert.ok(s.includes(body), `${f}의 마크 몸통이 파비콘과 다르다`);
    assert.ok(s.includes(initial), `${f}의 마크 이니셜이 파비콘과 다르다`);
  }
});

test('랜딩 아이콘은 이모지가 아니라 선 아이콘이다', () => {
  const s = read('src/app/page.tsx');
  const emoji = s.match(/[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}]/gu);
  assert.equal(emoji, null, `랜딩에 이모지가 남아 있다: ${emoji && emoji.join(' ')}`);
  assert.match(s, /function Icon\(/, '선 아이콘 컴포넌트가 있어야 한다');
  assert.match(s, /strokeWidth="1\.4"/, '아이콘 굵기는 콘솔 메뉴와 같아야 한다');
});

/* ══════════ 시스템 화면 — 404·오류 (DS 4-1) ══════════ */

test('404·오류 화면이 브랜드 규격으로 있고 내부 오류 내용을 싣지 않는다 (DS 4-1)', () => {
  for (const f of ['src/app/not-found.tsx', 'src/app/error.tsx', 'src/app/global-error.tsx', 'src/components/SystemPage.tsx']) {
    assert.ok(has(f), `${f} 가 있어야 한다(기본 Next 화면은 개발자 초안 수준)`);
  }
  const sys = read('src/components/SystemPage.tsx');
  assert.match(sys, /import BrandMark from '\.\/BrandMark'/, '랜딩·콘솔과 같은 마크');
  assert.match(sys, /GOWON Chat/, '제품명');
  assert.match(sys, /aria-labelledby="sys-title"/, '화면 제목 연결');
  assert.match(sys, /<h1 id="sys-title"/, '제목은 h1');
  assert.match(sys, /minHeight: 42/, '버튼 터치 영역');
  assert.match(sys, /flexWrap: 'wrap'/, '375px 에서 버튼이 줄바꿈');

  const nf = read('src/app/not-found.tsx');
  assert.match(nf, /페이지를 찾을 수 없습니다/, '404 문구');
  assert.match(nf, /href: '\/'/, '홈으로');
  assert.equal(/\/admin/.test(nf), false, '404 에서 운영자 경로를 안내하지 않는다');

  for (const f of ['src/app/error.tsx', 'src/app/global-error.tsx']) {
    const e = read(f);
    assert.match(e, /^'use client';/, `${f} 는 클라이언트 경계`);
    assert.match(e, /onClick: reset/, `${f}: 다시 시도`);
    assert.match(e, /reference=\{error\.digest\}/, `${f}: 참조 번호만`);
    assert.equal(/error\.message|error\.stack|\{String\(error/.test(e), false, `${f}: 오류 내용(메시지·스택)을 화면에 싣지 않는다`);
  }
  const ge = read('src/app/global-error.tsx');
  assert.match(ge, /<html lang="ko">/, 'global-error 는 루트 레이아웃을 대체하므로 lang 을 직접 준다');
  // 토큰 사본은 SystemPage 의 SYSTEM_TOKENS 한 벌뿐이다(DS 16-1) — global-error 는 그것을 body 에 얹는다.
  assert.match(ge, /SYSTEM_TOKENS/, 'globals.css 가 없으므로 토큰을 직접 얹어야 한다');
  assert.match(sys, /'--brand': '#2563EB'/, '토큰 사본이 SystemPage 에 있어야 한다');
});

/* ══════════ 랜딩 — 상용 수준 구조 & 운영자 정보 비노출 ══════════ */

test('랜딩에 설치 스니펫·개발자용 정보가 노출되지 않는다', () => {
  const s = read('src/app/page.tsx');
  for (const leak of ['embed.js', 'data-position', 'data-offset', 'data-z', '<script src', '/admin']) {
    assert.equal(s.includes(leak), false, `랜딩에 운영자용 정보 노출: ${leak}`);
  }
});

test('랜딩이 의사결정에 필요한 섹션을 갖춘다', () => {
  const s = read('src/app/page.tsx');
  for (const anchor of ['id="trust"', 'id="features"', 'id="channels"', 'id="steps"', 'id="faq"', 'id="demo"', 'id="contact"']) {
    assert.ok(s.includes(anchor), `랜딩 섹션 누락: ${anchor}`);
  }
  assert.match(s, /인공지능\(AI\)이 응대합니다/, 'AI 고지');
  assert.match(s, /<details/, 'FAQ는 펼침 목록이어야 한다(키보드 조작 가능)');
});

test('랜딩이 근거 없는 성과 수치·타사 이름을 쓰지 않는다', () => {
  const s = read('src/app/page.tsx');
  // "…률 87%" 같은 성과 주장
  assert.equal(/(해결률|자동화율|절감|만족도|정확도|응답률)[^\n]{0,10}\d+\s*%/.test(s), false, '근거 없는 성과 수치가 있다');
  for (const brand of ['채널톡', '알프', 'Intercom', 'Fin AI', 'Zendesk']) {
    // 주석의 벤치마킹 기록은 허용하되, 화면 문자열(따옴표 안)에 타사명이 들어가면 안 된다
    const inUi = new RegExp(`['\`"][^'\`"\\n]*${brand}[^'\`"\\n]*['\`"]`);
    assert.equal(inUi.test(s), false, `화면 문구에 타사명이 있다: ${brand}`);
  }
  assert.match(s, /측정 중/, '값이 없는 지표는 「측정 중」으로 표시해야 한다');
});

test('설치 안내는 관리 콘솔 안에 있고 배포 주소를 하드코딩하지 않는다', () => {
  const s = read('src/app/admin/page.tsx');
  assert.match(s, /\['install', '설치'\]/, '설치 탭이 등록돼야 한다');
  assert.match(s, /function installSnippet/, '설치 스니펫 생성 함수');
  assert.match(s, /window\.location\.origin/, '배포 주소는 현재 접속 주소를 써야 한다');
  assert.match(s, /INSTALL_OPTIONS/, '옵션 표');
  assert.match(s, /data-tenant/, '테넌트 옵션 안내가 있어야 한다');
});

test('관리 콘솔 화면에 내부 구현 문구가 남아 있지 않다', () => {
  const s = read('src/app/admin/page.tsx');
  // 화면에 그려지는 문자열만 검사한다(주석의 구현 메모는 허용)
  const ui = s.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  for (const w of ['data/admin-store.json', '401이면', '서버 메모리 기준']) {
    assert.equal(ui.includes(w), false, `콘솔 화면에 내부 문구 노출: ${w}`);
  }
});

/* ══════════ 약관·방침 셸 통일 (DS 4-4) ══════════ */

test('약관·방침 레이아웃은 랜딩과 같은 셸(상단바·브랜드 마크·목차·푸터)을 쓴다', () => {
  const s = read('src/app/privacy/LegalLayout.tsx');
  assert.match(s, /from '@\/components\/BrandMark'/, '브랜드 마크는 공용 컴포넌트를 쓴다');
  assert.match(s, /aria-label="목차"/);
  assert.match(s, /aria-labelledby="legal-title"/);
  assert.match(s, /href="\/terms"/);
  assert.match(s, /href="\/privacy"/);
  assert.equal(s.includes('/admin'), false, '법적 고지 페이지는 운영자 화면을 안내하지 않는다');
  // 이모지·하드코딩 색 0건 — 토큰(var())만
  assert.equal(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(s), false, '이모지 아이콘이 남아 있다');
  assert.equal(/#[0-9a-f]{3,8}\b/i.test(s), false, '하드코딩 색이 남아 있다');
  // 375px: 목차가 가로 스크롤 칩으로 접히고 카드 여백이 줄어든다
  const css = read('src/app/globals.css');
  assert.match(css, /@media \(max-width:900px\)\{[^}]*\.lg-main\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(css, /\.lg-toc-list\{flex-direction:row;flex-wrap:nowrap;overflow-x:auto/);
  // 앵커 착지 여백은 DS 10-2 에서 html{scroll-padding-top} 한 곳으로 옮겼다(화면마다 적으면 둘이 더해진다).
  assert.match(css, /html\{[^}]*scroll-padding-top:\d+px/);
});

test('약관·방침 페이지에 설명 메타가 있고 제목은 문자열이라 목차에 잡힌다', () => {
  for (const f of ['src/app/terms/page.tsx', 'src/app/privacy/page.tsx']) {
    const s = read(f);
    assert.match(s, /description: '/, `${f} 설명 메타`);
    assert.ok((s.match(/<h2>/g) ?? []).length >= 5, `${f} 조항 제목`);
  }
});

/* ══════════ 링크 미리보기·색인 메타데이터 (DS 4-5) ══════════ */

test('루트 레이아웃이 링크 미리보기(OG·트위터)·테마색·metadataBase 를 내보낸다', () => {
  const s = read('src/app/layout.tsx');
  assert.match(s, /metadataBase: new URL\(/);
  assert.match(s, /openGraph: \{[^}]*locale: 'ko_KR'/);
  assert.match(s, /twitter: \{ card: 'summary_large_image'/);
  assert.match(s, /export const viewport: Viewport/);
  assert.match(s, /themeColor: '#2563EB'/, '테마색은 globals.css --brand 와 같아야 한다');
  assert.match(read('src/app/globals.css'), /--brand:#2563EB;/);
});

test('미리보기 이미지는 1200x630 PNG 파일 규약으로 있고 대체 텍스트가 붙어 있다', () => {
  for (const name of ['opengraph-image', 'twitter-image']) {
    const p = `src/app/${name}.png`;
    assert.ok(has(p), `${p} 가 있어야 한다`);
    const buf = readFileSync(new URL(`../${p}`, import.meta.url));
    assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${p} 는 PNG 여야 한다`);
    assert.equal(buf.readUInt32BE(16), 1200, `${p} 폭`);
    assert.equal(buf.readUInt32BE(20), 630, `${p} 높이`);
    assert.ok(buf.length < 300 * 1024, `${p} 용량(300KB 미만)`);
    const alt = read(`src/app/${name}.alt.txt`);
    assert.match(alt, /GOWON Chat/);
  }
  // 생성 스크립트는 수치·타사명을 쓰지 않는다(§13)
  const gen = read('scripts/og-image.py');
  assert.equal(/\d+\s*%/.test(gen), false, '성과 수치 금지');
});

test('관리 콘솔·임베드 프레임은 검색 색인에서 제외된다', () => {
  assert.match(read('src/app/admin/layout.tsx'), /robots: \{ index: false, follow: false/);
  assert.match(read('src/app/widget/page.tsx'), /robots: \{ index: false, follow: false \}/);
  // 랜딩·약관·방침은 색인 허용(색인 제외 지정 없음)
  for (const f of ['src/app/page.tsx', 'src/app/terms/page.tsx', 'src/app/privacy/page.tsx']) {
    assert.equal(read(f).includes('index: false'), false, `${f} 는 색인돼야 한다`);
  }
});

/* ══════════ 5순위 — 백로그 소진 후 재감사 (DS 5-x) ══════════ */

// 화면에 실제로 그려지는 부분만 남긴다 — 한 줄 주석·블록 주석·JSX 주석을 걷어낸다.
// 주석에 적힌 화살표나 개발 표기까지 결함으로 세면 거짓 실패가 난다.
// 블록 주석을 먼저 지우고, 그때 남는 빈 JSX 중괄호(`{ }`)를 치운다.
// 「{ … /* … */ … }」 를 한 번에 잡으려 하면 lazy 매칭이 중괄호를 건너뛰어
// 파일 중간을 통째로 삼킨다 — 「없어야 한다」 검사가 조용히 통과해 버린다.
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\{\s*\}/g, '');

test('랜딩은 위젯을 펼친 채로 띄우지 않는다 (DS 5-1)', () => {
  const s = read('src/app/page.tsx');
  assert.match(s, /<ChatWidget\s+defaultOpen=\{false\}/, '랜딩은 런처만 보여야 한다');
  // 375px에서 열린 위젯은 전체화면(inset:0)이라, 자동으로 열리면 제품 소개를 통째로 덮는다.
  const w = read('src/components/ChatWidget.tsx');
  assert.match(w, /defaultOpen = !embedded/, '기본값은 프롭으로 드러나 있어야 한다');
  assert.match(w, /useState\(defaultOpen\)/, '열림 상태는 프롭에서 와야 한다');
  // 사용자가 열지 않았는데 초점을 빼앗지 않는다(모바일에서 키보드가 저절로 올라온다).
  assert.match(w, /skipAutoFocus/, '처음부터 펼쳐진 경우 자동 초점을 건너뛰어야 한다');
});

test('위젯 아이콘은 이모지가 아니라 선 아이콘이다 (DS 5-2)', () => {
  const s = read('src/components/ChatWidget.tsx');
  const emoji = stripComments(s).match(/[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{00D7}\u{2212}]/gu);
  assert.equal(emoji, null, `위젯에 이모지·문자 글리프 아이콘이 남아 있다: ${emoji && emoji.join(' ')}`);
  assert.match(s, /function WIcon\(/, '선 아이콘 컴포넌트가 있어야 한다');
  assert.match(s, /strokeWidth="1\.4"/, '아이콘 굵기는 랜딩·콘솔과 같아야 한다');
  // 런처는 제품에서 가장 많이 노출되는 요소다 — 여기서 브랜드가 어긋나면 안 된다.
  assert.match(s, /<WIcon name=\{open \? 'close' : 'chat'\}/, '런처는 선 아이콘이어야 한다');
});

test('관리 콘솔 화면에 내부 표기 [승인 필요] 가 없다 (DS 5-3)', () => {
  const s = read('src/app/admin/page.tsx');
  // 주석에는 남겨 두되(개발 표기), 화면 문구에는 나오지 않아야 한다.
  const rendered = stripComments(s);
  assert.equal(rendered.includes('[승인 필요]'), false, '운영자 화면에 내부 개발 표기가 노출된다');
  // 같이 걷어낸 개발자 문구
  for (const leak of ['파일시스템', '디스크에 쓰지', '백업 API']) {
    assert.equal(rendered.includes(leak), false, `화면에 내부 문구 노출: ${leak}`);
  }
});

test('되돌릴 수 없는 동작은 브랜드 확인 대화상자를 거친다 (DS 5-4)', () => {
  const s = read('src/app/admin/page.tsx');
  // 브라우저 기본 대화상자는 브랜드를 따르지 않고 주소가 함께 노출된다.
  assert.equal(/window\.(confirm|alert|prompt)\(/.test(s), false, '브라우저 기본 대화상자가 남아 있다');
  assert.match(s, /function ConfirmDialog\(/, '확인 대화상자 컴포넌트가 있어야 한다');
  assert.match(s, /role="alertdialog"/, '되돌릴 수 없는 동작은 alertdialog 여야 한다');
  assert.match(s, /aria-modal="true"/, '모달 표시');
  assert.match(s, /cancelRef\.current\?\.focus\(\)/, '기본 초점은 취소 — Enter 로 실수로 지우지 않게');
  // 삭제·초기화 4곳이 전부 확인을 거친다.
  const asks = s.match(/await askConfirm\(/g) || [];
  assert.ok(asks.length >= 4, `확인을 거치지 않는 파괴적 동작이 있다(확인 ${asks.length}곳)`);
});

test('삭제·저장 실패를 조용히 삼키지 않는다 (DS 5-4)', () => {
  const s = read('src/app/admin/page.tsx');
  // `저장 실패: ${data.error}` 처럼 폴백 없는 원문 보간은 화면에 undefined 를 띄운다.
  assert.equal(/\$\{data\.error\}/.test(s), false, '서버 원문을 폴백 없이 화면에 보간한다');
  assert.match(s, /const failed = \(/, '실패 안내 헬퍼가 있어야 한다');
  for (const fn of ['removeKB', 'resetAll', 'removeCustomRule', 'removePartner', 'patchRule']) {
    const body = s.slice(s.indexOf(`const ${fn} = `));
    const end = body.indexOf('\n  };');
    assert.ok(/catch\s*\{/.test(body.slice(0, end)), `${fn} 에 네트워크 실패 처리가 없다`);
  }
});

test('상태 배경 틴트가 토큰으로 있다 (DS 5-4)', () => {
  const css = read('src/app/globals.css');
  for (const t of ['--success-50', '--warn-50', '--danger-50']) {
    assert.ok(css.includes(t), `${t} 토큰이 없다 — 상태 틴트가 화면마다 하드코딩된다`);
  }
  assert.match(css, /\.ac-modal\{/, '확인 대화상자 규격이 토큰 파일에 있어야 한다');
  assert.match(css, /prefers-reduced-motion:reduce\)\{\.ac-modal\{animation:none/, '모션 최소화 설정 존중');
});

test('위젯 전송 실패는 답변처럼 보이지 않고 다시 보낼 수 있다 (DS 5-5)', () => {
  const s = read('src/components/ChatWidget.tsx');
  // 코드 구조 검사는 원문 그대로 본다 — stripComments 는 「없어야 한다」 쪽 검사용이다.
  // 실패 안내를 보통 말풍선으로 그리면 사용자는 챗봇이 "그렇게 답했다"고 읽는다(QUALITY_BAR §3).
  assert.match(s, /m\.failed !== undefined/, '실패 말풍선을 따로 그리지 않는다');
  assert.match(s, /role="alert"/, '실패 안내는 즉시 읽혀야 한다');
  assert.match(s, /var\(--danger-50\)/, '경고 톤은 토큰을 쓴다');
  assert.match(s, /다시 보내기/, '다시 보낼 수단이 없다 — 사용자가 쓴 글이 사라진다');
  // 72차(DS 72-1)에 **앞서 쓴 열쇠**를 함께 들고 간다 — 원문을 그대로 보내는 것은 종전과 같고,
  // 같은 열쇠로 보내야 서버가 그 말을 두 번 처리하지 않는다(그 배선은 widget.test.mjs DS 72-1).
  assert.match(s, /sendText\(failedText, m\.key, failedId\)/, '다시 보내기가 원문을 그대로 재전송해야 한다');
  // 실패 경로 3곳(서버 오류·네트워크 예외·오프라인)이 모두 재전송 문장을 들고 있어야 한다.
  const fails = s.match(/failed: text/g) || [];
  assert.ok(fails.length >= 3, `실패 경로에 재전송 문장이 빠져 있다(${fails.length}/3)`);
  // 하드코딩 색 금지 — 실패·오프라인 표시도 토큰만 쓴다(#fff 제외).
  const hex = (s.match(/(?:background|borderColor): '#[0-9A-Fa-f]{3,6}'/g) || [])
    .filter((x) => !x.endsWith("'#fff'"));
  assert.deepEqual(hex, [], `상태 색이 하드코딩됐다: ${hex.join(' ')}`);
});

test('위젯이 연결 끊김을 보내기 전에 알린다 (DS 5-5)', () => {
  const s = read('src/components/ChatWidget.tsx');
  assert.match(s, /window\.addEventListener\('offline', sync\)/, '연결 상태를 듣지 않는다');
  assert.match(s, /navigator\.onLine === false/, '끊긴 채로 요청을 보내면 무조건 실패한다');
  assert.match(s, /인터넷 연결이 끊겼습니다/, '연결 끊김 안내 문구가 없다');
  // 서버 렌더에서는 연결 상태를 알 수 없다 — false 로 시작해야 한다(hydration 불일치 방지).
  assert.match(s, /const \[offline, setOffline\] = useState\(false\)/, '오프라인 상태 초기값');
  assert.match(s, /name="offline"/, '연결 끊김도 선 아이콘으로');
  // 서버 렌더 결과에는 배너가 없어야 한다(연결 상태 미확인).
  assert.equal(/서버에서.*offline/.test(s), false, '서버 렌더에서 연결 상태를 단정하면 안 된다');
});

test('위젯이 보내기 전에 글자 수 한계를 알린다 (DS 5-5)', () => {
  const s = read('src/components/ChatWidget.tsx');
  const route = read('src/app/api/chat/route.ts');
  // 상한의 단일 출처는 `lib/limits` 다(DS 38-1) — 라우트는 그 값을 가져다 쓴다.
  const limit = Number(/MAX_MESSAGE_LEN = (\d+)/.exec(read('src/lib/limits.ts'))?.[1]);
  assert.ok(limit > 0, '서버 길이 한계를 읽지 못했다');
  assert.match(route, /import \{ MAX_MESSAGE_LEN \} from '@\/lib\/limits';/, '라우트가 상한을 따로 적고 있다');
  const widgetLimit = Number(/MAX_INPUT_LEN = (\d+)/.exec(s)?.[1]);
  assert.equal(widgetLimit, limit, '위젯과 서버의 길이 한계가 어긋나면 413 으로 거절된다');
  assert.match(s, /aria-invalid=\{tooLong \|\| undefined\}/, '어느 입력이 틀렸는지 알려야 한다');
  assert.match(s, /aria-describedby=/, '오류 문구를 입력과 연결해야 한다');
  // 비었는지 재는 자는 `trim()` 이 아니라 사본 `cleanText` 다 (DS 63-1) — 제로폭 공백뿐인 입력을
  // `trim()` 은 글자로 세어 전송 버튼을 열어 두었다(빈 말풍선이 올라가고 요청까지 나갔다).
  assert.match(s, /aria-disabled=\{busy \|\| tooLong \|\| !cleanText\(input\) \|\| undefined\}/, '한계를 넘으면 전송을 막는다');
  assert.match(s, /function send\(\) \{ if \(!tooLong\) sendText\(input\); \}/, '실제 차단은 처리 함수 앞단이 한다');
});

test('건너뛰기 링크로 본문에 바로 닿는다 (DS 5-6)', () => {
  const css = read('src/app/globals.css');
  assert.match(css, /\.skip-link\{/, '건너뛰기 링크 규격이 토큰 파일에 없다');
  // display:none 은 초점을 받지 못한다 — 화면 밖으로 밀어 두고 초점 시 나타나야 한다.
  assert.match(css, /\.skip-link:focus\{top:12px\}/, '초점을 받으면 보여야 한다');
  assert.equal(/\.skip-link\{[^}]*display:none/.test(css), false, '숨긴 링크는 초점을 받지 못한다');
  // 스크롤 위치·사이드바 stacking 과 무관하게 보이도록 고정 배치(콘솔 사이드바 z-index 6, 상단바 20).
  assert.match(css, /\.skip-link\{position:fixed/, '스크롤하면 화면 밖으로 밀려난다');

  for (const [file, target] of [
    ['src/app/page.tsx', '#main'],
    ['src/app/privacy/LegalLayout.tsx', '#main'],
    ['src/app/admin/page.tsx', '#ac-main'],
  ]) {
    const s = read(file);
    assert.ok(s.includes(`href="${target}" className="skip-link"`), `${file} 에 건너뛰기 링크가 없다`);
    assert.ok(s.includes(`id="${target.slice(1)}"`), `${file} 의 본문에 도착 지점이 없다`);
    assert.ok(/tabIndex=\{-1\}/.test(s), `${file} 의 본문이 초점을 받지 못한다`);
  }
});

test('랜딩의 main 랜드마크가 상단바·푸터를 삼키지 않는다 (DS 5-6)', () => {
  const s = read('src/app/page.tsx');
  const main = s.indexOf('<main id="main"');
  assert.ok(main > 0, 'main 랜드마크가 없다');
  // 페이지 전체를 감싼 main 은 스크린리더의 랜드마크 이동을 무의미하게 만든다.
  assert.ok(s.indexOf('<header') < main, '상단바가 main 안에 있다');
  assert.ok(s.indexOf('<footer') > s.indexOf('</main>'), '푸터가 main 안에 있다');
  assert.ok(s.indexOf('<ChatWidget') > s.indexOf('</main>'), '위젯이 main 안에 있다');
  // 하드코딩 hex 없이 토큰만(DS 4-4 와 같은 규칙).
  const hex = stripComments(s).match(/#[0-9A-Fa-f]{6}/g) || [];
  assert.deepEqual(hex, [], `랜딩에 하드코딩 색이 남아 있다: ${hex.join(' ')}`);
});

test('콘솔은 탭을 바꾸면 본문으로 초점을 옮긴다 (DS 5-6)', () => {
  const s = read('src/app/admin/page.tsx');
  assert.match(s, /mainRef\.current\?\.focus\(\)/, '탭을 바꿔도 초점이 사이드바에 남는다');
  assert.match(s, /\}, \[tab\]\);/, '탭 변경에 반응해야 한다');
  assert.match(s, /tabMounted/, '첫 렌더에서는 초점을 빼앗지 않아야 한다');
  assert.match(s, /aria-label=\{currentLabel\}/, '본문에 현재 화면 이름이 붙어야 읽힌다');
});

test('약관·방침 공개 페이지에 내부 표기가 없다 (DS 5-7)', () => {
  const rendered = stripComments(read('src/app/privacy/LegalLayout.tsx'));
  assert.equal(rendered.includes('[승인 필요]'), false, '공개 페이지에 내부 개발 표기가 노출된다');
  // 초안·[미확정] 안내는 그대로 남아야 한다(법무 검토 전임을 방문자에게 밝히는 문구).
  assert.ok(rendered.includes('검토 초안'), '초안 표기까지 지우면 안 된다');
  assert.ok(rendered.includes('[미확정]'), '본문 미확정 표기 안내가 없다');
});

test('내려받기는 관리 토큰을 주소에 싣지 않는다 (DS 5-8)', () => {
  const s = read('src/app/admin/page.tsx');
  // 주소에 실린 토큰은 주소창·브라우저 방문 기록·서버 접근 로그에 그대로 남는다(QUALITY_BAR §3).
  const rendered = stripComments(s);
  assert.equal(/token=\$\{encodeURIComponent/.test(rendered), false, '관리 토큰이 주소(쿼리)에 실린다');
  assert.equal(/qs\.set\('token'/.test(rendered), false, '관리 토큰이 주소(쿼리)에 실린다');
  // window.open 은 실패해도 빈 탭·JSON 오류 본문만 남긴다 — 콘솔에는 아무 안내도 없다(§1).
  assert.equal(/window\.open\(/.test(rendered), false, '내려받기가 새 탭 열기로 남아 있다');
  // 헤더 인증 + Blob 저장 경로가 단일 출처여야 한다.
  assert.match(s, /const downloadFile = async \(/, '내려받기 공통 경로가 없다');
  const body = s.slice(s.indexOf('const downloadFile = async ('));
  const fn = body.slice(0, body.indexOf('\n  };'));
  assert.match(fn, /headers: authHeaders\(\)/, '토큰은 헤더로 보내야 한다');
  assert.match(fn, /if \(on401\(res\)\) return;/, '세션 만료를 잠금 화면으로 넘겨야 한다');
  assert.match(fn, /catch \{/, '네트워크 실패를 삼키면 안 된다');
  assert.match(fn, /createObjectURL/, 'Blob 으로 저장해야 한다');
  assert.match(fn, /revokeObjectURL/, '만든 URL 을 되돌려줘야 한다');
  assert.match(fn, /content-disposition/, '서버가 지정한 파일명을 써야 한다');
  // 내려받기 4곳이 모두 이 경로를 지난다.
  const calls = s.match(/downloadFile\(/g) || [];
  assert.ok(calls.length >= 4, `공통 경로를 쓰지 않는 내려받기가 있다(${calls.length}/4)`);
  for (const url of ['/api/admin/logs/export', '/api/admin/backup', '/api/admin/audit?format=csv']) {
    assert.ok(s.includes(`downloadFile('${url}'`), `내려받기 누락: ${url}`);
  }
  assert.match(s, /downloadFile\(`\/api\/admin\/settlement\?/, '정산 CSV 누락');
  // 진행 표시 — 멈춘 것처럼 보이지 않게(§1).
  assert.match(s, /const \[dlBusy, setDlBusy\] = useState\(''\)/, '내려받는 중 상태가 없다');
  const spins = s.match(/내려받는 중…/g) || [];
  assert.ok(spins.length >= 4, `진행 표시가 빠진 내려받기 버튼이 있다(${spins.length}/4)`);
  // 진행 중 버튼을 disabled 로 만들면 키보드로 누른 사용자의 초점이 본문 밖으로 떨어진다.
  assert.match(s, /function busyBtn\(/, '진행 중 버튼 공통 속성이 없다');
  const bb = s.slice(s.indexOf('function busyBtn('));
  assert.match(bb.slice(0, bb.indexOf('\n}')), /'aria-disabled': locked \|\| undefined/, '초점을 잃지 않게 aria-disabled 로 알려야 한다');
});

test('백업 복원은 덮어쓰기 전에 확인을 거치고 실패를 알린다 (DS 5-9)', () => {
  const s = read('src/app/admin/page.tsx');
  const body = s.slice(s.indexOf('const restoreBackup = async'));
  const fn = body.slice(0, body.indexOf('\n  };'));
  // 복원은 지금 등록된 자료를 통째로 덮어쓴다 — 되돌릴 수 없는 동작이다(§3).
  assert.match(fn, /await askConfirm\(/, '덮어쓰기 전에 확인 절차가 없다');
  assert.match(fn, /target: file\.name/, '무엇으로 덮어쓰는지 밝혀야 한다');
  assert.match(fn, /if \(!ok\) return;/, '취소하면 아무것도 하지 않아야 한다');
  assert.match(fn, /if \(on401\(res\)\) return;/, '세션 만료 처리가 없다');
  assert.match(fn, /catch \{/, '네트워크 실패를 삼키면 안 된다');
  assert.match(fn, /setRestoreBusy\(true\)/, '복원 중 표시가 없다');
  assert.match(fn, /finally \{[\s\S]{0,80}setRestoreBusy\(false\)/, '실패해도 진행 표시를 풀어야 한다');
  assert.match(s, /복원하는 중…/, '복원 중 버튼 표시가 없다');
});

test('남은 쓰기 동작도 실패를 알리고 세션 만료를 처리한다 (DS 5-10)', () => {
  const s = read('src/app/admin/page.tsx');
  // DS 5-4 가 삭제·수정만 손봤던 탓에 스위치·상태 변경·자료 저장에 예외 처리가 빠져 있었다.
  for (const fn of ['toggleCustomRule', 'patchTicket', 'submitKB', 'restoreBackup']) {
    const body = s.slice(s.indexOf(`const ${fn} = `));
    const seg = body.slice(0, body.indexOf('\n  };'));
    assert.ok(/catch\s*\{/.test(seg), `${fn} 에 네트워크 실패 처리가 없다`);
    assert.ok(seg.includes('on401(res)'), `${fn} 에 세션 만료 처리가 없다`);
  }
  // 관리 API 쓰기 요청은 예외 없이 401 을 확인한다.
  const writes = s.match(/method: '(POST|PATCH|DELETE)'/g) || [];
  const guards = s.match(/on401\(res\)/g) || [];
  assert.ok(guards.length >= writes.length, `401 확인이 빠진 쓰기 경로가 있다(쓰기 ${writes.length} · 확인 ${guards.length})`);
});

/* ══════════ 6순위 — 백로그 소진 후 3차 재감사 (DS 6-x) ══════════ */

test('문서 업로드 폼이 라벨·인라인 검증·실패 처리를 갖춘다 (DS 6-1)', () => {
  const s = read('src/app/admin/page.tsx');
  // 라벨 — placeholder 는 라벨이 아니다(글자를 넣으면 사라지고 스크린리더가 읽지 못한다).
  for (const id of ['kb-imp-title', 'kb-imp-cat', 'kb-imp-chunk', 'kb-imp-text']) {
    assert.match(s, new RegExp(`htmlFor="${id}"`), `라벨 누락: ${id}`);
    assert.match(s, new RegExp(`id="${id}"`), `입력 누락: ${id}`);
  }
  // 어느 칸이 왜 틀렸는지 그 칸 아래에서 밝힌다(§1) — 토스트 한 줄로는 알 수 없었다.
  for (const f of ['impErr.title', 'impErr.maxChars', 'impErr.text']) {
    assert.ok(s.includes(`aria-invalid={${f} ? 'true' : undefined}`), `인라인 오류 표시 누락: ${f}`);
  }
  assert.match(s, /className="ac-err">\{impErr\.title\}/, '문서명 오류 문구가 화면에 없다');
  const body = s.slice(s.indexOf('const runImport = async'));
  const fn = body.slice(0, body.indexOf('\n  };'));
  assert.equal(/flash\('문서명과 본문을 입력해 주세요/.test(fn), false, '검증이 토스트로 남아 있다');
  // 초점 옮기기는 DS 29-1 에서 폼 5곳이 쓰는 한 문(`focusErrorField`)으로 모았다.
  assert.match(fn, /focusErrorField\(firstErrorId\(errs, IMP_FIELD_ORDER\)\)/, '첫 오류 칸으로 초점을 옮겨야 한다');
  assert.match(fn, /catch \{/, '네트워크 실패를 삼키면 안 된다(§3)');
  assert.match(fn, /기존 자료는 그대로입니다/, '등록 실패 시 무엇이 남았는지 밝혀야 한다');
  assert.match(fn, /if \(impBusy\) return;/, '버튼을 잠그지 않으므로 중복 실행을 함수가 막아야 한다');
  // 진행 표시는 disabled 가 아니라 aria — 키보드로 누른 버튼에서 초점이 떨어지지 않게(DS 5-8).
  const form = s.slice(s.indexOf('<div className="ac-grid3">'), s.indexOf('먼저 「미리보기」로'));
  assert.equal(/disabled=\{impBusy/.test(s), false, '진행 중 버튼을 disabled 로 잠그면 초점이 떨어진다');
  assert.match(s, /busyBtn\(impBusy === 'commit'/, '등록 버튼에 진행 표시가 없다');
  // 주석에 적힌 문구로 통과하지 않게 렌더 구간만 본다(DS 5-6 에서 겪은 거짓 통과).
  const rendered = stripComments(s);
  assert.match(rendered, /등록하는 중…/, '등록 중 표시가 없다');
  assert.match(rendered, /미리보기 만드는 중…/, '미리보기 중 표시가 없다');
  assert.ok(form.includes('aria-required="true"'), '필수 항목 표시가 없다');
});

test('문서 업로드의 길이 한계가 서버와 같은 값이다 (DS 6-1)', () => {
  const s = read('src/app/admin/page.tsx');
  // 화면이 서버보다 느슨하면 보낸 뒤에야 거절당하고, 빡빡하면 멀쩡한 문서를 막는다.
  const ingest = read('src/lib/ingest.ts');
  const docMax = /MAX_DOC_CHARS = ([\d_]+)/.exec(ingest);
  assert.ok(docMax, 'ingest 의 본문 한계를 찾지 못했다');
  assert.match(s, new RegExp(`const MAX_DOC_CHARS = ${docMax[1]};`), '본문 한계가 서버와 다르다');
  // 「한 항목 길이」의 범위는 **라우트가 아니라 lib** 에 있다 (DS 65-1) — 라우트는 HTTP 메서드
  // 외 export 가 금지되어 다른 곳이 가져다 쓸 수 없는 자리이고, 그 안에 손으로 적힌 동안에는
  // 콘솔 사본과 갈라져도 아무도 알 수 없었다.
  const lo = /export const CHUNK_CHARS_MIN = (\d+);/.exec(ingest);
  const hi = /export const CHUNK_CHARS_MAX = (\d+);/.exec(ingest);
  assert.ok(lo && hi, 'ingest 의 「한 항목 길이」 범위를 찾지 못했다');
  const route = read('src/app/api/admin/kb/import/route.ts');
  assert.match(route, /parseNumber\(body\.maxChars, \{ min: CHUNK_CHARS_MIN, max: CHUNK_CHARS_MAX, integer: true \}\)/, '라우트가 수를 제 식으로 읽는다');
  assert.equal(/Math\.min\(Math\.max\(/.test(route), false, '범위를 조용히 당기는 자리가 남아 있다');
  assert.match(s, new RegExp(`const MIN_CHUNK_CHARS = ${lo[1]};`), '청크 최솟값이 서버와 다르다');
  assert.match(s, new RegExp(`const MAX_CHUNK_CHARS = ${hi[1]};`), '청크 최댓값이 서버와 다르다');
  // 남은 글자 수를 미리 보여 준다.
  assert.match(s, /id="kb-imp-count"/, '본문 글자 수 표시가 없다');
  assert.match(s, /aria-describedby=\{`kb-imp-count/, '글자 수가 입력과 묶여 읽히지 않는다');
});

test('콘솔 상태 색이 토큰 단일 출처를 지킨다 (DS 6-2)', () => {
  const s = read('src/app/admin/page.tsx');
  // DS 5-4 가 세운 틴트 토큰이 콘솔에는 hex 로 흩어져 있어, 토큰을 바꿔도 따라오지 않았다.
  const hex = stripComments(s).match(/#[0-9A-Fa-f]{6}/g) || [];
  assert.deepEqual(hex, [], `콘솔에 하드코딩 색이 남아 있다: ${hex.join(' ')}`);
  assert.match(s, /^const TONE = \{$/m, '상태 톤 단일 출처가 없다');
  for (const k of ['ok', 'warn', 'danger', 'brand', 'mute']) {
    assert.match(s, new RegExp(`^  ${k}: \\{ background: 'var\\(--`, 'm'), `TONE.${k} 가 토큰이 아니다`);
  }
  // 상태 pill 은 모두 TONE 을 지난다.
  assert.equal(/style=\{\{ background: '(?!var)/.test(s), false, '인라인 배경색이 토큰을 우회한다');
  const css = read('src/app/globals.css');
  for (const t of ['--warn-200', '--danger-200']) {
    assert.match(css, new RegExp(`${t}:#`), `토큰 정의 누락: ${t}`);
  }
});

test('콘솔 탭이 주소에 남아 새로고침·뒤로가기에서 유지된다 (DS 6-3)', () => {
  const s = read('src/app/admin/page.tsx');
  assert.match(s, /function tabFromHash\(hash: string\): TabKey/, '주소 → 탭 변환이 없다');
  assert.equal(/^export function tabFromHash/m.test(s), false, 'page.tsx 에서 내보내면 안 된다');
  assert.match(s, /const TAB_KEYS: readonly TabKey\[\] = TAB_GROUPS/, '탭 목록이 메뉴와 같은 출처여야 한다');
  // DS 9-3 에서 조건(`#settle?m=…`)까지 같은 파서로 읽게 넓혔다 — 되돌리는 규칙은 그대로다.
  assert.match(s, /tab: isTabKey\(name\) \? name : 'dash'/, '모르는 이름은 대시보드로 되돌려야 한다');
  // 서버 렌더는 해시를 알 수 없다 — 초기값이 하드코딩 'dash' 여야 hydration 이 어긋나지 않는다.
  assert.match(s, /useState<TabKey>\('dash'\)/, '서버 렌더 초기 탭이 고정이어야 한다');
  assert.match(s, /window\.addEventListener\('hashchange', onHash\)/, '뒤로/앞으로를 듣지 않는다');
  assert.match(s, /window\.removeEventListener\('hashchange', onHash\)/, '이벤트를 정리하지 않는다');
  const go = s.slice(s.indexOf('const goTab = useCallback'));
  const fn = go.slice(0, go.indexOf('\n  }, [setTab]);'));
  assert.match(fn, /window\.history\.pushState\(null, '', `#\$\{next\}`\)/, '탭 전환이 방문 기록에 남지 않는다');
  assert.match(fn, /catch \{/, '주소를 못 바꿔도 화면 전환은 막지 않아야 한다');
  // 탭을 바꾸는 모든 경로가 goTab 을 지난다(setTab 직접 호출은 해시 동기화 구간에만 있다).
  const after = s.slice(s.indexOf('\n  }, [setTab]);', s.indexOf('const goTab = useCallback')));
  assert.equal(/\bsetTab\(/.test(after), false, '주소를 거치지 않고 탭을 바꾸는 경로가 있다');
  assert.ok((after.match(/\bgoTab\(/g) || []).length >= 10, '탭 전환 경로가 goTab 으로 모이지 않았다');
  // 깊은 링크로 막 들어왔을 때는 초점을 가로채지 않는다(뒤로/앞으로는 사용자의 이동이므로 옮긴다).
  assert.match(s, /if \(initial\) skipTabFocus\.current = true;/, '첫 진입 표시를 세우지 않는다');
  assert.match(s, /if \(skipTabFocus\.current\) \{ skipTabFocus\.current = false; return; \}/, '첫 진입에서 초점을 빼앗는다');
});


/* ══════════ 7순위 — 4차 재감사 (DS 7-x) ══════════ */

test('위젯이 같은 방문 안에서 대화를 이어간다 (DS 7-1)', () => {
  const s = read('src/components/ChatWidget.tsx');
  // 세션 식별자가 마운트마다 새로 생기면, 호스트 페이지를 한 번 옮길 때마다 대화가 처음부터다.
  assert.match(s, /const \[sessionId, setSessionId\] = useState\(newSessionId\)/, '세션을 이어받을 수 없다');
  assert.match(s, /setSessionId\(saved\.id\)/, '복원한 대화가 서버 문맥과 이어지지 않는다');
  assert.match(s, /const saved = loadThread\(threadId\)/, '마운트 후 복원 경로가 없다');
  // 이미 누른 평가(DS 33-2)와 접수번호를 받은 카드(DS 34-1·35-1)도 같은 자리에 함께 저장한다 —
  // 되살리지 않으면 페이지를 옮길 때마다 평가를 다시 묻고, 접수번호가 사라진다.
  assert.match(
    s,
    /saveThread\(threadId, sessionId, msgs, Date\.now\(\), rated, filedCard\)/,
    '대화가 저장되지 않거나, 평가·접수가 함께 저장되지 않는다',
  );
  // 공용 PC 에 다음 사람이 읽을 대화를 남기지 않는다 — 탭을 닫으면 사라지는 저장소여야 한다.
  assert.match(s, /window\.sessionStorage/, '세션 저장소를 쓰지 않는다');
  // 주석은 「localStorage 가 아니라 sessionStorage 를 쓴다」고 적혀 있다 — 실제 코드만 본다.
  assert.equal(/localStorage/.test(stripComments(s)), false, '대화를 영구 저장소에 남기면 공용 PC 에서 다음 사람이 읽는다');
  // 저장소 접근 자체가 예외를 던지는 환경(쿠키 차단 iframe·사생활 보호 모드)에서 위젯이 죽으면 안 된다.
  const store = s.slice(s.indexOf('function threadStore('));
  assert.match(store.slice(0, store.indexOf('\n}')), /catch \{/, '저장소 접근 실패를 감싸지 않는다');
  for (const fn of ['loadThread', 'saveThread', 'clearThread']) {
    const body = s.slice(s.indexOf(`export function ${fn}(`));
    assert.match(body.slice(0, body.indexOf('\n}')), /catch/, `${fn} 에 실패 처리가 없다`);
  }
  // 서버 세션이 이미 지워진 대화를 이어 보이면 「아까 말한 그거요」가 통하지 않는다.
  const ttl = /THREAD_TTL_MS = (\d+) \* (\d+) \* (\d+)/.exec(s);
  assert.ok(ttl, '복원 유효 시간이 없다');
  const widgetTtl = Number(ttl[1]) * Number(ttl[2]) * Number(ttl[3]);
  const session = read('src/lib/session.ts');
  const srv = /TTL_MS = (\d+) \* (\d+) \* (\d+)/.exec(session);
  assert.ok(srv, '서버 세션 TTL 을 읽지 못했다');
  assert.equal(widgetTtl, Number(srv[1]) * Number(srv[2]) * Number(srv[3]), '위젯 복원 창과 서버 세션 TTL 이 어긋난다');
  // 전송 실패 안내는 그때의 상황이다 — 다시 열었을 때 남아 있으면 지나간 오류를 현재로 읽는다.
  assert.match(s, /msgs\.filter\(\(m\) => m\.failed === undefined\)/, '지나간 오류 안내까지 저장한다');
  // 「닫고 처음으로」는 저장분까지 지운다(사용자가 명시적으로 지운 대화다).
  assert.match(s, /clearThread\(threadId\);\n      setSessionId\(newSessionId\(\)\);/, '지운 대화가 다시 살아난다');
  // 왜 지난 말풍선이 남아 있는지 화면에 밝힌다.
  assert.match(s, /이전 대화를 이어서 보고 있습니다/, '이어가기 표시가 없다');
});

test('위젯이 비모달일 때 키보드 초점을 가두지 않는다 (DS 7-2)', () => {
  const s = read('src/components/ChatWidget.tsx');
  // aria-modal 은 전체화면일 때만 붙는다 — 그렇다면 초점 가두기도 그때만이어야 한다.
  assert.match(s, /aria-modal=\{fullscreen \? true : undefined\}/, '모달 표시 조건이 바뀌었다');
  const fn = s.slice(s.indexOf('function onPanelKeyDown('));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.match(body, /if \(!\(open && mobile\)\) return;/, '비모달 위젯이 키보드 초점을 가둔다');
  // 가두기 조건은 Tab 검사 뒤, 초점 목록을 뒤지기 전에 와야 한다(ESC 는 두 경우 모두 동작한다).
  assert.ok(body.indexOf("e.key !== 'Tab'") < body.indexOf('if (!(open && mobile)) return;'), '검사 순서가 어긋났다');
  assert.ok(body.indexOf('if (!(open && mobile)) return;') < body.indexOf('FOCUSABLE'), '가두기 전에 걸러야 한다');
  assert.match(body, /e\.key === 'Escape'/, 'ESC 로 닫는 경로가 사라졌다');
});

test('전체화면 위젯 뒤에서 페이지가 따라 움직이지 않는다 (DS 7-3)', () => {
  const s = read('src/components/ChatWidget.tsx');
  // 잠그는 일 자체는 콘솔과 **같은 사본**(lockPageScroll)이 한다 — DS 26-1 에서 한 벌로 모았다.
  assert.match(s, /return lockPageScroll\(window, document\);/, '전체화면일 때 뒤 페이지가 스크롤된다');
  assert.match(s, /body\.style\.overflow = 'hidden'/, '잠금이 overflow 를 막지 않는다');
  assert.match(s, /body\.style\.overflow = prevOverflow;/, '원래 스타일을 되돌리지 않는다');
  assert.match(s, /overscrollBehavior: 'contain'/, '목록 끝에서 스크롤이 뒤 페이지로 넘어간다');
  // 임베드 모드는 호스트 문서가 따로 있다 — 위젯이 아니라 embed.js 가 잠근다.
  assert.match(s, /if \(embedded \|\| typeof document === 'undefined'\) return;/, '임베드에서 자기 문서를 잠그면 소용이 없다');
  const e = read('public/embed.js');
  assert.match(e, /function lockHost\(on\)/, '호스트 스크롤 잠금이 없다');
  assert.match(e, /lockHost\(lastFull\)/, '전체화면 신호에 잠그지 않는다');
  assert.match(e, /window\.scrollTo\(0, lockY\)/, '풀 때 읽던 자리로 되돌리지 않는다');
  assert.match(e, /document\.body\.style\.overflow = prevOverflow/, '호스트의 원래 스타일을 되돌리지 않는다');
  assert.match(e, /lockHost\(false\);\n      if \(iframe\.parentNode\)/, '위젯을 걷어낼 때 잠금이 남는다');
  // data-tenant·data-position 옵션 계약은 그대로여야 한다.
  assert.match(e, /attr\('data-position', 'right'\)/, 'data-position 옵션 계약이 깨졌다');
  assert.match(e, /attr\('data-tenant', ''\)/, 'data-tenant 옵션 계약이 깨졌다');
});


/* ══════════ 8순위 — 백로그 소진 후 5차 재감사 (DS 8-x) ══════════ */

test('동작 버튼을 비활성으로 만들지 않는다 — 키보드 초점이 본문 밖으로 떨어진다 (DS 8-1·8-2)', () => {
  // `disabled` 가 붙는 순간 그 버튼에 있던 초점은 <body> 로 간다. 키보드 사용자는
  // 「저장」을 누른 뒤 화면 맨 위부터 Tab 을 다시 눌러야 하고, 서랍(role=dialog) 안에서는
  // 초점 가두기가 참조할 대상이 사라져 **뒤 페이지로 새어 나간다**.
  for (const f of ['src/app/admin/page.tsx', 'src/components/ChatWidget.tsx']) {
    const rendered = stripComments(read(f));
    const bad = [...rendered.matchAll(/<button[\s\S]{0,400}?>/g)].filter((m) => /\sdisabled=/.test(m[0]));
    assert.equal(bad.length, 0, `${f} 의 버튼 ${bad.length}곳이 아직 disabled 로 초점을 떨어뜨린다`);
  }
  // 대신 쓰는 짝: 모양·보조기술 표기는 `busyBtn`(콘솔)·`aria-disabled`(위젯)로.
  const admin = read('src/app/admin/page.tsx');
  assert.match(admin, /'aria-disabled': locked \|\| undefined/, 'busyBtn 이 aria-disabled 를 달지 않는다');
  // 중복 실행은 처리 함수 앞단이 막는다 — state 는 같은 틱의 두 번째 클릭을 못 막으므로 ref 로.
  assert.match(admin, /function useRunOnce\(\)/, '중복 실행 차단 헬퍼가 없다');
  assert.match(admin, /const running = useRef<Record<string, boolean>>\(\{\}\)/, 'state 로 막으면 같은 틱의 두 번째 클릭이 새어 나간다');
  const claims = (admin.match(/claim\('[a-z]+'\)/g) || []).length;
  const releases = (admin.match(/release\('[a-z]+'\)/g) || []).length;
  assert.ok(claims >= 7, `중복 실행을 막는 경로가 ${claims}곳뿐이다`);
  assert.equal(claims, releases, '집었는데 놓지 않는 경로가 있다 — 그 버튼은 영영 동작하지 않는다');
  // 서랍의 초점 가두기는 `aria-disabled` 를 목록에서 빼지 않아야 순환이 끊기지 않는다.
  assert.equal(/filter\(\(el\) => !el\.hasAttribute\('aria-disabled'\)\)/.test(admin), false, 'aria-disabled 를 빼면 진행 중에 순환이 끊긴다');
});

test('접수 연락처는 잠그지 않고 무엇이 틀렸는지 알려준다 (DS 8-2)', async () => {
  const s = read('src/components/ChatWidget.tsx');
  assert.match(s, /export function contactError\(v: string\): string/, '왜 못 보내는지 알려줄 함수가 없다');
  // 버튼을 형식 때문에 잠그면 「왜 안 눌리지」로 끝난다 — QUALITY_BAR §1.
  assert.equal(/aria-disabled=\{[^}]*validContact/.test(s), false, '형식 때문에 버튼을 잠그면 이유를 말할 기회가 없다');
  // Enter 도 삼키지 않는다(눌러야 이유를 알려줄 수 있다). 조합 확인은 한 함수가 한다(DS 41-1).
  assert.match(s, /if \(e\.key === 'Enter' && !composingKey\(e\)\) submitHandoff\(handoff\.contact\);/, 'Enter 를 조용히 삼킨다');
  // 오류는 stage 와 무관하게(형식 오류는 stage=form 이다) 인라인으로 뜨고 입력과 묶인다.
  assert.match(s, /\{handoff\.error && \(/, '형식 오류가 화면에 뜨지 않는다');
  assert.match(s, /id="gw-handoff-err" role="alert"/, '오류가 보조기술에 전달되지 않는다');
  assert.match(s, /aria-describedby=\{handoff\.error \? 'gw-handoff-err gw-handoff-hint' : 'gw-handoff-hint'\}/, '오류가 입력 칸과 묶이지 않았다');
  assert.match(s, /aria-invalid=\{handoff\.error \? 'true' : undefined\}/, '틀린 칸이 표시되지 않는다');
  assert.match(s, /contactRef\.current\?\.focus\(\)/, '틀린 칸으로 초점을 돌려주지 않는다(화면 밖일 수 있다)');
  // 보내는 중에는 disabled 가 아니라 readOnly — 비활성은 초점을 떨어뜨린다.
  assert.match(s, /readOnly=\{handoff\.stage === 'sending'\}/, '보내는 중 입력 칸이 초점을 잃는다');
  // 「연락처 없이 접수」는 그대로 통과해야 한다(검증 대상이 아니다).
  assert.match(s, /submitHandoff\('', true\)/, '연락처 없이 접수가 형식 검사에 막힌다');
});

test('모션 최소화 설정에서 화면이 미끄러지지 않는다 (DS 8-3)', () => {
  // CSS 의 `@media (prefers-reduced-motion: reduce){html{scroll-behavior:auto}}` 는
  // JS 가 behavior:'smooth' 를 **직접 넘기면 무시된다** — 설정은 켜 두었는데 화면만 미끄러진다.
  for (const f of ['src/app/admin/page.tsx', 'src/components/ChatWidget.tsx']) {
    const s = read(f);
    assert.equal(s.includes("behavior: 'smooth'"), false, `${f} 가 모션 설정을 무시하고 미끄러진다`);
    assert.match(s, /function scrollBehavior\(\): ScrollBehavior/, `${f} 에 모션 설정을 읽는 경로가 없다`);
    assert.match(s, /'\(prefers-reduced-motion: reduce\)'\)\.matches\) return 'auto'/, `${f} 가 설정을 읽지 않는다`);
    // matchMedia 가 없는 환경에서 예외로 죽으면 스크롤 자체가 멈춘다.
    assert.match(s, /\} catch \{ \/\* matchMedia 미지원/, `${f} 의 모션 판정이 예외를 삼키지 않는다`);
  }
  const w = read('src/components/ChatWidget.tsx');
  assert.match(w, /endRef\.current\?\.scrollIntoView\(\{ behavior: scrollBehavior\(\) \}\)/, '대화 자동 스크롤이 설정을 따르지 않는다');
  const a = read('src/app/admin/page.tsx');
  // 4곳: 안내 자료 수정·「이 질문으로 자료 만들기」(DS 32-2)·고객사 수정·파트너 수정
  assert.equal((a.match(/behavior: scrollBehavior\(\), block: 'start'/g) || []).length, 4, '폼으로 스크롤하는 4곳이 모두 설정을 따라야 한다');
});


/* ══════════ 디자인 스프린트 — 7차 재감사 (DS 10-1·10-2·10-3) ══════════ */

/** globals.css :root 에서 토큰 hex 를 읽는다(단일 출처를 실제로 파싱한다). */
function tokens() {
  const root = read('src/app/globals.css').split(':root{')[1].split('\n}')[0];
  const out = {};
  for (const [, k, v] of root.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{6})/g)) out[k] = v;
  return out;
}

/** WCAG 2.1 상대 휘도 → 대비비. 눈대중이 아니라 계산으로 고정한다. */
function contrast(a, b) {
  const lum = (hex) => {
    const ch = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('보조 문구 색이 모든 배경에서 WCAG AA(4.5:1)를 넘는다 (DS 10-1)', () => {
  const t = tokens();
  // 화면에 실제로 깔리는 밝은 면 — 흰 카드·페이지 배경·상태 틴트 4종(편집 중 행은 --brand-50 이다).
  const lightBgs = ['--surface', '--bg', '--brand-50', '--success-50', '--warn-50', '--danger-50'];
  for (const fg of ['--sub', '--mut']) {
    for (const bg of lightBgs) {
      const r = contrast(t[fg], t[bg]);
      assert.ok(r >= 4.5, `${fg}(${t[fg]}) on ${bg}(${t[bg]}) = ${r.toFixed(2)}:1 — AA 미달`);
    }
  }
  // 어두운 면 위에서는 --mut 가 반대로 어둡다 → 짝 토큰이 따로 있어야 한다.
  assert.ok(t['--mut-on-ink'], '어두운 배경용 보조 문구 토큰이 없다');
  assert.ok(contrast(t['--mut-on-ink'], t['--ink']) >= 4.5, '--mut-on-ink 가 --ink 위에서 AA 미달');
  assert.ok(contrast(t['--mut'], t['--ink']) < 4.5, '--mut 가 어두운 면에서도 통과하면 짝 토큰이 필요 없다 — 전제가 바뀌었다');
  // 위계는 유지한다(mut 가 sub 보다 연해 보여야 보조 문구로 읽힌다).
  assert.ok(contrast(t['--mut'], t['--surface']) < contrast(t['--sub'], t['--surface']), '--mut 가 --sub 보다 진하다');
  // 어두운 카드(최종 CTA)는 --mut 를 쓰지 않는다.
  const cta = (read('src/app/page.tsx').split('<section id="contact"')[1] || '').split('</section>')[0];
  assert.ok(cta, '랜딩 최종 CTA 섹션을 찾지 못했다');
  assert.equal(/var\(--mut\)/.test(cta), false, '어두운 CTA 카드가 밝은 면용 --mut 를 쓴다');
  assert.match(cta, /var\(--mut-on-ink\)/, '어두운 CTA 카드가 짝 토큰을 쓰지 않는다');
});

test('앵커가 스티키 상단바 아래로 숨지 않는다 (DS 10-2)', () => {
  const css = read('src/app/globals.css');
  const m = css.match(/html\{[^}]*scroll-padding-top:(\d+)px/);
  assert.ok(m, 'html 에 scroll-padding-top 이 없다 — 앵커가 상단바 뒤로 들어간다');
  assert.ok(Number(m[1]) >= 63, `상단바(62px + 테두리)보다 작다: ${m[1]}px`);
  // 화면마다 scroll-margin 을 적으면 둘이 더해져 착지점이 두 배로 내려간다(DS 6-2 단일 출처).
  assert.equal(/scroll-margin-top/.test(css), false, 'scroll-padding-top 과 scroll-margin-top 이 겹친다');
  // 랜딩 메뉴·CTA 가 가리키는 앵커가 실제로 존재해야 한다(죽은 링크도 같이 막는다).
  const page = read('src/app/page.tsx');
  for (const [, id] of page.matchAll(/href="#([a-z][a-z0-9-]*)"/g)) {
    assert.ok(page.includes(`id="${id}"`), `랜딩에 #${id} 앵커 대상이 없다`);
  }
});

test('이름 붙인 상자가 보조기술에 전달된다 — generic div 금지 (DS 10-3)', () => {
  // `<div aria-label>` 은 역할이 generic 이라 이름이 노출되지 않는다(ARIA 금지 대상).
  for (const f of ['src/app/page.tsx', 'src/app/admin/page.tsx', 'src/components/ChatWidget.tsx']) {
    const s = read(f);
    for (const [tag] of s.matchAll(/<div[^>]*aria-label(?:by)?=[^>]*>/g)) {
      assert.match(tag, /role="/, `${f}: 이름만 있고 역할이 없는 div — ${tag.slice(0, 90)}`);
    }
  }
  // 랜딩 히어로 예시는 figure/figcaption 으로 묶여 「예시」임이 먼저 전달된다.
  const page = read('src/app/page.tsx');
  assert.match(page, /<figure aria-label="상담 화면 예시 — 실제 답변은 등록한 자료에 따라 달라집니다"/, '히어로 예시가 figure 가 아니다');
  assert.match(page, /<figcaption/, '예시 안내문이 figcaption 으로 묶이지 않았다');
  // 콘솔 미리보기의 타이핑 표시는 위젯과 같은 규격(role="status")이어야 들린다.
  const admin = read('src/app/admin/page.tsx');
  assert.match(admin, /<div role="status" className="ac-pv-bot" aria-label="답변을 작성하고 있습니다">/, '콘솔 타이핑 표시가 위젯 규격을 따르지 않는다');
  assert.match(read('src/components/ChatWidget.tsx'), /role="status"\n\s+aria-label="답변을 작성하고 있습니다"/, '위젯 타이핑 표시 규격이 바뀌었다');
});


/* ══════════ 디자인 스프린트 — 8차 재감사 (DS 11-1·11-2·11-3) ══════════ */

test('상태 본문색(성공·경고·오류)이 밝은 면 전부에서 WCAG AA 를 넘는다 (DS 11-1)', () => {
  const t = tokens();
  // DS 10-1 이 --sub·--mut 만 고쳤다. 상태색도 같은 자리(11.5~13.5px 본문)에 글자로 쓰인다.
  const lightBgs = ['--surface', '--bg', '--brand-50', '--success-50', '--warn-50', '--danger-50'];
  for (const fg of ['--success', '--warn', '--danger']) {
    for (const bg of lightBgs) {
      const r = contrast(t[fg], t[bg]);
      assert.ok(r >= 4.5, `${fg}(${t[fg]}) on ${bg}(${t[bg]}) = ${r.toFixed(2)}:1 — AA 미달`);
    }
  }
  // 상태색은 채워진 면으로도 쓰인다(삭제 버튼 배경·스위치 켜짐) — 그 위 흰 글자/손잡이도 확인한다.
  for (const fg of ['--success', '--warn', '--danger']) {
    assert.ok(contrast(t[fg], '#FFFFFF') >= 4.5, `${fg} 면 위의 흰 글자가 AA 미달`);
  }
});

test('상태 틴트는 토큰 한 곳에서만 나온다 — 하드코딩 금지 (DS 11-2)', () => {
  const css = read('src/app/globals.css');
  const root = css.split(':root{')[1].split('\n}')[0];
  const t = tokens();
  // 테두리 틴트는 세 계열이 짝을 갖춘다(성공 쪽만 빠져 있어서 #BBF7D0 이 화면에 박혀 있었다).
  for (const k of ['--success-50', '--warn-50', '--danger-50', '--success-200', '--warn-200', '--danger-200']) {
    assert.ok(t[k], `${k} 토큰이 없다`);
  }
  // :root 바깥(= 실제 화면 규칙)에는 색 리터럴이 남아 있으면 안 된다. #fff 는 예외(중립).
  const body = css.replace(root, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const stray = [...body.matchAll(/#[0-9A-Fa-f]{3,8}\b/g)].map((m) => m[0]).filter((h) => h !== '#fff');
  assert.deepEqual(stray, [], `틴트가 토큰을 우회했다: ${stray.join(', ')}`);
});

test('새 창으로 열리는 링크는 그 사실을 알린다 (DS 11-3)', () => {
  const admin = read('src/app/admin/page.tsx');
  const widget = read('src/components/ChatWidget.tsx');
  const landing = read('src/app/page.tsx');
  for (const [name, src] of [['콘솔', admin], ['위젯', widget], ['랜딩', landing]]) {
    const blanks = (src.match(/target="_blank"/g) || []).length;
    const notices = (src.match(/새 창에서 열립니다/g) || []).length;
    assert.equal(notices, blanks, `${name}: 새 창 링크 ${blanks}곳 중 고지 ${notices}곳`);
    // 새 탭 링크는 opener 도 함께 끊는다(기존 규약 유지).
    if (blanks) assert.match(src, /rel="noopener noreferrer"/, `${name}: rel 규약이 빠졌다`);
  }
  // 콘솔은 링크마다 적지 않고 한 곳(ExternalLink)에서만 만든다 — 표시와 고지가 갈라지지 않게.
  assert.equal((admin.match(/target="_blank"/g) || []).length, 1, '콘솔에 ExternalLink 를 거치지 않는 새 창 링크가 있다');
  assert.match(admin, /function ExternalLink\(/, '콘솔 새 창 링크 공통 껍데기가 없다');
  assert.equal((admin.match(/<ExternalLink /g) || []).length, 2, '콘솔 새 창 링크 수가 바뀌었다');
  // 접근 이름은 보이는 글자로 시작해야 음성 입력이 이름으로 누를 수 있다(WCAG 2.5.3).
  assert.match(admin, /aria-label=\{`\$\{label\} — 새 창에서 열립니다`\}/, '콘솔 접근 이름이 보이는 글자로 시작하지 않는다');
  assert.match(widget, /aria-label=\{`\$\{m\.cta\.label\} — 새 창에서 열립니다`\}/, '위젯 접근 이름이 보이는 글자로 시작하지 않는다');
});


/* ══════════ 13순위 — 백로그 소진 후 10차 재감사 (DS 13-x) ══════════ */

test('임베드 메시지는 자칭 이름이 아니라 보낸 창으로 가린다 (DS 13-1)', () => {
  const e = read('public/embed.js');
  // `{source:'gowon-chat'}` 은 누구나 적을 수 있는 자칭 이름이다. 위조할 수 없는 검사는
  // "보낸 창이 우리 iframe 인가" 하나뿐이고, 이 신호 하나가 전체화면 전환을 결정한다.
  assert.match(e, /if \(ev\.source !== iframe\.contentWindow\) return;/, '호스트가 보낸 창을 확인하지 않는다');
  assert.match(e, /if \(frameOrigin !== '\*' && ev\.origin !== frameOrigin\) return;/, '출처 2차 확인이 없다');
  // 종전의 `origin && ev.origin !== origin` 은 주소를 읽지 못하면 검사를 통째로 건너뛰었다.
  assert.equal(/if \(origin && ev\.origin !== origin\) return;/.test(e), false, '출처를 못 읽으면 검사를 건너뛰는 경로가 남아 있다');
  // 호스트 뷰포트 크기를 아무 출처로나 뿌리지 않는다.
  assert.match(e, /var frameOrigin = '\*';/, '위젯 프레임 출처를 따로 풀지 않는다');
  assert.match(e, /new URL\(iframe\.src, window\.location\.href\)\.origin/, '프레임 출처는 iframe 주소에서 풀어야 한다');
  const targets = [...e.matchAll(/\}, ([^)]+)\);/g)].map((m) => m[1].trim());
  assert.ok(targets.includes('frameOrigin'), 'sendViewport 가 프레임 출처로 보내지 않는다');
  assert.equal(targets.includes("origin || '*'"), false, "호스트 뷰포트를 '*' 로 뿌린다");

  // 위젯 쪽도 같은 경계를 갖는다 — 이 값이 전체화면(화면을 통째로 덮는 상태)을 정한다.
  // 호스트 출처는 고객사마다 달라 미리 알 수 없으므로 창 검사가 유일한 경계다.
  const w = read('src/components/ChatWidget.tsx');
  assert.match(w, /if \(ev\.source !== window\.parent\) return;/, '위젯이 부모가 보낸 메시지인지 확인하지 않는다');
  const onHost = w.slice(w.indexOf('const onHost ='), w.indexOf("window.addEventListener('message', onHost)"));
  assert.ok(onHost.indexOf('ev.source !== window.parent') < onHost.indexOf("d.source !== 'gowon-chat-host'"),
    '창 검사가 자칭 이름 검사보다 뒤에 있다');
  // 공개 계약은 그대로.
  assert.match(e, /attr\('data-tenant', ''\)/, 'data-tenant 옵션 계약이 깨졌다');
  assert.match(e, /attr\('data-position', 'right'\)/, 'data-position 옵션 계약이 깨졌다');
});

test('랜딩 섹션 메뉴가 좁은 화면에서 사라지지 않는다 (DS 13-2)', () => {
  const css = read('src/app/globals.css');
  const page = read('src/app/page.tsx');
  // 약관 페이지 목차(DS 4-4)는 ≤900px 에서 가로 스크롤 칩으로 접힌다. 같은 셸을 쓰는
  // 랜딩만 메뉴를 통째로 지우면, 좁은 화면에는 섹션으로 가는 수단이 아예 없다.
  assert.equal(/\.lp-nav\{display:none\}/.test(css), false, '좁은 화면에서 랜딩 메뉴를 지운다');
  const mq = (css.match(/@media \(max-width:900px\)\{[^@]*?\.lp-nav\{[\s\S]*?\n\}/) || [])[0];
  assert.ok(mq, '랜딩 메뉴의 좁은 화면 규칙이 없다');
  assert.match(mq, /\.lp-nav\{[^}]*overflow-x:auto/, '메뉴가 가로로 스크롤되지 않는다');
  assert.match(mq, /\.lp-nav\{[^}]*flex-wrap:nowrap/, '칩이 여러 줄로 쌓이면 상단바가 화면을 덮는다');
  // 손가락 목표는 약관 목차 칩과 같은 규격(34px).
  const chip = (mq.match(/\.lp-nav a\{[^}]*\}/) || [])[0] || '';
  const toc = (css.match(/\.lg-toc-list a\{[^}]*min-height:(\d+)px/) || [])[1];
  assert.match(chip, new RegExp(`min-height:${toc}px`), `칩 손가락 목표가 약관 목차(${toc}px)와 다르다`);

  // 상단바가 두 줄이 되므로 앵커 착지점도 같이 내려가야 한다(DS 10-2 의 단일 출처).
  const wide = Number((css.match(/^html\{[^}]*scroll-padding-top:(\d+)px/m) || [])[1]);
  const narrow = Number((mq.match(/html\{scroll-padding-top:(\d+)px\}/) || [])[1]);
  assert.ok(narrow > wide, `두 줄 상단바인데 착지 여백이 그대로다: ${narrow}px ≤ ${wide}px`);
  assert.equal(/scroll-margin-top/.test(css), false, 'scroll-padding-top 과 scroll-margin-top 이 겹친다');

  // 인라인으로 적은 값은 미디어 쿼리가 이기지 못한다 — 폭·높이·여백을 전부 클래스로 내보낸다.
  // (`wrap` 의 padding:'0 22px' 하나가 두 줄 상단바의 세로 여백을 통째로 막는다.)
  assert.match(page, /<div className="lp-topin">/, '상단바가 여전히 인라인 레이아웃을 쓴다');
  assert.equal(/height: 62/.test(page), false, '인라인 높이가 남아 있어 두 줄로 접히지 않는다');
  const topin = (css.match(/\.lp-topin\{[^}]*\}/) || [])[0] || '';
  for (const prop of ['max-width', 'padding', 'height:62px']) {
    assert.ok(topin.includes(prop), `상단바 ${prop} 가 클래스에 없다`);
  }
  assert.match(mq, /\.lp-topin\{[^}]*padding:10px 22px 8px/, '두 줄 상단바의 세로 여백이 없다');
  // 메뉴 칩은 전부 링크라 Tab 으로 닿는다 — 스크롤 영역에 별도 tabindex 를 두지 않는다(DS 9-1 단서).
  assert.match(page, /<nav aria-label="주요 섹션" className="lp-nav">/, '메뉴 랜드마크 이름이 사라졌다');
});

/* ────────────────────────────────────────────────────────────────
 * DS 15-1 — 응답 보안 헤더 (next.config.js)
 * 종전에는 한 줄도 없었다: 남의 페이지가 로그인된 `/admin` 을 프레임으로 띄울 수 있었고,
 * 내려받은 백업·로그 파일이 HTML 로 해석될 수 있었다.
 * ──────────────────────────────────────────────────────────────── */
test('보안 헤더: 모든 응답에 nosniff·Referrer-Policy·HSTS·Permissions-Policy 가 붙는다', () => {
  const s = read('next.config.js');
  assert.match(s, /async headers\(\)/, 'headers() 가 있어야 한다');
  assert.match(s, /'X-Content-Type-Options',\s*value:\s*'nosniff'/);
  assert.match(s, /'Referrer-Policy',\s*value:\s*'strict-origin-when-cross-origin'/);
  assert.match(s, /'Strict-Transport-Security',\s*value:\s*'max-age=\d{7,}/);
  assert.match(s, /'Permissions-Policy'/);
  // 전역 규칙의 대상은 모든 경로여야 한다(화면을 하나씩 세면 새 화면이 빠진다).
  assert.match(s, /source:\s*'\/:path\*',\s*headers:\s*BASE/);
});

test('보안 헤더: 프레임은 기본 금지이고 위젯만 예외다', () => {
  const s = read('next.config.js');
  assert.match(s, /frame-ancestors 'none'/, '기본은 프레임 금지여야 한다');
  // 「막을 곳을 센다」가 아니라 「열 곳만 뺀다」 — 새 화면이 늘어도 기본이 막힘이다.
  assert.match(s, /source:\s*'\/\(\(\?!widget/, '전역 규칙에서 /widget 을 정규식으로 빼야 한다');
  // 같은 헤더를 두 번 내보내면 브라우저가 둘 다 적용해 위젯이 막힌다 → CSP 규칙은 하나뿐이어야 한다.
  assert.equal(
    (s.match(/'Content-Security-Policy'/g) || []).length,
    1,
    'CSP 규칙이 둘 이상이면 위젯 응답에 두 줄이 나가 임베드가 막힌다',
  );
  // X-Frame-Options 는 「아무나 허용」 값이 없으므로 전역에 걸면 안 된다(위젯이 죽는다).
  assert.ok(!/source:\s*'\/:path\*',\s*headers:\s*\[\{\s*key:\s*'X-Frame-Options'/.test(s));
  assert.match(s, /source:\s*'\/admin\/:path\*'[\s\S]{0,120}X-Frame-Options[\s\S]{0,40}DENY/);
  assert.match(s, /source:\s*'\/api\/admin\/:path\*'[\s\S]{0,120}X-Frame-Options[\s\S]{0,40}DENY/);
});

/* ────────────────────────────────────────────────────────────────
 * DS 15-3 — robots.txt / sitemap.xml (종전 둘 다 404)
 * ──────────────────────────────────────────────────────────────── */
test('robots.txt 가 콘솔·API·위젯 프레임을 크롤 대상에서 뺀다', () => {
  assert.ok(has('src/app/robots.ts'), 'app/robots.ts 가 있어야 한다');
  const s = read('src/app/robots.ts');
  for (const p of ['/admin', '/api/', '/widget']) {
    assert.ok(s.includes(`'${p}'`), `${p} 가 disallow 에 없다`);
  }
  assert.match(s, /sitemap:/, 'sitemap 주소를 알려야 한다');
  // 주소는 지어내지 않고 단일 출처에서 온다.
  assert.match(s, /from '@\/lib\/site'/);
  assert.ok(!/https:\/\/[a-z0-9.-]+\.(vercel\.app|com)/.test(s), '배포 주소를 여기 적으면 안 된다(@/lib/site)');
});

test('sitemap 은 공개 화면 3장만 싣고 날짜를 지어내지 않는다', () => {
  assert.ok(has('src/app/sitemap.ts'), 'app/sitemap.ts 가 있어야 한다');
  const s = read('src/app/sitemap.ts');
  for (const p of ['/`', '/terms`', '/privacy`']) assert.ok(s.includes(p), `${p} 가 없다`);
  for (const p of ['/admin', '/widget', '/api']) {
    assert.ok(!s.includes(p), `${p} 는 사이트맵에 넣지 않는다`);
  }
  // 배포마다 오늘 날짜를 찍으면 검색엔진이 「매일 바뀌는 문서」로 읽고 다시 오지 않는다.
  assert.ok(!/new Date\(\)/.test(s), 'lastModified 에 배포 시각을 찍으면 안 된다');
  assert.match(s, /LEGAL_UPDATED/, '화면이 보여 주는 시행일과 같은 값이어야 한다');
});

test('배포 주소·법무 시행일이 단일 출처에서 나온다', () => {
  const site = read('src/lib/site.ts');
  assert.match(site, /NEXT_PUBLIC_SITE_URL/);
  // http(s) 가 아닌 값(javascript: 등)은 받지 않는다.
  assert.match(site, /protocol !== 'https:'/);
  assert.match(site, /export const LEGAL_UPDATED = '(\d{4}-\d{2}-\d{2})'/);
  const date = site.match(/export const LEGAL_UPDATED = '(\d{4}-\d{2}-\d{2})'/)[1];
  // 약관·방침 화면이 같은 상수를 봐야 한다 — 갈라지면 사이트맵이 화면과 다른 날짜를 알린다.
  for (const p of ['src/app/terms/page.tsx', 'src/app/privacy/page.tsx']) {
    const s = read(p);
    assert.match(s, /updated=\{LEGAL_UPDATED\}/, `${p} 가 상수를 쓰지 않는다`);
    assert.ok(!s.includes(`updated="${date}"`), `${p} 에 날짜가 하드코딩돼 있다`);
  }
  // 링크 미리보기의 기준 주소도 같은 곳에서 온다.
  const layout = read('src/app/layout.tsx');
  assert.match(layout, /from '@\/lib\/site'/);
  assert.ok(!/const SITE_URL = process\.env/.test(layout), 'layout 이 기본값을 따로 들고 있으면 갈라진다');
});

/* CSV 수식 주입 — 단일 출처 고정(실행 검증은 runtime.test.mjs) */
test('CSV 를 만드는 곳이 전부 공용 이스케이프를 쓴다', () => {
  const WRITERS = ['src/lib/audit.ts', 'src/lib/settlement.ts', 'src/lib/convlog.ts'];
  for (const p of WRITERS) {
    const s = read(p);
    assert.match(s, /from '@\/lib\/csv'/, `${p} 가 공용 이스케이프를 쓰지 않는다`);
    // 제 손으로 따옴표만 세우는 사본이 다시 생기면 수식 주입이 되살아난다.
    assert.ok(!/function csvCell/.test(s), `${p} 에 csvCell 사본이 남아 있다`);
  }
  const csv = read('src/lib/csv.ts');
  assert.match(csv, /\[=\+\\?-@/, '수식 시작 글자(= + - @ 탭 CR)를 모두 봐야 한다');
  assert.match(csv, /PLAIN_NUMBER/, '순수한 수는 예외여야 한다(음수 금액)');
});

/**
 * DS 15-1 — 헤더 규칙을 **Next 자신의 경로 매칭기로 실제로 돌려** 확인한다.
 * 문자열 검사로는 `/((?!widget(?:/|$)).*)` 가 정말 `/widget` 만 빼는지 알 수 없고,
 * 여기를 잘못 쓰면 ① 위젯 응답에 CSP 가 두 줄 나가 **고객사 임베드가 통째로 막히거나**
 * ② 반대로 콘솔이 프레임 금지에서 빠져 원래 결함으로 되돌아간다. 둘 다 조용히 일어난다.
 */
test('헤더 규칙 매칭: 위젯만 프레임이 열리고 나머지는 전부 막힌다', async () => {
  const { createRequire } = await import('node:module');
  const require_ = createRequire(new URL('../package.json', import.meta.url));
  let pathToRegexp;
  try {
    const m = require_('next/dist/compiled/path-to-regexp');
    pathToRegexp = m.pathToRegexp || m.default?.pathToRegexp || m;
  } catch {
    return; // next 미설치 환경 — 위의 텍스트 계약 검사로 갈음한다.
  }
  const { fileURLToPath } = await import('node:url');
  const rules = await require_(fileURLToPath(new URL('../next.config.js', import.meta.url))).headers();
  const keysFor = (p) =>
    rules.filter((r) => pathToRegexp(r.source).test(p)).flatMap((r) => r.headers.map((h) => h.key));

  const BASE = ['X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy', 'Strict-Transport-Security'];

  // 위젯: 프레임으로 도는 것이 존재 이유 — CSP 가 한 줄도 나가면 안 된다.
  for (const p of ['/widget', '/widget/']) {
    const keys = keysFor(p);
    for (const b of BASE) assert.ok(keys.includes(b), `${p} 에 ${b} 가 빠졌다`);
    assert.equal(keys.filter((k) => k === 'Content-Security-Policy').length, 0, `${p} 에 CSP 가 붙으면 임베드가 막힌다`);
    assert.ok(!keys.includes('X-Frame-Options'), `${p} 에 X-Frame-Options 가 붙으면 임베드가 막힌다`);
  }

  // 나머지: 프레임 금지가 **정확히 한 번**. 두 번이면 브라우저가 둘 다 적용한다.
  for (const p of ['/', '/terms', '/privacy', '/admin', '/admin/x', '/api/chat', '/embed.js', '/robots.txt', '/sitemap.xml']) {
    const keys = keysFor(p);
    for (const b of BASE) assert.ok(keys.includes(b), `${p} 에 ${b} 가 빠졌다`);
    assert.equal(keys.filter((k) => k === 'Content-Security-Policy').length, 1, `${p} 의 CSP 개수가 1이 아니다`);
  }

  // 콘솔·관리 API 는 구형 브라우저에도 못을 박는다.
  for (const p of ['/admin', '/admin/x', '/api/admin/backup', '/api/admin/logs/export']) {
    assert.ok(keysFor(p).includes('X-Frame-Options'), `${p} 에 X-Frame-Options 가 빠졌다`);
  }
});

/* ══════════ 디자인 스프린트 — 13차 재감사 (DS 16-1·16-2) ══════════ */

/**
 * 최후 오류 화면(global-error)은 `globals.css` 가 실리지 않는 유일한 화면이라 토큰 값을 직접 들어야 한다.
 * 그 사본이 둘이 되면(종전: global-error 의 토큰표 + SystemPage 의 `var(--x, 기본값)`) 단일 출처가 갈라져
 * DS 10-1 처럼 토큰을 내린 뒤에도 **이 화면에서만** 옛 값이 남는다. 사본은 한 벌이고, 그 한 벌은 :root 와 같아야 한다.
 */
test('시스템 화면 토큰 사본이 :root 와 한 글자도 다르지 않다 (DS 16-1)', () => {
  const sys = read('src/components/SystemPage.tsx');
  const t = tokens();

  // 사본 한 벌 — SYSTEM_TOKENS.
  const table = sys.split('export const SYSTEM_TOKENS = {')[1]?.split('} as CSSProperties')[0];
  assert.ok(table, 'SystemPage 가 토큰 사본(SYSTEM_TOKENS)을 내보내지 않는다');
  const copy = {};
  for (const [, k, v] of table.matchAll(/'(--[a-z0-9-]+)':\s*(?:'([^']*)'|"([^"]*)")/g)) copy[k] = (v ?? '').trim();
  for (const [, k, v] of table.matchAll(/'(--[a-z0-9-]+)':\s*"([^"]*)"/g)) copy[k] = v.trim();

  // hex 토큰은 :root 값과 같아야 한다(대소문자 무시 — #FFFFFF/#ffffff 는 같은 색이다).
  for (const [k, v] of Object.entries(copy)) {
    if (!/^#[0-9A-Fa-f]{6}$/.test(v)) continue;
    assert.ok(t[k], `:root 에 없는 토큰을 사본이 들고 있다: ${k}`);
    assert.equal(v.toLowerCase(), t[k].toLowerCase(), `${k} 사본(${v})이 :root(${t[k]})와 다르다 — 최후 화면만 옛 값으로 남는다`);
  }
  // DS 10-1 이 내린 값이 여기서 되돌아가지 않게 못을 박는다.
  assert.equal(copy['--mut'].toLowerCase(), t['--mut'].toLowerCase(), '--mut 사본이 AA 미달 옛 값으로 되돌아갔다');

  // 그림자·글꼴처럼 hex 가 아닌 토큰도 :root 원문과 같아야 한다(종전 사본은 그림자 두 겹 중 한 겹만 들었다).
  const root = read('src/app/globals.css').split(':root{')[1].split('\n}')[0];
  for (const k of ['--shadow-card', '--font']) {
    const m = root.match(new RegExp(`${k}\\s*:\\s*([^;]+);`));
    assert.ok(m, `:root 에 ${k} 가 없다`);
    const want = m[1].trim().replace(/\s+/g, ' ');
    const got = (copy[k] || '').replace(/\s+/g, ' ');
    assert.equal(got, want, `${k} 사본이 :root 와 다르다 — 최후 화면만 다른 규격으로 보인다`);
  }

  // 화면은 기본값 없는 var() 로만 참조한다 — 기본값을 쓰면 사본이 다시 둘이 된다.
  for (const f of ['src/components/SystemPage.tsx', 'src/components/BrandMark.tsx']) {
    const body = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/var\(\s*--[a-z0-9-]+\s*,/.test(body), false, `${f} 에 var(--x, 기본값) 이 남아 있다`);
  }

  // 최후 화면이 참조하는 토큰은 **전부** 사본에 있어야 한다(하나라도 빠지면 그 값만 브라우저 기본으로 떨어진다).
  const used = new Set();
  for (const f of ['src/components/SystemPage.tsx', 'src/components/BrandMark.tsx']) {
    const body = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const [, k] of body.matchAll(/var\((--[a-z0-9-]+)\)/g)) used.add(k);
  }
  for (const k of used) assert.ok(k in copy, `최후 화면이 쓰는 ${k} 가 토큰 사본에 없다`);

  // global-error 는 제 사본을 만들지 않고 그 한 벌을 그대로 쓴다.
  const ge = read('src/app/global-error.tsx');
  assert.match(ge, /import SystemPage, \{ SYSTEM_TOKENS \}/, 'global-error 가 토큰 사본을 따로 들고 있다');
  assert.match(ge, /\{ \.\.\.SYSTEM_TOKENS/, 'global-error 가 사본을 body 에 얹지 않는다');
  assert.equal(/'--[a-z0-9-]+':/.test(ge), false, 'global-error 에 토큰 정의가 다시 생겼다');
});

/**
 * 약관·방침으로 가는 길은 두 푸터의 링크 두 개뿐인데(DS 15-3), 글자만 있는 12.5px 링크라
 * 누를 수 있는 높이가 15px 였다 — 같은 화면의 다른 링크는 34~42px 를 지킨다.
 */
test('푸터 법무 링크가 손가락으로 누를 수 있는 규격을 지킨다 (DS 16-2)', () => {
  const css = read('src/app/globals.css');
  const rule = css.match(/\.lp-footlink\{([^}]*)\}/);
  assert.ok(rule, '.lp-footlink 규격이 없다 — 화면마다 인라인으로 적으면 좁은 화면 규칙이 이기지 못한다');
  const h = rule[1].match(/min-height:(\d+)px/);
  assert.ok(h && Number(h[1]) >= 44, `누를 면이 44px 미만이다: ${rule[1]}`);
  assert.match(rule[1], /display:inline-flex/, '높이를 주려면 inline 이 아니어야 한다(inline 요소는 높이를 받지 않는다)');
  assert.match(rule[1], /align-items:center/, '글자가 위로 붙는다');
  // 같은 화면의 다른 터치 규격보다 작지 않아야 한다(목차 칩 34px — DS 13-2).
  const chip = css.match(/\.lg-toc-list a\{[^}]*min-height:(\d+)px/);
  assert.ok(chip && Number(h[1]) >= Number(chip[1]), '법무 링크가 목차 칩보다 작다');

  // 두 푸터가 같은 규격을 본다 — 인라인으로 갈라지지 않게.
  for (const f of ['src/app/page.tsx', 'src/app/privacy/LegalLayout.tsx']) {
    const src = read(f);
    for (const href of ['/terms', '/privacy']) {
      const m = src.match(new RegExp(`href="${href}"[^>]*>`));
      assert.ok(m, `${f} 에 ${href} 링크가 없다`);
      assert.match(m[0], /className="lp-footlink"/, `${f} 의 ${href} 링크가 공용 규격을 쓰지 않는다`);
      assert.equal(/style=\{\{/.test(m[0]), false, `${f} 의 ${href} 링크에 인라인 스타일이 남아 있다`);
    }
  }
});


/* ══════════ 디자인 스프린트 — 14차 재감사 (DS 17-1·17-2·17-3) ══════════ */

/**
 * DS 17-1 — 글꼴은 **동적 서브셋** 판만 쓴다.
 *
 * 통짜 판(`static/pretendard.css`)은 서브셋이 없어 굵기 하나가 통째로 750~780KB 다.
 * 화면이 쓰는 굵기는 4종(400·600·700·800)이라 첫 방문에 **3.0MB**(라이브 실측 748+767+773+775KB).
 * 같은 루트 레이아웃을 `/widget` 이 쓰므로 그 값은 **고객사 사이트 방문자**가 치른다.
 *
 * 이 테스트가 고정하는 것은 세 가지다 — ① 통짜 판으로 되돌아가지 않는다 ② preconnect 가
 * 스타일시트와 **같은 출처**를 가리킨다(두 문자열이 갈라지면 미리 연 연결이 아무 데도 쓰이지 않는다)
 * ③ 시트가 싣는 family 이름이 `--font` 의 **첫 이름**과 같다(종전에는 시트가 `Pretendard` 만
 * 싣는데 토큰의 첫 이름은 `Pretendard Variable` 이라 첫 자리가 죽어 있었다).
 */
test('글꼴은 동적 서브셋 판을 쓰고 CDN 연결을 미리 연다 (DS 17-1)', () => {
  const s = read('src/app/layout.tsx');
  // 주석은 걷어내고 본다 — 아래 검사들은 「없어야 한다」라서 설명 문장에 걸리면 거짓 실패한다.
  const code = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // ① 통짜 판 금지.
  assert.equal(/static\/pretendard\.css/.test(code), false,
    '서브셋 없는 통짜 글꼴로 되돌아갔다 — 굵기 4종이면 첫 방문에 3.0MB 다');
  const css = s.match(/const FONT_CSS = `([^`]+)`/);
  assert.ok(css, 'FONT_CSS 한 곳에서 글꼴 시트 주소를 정하지 않는다');
  assert.match(css[1], /dynamic-subset\.css$/, '글꼴 시트가 동적 서브셋(unicode-range) 판이 아니다');

  // ② preconnect 는 시트와 같은 출처여야 한다 — 문자열 두 벌이 갈라지지 않게 FONT_ORIGIN 을 재사용한다.
  const origin = s.match(/const FONT_ORIGIN = '([^']+)'/);
  assert.ok(origin && /^https:\/\//.test(origin[1]), 'FONT_ORIGIN 이 없다');
  assert.ok(css[1].startsWith('${FONT_ORIGIN}'), '글꼴 시트 주소가 FONT_ORIGIN 을 쓰지 않는다 — 두 출처가 갈라진다');
  const pre = s.match(/<link rel="preconnect"[^>]*>/);
  assert.ok(pre, '글꼴 CDN 에 preconnect 가 없다 — 첫 글자 앞에서 DNS·TLS 왕복이 통째로 남는다');
  assert.match(pre[0], /href=\{FONT_ORIGIN\}/, 'preconnect 가 FONT_ORIGIN 이 아닌 다른 주소를 가리킨다');
  assert.match(pre[0], /crossOrigin="anonymous"/, '글꼴은 익명 CORS 요청이라 crossOrigin 없이는 연결이 재사용되지 않는다');

  // ③ 시트가 싣는 family 와 토큰의 첫 이름이 같아야 한다.
  const font = read('src/app/globals.css').match(/--font:([^;]+);/);
  assert.ok(font, '--font 토큰이 없다');
  assert.ok(font[1].trim().startsWith("'Pretendard Variable'"),
    `--font 의 첫 이름이 'Pretendard Variable' 이 아니다: ${font[1].trim()}`);
  assert.match(css[1], /\/variable\/pretendardvariable-/,
    '시트가 가변 글꼴 판이 아니면 --font 의 첫 이름은 한 번도 로드되지 않는다(죽은 자리)');
});

/**
 * DS 17-2 — `/embed.js` 만 캐시를 연다.
 *
 * 이 파일은 **고객사 사이트의 모든 페이지**에 박히는 유일한 파일인데, 기본 정책
 * (`public, max-age=0, must-revalidate` — 라이브 실측)에서는 페이지를 옮길 때마다 상담창이
 * 뜨기 전에 재검증 왕복이 먼저 끼어든다. 반대로 HTML·API 에 캐시를 열면 대화·집계가 낡는다 —
 * 그래서 **열리는 곳이 이 한 곳뿐**임을 함께 고정한다.
 */
test('embed.js 만 캐시가 열리고 화면·API 는 그대로다 (DS 17-2)', async () => {
  const s = read('next.config.js');
  const rule = s.match(/const EMBED_CACHE = \[\{ key: 'Cache-Control', value: '([^']+)' \}\]/);
  assert.ok(rule, 'embed.js 캐시 정책이 한 곳(EMBED_CACHE)에 없다');
  const age = rule[1].match(/max-age=(\d+)/);
  assert.ok(age && Number(age[1]) > 0, `max-age 가 0 이면 매 페이지마다 재검증 왕복이 남는다: ${rule[1]}`);
  assert.ok(Number(age[1]) <= 3600, `스니펫 수정이 닿기까지 너무 오래 걸린다: ${rule[1]}`);
  assert.match(rule[1], /stale-while-revalidate=\d+/, '새로 받는 동안 방문자가 기다리지 않게 SWR 을 둔다');
  assert.equal(/must-revalidate/.test(rule[1]), false, 'must-revalidate 면 캐시를 연 뜻이 없다');

  // 규칙을 **Next 자신의 경로 매칭기로 실제로 돌려** 확인한다(문자열 검사로는 범위를 알 수 없다).
  const { createRequire } = await import('node:module');
  const require_ = createRequire(new URL('../package.json', import.meta.url));
  let pathToRegexp;
  try {
    const m = require_('next/dist/compiled/path-to-regexp');
    pathToRegexp = m.pathToRegexp || m.default?.pathToRegexp || m;
  } catch {
    return; // next 미설치 환경 — 위의 텍스트 계약 검사로 갈음한다.
  }
  const { fileURLToPath } = await import('node:url');
  const rules = await require_(fileURLToPath(new URL('../next.config.js', import.meta.url))).headers();
  const cacheCount = (p) =>
    rules.filter((r) => pathToRegexp(r.source).test(p))
      .flatMap((r) => r.headers.map((h) => h.key))
      .filter((k) => k === 'Cache-Control').length;

  assert.equal(cacheCount('/embed.js'), 1, '/embed.js 에 캐시 정책이 붙지 않았다');
  for (const p of ['/', '/widget', '/admin', '/api/chat', '/api/admin/backup', '/terms']) {
    assert.equal(cacheCount(p), 0, `${p} 에 캐시가 열렸다 — 화면·API 는 언제나 최신이어야 한다`);
  }
});

/**
 * DS 17-3 — 밝은 화면 한 벌임을 선언한다.
 *
 * 선언이 없으면(`color-scheme: normal` — 라이브 실측) Android Chrome 의 자동 다크 테마가
 * 「다크를 준비하지 않은 사이트」로 보고 색을 스스로 뒤집는다. 그 화면은 고객사 사이트 위의
 * 상담창이기도 하다 — 우리가 손대지 않은 곳에서 브랜드가 어긋난다.
 * meta 와 CSS 를 **둘 다** 둔다: 판정은 문서를 받는 순간에 나므로 CSS 보다 meta 가 먼저 읽힌다.
 */
test('밝은 화면 한 벌임을 선언한다 — 자동 다크에 색을 맡기지 않는다 (DS 17-3)', () => {
  const root = read('src/app/globals.css').split(':root{')[1].split('\n}')[0];
  assert.match(root, /color-scheme\s*:\s*light/, ':root 에 color-scheme 선언이 없다');

  const layout = read('src/app/layout.tsx');
  assert.match(layout, /<meta name="color-scheme" content="light" \/>/,
    'meta 선언이 없다 — CSS 가 도착하기 전에 자동 다크 판정이 난다');

  // 임베드 프레임도 같은 선언이어야 한다. `normal` 은 「정하지 않음」이라 호스트 배색에 끌려간다.
  const embed = read('public/embed.js');
  const style = embed.split('iframe.style.cssText = [')[1].split('].join')[0];
  assert.match(style, /'color-scheme:light'/, '임베드 프레임이 밝은 화면임을 선언하지 않는다');
  assert.equal(/color-scheme:normal/.test(style), false, '프레임이 아직 color-scheme:normal 이다');
});
/**
 * DS 19-1 — 「빠른 답장」이 이음 프리셋에만 연결돼 있었다.
 *
 * `tenantConfig(id)` 는 등록된 프리셋(예: eum)일 때만 값을 돌려준다(`getTenantPreset` 이 그 외에는
 * null). 그런데 랜딩(`page.tsx`)과 기본 임베드(`widget/page.tsx`)는 `tenant` 가 없으면 아무것도
 * 넘기지 않았다 — 그래서 GOWON 자체(테넌트를 지정하지 않는 가장 흔한 경우)는 관리 콘솔에 지식을
 * 아무리 채워도 위젯 첫 화면에 칩이 한 번도 뜨지 않았다. `tests/widget.test.mjs` 의 렌더 테스트가
 * 전부 가짜 `tenant` 객체를 직접 넘겨 왔기 때문에 이 배선 누락이 18차 재감사까지 드러나지 않았다.
 * `fallbackStarters()`(일반 지식베이스 상위 질문)를 두 화면 모두에 연결한다 — 단, 실제 테넌트가
 * 붙었을 때는 절대 쓰지 않는다(자기 칩이 비었다고 일반 지식으로 채우면 다른 브랜드 문구가 샌다).
 */
test('기본 위젯(테넌트 없음)도 일반 지식베이스에서 빠른 답장을 받는다 (DS 19-1)', () => {
  const lib = read('src/lib/tenantKB.ts');
  assert.match(lib, /export function fallbackStarters\(\)/, 'fallbackStarters 가 없다');
  assert.match(lib, /listKB\(\)/, 'fallbackStarters 는 관리 콘솔 지식베이스(listKB)에서 뽑아야 한다');

  const landing = read('src/app/page.tsx');
  assert.match(landing, /import \{ fallbackStarters \} from '@\/lib\/tenantKB'/, '랜딩이 fallbackStarters 를 불러오지 않는다');
  assert.match(landing, /<ChatWidget\s+defaultOpen=\{false\}\s+fallbackStarters=\{fallbackStarters\(\)\}/, '랜딩 위젯에 fallbackStarters 가 연결되지 않았다');

  const widgetPage = read('src/app/widget/page.tsx');
  assert.match(widgetPage, /fallbackStarters(?:,\s*| )tenantConfig|tenantConfig(?:,\s*| )fallbackStarters/, '위젯 페이지가 fallbackStarters 를 불러오지 않는다');
  assert.match(widgetPage, /tenant \? \{ tenant \} : \{ fallbackStarters: fallbackStarters\(\) \}/, 'tenant 가 없을 때만 fallbackStarters 를 써야 한다');

  const widget = read('src/components/ChatWidget.tsx');
  assert.match(widget, /fallbackStarters\?:\s*string\[\]/, 'ChatWidget 이 fallbackStarters 프롭을 받지 않는다');
  // 테넌트가 있으면 그 테넌트의 starters 만 본다 — 있을 때도 fallbackStarters 로 새면 격리가 깨진다.
  assert.match(widget, /const starters = \(tenant \? \(tenant\.starters \?\? \[\]\) : \(fallbackStarters \?\? \[\]\)\)/, 'tenant 유무에 따라 출처가 갈라지지 않는다(격리 깨짐 위험)');
});

/** 소스에서 함수 하나의 본문만 떼어낸다(들여쓴 `  }` 로 끝나는 컴포넌트 안 함수 기준). */
function fnBody(src, decl) {
  const i = src.indexOf(decl);
  assert.ok(i >= 0, `${decl} 선언을 찾지 못했다`);
  const end = src.indexOf('\n  }', i);
  assert.ok(end > i, `${decl} 의 끝을 찾지 못했다`);
  return src.slice(i, end);
}

/**
 * DS 20-1 — 「닫고 처음으로」로 지운 대화의 답이 새 대화에 끼어든다.
 *
 * 답을 기다리는 동안 닫기를 누르면 `msgs`·`handoff` 는 초기화되지만 **보낸 요청은 그대로 돌아온다**.
 * 종전에는 그 응답이 아무 대조 없이 `pushBot`/`setHandoff` 로 들어가, 사용자가 방금 지운 질문의
 * 답이 새 대화의 인사말 아래 붙었다(§1 「중복 클릭·상태가 깨지지 않는다」). `busy` 도 그 요청이
 * 끝날 때까지 참이라 **묻지도 않았는데 타이핑 점 3개**가 돌았다.
 */
test('지운 대화의 응답이 새 대화에 끼어들지 않는다 (DS 20-1)', () => {
  const s = read('src/components/ChatWidget.tsx');
  assert.match(s, /const genRef = useRef\(0\)/, '대화 세대를 세는 ref 가 없다');

  const close = fnBody(s, 'const closePanel = useCallback(');
  assert.match(close, /genRef\.current \+= 1/, '「닫고 처음으로」가 대화 세대를 올리지 않는다');
  assert.match(close, /setBusy\(false\)/, '지운 대화의 기다림 표시를 내리지 않는다(묻지 않았는데 점이 뛴다)');

  const send = fnBody(s, 'async function sendText(');
  assert.match(send, /const gen = genRef\.current/, 'sendText 가 요청 시점의 세대를 잡지 않는다');
  // 응답 경로·네트워크 예외 경로·기다림 표시 해제 세 곳 모두 대조해야 한다.
  assert.ok((send.match(/gen !== genRef\.current/g) || []).length >= 2, '응답·예외 두 경로에서 세대를 대조해야 한다');
  assert.match(send, /if \(gen === genRef\.current\) setBusy\(false\)/, '새 대화의 기다림 표시를 꺼 버리면 중복 전송까지 열린다');

  const handoff = fnBody(s, 'async function submitHandoff(');
  assert.match(handoff, /const gen = genRef\.current/, 'submitHandoff 가 세대를 잡지 않는다');
  assert.ok((handoff.match(/gen !== genRef\.current/g) || []).length >= 2, '접수 응답·예외 두 경로에서 세대를 대조해야 한다');
});

/**
 * DS 20-3 — 되살린 대화에서 접수하면 「남긴 메시지 없음」이 붙는다.
 *
 * 접수에 싣는 마지막 고객 말을 전송할 때 채우는 ref 하나로 들고 있었다. 임베드 위젯은 호스트가
 * 페이지를 옮길 때마다 새로 뜨므로(DS 7-1 이 그래서 대화를 되살린다) 그 ref 는 비어 있고,
 * 운영자 화면에는 고객이 분명히 물어봤는데 「남긴 메시지 없음」이 떴다.
 */
test('접수에 싣는 마지막 고객 말은 화면의 대화에서 온다 (DS 20-3)', () => {
  const s = read('src/components/ChatWidget.tsx');
  assert.match(s, /export function lastUserText\(list: Msg\[\]\): string/, '대화에서 마지막 고객 말을 찾는 함수가 없다');
  assert.match(s, /message: lastUserText\(msgs\)/, '접수 요청이 화면의 대화에서 마지막 말을 싣지 않는다');
  // 되살린 대화에서 비는 별도 ref 를 다시 들이지 않는다(대화와 접수가 같은 출처를 봐야 한다).
  assert.equal(/lastUserRef/.test(s), false, '마지막 말을 별도 ref 로 들고 있으면 되살린 대화에서 빈 값이 된다');
});

/**
 * DS 21-1·21-2·21-3 — 「며칠인가」를 서버 시간대에 맡기고 있었다.
 *
 * 사용자는 한국에 있고 서버는 없다(Vercel Node 런타임 = UTC). 달력 날짜를 로컬/UTC 게터로 읽으면
 * 한국 자정~오전 9시 동안 하루가 어긋난다. 그 계산을 `src/lib/kst.ts` 한 곳으로 모으고,
 * **밖에서 다시 새지 않도록** 패턴 자체를 0건으로 고정한다(DS 6-2 의 단일 출처와 같은 방식).
 */
const KST_SOURCES = [
  'src/lib/kst.ts',
  'src/lib/slots.ts',
  'src/lib/settlement.ts',
  'src/lib/convlog.ts',
  'src/app/admin/page.tsx',
  ...ROUTES,
].filter(has);

test('달력 날짜 계산은 src/lib/kst.ts 밖에 없다 (DS 21-1·21-2·21-3)', () => {
  for (const p of KST_SOURCES) {
    if (p === 'src/lib/kst.ts') continue;
    const s = read(p);
    // 로컬 달력 게터 — 서버가 UTC 면 한국 날짜와 하루 어긋난다.
    assert.equal(/\.get(FullYear|Month|Date)\(\)/.test(s), false, `${p}: 로컬 달력 게터로 날짜를 읽는다`);
    // toISOString().slice(0,10|7) — UTC 날짜·달을 사람이 읽는 날짜처럼 쓰는 자리.
    assert.equal(/toISOString\(\)\.slice\(\s*0\s*,\s*(10|7)\s*\)/.test(s), false, `${p}: UTC 날짜를 사람이 읽는 날짜로 쓴다`);
  }
  // 시간대는 한 곳에서만 선언한다.
  const kst = read('src/lib/kst.ts');
  assert.match(kst, /9 \* 60 \* 60 \* 1000/, 'KST 오프셋 선언이 없다');
  assert.match(kst, /export function kstDate\(/);
  assert.match(kst, /export function kstMonth\(/);
  assert.match(kst, /export function kstStamp\(/);
});

test('예약 폼의 「오늘·내일」은 한국 달력으로 푼다 (DS 21-1)', () => {
  const s = read('src/lib/slots.ts');
  assert.match(s, /from '@\/lib\/kst'/, 'slots 가 한국 달력 모듈을 쓰지 않는다');
  assert.match(s, /kstYmd\(now\)/, '상대 날짜 기준일을 한국 시간으로 잡지 않는다');
  // 종전의 로컬 Date 조립 헬퍼는 남겨 두면 다시 쓰이게 된다.
  assert.equal(/function fmtDate\(/.test(s), false, '로컬 시간대에 의존하는 날짜 조립 함수가 남아 있다');
});

test('정산 기준월 기본값은 한국 시간 기준 이번 달이다 (DS 21-2)', () => {
  const lib = read('src/lib/settlement.ts');
  assert.match(lib, /return kstMonth\(at\)/, '서버 기본값이 한국 달력을 쓰지 않는다');
  const page = read('src/app/admin/page.tsx');
  assert.match(page, /function kstMonthNow\(/, '화면에 한국 달력 기본값 함수가 없다');
  assert.match(page, /useState\(\(\) => kstMonthNow\(\)\)/, '기준월 기본값이 한국 달력을 쓰지 않는다');
});

test('내려받기 파일 이름의 날짜는 한국 날짜다 (DS 21-3)', () => {
  for (const p of ['src/app/api/admin/backup/route.ts', 'src/app/api/admin/audit/route.ts', 'src/app/api/admin/logs/export/route.ts']) {
    const s = read(p);
    assert.match(s, /kstStamp\(\)/, `${p}: 파일 이름 날짜가 한국 날짜가 아니다`);
    assert.match(s, /filename="[^"]*\$\{date\}/, `${p}: 파일 이름에 날짜가 붙지 않는다`);
  }
});

test('대화 집계의 날짜 묶음도 같은 한 곳에서 온다 (DS 21-1)', () => {
  const s = read('src/lib/convlog.ts');
  assert.match(s, /import \{ KST_CSV_NOTE, kstDate, kstDateTime, readInstant \} from '@\/lib\/kst'/, 'convlog 가 한국 달력 모듈을 쓰지 않는다');
  // Intl 이 없는 환경에서 UTC 로 떨어지던 폴백을 되살리지 않는다(조용히 하루가 어긋나는 자리).
  assert.equal(/Asia\/Seoul/.test(s), false, '시간대 문자열이 두 곳에 있으면 갈라진다');
});

/* ══════════ 19차 재감사 — 운영자 화면에 코드가 그대로 뜨던 자리 (DS 22-x) ══════════ */

/** `const NAME ... = { k: 'v', 'k.k': 'v' };` 블록을 `{k: v}` 로 읽는다(두 사전 대조용). */
function dictOf(src, name) {
  const start = src.indexOf(`const ${name}`);
  assert.ok(start >= 0, `${name} 선언을 찾지 못했다`);
  const open = src.indexOf('{', start);
  const end = src.indexOf('\n};', open);
  assert.ok(open > 0 && end > open, `${name} 블록의 끝을 찾지 못했다`);
  const out = {};
  for (const m of src.slice(open + 1, end).matchAll(/^\s*'?([\w.:-]+)'?\s*:\s*'([^']*)'/gm)) out[m[1]] = m[2];
  assert.ok(Object.keys(out).length > 0, `${name} 에서 읽어낸 항목이 없다`);
  return out;
}

test('이관 요약 평문에는 코드가 아니라 사람 말만 남는다 (DS 22-1)', () => {
  const s = read('src/lib/handoff.ts');
  const body = s.slice(s.indexOf('export function renderSummaryText'));
  // 이 평문은 관리 콘솔 서랍의 「이관 요약」 칸에 그대로 그려진다 — 코드를 보간하면 그대로 화면에 뜬다.
  assert.equal(/\(\$\{s\.reason\}\)/.test(body), false, '사유 코드를 괄호로 덧붙이면 안 된다');
  assert.equal(/\$\{s\.lastIntent\}/.test(body), false, '인텐트 코드를 그대로 쓰면 안 된다');
  assert.equal(/s\.piiKinds\.join/.test(body), false, '마스킹 종류 영문 코드를 그대로 쓰면 안 된다');
  assert.equal(/채널 \$\{s\.channel\}/.test(body), false, '채널 코드를 그대로 쓰면 안 된다');
  assert.equal(/s\.ticketId \?\? s\.sessionId/.test(body), false, '식별자 원문을 그대로 쓰면 안 된다');
  assert.match(body, /shortId\(s\.ticketId, 8\)/, '접수번호는 서랍 제목과 같은 앞 8자');
  assert.match(body, /shortId\(s\.sessionId, 6\)/, '대화 식별자는 앞 6자');
  assert.match(body, /s\.lastIntentLabelKo/, '직전 주제는 표시명으로');
  assert.match(body, /piiKinds\.map\(maskKindLabel\)/, '마스킹 종류는 표시명으로');
  assert.match(body, /CHANNEL_LABELS\[s\.channel\]/, '채널은 표시명으로');
  // 코드 자체는 구조체에 그대로 남는다(기계가 보는 쪽) — 사람이 읽는 평문과 섞지 않는다.
  assert.match(s, /lastIntentLabelKo\?: string/, '표시명 필드 선언이 있어야 한다');
  assert.match(s, /reasonLabelKo: HANDOFF_REASON_LABELS\[input\.reason\]/, '사유 코드 필드가 사라지면 안 된다');
});

test('대화 주제 이름은 어휘를 아는 서버에서 온다 (DS 22-2)', () => {
  const page = read('src/app/admin/page.tsx');
  // 화면이 사전을 따로 들고 코드로 폴백하던 자리를 없앤다.
  assert.equal(/INTENT_LABELS/.test(page), false, '화면에 인텐트 사전이 남아 있으면 다시 어긋난다');
  assert.equal(/\|\| t\.intent\}/.test(page), false, '인텐트 코드를 폴백으로 그리면 안 된다');
  assert.match(page, /const UNNAMED_TOPIC = '기타'/, '이름 없는 주제의 표시명이 필요하다');
  assert.match(page, /intentLabel\?: string/, '턴에 주제 표시명 필드가 있어야 한다');
  assert.match(page, /topIntents: \{ intent: string; count: number; label\?: string \}/, '주제별 분포에도 표시명이 필요하다');
  // 서버 3곳(최근 대화·주제별 분포·응답 테스트)이 모두 같은 함수로 이름을 붙인다.
  const esc = read('src/app/api/admin/escalations/route.ts');
  assert.match(esc, /intentLabel: intentLabel\(t\.intent, labels\)/, '최근 대화에 이름이 붙지 않는다');
  assert.match(esc, /topIntents: conversation\.topIntents\.map/, '주제별 분포에 이름이 붙지 않는다');
  assert.match(read('src/app/api/chat/route.ts'), /intentLabel: intentLabel\(result\.intent/, '응답 테스트가 쓸 이름이 없다');
  // 내장 룰 이름은 룰 정의에서 그대로 온다 — 룰을 늘려도 사전을 고칠 일이 없다.
  const lib = read('src/lib/intents.ts');
  assert.match(lib, /for \(const r of RULES\) out\[r\.intent\] = r\.label/, '룰 라벨을 재사용하지 않으면 또 갈라진다');
  assert.match(lib, /UNKNOWN_INTENT_LABEL = '기타'/, '모르는 코드도 코드로 내보내지 않는다');
});

test('접수 폼 제목이 폼 정의와 어긋나지 않는다 (DS 22-2)', () => {
  const titles = dictOf(read('src/lib/intents.ts'), 'FORM_TITLES');
  const slots = read('src/lib/slots.ts');
  const forms = {};
  for (const m of slots.matchAll(/id: '([\w-]+)',\n\s*title: '([^']+)'/g)) forms[m[1]] = m[2];
  assert.ok(Object.keys(forms).length > 0, 'slots.ts 에서 폼 정의를 읽지 못했다');
  assert.deepEqual(titles, forms, '폼 제목이 두 곳에서 갈라졌다(화면에 다른 이름이 뜬다)');
});

test('채널·응답 근거 사전이 화면과 서버에서 같다 (DS 22-2)', () => {
  const lib = read('src/lib/intents.ts');
  const page = read('src/app/admin/page.tsx');
  assert.deepEqual(dictOf(page, 'CHANNEL_LABELS'), dictOf(lib, 'CHANNEL_LABELS'), '채널 표시명이 갈라졌다');
  assert.deepEqual(dictOf(page, 'SOURCE_VIEW_LABELS'), dictOf(lib, 'SOURCE_LABELS'), '응답 근거 표시명이 갈라졌다');
});

test('감사 로그 작업 이름이 작업 종류 전수를 덮는다 (DS 22-3)', () => {
  const s = read('src/lib/audit.ts');
  const union = s.slice(s.indexOf('export type AuditAction'), s.indexOf('export const AUDIT_ACTION_LABELS'));
  const codes = [...union.matchAll(/'([\w.]+)'/g)].map((m) => m[1]);
  assert.ok(codes.length >= 13, `작업 종류를 읽지 못했다(${codes.length}건)`);
  const labels = dictOf(s, 'AUDIT_ACTION_LABELS');
  assert.deepEqual(Object.keys(labels).sort(), [...codes].sort(), '이름 없는 작업 종류가 있으면 화면에 코드가 뜬다');
  for (const [code, label] of Object.entries(labels)) {
    assert.equal(/[A-Za-z]/.test(label), false, `${code}: 표시명에 영문이 섞였다(${label})`);
  }
  assert.match(s, /Record<AuditAction, string>/, '타입으로 전수를 강제해야 다음 작업에서 또 빠지지 않는다');
  // 화면은 서버가 준 이름만 그린다.
  const page = read('src/app/admin/page.tsx');
  assert.equal(/AUDIT_ACTION_LABELS/.test(page), false, '화면에 작업 사전이 남아 있으면 다시 어긋난다');
  assert.equal(/\|\| e\.action\}/.test(page), false, '작업 코드를 폴백으로 그리면 안 된다');
  assert.match(read('src/app/api/admin/audit/route.ts'), /actionLabel: auditActionLabel\(e\.action\)/, '작업 이름을 보내지 않는다');
});

test('감사 로그의 「내용」에 상태·경로 코드가 남지 않는다 (DS 22-3)', () => {
  const esc = read('src/app/api/admin/escalations/route.ts');
  assert.match(esc, /상태→\$\{STATUS_LABELS\[status\]\}/, '상태 코드가 그대로 기록된다');
  const par = read('src/app/api/admin/partners/route.ts');
  assert.equal(/경로 \$\{r\.account\.source\}/.test(par), false, '유입 경로 코드가 그대로 기록된다');
  assert.equal(/귀속 \$\{r\.account\.partnerId/.test(par), false, '파트너 식별자가 이름 대신 기록된다');
  assert.match(par, /LEAD_SOURCE_LABELS\[r\.account\.source\]/, '유입 경로를 이름으로 기록해야 한다');
  // 찾을 수 없는 귀속의 이름도 **한 벌**이다 (DS 56-1) — 종전에는 이 자리만 「알 수 없는 파트너」라고
  // 적었다(콘솔·정산·집계는 `missingPartnerName` 을 쓴다). 감사 로그는 영구히 남는 기록이고,
  // 그 말에는 어느 파트너인지조차 없었다.
  assert.equal(/'알 수 없는 파트너'/.test(par), false, '감사 로그가 찾을 수 없는 귀속을 다른 말로 적는다');
  assert.match(par, /\?\.name \?\? missingPartnerName\(r\.account\.partnerId\)/, '귀속은 파트너 이름으로 기록해야 한다');
});

test('이관 요약이 회신 창구(채널)를 지어내지 않는다 (DS 22-4)', () => {
  const chat = read('src/lib/chat.ts');
  assert.equal(/channel: 'web',/.test(chat), false, '요약 채널이 고정값이면 카카오 접수도 홈페이지라고 말한다');
  assert.match(chat, /channel: ctx\.channel \?\? 'web'/, '채널은 세션에서 읽어야 한다');
  assert.match(read('src/lib/session.ts'), /channel\?: 'web' \| 'kakao'/, '세션에 채널 필드가 없다');
  const kakao = read('src/app/api/kakao/webhook/route.ts');
  assert.match(kakao, /updateSession\(sessionId, \{ channel: 'kakao' \}\)/, '카카오 웹훅이 채널을 남기지 않는다');
  assert.match(read('src/app/api/escalation/route.ts'), /channel: ctx\.channel \?\? 'web'/, '접수 API 도 세션 채널을 따라야 한다');
});

test('내려받는 CSV 의 열 이름이 받는 사람의 말이다 (DS 22-3)', () => {
  const audit = read('src/lib/audit.ts');
  assert.equal(/'id,at,action/.test(audit), false, '변경 이력 CSV 열 이름이 영문이다');
  assert.match(audit, /csvRow\(\['번호', '시각', '작업', '작업코드', '대상', '내용', '인증', '시각\(ISO\)'\]\)/, '변경 이력 CSV 헤더');
  assert.match(audit, /auditActionLabel\(e\.action\),\n\s*e\.action,/, '작업은 이름과 코드를 함께 싣는다');
  // 표를 만드는 곳은 라우트가 아니라 lib 이다 — 라우트는 돌려 볼 수 없는 자리다(DS 40-1).
  const logs = read('src/lib/convlog.ts');
  assert.equal(/'intent', 'source'/.test(logs), false, '대화 기록 CSV 열 이름이 영문이다');
  assert.match(logs, /'주제', '근거'/, '대화 기록 CSV 헤더가 한국어가 아니다');
  assert.match(logs, /intentLabel\(l\.intent, intentLabels\)/, '주제를 이름으로 싣지 않는다');
  // 이름을 붙이는 자는 한 벌이고 **어떤 코드에도 코드를 되돌려주지 않는다** (DS 54-2).
  assert.match(logs, /sourceLabel\(l\.source\)/, '근거를 이름으로 싣지 않는다');
  assert.equal(/SOURCE_LABELS\[l\.source\] \?\? l\.source/.test(logs), false, '코드를 폴백으로 싣는 식이 남아 있다');
  assert.match(logs, /'주제코드'/, '다른 시스템으로 옮길 코드 열은 남겨 둔다');
});

/* ══════════ 디자인 스프린트 — 20차 재감사 (DS 23-1·23-2) ══════════ */

/**
 * DS 23-1 — 브라우저 `fetch` 에는 시간 제한이 없다.
 *
 * 요청을 보낸 뒤 신호가 끊기면(지하철·엘리베이터, 연결만 붙잡고 있는 중간 장비) 그 약속은 몇 분이
 * 지나도 지켜지지도 깨지지도 않는다. 그 사이 위젯은 `busy` 가 참이라 타이핑 점 3개를 계속 돌리고,
 * `sendText` 앞단의 `if (!text || busy) return` 때문에 **다시 보내기도 새 질문도 조용히 무시**한다 —
 * DS 5-5 가 만든 실패 안내·재전송 경로가 한 번도 실행되지 않는다(QUALITY_BAR §1·§3).
 */
test('위젯의 모든 요청에 기한이 있다 (DS 23-1)', () => {
  const s = read('src/components/ChatWidget.tsx');
  // 기한은 한 곳에서 만든다 — 요청마다 손으로 적으면 어느 하나는 빠진다.
  assert.match(s, /export async function postJson\(url: string, body: unknown, ms: number\)/, '기한을 가진 공용 요청 함수가 없다');
  assert.match(s, /new AbortController\(\)/, '기한이 지나도 요청을 끊지 못한다');
  assert.match(s, /setTimeout\(\(\) => ctl\.abort\(\), ms\)/, '기한 타이머가 없다');

  // 본문 읽기까지 같은 기한 안에 있어야 한다 — 헤더만 오고 본문이 멈추는 응답이 있다.
  // 보내는 쪽(postJson)과 되묻는 쪽(getJson · DS 50-1)이 **같은 규칙**을 지키는지 각각 본다.
  for (const [name, next] of [
    ['export async function postJson', 'export async function getJson'],
    ['export async function getJson', 'function isTimeout'],
  ]) {
    const helper = s.slice(s.indexOf(name), s.indexOf(next));
    assert.match(helper, /new AbortController\(\)/, `${name} 가 기한이 지나도 요청을 끊지 못한다`);
    assert.match(helper, /const data = await r\.json\(\)\.catch\(\(\) => null\)/, `${name} 가 본문을 기한 안에서 읽지 않거나, 파싱 실패로 안내까지 잃는다`);
    assert.equal(
      /clearTimeout/.test(helper.slice(0, helper.indexOf('const data'))),
      false,
      `${name} 이 응답이 오자마자 타이머를 지운다 — 본문 대기가 다시 무한이 된다`,
    );
  }

  // 위젯이 직접 fetch 를 부르는 자리는 그 두 함수 안뿐이다(= 기한 없는 요청 0건).
  assert.equal((s.match(/[^a-zA-Z]fetch\(/g) || []).length, 2, '기한을 거치지 않는 요청이 남아 있다');
  assert.match(s, /export async function getJson\(url: string, ms: number\)/, '되묻는 요청에 기한을 가진 공용 함수가 없다');
  assert.match(s, /getJson\(\s*`\/api\/escalation\?id=/, '접수 상태 되묻기가 기한을 거치지 않는다');
  for (const url of ['/api/chat', '/api/feedback', '/api/escalation']) {
    assert.match(s, new RegExp(`postJson\\(\\s*'${url}'`), `${url} 요청이 기한을 거치지 않는다`);
  }
  // 대화 요청은 서버의 LLM 예산(8초 × 재시도 1회)보다 길어야 한다 — 짧으면 올 답을 끊는다.
  assert.match(s, /export const CHAT_TIMEOUT_MS = 25_000/, '대화 응답 기한이 없다');
  assert.match(s, /export const POST_TIMEOUT_MS = 15_000/, '접수·평가 요청 기한이 없다');

  // 기한이 지나 우리가 끊은 것과 「연결이 느린 것」을 구분해 말한다.
  assert.match(s, /function isTimeout\(e: unknown\)/, '끊긴 요청을 구분하지 않는다');
  assert.match(s, /'AbortError'/, 'AbortError 를 구분하지 않으면 기다린 사람에게 엉뚱한 안내가 간다');
  const send = fnBody(s, 'async function sendText(');
  assert.match(send, /isTimeout\(e\)/, '대화 요청이 끊긴 사실을 구분하지 않는다');
  assert.match(send, /답변이 오지 않아 기다리기를 멈췄습니다/, '기다림을 멈춘 사실을 밝히지 않는다');
  assert.match(send, /failed: text,/, '끊긴 뒤 「다시 보내기」가 붙지 않으면 나오는 길이 없다');
  const handoff = fnBody(s, 'async function submitHandoff(');
  assert.match(handoff, /isTimeout\(e\)/, '접수도 기한이 지난 사실을 밝혀야 한다');
  assert.match(handoff, /접수 결과가 오지 않아 기다리기를 멈췄습니다/, '접수가 끊긴 사실을 밝히지 않는다');
});

/**
 * DS 23-2 — 콘솔도 같은 자리에 있었다.
 *
 * 불러오기가 끝나지 않으면 `phase` 가 `loading` 에 머물러 스켈레톤이 영구히 반짝이고(DS 4-2 의
 * 「다시 시도」는 `error` 일 때만 뜬다), 중복 실행 잠금(`claim`)이 `release` 를 만나지 못해
 * 그 탭에서는 같은 기능을 다시 누를 수조차 없다 — 새로고침 말고는 나오는 길이 없다.
 */
test('콘솔의 모든 요청이 기한을 거친다 (DS 23-2)', () => {
  const s = read('src/app/admin/page.tsx');
  assert.match(s, /function afetch\(input: string, init: RequestInit = \{\}, ms: number = REQUEST_TIMEOUT_MS\)/, '기한을 가진 공용 요청 함수가 없다');
  assert.match(s, /setTimeout\(\(\) => ctl\.abort\(\), ms\)/, '기한 타이머가 없다');
  // 응답이 왔다고 타이머를 지우지 않는다 — 본문(`json()`·`blob()`)을 읽는 동안에도 기한이 살아 있어야 한다.
  const helper = s.slice(s.indexOf('function afetch('), s.indexOf('function scrollBehavior'));
  assert.match(helper, /\.catch\(\(e\) => \{/, '실패한 요청의 타이머를 정리하지 않는다');
  assert.equal(/\.finally\(/.test(helper), false, '응답과 함께 타이머를 지우면 본문 대기가 다시 무한이 된다');

  // 화면이 직접 fetch 를 부르는 자리는 afetch 안의 두 곳(미지원 폴백·본체)뿐이다.
  assert.equal((s.match(/[^a-zA-Z]fetch\(/g) || []).length, 2, '기한을 거치지 않는 요청이 남아 있다');
  assert.ok((s.match(/await afetch\(/g) || []).length >= 25, '콘솔 요청 대부분이 기한을 거치지 않는다');

  // 「응답 테스트」만 기한이 길다 — 같은 `/api/chat` 을 부르는 위젯과 **같은 값**이어야 한다.
  assert.match(s, /const CHAT_TEST_TIMEOUT_MS = 25_000/, '응답 테스트 기한이 없다');
  assert.match(s, /const REQUEST_TIMEOUT_MS = 15_000/, '기본 요청 기한이 없다');
  assert.match(s, /CHAT_TEST_TIMEOUT_MS,\n\s*\);/, '응답 테스트가 긴 기한을 쓰지 않는다');
  const widget = read('src/components/ChatWidget.tsx');
  const pick = (src, name) => {
    const m = new RegExp(`${name} = ([\\d_]+)`).exec(src);
    assert.ok(m, `${name} 를 찾지 못했다`);
    return Number(m[1].replace(/_/g, ''));
  };
  assert.equal(pick(s, 'CHAT_TEST_TIMEOUT_MS'), pick(widget, 'CHAT_TIMEOUT_MS'), '같은 /api/chat 인데 화면마다 기한이 다르다');
  assert.equal(pick(s, 'REQUEST_TIMEOUT_MS'), pick(widget, 'POST_TIMEOUT_MS'), '짧은 요청의 기한이 화면마다 다르다');
});

/* ══════════ 디자인 스프린트 — 21차 재감사 (DS 24-1·24-2) ══════════ */

/**
 * DS 24-1 — 관리 콘솔의 화면은 **연 순간의 사진**이었다.
 *
 * 불러오기는 마운트 때 한 번뿐인데, 이 화면에서 가장 중요한 데이터(상담원 연결 요청)는 운영자가
 * 아니라 **고객이** 만든다. 고객은 「상담원이 확인 후 순서대로 연락드릴게요」라는 약속과 접수
 * 순번을 받고 기다리는데, 운영자 쪽 화면은 누군가 「새로고침」을 누르기 전까지 그 접수가 들어온
 * 사실조차 모른다 — 콘솔을 띄워 놓고 기다리는 것이 이 탭의 쓰임새인데 그 기다림이 헛돈다
 * (QUALITY_BAR §1 「핵심 흐름이 처음부터 끝까지 끊기지 않는다」).
 */
test('콘솔이 새 상담원 요청을 스스로 확인하고 알린다 (DS 24-1)', () => {
  const s = read('src/app/admin/page.tsx');

  // 되풀이 확인이 실제로 걸린다(간격은 한 곳에서 정한다).
  assert.match(s, /const OPS_POLL_MS = 30_000;/, '자동 확인 간격이 한 곳에 없다');
  assert.match(s, /setInterval\(tick, OPS_POLL_MS\)/, '자동 확인 타이머가 없다 — 화면이 연 순간에 멈춘다');
  // 보이는 동안에만 돈다 + 돌아오면 곧바로 한 번(30초를 더 기다리게 하지 않는다).
  assert.match(s, /function shouldPoll\(visibility: string, online: boolean, busy: boolean\)/, '쉴 때를 가리는 판정이 없다');
  assert.match(s, /addEventListener\('visibilitychange', wake\)/, '탭이 다시 보일 때 깨우지 않는다');
  assert.match(s, /addEventListener\('online', wake\)/, '연결이 돌아올 때 깨우지 않는다');
  // 떠날 때 치운다 — 타이머·리스너가 남으면 콘솔을 오래 쓸수록 요청이 겹쳐 늘어난다.
  assert.match(s, /clearInterval\(timer\)/, '타이머를 치우지 않는다');
  assert.equal((s.match(/removeEventListener\('visibilitychange', wake\)/g) || []).length, 1, 'visibilitychange 리스너가 남는다');
  assert.equal((s.match(/removeEventListener\('online', wake\)/g) || []).length, 1, 'online 리스너가 남는다');

  // 배경 확인은 화면을 「불러오는 중」으로 되돌리지 않는다 — 30초마다 스켈레톤이 끼어들면
  // 읽던 표가 사라진다. 그래서 loadEsc·loadAudit 는 quiet 를 받는다.
  assert.match(s, /const loadEsc = useCallback\(async \(quiet = false\) =>/, '배경 확인과 손으로 누른 새로고침을 구분하지 않는다');
  assert.match(s, /const loadAudit = useCallback\(async \(quiet = false\) =>/, '변경 이력도 같은 구분이 필요하다');
  assert.match(s, /if \(!quiet\) markPhase\('esc', 'loading'\);/, '배경 확인이 스켈레톤을 되돌린다');
  assert.match(s, /if \(!quiet\) markPhase\('audit', 'loading'\);/, '배경 확인이 스켈레톤을 되돌린다');

  // ⚠️ `onClick={loadEsc}` 처럼 **그대로** 넘기면 React 가 이벤트 객체를 첫 인자로 준다 —
  // 그 순간 손으로 누른 새로고침이 조용히 배경 모드가 되어 「불러오는 중」 표시가 사라진다.
  for (const name of ['loadEsc', 'loadAudit']) {
    assert.equal(new RegExp(`(onClick|onRetry)=\\{${name}\\}`).test(s), false, `${name} 를 그대로 넘기면 이벤트 객체가 quiet 로 들어간다`);
  }

  // 뒤늦게 도착한 옛 응답이 새 응답을 덮지 않는다(배경 확인 ↔ 상태 변경이 겹친다).
  assert.match(s, /const seq = \+\+escSeqRef\.current;/, '겹친 조회의 순서를 가리지 않는다');
  assert.match(s, /if \(seq !== escSeqRef\.current\) return;/, '옛 응답이 새 응답을 덮는다');

  // 어느 탭에 있든 대기 건수가 보인다 + 뜻은 스크린리더에도 전해진다(숫자만 읽히면 모른다).
  assert.match(s, /className="ac-navcount"/, '사이드바에 대기 건수 배지가 없다');
  assert.match(s, /대기 \$\{openCount\}건/, '배지의 뜻이 스크린리더에 전해지지 않는다');
  assert.match(s, /function newRequestNotice\(prev: number \| null, next: number\)/, '늘어난 때만 알리는 판정이 없다');
  const css = read('src/app/globals.css');
  const rule = (/\.ac-navcount\{([^}]*)\}/.exec(css) || [])[1];
  assert.ok(rule, '배지 모양이 없다');
  // 색은 토큰으로만 말한다(DS 6-2). 흰 글자(#fff)는 토큰 위에 얹는 전경색이라 예외다
  // — 「대기 중」 상태 pill 과 같은 --warn 을 써서 화면 안에서 같은 뜻이 같은 색이 되게 한다.
  assert.match(rule, /background:var\(--warn\)/, '배지 색이 「대기 중」 상태와 어긋난다');
  assert.deepEqual(rule.match(/#[0-9a-fA-F]{3,8}/g) || [], ['#fff'], '배지가 색 토큰을 우회한다(DS 6-2)');
});

/**
 * DS 24-2 — 운영자가 **방금 한 일**도 콘솔에 남지 않았다.
 *
 * 「변경 이력」은 이 콘솔이 하는 모든 일이 쌓이는 곳인데 마운트 때 한 번만 읽었다 — 자료를 고치고
 * 규칙을 바꾸고 접수 상태를 바꾼 뒤 열어도 그 기록이 하나도 없어 「안 남았나?」로 읽혔다.
 * 「응답 테스트」도 마찬가지다: 대시보드의 빈 상태가 「응답 테스트에서 대화하면 여기에 쌓입니다」
 * 라고 안내하고 버튼까지 두는데, 그대로 따라 해도 돌아온 화면이 똑같이 비어 있었다.
 */
test('콘솔에서 한 일이 그 콘솔에 바로 보인다 (DS 24-2)', () => {
  const s = read('src/app/admin/page.tsx');

  // 변경 이력 탭은 열 때마다 다시 읽는다(배경 모드라 스켈레톤이 끼어들지 않는다).
  assert.match(s, /if \(tab !== 'audit' \|\| !authInfo\?\.allowed\) return;\n\s*loadAudit\(true\);/, '변경 이력이 탭을 열 때 갱신되지 않는다');

  // 응답 테스트로 주고받은 말도 대화 기록이 된다 — 답이 **실제로 왔을 때만** 다시 읽는다
  // (끊긴 요청에 우리가 만들어 넣은 안내 문구를 서버 응답으로 착각하면 안 된다).
  const runTest = fnBody(s, 'const runTest = async () =>');
  assert.match(runTest, /let answered = false;/, '답이 실제로 왔는지 구분하지 않는다');
  assert.match(runTest, /answered = true;/, '응답을 받은 사실을 남기지 않는다');
  assert.match(runTest, /if \(answered\) loadEsc\(true\);/, '시험 대화가 대시보드·최근 대화에 반영되지 않는다');
  // 빈 상태가 가리키는 길과 실제 동작이 같은지 — 안내 문구가 거짓이 되지 않게 함께 고정한다.
  assert.ok(s.includes('「응답 테스트」에서 대화하면 여기에 쌓입니다'), '대시보드 빈 상태의 안내가 바뀌었다');
});

/**
 * DS 24-3 — 고객 쪽에도 같은 자리가 있었다: 상담창을 **열어 둔 채** 자리를 비운 사람.
 *
 * 서버는 30분 뒤 대화 문맥을 지운다. 페이지를 옮기면 복원 관문(`loadThread`, DS 7-1)이 그 사실을
 * 보고 새로 시작하지만, 창을 그대로 둔 사람은 그 관문을 지나지 않는다 — 화면에는 「예약 접수 ·
 * 성함을 알려주세요」 카드가 그대로 떠 있는데 보낸 「홍길동」은 폼의 답이 아니라 새 질문이 된다.
 */
test('한동안 비워 둔 대화를 먼저 밝힌다 (DS 24-3)', () => {
  const s = read('src/components/ChatWidget.tsx');
  assert.match(s, /export function threadExpired\(lastAt: number, now: number\)/, '문맥이 사라졌는지 가리는 판정이 없다');
  assert.match(s, /export function lastTurnAt\(msgs: Msg\[\]\)/, '마지막 주고받음 시각을 화면의 대화에서 찾지 않는다');

  // 판정은 복원 관문과 **같은 값**을 쓴다 — 두 곳이 갈라지면 한쪽만 만료로 본다.
  const ttl = /export const THREAD_TTL_MS = ([^;]+);/.exec(s);
  assert.ok(ttl, 'THREAD_TTL_MS 를 찾지 못했다');
  const session = read('src/lib/session.ts');
  assert.match(session, /const TTL_MS = 30 \* 60 \* 1000;/, '서버 세션 TTL 이 바뀌었다 — 위젯 판정도 함께 맞춰야 한다');
  assert.equal(ttl[1].trim(), '30 * 60 * 1000', '위젯이 서버 세션 TTL 과 다른 값으로 판정한다');

  // 보내기 전에 밝힌다 — 답이 돌아온 뒤에 설명하면 이미 엉뚱한 안내를 읽은 뒤다.
  const send = fnBody(s, 'async function sendText(');
  const guard = send.indexOf('threadExpired(');
  const call = send.indexOf("postJson(\n");
  assert.ok(guard > 0, '전송 경로가 만료를 보지 않는다');
  assert.ok(call > guard, '답을 받은 뒤에야 만료를 밝힌다');
  // 누를 수 없게 된 카드(진행 중 폼·번호 제안)를 거둔다 — 남겨 두면 다시 눌러 같은 일이 되풀이된다.
  assert.match(send, /form: undefined, suggestions: undefined/, '사라진 문맥의 카드를 화면에 남긴다');
  // 안내는 사람 말로. 내부 용어(세션·TTL·문맥)를 손님에게 쓰지 않는다(DS 2-7).
  const notice = /pushBot\(\{ text: '(한동안[^']+)' \}\)/.exec(send);
  assert.ok(notice, '만료를 알리는 말풍선이 없다');
  for (const bad of ['세션', 'TTL', '문맥', '서버']) {
    assert.equal(notice[1].includes(bad), false, `손님에게 내부 용어를 쓴다: ${bad}`);
  }
});


/* ══════════ 26순위 — 백로그 소진 후 23차 재감사 (DS 26-x) ══════════ */

/** 최상위 함수 하나를 소스에서 그대로 떼어낸다(닫는 중괄호가 1열에 있는 선언 기준). */
function topFn(src, decl) {
  const i = src.indexOf(decl);
  assert.ok(i >= 0, `${decl} 선언을 찾지 못했다`);
  const end = src.indexOf('\n}', i);
  assert.ok(end > i, `${decl} 의 끝을 찾지 못했다`);
  return src.slice(i, end + 2);
}

/**
 * DS 26-1·26-2 — 같은 일을 하는 두 사본이 갈라지지 않는가.
 *
 * 위젯과 관리 콘솔은 서로를 불러오지 않는다(각각 다른 클라이언트 번들이고, 콘솔은 lib 을 쓰지
 * 않는다 — `MAX_DOC_CHARS`·`kstMonthNow`·`REQUEST_TIMEOUT_MS` 와 같은 기존 규약이다).
 * 그래서 「뒤 화면 잠금」과 「넘침 측정」은 두 파일에 사본으로 있다 — 글자까지 대조해 둔다.
 * 종전에 위젯 쪽 잠금은 스크롤 위치를 되돌리지 않고 스크롤바 폭도 메우지 않았다(같은 일을
 * 두 화면이 다르게 하고 있었다). 동작 자체는 콘솔 테스트가 가짜 창 위에서 실제로 돌려 본다.
 */
test('뒤 화면 잠금·넘침 측정이 위젯과 콘솔에서 같은 사본이다 (DS 26-1·26-2)', () => {
  const widget = read('src/components/ChatWidget.tsx');
  const console_ = read('src/app/admin/page.tsx');
  for (const decl of ['function lockPageScroll(', 'function overflowsY(', 'function useScrollableY<']) {
    assert.equal(topFn(widget, decl), topFn(console_, decl), `사본이 갈라졌다: ${decl}`);
  }
  // 뒤 화면의 스타일을 만지는 자리는 이 함수 안뿐이어야 한다 — 밖에서 만지면 잠금이 어긋난다.
  for (const [name, s] of [['위젯', widget], ['콘솔', console_]]) {
    const lock = topFn(s, 'function lockPageScroll(');
    const outside = s.replace(lock, '');
    assert.equal(/body\.style/.test(outside), false, `${name}이 잠금 밖에서 뒤 화면 스타일을 만진다`);
    // 풀 때는 **열 때의 값**으로 되돌린다 — 지우면(빈 문자열) 호스트 페이지의 설정을 뺏는다.
    assert.match(lock, /const prevOverflow = body\.style\.overflow;/, `${name}: 원래 값을 기억하지 않는다`);
    assert.match(lock, /win\.scrollTo\(0, y\);/, `${name}: 읽던 자리로 되돌리지 않는다`);
  }
  // 고객사 사이트(호스트 문서)는 embed.js 가 같은 규칙으로 잠근다 — 이쪽은 계약이라 그대로 둔다.
  assert.match(read('public/embed.js'), /function lockHost\(on\)/, '호스트 스크롤 잠금이 사라졌다');
});

/* ══════════ 29순위 — 백로그 소진 후 26차 재감사 (DS 29-x) ══════════ */

/** 문자열 리터럴 안의 `${…}` 를 걷어낸다(식은 화면에 뜨는 글자가 아니다). */
function litText(raw) {
  return raw.replace(/\$\{[^{}]*\}/g, '');
}

/**
 * DS 29-3 — 서버가 거절하며 적어 보낸 문장은 **그대로 화면에 뜬다**.
 * 콘솔은 `data.message || data.error` 를 토스트·인라인 오류로 옮겨 적고, 위젯도 같은 본문을
 * 읽는다. 그런데 「화면 문자열에 내부 문구 0건」 검사(DS 2-8)는 JSX 만 훑기 때문에 이 자리가
 * 사각이었다 — 운영자는 「reply는 1000자 이하여야 합니다」·「잘못된 상태값입니다(허용: open, …)」
 * 를, 고객은 「방문 희망일을(를) 입력해 주세요」를 보고 있었다.
 */
test('거절 문장에 코드 어휘가 없다 — 서버가 쓰는 문장도 화면 문구다 (DS 29-3)', () => {
  const files = [
    'src/lib/http.ts', 'src/lib/refusal.ts', 'src/lib/adminStore.ts', 'src/lib/audit.ts',
    'src/lib/convlog.ts', 'src/lib/escalation.ts', 'src/lib/partners.ts', 'src/lib/settlement.ts',
    'src/lib/feedback.ts', 'src/lib/knowledge.ts',
    'src/app/api/admin/auth/route.ts', 'src/app/api/admin/kb/route.ts', 'src/app/api/admin/kb/import/route.ts',
    'src/app/api/admin/rules/route.ts', 'src/app/api/admin/partners/route.ts',
    'src/app/api/admin/escalations/route.ts', 'src/app/api/admin/settlement/route.ts',
    'src/app/api/admin/backup/route.ts', 'src/app/api/chat/route.ts', 'src/app/api/escalation/route.ts',
    'src/app/api/feedback/route.ts',
  ].filter(has);
  assert.ok(files.length >= 20, '검사 대상 파일이 사라졌다');

  // 화면 이름이 되어도 좋은 영문 약어(제품에서 그대로 부르는 말).
  const OK_WORDS = new Set(['CSV', 'URL', 'AI', 'GOWON']);
  // 쓰면 안 되는 한국어 — 코드 구조를 그대로 옮긴 말.
  const BANNED_KO = ['배열', '객체', '파싱', '티켓', '상태값', '네임스페이스', '스냅샷'];

  for (const f of files) {
    const src = stripComments(read(f));
    // ① `fail('code', '<문장>')` 의 둘째 인자 ② 객체의 `error: '<문장>'` ③ 거절 문장 상수·사전
    const found = [
      ...src.matchAll(/fail\(\s*'[a-z_]+'\s*,\s*(?:'([^']*)'|`([^`]*)`)/g),
      ...src.matchAll(/\berror:\s*(?:'([^']*)'|`([^`]*)`)/g),
      ...src.matchAll(/\breason\s*=\s*(?:'([^']*)'|`([^`]*)`)/g), // 로그인 화면이 그대로 그리는 사유

      ...src.matchAll(/^\s*(?:export const )?[A-Z_]*MESSAGE[A-Z_]*\s*=\s*(?:'([^']*)'|`([^`]*)`)/gm),
      ...src.matchAll(/^\s{2}[a-z_]+:\s*'([^']*)'/gm), // DEFAULT_MESSAGE 사전
    ].map((m) => litText(m[1] ?? m[2] ?? ''));

    for (const msg of found) {
      if (!/[가-힣]/.test(msg)) continue; // 코드 식별자(에러 코드 등)는 문장이 아니다
      for (const word of msg.match(/[A-Za-z_]{2,}/g) || []) {
        assert.ok(OK_WORDS.has(word), `${f}: 거절 문장에 코드 어휘 「${word}」 — ${msg}`);
      }
      for (const ko of BANNED_KO) {
        assert.equal(msg.includes(ko), false, `${f}: 거절 문장에 내부 어휘 「${ko}」 — ${msg}`);
      }
      // 형식 토큰·내부 단위도 화면 말이 아니다(DS 2-12 가 걷어낸 bp, DS 21 의 YYYY-MM).
      assert.equal(/YYYY|MM-DD|\bbp\b/.test(msg), false, `${f}: 거절 문장에 형식·단위 토큰 — ${msg}`);
    }
  }
});

test('화면에 뜨는 말에 괄호 조사가 없다 (DS 29-3)', () => {
  for (const f of ['src/lib/slots.ts', 'src/lib/chat.ts', 'src/app/admin/page.tsx', 'src/components/ChatWidget.tsx', 'src/app/page.tsx']) {
    const s = read(f);
    assert.equal(/을\(를\)|이\(가\)|은\(는\)|와\(과\)/.test(stripComments(s)), false, `${f}: 괄호 조사가 화면에 보인다`);
  }
  // 조사 판정은 한 곳에서만 만든다 — 콘솔은 lib 을 불러오지 않으므로 사본이고, 두 사본이
  // 같은 규칙인지 글자로 대조한다(DS 26-1 과 같은 방식).
  const lib = read('src/lib/refusal.ts');
  const console_ = read('src/app/admin/page.tsx');
  for (const s of [lib, console_]) {
    assert.match(s, /0xac00/, '받침 판정이 한글 음절 범위를 쓰지 않는다');
    assert.match(s, /% 28;/, '받침 판정식이 바뀌었다');
    // ㄹ 받침은 따로 가른다 — 「으로」 짝에서만 받침 없는 쪽이다(DS 61-1).
    assert.match(s, /jong === 0 \? 'none' : jong === 8 \? 'rieul' : 'other'/, 'ㄹ 받침을 따로 가르지 않는다');
  }
  assert.match(console_, /원본은 `src\/lib\/refusal\.ts`\(josa\)/, '사본임을 밝히지 않으면 다음 사람이 따로 고친다');
});

/**
 * DS 29-1 — 거절은 **그 칸에서** 해야 한다.
 * 이유를 칸 아래에 적어 두기만 하면 ① 스티키 폼이 자기 상자 안에서 스크롤되므로(DS 26-3)
 * 위쪽 칸의 오류가 눈에 보이지 않고 ② `aria-invalid`·`aria-describedby` 는 초점이 닿을 때만
 * 읽히므로 스크린리더는 **거절당한 줄도 모른다**. 위젯 접수 카드는 처음부터 초점을 옮기고
 * 있었는데(`contactRef`) 콘솔 폼 4곳은 그렇지 않았다 — 같은 일을 두 화면이 다르게 했다.
 */
test('폼이 거절하면 틀린 칸으로 데려간다 (DS 29-1)', () => {
  const s = read('src/app/admin/page.tsx');
  const bare = stripComments(s);

  // 판정·이동을 각각 한 곳에서만 만든다.
  assert.equal((bare.match(/function firstErrorId\(/g) || []).length, 1, 'firstErrorId 선언이 하나가 아니다');
  assert.equal((bare.match(/function focusErrorField\(/g) || []).length, 1, 'focusErrorField 선언이 하나가 아니다');

  // 거절하는 폼 5곳이 모두 그 문을 지난다(한 곳만 빠져도 그 폼은 조용히 거절한다).
  const orders = ['IMP_FIELD_ORDER', 'KB_FIELD_ORDER', 'CR_FIELD_ORDER', 'ACCOUNT_FIELD_ORDER', 'PARTNER_FIELD_ORDER'];
  for (const o of orders) {
    assert.ok(bare.includes(`focusErrorField(firstErrorId(errs, ${o}))`), `${o} 를 쓰는 거절 경로가 없다`);
    assert.match(bare, new RegExp(`const ${o} = \\[`), `${o} 선언이 없다`);
  }
  assert.equal((bare.match(/focusErrorField\(firstErrorId\(/g) || []).length, orders.length, '거절 경로 수가 폼 수와 다르다');

  // 순서는 「화면에 그려진 순서」여야 한다 — 아래쪽 칸으로 데려가면 위에 남은 오류를 지나친다.
  for (const [order, ids] of [
    ['KB_FIELD_ORDER', ['kb-question', 'kb-keywords', 'kb-answer']],
    ['CR_FIELD_ORDER', ['cr-label', 'cr-keywords', 'cr-reply']],
    ['ACCOUNT_FIELD_ORDER', ['a-name', 'a-partner', 'a-date', 'a-fee']],
  ]) {
    const decl = bare.slice(bare.indexOf(`const ${order} = [`));
    const line = decl.slice(0, decl.indexOf('\n'));
    let at = -1;
    for (const id of ids) {
      const next = line.indexOf(`'${id}'`);
      assert.ok(next > at, `${order}: ${id} 가 화면 순서와 어긋난다`);
      at = next;
    }
    // 가리키는 id 가 실제로 그 화면에 있어야 한다(없으면 초점이 아무 데도 가지 않는다).
    for (const id of ids) assert.match(s, new RegExp(`id="${id}"`), `${id} 칸이 화면에 없다`);
  }

  // 키워드는 새 자료의 필수 항목이다 — 종전에는 서버만 알고 있어 토스트로 거절당했다.
  assert.match(bare, /errs\.keywords = '고객이 쓸 표현을 한 개 이상/, '키워드 거절을 화면이 먼저 말하지 않는다');
  assert.match(bare, /aria-describedby=\{kbErr\.keywords \? 'kb-keywords-err' : undefined\}/, '키워드 오류가 칸과 묶여 읽히지 않는다');

  // 기본 규칙 답변은 서버 상한을 화면이 먼저 막는다(칸을 벗어난 뒤 토스트로 거절당하지 않게).
  // 수는 `lib/limits` 에 있다 (DS 74-3) — `lib/adminStore` 는 종전 이름으로 그대로 내보낸다.
  assert.match(read('src/lib/adminStore.ts'), /export const MAX_RULE_REPLY_LEN = RULE_REPLY_LEN;/, '답변 상한이 단일 출처를 보지 않는다');
  const max = /export const RULE_REPLY_LEN = (\d+);/.exec(read('src/lib/limits.ts'));
  assert.ok(max, '서버의 답변 상한을 찾지 못했다');
  assert.match(s, new RegExp(`const MAX_RULE_REPLY_LEN = ${max[1]};`), '답변 상한이 서버와 다르다');
  assert.match(bare, /maxLength=\{MAX_RULE_REPLY_LEN\}/, '인라인 답변 편집에 상한이 없다');
});

/**
 * DS 29-2 — 실패를 성공과 같은 모양·같은 2.5초로 말하면, 저장을 누른 뒤 표를 보던 운영자는
 * 실패한 줄 모르고 다음 일을 한다. 게다가 앞의 안내가 걸어 둔 타이머를 거두지 않아
 * **두 번째 안내가 0.5초만 뜨는** 자리가 있었다(2.5초 안에 두 번 일어난 경우).
 */
test('실패는 성공과 다른 통로로 알린다 (DS 29-2)', () => {
  const s = read('src/app/admin/page.tsx');
  const bare = stripComments(s);

  // 알림을 띄우는 문은 하나다 — 타이머를 거두는 자리가 거기뿐이어야 어긋나지 않는다.
  assert.equal((bare.match(/const notify = \(/g) || []).length, 1, 'notify 선언이 하나가 아니다');
  const notify = topFn(bare.replace('const notify = (', 'function notify('), 'function notify(');
  assert.match(notify, /window\.clearTimeout\(noticeTimer\.current\)/, '앞의 안내 타이머를 거두지 않는다');
  assert.match(notify, /if \(kind === 'ok'\) noticeTimer\.current = window\.setTimeout/, '실패가 스스로 사라진다');
  assert.match(notify, /noticeSeq\.current \+= 1/, '같은 문장이 연달아 오면 다시 읽히지 않는다');

  // 실패만 `role="alert"` — 읽던 것을 끊고 먼저 읽는다. 성공은 그대로 polite 다.
  assert.match(bare, /role=\{notice\.kind === 'fail' \? 'alert' : 'status'\}/, '실패 알림의 역할이 성공과 같다');
  assert.match(bare, /aria-live=\{notice\.kind === 'fail' \? 'assertive' : 'polite'\}/, '실패를 나중에 읽는다');
  // 색만으로 구분하지 않는다 — 아이콘과 머무는 「닫기」가 함께 있어야 한다.
  assert.match(bare, /className="ac-toast-icon"/, '실패 아이콘이 없다');
  assert.match(bare, /aria-label="알림 닫기"/, '머무는 알림을 치울 수단이 없다');
  assert.match(bare, /onClick=\{dismissNotice\}/, '닫기가 알림을 치우지 않는다');

  // 실패 문구가 성공 통로(flash)로 새어 나가지 않는다.
  for (const m of bare.match(/flash\(`?'?[^\n]*?\)/g) || []) {
    assert.equal(/하지 못했|오류로|없습니다\./.test(m), false, `실패를 성공 통로로 알린다: ${m}`);
  }
  assert.match(bare, /const failed = \([\s\S]{0,200}notify\([\s\S]{0,80}'fail'\)/, '실패 공통 통로가 notify 를 쓰지 않는다');

  // 머무는 알림에 모양이 있어야 성공과 구분된다(색은 토큰에서만 — DS 11-2).
  const css = read('src/app/globals.css');
  assert.match(css, /\.ac-toast-fail\{background:var\(--danger\)/, '실패 알림 색이 토큰을 우회했거나 없다');
  assert.match(css, /\.ac-toast-fail\{border:2px solid ButtonText\}/, '고대비 모드에서 실패 알림이 성공과 같아진다');
});

/* ══════════ 30순위 — 백로그 소진 후 27차 재감사 (DS 30-x) ══════════ */

/**
 * DS 30-1·30-2 — 「지금보다 앞인가」를 재는 자리는 한국 시간 하나를 봐야 한다(DS 21 이 세운 규약).
 * 들고 있는 반쪽을 비우는 자리가 늘어나면 다른 항목에 지난 시각이 따라붙으므로 개수를 고정한다.
 */
test('예약 일시는 한국 시간으로 앞뒤를 재고, 반쪽을 비우는 자리가 셋이다 (DS 30-1·30-2)', () => {
  const s = read('src/lib/slots.ts');
  const bare = stripComments(s);

  // 시각 비교도 달력과 같은 출처(@/lib/kst)에서 온다 — `new Date().getHours()` 는 서버 시간대다.
  assert.match(bare, /import \{[^}]*kstTime[^}]*\} from '@\/lib\/kst'/, '한국 시각을 kst 에서 받지 않는다');
  assert.equal(/getHours\(\)|getMinutes\(\)/.test(bare), false, '기계 시간대로 시각을 읽는 자리가 있다');
  const past = topFn(bare, 'function isPastKst(');
  assert.match(past, /ymdToString\(kstYmd\(now\)\)/, '오늘을 한국 달력으로 세지 않는다');
  assert.match(past, /time < kstTime\(now\)/, '같은 날의 지난 시각을 가려내지 않는다');

  // 반쪽은 돌려주고(1곳), 비우는 자리는 「이전」·확정·완료 셋뿐이다.
  assert.equal((bare.match(/partial: res\.parts/g) || []).length, 1, '반쪽을 들고 있는 자리가 하나가 아니다');
  assert.equal((bare.match(/partial: undefined/g) || []).length, 3, '반쪽을 비우는 자리가 셋이 아니다');

  // 반쪽만으로는 확정하지 않는다 — 두 거절은 각각 모르는 쪽만 묻는다.
  assert.match(bare, /parts: \{ date, time: null \}[\s\S]{0,80}몇 시가 좋을까요/, '날짜만 받고 넘어간다');
  assert.match(bare, /parts: \{ date: null, time \}[\s\S]{0,80}며칠이 좋을까요/, '시간만 받고 넘어간다');
  // 파서는 반쪽 표기를 그대로 둔다(판단은 검증 쪽 몫 — 다른 호출자의 계약을 바꾸지 않는다).
  assert.match(bare, /export function parseDateTimeParts\(/, '반쪽 파서가 없다');
  assert.match(bare, /\(시간 미정\)/, '파서의 반쪽 표기가 사라졌다');

  // 고객에게 되읽어 주는 말에 형식 토큰·영문이 없다(DS 29-3 과 같은 규칙).
  for (const fn of ['function dateWords(', 'function timeWords(']) {
    const body = topFn(bare, fn);
    assert.equal(/YYYY|[A-Z]{2,}/.test(body.split('\n').slice(1).join('\n')), false, `${fn}: 형식 토큰이 화면에 나간다`);
  }
});

/**
 * DS 30-3 — 아직 오지 않은 달을 고르면 계약 중인 고객사가 전부 걸려 **일어나지 않은 달의
 * 수수료 합계**가 확정 수치처럼 떴다(§13 가짜 수치 금지 · 이 파일 첫 원칙 「없는 숫자를 만들지
 * 않는다」). 화면이 먼저 막고 서버가 거절한다 — 두 값이 갈라지지 않게 함께 고정한다.
 */
test('정산은 아직 오지 않은 달을 산출하지 않는다 (DS 30-3)', () => {
  const lib = stripComments(read('src/lib/settlement.ts'));
  const page = read('src/app/admin/page.tsx');

  // 서버: 형식 검사 바로 뒤에 「이번 달까지」 관문이 있고, 기준은 한국 시간이다.
  assert.match(lib, /const now = currentMonth\(input\.at \?\? new Date\(\)\);\s*if \(month > now\)/, '미래 달 관문이 없다');
  assert.match(lib, /아직 오지 않은 달은 산출할 수 없습니다\./, '거절 문장이 바뀌었다');
  assert.match(lib, /\$\{monthWords\(now\)\}까지 고를 수 있습니다\./, '어디까지 고를 수 있는지 말하지 않는다');
  assert.equal(/YYYY-MM|\bbp\b/.test('아직 오지 않은 달은 산출할 수 없습니다.'), false);
  assert.match(lib, /function monthWords\(/, '달을 사람 말로 적는 자리가 없다');

  // 화면: 달 고르개가 아직 오지 않은 달을 내주지 않고, 주소로 들어온 값도 이번 달로 끌어온다.
  assert.match(page, /max=\{kstMonthNow\(\)\}/, '기준월 고르개에 상한이 없다');
  assert.match(page, /const asked = MONTH_RE\.test\(m\) \? m : settleCond\.current\.month;/, '주소 값 검사가 바뀌었다');
  assert.match(page, /const month = asked > thisMonth \? thisMonth : asked;/, '주소로는 미래 달을 열 수 있다');
});

/* ══════════ 디자인 스프린트 — 32차 재감사 (DS 35-3) ══════════ */

/**
 * DS 35-3 — 위젯 카드가 연락처 질문을 끝냈는데 서버는 계속 묻고 있었다.
 * 「정말 그렇게 되는가」는 `tests/runtime.test.mjs` 가 돌려서 본다 — 여기서는 그 고침이
 * 접수 API 의 **세션 갱신 한 자리**에 있는지를 고정한다(라우트는 next 의존 때문에 컴파일 대상이
 * 아니다). 연락처를 남겼든 남기지 않기로 했든 카드가 그 질문을 끝냈으므로, 조건 없이 거둔다.
 */
test('접수 API 가 연락처를 묻는 상태를 거둔다 (DS 35-3)', () => {
  const route = read('src/app/api/escalation/route.ts');
  const post = route.slice(route.indexOf('export async function POST('), route.indexOf('export async function GET('));
  assert.match(post, /awaitingContact: false,/, '카드가 끝낸 질문을 대화창이 다시 묻는다');
  // 연락처를 남긴 경우에만 거두면, 「연락처 없이 접수」를 누른 사람의 다음 질문이 그대로 삼켜진다.
  assert.equal(/contact\.value \? \{ awaitingContact/.test(post), false, '선택에 따라 거두는 쪽이 갈린다');
  // 세션 식별자는 창구가 발급할 수도 있는 값이 되었다(DS 51-2) — 변수 이름만 옮겨 적는다.
  const upd = post.slice(post.indexOf('updateSession(sessionId, {'));
  assert.match(upd.slice(0, upd.indexOf('});')), /ticketId: ticket\.id/, '세션 갱신이 한자리에 모여 있지 않다');
});

/* ══════════ 디자인 스프린트 — 33차 재감사 (DS 36-1·36-2·36-3) ══════════ */

/**
 * DS 36-1·36-2 — 「어느 고객사의 손님인가」를 **적고 지나가는 자리가 하나도 빠지지 않는가.**
 *
 * 대화를 적는 곳이 둘(웹·카카오), 접수를 만드는 곳이 일곱이다. 한 곳이라도 비워 두면 그 경로로
 * 들어온 손님만 운영 화면에서 「기본 구성」으로 보인다 — 같은 종류의 누락이 DS 22-x(사전에
 * 없는 코드)와 DS 29-3(검증만 하고 화면에 전하지 않기)에서 이미 두 번 일어났다.
 * 타입으로 막아 두고(필수 필드), 그 필수성이 선택으로 풀리지 않는지를 여기서 고정한다.
 */
test('대화·접수를 적는 모든 자리가 고객사를 함께 적는다 (DS 36-1·36-2)', () => {
  // ① 타입이 비워 두는 것을 막는다 — 선택 항목이 되면 새로 생긴 경로가 조용히 빠진다.
  assert.match(read('src/lib/convlog.ts'), /\n  tenant: string \| null;/, '대화 기록의 고객사가 필수가 아니다');
  assert.match(read('src/lib/escalation.ts'), /\n  tenant: string \| null;/, '접수 입력의 고객사가 필수가 아니다');

  // ② 실제 호출 자리가 모두 적고 지나간다(엔진 6곳 + 접수 API 1곳 · 대화 기록 2곳).
  const withTenant = (file, fn) => {
    const s = read(file);
    const calls = [...s.matchAll(new RegExp(`${fn}\\(\\{`, 'g'))];
    for (const m of calls) {
      const body = s.slice(m.index, m.index + 700);
      const upTo = body.slice(0, body.indexOf('});') >= 0 ? body.indexOf('});') : body.length);
      assert.match(upTo, /tenant[:,]/, `${file} 의 ${fn} 한 자리가 고객사를 적지 않는다`);
    }
    return calls.length;
  };
  // 엔진의 접수 자리는 여섯이다(DS 37-1 이 「접수 뒤 연락처만 보낸 경우」를 더했다).
  assert.equal(withTenant('src/lib/chat.ts', 'createTicket'), 6, '엔진의 접수 자리 수가 바뀌었다 — 새 자리를 확인하라');
  // 한 줄로 쓴 자리(연락처 첨부)는 글자까지 고정한다 — 거기서 빠지면 세 경로 중 하나만 어긋난다.
  assert.match(read('src/lib/chat.ts'), /createTicket\(\{ sessionId, tenant: tenantOf\(sessionId\), contact/, '연락처 첨부 접수가 고객사를 적지 않는다');
  assert.equal(withTenant('src/app/api/escalation/route.ts', 'createTicket'), 1);
  assert.equal(withTenant('src/app/api/chat/route.ts', 'logTurn'), 1);
  assert.equal(withTenant('src/app/api/kakao/webhook/route.ts', 'logTurn'), 1);

  // ③ 요청에 실려 온 문자열을 그대로 적지 않는다 — 등록되지 않은 값이면 엔진은 기본 자료로
  //    답하므로, 그대로 적으면 기록이 답한 근거와 어긋난다.
  assert.match(read('src/app/api/chat/route.ts'), /tenant: resolvedTenantId\(tenantId\)/, '해석하지 않은 값을 기록한다');
  assert.equal(/tenant: tenantId[,\n]/.test(read('src/app/api/chat/route.ts')), false, '요청 값을 그대로 적는 자리가 남았다');

  // ④ 접수 API 는 고객사를 **세션에서** 읽는다(고객이 보낸 값을 믿지 않는다 — 운영자 화면과
  //    이관 요약에 그대로 그려지는 값이다). 위젯 계약은 늘리지 않는다.
  const esc = read('src/app/api/escalation/route.ts');
  assert.match(esc, /const tenant = ctx\.tenantId \?\? null;/, '접수가 고객사를 세션에서 읽지 않는다');
  assert.equal(/parsed\.data\.tenant/.test(esc), false, '접수 API 가 고객이 보낸 고객사 값을 받는다');

  // ⑤ 이관 요약은 **이름**을 받는다 — 요약 모듈은 테넌트 어휘를 모른다(`intentLabels` 와 같은 규칙).
  const handoff = read('src/lib/handoff.ts');
  assert.match(handoff, /if \(s\.tenantLabelKo\) L\.push\(`고객사: \$\{s\.tenantLabelKo\}`\)/, '요약 평문에 고객사 줄이 없다');
  assert.equal(/@\/lib\/tenants/.test(handoff), false, '요약 모듈이 테넌트 어휘를 직접 알게 됐다');
});

/* ══════════ 디자인 스프린트 — 34차 재감사 (DS 37-1·37-2·37-3) ══════════ */

/**
 * DS 37-1 — 연락처를 **다시 물을지**는 「이 접수에 회신할 곳이 남아 있는가」로 가른다.
 * 「정말 그렇게 동작하는가」는 `tests/runtime.test.mjs` 가 돌려서 본다 — 여기서는 접수 안내를
 * 하는 **두 자리 모두**가 그 판정을 거치는지, 조건 없이 켜는 자리가 남지 않았는지를 고정한다.
 */
test('접수 안내가 조건 없이 연락처를 묻지 않는다 (DS 37-1)', () => {
  const s = read('src/lib/chat.ts');
  const asks = [...s.matchAll(/awaitingContact: !ticket\.contact,/g)];
  assert.equal(asks.length, 2, '규칙 전환·자동 전환 두 자리가 같은 판정을 쓰지 않는다');
  assert.equal(/awaitingContact: true,/.test(s), false, '조건 없이 연락처를 묻는 자리가 남았다');
  // 판정값은 세션 슬롯이 아니라 **접수에 붙어 있는 값**이다(완료 후 파기된 접수는 다시 물어야 한다).
  assert.match(s, /function contactTail\(ticket: \{ contact\?: string \}, ask: string\)/, '연락처 문구의 단일 출처가 없다');
  assert.match(s, /maskPii\(ticket\.contact\)\.text/, '연락처 원문을 그대로 되돌려 적는다');
  // 묻지 않는 대신 열어 둔 길 — **보낸 것이 연락처뿐일 때만** 받는다(문장에 섞인 번호는 DS 35-3).
  assert.match(s, /export function isOnlyContact/, '연락처만 보낸 경우를 가르는 함수가 없다');
  // 가르는 자는 `pii.takeContactOnly` 한 곳이고(DS 70-3), 그 길은 **열린 접수가 있을 때만** 선다.
  assert.match(s, /return takeContactOnly\(text\)\.kind !== null;/, '연락처만 보낸 경우를 제 식으로 가른다');
  assert.match(s, /const only = openTicketId \? takeContactOnly\(text\) : null;/, '접수 뒤 연락처 변경 경로가 없다');
  // 새 인텐트에도 이름이 있어야 운영자 화면에 코드가 뜨지 않는다(DS 22-x).
  assert.match(read('src/lib/intents.ts'), /contact_updated: '연락처 변경'/, '새 인텐트에 이름이 없다');
});

/**
 * DS 37-2·37-3 — 카카오는 **어댑터 한 함수가 화면 전체**다.
 * 접수한 사실은 세션이 알고 있으므로 라우트가 그 값을 어댑터에 전해야 하고(37-2),
 * 말풍선 상한은 「잘라서 숨기기」가 아니라 「나눠 담고, 그래도 넘치면 말하기」로 다룬다(37-3).
 */
test('카카오 어댑터가 접수 사실을 받고 상한을 규격대로 다룬다 (DS 37-2·37-3)', () => {
  const route = read('src/app/api/kakao/webhook/route.ts');
  // 번호만이 아니라 **지금 모습**을 전한다(DS 51-3) — 가리키는 식만 옮겼고 뜻은 그대로다.
  assert.match(route, /const filedId = getSession\(sessionId\)\.ticketId;/, '라우트가 접수한 사실을 어댑터에 전하지 않는다');
  assert.match(route, /closed: isClosedStatus\(filedTicket\.status\)/, '끝난 접수인지를 전하지 않는다');
  assert.match(route, /contactOnFile: Boolean\(filedTicket\.contact\)/, '회신할 곳이 있는지를 전하지 않는다');

  const s = read('src/lib/kakao.ts');
  assert.equal(/body\.slice\(0, 1000\)/.test(s), false, '답변을 말 중간에서 자르는 자리가 남았다');
  assert.match(s, /export const KAKAO_TEXT_LIMIT = 1000;/, '규격값을 이름 없이 흩어 적었다');
  assert.match(s, /export const KAKAO_OUTPUT_LIMIT = 3;/, '말풍선 수 규격이 없다');
  assert.match(s, /result\.escalate && !result\.ticketId && !filed/, '접수한 사람에게 접수를 다시 권한다');
  // 근거는 마지막 한 칸을 비워 두고 따로 보낸다 — 한 번에 자르면 가장 먼저 사라진다(§13).
  assert.match(s, /KAKAO_OUTPUT_LIMIT - \(cite \? 1 : 0\)/, '근거 자리를 비워 두지 않는다');
});

/* ══════════ 디자인 스프린트 — 35차 재감사 (DS 38-1·38-2·38-3) ══════════ */

/**
 * DS 38-1·38-3 — 글자 상한의 **단일 출처**와 「잘랐다」는 표시.
 * 「정말 그렇게 동작하는가」는 `tests/runtime.test.mjs` 가 돌려서 본다 — 여기서는 숫자를 손으로
 * 다시 적은 자리가 남지 않았는지, 꼬리를 조용히 버리는 `slice` 가 남지 않았는지를 고정한다.
 */
test('받는 말·남기는 말의 상한이 한 곳에서 온다 (DS 38-1·38-3)', () => {
  const limits = read('src/lib/limits.ts');
  for (const name of ['MAX_MESSAGE_LEN', 'TURN_TEXT_LEN', 'TICKET_MESSAGE_LEN', 'TICKET_NOTE_LEN', 'SUMMARY_TEXT_LEN', 'SUMMARY_LINE_LEN']) {
    assert.match(limits, new RegExp(`export const ${name} = \\d+;`), `상한 ${name} 이 단일 출처에 없다`);
  }
  assert.match(limits, /export const CLIP_MARK = '…\(이하 생략\)';/, '잘랐다는 표시가 없다');
  // 표시까지 상한 안에 넣는다 — 저장·내려받기 계약은 「상한 이하」다.
  // 자르는 자리는 `cutEnd` 가 고른다 (DS 62-1) — 글자 하나를 쪼개지 않는다.
  assert.match(limits, /v\.slice\(0, cutEnd\(v, limit - CLIP_MARK\.length\)\)/, '표시를 붙이며 상한을 넘긴다');

  // 기록에 남기는 자리는 전부 `clip` 을 지난다 — 숫자를 손으로 적은 `slice` 가 남으면 안 된다.
  for (const f of ['src/lib/convlog.ts', 'src/lib/escalation.ts']) {
    const s = read(f);
    assert.match(s, /from '@\/lib\/limits'/, `${f} 가 상한을 따로 적고 있다`);
    assert.equal(/slice\(0, (300|500|4000)\)/.test(s), false, `${f} 에 꼬리를 조용히 버리는 자리가 남았다`);
  }
  // 가린 뒤에 자른다 (DS 39-1) — 먼저 자르면 경계에 걸친 번호가 쪼개져 규칙에 걸리지 않는다.
  assert.match(read('src/lib/convlog.ts'), /message: clip\(m\.text, TURN_TEXT_LEN\)/, '대화 기록이 표시 없이 잘린다');
  assert.match(read('src/lib/escalation.ts'), /clip\(input\.summary, SUMMARY_TEXT_LEN\)/, '이관 요약 보호막이 표시를 남기지 않는다');

  // 카카오 창구의 상한은 웹과 **같은 값**이어야 한다(자기 숫자를 적으면 다시 어긋난다).
  const kakao = read('src/lib/kakao.ts');
  assert.match(kakao, /export const KAKAO_UTTERANCE_LIMIT = MAX_MESSAGE_LEN;/, '카카오가 상한을 따로 적고 있다');
  assert.match(kakao, /utterance\.length > KAKAO_UTTERANCE_LIMIT/, '발화 길이를 재는 자리가 없다');
  // 받아서 자르지 않는다 — 고객이 쓴 말을 줄이면 묻지 않은 질문에 답하는 것이 된다.
  assert.equal(/utterance\.slice\(0, KAKAO_UTTERANCE_LIMIT\)/.test(kakao), false, '긴 발화를 잘라서 받는다');

  // 라우트는 「확인하지 못했어요」와 「너무 길어요」를 구분해 말한다.
  const route = read('src/app/api/kakao/webhook/route.ts');
  assert.match(route, /if \(!parsed\.ok\) \{/, '실패 사유를 값으로 받지 않는다');
  assert.match(route, /KAKAO_TOO_LONG_TEXT/, '긴 발화에 상한을 알리지 않는다');
  assert.match(route, /code: tooLong \? 'utterance_too_long'/, '거절 사유가 서버 로그에 남지 않는다');

  // 위젯은 lib 을 import 하지 않아야 렌더 테스트가 파일 하나만 떼어 컴파일할 수 있다 —
  // 그래서 값을 적어 두고, 어긋나면 위쪽 DS 5-5 테스트가 막는다.
  assert.equal(/from '@\/lib\//.test(read('src/components/ChatWidget.tsx')), false, '위젯이 lib 을 import 하면 렌더 테스트가 깨진다');
});

/**
 * DS 38-2 — 이관 요약의 **마지막 줄은 언제나 「개인정보 마스킹」**이다.
 * 길이를 맞추는 몫은 직전 대화가 지고, 줄인 줄 수는 말로 남는다.
 */
test('이관 요약이 상한을 꼬리로 갚지 않는다 (DS 38-2)', () => {
  const s = read('src/lib/handoff.ts');
  assert.match(s, /export function renderSummaryText\(s: HandoffSummary, limit = SUMMARY_TEXT_LEN\)/, '요약을 만드는 쪽에 상한이 없다');
  assert.match(s, /fitTurnLines\(convo, limit - head\.length - 1 - mask\.length\)/, '직전 대화가 길이를 맞추지 않는다');
  assert.match(s, /\[head, \.\.\.fitTurnLines\([^)]*\), mask\]\.join\('\\n'\)/, '마스킹 줄이 마지막이 아니다');
  assert.match(s, /앞선 대화 \$\{n\}줄은 길어서 요약에서 줄였습니다/, '줄인 사실을 말하지 않는다');
  // 고지가 들어갈 자리를 **최대 길이로 먼저** 비워 둔다 — 고지까지 잘리면 아무도 줄인 줄 모른다.
  assert.match(s, /DROPPED_NOTICE\(lines\.length\)\.length \+ 1/, '줄였다는 고지 자리를 비워 두지 않는다');
  assert.match(s, /clip\(t\.text, SUMMARY_LINE_LEN\)/, '대화 한 줄을 표시 없이 자른다');
  assert.match(s, /clip\(c\.value, SUMMARY_LINE_LEN\)/, '수집 정보 한 값을 표시 없이 자른다');
});

/* ══════════ 디자인 스프린트 — 36차 재감사 (DS 39-1·39-2·39-3) ══════════ */

/**
 * DS 39-3 — 마스킹 규칙의 **단일 출처**.
 * 「정말 그렇게 동작하는가」는 `tests/runtime.test.mjs` 가 돌려서 본다 — 여기서는 규칙을 손으로
 * 다시 적은 자리가 남지 않았는지, 가리는 자리가 전부 그 한 곳을 지나는지를 고정한다.
 */
test('개인정보를 가리는 규칙이 한 곳에서 온다 (DS 39-3)', () => {
  const pii = read('src/lib/pii.ts');
  assert.match(pii, /export type MaskStrength = 'readable' \| 'opaque';/, '세기 구분이 없다');
  assert.match(pii, /export function maskPii\(input: string, strength: MaskStrength = 'readable'\)/, '기본 세기가 readable 이 아니다');
  // 이 파일은 아무것도 import 하지 않는다 — 로깅·모니터링이 여기를 보므로 거꾸로 의존하면 순환이다.
  assert.equal(/^import /m.test(pii), false, 'pii 가 다른 모듈에 의존하면 순환이 생긴다');

  // 규칙 표는 한 벌뿐이다. 다른 파일에 정규식을 다시 적으면 또 어긋난다.
  for (const f of ['src/lib/handoff.ts', 'src/lib/monitoring.ts']) {
    const s = read(f);
    assert.match(s, /from '@\/lib\/pii'/, `${f} 가 마스킹 단일 출처를 쓰지 않는다`);
    assert.equal(/01\[0-9\]\[-\\s\]\?/.test(s), false, `${f} 에 마스킹 규칙이 따로 남았다`);
  }
  // 외부 LLM 전송은 `scrub`(= opaque)을 그대로 쓴다 — 이 경로가 가장 멀리 나간다.
  assert.match(read('src/lib/llm.ts'), /scrub\(m\.content\)/, '외부로 나가는 본문이 마스킹을 거치지 않는다');

  // 우리가 만든 식별자는 사용자 글이 아니다 — 계좌 규칙에 걸려 로그 추적이 끊기지 않게 한다.
  assert.match(read('src/lib/logger.ts'), /if \(k === 'sessionHash'\)/, '세션 해시가 마스킹에 걸린다');
});

/**
 * DS 39-1·39-2 — 기록에 남기는 글은 **가린 뒤에** 자른다.
 * 순서가 뒤집히면 상한 경계에 걸친 번호가 쪼개져 규칙에 걸리지 않고 앞자리가 그대로 남는다.
 */
test('대화 기록·접수 본문이 저장 전에 개인정보를 가린다 (DS 39-1·39-2)', () => {
  const conv = read('src/lib/convlog.ts');
  assert.match(conv, /import \{ maskPii, mergeKinds, piiKindLabels \} from '@\/lib\/pii'/, '대화 기록이 마스킹을 불러오지 않는다');
  assert.match(conv, /const m = maskPii\(input\.message \|\| ''\);/, '고객의 말이 마스킹을 지나지 않는다');
  assert.match(conv, /const r = maskPii\(input\.reply \|\| ''\);/, '답변이 마스킹을 지나지 않는다');
  assert.match(conv, /piiKinds\?: string\[\];/, '무엇을 가렸는지 남기지 않는다');
  // 복원 경로도 같은 관문을 지난다(마스킹 이전에 뜬 스냅샷에는 원문이 들어 있다).
  assert.match(conv, /const mm = maskPii\(String\(t\.message \?\? ''\)\);/, '복원 경로가 마스킹을 건너뛴다');

  const esc = read('src/lib/escalation.ts');
  assert.match(esc, /const body = maskPii\(String\(input\.message \|\| ''\)\.trim\(\)\);/, '접수 본문이 마스킹을 지나지 않는다');
  assert.match(esc, /message: clip\(body\.text, TICKET_MESSAGE_LEN\)/, '가리기 전에 자른다');
  // 회신할 연락처는 **가리지 않는다** — 상담원이 전화를 걸 대상이다(화면·파기·되읽기로 다룬다).
  assert.equal(/maskPii\([^)]*contact/.test(esc), false, '회신할 연락처를 저장 단계에서 가려 버렸다');

  // 이름은 서버가 붙여 보낸다(`intentLabel`·`tenantLabel` 과 같은 규칙) — 콘솔은 사전을 안 든다.
  const route = read('src/app/api/admin/escalations/route.ts');
  assert.match(route, /import \{ piiKindLabels \} from '@\/lib\/pii'/, '가린 종류의 이름을 붙이지 않는다');
  assert.match(route, /piiLabels: piiKindLabels\(t\.piiKinds\),/, '접수·대화에 가린 종류가 실리지 않는다');
});

/* ══════════ 37차 재감사 — 내려받은 파일이 화면과 다른 말을 하던 자리 (DS 40-x) ══════════ */

/**
 * DS 40-1 — 내려받는 표를 만드는 코드가 **돌려 볼 수 없는 자리**(`route.ts`)에 있었다.
 * 라우트는 HTTP 메서드·설정 외 export 가 금지되어(★ 안전 원칙) 런타임 테스트가 0건이었고,
 * 그래서 열 이름만 소스 텍스트로 대조한 채 **값은 아무도 보지 않았다**(시각이 UTC 로 나갔다).
 * 38차가 웹 발화 상한에서 본 것과 같은 자리다.
 */
test('내려받는 표를 만드는 곳은 돌려 볼 수 있는 자리다 (DS 40-1)', () => {
  const route = read('src/app/api/admin/logs/export/route.ts');
  // 라우트는 부르기만 한다 — 표를 만드는 식(`csvRow`)이 남아 있으면 다시 돌려 볼 수 없다.
  assert.match(route, /import \{ turnCount, turnsToCsv \} from '@\/lib\/convlog'/, '라우트가 표를 직접 만든다');
  assert.equal(/csvRow|csvCell/.test(route), false, '라우트에 표를 만드는 식이 남아 있다');
  // 라우트에는 HTTP 메서드·설정 외 export 가 없다(★ 안전 원칙 — 이 규칙이 결함의 원인이었다).
  const exports = [...route.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+(\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(exports.sort(), ['GET', 'dynamic'], `라우트에 허용되지 않은 export 가 있다: ${exports}`);

  // 사람이 읽는 시각은 한국 시간, 기계가 보는 원문은 따로 — `주제`·`주제코드` 와 같은 규칙.
  for (const p of ['src/lib/convlog.ts', 'src/lib/audit.ts']) {
    const s = read(p);
    assert.match(s, /from '@\/lib\/kst'/, `${p}: 한국 시간 모듈을 쓰지 않는다`);
    assert.match(s, /kstDateTime\(\w+\.at\)/, `${p}: 시각을 ISO 원문으로 싣는다`);
    assert.match(s, /'시각\(ISO\)'/, `${p}: 기계가 보는 원문 열이 없다`);
    assert.match(s, /KST_CSV_NOTE/, `${p}: 파일이 제 시각 기준을 말하지 않는다`);
  }
  // 시간대 문자열이 두 곳에 있으면 갈라진다 — 계산은 `@/lib/kst` 하나가 한다(DS 21-1 과 같은 규칙).
  assert.equal(/\+ 9 \* 60|32400000|Asia\/Seoul/.test(read('src/lib/convlog.ts')), false, '오프셋을 손으로 적었다');
});

/** DS 40-2 — 화면은 「가렸다」·「최근 분량만」이라 말하는데 파일은 말하지 않았다. */
test('내려받는 대화 기록이 가림·보관 범위를 열과 주석으로 말한다 (DS 40-2)', () => {
  const s = read('src/lib/convlog.ts');
  assert.match(s, /'개인정보 가림'/, 'CSV 에 가림 표시 열이 없다');
  assert.match(s, /piiKindLabels\(l\.piiKinds\)\.join\(', '\)/, '가린 종류를 이름으로 싣지 않는다');
  // 이름 사전은 서버(`@/lib/pii`)가 들고 있다 — 파일이 사전을 따로 들면 종류가 늘 때 어긋난다.
  assert.equal(/'휴대폰 번호'|'주민등록번호'/.test(s), false, 'convlog 가 가림 종류 사전을 따로 들고 있다');
  // 보관 한도는 한 곳에서 온다(화면 문구와 파일 주석이 다른 수를 말하지 않게).
  assert.match(s, /export const TURN_RETENTION = MAX_LOGS;/, '보관 한도에 이름이 없다');
  // 꼬리 주석의 문장은 변경 이력 CSV 와 **한 벌**이다(`@/lib/retention` · DS 48-1) — 두 파일을
  // 나란히 받은 사람이 어느 쪽 기준을 믿어야 하는지 헷갈리지 않게. 실제 출력은 runtime 이 본다.
  assert.match(s, /retentionNotes\('대화', turnRetention\(\)\)/, '파일이 보관 범위를 한 벌로 말하지 않는다');
  assert.match(read('src/lib/retention.ts'), /보관 한도 \$\{r\.limit\}건/, '파일이 보관 한도를 말하지 않는다');
  assert.match(s, /\$\{CLIP_MARK\}/, '줄임 표시를 손으로 적었다');
});

/**
 * DS 40-3 — 개인정보가 담긴 내려받기가 **흔적을 남기지 않았다**.
 * 정산 리포트(금액)만 남고, 상담 내용 보존분 전체·배포를 다시 세울 수 있는 백업은 0건이었다.
 */
test('쿼리 토큰으로 여는 내려받기는 모두 변경 이력에 남는다 (DS 40-3)', () => {
  // 쿼리 토큰을 허용하는 관리 라우트 = 브라우저가 직접 여는 내려받기다.
  const DOWNLOADS = [
    ['src/app/api/admin/logs/export/route.ts', 'conversation.export'],
    ['src/app/api/admin/backup/route.ts', 'backup.export'],
    ['src/app/api/admin/settlement/route.ts', 'settlement.export'],
  ];
  for (const [p, action] of DOWNLOADS) {
    const s = read(p);
    assert.match(s, /allowQueryToken/, `${p}: 브라우저 내려받기 경로가 아니다(목록을 고쳐야 한다)`);
    assert.match(s, /from '@\/lib\/audit'/, `${p}: 감사 로그를 불러오지 않는다`);
    assert.match(s, new RegExp(`action: '${action.replace('.', '\\.')}'`), `${p}: ${action} 을 남기지 않는다`);
  }
  // 변경 이력 CSV 내려받기 자신은 남기지 않는다 — 그 파일이 흔적이고, 재귀 기록은 잡음이다.
  assert.equal(/logAudit/.test(read('src/app/api/admin/audit/route.ts')), false, '변경 이력 조회가 자기를 기록한다');

  // 작업 코드 목록은 **한 벌**이다 — 손으로 적은 사본에 빠진 코드는 복원에서 조용히 버려졌다.
  const audit = read('src/lib/audit.ts');
  assert.match(audit, /const ACTIONS = new Set<string>\(Object\.keys\(AUDIT_ACTION_LABELS\)\)/, '받아들이는 코드 목록이 두 벌이다');
  assert.equal(/new Set<string>\(\[\s*'kb\.upsert'/.test(audit), false, '손으로 적은 사본이 남아 있다');
  // 새 작업 종류에도 사람 말 이름이 있다(화면·CSV 가 그대로 그리는 값이다).
  for (const k of ['backup.export', 'conversation.export']) {
    assert.ok(audit.includes(`'${k}': '`), `${k} 의 표시명이 없다`);
  }
});

/* ══════════ 41순위 — 백로그 소진 후 38차 재감사 (DS 41-x) ══════════ */

/**
 * DS 41-1·41-2 — 「조합 중인가」를 묻는 자리는 **한 함수**다.
 *
 * 종전에는 `!e.nativeEvent.isComposing` 을 키 분기마다 손으로 적었고, 그래서 적은 자리(위젯
 * 입력칸·접수 연락처·응답 테스트)만 지켜졌다. 같은 글자를 손으로 적게 하면 **새로 생긴 키 분기**가
 * 조용히 빠진다 — 실제로 상담창의 Esc 와 콘솔 전역 검색의 Enter·Esc 가 빠져 있었다.
 * 위젯과 콘솔은 서로를 불러오지 않으므로(`MAX_INPUT_LEN`·`lockPageScroll` 과 같은 기존 규약)
 * 사본 두 벌을 글자까지 대조한다. 동작 자체는 두 화면 테스트가 떼어내 실제로 돌려 본다.
 */
test('조합 중인 키를 가리는 판정이 위젯·콘솔에서 같은 사본이다 (DS 41-1·41-2)', () => {
  const widget = read('src/components/ChatWidget.tsx');
  const console_ = read('src/app/admin/page.tsx');
  assert.equal(topFn(widget, 'function composingKey('), topFn(console_, 'function composingKey('), '사본이 갈라졌다');
  // 두 모양을 모두 본다 — React 합성 이벤트는 `nativeEvent.isComposing`, window 리스너가 받는
  // 네이티브 KeyboardEvent 는 `isComposing` 이다(한쪽만 보면 나머지 자리에서 조용히 무효가 된다).
  assert.match(
    topFn(widget, 'function composingKey('),
    /e\.nativeEvent \? e\.nativeEvent\.isComposing : e\.isComposing/,
    '조합 확인이 한쪽 모양만 본다',
  );

  for (const [name, s] of [['위젯', widget], ['콘솔', console_]]) {
    // 손으로 적은 조합 확인(`!e.nativeEvent.isComposing`)이 남아 있으면 규칙이 다시 갈라진다.
    assert.equal(/!e\.nativeEvent\.isComposing/.test(s), false, `${name}: 조합 확인을 손으로 적은 자리가 남아 있다`);
    // 날 것의 `isComposing` 을 보는 자리는 그 한 함수뿐이다.
    assert.equal((s.match(/e\.isComposing/g) || []).length, 1, `${name}: 조합 상태를 그 함수 밖에서도 읽는다`);
    assert.ok((s.match(/composingKey\(e\)/g) || []).length >= 3, `${name}: 조합 확인을 거치는 키 분기가 너무 적다`);
  }

  // 위젯 — 패널의 Esc 는 음절 취소일 수 있다(그 키로 상담창을 접지 않는다).
  const panel = widget.slice(widget.indexOf('function onPanelKeyDown('), widget.indexOf('function pushBot('));
  const esc = panel.slice(panel.indexOf("if (e.key === 'Escape') {"), panel.indexOf('closePanel(false);'));
  assert.match(esc, /if \(composingKey\(e\)\) return;/, '위젯: 조합 중인 Esc 에도 상담창을 접는다');
  // 글자를 보내는 두 자리(입력칸·접수 연락처)는 종전부터 지켜졌다 — 같은 한 함수로 옮겼을 뿐이다.
  assert.equal((widget.match(/e\.key === 'Enter' && !composingKey\(e\)/g) || []).length, 2, '위젯: Enter 분기가 조합 확인을 거치지 않는다');

  // 콘솔 — 전역 검색은 **어떤 키든** 조합 중이면 손대지 않는다(Enter·Esc·화살표가 모두 글자 쪽이다).
  const search = console_.slice(console_.indexOf('function GlobalSearch('), console_.indexOf('function tokenStore('));
  assert.ok(search.length > 0, 'GlobalSearch 영역을 찾지 못했다');
  assert.match(
    search,
    /const onKeyDown = \(e: ReactKeyboardEvent<HTMLInputElement>\) => \{\n(?:\s*\/\/[^\n]*\n)*\s*if \(composingKey\(e\)\) return;/,
    '콘솔: 전역 검색이 조합 중인 키로도 움직인다',
  );
  assert.match(console_, /e\.key === 'Enter' && !e\.shiftKey && !composingKey\(e\)/, '콘솔: 응답 테스트 Enter 가 조합 확인을 거치지 않는다');
});

/**
 * DS 41-3 — 덮개(`aria-modal="true"`)가 열려 있는 동안 창 전체에서 듣는 단축키.
 *
 * `Ctrl+K`·`/` 가 들으면 초점이 덮개 밖 헤더 검색칸으로 나간다. 덮개의 Esc·Tab 가둠은 모두
 * 제 패널의 `onKeyDown` 에 걸려 있으므로 그 뒤로는 Esc 로 덮개를 닫는 길이 막히고, 확인
 * 대화상자는 약속(`resolve`)이 풀리지 않아 그 작업이 멈춘 채 남는다.
 */
test('창 전체에서 듣는 단축키가 덮개를 건너뛰지 않는다 (DS 41-3)', () => {
  const s = read('src/app/admin/page.tsx');
  const search = s.slice(s.indexOf('function GlobalSearch('), s.indexOf('function tokenStore('));
  assert.match(
    search,
    /if \(composingKey\(e\) \|\| document\.querySelector\('\[aria-modal="true"\]'\)\) return;/,
    '단축키가 덮개·조합 상태를 보지 않는다',
  );
  // 덮개 넷이 모두 그 표시를 달고 있어야 이 한 줄이 넷 모두를 지킨다(서랍 3 + 확인 대화상자 1).
  // 세는 것은 화면에 그려지는 속성뿐이다 — 위의 선택자 문자열(`[aria-modal="true"]`)은 제외한다.
  assert.equal((s.match(/aria-modal="true"(?=[\s>])/g) || []).length, 4, '덮개 수가 바뀌었다 — 단축키 차단 범위를 다시 확인해야 한다');
  // 창 전체에서 키를 듣는 자리는 이 단축키와 덮개의 Esc 뿐이다(새로 생기면 같은 판단이 필요하다).
  assert.equal((s.match(/addEventListener\('keydown'/g) || []).length, 4, '창 전체에서 키를 듣는 자리가 늘었다');
});

/* ══════════ 42순위 — 백로그 소진 후 39차 재감사 (DS 42-x) ══════════ */

/**
 * DS 42-1 — 「같은 말인가」를 묻는 자는 **한 벌**이다.
 *
 * 종전에는 엔진(`compact`)·묶음 열쇠·고객사 검색·콘솔의 탭 검색칸이 저마다 규칙을 적어 두었고,
 * 어느 것도 유니코드 정규화를 하지 않았다. 자리마다 적는 방식이면 새로 생기는 검색칸이 또 빠진다.
 */
test('「같은 말인가」를 묻는 자가 한 벌이다 (DS 42-1)', () => {
  // ① 서버: 비교용 정규화는 `@/lib/normalize` 의 `compact` 하나를 지난다.
  const conv = read('src/lib/convlog.ts');
  assert.match(conv, /function questionKey\(message: string\): string \{\n\s*const key = compact\(message\);/, '묶음 열쇠가 제 자를 따로 적고 있다');
  const partners = read('src/lib/partners.ts');
  assert.match(partners, /const q = compact\(filter\.q \?\? ''\);/, '고객사 검색이 제 자를 따로 적고 있다');
  assert.match(partners, /!compact\(a\.name\)\.includes\(q\)/, '검색어와 이름을 다른 자로 재고 있다');
  const know = read('src/lib/knowledge.ts');
  assert.match(know, /const base = compact\(keyword\)\.length >= 2/, '키워드 길이를 매칭과 다른 자로 재고 있다');

  // ② lib 에 「소문자 + 공백 제거」를 손으로 적은 자리가 남아 있지 않다(그 자는 엔진보다 약하다).
  for (const f of ['src/lib/convlog.ts', 'src/lib/partners.ts', 'src/lib/knowledge.ts', 'src/lib/ingest.ts']) {
    const body = read(f).split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
    assert.equal(/toLowerCase\(\)\s*\.?\s*replace\(\/\\s/.test(body), false, `${f}: 제 자를 따로 적은 검색 정규화가 남아 있다`);
  }

  // ③ 콘솔: 검색칸이 넷이든 다섯이든 **같은 함수 하나**를 지난다(콘솔은 lib 을 불러올 수 없다).
  const s = read('src/app/admin/page.tsx');
  for (const name of ['kbQuery', 'ruleQuery', 'escQuery', 'accountQuery']) {
    assert.ok(s.includes(`searchNorm(${name})`), `${name} 가 공통 검색 자를 지나지 않는다`);
  }
  assert.equal(/Query\.trim\(\)\.toLowerCase\(\)/.test(s), false, '탭 검색칸이 제 자를 따로 적고 있다');
  // 비교용 정규화를 적는 자리는 그 함수 하나뿐이다(`docLen` 은 길이를 재는 다른 일이다).
  // 늘여 쓴 글자를 줄이는 식에서 숫자를 뺀 것은 DS 64-3 — 「1000원」과 「100원」은 다른 값이다.
  assert.equal((s.match(/\.toLowerCase\(\)\s*\n?\s*\.replace\(\/\(\[\^0-9\]\)/g) || []).length, 1, '콘솔에 비교용 정규화가 두 벌 이상 있다');
});

/**
 * DS 42-3 — 유니코드 정규화를 적는 자리는 **`@/lib/normalize` 한 곳**이다.
 *
 * 분해형 한글(ㅎ+ㅏ+ㄴ)은 화면에 완성형과 똑같이 보이지만 문자열로는 다른 글자다.
 * 자리마다 `.normalize('NFC')` 를 적으면 빠뜨린 자리가 조용히 생긴다 — 그 자리가
 * 문서 업로드의 토큰 경계였고, 한글 문서가 통째로 버려졌다.
 */
test('유니코드 정규화는 한 곳에서만 적는다 (DS 42-3)', () => {
  // lib 쪽에서 NFC 를 직접 적는 파일은 normalize.ts 뿐이다(나머지는 `toNfc` 를 불러 쓴다).
  for (const f of ['src/lib/ingest.ts', 'src/lib/convlog.ts', 'src/lib/partners.ts', 'src/lib/knowledge.ts', 'src/lib/chat.ts']) {
    assert.equal(/normalize\('NFC'\)/.test(read(f)), false, `${f}: 유니코드 정규화를 손으로 적고 있다`);
  }
  const norm = read('src/lib/normalize.ts');
  assert.equal((norm.match(/normalize\('NFC'\)/g) || []).length, 1, 'normalize.ts 안에서도 두 벌로 적혀 있다');
  assert.match(norm, /export function toNfc\(s: string\): string \{/, '정규화 단일 출처(toNfc)가 없다');

  // 문서 업로드: 자르기·토큰 경계·길이 판정이 모두 정규화 **뒤**에 온다.
  const ing = read('src/lib/ingest.ts');
  // 정규화 **뒤에** 자르고, 자르는 자리는 `cutEnd` 가 고른다 (DS 62-1) — 정규화가 합쳐 주지
  // 못하는 두 칸 글자(이모지)가 상한 가운데 떨어지면 마지막 글자가 반쪽으로 남는다.
  assert.match(ing, /const nfc = toNfc\(raw\);\n\s*const text = nfc\.slice\(0, cutEnd\(nfc, MAX_DOC_CHARS\)\)/, '정규화 전에 문서를 자른다');
  assert.match(ing, /const tokens = toNfc\(text\)\n\s*\.toLowerCase\(\)/, '정규화 전에 토큰을 가른다');
  const route = read('src/app/api/admin/kb/import/route.ts');
  assert.match(route, /reqStr\(typeof body\.text === 'string' \? toNfc\(body\.text\) : body\.text, 'text', MAX_DOC_CHARS\)/, '길이를 정규화 전에 잰다');

  // 콘솔도 같은 기준으로 센다 — 화면이 통과시킨 글을 서버가 거절하지 않게.
  const s = read('src/app/admin/page.tsx');
  assert.match(s, /function docLen\(v: string\): number \{\n\s*return \(v \|\| ''\)\.normalize\('NFC'\)\.length;/, '콘솔이 코드 단위로 글자를 센다');
  assert.equal(/imp\.text\.length/.test(s), false, '본문 길이를 코드 단위로 세는 자리가 남아 있다');
});

/* ══════════ 49순위 — 백로그 소진 후 46차 재감사 (DS 49-1·49-2) ══════════ */

/**
 * DS 49-1 — 접수 조회 창구의 **배선**. 「정말 가려지는가」는 `runtime.test.mjs` 가 저장소를
 * 돌려서 본다(라우트는 next 의존 때문에 컴파일 대상이 아니다). 여기서는 그 문을 라우트가
 * 실제로 지나는지, 번호만으로 찾는 옛길이 남아 있지 않은지, 거절이 한 문장인지를 고정한다.
 */
test('접수 조회가 주인 확인과 횟수 제한을 지난다 (DS 49-1)', () => {
  const route = read('src/app/api/escalation/route.ts');
  const get = route.slice(route.indexOf('export async function GET('));

  // ① 번호만으로 찾는 옛길이 남아 있지 않다 — 두 값을 함께 받는 문 하나만 쓴다.
  assert.match(get, /getTicketForSession\(id\.value, owner\.value\)/, '조회가 주인을 가리지 않는다');
  assert.equal(/getTicket\(/.test(get), false, '번호만으로 찾는 길이 남아 있다');
  assert.equal(/getTicket,/.test(route), false, '옛 함수를 아직 들여온다');

  // ② 세션을 **필수**로 받는다(없으면 400) — 선택으로 두면 보내지 않는 쪽이 종전 그대로 열린다.
  assert.match(get, /reqQuery\(req, 'sessionId', 60\)/, '세션을 필수로 받지 않는다');
  assert.ok(
    get.indexOf("reqQuery(req, 'sessionId'") < get.indexOf('getTicketForSession('),
    '찾은 뒤에 세션을 본다 — 그 응답이 존재를 알린다',
  );

  // ③ 훑는 일을 막는다 — 읽기 경로에도 횟수 제한이 걸린다(방침 §10 이 적어 둔 보호 조치다).
  assert.match(get, /rateGuard\('escalation-lookup', req\.headers, 30\)/, '조회에 횟수 제한이 없다');
  assert.ok(get.indexOf('rateGuard(') < get.indexOf("reqQuery(req, 'id')"), '제한이 입력 검사 뒤에 있다');

  // ④ 거절은 한 문장이다 — 없는 번호와 남의 번호를 다르게 거절하면 그 차이가 답이 된다.
  assert.equal((get.match(/fail\('not_found'/g) || []).length, 1, '거절하는 자리가 둘 이상이다');
  assert.equal(/forbidden|unauthorized/.test(get), false, '남의 접수에 다른 코드로 거절한다');

  // ⑤ 응답에 늘어난 칸이 없다(연락처·세션·메모는 종전처럼 싣지 않는다).
  const body = get.slice(get.indexOf('ok({'));
  for (const banned of ['contact', 'sessionId', 'note', 'summary', 'message']) {
    assert.equal(new RegExp(`${banned}:`).test(body), false, `조회 응답에 ${banned} 가 실린다`);
  }
  // 로그도 종전 규칙 그대로다 — 세션 원문은 남기지 않는다.
  for (const call of get.match(/rl\.end\(\{[\s\S]*?\}\)/g) ?? []) {
    assert.equal(/(?<![.\w])sessionId\s*[,:}]/.test(call), false, '조회 로그가 세션 원문을 남긴다');
  }

  // ⑥ 가리는 자는 저장소에 한 벌이다 — 비교는 상수 시간, 빈 세션은 거절한다.
  const lib = read('src/lib/escalation.ts');
  const fn = lib.slice(lib.indexOf('export function getTicketForSession('));
  assert.match(fn, /safeEqual\(t\.sessionId, sid\)/, '세션을 글자 단위로 견준다');
  // 빈 세션과 **공용 세션 값**을 같은 자리에서 거절한다(DS 51-2) — 뜻은 그대로, 범위가 늘었다.
  assert.match(fn, /if \(!sid \|\| isSharedSessionKey\(sid\)\) return undefined;/, '빈 세션·공용 세션이 통과한다');
});

/**
 * DS 49-2 — 공개 응답이 **우리 문이 잠겨 있지 않다는 사실**을 밖에 알렸다.
 *
 * `/api/health` 는 `adminAuthRequired`·`adminTokenConfigured` 를, 카카오 웹훅 GET 은
 * `signature.configured`·`required` 를 인증 없이 돌려줬다. 지금 배포본의 그 값은 모두
 * false 이므로([승인 필요]) 두 응답은 「관리 콘솔에 토큰이 없다」·「서명 없이 보낸 요청도
 * 받는다」를 라이브 주소를 아는 누구에게나 알리는 안내문이었다.
 */
test('공개 상태 응답이 잠금 상태를 밖에 알리지 않는다 (DS 49-2)', () => {
  const health = read('src/app/api/health/route.ts');

  // ① 토큰을 **맞췄을 때만** 적는다 — 게이트 OFF 면 통과되는 `requireAdmin` 은 쓰지 않는다.
  assert.match(health, /const authed = isAdminAuthed\(req\);/, '헬스체크가 토큰 일치를 보지 않는다');
  assert.equal(/requireAdmin\(/.test(health), false, '게이트 OFF 면 통과되는 문을 쓴다');
  for (const key of ['adminAuthRequired:', 'adminTokenConfigured:', 'partnerPortal:']) {
    const i = health.indexOf(key);
    assert.ok(i > 0, `${key} 칸이 사라졌다 — 토큰을 맞춘 사람은 볼 수 있어야 한다`);
    assert.ok(i > health.indexOf('...(authed'), `${key} 가 아직 공개 응답에 있다`);
  }
  // ② 외부 감시·콘솔이 읽는 칸은 종전대로 공개다(저장소·테넌트 상태는 잠금 상태가 아니다).
  assert.ok(health.indexOf('dependencies') < health.indexOf('...(authed'), '저장소 상태가 토큰 뒤로 숨었다');
  assert.match(health, /status: failing\.length \|\| brokenTenant \? 'degraded' : 'ok'/, '신호등 판정이 바뀌었다');
  // ③ 토큰 값 자체는 어느 쪽에도 실리지 않는다(종전 규칙).
  assert.equal(/ADMIN_TOKEN\s*[,}]/.test(health.replace(/process\.env\.ADMIN_TOKEN/g, '')), false, '토큰 값을 노출한다');

  const kakao = read('src/app/api/kakao/webhook/route.ts');
  const get = kakao.slice(kakao.indexOf('export async function GET('), kakao.indexOf('export async function POST('));
  assert.match(get, /isAdminAuthed\(req\)/, '웹훅 GET 이 서명 설정을 아무에게나 말한다');
  assert.ok(get.indexOf('signature:') > get.indexOf('isAdminAuthed(req)'), '서명 설정이 아직 공개 응답에 있다');
  // 등록한 쪽이 「이 URL 이 응답하는가」를 보는 값은 그대로 둔다.
  assert.match(get, /live: KAKAO_LIVE/, '등록 확인에 쓰는 값까지 거뒀다');
});

/* ══════════ 50순위 — 백로그 소진 후 47차 재감사 (DS 50-1·50-2·50-3) ══════════ */

/**
 * DS 50-1 — 되살린 접수의 상태를 **되묻는 배선**.
 *
 * 판정과 문구는 돌려서 본다(`tests/widget.test.mjs` 같은 번호). 여기서 고정하는 것은 효과의
 * 배선이다: ① 되살린 카드만 `stale` 로 표시하는가 ② 자기 세션을 들고 묻는가(DS 49-1 이 세운
 * 주인 확인) ③ **한 번만** 묻는가(주기적으로 묻지 않는다 — 사내망에서는 조회 제한 30회/분이
 * 한 IP 에 공유된다) ④ 답하지 못하면 모른다고 적는가 ⑤ 그 사이 대화를 지웠거나 새 접수를
 * 만들었으면 응답을 싣지 않는가(DS 20-1 의 세대 대조와 같은 규칙).
 */
test('되살린 접수의 상태를 자기 세션으로 한 번 되묻는다 (DS 50-1)', () => {
  const s = read('src/components/ChatWidget.tsx');

  // ① 되살린 카드만 「모른다」로 시작한다 — 방금 접수한 카드는 표시하지 않는다.
  const restore = s.slice(s.indexOf('const savedHandoff = saved.handoff;'), s.indexOf('setResumed(true);'));
  assert.match(restore, /created: false, stale: true/, '되살린 카드가 그때의 상태를 지금 상태처럼 들고 온다');
  const submit = fnBody(s, 'async function submitHandoff(');
  assert.equal(/stale: true/.test(submit), false, '방금 접수한 카드까지 모르는 것으로 표시한다');

  // ② 되묻는 조건과 창구 — `stale` 인 접수에만, 자기 세션을 들고.
  assert.match(s, /const staleTicketId = handoff\?\.ticket\?\.stale === true \? handoff\.ticket\.id : '';/, '되묻는 대상을 가리지 않는다');
  assert.match(
    s,
    /getJson\(\s*`\/api\/escalation\?id=\$\{encodeURIComponent\(staleTicketId\)\}&sessionId=\$\{encodeURIComponent\(sessionId\)\}`/,
    '접수번호만으로 묻거나, 값을 그대로 주소에 붙인다',
  );
  // ③ 한 번만 묻는다 — 되살릴 때마다 한 번이고, 그 뒤로는 다시 묻지 않는다.
  const effect = s.slice(s.indexOf('const staleTicketId ='), s.indexOf('// 적던 말도 글자마다 보관한다'));
  assert.match(effect, /\}, \[staleTicketId, sessionId\]\);/, '되묻는 조건이 바뀔 때마다 다시 묻는다');
  assert.equal(/setInterval|setTimeout/.test(effect), false, '주기적으로 되묻는다 — 조회 제한을 한 IP 가 공유한다');

  // ④ 답을 받으면 상태·회신 여부를 함께 고치고 「모른다」를 거둔다. 못 받으면 모른다고 적는다.
  assert.match(effect, /stale: false,/, '확인한 뒤에도 모르는 상태로 남는다');
  assert.match(effect, /contactOnFile: data\.ticket\.contactOnFile === true/, '서버가 말하지 않은 회신 가능 여부를 있다고 본다');
  assert.equal((effect.match(/patch\(\{ unchecked: true \}\)/g) || []).length, 2, '되묻지 못한 자리(거절·끊김)를 모른다고 적지 않는다');

  // ⑤ 그 사이 대화를 지웠거나(세대) 카드가 다른 접수로 바뀌었으면 싣지 않는다.
  assert.match(effect, /gen !== genRef\.current/, '지운 대화의 응답이 끼어든다');
  assert.match(effect, /h\.ticket\.id === staleTicketId && h\.ticket\.stale/, '다른 접수 카드에 지난 응답을 싣는다');

  // 조회 응답은 **주인 확인을 지난 뒤**에만 회신 가능 여부를 말한다(DS 49-1 과 한 벌이다).
  const route = read('src/app/api/escalation/route.ts');
  const get = route.slice(route.indexOf('export async function GET('));
  assert.ok(get.indexOf('getTicketForSession(id.value, owner.value)') < get.indexOf('contactOnFile'), '주인 확인보다 먼저 값을 싣는다');
  assert.match(get, /rateGuard\('escalation-lookup', req\.headers, 30\)/, '조회 횟수 제한이 사라졌다');
});

/**
 * DS 50-1 — 끝난 접수가 **다시 부를 길을 막지 않는다**.
 *
 * 접수번호를 들고 있는 동안 다른 답변의 「상담원 연결하기」는 안내 문구로 바뀐다(DS 35-2 —
 * 중복 접수를 막는 자리다). 그런데 그 판정이 「접수가 있는가」였기 때문에, 운영자가 완료·취소한
 * 접수 하나가 그 대화에서 **상담원을 다시 부를 유일한 버튼을 영구히 가렸다** — 게다가 그 문구는
 * 「접수번호 …로 상담원 연결이 접수돼 있어요」라고 현재형으로 말한다(사실이 아니다).
 */
test('끝난 접수는 다시 부를 길을 막지 않는다 (DS 50-1)', () => {
  const s = read('src/components/ChatWidget.tsx');
  assert.match(
    s,
    /const filedTicket = handoff\?\.ticket && !ticketClosed\(handoff\.ticket\.status\) \? handoff\.ticket : null;/,
    '끝난 접수가 아직 「들고 있는 접수」로 남아 있다',
  );
  // 아직 확인하지 못한 접수(stale)는 들고 있는 것으로 본다 — 모르는 동안 중복 접수를 권하지 않는다.
  assert.equal(/!handoff\.ticket\.stale \? handoff\.ticket/.test(s), false, '모르는 동안 중복 접수를 권한다');
  // 판정은 상태 **코드**로 한다(라벨은 사람에게 보여 주는 말이라 바뀔 수 있다).
  const fn = s.slice(s.indexOf('export function ticketClosed('), s.indexOf('/** 접수 완료 카드가 들고 있는 값'));
  assert.match(fn, /status === 'resolved' \|\| status === 'canceled'/, '끝난 접수 판정이 상태 코드가 아니다');
  assert.equal(/'완료'|'취소'/.test(fn), false, '라벨 글자로 판정한다');
});

/**
 * DS 50-2 — 접수번호가 **갈렸는데 같은 번호인 척** 말했다.
 *
 * 세션당 열린 접수는 재사용되지만(`createTicket`), 운영자가 완료·취소로 닫은 뒤에 같은 대화가
 * 다시 접수하면 번호는 새로 발급된다(`created === true`). 접수번호를 알리는 자리 여섯 곳 중
 * 둘은 그 값을 **버렸고**(연락처 수집·연락처만 보낸 경우), 한 곳은 「접수번호 ESC-0003 **그대로**」
 * 라고 적었다 — 고객이 받아 적은 번호는 ESC-0002 다. 문장은 `renumberedLine` 한 곳에서 만든다.
 */
test('접수번호를 알리는 자리가 모두 바뀐 사실을 말한다 (DS 50-2)', () => {
  const s = read('src/lib/chat.ts');

  assert.match(s, /function renumberedLine\(prevId: string \| undefined, nextId: string, created: boolean\)/, '바뀐 사실을 말하는 한 문장이 없다');
  // 조사는 번호를 읽는 소리에 맞춘다(DS 61-2) — 종전에는 `${prevId}는` 이라 「ESC-0001는」이었다.
  assert.match(s, /앞서 안내드린 접수번호 \$\{josa\(prevId, '은', '는'\)\} 더 진행되지 않아 새로 접수했어요/, '앞 번호가 끝났다는 사실을 말하지 않는다');
  // 까닭은 말하지 않는다 — `created` 만으로는 완료인지 취소인지(또는 복원인지) 알 수 없다.
  // 끊는 자리는 바로 다음 함수의 머리말이다 — 종전에는 「폴백 제안 번호 선택」 주석이었는데,
  // 그 식은 `lib/choice` 로 옮겨 가며 사라졌다(DS 69-1). 못 찾으면 파일 전체를 보게 되므로
  // (그러면 이 검증은 아무것도 지키지 않는다) 자리를 찾았는지 먼저 센다.
  const tail = s.indexOf('/**\n * 이 대화가 어느 고객사(테넌트)의 위젯에서 왔는가');
  assert.ok(tail > 0, '끊는 자리를 찾지 못했다 — 함수 범위를 좁히지 못하면 아래 검증이 헛돈다');
  const fn = s.slice(s.indexOf('function renumberedLine('), tail);
  assert.equal(/완료|취소/.test(fn), false, '알 수 없는 까닭을 지어낸다');
  assert.match(fn, /if \(!created \|\| !prevId \|\| prevId === nextId\) return '';/, '번호가 그대로인데도 바뀌었다고 말한다');

  // 접수번호를 알리는 자리가 모두 이 문장을 거친다(세어 고정한다 — 새 자리가 조용히 빠지지 않게).
  // 여섯 곳: 폼 중단(max_retry)·폼 완료·연락처 수집·연락처만 보낸 경우·규칙 전환·연속 저신뢰.
  assert.equal((s.match(/renumberedLine\(ctx\.ticketId, ticket\.id, created\)/g) || []).length, 6, '접수번호를 알리는 자리 중 빠진 곳이 있다');
  // 「그대로」는 **번호가 그대로일 때만** 쓴다.
  const grammar = s.slice(s.indexOf('// 0-a2)'), s.indexOf('// 0-b)'));
  // 가린 번호의 조사도 받침에 맞춘다(DS 61-3) — 종전에는 `${masked}로` 였다.
  assert.match(grammar, /renumbered\s*\n\s*\/\/[^\n]*\n\s*\? `연락처를 \$\{josa\(masked, '으로', '로'\)\} 바꿨어요\.\$\{renumbered\} 새 접수번호는 \$\{ticket\.id\}입니다\./, '번호가 갈렸는데 「그대로」라고 말한다');
  assert.match(grammar, /: `연락처를 \$\{josa\(masked, '으로', '로'\)\} 바꿨어요\. 접수번호 \$\{ticket\.id\} 그대로/, '번호가 그대로인 경우의 말까지 바꿨다');
  // `created` 를 버리는 자리가 남아 있지 않다(그 값이 곧 「번호가 새로 발급됐다」다).
  assert.equal(/const \{ ticket \} = createTicket\(\{ sessionId, tenant: tenantOf\(sessionId\), contact,/.test(s), false, 'created 를 버리는 접수 자리가 남아 있다');
});

/* ══════════ 디자인 스프린트 — 48차 재감사 (DS 51-1·51-2·51-3) ══════════ */

/**
 * DS 51-1 — 제한을 세는 열쇠가 **돌려 볼 수 있는 자리**에 있고, 요청자가 고를 수 없는 값인가.
 *
 * 「정말 그렇게 가르는가」는 `tests/runtime.test.mjs` 가 돌려서 본다(그러려고 의존성 없는
 * 모듈로 내렸다 — 종전 자리는 `next/server` 를 끌어와 런타임 테스트가 닿지 못했다).
 * 여기서는 ① 그 자리가 다시 라우트·`next` 의존 모듈로 올라가지 않았는지 ② 요청자가 적는
 * 칸을 먼저 보는 식이 되살아나지 않았는지 ③ 세는 자리들이 모두 그 한 벌을 쓰는지를 고정한다.
 */
test('제한·잠금이 같은 한 벌의 열쇠를 쓴다 (DS 51-1)', () => {
  const key = read('src/lib/clientKey.ts');
  // ① 의존성이 없다 — 이 모듈이 무엇이든 import 하면 다시 돌려 볼 수 없는 자리가 된다.
  assert.equal(/^\s*import\s/m.test(key), false, '열쇠를 만드는 모듈이 다른 모듈을 끌어온다');
  assert.match(key, /export function clientKey\(headers: Headers\): string/, '열쇠를 만드는 자가 없다');
  assert.match(key, /export const UNKNOWN_CLIENT = 'unknown';/, '「모른다」를 가리키는 값이 없다');

  // ② 플랫폼이 적는 헤더를 먼저 보고, `x-forwarded-for` 는 맨 뒤를 쓴다.
  assert.match(key, /const TRUSTED_HEADERS = \['x-vercel-forwarded-for', 'x-real-ip'\] as const;/, '믿는 헤더가 한 곳에 적혀 있지 않다');
  assert.ok(key.indexOf('TRUSTED_HEADERS') < key.indexOf("headers.get('x-forwarded-for')"), '요청자가 적는 칸을 먼저 본다');
  assert.match(key, /parts\[parts\.length - 1\]/, '맨 앞(요청자가 적는 칸)을 쓴다');
  assert.equal(/split\(','\)\[0\]/.test(key), false, '맨 앞을 쓰는 식이 되살아났다');
  // 모양을 보지 않고 쓰는 길이 없다 — 세 자리 모두 `looksLikeIp` 를 지난다.
  assert.equal((key.match(/looksLikeIp\(/g) || []).length, 3, '모양을 보지 않고 열쇠로 쓰는 자리가 있다');

  // ③ 세는 자리들이 모두 그 한 벌을 쓴다(제한·잠금이 다른 기준으로 갈리면 한쪽이 무력해진다).
  const rate = read('src/lib/ratelimit.ts');
  assert.match(rate, /import \{ clientKey \} from '@\/lib\/clientKey';/, '제한이 자기 열쇠를 따로 만든다');
  assert.match(rate, /`\$\{scope\}:\$\{clientKey\(headers\)\}`/, '제한이 공용 열쇠를 쓰지 않는다');
  assert.equal(/x-forwarded-for/.test(rate), false, '제한 모듈에 헤더를 읽는 자리가 남아 있다');
  const auth = read('src/app/api/admin/auth/route.ts');
  assert.match(auth, /const key = clientKey\(req\.headers\);/, '잠금이 공용 열쇠를 쓰지 않는다');

  // ④ 잠금 자리는 **잠긴 것을 마지막에** 지운다(자리를 밀어 잠금을 푸는 길을 열지 않는다).
  const lock = read('src/lib/adminAuth.ts');
  const fn = lock.slice(lock.indexOf('function sweep('), lock.indexOf('export interface LockoutStatus'));
  assert.equal(/attempts\.keys\(\)\.next\(\)\.value/.test(fn), false, '맨 앞을 그대로 지우는 식이 남아 있다');
  assert.match(fn, /if \(now >= v\.lockedUntil\)/, '잠긴 자리를 가리지 않는다');
});

/**
 * DS 51-2 — 세션을 보내지 않은 요청에 **창구가 한 번 쓰는 식별자를 발급하는가.**
 *
 * 공용 값을 거절하는 쪽(`escalation.getTicketForSession`)과 값을 만드는 쪽(`lib/session`)은
 * 런타임 테스트가 돌려서 본다. 라우트는 돌려 볼 수 없는 자리이므로(★ 안전 원칙 — 메서드 외
 * export 금지) 창구 넷이 모두 그 발급을 지나는지를 여기서 고정한다. 한 곳이라도 빠지면
 * 그 창구로 들어온 손님들이 다시 **한 사람**이 된다.
 */
test('세션을 들고 오지 않은 요청에 창구가 식별자를 발급한다 (DS 51-2)', () => {
  const session = read('src/lib/session.ts');
  assert.match(session, /export function isSharedSessionKey\(id: unknown\): boolean/, '공용 세션 값을 가리는 자가 없다');
  assert.match(session, /export function newVisitorSessionId\(prefix = 'web'\): string/, '발급하는 자가 없다');
  // 난수원을 **먼저** 본다(마지막 그물이 앞에 서면 암호학적 난수를 쓰지 않는다 · DS 49-3).
  assert.ok(session.indexOf('randomUUID') < session.indexOf('fallbackHex(16)'), '마지막 그물을 먼저 본다');
  assert.match(session, /for \(let i = 0; i < bytes \* 2; i \+= 1\)/, '마지막 그물이 자릿수를 채우지 않는다');

  // ① 대화·접수 창구가 공용 값을 받으면 발급으로 바꾼다(기본값으로 공용 값을 쓰지 않는다).
  for (const p of ['src/app/api/chat/route.ts', 'src/app/api/escalation/route.ts']) {
    const s = read(p);
    assert.match(s, /optStr\(parsed\.data\.sessionId, 'sessionId', 60, ''\)/, `${p} 가 공용 값을 기본값으로 쓴다`);
    assert.match(
      s,
      /isSharedSessionKey\(sid\.value\) \? newVisitorSessionId\('web'\) : sid\.value/,
      `${p} 가 세션 없는 요청을 한 칸에 몰아넣는다`,
    );
    // 공용 값을 **쓰는** 자리가 없다(주석에 적힌 종전 식 설명은 센다고 보지 않는다).
    assert.equal(/, 'anon'\)/.test(s), false, `${p} 가 공용 값을 기본값으로 넘긴다`);
    assert.equal(/\|\| 'anon'/.test(s), false, `${p} 가 공용 값으로 되돌린다`);
  }

  // ② 카카오는 사용자 id 가 없을 때만 발급한다 — 중복 전달 키는 페이로드 값을 그대로 쓴다.
  const kko = read('src/app/api/kakao/webhook/route.ts');
  assert.match(kko, /const sessionId = parsed\.userId \? `kakao:\$\{parsed\.userId\}` : newVisitorSessionId\('kakao'\);/, '카카오가 모르는 사용자를 한 칸에 몰아넣는다');
  assert.match(kko, /kakaoEventKey\(req\.headers, parsed\.userId, parsed\.utterance\)/, '중복 전달 키가 발급값으로 흔들린다');
  // 지어내는 **식**이 남아 있지 않다(주석에 적힌 종전 식 설명은 센다고 보지 않는다).
  // 터는 자는 `trim()` 이 아니라 `cleanText` 다 (DS 63-1) — 보이지 않는 글자뿐인 id 는 없는 id 다.
  assert.match(read('src/lib/kakao.ts'), /const userId = cleanText\(p\.userRequest\?\.user\?\.id\)\.slice\(0, 60\);/, '카카오가 모르는 사용자를 지어낸다');

  // ③ 관리 콘솔 「응답 테스트」가 자기 세션을 들고 보낸다(두 운영자·밖의 요청과 섞이지 않게).
  const admin = read('src/app/admin/page.tsx');
  assert.match(admin, /function newConsoleSessionId\(\): string/, '콘솔이 자기 세션을 만들지 않는다');
  assert.match(admin, /const testSessionRef = useRef\(''\);/, '세션이 턴마다 새로 만들어진다');
  assert.match(admin, /if \(!testSessionRef\.current\) testSessionRef\.current = newConsoleSessionId\(\);/, '콘솔 세션을 한 번만 만들지 않는다');
  assert.match(admin, /sessionId: testSessionRef\.current,/, '응답 테스트가 세션을 보내지 않는다');
  // 접두사 + 16진수 32자 = 41자 — 서버 입력 상한(60자) 안이다.
  assert.match(admin, /`console_\$\{c\.randomUUID\(\)\.replace\(\/-\/g, ''\)\}`/, '콘솔 세션이 추측 가능한 값에서 나온다');

  // ④ 가리는 자는 저장소 **한 벌**이다 — 라우트가 따로 적으면 조회 자리가 늘 때 한쪽이 빠진다.
  const esc = read('src/lib/escalation.ts');
  assert.match(esc, /import \{ isSharedSessionKey \} from '@\/lib\/session';/, '접수 저장소가 공용 값을 가리지 않는다');
});

/**
 * DS 51-3 — 카카오가 **지금 모습**을 받고, 웹과 같은 판정을 하는가.
 *
 * 「정말 그렇게 말하는가」는 런타임 테스트가 돌려서 본다. 여기서는 ① 끝난 접수를 가리는 어휘가
 * 한 곳에서 오는지 ② 위젯이 들고 있는 사본이 그 어휘와 어긋나지 않는지를 고정한다 —
 * 위젯은 클라이언트 묶음이라 접수 저장소를 import 할 수 없어 **두 벌**이 될 수밖에 없는 자리다.
 */
test('끝난 접수를 가리는 어휘가 창구마다 어긋나지 않는다 (DS 51-3)', () => {
  const esc = read('src/lib/escalation.ts');
  assert.match(esc, /export const CLOSED_STATUSES: EscalationStatus\[\] = \['resolved', 'canceled'\];/, '끝난 상태 코드가 한 곳에 없다');
  assert.match(esc, /export function isClosedStatus\(status: string \| undefined\): boolean/, '끝났는지 가리는 자가 없다');

  // 위젯의 사본이 같은 두 코드를 본다 — 한쪽만 늘면 그 창구가 끝난 접수를 현재형으로 말한다.
  const widget = read('src/components/ChatWidget.tsx');
  const copy = widget.slice(widget.indexOf('export function ticketClosed('), widget.indexOf('/** 접수 완료 카드가 들고 있는 값'));
  for (const code of ['resolved', 'canceled']) {
    assert.ok(copy.includes(`'${code}'`), `위젯의 사본이 ${code} 를 끝난 상태로 보지 않는다`);
  }
  assert.equal((copy.match(/status === '/g) || []).length, 2, '위젯의 사본이 저장소와 다른 수의 코드를 본다');

  // 카카오 어댑터는 상태 코드를 **해석하지 않는다**(두 벌이 세 벌이 되지 않게).
  const kakao = read('src/lib/kakao.ts');
  assert.equal(/resolved|canceled/.test(kakao), false, '어댑터가 상태 코드를 스스로 해석한다');
  assert.match(kakao, /const filed = opts\.filedTicket && !opts\.filedTicket\.closed \? opts\.filedTicket : null;/, '끝난 접수를 들고 있다');
  // 연락처가 없는 접수의 문장은 엔진과 한 벌이다(DS 45-1).
  assert.match(kakao, /import \{ noContactLine, type ChatReply \} from '@\/lib\/chat';/, '회신 불가 안내를 베껴 적었다');
  assert.match(kakao, /: noContactLine\(\)\)/, '연락처 없는 접수에 회신을 약속한다');
});

/* ══════════ 디자인 스프린트 — 49차 재감사 (DS 52-1·52-2·52-3) ══════════ */

/**
 * DS 52-1 — 전화번호 모양이 **한 곳**에 적혀 있는가.
 *
 * 「정말 가리는가」는 `tests/runtime.test.mjs` 가 돌려서 본다. 여기서 고정하는 것은 **패턴이
 * 두 벌로 돌아가지 않는 것**이다 — 받아 적는 쪽이 자기 패턴을 다시 손으로 적으면, 한쪽만
 * 넓어져 「받아 적을 수는 있는데 가릴 수는 없는 모양」이 또 생긴다(점으로 적은 번호가 그랬다).
 * 마스킹(DS 39-3)·상한(DS 38-x)·감사 어휘(DS 40-3)에서 세운 것과 같은 규칙이다.
 */
test('전화번호 모양은 받아 적는 쪽과 가리는 쪽이 한 벌로 쓴다 (DS 52-1)', () => {
  const pii = read('src/lib/pii.ts');
  // ① 구분자 집합과 패턴 원문이 **여기 한 곳**에 있다.
  //    구분자에는 붙임표 꼴이 모두 들어 있다(PDF·HWP 의 U+2010·U+2011, 메일의 U+2013 · DS 70-1).
  assert.match(pii, /export const PHONE_SEP = '\[-\\\\s\.\\\\u2010\\\\u2011\\\\u2013\\\\u2212\]';/, '구분자 집합이 한 곳에 적혀 있지 않다');
  //    앞가지가 네 자리인 갈래(안심번호 `0507`·인터넷전화 `0303`)까지 한 식에 있다 (DS 70-2).
  assert.match(
    pii,
    /export const PHONE_PATTERN =\s*`\(\?:\(\?:050\\\\d\|0303\)\$\{PHONE_SEP\}\?\\\\d\{3,4\}\$\{PHONE_SEP\}\?\\\\d\{4\}\|0\\\\d\{1,2\}\$\{PHONE_SEP\}\?\\\\d\{3,4\}\$\{PHONE_SEP\}\?\\\\d\{4\}\)`;/,
    '패턴 원문이 없다',
  );
  // ② 가리는 규칙이 그 원문을 쓴다 — 하이픈·공백만 아는 식이 되살아나지 않았다.
  //    경계·관문까지 담은 식도 **한 곳**에 있다(`PHONE_MATCH_PATTERN` · DS 53-1).
  assert.match(pii, /export const PHONE_MATCH_PATTERN = `\\\\b\$\{PHONE_PATTERN\}\\\\b\(\?!\[\\\\w\.\+-\]\*@\)`;/, '경계·관문을 담은 식이 한 곳에 없다');
  assert.match(pii, /re: new RegExp\(PHONE_MATCH_PATTERN, 'g'\)/, '가리는 규칙이 공통 패턴을 쓰지 않는다');
  assert.equal(/\[-\\s\]\?\\d\{3,4\}/.test(pii), false, '하이픈·공백만 아는 식이 남아 있다');

  // ③ 받아 적는 쪽은 패턴을 **직접 적지 않는다** — 셋 모두 `findContact` 하나를 쓴다(DS 53-1).
  const chat = read('src/lib/chat.ts');
  const slots = read('src/lib/slots.ts');
  assert.match(chat, /import \{[^}]*\bfindContact\b[^}]*\} from '@\/lib\/pii';/, '받아 적는 쪽이 고르는 자를 끌어오지 않는다');
  assert.match(slots, /import \{[^}]*\btakeContact\b[^}]*\} from '@\/lib\/pii';/, '접수 폼이 고르는 자를 끌어오지 않는다');
  for (const [name, src] of [['chat', chat], ['slots', slots]]) {
    assert.equal(/01\[016789\]/.test(src), false, `손으로 적은 전화번호 패턴이 남아 있다: ${name}`);
    assert.equal(/\\d\{3,4\}/.test(src), false, `전화번호 패턴 사본이 남아 있다: ${name}`);
    assert.equal(/\[\\w\.\+-\]\+@/.test(src), false, `이메일 패턴 사본이 남아 있다: ${name}`);
  }
});

/**
 * DS 52-2 — 가린 글의 **모양을 만드는 식**이 종전으로 돌아가지 않았는가.
 *
 * 돌려서 보는 것은 런타임 테스트의 몫이고(실제 결과 문자열), 여기서는 두 식이 되살아나지
 * 않는 것만 고정한다: ① 이메일에서 `@` 까지 삼키던 `slice(0, 2)` ② 묶음 셋만 보던 계좌 패턴.
 */
test('가린 글의 모양을 만드는 식이 종전으로 돌아가지 않는다 (DS 52-2)', () => {
  const pii = read('src/lib/pii.ts');
  // ① 이메일은 `@` 자리를 찾아 아이디와 도메인을 **따로** 다룬다.
  assert.equal(/\$\{m\.slice\(0, 2\)\}\*\*\*@/.test(pii), false, '`@` 까지 삼키던 식이 남아 있다');
  assert.equal(/m\.split\('@'\)\[1\]/.test(pii), false, '마지막 `@` 를 보지 않는 식이 남아 있다');
  assert.match(pii, /const at = m\.lastIndexOf\('@'\);/, '아이디와 도메인을 가르는 자리가 없다');
  assert.match(pii, /const keep = local\.length > 2 \? 2 : local\.length > 1 \? 1 : 0;/, '아이디보다 긴 글자를 남긴다');
  // ② 계좌는 묶음 넷까지 본다.
  assert.match(pii, /re: \/\\b\\d\{2,4\}-\?\\d\{2,6\}-\?\\d\{2,6\}\(\?:-\?\\d\{2,6\}\)\?\\b\/g,/, '계좌 규칙이 묶음 넷을 보지 않는다');
  assert.equal(/\/\\b\\d\{2,3\}-\?\\d\{2,6\}-\?\\d\{2,6\}\\b\/g/.test(pii), false, '묶음 셋만 보던 식이 남아 있다');
  // ③ 예약 일시 보호는 그대로다 — 넓힌 규칙이 날짜를 삼키지 않게 하는 자리다.
  assert.match(pii, /const PROTECT_RULES: RegExp\[\] = \[\/\\b20\\d\{2\}\[-\.\/\]\\d\{1,2\}\[-\.\/\]\\d\{1,2\}\\b\/g\];/, '날짜 보호가 사라졌다');
});

/**
 * DS 52-3 — 복원 경로가 **끝난 접수의 연락처를 들고 오지 않는가.**
 *
 * 저장분을 읽어 들이는 자리는 하나(`escalation.importTickets`)이고, 「어느 상태가 끝인가」를
 * 정하는 자도 하나다(`isClosedStatus` · DS 51-3). 두 자리가 상태 코드를 각자 늘어놓으면
 * 상태가 늘 때 한쪽이 빠진다 — 그 한쪽이 **파기 약속을 지키는 쪽**이면 번호가 남는다.
 */
test('복원·파기가 같은 자로 「끝난 접수」를 가른다 (DS 52-3)', () => {
  const esc = read('src/lib/escalation.ts');
  // ① 복원이 끝난 접수의 연락처를 파기 대상으로 본다. 「있었는가」는 **글자로 읽은 뒤** 가린다
  //    — `typeof === 'string'` 으로 보면 숫자로 적힌 번호가 파기 대상에서 빠진다(DS 54-1).
  assert.match(esc, /const contact = c\.contact === undefined \|\| c\.contact === null \? '' : String\(c\.contact\)\.trim\(\);/, '저장분의 연락처를 글자로 읽지 않는다');
  assert.match(esc, /const purgedAt = recorded \|\| \(isClosedStatus\(c\.status\) && contact \? now\(\) : undefined\);/, '끝난 접수의 연락처를 되살리는 식이다');
  assert.equal(/typeof c\.contact === 'string' && c\.contact\.trim\(\) !== ''/.test(esc), false, '글자인지만 보는 판정이 남아 있다');
  // ② 파기하는 자리도 같은 자를 쓴다 — 상태 코드를 손으로 늘어놓지 않는다.
  assert.match(esc, /if \(isClosedStatus\(t\.status\) && t\.contact\) \{/, '파기 판정이 상태 코드를 직접 늘어놓는다');
  assert.equal(/\(t\.status === 'resolved' \|\| t\.status === 'canceled'\) && t\.contact/.test(esc), false, '손으로 늘어놓은 판정이 남아 있다');
  // ③ 「처음부터 없던 접수」와 「받았다가 파기한 접수」를 구분하는 칸은 그대로다.
  assert.match(esc, /contactPurgedAt\?: string;/, '파기 사실을 남기는 칸이 사라졌다');
});

/**
 * DS 53-2 — 평가의 자료 이름을 **밖에서 적을 수 없는가**(배선 쪽 고정).
 *
 * 가리는 판정(`resolveKb`)이 실제로 가리는지는 런타임 테스트가 돌려서 본다. 라우트는
 * `route.ts` 규칙상 돌려 볼 수 없는 자리이므로(HTTP 메서드·설정 외 export 금지), 「호출자가
 * 보낸 라벨을 넘기지 않는다」·「이름은 지금 KB 에서 찾는다」를 여기서 소스로 고정한다.
 */
test('평가 라우트는 호출자의 라벨을 저장하지 않는다 (DS 53-2)', () => {
  const route = read('src/app/api/feedback/route.ts');
  // ① 이름은 지금 KB 에서 찾는다 — 가리는 자는 `resolveKb` 한 벌이다.
  assert.match(route, /import \{ recordFeedback, resolveKb \} from '@\/lib\/feedback';/, '가리는 자를 끌어오지 않는다');
  assert.match(route, /import \{ kbLabelMap \} from '@\/lib\/tenantKB';/, '이름을 아는 사전을 끌어오지 않는다');
  assert.match(route, /const kb = resolveKb\(kbId\.value, kbLabelMap\(\)\);/, '라우트가 자료를 확인하지 않는다');
  // ② 호출자가 보낸 라벨은 **저장소로 가지 않는다**(길이 검증만 남는다).
  assert.equal(/citation: citation\.value/.test(route), false, '호출자가 보낸 라벨을 그대로 넘긴다');
  assert.equal(/citation: parsed\.data\.citation/.test(route), false, '호출자가 보낸 라벨을 그대로 넘긴다');
  assert.match(route, /\.\.\.\(kb \?\? \{\}\),/, '확인한 자료를 한 쌍으로 넘기지 않는다');

  // ③ 저장소는 그 한 쌍만 적는다 — 복원은 저장분의 이름을 들고 오지 않는다.
  const lib = read('src/lib/feedback.ts');
  assert.match(lib, /export function resolveKb\(kbId: unknown, labels: Record<string, string>\)/, '가리는 자가 저장소에 없다');
  // 이름을 줄일 때는 **줄였다고 적는다** (DS 62-3) — 종전에는 120칸에서 말없이 끊겼다.
  assert.match(lib, /return label \? \{ kbId: id, citation: ellipsize\(label, MAX_CITATION_LEN\) \} : null;/, '모르는 자료 id 를 받아들인다');
  assert.match(lib, /export const DELETED_KB_LABEL = '지워진 자료';/, '이름을 댈 수 없는 줄의 표기가 없다');
  assert.equal(/citation: typeof e\.citation === 'string'/.test(lib), false, '복원이 저장분의 이름을 들고 온다');
});

/**
 * DS 53-3 — 복원이 **매출 귀속을 지우지 않는가**(배선 쪽 고정).
 *
 * 되돌림의 결과는 런타임 테스트가 돌려서 본다. 여기서는 ① 지우던 식이 되살아나지 않는 것
 * ② 「지금 찾을 수 없는 파트너」의 이름이 한 곳에서 오는 것 ③ 그 사실이 복원 기록과 화면에
 * 적히는 것(라우트·콘솔은 돌려 볼 수 없는 자리다)을 고정한다.
 */
test('복원이 매출 귀속을 지우지 않고 그 사실을 적는다 (DS 53-3)', () => {
  const p = read('src/lib/partners.ts');
  // ① 「없는 파트너를 가리키면 직접 계약」으로 되돌리던 식이 남아 있지 않다.
  assert.equal(/ids\.has\(rawPid\) \? rawPid : null/.test(p), false, '귀속을 지우던 식이 남아 있다');
  assert.match(p, /if \(partnerId && !ids\.has\(partnerId\)\) orphans \+= 1;/, '찾을 수 없는 귀속을 세지 않는다');
  // ② 이름은 한 곳에서 온다 — 정산 리포트가 그 함수를 쓴다.
  assert.match(p, /export function missingPartnerName\(id: string\): string \{/, '이름을 적는 자가 없다');
  const settle = read('src/lib/settlement.ts');
  // 귀속 식별자는 DS 57-2 에서 한 줄(`partnerId`)로 묶였다 — 쓰는 자는 그대로 그 함수다.
  assert.match(settle, /const partnerId = a\.partnerId as string;/, '리포트가 귀속 식별자를 집는 자리가 바뀌었다');
  assert.match(settle, /missingPartnerName\(partnerId\)/, '리포트가 이름을 따로 적는다');
  assert.equal(/`\(삭제된 파트너 \$\{a\.partnerId\}\)`/.test(settle), false, '이름이 두 벌로 갈라졌다');
  // ③ 복원 기록과 화면이 그 수를 말한다(조용히 넘기지 않는다).
  const route = read('src/app/api/admin/backup/route.ts');
  assert.match(route, /귀속 파트너 없음 \$\{partners\.orphans\}/, '복원 기록이 그 사실을 말하지 않는다');
  assert.match(route, /orphanAccounts: partners\.orphans/, '응답이 그 수를 싣지 않는다');
  const dash = read('src/app/admin/page.tsx');
  assert.match(dash, /data\.orphanAccounts/, '화면이 그 사실을 말하지 않는다');
  assert.ok(dash.includes('귀속 파트너가 이 파일에 없어 귀속을 그대로 두었습니다'), '화면이 무엇이 그대로인지 말하지 않는다');
  // 손을 써야 하는 안내는 2.5초 뒤 사라지는 알림으로 띄우지 않는다(닫기 버튼이 있는 쪽이다).
  // 55차(DS 55-3)에 「같은 식별자 중복」이 같은 자리에 더해져 문장을 모아 두는 식이 되었다.
  assert.match(dash, /if \(orphans > 0\) \{\s*issues\.push\(/, '귀속 안내가 머무는 안내로 가지 않는다');
  assert.match(dash, /if \(issues\.length > 0\) \{[\s\S]{0,400}?'fail'\);/, '사라지는 알림으로 띄운다');
});

/* ══════════ 51차 재감사 — 되돌아 들어오는 문 (DS 54-x) ══════════ */

/**
 * DS 54-1 — 접수 복원이 저장분을 **통째로 펼치지 않는다**(배선 쪽 고정).
 *
 * 돌려 볼 수 있는 쪽은 `tests/runtime.test.mjs` 가 본다. 여기서 고정하는 것은 **다시 갈라지지
 * 않는가**다: `{...c}` 가 되살아나면 그 뒤로 접수에 칸이 하나 늘 때마다 관문을 지나지 않는
 * 칸이 하나 늘고, 그 사실은 타입 검사에도 테스트에도 걸리지 않는다.
 */
test('접수 복원이 칸을 하나씩 적는다 (DS 54-1)', () => {
  const esc = read('src/lib/escalation.ts');
  const body = esc.slice(esc.indexOf('export function importTickets'), esc.indexOf('export function createTicket'));
  assert.equal(/\.\.\.c,/.test(body), false, '저장분을 통째로 펼치는 식이 남아 있다');
  // 요약도 본문과 같은 관문을 지난다 — 상담원이 실제로 읽는 칸이다.
  assert.match(body, /const brief = maskPii\(String\(c\.summary \?\? ''\)\);/, '요약이 마스킹을 지나지 않는다');
  assert.match(body, /summary: clip\(brief\.text, SUMMARY_TEXT_LEN\)/, '요약에 길이 상한이 없다');
  assert.match(body, /mergeKinds\(Array\.isArray\(c\.piiKinds\) \? c\.piiKinds : \[\], body\.hits, brief\.hits\)/, '요약에서 가린 종류를 세지 않는다');
  // 메모·연락처의 상한은 접수를 만드는 쪽과 같은 수다(이름 없는 숫자를 다시 적지 않는다).
  assert.match(body, /note: clip\(c\.note\.trim\(\), TICKET_NOTE_LEN\)/, '메모에 길이 상한이 없다');
  // 연락처는 표시 없이 상한만 지키되 **글자를 쪼개지 않는다** (DS 62-1) — 「…(이하 생략)」이
  // 섞이면 상담원이 걸 수 없는 번호가 되고, 반쪽 글자도 걸 수 없는 번호다.
  assert.match(body, /cut\(contact, TICKET_CONTACT_LEN\)/, '연락처에 길이 상한이 없다');
  assert.equal(/slice\(0, 100\)/.test(esc), false, '이름 없는 숫자가 남아 있다');
  assert.equal(/\.slice\(0, TICKET_CONTACT_LEN\)/.test(esc), false, '글자를 쪼갤 수 있는 자리가 남아 있다');
});

/**
 * DS 54-2 — 응답 근거 이름을 붙이는 자가 **코드를 되돌려주지 않는가**(화면 쪽 고정).
 *
 * 콘솔은 클라이언트 묶음이라 돌려 볼 수 없는 자리다. 종전에는 같은 사전을 네 자리에서 각각
 * `SOURCE_VIEW_LABELS[x] || x` 로 읽어, 사전에 없는 코드가 최근 대화 표·상세 서랍·응답 테스트
 * 서랍·대시보드 「근거별」 묶음에 글자째 떴다.
 */
test('응답 근거 이름을 붙이는 자가 코드를 되돌려주지 않는다 (DS 54-2)', () => {
  const page = read('src/app/admin/page.tsx');
  assert.match(page, /function sourceView\(source: string\): string \{\n  return SOURCE_VIEW_LABELS\[\(source \|\| ''\)\.trim\(\)\] \|\| SOURCE_VIEW_LABELS\.unknown;/, '화면이 이름을 한 곳에서 붙이지 않는다');
  assert.equal(/SOURCE_VIEW_LABELS\[(t\.source|k)\] \|\|/.test(page), false, '코드를 폴백으로 그리는 식이 남아 있다');
  assert.equal((page.match(/sourceView\(/g) || []).length, 5, '근거를 그리는 자리 수가 달라졌다(선언 1 + 사용 4)');

  const lib = read('src/lib/intents.ts');
  // 어휘는 표시명 사전에서 끌어온다 — 손으로 적은 사본이 생기면 근거가 늘 때 한쪽이 빠진다(DS 40-3).
  assert.match(lib, /export const SOURCE_CODES: ReadonlySet<string> = new Set\(Object\.keys\(SOURCE_LABELS\)\);/, '어휘를 손으로 적어 두었다');
  assert.match(lib, /export const UNKNOWN_SOURCE_LABEL = SOURCE_LABELS\.unknown;/, '이름이 두 벌로 갈라졌다');
  // 표시명은 사람이 읽는 말이다 — 코드를 그대로 적어 두면 사전이 있어도 화면에 코드가 뜬다.
  for (const [code, label] of Object.entries(dictOf(lib, 'SOURCE_LABELS'))) {
    assert.match(label, /[가-힣]/, `${code}: 표시명이 사람 말이 아니다(${label})`);
    assert.notEqual(label, code, `${code}: 표시명이 코드와 같다`);
  }
  // 복원은 어휘 밖의 코드를 **멀쩡한 코드로 바꿔 적지 않는다**(집계가 부풀거나 없던 할 일이 생긴다).
  const logs = read('src/lib/convlog.ts');
  assert.match(logs, /source: SOURCE_CODES\.has\(String\(t\.source\)\) \? t\.source : 'unknown',/, '복원이 근거 코드를 확인하지 않는다');
});

/**
 * DS 54-3 — 복원이 받아들이는 **시각의 모양**이 한 벌인가.
 *
 * 저장소가 넷(대화 기록·변경 이력·평가·접수)인데 시각을 받아 적는 식은 각자 적혀 있었다.
 * 한 곳에만 관문을 세우면 다음 저장소가 또 종전 식을 복사한다.
 */
test('복원이 받아들이는 시각의 모양이 한 벌이다 (DS 54-3)', () => {
  const kst = read('src/lib/kst.ts');
  assert.match(kst, /export function isReadableInstant\(v: unknown\): v is string \{/, '읽을 수 있는 시각을 가리는 자가 없다');
  assert.match(kst, /export function readInstant\(v: unknown, fallback: string\): string \{/, '복원이 쓰는 자가 없다');
  for (const f of ['src/lib/convlog.ts', 'src/lib/audit.ts', 'src/lib/feedback.ts', 'src/lib/escalation.ts']) {
    const s = read(f);
    assert.match(s, /readInstant\(/, `${f}: 복원이 시각 관문을 지나지 않는다`);
    assert.equal(
      /at: typeof \w+\.at === 'string' && \w+\.at \? \w+\.at : new Date\(\)\.toISOString\(\)/.test(s),
      false,
      `${f}: 「문자열이면 그대로」 식이 남아 있다`,
    );
  }
  // 시각을 읽지 못한다고 기록을 버리지 않는다 — 기록 한 줄은 「누가 무엇을 했는가」의 증거다.
  assert.equal(/isReadableInstant\([\w.]+\.at\)\) continue/.test(read('src/lib/audit.ts')), false, '시각을 못 읽은 기록을 버린다');
});

/* ══════════ 52차 재감사 — 귀속의 이름과 날짜 (DS 55-x) ══════════ */

/**
 * DS 55-3 — 파트너·고객사 복원이 **관문 밖에 있었다**(배선 쪽 고정).
 *
 * 되돌림의 결과는 `tests/runtime.test.mjs` 가 돌려서 본다. 여기서 고정하는 것은 **다시 갈라지지
 * 않는가**다: DS 54-3 이 저장소 넷에 세운 시각 관문의 목록에 이 둘이 빠져 있었고, 그래서
 * 종전 식(`typeof x === 'string'`)이 그대로 남아 빈 문자열까지 시각 칸에 박혔다.
 */
test('남은 복원 문도 같은 시각 관문을 지나고 같은 식별자를 두 번 들이지 않는다 (DS 55-3)', () => {
  // ① 시각 관문 — 저장소 목록에 빠진 곳이 없다(DS 54-3 의 넷 + 이번의 둘).
  for (const f of ['src/lib/partners.ts', 'src/lib/adminStore.ts']) {
    const s = read(f);
    assert.match(s, /import \{ readInstant \} from '@\/lib\/kst';/, `${f}: 시각 관문을 불러오지 않는다`);
    assert.equal(/typeof \(?[\w ().]*?\)?\.?createdAt === 'string'/.test(s), false, `${f}: 「문자열이면 그대로」 식이 남아 있다`);
  }
  const p = read('src/lib/partners.ts');
  for (const field of ['createdAt', 'updatedAt']) {
    assert.ok((p.match(new RegExp(`${field}: readInstant\\(`, 'g')) || []).length >= 2, `${field} 가 관문을 지나지 않는 자리가 있다`);
  }
  // ② 귀속 근거는 시각을 읽지 못해도 **버리지 않는다** — 값만 바꾸면 근거가 사라진다는 이 파일의 첫 원칙.
  assert.equal(/\.filter\(\(e\) => e && typeof e === 'object' && typeof e\.at === 'string'\)/.test(p), false, '시각이 글자가 아닌 귀속 이력 줄을 버린다');
  assert.match(p, /\.filter\(\(e\) => e && typeof e === 'object'\)/, '귀속 이력 거르개가 없다');
  assert.match(p, /at: readInstant\(e\.at, now\(\)\),/, '귀속 이력의 시각이 관문을 지나지 않는다');
  // ③ 같은 id 는 먼저 나온 것만 — 그 수를 돌려주고, 라우트가 기록·응답에 싣는다.
  assert.match(p, /if \(ids\.has\(pid\)\) \{ duplicates \+= 1; continue; \}/, '같은 파트너 id 를 두 번 들인다');
  assert.match(p, /if \(accountIds\.has\(aid\)\) \{ duplicates \+= 1; continue; \}/, '같은 고객사 id 를 두 번 들인다');
  assert.match(p, /orphans, duplicates,/, '건너뛴 수를 돌려주지 않는다');
  const route = read('src/app/api/admin/backup/route.ts');
  assert.match(route, /같은 식별자 중복 \$\{partners\.duplicates\}/, '복원 기록이 그 사실을 말하지 않는다');
  assert.match(route, /duplicateEntries: partners\.duplicates/, '응답이 그 수를 싣지 않는다');
  const dash = read('src/app/admin/page.tsx');
  assert.match(dash, /data\.duplicateEntries/, '화면이 그 사실을 말하지 않는다');
  assert.ok(dash.includes('먼저 나온 것만 남기고 건너뛰었습니다'), '무엇을 건너뛰었는지 말하지 않는다');
});

/* ══════════ 디자인 스프린트 — 53차 재감사 (DS 56-1·56-3) ══════════ */

/**
 * DS 56-3 — 파트너·고객사가 **동시 편집 관문의 적용 목록 밖**에 있었다(배선 쪽 고정).
 *
 * 거절·통과의 판정은 `tests/runtime.test.mjs` 가 돌려서 본다. 여기서 고정하는 것은 **두 벌로
 * 갈라지지 않는가**다(DS 42-2): 목록에 실어 보내는 쪽과 저장 직전에 견주는 쪽이 다른 식을
 * 쓰면 영영 어긋나거나(저장이 늘 거절된다) 영영 같아진다(경고가 조용히 사라진다).
 * 라우트는 `route.ts` 규칙상 떼어내 돌릴 수 없어 소스로 고정한다.
 */
test('파트너·고객사도 「내가 본 모습」 관문을 지난다 (DS 56-3)', () => {
  const p = read('src/lib/partners.ts');
  // ① 재는 자는 저장소 안에 **한 벌**이다 — 다른 저장소와 같은 자(`revOf`)를 쓴다.
  assert.match(p, /import \{ revOf \} from '@\/lib\/rev';/, '모습을 재는 자를 불러오지 않는다');
  assert.match(p, /export function accountRev\(a: Account\): string \{/, '고객사의 모습을 재는 자가 없다');
  assert.match(p, /export function partnerRev\(p: Partner\): string \{/, '파트너의 모습을 재는 자가 없다');
  // 스스로 바꾸는 값(시각)·따로 쌓이는 값(귀속 이력)은 모습에 들지 않는다 — 들면 영영 어긋난다.
  const accRev = p.slice(p.indexOf('export function accountRev('), p.indexOf('/** 파트너 한 건의 모습'));
  assert.equal(/createdAt|updatedAt|attribution/.test(accRev), false, '저장이 스스로 바꾸는 값이 모습에 들어 있다');
  // ② 거절 문장은 다른 관문과 **같은 말**이다(DS 46-1 이 한 곳에 모아 둔 문장이다).
  for (const m of ['CHANGED_DELETE_TARGET_MESSAGE', 'CHANGED_TARGET_MESSAGE', 'RESTORE_FORMAT_MESSAGE', 'STALE_TARGET_MESSAGE']) {
    assert.ok(new RegExp(`^  ${m},$`, 'm').test(p), `거절 문장을 따로 적는다: ${m}`);
  }
  assert.equal(/'그 사이 다른 화면에서/.test(p), false, '거절 문장이 두 벌로 갈라졌다');
  // ③ 두 저장 함수와 **삭제**가 모두 그 관문을 지난다(DS 57-1 에서 지우는 자리가 합류했다).
  assert.ok((p.match(/conflictOf\(input\.baseRev,/g) || []).length === 3, '관문을 지나지 않는 쓰기 경로가 있다');
  // ④ 라우트: 목록에 모습을 실어 보내고(견주는 쪽과 같은 함수다), 거절은 **입력 오류와 구분해** 보낸다.
  const route = read('src/app/api/admin/partners/route.ts');
  assert.match(route, /partners: scopePartners\(principal, listPartners\(\)\)\.map\(\(p\) => \(\{ \.\.\.p, rev: partnerRev\(p\) \}\)\)/, '파트너 목록에 모습이 없다');
  assert.match(route, /accounts: queryAccounts\(filter\)\.map\(\(a\) => \(\{ \.\.\.a, rev: accountRev\(a\) \}\)\)/, '고객사 목록에 모습이 없다');
  // 쓰기 셋(파트너 저장·고객사 저장·파트너 삭제)이 모두 거절을 **입력 오류와 구분해** 보낸다.
  assert.ok((route.match(/if \(r\.conflict\) \{/g) || []).length === 3, '거절을 입력 오류와 섞어 보낸다');
  assert.ok((route.match(/conflict: r\.conflict,/g) || []).length === 3, '거절 사유를 싣지 않는 경로가 있다');
  assert.ok((route.match(/current: \{ \.\.\.r\.current, rev: (?:partnerRev|accountRev)\(r\.current\) \}/g) || []).length === 3, '지금 저장된 값을 모습과 함께 보내지 않는다');
  // ⑤ route.ts 규칙 — HTTP 메서드·설정 외의 export 가 늘지 않았다.
  const exports = [...route.matchAll(/^export (?:async function|function|const) (\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(exports.sort(), ['DELETE', 'GET', 'POST', 'dynamic'], `route.ts 에 허용되지 않은 export 가 있다: ${exports}`);
});

/**
 * DS 56-1 — 찾을 수 없는 귀속을 **고치는 문**이 그 귀속을 거절했다(계약 쪽 고정).
 *
 * 동작은 `tests/runtime.test.mjs` 가 돌려서 본다. 여기서 고정하는 것은 그 판정의 **범위**다:
 * 지금 가진 귀속을 그대로 들고 오는 것만 통과시키고, 없는 곳으로 **옮기는** 길은 종전처럼 막는다.
 */
test('귀속은 바꿀 때만 파트너의 존재를 확인한다 (DS 56-1)', () => {
  const p = read('src/lib/partners.ts');
  assert.match(p, /const keepingAttribution = Boolean\(existing && partnerId && existing\.partnerId === partnerId\);/, '지금 가진 귀속인지 보지 않는다');
  assert.match(p, /if \(partnerId && !keepingAttribution && !partners\.some\(\(p\) => p\.id === partnerId\)\) \{/, '귀속을 들고 오기만 해도 거절한다');
  // 종전 식(지금 가진 귀속까지 거절하던 조건)이 남아 있지 않다.
  assert.equal(/if \(partnerId && !partners\.some\(\(p\) => p\.id === partnerId\)\) \{/.test(p), false, '종전 조건이 남아 있다');
});

/* ══════════ 디자인 스프린트 — 54차 재감사 (DS 57-1·57-2) ══════════ */

/**
 * DS 57-1 — 지우는 자리의 관문과 **지워진 것의 기록**(배선 쪽 고정).
 *
 * 동작은 `tests/runtime.test.mjs` 가 돌려서 본다. 여기서 고정하는 것은 라우트다
 * (`route.ts` 규칙상 떼어내 돌릴 수 없다): ① 주소에 실려 온 모습을 저장소에 넘기는 것
 * ② 지워진 파트너의 **이름·수수료율·상태**가 감사 로그에 남는 것 — 지운 뒤에는 그 값이
 * 어디에도 없고, DS 56-1 이 열어 둔 복구 길(「같은 식별자로 다시 등록하기」)에 필요한 값이
 * 하필 그 둘이다. 지어내는 값이 아니라 **지우는 순간에 저장되어 있던 값**이다(§13).
 */
test('파트너 삭제가 모습을 받고 무엇을 지웠는지 기록한다 (DS 57-1)', () => {
  const route = read('src/app/api/admin/partners/route.ts');
  const del = route.slice(route.indexOf('export async function DELETE('));
  assert.ok(del.length > 0, 'DELETE 를 찾지 못했다');
  // ① 주소에 실려 온 모습을 그대로 넘긴다(보내지 않으면 종전처럼 지운다 — 옵트인).
  assert.match(del, /deletePartner\(id\.value, \{ baseRev: req\.nextUrl\.searchParams\.get\('baseRev'\) \}\)/, '삭제가 모습을 받지 않는다');
  // ② 「무엇을 지웠는가」를 적는다 — 식별자만 남기지 않는다.
  assert.match(del, /action: 'partner\.delete'/, '감사 기록이 사라졌다');
  // 이름을 줄일 때는 **줄였다고 적는다** (DS 62-3) — 영구히 남는 기록이고 정산 분쟁에서
  // 꺼내는 글이라, 줄인 이름이 이름의 전부인 것처럼 읽히면 안 된다.
  assert.match(del, /detail: `삭제: \$\{ellipsize\(r\.partner\.name, AUDIT_PART_LEN\)\} \/ 수수료율 \$\{feeRateWords\(r\.partner\.feeRateBp\)\} \/ \$\{PARTNER_STATUS_LABELS\[r\.partner\.status\]\}`/, '지운 파트너의 이름·수수료율·상태를 적지 않는다');
  // ③ 사람이 읽는 기록에 내부 단위(bp)·코드 어휘를 적지 않는다(DS 2-12·29-3).
  assert.equal(/detail: [^\n]*feeRateBp\}/.test(del), false, '기록에 내부 단위가 새어 나간다');
  // ④ 수수료율을 사람 말로 바꾸는 자는 **저장소 쪽 한 벌**이다(라우트가 따로 적지 않는다).
  const p = read('src/lib/partners.ts');
  assert.match(p, /export function feeRateWords\(bp: number \| null \| undefined\): string \{/, '수수료율을 말로 적는 자가 없다');
  assert.match(route, /import \{[\s\S]*?\bfeeRateWords,/, '라우트가 그 자를 쓰지 않는다');
  // ⑤ route.ts 규칙 — 허용된 export 넷만 있다.
  const exports = [...route.matchAll(/^export (?:async function|function|const) (\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(exports.sort(), ['DELETE', 'GET', 'POST', 'dynamic'], `route.ts 에 허용되지 않은 export 가 있다: ${exports}`);
});

/**
 * DS 57-2 — 제외 사유를 재는 자가 **한 벌**인지(계약 쪽 고정).
 *
 * 건수는 `tests/runtime.test.mjs` 가 돌려서 본다. 여기서 고정하는 것은 ① 대상 판정과 제외
 * 사유가 **같은 함수** 하나에서 나오는 것(두 벌로 적으면 「대상이 아닌데 사유도 없는 건」이
 * 다시 생긴다) ② 사유 문장을 **리포트가** 적는 것(화면이 다시 적으면 표와 주석이 갈라진다).
 */
test('정산 제외 사유는 한 자가 재고 리포트가 적는다 (DS 57-2)', () => {
  const s = read('src/lib/settlement.ts');
  // ① 판정은 한 곳이다 — 종전의 참/거짓 판정자(`eligible`)는 남아 있지 않다.
  assert.match(s, /function exclusionOf\(a: Account, periodEnd: string\): SettlementExclusion \| null \{/, '사유를 재는 자가 없다');
  assert.equal(/function eligible\(/.test(s), false, '종전 판정자가 남아 있다(두 벌이 된다)');
  assert.ok((s.match(/exclusionOf\(a, periodEnd\)/g) || []).length === 1, '판정을 두 번 한다');
  // ② 다섯 사유가 모두 세어지고 문장을 가진다(세기만 하고 말하지 않는 사유를 만들지 않는다).
  const kinds = ['direct', 'churned', 'prospect', 'no_contract_date', 'after_period'];
  for (const k of kinds) {
    assert.ok(new RegExp(`^  ${k}: \\(n\\) =>`, 'm').test(s), `사유 문장이 없다: ${k}`);
    assert.ok(new RegExp(`'${k}'`).test(s), `사유를 재지 않는다: ${k}`);
  }
  assert.match(s, /const EXCLUSION_ORDER: SettlementExclusion\[\] = \['direct', 'churned', 'prospect', 'no_contract_date', 'after_period'\];/, '사유 순서가 고정되지 않았다');
  // ③ 사실이 아닌 한 덩이 문장이 남아 있지 않다(해지를 「아직 계약 상태가 아니」라고 적던 자리).
  //    주석은 그 문장을 **왜 고쳤는지** 적고 있으므로 떼어내고 본다.
  const code = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/아직 계약 상태가 아니거나/.test(code), false, '종전 문장이 남아 있다');
  assert.equal(/notYetContracted|directExcluded/.test(code), false, '종전 계수기가 남아 있다');
  // ④ 「조회 = 대상 + 제외」를 리포트가 적는다 — 화면이 더하거나 빼지 않는다.
  assert.match(s, /조회한 고객사 \$\{all\.length\}곳 = 정산 대상 \$\{rows\.length\}곳 \+ 제외 \$\{excludedTotal\}곳\./, '수를 맞춰 적지 않는다');
  const page = read('src/app/admin/page.tsx');
  const notes = page.slice(page.indexOf('function SettleNotes('), page.indexOf('interface RollupView'));
  assert.equal(/excluded|churned|prospect/.test(notes), false, '화면이 사유를 다시 센다');
});

/* ══════════ 디자인 스프린트 — 55차 재감사 (DS 58-1·58-2·58-3) ══════════ */

/**
 * DS 58-1 — 보관 경계를 **앞으로만** 옮기는 자가 한 벌인지(배선 쪽 고정).
 *
 * 건수·문장은 `tests/runtime.test.mjs` 가 돌려서 본다. 여기서 고정하는 것은 ① 경계를 뒤로
 * 물리는 대입이 소스에 **남아 있지 않은** 것 ② 경계보다 앞선 줄을 세는 자리가 한 곳인 것
 * ③ 두 내려받기 파일의 꼬리 문장이 여전히 **한 벌**(`@/lib/retention`)인 것이다.
 */
test('보관 경계는 앞으로만 가고, 섞인 구간을 한 벌로 말한다 (DS 58-1)', () => {
  const a = read('src/lib/audit.ts');
  // ① 경계를 옮기는 문은 하나다 — 손으로 대입하는 자리가 남아 있으면 다시 뒤로 물린다.
  assert.match(a, /function advanceKnownFrom\(at: string \| undefined\): void \{\n\s*if \(at && at > knownFrom\) knownFrom = at;/, '경계를 앞으로만 옮기는 문이 없다');
  const code = a.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/knownFrom = events\[0\]\?\.at \|\| knownFrom;/.test(code), false, '경계를 뒤로 물리는 대입이 남아 있다');
  // 경계를 **직접 적는** 자리는 둘뿐이다: 비우는 문(`resetAudit`)과 통째로 갈아 끼우는 문
  // (`importAudit` — 파일이 적어 둔 값, 없으면 짐작). 그 밖에서는 앞으로 옮기는 문만 쓴다.
  assert.equal((code.match(/^\s*knownFrom = /gm) || []).length, 2, '경계를 직접 적는 자리가 늘었다(뒤로 물릴 수 있다)');
  assert.match(code, /export function resetAudit\(\): void \{[\s\S]{0,200}?knownFrom = new Date\(\)\.toISOString\(\);/, '비우는 문이 경계를 되돌리지 않는다');
  assert.match(code, /knownFrom = isReadableInstant\(saved\) \? readInstant\(saved, ''\) : events\[0\]\?\.at \|\| new Date\(\)\.toISOString\(\);/, '보관 파일이 적어 둔 경계를 읽지 않는다');
  assert.match(a, /knownFrom\?: string;/, '보관 파일이 경계를 적지 않는다');
  assert.match(a, /return \{ version: 1, savedAt: new Date\(\)\.toISOString\(\), seq, knownFrom, events:/, '내보내는 파일에 경계가 없다');
  // 사람이 올린 백업의 경계는 **쓰지 않는다** — 합치는 문은 목록만 읽는다(남의 경계다).
  const merge = a.slice(a.indexOf('export function mergeAudit('), a.indexOf('// 기동 시 복원'));
  assert.equal(/\.knownFrom/.test(merge.replace(/\/\*[\s\S]*?\*\//g, '')), false, '합치기가 남의 경계를 받아 적는다');
  // ② 섞인 구간을 세는 자리도 하나다 — 한도에 걸려 버려지면 그 표시도 사라져야 한다.
  assert.match(a, /function syncMergedFrom\(\): void \{\n\s*const oldest = events\[0\]\?\.at;\n\s*mergedFrom = oldest && oldest < knownFrom \? oldest : null;/, '섞인 구간을 세는 자가 없다');
  assert.match(a, /function trimToLimit\(\): void \{[\s\S]{0,260}?syncMergedFrom\(\);\n\}/, '버린 뒤에 다시 세지 않는다');
  // ③ 평소에는 그 칸이 **없다** — 「섞이지 않았다」를 빈 값으로 말하지 않는다(모수의 모양이 한 벌이다).
  assert.match(a, /\.\.\.\(mergedFrom \? \{ mergedFrom \} : \{\}\)/, '섞이지 않았을 때도 칸을 만든다');
  // ④ 꼬리 문장은 한 벌이다 — 대화 기록 CSV 와 변경 이력 CSV 가 같은 틀을 쓴다(DS 48-1).
  const r = read('src/lib/retention.ts');
  assert.match(r, /mergedFrom\?: string;/, '보관 범위에 섞인 구간이 없다');
  assert.match(r, /const merged = r\.mergedFrom && r\.mergedFrom < r\.knownFrom \? r\.mergedFrom : '';/, '섞인 구간을 가리는 자가 없다');
  assert.ok(r.includes('이후의 기록만 담겨 있습니다'), '섞이지 않았을 때의 종전 문장이 사라졌다');
  assert.ok(r.includes('이후의 기록은 빠진 것이 없습니다'), '섞였을 때 경계 이후를 말하지 않는다');
  for (const f of ['src/lib/audit.ts', 'src/lib/convlog.ts']) {
    assert.match(read(f), /retentionNotes\(/, `${f}: 모수를 제 손으로 적는다`);
  }
  // 대화 기록은 합치는 문이 없다 — 그 쪽에 섞인 구간 계산을 베껴 두지 않는다.
  assert.equal(/mergedFrom/.test(read('src/lib/convlog.ts')), false, '합치지 않는 저장소가 섞인 구간을 들고 있다');
});

/**
 * DS 58-2 — 「근거가 있었다」는 사실만 복원하고 **글은 들고 오지 않는** 배선 고정.
 *
 * DS 53-2 의 판단(저장분의 근거 이름을 복원하지 않는다)을 뒤집지 않는 것이 이 항목의 조건이다.
 * 집계·화면 문장은 `tests/runtime.test.mjs`·`tests/console.test.mjs` 가 본다.
 */
test('복원이 근거 이름이 아니라 사실만 들고 온다 (DS 58-2)', () => {
  const f = read('src/lib/feedback.ts');
  // ① 복원은 이름 칸을 **빈 글자로** 적는다(종전 그대로) — 그리고 사실 하나만 더 들고 온다.
  assert.match(f, /citation: '',/, '복원이 저장분의 이름을 들고 온다');
  assert.match(f, /const citationLost = !kbId && \(e\.citationLost === true \|\| \(typeof e\.citation === 'string' && Boolean\(e\.citation\.trim\(\)\)\)\);/, '근거가 있었다는 사실을 세지 않는다');
  assert.match(f, /\.\.\.\(citationLost \? \{ citationLost: true as const \} : \{\}\)/, '없을 때도 칸을 만든다');
  // ② 세 표기가 모두 **서로 다른 글자**다(같으면 화면이 가릴 수 없다).
  const labels = ['NO_CITATION_LABEL', 'DELETED_KB_LABEL', 'UNKNOWN_KB_LABEL']
    .map((n) => (f.match(new RegExp(`export const ${n} = '([^']+)'`)) || [])[1]);
  assert.ok(labels.every(Boolean), `표기가 빠졌다: ${labels}`);
  assert.equal(new Set(labels).size, 3, `같은 말로 적는 사실이 있다: ${labels}`);
  // ③ 묶음 열쇠는 세 갈래다 — id · 되돌리지 못한 복원분 · 라벨(근거 없음 포함).
  assert.match(f, /\? 'lost:'/, '되돌리지 못한 평가를 따로 모으지 않는다');
  assert.match(f, /const lost = key === 'lost:';/, '줄의 사유를 열쇠에서 읽지 않는다');
  // ④ 새로 들어오는 평가에는 이 칸이 붙지 않는다 — 창구는 이름과 id 를 한 쌍으로만 적는다.
  const record = f.slice(f.indexOf('export function recordFeedback('), f.indexOf('export function listFeedback('));
  assert.equal(/citationLost/.test(record), false, '지금 들어온 평가에 「되돌리지 못함」을 적는다');
  assert.match(read('src/app/api/feedback/route.ts'), /\.\.\.\(kb \?\? \{\}\)/, '창구가 이름과 id 를 한 쌍으로 적지 않는다');
});

/**
 * DS 58-3 — 거르는 규칙과 **세는 규칙**이 한 벌인지(배선 쪽 고정).
 *
 * 종전에는 `documentToCandidates` 가 거르면서 아무것도 돌려주지 않았다. 세는 자리를 따로
 * 적으면 「후보 수 + 빠진 수 ≠ 조각 수」가 되는 날이 온다 — 그때는 화면이 거짓을 적는다.
 */
test('문서 업로드에서 거르는 자와 세는 자가 한 벌이다 (DS 58-3)', () => {
  const i = read('src/lib/ingest.ts');
  // ① 거르는 곳은 한 곳이다 — 종전의 `.filter(...)` 사본이 남아 있지 않다.
  assert.match(i, /export function ingestDocument\(raw: string, opts: IngestOptions\): IngestResult \{/, '세어 돌려주는 문이 없다');
  assert.match(i, /if \(keywords\.length === 0\) \{/, '거르는 자리가 없다');
  assert.equal(/\.filter\(\(c\) => c\.keywords\.length > 0\)/.test(i), false, '세지 않고 거르는 사본이 남아 있다');
  // ② 종전 이름은 **그 문을 지난다**(부르는 쪽을 한꺼번에 바꾸지 않아도 수가 어긋나지 않는다).
  assert.match(i, /export function documentToCandidates\(raw: string, opts: IngestOptions\): KBCandidate\[\] \{\n\s*return ingestDocument\(raw, opts\)\.candidates;\n\}/, '종전 이름이 따로 거른다');
  // ③ 빠진 조각에는 **본문 전체가 아니라 단서만** 담긴다(찾는 데 필요한 만큼이다).
  const dropped = i.slice(i.indexOf('export interface DroppedChunk {'), i.indexOf('export interface IngestResult {'));
  assert.deepEqual(
    [...dropped.matchAll(/^  (\w+):/gm)].map((m) => m[1]),
    ['index', 'heading', 'chars', 'head'],
    '빠진 조각이 담는 칸이 달라졌다',
  );
  // 줄이는 자는 한 곳이고 너비도 한 수다 (DS 62-2) — 종전에는 이 자리(41자)와 대표 질문을
  // 만드는 자리(40자)가 각각 다르게 잘랐고, 주석에는 둘 다 「40자」라 적혀 있었다.
  assert.match(i, /head: ellipsize\(flat, DOC_HEAD_LEN\),/, '줄였으면 줄였다고 말하지 않는다');
  assert.match(i, /export const DOC_HEAD_LEN = 40;/, '첫머리 너비가 단일 출처에 없다');
  assert.equal(/length > 40 \?/.test(i), false, '손으로 자르는 자리가 남아 있다');
  // ④ 라우트에만 export 가 늘지 않았다(★ 안전 원칙 — HTTP 메서드·설정 외 export 금지).
  const route = read('src/app/api/admin/kb/import/route.ts');
  const exports = [...route.matchAll(/^export (?:async function|function|const) (\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(exports.sort(), ['POST', 'dynamic'], `route.ts 에 허용되지 않은 export 가 있다: ${exports}`);
});

/* ══════════ 59순위 — 백로그 소진 후 56차 재감사 (DS 59-x) ══════════ */

/**
 * DS 59-1·59-2 — 고객사 페이지 위에서의 배선.
 * 「정말 그렇게 도는가」는 `tests/widget.test.mjs`(DS 59-1·59-2)가 embed.js 를 실제로 돌려 본다.
 * 여기서는 **두 쪽이 맞물리는 자리**만 고정한다 — 한쪽만 고치면 조용히 어긋나는 것들이다.
 */
test('고객사 페이지에 붙는 쪽의 배선이 한 벌로 맞물린다 (DS 59-1·59-2)', () => {
  const e = read('public/embed.js');
  // ① 인쇄에서 빠지는 이름과 그 이름을 거는 규칙이 같은 글자다.
  assert.match(e, /iframe\.setAttribute\('data-gowon-chat', 'frame'\);/, '프레임에 식별 속성이 없다');
  assert.match(e, /\[data-gowon-chat="frame"\]\{display:none !important\}/, '인쇄 규칙이 그 속성을 걸지 않는다');
  assert.match(e, /printStyle\.setAttribute\('media', 'print'\);/, '화면에도 적용되는 규칙을 붙인다');
  // 우리 화면의 인쇄 규칙(globals.css)은 콘솔만 덮는다 — 고객사 페이지는 이쪽이 유일한 자리다.
  assert.equal(/gowon-chat/.test(read('src/app/globals.css')), false, '고객사 페이지 규칙이 우리 CSS 에 섞였다');

  // ② 검사하지 않은 값이 style 문자열에 실리지 않는다(세미콜론 한 글자가 배치를 덮던 자리).
  assert.match(e, /var zIndex = \/\^\[0-9\]\{1,10\}\$\/\.test\(zRaw\) \? zRaw : Z_DEFAULT;/, '쌓임 순서를 검사하지 않는다');
  assert.equal(/attr\('data-z'[^\n]*\n\s*(var|iframe)\.?style/.test(e), false, '적어 준 값이 곧바로 style 로 간다');

  // ③ 버린 값은 **설치한 사람이 보는 자리**에만 적는다(방문자 화면에는 한 글자도 적지 않는다).
  assert.match(e, /function warn\(msg\) \{/, '버린 사실을 적는 자리가 없다');
  assert.match(e, /window\.console\.warn\('\[GOWON 상담창\] ' \+ msg\)/, '어느 스크립트가 적은 말인지 알 수 없다');
  assert.equal(/document\.body\.appendChild\(document\.createTextNode/.test(e), false, '방문자 화면에 글자를 적는다');

  // ④ 위젯은 **무엇으로 떴는지**를 준비 신호에 싣는다 — embed.js 가 요청한 값과 견주는 유일한 단서다.
  const w = read('src/components/ChatWidget.tsx');
  assert.match(w, /\{ source: 'gowon-chat', type: 'ready', tenant: tenant \? tenant\.id : null \}/, '적용된 고객사를 알리지 않는다');
  assert.match(e, /checkTenant\(d\.tenant\)/, '호스트가 그 값을 보지 않는다');
  assert.match(e, /if \(typeof applied === 'undefined'\) return;/, '옛 위젯을 틀렸다고 말한다');

  // ⑤ 공개 계약(data-tenant·data-position)은 그대로다.
  assert.match(e, /attr\('data-position', 'right'\)/, 'data-position 옵션 계약이 깨졌다');
  assert.match(e, /data-tenant/, 'data-tenant 옵션 계약이 깨졌다');
  assert.match(e, /tenant: tenant \|\| null,/, '__gowonChat.tenant 계약이 깨졌다');
});

/* ══════════ 60순위 — 백로그 소진 후 57차 재감사 (DS 60-1·60-2·60-3) ══════════ */

/**
 * DS 60-1·60-2·60-3 — 사람이 읽는 **시각·수**를 런타임의 Intl 에 맡긴 자리가 남지 않았는가.
 *
 * 이 저장소는 그 판단을 이미 한 자리에서 내려 두었다(`lib/kakao.ts` — 천 단위 쉼표를 손으로
 * 넣는다). 그런데 나머지 자리는 전부 `toLocale*` 이었다: 콘솔의 시각(브라우저 시간대 · 연도 없음 ·
 * 영문 AM/PM), 위젯 말풍선의 시각, 서버가 만들어 보내는 거절 문장의 자릿수. 어느 글자가 될지
 * 배포 환경에 달려 있는 상태를 다시 만들지 않도록 **호출 0건**을 고정한다.
 */
test('사람이 읽는 시각·수를 Intl 서식에 맡기지 않는다 (DS 60-1·60-2·60-3)', () => {
  const FILES = [
    'src/app/admin/page.tsx',
    'src/components/ChatWidget.tsx',
    'src/lib/kakao.ts',
    'src/lib/refusal.ts',
    'src/lib/partners.ts',
    'src/lib/kst.ts',
    'src/lib/num.ts',
    'src/lib/retention.ts',
    'src/lib/audit.ts',
    'src/lib/convlog.ts',
    'src/lib/settlement.ts',
    'src/app/page.tsx',
    'public/embed.js',
  ];
  for (const f of FILES) {
    // 주석·문서의 설명 문장은 센 자리가 아니다 — 호출만 센다(템플릿 문자열 안의 설명도 비운다).
    const calls = read(f).replace(/`[^`]*`/g, '``').match(/\.toLocale(String|TimeString|DateString)\(/g) || [];
    assert.deepEqual(calls, [], `${f} 에 Intl 서식이 남아 있다: ${calls.join(', ')}`);
  }
});

/** DS 60-1 — 화면의 시각은 파일의 시각에서 **초만 뗀 것**이다(식을 두 벌로 적지 않는다). */
test('화면에 적는 시각이 파일의 식에서 나온다 (DS 60-1)', () => {
  const k = read('src/lib/kst.ts');
  // `kstMinute` 는 자기 계산을 하지 않는다 — `kstDateTime` 하나를 지나간다.
  const i = k.indexOf('export function kstMinute(');
  assert.ok(i > 0, 'kstMinute 가 없다');
  const body = k.slice(i, k.indexOf('\n}', i));
  assert.match(body, /kstDateTime\(at\)/, '시각 계산을 두 벌로 적었다');
  assert.equal(/KST_OFFSET_MS/.test(body), false, '오프셋 계산을 또 적었다');
  assert.match(k, /export const KST_SCREEN_NOTE = /, '화면이 말할 시각 기준 문장이 없다');
});

/** DS 60-3 — 수를 끊어 적는 자는 `lib/num` 하나이고, 쓰는 쪽이 그것을 불러온다. */
test('수를 끊어 적는 자가 lib/num 하나다 (DS 60-3)', () => {
  const n = read('src/lib/num.ts');
  assert.match(n, /export function comma\(n: number\): string/, 'comma 를 내보내지 않는다');
  // Intl 을 쓰지 않으므로 서버·브라우저·테스트가 같은 글자를 낸다.
  assert.equal(/Intl|toLocale/.test(n.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), false, 'lib/num 이 Intl 에 기댄다');
  for (const f of ['src/lib/kakao.ts', 'src/lib/refusal.ts', 'src/lib/partners.ts']) {
    assert.match(read(f), /import \{ comma(?:, [\w, ]+)? \} from '@\/lib\/num';/, `${f} 가 수를 제 식으로 적는다`);
  }
  // 콘솔은 lib 을 불러오지 않는 규약이라 사본을 들고 있다(값 대조는 tests/console.test.mjs).
  assert.match(read('src/app/admin/page.tsx'), /^function comma\(n: number\): string \{$/m, '콘솔에 사본이 없다');
});

/* ══════════ 61순위 — 백로그 소진 후 58차 재감사 (DS 61-1·61-2·61-3) ══════════ */

/**
 * DS 61-1·61-2·61-3 — 값 뒤에 조사를 **글자로 박아 둔 자리**가 남지 않았는가.
 *
 * 조사를 고르는 자(`josa`)는 29차에 이미 세워 두었다. 그런데 **고객·운영자에게 보이는 글**에서
 * 그 자를 지나지 않고 손으로 적은 자리가 아홉 있었다 — 접수번호(`${prevId}는`·`{id}로`),
 * 가린 연락처(`${masked}가`·`${masked}로`), 접수 폼 이름(`${form.title}를`), 운영자가 적은
 * 규칙 키워드·이름(`「${keyword}」는`·`「${label}」이`). 그 값들은 모두 숫자·영문·운영자 입력으로
 * 끝나므로 한쪽으로 박아 두면 **절반 가까이가 틀린 글자**가 된다.
 *
 * 다시 생기는 것을 막는 자리다 — 사람이 읽는 글을 적는 다섯 파일에 그 모양이 0건임을 고정한다.
 */
test('사람이 읽는 글에 조사를 글자로 박아 두지 않는다 (DS 61-1·61-2·61-3)', () => {
  const FILES = [
    'src/lib/chat.ts',
    'src/lib/kakao.ts',
    'src/lib/refusal.ts',
    'src/lib/slots.ts',
    'src/lib/retention.ts',
    'src/components/ChatWidget.tsx',
    'src/app/admin/page.tsx',
  ];
  for (const f of FILES) {
    // 주석은 센 자리가 아니다 — 블록 주석·줄 주석을 먼저 걷어낸다.
    const code = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    // 값 바로 뒤(닫는 괄호·따옴표 하나는 넘겨 가며)에 조사가 붙은 자리.
    // 「건」·「가지」·「번째」 같은 셈말은 조사가 아니다 — 조사 다음이 공백·문장부호인 자리만 센다.
    const hits = code.match(/\}[」』'"]?(은|는|을|를|이|가|으로|와|과)[\s.,·—]/g) || [];
    assert.deepEqual(hits, [], `${f} 에 손으로 적은 조사가 남았다: ${hits.join(' / ')}`);
  }
});

/** DS 61-1 — 조사를 고르는 자는 `lib/refusal` 하나이고, 쓰는 쪽이 그것을 불러온다. */
test('조사를 고르는 자가 lib/refusal 하나다 (DS 61-1)', () => {
  const r = read('src/lib/refusal.ts');
  assert.match(r, /export function batchimOf\(word: string\): Batchim \| null/, 'batchimOf 를 내보내지 않는다');
  assert.match(r, /export function particle\(word: string, withBatchim: string, withoutBatchim: string\): string/, 'particle 을 내보내지 않는다');
  // `josa` 는 제 판정을 하지 않는다 — `particle` 하나를 지나간다(식을 두 벌로 적지 않는다).
  const i = r.indexOf('export function josa(');
  assert.ok(i > 0, 'josa 가 없다');
  const body = r.slice(i, r.indexOf('\n}', i));
  assert.match(body, /particle\(word, withBatchim, withoutBatchim\)/, '조사 판정을 두 벌로 적었다');
  assert.equal(/0xac00|charCodeAt/.test(body), false, '받침 계산을 또 적었다');
  // ㄹ 받침은 「으」로 시작하는 짝에서만 받침 없는 쪽이다 — 그 예외가 한 곳에 있다.
  assert.match(r, /withBatchim\.startsWith\('으'\)/, 'ㄹ 받침 예외가 없다');

  // 서버에서 글을 만드는 쪽은 lib 을 불러온다(같은 묶음에서 거절 문장도 함께 가져온다 · DS 70-2).
  for (const f of ['src/lib/chat.ts', 'src/lib/kakao.ts', 'src/lib/slots.ts', 'src/lib/retention.ts']) {
    assert.match(read(f), /import \{[^}]*\bjosa\b[^}]*\} from '@\/lib\/refusal';/, `${f} 가 조사를 제 식으로 고른다`);
  }
  // 콘솔·위젯은 lib 을 불러오지 않는 규약이라 사본을 들고 있다
  // (값 대조는 tests/console.test.mjs · tests/widget.test.mjs).
  for (const f of ['src/app/admin/page.tsx', 'src/components/ChatWidget.tsx']) {
    assert.match(read(f), /function batchimOf\(word: string\): 'none' \| 'rieul' \| 'other' \| null \{/, `${f} 에 사본이 없다`);
    assert.match(read(f), /원본은 `src\/lib\/refusal\.ts`/, `${f} 가 사본임을 밝히지 않는다`);
  }
});

/* ══════════ 62순위 — 백로그 소진 후 59차 재감사 (DS 62-1·62-2·62-3) ══════════ */

/**
 * DS 62-1·62-2 — **글을 자르는 자가 한 곳인가**.
 *
 * 「정말 글자를 쪼개지 않는가」는 `tests/runtime.test.mjs`(DS 62-1)가 바이트로 돌려서 본다.
 * 여기서는 ① 자르는 식이 `lib/limits` 한 곳에 있는 것 ② 사람이 읽는 글을 적는 파일에서 손으로
 * 자른 뒤 `…` 를 붙이는 자리가 **0건**인 것 ③ 너비 숫자가 이름을 가진 것을 고정한다.
 * (다시 생기는 것을 막는 자리다 — 새 목록 한 줄이 `slice(0, 40) + '…'` 로 들어오면 걸린다.)
 */
test('글을 자르는 자가 한 곳에서 온다 (DS 62-1·62-2)', () => {
  const limits = read('src/lib/limits.ts');
  // 쪼개지지 않는 자리를 고르는 식은 한 벌이다 — 세 자(`cut`·`clip`·`ellipsize`)가 그것을 지난다.
  assert.match(limits, /export function cutEnd\(text: unknown, limit: number\): number \{/, '자르는 자리를 고르는 자가 없다');
  assert.match(limits, /export function cut\(text: unknown, limit: number\): string \{/, '표시 없이 상한만 지키는 자가 없다');
  assert.match(limits, /export function ellipsize\(text: unknown, limit: number\): string \{/, '화면용으로 줄이는 자가 없다');
  assert.match(limits, /export const ELLIPSIS = '…';/, '화면 표시가 단일 출처에 없다');
  for (const fn of ['cut', 'clip', 'ellipsize']) {
    const i = limits.indexOf(`export function ${fn}(`);
    const body = limits.slice(i, limits.indexOf('\n}', i));
    assert.match(body, /cutEnd\(/, `${fn} 이 자르는 자리를 제 식으로 고른다`);
  }
  // 상한 세 벌(묶음 판정표)이 두 곳에 적히지 않았다 — 한쪽만 고치면 콘솔과 서버가 갈라진다.
  assert.equal((limits.match(/const JOINS_LEFT = /g) || []).length, 1, '묶음 판정표가 두 벌로 적혀 있다');

  // ── 사람이 읽는 글을 적는 파일에 손으로 자르는 자리가 남지 않았다.
  const FILES = [
    'src/lib/kakao.ts', 'src/lib/knowledge.ts', 'src/lib/ingest.ts', 'src/lib/handoff.ts',
    'src/lib/llm.ts', 'src/lib/feedback.ts', 'src/lib/escalation.ts', 'src/lib/audit.ts',
    'src/app/admin/page.tsx',
  ];
  for (const f of FILES) {
    const code = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const hits = code.match(/\.slice\(0,[^)\n]*\)[^\n]{0,8}…/g) || [];
    assert.deepEqual(hits, [], `${f}: 손으로 자른 뒤 표시를 붙이는 자리가 남았다 — ${hits.join(' / ')}`);
  }

  // ── 너비 숫자는 이름을 가진다(이름 없는 숫자는 입구마다 갈라진다 — 이 파일이 생긴 까닭이다).
  assert.match(read('src/lib/ingest.ts'), /ellipsize\(firstLine, DOC_HEAD_LEN\)/, '대표 질문이 제 숫자로 자른다');
  assert.match(read('src/lib/kakao.ts'), /export const KAKAO_LABEL_LEN = 14;/, '바로가기 라벨 너비에 이름이 없다');
  assert.match(read('src/lib/kakao.ts'), /ellipsize\(s\.question, KAKAO_LABEL_LEN\)/, '바로가기 라벨이 제 식으로 자른다');
  // 말풍선 나누기의 마지막 길도 쪼개지지 않는 자리에서 끊는다(종전에는 `return room`).
  const kakao = read('src/lib/kakao.ts');
  assert.match(kakao, /const win = text\.slice\(0, cutEnd\(text, room\)\);/, '말풍선 나누기가 칸으로 끊는다');
  assert.equal(/^  return room;$/m.test(kakao), false, '상한을 그대로 돌려주는 자리가 남았다');
});

/**
 * DS 62-3 — 기록에 **운영자가 적은 이름**을 싣는 다섯 라우트가 같은 자를 지나는가.
 * (감사 로그는 영구히 남고 정산 분쟁에서 꺼내는 글이다 — 줄였다는 사실이 없으면 줄인 이름이
 * 이름의 전부인 것처럼 읽힌다. 「정말 표시가 남는가」는 runtime.test.mjs 가 돌려서 본다.)
 */
test('관리 작업 기록이 이름을 손으로 끊지 않는다 (DS 62-3)', () => {
  const limits = read('src/lib/limits.ts');
  for (const name of ['AUDIT_TARGET_LEN', 'AUDIT_DETAIL_LEN', 'AUDIT_NAME_LEN', 'AUDIT_PART_LEN']) {
    assert.match(limits, new RegExp(`export const ${name} = \\d+;`), `${name} 이 단일 출처에 없다`);
  }
  // 저장 상한은 `clip`(표시를 상한 안에 담는다) — 쓰는 쪽과 복원하는 쪽이 같은 자다.
  const audit = read('src/lib/audit.ts');
  assert.equal((audit.match(/clip\(e?\.?[a-z.?\s']*target[^)]*AUDIT_TARGET_LEN\)/g) || []).length, 2, '쓰는 쪽과 복원하는 쪽이 갈라졌다(대상)');
  assert.equal((audit.match(/clip\([^)]*AUDIT_DETAIL_LEN\)/g) || []).length, 2, '쓰는 쪽과 복원하는 쪽이 갈라졌다(내용)');
  const auditCode = audit.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert.equal(/slice\(0, (100|300)\)/.test(auditCode), false, '이름 없는 숫자가 남아 있다');

  // 라우트가 싣는 이름은 `ellipsize`(한 글자로 말한다) — 좁은 칸에서 내용이 사라지지 않게.
  const ROUTES = {
    'src/app/api/admin/kb/route.ts': [/ellipsize\(result\.entry\.question, AUDIT_NAME_LEN\)/],
    'src/app/api/admin/rules/route.ts': [/ellipsize\(result\.rule\.label, AUDIT_NAME_LEN\)/],
    'src/app/api/admin/kb/import/route.ts': [/ellipsize\(title\.value, AUDIT_NAME_LEN\)/],
    'src/app/api/admin/partners/route.ts': [
      /ellipsize\(r\.partner\.name, AUDIT_PART_LEN\)/,
      /ellipsize\(r\.account\.name, AUDIT_PART_LEN\)/,
      /ellipsize\(last\.note, AUDIT_PART_LEN\)/,
    ],
  };
  for (const [f, pats] of Object.entries(ROUTES)) {
    const s = read(f);
    assert.match(s, /from '@\/lib\/limits'/, `${f} 가 자르는 자를 끌어오지 않는다`);
    for (const p of pats) assert.match(s, p, `${f}: ${p} 가 없다`);
    assert.equal(/\.slice\(0, (40|60)\)/.test(s), false, `${f} 에 말없이 끊는 자리가 남았다`);
    // ★ 안전 원칙 — route.ts 에 HTTP 메서드·설정 외 export 가 늘지 않았다.
    const exports = [...s.matchAll(/^export (?:async function|function|const) (\w+)/gm)].map((m) => m[1]);
    const allowed = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'dynamic', 'revalidate', 'runtime', 'fetchCache', 'maxDuration']);
    for (const e of exports) assert.ok(allowed.has(e), `${f} 에 허용되지 않은 export 가 있다: ${e}`);
  }
});

/* ══════════ 63순위 — 백로그 소진 후 60차 재감사 (DS 63-1·63-2·63-3) ══════════ */

/**
 * DS 63-1·63-2 — **보이지 않는 글자**를 터는 자가 한 벌인가(배선).
 *
 * 「정말 그렇게 동작하는가」는 runtime.test.mjs 가 돌려서 본다. 여기서는 그 자를 **지나는
 * 자리**를 고정한다 — 받는 자리(`http.optStr`·카카오 발화)와 판정하는 자리(`normalize`)가
 * 같은 파일에서 오는지, 그리고 `trim()` 으로 되돌아간 자리가 없는지.
 */
test('보이지 않는 글자를 터는 자가 한 벌이다 (DS 63-1·63-2)', () => {
  const text = read('src/lib/text.ts');
  for (const name of ['stripInvisible', 'cleanText', 'isBlank', 'stripForMatch']) {
    assert.match(text, new RegExp(`export function ${name}\\(`), `${name} 이 단일 출처에 없다`);
  }
  // **글자를 이루는** 보이지 않는 글자는 보관용 표에서 지우지 않는다 — 59차가 한 글자로 묶어 둔
  // 것들이다(이음표·변형 선택자). 지우면 `👩‍👩‍👧` 가 낱낱의 사람이 된다.
  const decl = text.slice(text.indexOf('const INVISIBLE'));
  const keepTable = decl.slice(0, decl.indexOf('\n'));
  assert.ok(/^const INVISIBLE = \/\[.+\]\/gu;$/.test(keepTable), `보관용 표를 찾지 못했다: ${keepTable.slice(0, 40)}`);
  for (const keep of ['u{200c}', 'u{200d}', 'u{fe0f}']) {
    assert.equal(keepTable.includes(keep), false, `보관용 표가 ${keep} 까지 지운다`);
  }
  // 표는 **코드포인트 표기로만** 적는다 — 글자 그대로 적으면 소스 자체가 보이지 않는 글자를 품는다.
  const literal = [...text].find((c) => {
    const n = c.codePointAt(0);
    return n === 0xad || n === 0x200b || n === 0xfeff || (n >= 0x202a && n <= 0x202e) || (n >= 0x2060 && n <= 0x2069);
  });
  assert.equal(literal, undefined, '보이지 않는 글자를 소스에 그대로 적었다');

  // ① 받는 자리 — 모든 쓰기 경로가 지나는 `optStr` 과 카카오 발화.
  const http = read('src/lib/http.ts');
  assert.match(http, /import \{ cleanText \} from '@\/lib\/text';/, '입력 검증이 공통 자를 끌어오지 않는다');
  assert.match(http, /const s = cleanText\(v\);/, '입력 검증이 trim 으로 턴다');
  const kakao = read('src/lib/kakao.ts');
  assert.match(kakao, /const utterance = cleanText\(p\.userRequest\?\.utterance\);/, '카카오가 발화를 trim 으로 턴다');

  // ② 판정하는 자리 — 「같은 말인가」의 단일 기준.
  const norm = read('src/lib/normalize.ts');
  assert.match(norm, /import \{ stripForMatch \} from '@\/lib\/text';/, '비교하는 자가 공통 자를 끌어오지 않는다');
  // 지우는 것이 **먼저**다 — 분해형 한글 사이에 제로폭 공백이 끼면 정규화가 합치지 못한다 (DS 64-1).
  assert.match(norm, /return toMatchForm\(stripForMatch\(s\)\)\.toLowerCase\(\)/, '비교 전에 보이지 않는 글자를 지우지 않는다');

  // ③ 화면 사본 두 벌이 **사본임을 밝힌다**(밝히지 않으면 다음 사람이 한쪽만 고친다).
  assert.ok(read('src/app/admin/page.tsx').includes('원본은 `src/lib/text.ts`'), '콘솔 사본이 출처를 밝히지 않는다');
  assert.ok(read('src/components/ChatWidget.tsx').includes('원본은 `src/lib/text.ts`'), '위젯 사본이 출처를 밝히지 않는다');
});

/* ══════════ 64순위 — 백로그 소진 후 61차 재감사 (DS 64-1·64-2) ══════════ */

/**
 * DS 64-2 — **이름으로 줄을 세우는 자가 한 벌인가**(배선).
 *
 * 「정말 그 차례로 서는가」는 runtime.test.mjs 가 돌려서 본다. 여기서는 그 자를 **적는
 * 자리**를 고정한다: `localeCompare` 를 손으로 적은 자리가 `lib/order.ts` 와 콘솔 사본
 * 말고는 없는지, 그리고 이름 목록을 맨 `sort()`(코드포인트 순)로 세우는 자리가 남지 않았는지.
 *
 * 로케일을 적지 않은 `localeCompare` 가 특히 위험하다 — 돌려 보는 PC 는 `ko-KR` 이고
 * 배포 환경은 대개 `en-US` 라서, **테스트가 통과하는 곳에서는 드러나지 않는다**.
 */
test('이름으로 줄을 세우는 자가 한 벌이다 (DS 64-2)', () => {
  const order = read('src/lib/order.ts');
  assert.match(order, /export function compareText\(/, '줄 세우는 자가 단일 출처에 없다');
  assert.match(order, /localeCompare\(String\(b \?\? ''\), ORDER_LOCALE, ORDER_OPTIONS\)/, '로케일·옵션을 한 곳에 못박지 않았다');

  // lib 에서 `localeCompare` 를 적은 자리는 `order.ts` 하나뿐이다.
  const libs = readdirSync(new URL('../src/lib', import.meta.url)).filter((f) => f.endsWith('.ts'));
  for (const f of libs) {
    if (f === 'order.ts') continue;
    const body = stripComments(read(`src/lib/${f}`));
    assert.equal(/localeCompare\(/.test(body), false, `src/lib/${f}: 줄 세우는 자를 따로 적고 있다`);
  }
  // 종전에 갈라져 있던 네 자리가 공통 자를 지난다.
  for (const [f, pat] of [
    ['src/lib/convlog.ts', /compareText\(a\.tenant, b\.tenant\)/],
    ['src/lib/feedback.ts', /compareText\(a\.citation, b\.citation\) \|\| compareText\(a\.key, b\.key\)/],
    ['src/lib/ingest.ts', /compareText\(a\.term, b\.term\)/],
    ['src/lib/settlement.ts', /compareText\(x\.partnerName, y\.partnerName\)/],
  ]) {
    assert.match(read(f), pat, `${f}: 공통 자를 지나지 않는다`);
  }

  // 콘솔은 lib 을 불러올 수 없으므로 사본을 두되, **출처를 밝히고** 한 벌이어야 한다.
  const con = read('src/app/admin/page.tsx');
  assert.ok(con.includes('원본은 `src/lib/order.ts`'), '콘솔 사본이 출처를 밝히지 않는다');
  assert.equal((stripComments(con).match(/\.localeCompare\(/g) || []).length, 1, '콘솔에 줄 세우는 자가 두 벌 이상 있다');
});

/**
 * DS 64-1 — 비교용 정규화(NFKC)를 적는 자리도 한 곳인가.
 *
 * DS 42-3 이 `normalize('NFC')` 에 대해 세운 규약과 같은 종류다 — 자리마다 적으면 빠뜨린
 * 자리가 조용히 생긴다. 보관하는 값은 여전히 NFC 다(`toNfc`): 바꾸는 것은 **비교**뿐이다.
 */
test('호환 문자 정규화는 비교하는 자리에서만 한다 (DS 64-1)', () => {
  const norm = read('src/lib/normalize.ts');
  assert.match(norm, /export function toMatchForm\(s: string\): string \{/, '비교용 정규화가 단일 출처에 없다');
  assert.match(norm, /const NOT_COMPAT_JAMO = \/\[\^\\u\{3130\}-\\u\{318f\}\]\+\/gu;/, '한글 자모 구간을 건너뛰지 않는다');
  // 보관하는 값은 NFC 그대로다 — 들어온 글을 우리가 바꿔 저장하지 않는다(63차가 그은 선).
  assert.match(norm, /export function toNfc\(s: string\): string \{\n\s*return \(s \|\| ''\)\.normalize\('NFC'\);/, '보관용 정규화가 바뀌었다');
  for (const f of ['src/app/api/admin/kb/import/route.ts', 'src/lib/ingest.ts']) {
    assert.equal(/normalize\('NFKC'\)/.test(read(f)), false, `${f}: 보관하는 값에 NFKC 를 걸고 있다`);
  }
  // NFKC 를 적는 자리는 lib 한 곳 + 콘솔 사본 한 곳뿐이다.
  const libs = readdirSync(new URL('../src/lib', import.meta.url)).filter((f) => f.endsWith('.ts'));
  for (const f of libs) {
    if (f === 'normalize.ts') continue;
    assert.equal(/normalize\('NFKC'\)/.test(read(`src/lib/${f}`)), false, `src/lib/${f}: 비교용 정규화를 따로 적고 있다`);
  }
  assert.equal((stripComments(read('src/app/admin/page.tsx')).match(/normalize\('NFKC'\)/g) || []).length, 1, '콘솔에 비교용 정규화가 두 벌 이상 있다');
});

/* ══════════ 65순위 — 백로그 소진 후 62차 재감사 (DS 65-1·65-2·65-3) ══════════ */

/**
 * DS 65-1·65-3 — **수를 읽는 자가 한 곳인가.**
 *
 * 「정말 그렇게 읽는가」는 `tests/runtime.test.mjs`(DS 65-1·65-3)가 돌려 보고,
 * 「다른 곳에 또 적혀 있지 않은가」는 여기서 고정한다 — 다시 생기는 것을 막는 자리다.
 * `Number()` 자체를 금하지는 않는다(글자 한 자를 숫자로 보는 자리처럼 정당한 쓰임이 있다).
 * 막는 것은 **바깥에서 들어온 값**(요청 본문·쿼리·환경변수)을 그것으로 읽는 일이다.
 */
test('수를 읽는 자가 lib/num 하나다 (DS 65-1·65-3)', () => {
  const n = read('src/lib/num.ts');
  assert.match(n, /export function parseNumber\(v: unknown, rules: NumRules = \{\}\): NumResult/, 'parseNumber 를 내보내지 않는다');
  assert.match(n, /export function envNumber\(name: string, rules: NumRules = \{\}\): number \| null/, 'envNumber 를 내보내지 않는다');
  // 빈 값과 0 을 가르는 것이 이 자의 요점이다 — 사유가 사라지면 부르는 쪽이 다시 섞는다.
  assert.match(n, /issue: NumIssue/, '거절 사유를 돌려주지 않는다');
  // 글자를 수로 받는 표기는 10진수 하나다(16진·지수 표기는 운영자가 금액 칸에 적을 글이 아니다).
  assert.match(n, /const DECIMAL = \/\^\[\+-\]\?\\d\+\(\?:\\\.\\d\+\)\?\$\/;/, '받는 표기가 바뀌었다');

  // 환경변수를 **제 식으로** 읽는 자리가 남지 않았다 — `Number('')` 은 0 이다.
  const libs = readdirSync(new URL('../src/lib', import.meta.url)).filter((f) => f.endsWith('.ts'));
  for (const f of [...libs.map((x) => `src/lib/${x}`), 'src/app/api/admin/kb/import/route.ts']) {
    if (f === 'src/lib/num.ts') continue;
    assert.equal(/Number\(process\.env/.test(stripComments(read(f))), false, `${f}: 설정값을 제 식으로 읽는다`);
  }
  for (const f of ['src/lib/chat.ts', 'src/lib/llm.ts', 'src/lib/adminAuth.ts', 'src/lib/partners.ts']) {
    assert.match(read(f), /from '@\/lib\/num';/, `${f}: 공통 자를 불러오지 않는다`);
  }

  // 요청으로 들어오는 수도 같은 문을 지난다(본문·쿼리).
  const http = read('src/lib/http.ts');
  assert.match(http, /const r = parseNumber\(req\.nextUrl\.searchParams\.get\(name\)\);/, '쿼리 수가 공통 자를 지나지 않는다');
  const partners = read('src/lib/partners.ts');
  assert.match(partners, /const r = parseNumber\(v, \{ min: 0, max: MAX_MONTHLY_FEE, integer: true \}\);/, '월 이용료가 공통 자를 지나지 않는다');
  assert.match(partners, /const rate = parseNumber\(input\.feeRateBp, \{ min: 0, max: 10000, integer: true \}\);/, '수수료율이 공통 자를 지나지 않는다');
  assert.equal(/(?<!\w)Number\((?:input\.|v\.replace)/.test(stripComments(partners)), false, '수를 제 식으로 읽는 자리가 남았다');
});

/* ── 66순위 — 63차 재감사 (DS 66-1·66-2·66-3) ── */

test('글의 경계를 짐작하는 자가 한 벌이다 (DS 66-1·66-2·66-3)', () => {
  assert.ok(has('src/lib/prose.ts'), '문장 끝·제목 판정의 단일 출처가 있어야 한다');
  const p = read('src/lib/prose.ts');
  assert.match(p, /export function sentenceEndAt/, '문장이 끝나는 자리를 돌려주는 자가 없다');
  assert.match(p, /export function splitSentences/, '문장을 가르는 자가 없다');
  assert.match(p, /export function readsAsSentence/, '제목인가 본문인가를 가르는 자가 없다');
  // 문장을 끝내지 않는 마침표 네 가지(소수·주소·약어·번호 매김)를 모두 보고 있어야 한다.
  for (const guard of ['DIGIT.test(prev) && DIGIT.test(next)', 'ASCII_WORD.test(next)', 'LATIN.test(prev)', 'NUMBERING_HEAD']) {
    assert.ok(p.includes(guard), `마침표 판정에서 빠졌다: ${guard}`);
  }

  // 쓰는 쪽 세 자리가 모두 그 자를 지난다.
  assert.match(read('src/lib/knowledge.ts'), /import \{ splitSentences \} from '@\/lib\/prose';/, '근거 발췌가 공통 자를 쓰지 않는다');
  assert.match(read('src/lib/kakao.ts'), /import \{ sentenceEndAt \} from '@\/lib\/prose';/, '말풍선 나누기가 공통 자를 쓰지 않는다');
  const ing = read('src/lib/ingest.ts');
  // 문서 등록은 두 가지를 그 자에 묻는다 — 「이 줄이 제목인가」와 「문단을 어디서 끊는가」
  // (상한을 넘는 문단을 문장 경계에서 나눈다 · DS 74-2).
  assert.match(ing, /import \{ readsAsSentence, splitSentences \} from '@\/lib\/prose';/, '제목·문장 판정이 공통 자를 쓰지 않는다');
  assert.match(ing, /NUMBERED_HEADING_RE\.test\(t\) && !readsAsSentence\(t\)/, '번호로 시작하는 본문을 제목으로 읽는다');

  // 제 식으로 문장 끝을 재는 자리가 **0건**이다 — 두 벌이면 한쪽만 고쳐진다(다시 생기는 것을
  // 막는 자리다). `prose.ts` 하나만 글자와 견준다.
  const files = [
    ...readdirSync(new URL('../src/lib', import.meta.url)).filter((f) => f.endsWith('.ts')).map((f) => `src/lib/${f}`),
    'src/components/ChatWidget.tsx',
    'src/app/admin/page.tsx',
  ];
  for (const f of files) {
    if (f === 'src/lib/prose.ts') continue;
    const body = stripComments(read(f));
    assert.equal(
      /===\s*'[.?!。]'|lastIndexOf\('[.?!。]'\)|endsWith\('[.?!。]'\)/.test(body),
      false,
      `${f}: 문장 끝을 제 식으로 잰다`,
    );
  }
});

/* ── 64차 재감사 — 비율을 백분율로 적는 자리 (DS 67-1·67-2) ── */
test('비율을 백분율로 적는 자가 한 곳에 있다 (DS 67-1·67-2)', () => {
  const n = read('src/lib/num.ts');
  assert.match(n, /export function percentLabel/, '비율을 글자로 적는 자가 없다');
  assert.match(n, /export const PERCENT_UNDER/, '0% 에 닿은 값을 적는 말이 없다');
  assert.match(n, /export const PERCENT_OVER/, '100% 에 닿은 값을 적는 말이 없다');
  // 0% 와 100% 는 실제로 0 과 전부일 때만 — 그 두 줄이 판정의 전부다.
  assert.ok(n.includes("if (part === 0) return '0%';"), '0% 를 반올림으로 적는다');
  assert.ok(n.includes("if (part >= whole) return '100%';"), '100% 를 반올림으로 적는다');

  // 서버가 미리 반올림해 둔 칸은 **기계가 보는 칸**임을 적어 둔다(화면이 그대로 적으면 거짓말이다).
  assert.match(read('src/lib/feedback.ts'), /lib\/num\.percentLabel/, 'helpfulRate 가 화면 글자로 쓰일 수 있다');

  /**
   * 사람이 읽는 **글자**를 손으로 반올림하는 자리가 0건인가.
   * 막대 **길이**는 글자가 아니다 — 길이는 바닥을 두고 센다(DS 67-3). 그래서 `width:` 가
   * 같은 줄에 있는 자리만 남는다(그 줄은 눈에 보이는 길이이고 수는 옆에 글자로 적는다).
   */
  for (const f of ['src/app/admin/page.tsx', 'src/components/ChatWidget.tsx', 'src/app/page.tsx']) {
    for (const line of read(f).split('\n')) {
      if (!/Math\.round\([^\n]*\* 100\)\}%/.test(line)) continue;
      assert.match(line, /width:/, `${f}: 비율 글자를 손으로 반올림한다 — ${line.trim()}`);
    }
  }
});

/* ── 65차 재감사 — 고객이 말한 때를 알아듣는 자리 (DS 68-1·68-2·68-3) ── */

test('사람이 말한 날은 달력에 있는 날만 받는다 (DS 68-1)', () => {
  const k = read('src/lib/kst.ts');
  assert.match(k, /export function isRealYmd/, '「달력에 있는 날인가」를 묻는 자가 없다');
  // 넘겨 주는 자(`normalizeYmd`)와 묻는 자가 **다른 일**임을 주석이 말해야 한다(다음 사람이
  // 같은 자를 양쪽에 쓰지 않게 — 그 한 번이 「2월 31일 → 3월 3일」로 접수된 자리다).
  assert.match(k, /DS 68-1/, '두 자의 쓰임을 가른 근거가 적혀 있지 않다');

  const s = stripComments(read('src/lib/slots.ts'));
  assert.match(s, /isRealYmd/, '사람이 말한 날을 받는 자리가 달력을 묻지 않는다');
  // 연도를 적은 쪽·적지 않은 쪽 **둘 다** 지난다.
  assert.match(s, /if \(isRealYmd\(y, m, d\)\) date =/, '연도를 적은 날이 달력을 지나지 않는다');
  assert.match(s, /\.filter\(\(y\) => isRealYmd\(y, m, d\)\)/, '연도 미기재 날이 달력을 지나지 않는다');
  // 없는 날은 **옮기지 않는다** — 그 사실을 들고 나가는 칸이 있어야 되묻는 문장이 달라진다.
  assert.match(s, /impossible\?: string/, '「없는 날」과 「못 알아들었다」가 같은 값이 된다');
  assert.match(read('src/lib/slots.ts'), /달력에 없는 날이에요/, '어느 날이 없는 날인지 말하지 않는다');
});

test('시각 판정이 그 수에 딸린 것만 본다 (DS 68-2·68-3)', () => {
  const body = stripComments(read('src/lib/slots.ts'));

  // ① 분은 분 표시가 있을 때만 — 「시」와 콜론을 한 식으로 묶으면 뒤의 맨 수가 분이 된다.
  assert.equal(/\[:시\]/.test(body), false, '「시」와 콜론을 한 식으로 묶어 맨 수를 분으로 읽는다');
  assert.match(body, /const HOUR_KO = /, '「몇 시」 꼴을 따로 보는 식이 없다');
  assert.match(body, /const HOUR_COLON = /, '콜론 꼴을 따로 보는 식이 없다');
  assert.ok(body.includes('(?:\\s*(\\d{1,2})\\s*분|\\s*(반))?'), '분 표시(분·반)를 요구하지 않는다');

  // ② 반나절은 **문장 전체**에서 줍지 않는다 — 그 수 앞의 가장 가까운 말만 본다.
  assert.equal(
    /\/[^/\n]*오후[^/\n]*\/i?\.test\(/.test(body),
    false,
    '반나절을 문장 전체에서 찾는다(다른 수의 것이 섞인다)',
  );
  assert.match(body, /function meridiemFor\(text: string, from: number, to: number\)/, '딸린 가림말을 고르는 자가 없다');
  assert.match(body, /const half = meridiemFor\(t, from, from \+ hm\[0\]\.length\)/, '시각 판정이 그 자를 지나지 않는다');
  // 종전 표에 없어 통째로 틀렸던 두 낱말이 들어 있어야 한다(「낮 2시」=새벽 2시 · 「밤 12시」=정오).
  for (const word of ['낮', '정오', '밤', '자정', '아침', '새벽', '저녁']) {
    assert.ok(body.includes(`${word}:`), `반나절 표에서 빠졌다: ${word}`);
  }
});

/* ── 66차 재감사 — 고객이 무엇을 골랐는지 알아듣는 자리 (DS 69-1·69-2·69-3) ── */

test('고르기를 알아듣는 자가 한 벌이다 (DS 69-1·69-2·69-3)', () => {
  const choice = read('src/lib/choice.ts');
  assert.match(choice, /export function pickNumber/, '번호를 읽는 자가 없다');
  assert.match(choice, /export function pickChoice/, '말로 고른 것을 가리는 자가 없다');
  assert.match(choice, /export function interpretControl/, '빠져나가는 말을 가리는 자가 없다');
  assert.match(choice, /export function isSkip/, '건너뛰기를 묻는 자가 없다');
  // `lib/normalize` 외에는 의존하지 않는다 — 엔진·폼 양쪽이 같은 자를 쓰기 위해서다.
  const imports = choice.match(/from '@\/lib\/[\w-]+'/g) ?? [];
  assert.deepEqual([...new Set(imports)], ["from '@/lib/normalize'"], 'choice 가 다른 모듈에 의존한다');

  const slots = stripComments(read('src/lib/slots.ts'));
  const chat = stripComments(read('src/lib/chat.ts'));

  // ① 번호를 **손으로** 읽는 자리가 0건이다(종전에는 두 벌이었다).
  for (const [name, body] of [['slots', slots], ['chat', chat]]) {
    assert.equal(/\^\(\[1-9\]\)/.test(body), false, `${name} 에 번호를 손으로 읽는 식이 남아 있다`);
    assert.equal(/parsePick/.test(body), false, `${name} 에 번호 판정 사본이 남아 있다`);
  }
  assert.match(slots, /const num = pickNumber\(input, choices\.length\)/, '선택지 매칭이 공통 자를 지나지 않는다');
  assert.match(slots, /const num = pickNumber\(raw, choices\.length\)/, '선택지 검증이 공통 자를 지나지 않는다');
  assert.match(chat, /const pick = pickNumber\(text, pending\.length\)/, '폴백 제안 번호가 공통 자를 지나지 않는다');
  // 「알아들었는데 그런 번호가 없다」를 두 자리 모두 말한다(「못 알아들었다」와 다른 사실이다).
  assert.match(slots, /num\.kind === 'out_of_range'/, '폼이 없는 번호를 못 알아들었다고 말한다');
  assert.match(chat, /pick\.kind === 'out_of_range'/, '제안 목록이 없는 번호를 새 질문으로 보낸다');
  assert.match(read('src/lib/intents.ts'), /suggestion_out_of_range: '없는 번호 선택'/, '새 인텐트에 사람이 읽는 이름이 없다');

  // ② 말로 고르는 쪽은 **먼저 걸리는 것**을 돌려주지 않는다 — 점수를 견주고 비기면 고르지 않는다.
  assert.match(choice, /return tied \? null : best;/, '비긴 자리에서 앞줄을 골라 준다');
  assert.match(choice, /hit\.term\.length >= 2 \? 2 : 1/, '걸린 표기의 길이를 재지 않는다(한 글자 동의어가 이긴다)');
  assert.equal(/for \(const c of choices\) \{[\s\S]{0,200}return c;/.test(slots), false, 'slots 에 먼저 걸리는 선택지를 돌려주는 사본이 남아 있다');

  // ③ 빠져나가는 말은 `lib/choice` 밖에 적혀 있지 않다 — 두 벌이면 말 목록이 갈린다.
  for (const [name, body] of [['slots', slots], ['chat', chat]]) {
    for (const re of ['SKIP_RE', 'CANCEL_RE', 'BACK_RE']) {
      assert.equal(new RegExp(`const ${re}`).test(body), false, `${name} 에 ${re} 사본이 남아 있다`);
    }
  }
  assert.match(chat, /if \(isSkip\(text\)\)/, '연락처 수집 턴이 공통 자를 지나지 않는다');
  assert.match(slots, /const control = interpretControl\(text\)/, '폼이 공통 자를 지나지 않는다');
  // 두 쪽이 알던 말을 모두 받는다(한 벌로 모으면서 줄이지 않았다).
  for (const word of ['건너뛰기', '스킵', 'skip', '생략', '없어요', '아니요', '아니오', '괜찮', '나중에']) {
    assert.ok(choice.includes(word), `건너뛰기 말 목록에서 빠졌다: ${word}`);
  }
  // 세 판정 모두 **보내온 글이 그 말뿐일 때만** 고른 것으로 본다.
  assert.ok(choice.includes('^(?:취소|'), '취소 판정이 문장 어디서든 걸린다');
  assert.ok(choice.includes('^(?:이전|'), '이전 판정이 문장 어디서든 걸린다');
  assert.ok(choice.includes('^(?:건너뛰기|'), '건너뛰기 판정이 문장 어디서든 걸린다');
});

/* ══════════ 디자인 스프린트 — 67차 재감사 (DS 70-1·70-2·70-3) ══════════ */

/**
 * DS 70-1·70-2·70-3 — 연락처를 **받아 적는 자가 한 벌**인가.
 *
 * 「정말 그렇게 받는가」는 `tests/runtime.test.mjs` 가 돌려서 본다(위젯 사본 대조는
 * `tests/widget.test.mjs`). 여기서 고정하는 것은 자가 **다시 갈라지지 않는 것**이다 —
 * 종전에는 모양을 보는 자(`pii`)·화면이 재는 자(위젯 카드)·아무것도 재지 않는 자리
 * (접수 API) 셋이 같은 값에 서로 다른 답을 냈다.
 */
test('연락처를 받아 적는 자가 한 벌이다 (DS 70-1·70-2·70-3)', () => {
  const pii = stripComments(read('src/lib/pii.ts'));
  const chat = stripComments(read('src/lib/chat.ts'));
  const slots = stripComments(read('src/lib/slots.ts'));
  const route = stripComments(read('src/app/api/escalation/route.ts'));

  // ① 전각을 모으는 자가 `pii` 한 곳이고, 가리는 쪽·받아 적는 쪽이 **둘 다** 그것을 지난다.
  assert.match(pii, /export function foldWidth\(input: string\): string/, '전각을 모으는 자를 내보내지 않는다');
  assert.match(pii, /let out = foldWidth\(input\);/, '가리는 쪽이 전각을 모으지 않는다');
  assert.match(pii, /const t = foldWidth\(text\);/, '받아 적는 쪽이 전각을 모으지 않는다');
  // 모으는 것은 **글자 하나가 글자 하나로** 바뀌는 범위뿐이다(자리가 밀리면 가린 구간이 어긋난다).
  assert.match(pii, /const FULLWIDTH_ASCII = new RegExp\('\[\\\\uff01-\\\\uff5e\]', 'g'\);/, '접는 범위가 한 곳에 적혀 있지 않다');

  // ② 자리 수를 세는 표가 `pii` 한 곳에 있다 — 받아 적는 쪽에 사본이 없다.
  assert.match(pii, /const PHONE_PLANS: readonly \(readonly \[RegExp, readonly number\[\]\]\)\[\]/, '자리 수 표가 없다');
  assert.match(pii, /export function checkPhone\(value: string\): PhoneCheck/, '자리 수를 세는 자를 내보내지 않는다');
  assert.match(pii, /export function takeContact\(text: string\): ContactTake/, '받아 적는 자를 내보내지 않는다');
  assert.match(pii, /export function takeContactOnly\(text: string\): ContactTake/, '연락처뿐인지 가리는 자를 내보내지 않는다');
  for (const [name, body] of [['chat', chat], ['slots', slots], ['route', route]]) {
    assert.equal(/01\[16789\]|\{9, 10\}|\[11\]\]/.test(body), false, `${name} 에 자리 수 표 사본이 남아 있다`);
    assert.equal(/replace\(\/\\D\/g, ''\)\.length/.test(body), false, `${name} 이 자리 수를 제 식으로 센다`);
  }

  // ③ 받아 적는 자리 **셋 모두**가 그 자를 지난다(엔진 두 길·폼·접수 API).
  assert.match(chat, /const got = takeContact\(text\);/, '연락처 수집 턴이 공통 자를 지나지 않는다');
  assert.match(chat, /const only = openTicketId \? takeContactOnly\(text\) : null;/, '연락처만 보낸 길이 공통 자를 지나지 않는다');
  assert.match(slots, /const got = takeContact\(raw\);/, '접수 폼이 공통 자를 지나지 않는다');
  assert.match(route, /const took = contact\.value \? takeContact\(contact\.value\) : null;/, '접수 API 가 연락처를 재지 않는다');
  // 접수 API 는 **재서 통과한 값**을 저장한다(고객이 보낸 원문이 아니다).
  assert.match(route, /const taken = took\?\.ok \? took\.value : '';/, '접수 API 가 원문을 그대로 저장한다');
  assert.match(route, /contact: taken \|\| undefined,/, '접수에 재지 않은 값이 붙는다');

  // ④ 거절 문장은 `lib/refusal` 한 곳에서 온다 — 세 자리가 같은 말을 한다.
  const refusal = stripComments(read('src/lib/refusal.ts'));
  assert.match(refusal, /export function phoneShapeMessage\(/, '번호 거절 문장이 한 곳에 없다');
  assert.match(refusal, /export const CONTACT_SHAPE_MESSAGE = /, '연락처 거절 문장이 한 곳에 없다');
  for (const [name, body] of [['chat', chat], ['slots', slots], ['route', route]]) {
    assert.ok(body.includes('phoneShapeMessage'), `${name} 이 거절 문장을 제 글로 적는다`);
    assert.ok(body.includes('CONTACT_SHAPE_MESSAGE'), `${name} 이 연락처 거절 문장을 제 글로 적는다`);
    assert.equal(/형식을 알아보지 못했어요/.test(body), false, `${name} 에 거절 문장 사본이 남아 있다`);
  }
  // 새 인텐트에도 이름이 있어야 운영자 화면에 코드가 뜨지 않는다(DS 22-x).
  assert.match(read('src/lib/intents.ts'), /contact_shape: '연락처 형식 안내'/, '새 인텐트에 이름이 없다');

  // ⑤ 꼬리를 떼는 자도 `pii` 한 곳이다 — 종전 「한 글자도 다르지 않을 때만」 식이 남지 않았다.
  assert.match(pii, /const CONTACT_TAIL =/, '꼬리 목록이 한 곳에 없다');
  assert.equal(/t\.replace\(\/\\s\+\/g, ''\) === c\.replace/.test(chat), false, '종전 「글자까지 같을 때만」 식이 남아 있다');
});

/* ══════════ 디자인 스프린트 — 68차 재감사 (DS 71-1·71-2·71-3) ══════════ */

/**
 * DS 71-1 — 남의 글을 **한 줄로 모으는 자**가 한 곳인가.
 *
 * 「정말 그렇게 모이는가」는 `tests/runtime.test.mjs` 가 돌려서 본다. 여기서 고정하는 것은
 * 줄이 뜻을 가지는 글(이관 요약 평문·접수 확인 문구)에 값을 끼우는 자리가 **전부 그 자를
 * 지나는 것**이다 — 한 자리라도 빠지면 그 자리에서만 고객이 우리 글의 줄을 만든다.
 */
test('줄이 뜻을 가지는 글에 끼우는 값은 한 줄로 모은다 (DS 71-1)', () => {
  const text = stripComments(read('src/lib/text.ts'));
  const handoff = stripComments(read('src/lib/handoff.ts'));
  const slots = stripComments(read('src/lib/slots.ts'));

  // ① 모으는 자와 그 표시는 `lib/text` 한 곳이다.
  assert.match(text, /export const LINE_BREAK_MARK = /, '줄바꿈 표시가 한 곳에 없다');
  assert.match(text, /export function oneLine\(s: unknown\): string/, '한 줄로 모으는 자를 내보내지 않는다');

  // ② 요약은 **가린 뒤에** 모은다(먼저 모으면 줄 끝에 걸친 번호를 규칙이 놓친다).
  assert.match(handoff, /import \{ oneLine \} from '@\/lib\/text';/, '요약이 공통 자를 가져오지 않는다');
  assert.match(handoff, /value: oneLine\(m\.text\)/, '수집 값을 한 줄로 모으지 않는다');
  assert.match(handoff, /text: oneLine\(m\.text\)/, '대화 한 마디를 한 줄로 모으지 않는다');
  for (const m of handoff.match(/oneLine\([^)]*\)/g) || []) {
    assert.match(m, /oneLine\(m\.text\)/, `마스킹을 지나지 않은 값을 모은다: ${m}`);
  }

  // ③ 접수 확인 문구도 같은 자를 지난다 — 한 항목이 한 줄이다.
  assert.match(slots, /import \{ oneLine \} from '@\/lib\/text';/, '확인 문구가 공통 자를 가져오지 않는다');
  assert.match(slots, /`- \$\{s\.label\}: \$\{oneLine\(/, '확인 문구가 값을 그대로 끼운다');

  // ④ 자리마다 제 식으로 줄바꿈을 지우지 않는다(지우면 「10시⏎2시」가 「10시2시」가 된다).
  for (const [name, body] of [['handoff', handoff], ['slots', slots]]) {
    assert.equal(/replace\(\/\\n\/g, ''\)/.test(body), false, `${name} 이 줄바꿈을 조용히 지운다`);
  }
});

/**
 * DS 71-2 — 「주고받은 메시지」는 **세어 둔 수**인가(버퍼 길이가 아니라).
 */
test('이관 요약의 메시지 수는 세션이 세어 둔 값에서 온다 (DS 71-2)', () => {
  const session = stripComments(read('src/lib/session.ts'));
  const handoff = stripComments(read('src/lib/handoff.ts'));
  const chat = stripComments(read('src/lib/chat.ts'));
  const route = stripComments(read('src/app/api/escalation/route.ts'));

  // ① 세는 자리는 턴을 쌓는 자리 하나다 — 버려도 수는 남는다.
  assert.match(session, /turnTotal\?: number;/, '주고받은 수를 세는 칸이 없다');
  assert.match(session, /updateSession\(sessionId, \{ turns, turnTotal: \(ctx\.turnTotal \?\? 0\) \+ 1 \}\);/, '턴을 쌓으면서 세지 않는다');

  // ② 요약은 **버퍼 길이를 수로 적지 않는다**.
  assert.equal(/turnCount: input\.turns\.length/.test(handoff), false, '종전 식(버퍼 길이)이 남아 있다');
  assert.match(handoff, /const turnCount = Math\.max\(input\.totalTurns \?\? 0, input\.turns\.length\);/, '세어 둔 수를 쓰지 않는다');
  assert.match(handoff, /omittedTurns: Math\.max\(0, turnCount - recentTurns\.length\)/, '담지 못한 수를 세지 않는다');

  // ③ 요약을 만드는 **두 자리 모두** 세어 둔 수를 넘긴다(한쪽만 넘기면 창구마다 다른 수가 간다).
  for (const [name, body] of [['chat', chat], ['escalation route', route]]) {
    assert.match(body, /totalTurns: ctx\.turnTotal/, `${name} 이 세어 둔 수를 넘기지 않는다`);
  }
});

/**
 * DS 71-3 — 콘솔이 **받아 온 창**을 대화의 길이라고 말하지 않는가.
 */
test('대화 기록 창구와 화면이 보여 준 수를 전체라고 말하지 않는다 (DS 71-3)', () => {
  const convlog = stripComments(read('src/lib/convlog.ts'));
  const route = stripComments(read('src/app/api/admin/escalations/route.ts'));
  const page = stripComments(read('src/app/admin/page.tsx'));

  // ① 묶음을 만드는 자는 저장소에 있다 — 접수 목록(`queryTickets`)과 같은 모양이다.
  assert.match(convlog, /export function queryTurns\(limit: number = TURN_PAGE_DEFAULT\): TurnPage/, '대화 기록 묶음을 만드는 자가 없다');
  assert.match(convlog, /export function sessionTurnCounts\(ids: readonly string\[\]\): Record<string, number>/, '대화별 보관 수를 세는 자가 없다');
  assert.match(convlog, /export const TURN_PAGE_DEFAULT = 30;/, '창 크기에 이름이 없다');

  // ② 라우트는 창 크기만 보내지 않는다 — 전체 수와 대화별 보관 수를 함께 보낸다.
  assert.equal(/listTurns\(30\)/.test(route), false, '종전 식(이름 없는 30)이 남아 있다');
  assert.match(route, /const page = queryTurns\(intQuery\(req, 'turns', TURN_PAGE_DEFAULT, 1, TURN_PAGE_MAX\)\);/, '라우트가 묶음 자를 쓰지 않는다');
  assert.match(route, /turnPage: \{ total: page\.total, shown: page\.turns\.length, limit: page\.limit, truncated: page\.truncated \}/, '전체 몇 건인지 말하지 않는다');
  assert.match(route, /sessionTurns: sessionTurnCounts\(page\.turns\.map\(\(t\) => t\.sessionId\)\)/, '대화별 보관 수를 보내지 않는다');

  // ③ 화면은 받은 수를 대화 전체라고 적지 않는다.
  // 빈 중괄호는 `stripComments` 가 걷어 간다(JSX 주석 자리) — 앞머리만 본다.
  assert.match(page, /setSessionTurns\(data\.sessionTurns \|\| /, '콘솔이 대화별 보관 수를 받지 않는다');
  assert.match(page, /const partial = kept > turns\.length;/, '토막인지 가리지 않는다');
  assert.match(page, /partial \? `최근 \$\{turns\.length\}쌍 · 보관 \$\{kept\}쌍` : `주고받은 메시지 \$\{turns\.length\}쌍`/, '토막을 전체라고 적는다');
  assert.ok(page.includes('이 화면에는 최근 {turns.length}쌍만 들어 있습니다.'), '빠진 대화가 있다는 사실을 적지 않는다');
  // 지킬 수 없는 약속을 버튼 이름에 적지 않는다 — 콘솔은 대화 「전체」를 들고 있지 않다.
  assert.equal(page.includes('대화 전체 보기'), false, '「전체」라고 적은 버튼이 남아 있다');
});

/* ══════════ 69차 재감사 — 이미 받은 것을 또 받았을 때 (DS 72-x) ══════════ */

/**
 * DS 72-1 — 「이미 받았다」를 가리는 자가 **한 곳**이고, 웹 창구가 그것을 지나는가.
 *
 * 돌려 보는 쪽(판정 자체)은 runtime.test.mjs 가 센다. 여기서는 **배선**을 고정한다 —
 * 그 판정이 서명 검증 파일 안에 있었던 탓에 웹 창구가 가져다 쓰지 못한 것이 이 결함의 뿌리다.
 */
test('재전달을 가리는 자가 한 곳이고 웹 대화 창구가 그것을 지난다 (DS 72-1)', () => {
  const idem = stripComments(read('src/lib/idem.ts'));
  const wa = stripComments(read('src/lib/webhookAuth.ts'));
  const route = stripComments(read('src/app/api/chat/route.ts'));
  const kakao = stripComments(read('src/app/api/kakao/webhook/route.ts'));
  const widget = read('src/components/ChatWidget.tsx');

  // ① 판정과 저장은 `lib/idem` 한 곳이다 — 웹훈 인증 파일에는 **저장소가 남아 있지 않다**.
  assert.match(idem, /const seen = new Map<string, DedupeRecord>\(\);/, '재전달을 기억하는 자리가 없다');
  assert.match(idem, /export function dedupeCheck\(/, '재전달을 가리는 자가 없다');
  assert.match(idem, /export function dedupeRelease\(/, '답을 만들지 못한 자리를 거두는 자가 없다');
  assert.match(idem, /export const REQUEST_KEY_LEN = 64;/, '열쇠 상한에 이름이 없다');
  assert.equal(/new Map<string, DedupeRecord>/.test(wa), false, '재전달 저장소가 두 벌이다');
  assert.match(wa, /export \{[\s\S]{0,200}dedupeCheck,[\s\S]{0,200}\} from '@\/lib\/idem';/, '부르던 쪽의 이름이 사라졌다');

  // ② 웹 대화 창구가 **한 번 쓰는 열쇠**를 받고, 세션과 함께 묶어 가린다.
  assert.match(route, /optStr\(parsed\.data\.msgId, 'msgId', REQUEST_KEY_LEN, ''\)/, '창구가 열쇠를 받지 않는다');
  assert.match(route, /const dupKey = mid\.value \? eventKey\(\['chat', sessionId, mid\.value\]\) : '';/, '열쇠를 세션과 묶지 않는다');
  assert.match(route, /if \(dup\.response && typeof dup\.response === 'object'\) \{/, '적어 둔 답을 돌려주지 않는다');
  assert.match(route, /code: 'duplicate_pending'/, '처리 중인 재전달을 로그에 남기지 않는다');
  assert.match(route, /if \(dupKey\) dedupeRelease\(dupKey\);/, '답을 만들지 못한 자리를 거두지 않는다');
  assert.match(route, /if \(dupKey\) dedupeRemember\(dupKey, payload\);/, '만든 답을 적어 두지 않는다');
  // 적어 두는 자리는 **대화 기록을 남긴 뒤**다 — 그 순서가 뒤집히면 재전달이 기록 없이 지나간다.
  assert.ok(route.indexOf('logTurn({') < route.indexOf('dedupeRemember(dupKey'), '기록보다 먼저 적어 둔다');
  // 처리 중인 재전달에는 **답을 지어내지 않는다**(지킬 수 있는 다음 길만 적는다).
  assert.ok(route.includes('앞서 보내 주신 말씀을 아직 처리하고 있어요.'), '처리 중임을 말하지 않는다');

  // ③ 카카오 창구는 종전 그대로 같은 자를 쓴다(창구마다 다른 판정을 두지 않는다).
  assert.match(kakao, /const dup = kakaoDedupe\(key\);/, '카카오 쪽 재전달 판정이 사라졌다');

  // ④ 위젯은 말풍선마다 열쇠를 만들고 **다시 보낼 때 같은 값**을 보낸다.
  assert.match(widget, /export function newMsgId\(\): string \{/, '열쇠를 만드는 자가 없다');
  assert.match(widget, /const msgId = retryId \|\| newMsgId\(\);/, '다시 보내기가 새 열쇠를 만든다');
  assert.match(widget, /\{ message: text, sessionId, msgId,/, '열쇠를 보내지 않는다');
  // 실패 경로 3곳(서버 오류·네트워크 예외·오프라인)이 모두 그 열쇠를 들고 있어야 한다.
  assert.equal((widget.match(/failedId: msgId/g) || []).length, 3, '열쇠를 들지 않는 실패 경로가 있다');
  // 난수원은 한 곳이다 — 열쇠를 만들려고 난수를 두 벌 적지 않는다.
  assert.match(widget, /return `m_\$\{newSessionId\(\)\.slice\('web_'\.length\)\}`;/, '열쇠가 다른 난수원에서 나온다');
});

/**
 * DS 72-2 · DS 72-3 — 두 번째 사실을 만들지 않는 자리의 **배선**.
 * (값으로 돌려 보는 쪽은 runtime.test.mjs 의 같은 번호 테스트가 센다.)
 */
test('평가·저장 창구가 두 번째 사실을 만들지 않는다 (DS 72-2 · DS 72-3)', () => {
  const fb = stripComments(read('src/lib/feedback.ts'));
  const store = stripComments(read('src/lib/adminStore.ts'));
  const partners = stripComments(read('src/lib/partners.ts'));
  const kbRoute = stripComments(read('src/app/api/admin/kb/route.ts'));
  const ruleRoute = stripComments(read('src/app/api/admin/rules/route.ts'));
  const partnerRoute = stripComments(read('src/app/api/admin/partners/route.ts'));
  const page = stripComments(read('src/app/admin/page.tsx'));

  // ① 평가 — 묶는 자는 한 곳이고, 접수가 그 자로 같은 평가를 찾는다.
  assert.match(fb, /function targetKey\(e: \{ kbId\?: string; citation\?: string \}\): string \{/, '묶는 자가 없다');
  assert.match(fb, /entries\.findIndex\(\(e\) => e\.sessionHash === sessionHash && targetKey\(e\) === key\)/, '같은 평가를 찾지 않는다');
  assert.match(fb, /id: prev \? prev\.id : `F-\$\{String\(seq\)\.padStart\(6, '0'\)\}`/, '같은 평가에 새 번호를 붙인다');
  // 복원도 같은 자를 쓴다 — 고치기 전 저장분이 두 건으로 되살아나지 않는다.
  assert.match(fb, /const key = targetKey\(e\);/, '복원이 묶지 않는다');
  assert.match(fb, /entries = collapsed\.slice\(-MAX_ENTRIES\);/, '복원이 쌓인 채로 들여온다');

  // ② 저장 — 「내용의 모습」은 동시 편집 관문과 **같은 식**에서 식별자만 뺀 것이다.
  assert.match(store, /function kbContentRev\(e: KBEntry\): string \{\n  return kbRev\(\{ \.\.\.e, id: '' \}\);/, '자료의 내용 판정이 두 벌이다');
  assert.match(store, /function customRuleContentRev\(r: CustomRule\): string \{\n  return customRuleRev\(\{ \.\.\.r, intent: '' \}\);/, '규칙의 내용 판정이 두 벌이다');
  assert.match(partners, /function accountContentRev\(a: Account\): string \{\n  return accountRev\(\{ \.\.\.a, id: '' \}\);/, '고객사의 내용 판정이 두 벌이다');
  assert.match(partners, /function partnerContentRev\(p: Partner\): string \{\n  return partnerRev\(\{ \.\.\.p, id: '' \}\);/, '파트너의 내용 판정이 두 벌이다');
  // 만드는 자리 넷 모두가 그 자를 지난다.
  for (const [what, body, sig] of [
    ['자료', store, /const twin = kbEntries\.find\(\(e\) => kbContentRev\(e\) === kbContentRev\(entry\)\);/],
    ['규칙', store, /const twin = customRules\.find\(\(r\) => customRuleContentRev\(r\) === customRuleContentRev\(rule\)\);/],
    ['파트너', partners, /const twin = partners\.find\(\(p\) => partnerContentRev\(p\) === partnerContentRev\(draft\)\);/],
    ['고객사', partners, /const twin = accounts\.find\(\(a\) => accountContentRev\(a\) === accountContentRev\(draft\)\);/],
  ]) assert.match(body, sig, `${what}를 만드는 자리가 쌍둥이를 가리지 않는다`);

  // ③ 창구는 그 사실을 화면에 전하고, **변경 이력에 「수정」이라 적지 않는다**.
  for (const [what, body] of [['자료', kbRoute], ['규칙', ruleRoute], ['파트너·고객사', partnerRoute]]) {
    assert.ok(body.includes('같은 내용이 이미 있어 새로 만들지 않음'), `${what} 쓰기가 없는 일을 기록에 적는다`);
    // `stripComments` 는 빈 중괄호를 걷어 간다 — 삼항의 앞쪽만 본다.
    assert.match(body, /duplicate \? \{ duplicate: true \} :/, `${what} 응답이 그 사실을 싣지 않는다`);
  }

  // ④ 화면 문구는 한 곳에서 나온다 — 네 자리가 같은 사실을 같은 말로 적는다.
  assert.match(page, /function duplicateSavedText\(what: string\): string \{/, '쌍둥이 안내 문구가 자리마다 흩어져 있다');
  for (const what of ['자료', '규칙', '파트너', '고객사']) {
    assert.ok(page.includes(`duplicateSavedText('${what}')`), `${what} 저장이 새로 만들지 않은 사실을 말하지 않는다`);
  }
});

/* ══════════ 71차 재감사 — 우리가 「이만큼까지」를 재는 자리 (DS 74-x) ══════════ */

/**
 * DS 74-1·74-3 — 관리 콘솔의 두 쓰기 창구가 들어온 값을 **재지 않았다**.
 *
 * `/api/admin/kb` 는 본문을 그대로 저장소에 넘겼고(길이·보이지 않는 글자·글자 아닌 값 전부),
 * `/api/admin/rules` 는 `PATCH`(기본 규칙 답변)만 1000자를 재고 `POST`(내 규칙)는 아무것도
 * 재지 않았다 — 같은 화면의 같은 「답변」 칸을 두 창구가 다른 자로 봤다. 이 제품의 자는
 * `lib/http` 의 `optStr`/`reqStr`(= `cleanText` + 상한 · DS 63-1)이고, 상한은 `lib/limits` 다.
 */
test('쓰기 창구가 들어온 값을 한 자로 재고, 상한은 한 곳에 있다 (DS 74-1·74-3)', () => {
  const limits = read('src/lib/limits.ts');
  const kbRoute = read('src/app/api/admin/kb/route.ts');
  const ruleRoute = read('src/app/api/admin/rules/route.ts');
  const store = read('src/lib/adminStore.ts');
  const ingest = read('src/lib/ingest.ts');

  // ① 상한은 `lib/limits` 에 이름을 갖고 있다.
  const num = (name, body = limits) => {
    const m = new RegExp(`export const ${name} = ([\\d_]+);`).exec(body);
    assert.ok(m, `${name} 상한이 단일 출처에 없다`);
    return Number(m[1].replace(/_/g, ''));
  };
  const q = num('KB_QUESTION_LEN');
  const a = num('KB_ANSWER_LEN');
  const cat = num('KB_CATEGORY_LEN');
  const kws = num('KEYWORDS_LEN');
  const kw = num('KEYWORD_LEN');
  const label = num('RULE_LABEL_LEN');
  const reply = num('RULE_REPLY_LEN');
  // 고객이 한 번에 보내는 글과 **같은 수**다 — 같은 대화의 두 쪽을 다른 자로 재지 않는다.
  assert.equal(a, num('MAX_MESSAGE_LEN'), '우리가 내보내는 글과 고객이 보내는 글의 상한이 갈라졌다');
  // 문서로 들어오는 길의 조각 상한과도 같다 — 한쪽으로 들어온 자료를 다른 쪽에서 고칠 수 있어야 한다.
  assert.equal(a, num('CHUNK_CHARS_MAX', ingest), '문서 조각 상한과 자료 답변 상한이 갈라졌다');
  // 문서에서 뽑는 검색어(8개)가 한 칸에 들어간다 — 들어온 자료를 콘솔에서 다시 저장할 수 있다.
  assert.ok(kw * 8 + 7 <= kws, `검색어 ${kw}자 8개가 한 칸(${kws}자)에 들어가지 않는다`);

  // ② 두 창구가 그 자를 지난다 — 본문을 그대로 넘기는 자리가 0건이다.
  assert.match(kbRoute, /const KB_FIELDS: readonly \(readonly \[string, number\]\)\[\] = \[/, '자료 창구가 받는 칸 목록이 없다');
  for (const [field, name] of [['id', '60'], ['category', 'KB_CATEGORY_LEN'], ['question', 'KB_QUESTION_LEN'], ['answer', 'KB_ANSWER_LEN'], ['source', 'KB_SOURCE_LEN']]) {
    assert.ok(kbRoute.includes(`['${field}', ${name}]`), `자료 창구가 ${field} 칸을 재지 않는다`);
  }
  assert.match(kbRoute, /const f = optStr\(nfcIfText\(body\[key\]\), key, max\);/, '자료 창구가 공통 자를 쓰지 않는다');
  assert.equal(/upsertKB\(body\)/.test(kbRoute), false, '자료 창구가 본문을 그대로 저장소에 넘긴다');
  assert.match(ruleRoute, /const RULE_FIELDS: readonly \(readonly \[string, number\]\)\[\] = \[/, '규칙 창구가 받는 칸 목록이 없다');
  for (const [field, name] of [['label', 'RULE_LABEL_LEN'], ['reply', 'MAX_RULE_REPLY_LEN'], ['keywords', 'KEYWORDS_LEN']]) {
    assert.ok(ruleRoute.includes(`['${field}', ${name}]`), `규칙 창구가 ${field} 칸을 재지 않는다`);
  }
  assert.equal(/upsertCustomRule\(parsed\.data\)/.test(ruleRoute), false, '규칙 창구가 본문을 그대로 저장소에 넘긴다');
  // 길이를 손으로 재는 자리가 남아 있지 않다(그 자는 보이지 않는 글자를 글자로 센다).
  assert.equal(/body\.reply\.length > MAX_RULE_REPLY_LEN/.test(ruleRoute), false, '손으로 길이를 재는 자리가 남아 있다');

  // ③ 길이는 **정규화 뒤에** 잰다 — 분해형 한글을 그냥 세면 멀쩡한 글이 먼저 걸린다(DS 42-3).
  for (const [what, body] of [['자료', kbRoute], ['규칙', ruleRoute]]) {
    assert.match(body, /function nfcIfText\(v: unknown\): unknown \{\n  return typeof v === 'string' \? toNfc\(v\) : v;\n\}/, `${what} 창구가 정규화 전에 잰다`);
  }

  // ④ 저장소의 빈칸 판정도 같은 자다 — 창구를 지나지 않는 길(문서 등록·복원)이 하나 있다.
  assert.match(store, /function clean\(v: unknown\): string \{\n  return cleanText\(v\);\n\}/, '저장소가 받는 자리의 자를 쓰지 않는다');
  assert.equal(/\.trim\(\) \|\| existing\./.test(store), false, '저장소에 trim 으로 재는 자리가 남아 있다');
  assert.equal(/\(input\.(question|answer|label|reply) \|\| ''\)\.trim\(\)/.test(store), false, '필수 검사가 trim 으로 재는 자리가 남아 있다');

  // ⑤ 거절 문장은 **그 칸의 화면 라벨**로 말한다 — 코드 키를 보이지 않는다(DS 29-3).
  const refusal = read('src/lib/refusal.ts');
  for (const [key, name] of [['question', '대표 질문'], ['answer', '답변'], ['keywords', '고객이 쓸 표현'], ['label', '규칙 이름']]) {
    assert.ok(refusal.includes(`${key}: '${name}',`), `${key} 칸의 사람 말 이름이 없다`);
  }

  // ⑥ 화면도 같은 수를 알고 있어야 **보내기 전에** 말할 수 있다(DS 29-1).
  const page = read('src/app/admin/page.tsx');
  for (const [name, value] of [['KB_QUESTION_LEN', q], ['KB_ANSWER_LEN', a], ['KB_CATEGORY_LEN', cat], ['KEYWORDS_LEN', kws], ['RULE_LABEL_LEN', label], ['MAX_RULE_REPLY_LEN', reply]]) {
    assert.ok(page.includes(`const ${name} = ${value};`), `콘솔 사본의 ${name} 이 서버와 다르다`);
  }
  assert.ok(page.includes('원본은 `src/lib/limits.ts`'), '콘솔 사본이 출처를 밝히지 않는다');
  const bare = stripComments(page);
  for (const [field, limit] of [['form.question', 'KB_QUESTION_LEN'], ['form.answer', 'KB_ANSWER_LEN'], ['form.keywords', 'KEYWORDS_LEN'], ['crForm.label', 'RULE_LABEL_LEN'], ['crForm.keywords', 'KEYWORDS_LEN'], ['crForm.reply', 'MAX_RULE_REPLY_LEN']]) {
    assert.ok(bare.includes(`fieldLen(${field}) > ${limit}`), `${field} 칸이 상한을 보내기 전에 보지 않는다`);
  }
});

/**
 * DS 74-2 — 「한 항목 길이」가 상한이 아니었다(담은 뒤에 넘치는지 봤다).
 * 값으로 확인하는 쪽은 `tests/runtime.test.mjs` 다 — 여기서는 **다시 생기지 않게** 고정한다.
 */
test('문서 조각이 상한을 넘지 않게 나뉜다 (DS 74-2)', () => {
  const ingest = read('src/lib/ingest.ts');
  assert.match(ingest, /function fitParagraph\(para: string, maxChars: number\): string\[\] \{/, '문단을 상한 안에 넣는 자가 없다');
  // 문장 경계는 공통 자에게 묻고, 글자 경계는 반쪽을 남기지 않는 자에게 묻는다.
  assert.match(ingest, /for \(const sentence of splitSentences\(para\)\)/, '문장 경계를 제 식으로 찾는다');
  assert.match(ingest, /const head = cut\(rest, maxChars\);/, '글자 경계를 제 식으로 끊는다');
  // 담기 **전에** 끊는다 — 종전 식(`curLen >= maxChars` 로 담은 뒤 끊기)이 남아 있지 않다.
  assert.match(ingest, /if \(cur && curLen \+ 1 \+ para\.length > maxChars\) flush\(\);/, '담은 뒤에 넘치는지 본다');
  // 주석에 적힌 종전 식으로 거짓 실패하지 않게 코드 구간만 본다(DS 5-6 에서 겪은 거짓 통과의 반대).
  assert.equal(/curLen >= maxChars/.test(stripComments(ingest)), false, '종전 식이 남아 있다');
  // 병합도 상한을 본다.
  assert.match(ingest, /prev\.heading === c\.heading && prev\.text\.length \+ 1 \+ body\.length <= maxChars/, '짧은 꼬리 병합이 상한을 넘긴다');
  // 문서가 만드는 자료 한 건도 자료 쪽 상한을 지킨다(줄이면 줄였다고 적는다).
  assert.match(ingest, /question: ellipsize\(toQuestion\(chunk, title\), KB_QUESTION_LEN\)/, '대표 질문이 상한을 모른다');
  assert.match(ingest, /source: ellipsize\(chunk\.heading \? `\$\{title\} — \$\{chunk\.heading\}` : title, KB_SOURCE_LEN\)/, '출처가 상한을 모른다');
  assert.match(ingest, /t\.length >= 2 && t\.length <= KEYWORD_LEN/, '낱말 하나의 상한을 보지 않는다');
});
