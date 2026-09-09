/**
 * E2E 스모크 스크립트(scripts/smoke.mjs) 자체 검증.
 * 스모크는 라이브에 요청을 보내는 도구라 테스트에서는 fetch를 스텁으로 갈아 끼운다 —
 * "정상 배포는 통과시키고, 고장난 배포는 실제로 잡아내는가"를 확인하는 게 목적이다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHECKS, DEFAULT_BASE_URL, exitCodeFor, formatReport, runSmoke } from '../scripts/smoke.mjs';

const src = readFileSync(new URL('../scripts/smoke.mjs', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/* ══════════ 응답 스텁 ══════════ */

const HEALTH_OK = {
  service: 'chatbot',
  status: 'ok',
  dependencies: {
    storage: { driver: 'memory', namespaces: [{ ns: 'audit', health: 'ok' }] },
    tenants: [{ id: 'eum', name: '이음', entries: 10, skipped: 0, ctaUrl: 'https://eum-app.vercel.app', ctaFromEnv: false }],
  },
  build: { env: 'production', commit: 'abc1234' },
};

const CHAT_FAQ_OK = {
  reply: '이음 참여 신청은 안내 페이지에서 하실 수 있어요.',
  source: 'kb',
  citation: { source: '이음 FAQ 1. 신청 방법', quote: '신청은 안내 페이지에서 받습니다.' },
  cta: { label: '이음 참여 신청하기', url: 'https://eum-app.vercel.app', hint: '신청은 이 버튼으로 하실 수 있어요.' },
};

const CHAT_UNKNOWN_OK = {
  reply: '이 질문은 제가 가진 안내 자료에 없어서 추측하지 않겠습니다. 담당 코디네이터에게 연결해 드릴까요?',
  source: 'fallback',
};

/** 정상 배포를 흉내 내는 fetch. override 로 특정 응답만 망가뜨려 실패 경로를 만든다. */
function stubFetch(override = {}) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init = {}) => {
      const u = new URL(url);
      const key = u.pathname + (u.search || '');
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ key, method: init.method || 'GET', body });

      const respond = (status, payload) => ({
        status,
        headers: new Map(),
        text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
      });

      if (override.throwOn && key.startsWith(override.throwOn)) throw new TypeError('fetch failed');

      if (key === '/api/health') return respond(200, override.health ?? HEALTH_OK);
      if (key === '/embed.js') {
        return respond(200, override.embed ?? '/* embed */ var t = attr("data-tenant"); iframe.src = origin + "/widget";');
      }
      if (key === '/widget?tenant=eum') {
        return respond(200, override.widget ?? '<html><body>이음 안내 챗봇 · AI 자동응답 · 등록된 안내 자료 기반</body></html>');
      }
      if (key === '/api/chat') {
        // override.tooLong / override.badTenant 는 "거절해야 할 입력을 200으로 받아주는 고장난 배포"를 흉내 낸다.
        if (typeof body?.message === 'string' && body.message.length > 2000) {
          return override.tooLong
            ? respond(200, override.tooLong)
            : respond(400, { code: 'invalid_input', error: 'invalid_input', message: 'message가 너무 깁니다.' });
        }
        if (body?.tenant && !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(body.tenant)) {
          return override.badTenant
            ? respond(200, override.badTenant)
            : respond(400, { code: 'invalid_input', error: 'invalid_input', message: 'tenant 형식이 잘못됐습니다.' });
        }
        if (/마일리지/.test(body?.message || '')) return respond(200, override.chatUnknown ?? CHAT_UNKNOWN_OK);
        return respond(200, override.chatFaq ?? CHAT_FAQ_OK);
      }
      return respond(404, { code: 'not_found', error: 'not_found', message: '없는 경로' });
    },
  };
}

const run = (override) => runSmoke({ baseUrl: 'https://example.test', fetchImpl: stubFetch(override).fetchImpl });

/* ══════════ 정상 경로 ══════════ */

test('정상 배포는 모든 검사를 통과하고 종료코드 0', async () => {
  const report = await run();
  const failed = report.results.filter((r) => !r.ok);
  assert.deepEqual(failed.map((f) => `${f.name}: ${f.detail}`), [], '통과해야 할 검사가 실패했다');
  assert.equal(report.failed, 0);
  assert.equal(report.passed, CHECKS.length);
  assert.equal(exitCodeFor(report), 0);
});

test('검사 목록이 이음 심사 요건(근거·CTA·단정 금지)과 실패 경로를 모두 덮는다', () => {
  const names = CHECKS.map((c) => c.name).join(' | ');
  for (const needle of ['health', 'embed.js', 'widget', '근거 번호', '단정하지 않고', '실패 경로']) {
    assert.match(names, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `검사 누락: ${needle}`);
  }
  assert.ok(CHECKS.length >= 8, '검사가 너무 적다');
});

test('개인정보를 보내지 않는다 — 고정 질의와 임의 세션 id만 나간다', async () => {
  const stub = stubFetch();
  await runSmoke({ baseUrl: 'https://example.test', fetchImpl: stub.fetchImpl });
  const posts = stub.calls.filter((c) => c.method === 'POST');
  assert.ok(posts.length >= 3);
  for (const c of posts) {
    assert.match(c.body.sessionId, /^smoke-[a-z]+-[a-z0-9]+$/, `세션 id 형식이 다르다: ${c.body.sessionId}`);
    assert.equal(/\d{2,3}-\d{3,4}-\d{4}|@|\d{6}-\d{7}/.test(c.body.message), false, '질의에 개인정보 형태 문자열이 있다');
  }
  // 관리·쓰기 API는 건드리지 않는다
  assert.equal(stub.calls.some((c) => c.key.startsWith('/api/admin')), false);
});

