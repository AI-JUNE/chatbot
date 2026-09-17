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

/* ── 저장소 어댑터 (영속화) ── */
test('개인정보 포함 네임스페이스는 승인 플래그 없이 저장되지 않는다', () => {
  const s = read('src/lib/storage.ts');
  assert.match(s, /process\.env\.PERSIST_PII === 'true'/, '기본값은 비활성이어야 한다');
  // 티켓·대화로그는 pii:true 로 등록되어야 한다
  const nsBlock = (s.split('export const NAMESPACES')[1] ?? '').split('};')[0];
  for (const ns of ['tickets', 'convlog']) {
    assert.ok(new RegExp(`${ns}:[^\\n]*pii: true`).test(nsBlock), `${ns}는 pii:true 로 등록되어야 한다`);
  }
  for (const ns of ['admin', 'audit']) {
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
  assert.match(s, /tenant\?\.starters/, '빠른 답장은 서버가 준 실제 FAQ에서 와야 한다');
  assert.match(s, /도움이 됐나요\?/, '답변 평가 문구');
  assert.match(s, /'\/api\/feedback'/, '평가는 서버에 기록돼야 한다');
  assert.match(s, /평가를 보내지 못했어요/, '실패를 삼키지 않고 알려야 한다');
  // 평가 요청에 대화 본문을 싣지 않는다(개인정보)
  assert.equal(/verdict, citation: m\.citation\?\.source \|\| ''/.test(s), true, '평가에는 근거 라벨만 보내야 한다');
});

test('빠른 답장은 실제 적재된 FAQ에서만 만들어진다', () => {
  const s = read('src/lib/tenantKB.ts');
  assert.match(s, /STARTER_COUNT/, '칩 개수 상수가 있어야 한다');
  assert.match(s, /tenantKB\(preset\)\s*\n?\s*\.slice\(0, STARTER_COUNT\)/, '칩은 KB에서 잘라 써야 한다');
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
  assert.match(s, /aria-describedby="gw-handoff-hint"/, '이용 목적 안내가 입력과 연결돼야 한다');
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
  assert.match(s, /disabled=\{handoff\.stage === 'sending'/, '전송 중에는 버튼이 잠겨야 한다');
  assert.match(s, /aria-busy=\{handoff\.stage === 'sending'\}/, '진행 상태를 알려야 한다');
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
  assert.match(ge, /'--brand': '#2563EB'/, 'globals.css 가 없으므로 토큰을 인라인으로');
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
  assert.match(css, /\.legal-body h2\{[^}]*scroll-margin-top/);
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
  assert.match(s, /sendText\(failedText, m\.key\)/, '다시 보내기가 원문을 그대로 재전송해야 한다');
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
  const limit = Number(/MAX_MESSAGE_LEN = (\d+)/.exec(route)?.[1]);
  assert.ok(limit > 0, '서버 길이 한계를 읽지 못했다');
  const widgetLimit = Number(/MAX_INPUT_LEN = (\d+)/.exec(s)?.[1]);
  assert.equal(widgetLimit, limit, '위젯과 서버의 길이 한계가 어긋나면 413 으로 거절된다');
  assert.match(s, /aria-invalid=\{tooLong \|\| undefined\}/, '어느 입력이 틀렸는지 알려야 한다');
  assert.match(s, /aria-describedby=/, '오류 문구를 입력과 연결해야 한다');
  assert.match(s, /disabled=\{busy \|\| tooLong \|\| !input\.trim\(\)\}/, '한계를 넘으면 전송을 막는다');
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