/* ══════════ 고장난 배포를 실제로 잡는가(실패 경로) ══════════ */

const failureCases = [
  ['이음 FAQ가 0건이면 잡는다', { health: { ...HEALTH_OK, dependencies: { ...HEALTH_OK.dependencies, tenants: [{ id: 'eum', entries: 0, skipped: 0 }] } } }, /FAQ 적재 0건/],
  ['health가 degraded면 잡는다', { health: { ...HEALTH_OK, status: 'degraded' } }, /status=degraded/],
  ['embed.js에서 data-tenant가 사라지면 잡는다', { embed: '/* embed */ iframe.src = origin + "/widget";' }, /data-tenant/],
  ['위젯에서 AI 고지가 빠지면 잡는다', { widget: '<html><body>이음 안내 챗봇</body></html>' }, /AI 고지/],
  ['근거 번호가 없으면 잡는다', { chatFaq: { ...CHAT_FAQ_OK, citation: undefined } }, /근거 번호 표시가 없다/],
  ['근거 라벨 형식이 깨지면 잡는다', { chatFaq: { ...CHAT_FAQ_OK, citation: { source: '내부 문서' } } }, /근거 번호 표시가 없다/],
  ['신청 CTA가 빠지면 잡는다', { chatFaq: { ...CHAT_FAQ_OK, cta: undefined } }, /CTA 주소가 없다/],
  ['CTA가 http(s)가 아니면 잡는다', { chatFaq: { ...CHAT_FAQ_OK, cta: { url: 'javascript:alert(1)' } } }, /CTA 주소가 없다/],
  ['FAQ 질문이 매칭되지 않으면 잡는다', { chatFaq: { ...CHAT_FAQ_OK, source: 'fallback' } }, /매칭되지 않았다/],
  ['모르는 질문에 단정하면 잡는다', { chatUnknown: { reply: '네, 마일리지로 교환할 수 있습니다.', source: 'fallback' } }, /단정|담당자 연결 안내가 없다/],
  ['모르는 질문을 FAQ 답변으로 내보내면 잡는다', { chatUnknown: { ...CHAT_UNKNOWN_OK, source: 'kb' } }, /FAQ 답변으로 내보냈다/],
  ['잘못된 테넌트를 200으로 받아주면 잡는다', { badTenant: CHAT_FAQ_OK }, /400이어야 하는데 200/],
  ['긴 입력을 200으로 받아주면 잡는다', { tooLong: CHAT_FAQ_OK }, /400이어야 하는데 200/],
];

for (const [title, override, pattern] of failureCases) {
  test(title, async () => {
    const report = await run(override);
    assert.ok(report.failed >= 1, '실패를 잡지 못했다');
    const detail = report.results.filter((r) => !r.ok).map((r) => r.detail).join(' / ');
    assert.match(detail, pattern);
    assert.equal(exitCodeFor(report), 1);
  });
}

test('tenants 필드가 없는 구버전 배포는 사유를 밝히고 실패한다', async () => {
  const report = await run({ health: { ...HEALTH_OK, dependencies: { storage: HEALTH_OK.dependencies.storage } } });
  const detail = report.results.filter((r) => !r.ok).map((r) => r.detail).join(' ');
  assert.match(detail, /구버전 배포/);
});

/* ══════════ 판정보류(접속 불가)를 실패로 부풀리지 않는다 ══════════ */

test('대상에 접속하지 못하면 종료코드 2로 멈춘다 — 검사 전부 실패로 보고하지 않는다', async () => {
  const report = await runSmoke({ baseUrl: 'https://example.test', fetchImpl: stubFetch({ throwOn: '/api/health' }).fetchImpl });
  assert.equal(report.unreachable, true);
  assert.equal(exitCodeFor(report), 2);
  assert.equal(report.failed, 0, '접속 불가를 검사 실패 건수로 세면 안 된다');
  assert.equal(report.results.length, 1, '접속 불가면 즉시 멈춘다');
  assert.match(formatReport(report), /판정보류/);
});

/* ══════════ 입력·배선 ══════════ */

test('대상 주소는 http(s)만 받는다', async () => {
  await assert.rejects(() => runSmoke({ baseUrl: 'javascript:alert(1)', fetchImpl: async () => {} }), /http\(s\)/);
  await assert.rejects(() => runSmoke({ baseUrl: '', fetchImpl: async () => {} }), /비어/);
  await assert.rejects(() => runSmoke({ baseUrl: 'not a url', fetchImpl: async () => {} }), /형식/);
});

test('기본 대상은 라이브 주소이고 SMOKE_BASE_URL로 바꿀 수 있다', () => {
  assert.equal(DEFAULT_BASE_URL, 'https://chatbot-gowon.vercel.app');
  assert.match(src, /SMOKE_BASE_URL/);
  assert.equal(pkg.scripts.smoke, 'node scripts/smoke.mjs');
});

test('보고서는 각 검사의 통과 여부를 한 줄씩 남긴다', async () => {
  const out = formatReport(await run());
  assert.equal(out.split('\n').filter((l) => l.startsWith('PASS')).length, CHECKS.length);
  assert.match(out, /통과 \d+ \/ 실패 \d+/);
});
