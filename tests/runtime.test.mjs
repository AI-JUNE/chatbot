/**
 * 런타임 동작 테스트 — TypeScript 소스를 실제로 컴파일해 실행한다.
 * (기존 unit.test.mjs는 소스 텍스트 계약 검사. 이 파일은 "정말 그렇게 동작하는가"를 본다.)
 *
 * 대상: next/react에 의존하지 않는 순수 lib 모듈.
 * typescript 미설치 등 컴파일 불가 환경에서는 전체를 skip 한다(테스트가 거짓 실패하지 않도록).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importLib, tscPath } from './_compile.mjs';

const CAN_COMPILE = tscPath() !== null;
const opts = CAN_COMPILE ? {} : { skip: 'typescript 미설치 — npm ci 후 실행' };

/** console.log/error 를 가로채 출력된 줄을 모은다. */
function captureConsole(fn) {
  const out = [];
  const err = [];
  const ol = console.log;
  const oe = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  try {
    fn();
  } finally {
    console.log = ol;
    console.error = oe;
  }
  return { out, err };
}

/* ══════════ 구조화 로깅 (정상 경로) ══════════ */

test('요청 로그 1건에 요청ID·소요시간·상태가 담긴다', opts, async () => {
  const { startRequest } = await importLib('logger', ['monitoring']);
  delete process.env.LOG_SILENT;
  process.env.LOG_LEVEL = 'info';

  const { out, err } = captureConsole(() => {
    const rl = startRequest('/api/chat', 'POST', null);
    rl.end({ status: 200, source: 'kb', intent: 'hours' });
  });

  assert.equal(err.length, 0, '2xx는 error로 나가지 않아야 한다');
  assert.equal(out.length, 1, '요청당 정확히 1건이어야 한다');
  const e = JSON.parse(out[0]);
  assert.equal(e.event, 'request');
  assert.equal(e.level, 'info');
  assert.equal(e.route, '/api/chat');
  assert.equal(e.method, 'POST');
  assert.equal(e.status, 200);
  assert.equal(e.source, 'kb');
  assert.equal(typeof e.durationMs, 'number');
  assert.ok(e.durationMs >= 0);
  assert.match(e.requestId, /^[A-Za-z0-9._-]{8,64}$/);
  assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T/);
});

test('상류가 준 요청ID를 이어받는다(분산 추적)', opts, async () => {
  const { startRequest, newRequestId } = await importLib('logger', ['monitoring']);
  assert.equal(startRequest('/api/chat', 'POST', 'abc-123-def-456').requestId, 'abc-123-def-456');
  // 형식이 어긋나면(짧음·공백·제어문자) 서버가 새로 만든다
  assert.notEqual(newRequestId('짧음'), '짧음');
  assert.notEqual(newRequestId('has space here'), 'has space here');
  assert.match(newRequestId(''), /^[A-Za-z0-9._-]{8,64}$/);
  assert.notEqual(newRequestId(null), newRequestId(null), '매번 다른 ID여야 한다');
});

test('세션 해시는 같은 세션에 일관되고 원문을 담지 않는다', opts, async () => {
  const { hashId } = await importLib('logger', ['monitoring']);
  const a = hashId('sess-01012345678');
  assert.equal(a, hashId('sess-01012345678'));
  assert.notEqual(a, hashId('sess-01087654321'));
  assert.equal(a.includes('01012345678'), false, '원문이 그대로 들어가면 안 된다');
  assert.match(a, /^[0-9a-f]{12}$/);
});

test('LOG_LEVEL 아래 레벨은 출력하지 않는다', opts, async () => {
  const { log, shouldLog } = await importLib('logger', ['monitoring']);
  assert.equal(shouldLog('debug', 'info'), false);
  assert.equal(shouldLog('error', 'info'), true);
  delete process.env.LOG_SILENT;
  process.env.LOG_LEVEL = 'warn';
  const { out, err } = captureConsole(() => log('info', 'skipped', { route: '/x' }));
  assert.equal(out.length + err.length, 0);
  process.env.LOG_LEVEL = 'info';
});

/* ══════════ 구조화 로깅 (실패 경로 · 개인정보 보호) ══════════ */

test('허용 목록 밖 필드는 기록되지 않고 이름만 남는다', opts, async () => {
  const { buildEntry } = await importLib('logger', ['monitoring']);
  const e = buildEntry('info', 'request', {
    route: '/api/chat',
    message: '제 번호는 010-1234-5678 입니다',
    contact: 'hong@example.com',
    sessionId: 'sess-raw-value',
    reply: '안녕하세요',
  });
  const json = JSON.stringify(e);
  assert.equal(e.message, undefined);
  assert.equal(e.contact, undefined);
  assert.equal(e.sessionId, undefined);
  assert.equal(/010-1234-5678|hong@example\.com|sess-raw-value|안녕하세요/.test(json), false, '개인정보·본문이 로그에 남았다');
  assert.deepEqual([...e.dropped].sort(), ['contact', 'message', 'reply', 'sessionId']);
});

test('허용 필드에 섞인 개인정보도 마스킹된다', opts, async () => {
  const { buildEntry } = await importLib('logger', ['monitoring']);
  const e = buildEntry('error', 'request', {
    status: 500,
    code: 'internal',
    error: '발송 실패: 010-9876-5432 / a.b@corp.co.kr / 900101-2345678',
  });
  assert.equal(/010-9876-5432|a\.b@corp\.co\.kr|900101-2345678/.test(e.error), false, '마스킹되지 않았다');
  assert.match(e.error, /01\*-\*\*\*\*-\*\*\*\*/);
});

test('객체·배열 값은 통째로 흘리지 않는다', opts, async () => {
  const { buildEntry } = await importLib('logger', ['monitoring']);
  const e = buildEntry('info', 'request', { route: { secret: '010-1111-2222' }, status: 200 });
  assert.equal(typeof e.route, 'undefined');
  assert.ok(e.dropped.includes('route'));
});

test('5xx는 error 레벨로, 4xx는 warn 레벨로 나간다', opts, async () => {
  const { startRequest } = await importLib('logger', ['monitoring']);
  delete process.env.LOG_SILENT;
  process.env.LOG_LEVEL = 'info';
  const r1 = captureConsole(() => startRequest('/api/chat', 'POST').end({ status: 500, code: 'internal' }));
  assert.equal(r1.out.length, 0);
  assert.equal(JSON.parse(r1.err[0]).level, 'error');
  const r2 = captureConsole(() => startRequest('/api/chat', 'POST').end({ status: 429, code: 'rate_limited' }));
  assert.equal(JSON.parse(r2.err[0]).level, 'warn');
  assert.equal(JSON.parse(r2.err[0]).code, 'rate_limited');
});

test('로깅 실패가 요청을 깨뜨리지 않는다', opts, async () => {
  const { log, startRequest } = await importLib('logger', ['monitoring']);
  delete process.env.LOG_SILENT;
  captureConsole(() => {
    assert.doesNotThrow(() => log('info', 'bad', null), 'fields가 null이어도 던지면 안 된다');
    const circular = {};
    circular.self = circular;
    assert.doesNotThrow(() => log('info', 'bad', circular));
    const rl = startRequest('/api/chat', 'POST');
    assert.doesNotThrow(() => rl.end({ status: 200 }));
    assert.doesNotThrow(() => rl.end({ status: 200 }));
  });
});

test('end()를 두 번 불러도 1건만 기록된다', opts, async () => {
  const { startRequest } = await importLib('logger', ['monitoring']);
  delete process.env.LOG_SILENT;
  process.env.LOG_LEVEL = 'info';
  const { out } = captureConsole(() => {
    const rl = startRequest('/api/chat', 'POST');
    rl.end({ status: 200 });
    rl.end({ status: 500 });
  });
  assert.equal(out.length, 1);
  assert.equal(JSON.parse(out[0]).status, 200);
});

/* ══════════ 백업·복구 리허설 (RUNBOOK.md 근거) ══════════ */

test('복구 리허설: 백업 스냅샷으로 관리 콘텐츠가 원상 복구된다', opts, async () => {
  process.env.ADMIN_PERSIST = 'false'; // 테스트가 로컬 파일을 건드리지 않게 한다
  const store = await importLib('adminStore', ['knowledge', 'normalize']);

  // 1) 운영 상태를 만든다
  store.upsertKB({ id: 'drill-1', category: '리허설', question: '복구 훈련용 항목', keywords: ['리허설'], answer: '복구 확인용 답변' });
  store.setRuleOverride('hours', { reply: '리허설 응답' });
  const before = store.exportSnapshot();
  const beforeCount = before.kb.length;
  assert.ok(before.kb.some((e) => e.id === 'drill-1'));
  assert.equal(before.version, 1);

  // 2) 장애를 흉내낸다 — 콘텐츠 유실
  store.importSnapshot({ version: 1, savedAt: new Date().toISOString(), kb: [], ruleOverrides: {}, customRules: [] });
  assert.equal(store.listKB().length, 0, '유실 상태를 만들지 못했다');

  // 3) 백업본으로 복구
  const restored = store.importSnapshot(before);
  assert.equal(restored.ok, true);
  assert.equal(restored.kb, beforeCount);
  assert.equal(store.listKB().length, beforeCount);
  assert.ok(store.listKB().some((e) => e.id === 'drill-1'), '복구 후 항목이 없다');
  assert.equal(store.getRuleOverride('hours')?.reply, '리허설 응답');
});

test('복구 실패 경로: 손상된 스냅샷은 거부하고 기존 데이터를 보존한다', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  const store = await importLib('adminStore', ['knowledge', 'normalize']);
  const keep = store.listKB().length;

  for (const bad of [null, 'text', 42, {}, { kb: [], customRules: [] }, { kb: 'x', ruleOverrides: {}, customRules: [] }]) {
    const r = store.importSnapshot(bad);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 를 통과시키면 안 된다`);
    assert.match(r.error, /필요|올바|유효/);
  }
  assert.equal(store.listKB().length, keep, '거부된 복원이 기존 데이터를 건드리면 안 된다');
});

test('복구 시 무효 항목은 건너뛰고 유효 항목만 반영한다', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  const store = await importLib('adminStore', ['knowledge', 'normalize']);
  const r = store.importSnapshot({
    version: 1,
    savedAt: new Date().toISOString(),
    kb: [
      { id: 'good-1', category: '일반', question: '정상 항목', keywords: ['정상'], answer: '정상 답변' },
      { id: '', question: '빈 ID', keywords: ['x'], answer: 'y' },
      { id: 'no-kw', question: '키워드 없음', keywords: [], answer: 'y' },
      null,
    ],
    ruleOverrides: {},
    customRules: [],
  });
  assert.equal(r.ok, true);
  assert.equal(r.kb, 1, '유효 항목 1건만 반영되어야 한다');
  assert.equal(store.listKB().length, 1);
});

/* ══════════ 저장소 어댑터 (영속화) ══════════ */

import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

/** 테스트용 임시 저장 디렉터리로 storage를 초기화한다. */
async function freshStorage(env = {}) {
  const st = await importLib('storage', ['logger', 'monitoring']);
  const dir = mkdtempSync(nodePath.join(tmpdir(), 'cb-st-'));
  process.env.LOG_SILENT = 'true';
  delete process.env.ADMIN_PERSIST;
  delete process.env.ADMIN_PERSIST_FILE;
  delete process.env.PERSIST_PII;
  process.env.STORAGE_DIR = dir;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  st.resetStorageState();
  st.setDriver('file');
  return { st, dir };
}

test('저장소 정상 경로: 파일 드라이버로 저장·복원되고 상태에 남는다', opts, async () => {
  const { st, dir } = await freshStorage();

  const saved = st.saveJson('admin', { version: 1, kb: [{ id: 'a' }] });
  assert.equal(saved.ok, true);
  assert.ok(saved.bytes > 0);
  assert.ok(existsSync(nodePath.join(dir, 'admin.json')), '파일이 만들어지지 않았다');

  const loaded = st.loadJson('admin');
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.data.kb, [{ id: 'a' }]);

  const s = st.storageStatus();
  assert.equal(s.driver, 'file');
  const ns = s.namespaces.find((n) => n.ns === 'admin');
  assert.equal(ns.health, 'ok');
  assert.equal(ns.persisted, true);
  assert.equal(ns.lastError, null);
  assert.match(ns.lastSavedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('저장소 실패 경로: 쓸 수 없는 경로여도 throw하지 않고 오류를 상태에 남긴다', opts, async () => {
  const { st, dir } = await freshStorage();
  // 디렉터리가 되어야 할 자리에 파일을 둔다 → mkdir 시 ENOTDIR
  const blocker = nodePath.join(dir, 'blocked');
  writeFileSync(blocker, 'not a directory', 'utf8');
  process.env.STORAGE_DIR = nodePath.join(blocker, 'sub');

  let threw = false;
  let res;
  try {
    res = st.saveJson('admin', { version: 1 });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, '저장 실패가 애플리케이션으로 새어나가면 안 된다');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'error');

  const ns = st.storageStatus().namespaces.find((n) => n.ns === 'admin');
  assert.equal(ns.health, 'error', '실패를 조용히 넘기면 안 된다');
  assert.equal(ns.persisted, false);
  assert.ok(ns.lastError && ns.lastError.length > 0, '실패 사유가 기록되어야 한다');
  assert.match(ns.lastErrorAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('읽기전용 파일시스템은 오류가 아니라 readonly 상태로 구분한다', opts, async () => {
  const { st } = await freshStorage();
  st.setDriver({
    name: 'file',
    read: () => null,
    write: () => {
      const e = new Error('EROFS: read-only file system, open /var/task/data/admin.json');
      e.code = 'EROFS';
      throw e;
    },
    remove: () => {},
  });

  const res = st.saveJson('admin', { version: 1 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'readonly', 'Vercel 등 읽기전용 환경은 장애 알림 대상이 아니다');
  const ns = st.storageStatus().namespaces.find((n) => n.ns === 'admin');
  assert.equal(ns.health, 'readonly');
  assert.ok(ns.lastError.includes('EROFS'));
  assert.equal(/\/var\/task/.test(ns.lastError), false, '오류 요약에 전체 경로가 남으면 안 된다');
});

test('손상된 저장 파일은 기본값으로 넘어가고 사유를 남긴다', opts, async () => {
  const { st, dir } = await freshStorage();
  writeFileSync(nodePath.join(dir, 'admin.json'), '{ 깨진 JSON', 'utf8');

  const r = st.loadJson('admin');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'error');
  const ns = st.storageStatus().namespaces.find((n) => n.ns === 'admin');
  assert.equal(ns.health, 'error');
  assert.ok(ns.lastError);
});

test('개인정보 네임스페이스는 승인 전까지 디스크에 쓰지 않는다', opts, async () => {
  const { st, dir } = await freshStorage();

  const blocked = st.saveJson('tickets', { version: 1, tickets: [{ contact: '010-1234-5678' }] });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'awaiting_approval');
  assert.equal(existsSync(nodePath.join(dir, 'tickets.json')), false, '승인 전 개인정보가 디스크에 남으면 안 된다');
  assert.equal(st.isPersistEnabled('tickets'), false);
  assert.equal(st.isPersistEnabled('audit'), true, '개인정보가 없는 감사 로그는 저장 대상이다');

  const ns = st.storageStatus().namespaces.find((n) => n.ns === 'tickets');
  assert.equal(ns.health, 'awaiting_approval');

  // 승인 후에는 같은 코드 경로로 저장된다
  process.env.PERSIST_PII = 'true';
  const approved = st.saveJson('tickets', { version: 1, tickets: [] });
  assert.equal(approved.ok, true);
  assert.ok(existsSync(nodePath.join(dir, 'tickets.json')));
  delete process.env.PERSIST_PII;
});

test('ADMIN_PERSIST=false 면 어떤 네임스페이스도 저장하지 않는다', opts, async () => {
  const { st, dir } = await freshStorage({ ADMIN_PERSIST: 'false' });
  const r = st.saveJson('admin', { version: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'disabled');
  assert.equal(existsSync(nodePath.join(dir, 'admin.json')), false);
  delete process.env.ADMIN_PERSIST;
});

test('flushSaves는 대기 중인 저장을 버리지 않고 즉시 기록한다', opts, async () => {
  const { st, dir } = await freshStorage();
  st.scheduleSave('admin', () => ({ version: 1, mark: 'flushed' }));
  assert.equal(existsSync(nodePath.join(dir, 'admin.json')), false, '디바운스 전에는 아직 쓰지 않는다');

  st.flushSaves();
  const raw = JSON.parse(readFileSync(nodePath.join(dir, 'admin.json'), 'utf8'));
  assert.equal(raw.mark, 'flushed', '대기 중이던 마지막 변경이 사라지면 안 된다');
});

test('관리 콘텐츠가 저장소를 거쳐 재기동 후에도 복원된다', opts, async () => {
  const { st, dir } = await freshStorage();
  const store = await importLib('adminStore', ['knowledge', 'normalize', 'storage', 'logger', 'monitoring']);

  store.upsertKB({ id: 'persist-1', category: '영속화', question: '저장되나요?', keywords: ['저장'], answer: '네, 저장됩니다.' });
  store.flushAdminPersist();

  const file = nodePath.join(dir, 'admin.json');
  assert.ok(existsSync(file), '관리 콘텐츠가 저장되지 않았다');
  const snap = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(snap.kb.some((e) => e.id === 'persist-1'));

  // 재기동을 흉내낸다 — 메모리를 비우고 저장분으로 복원
  store.importSnapshot({ version: 1, savedAt: new Date().toISOString(), kb: [], ruleOverrides: {}, customRules: [] }, { persist: false });
  assert.equal(store.listKB().length, 0);
  const loaded = st.loadJson('admin');
  assert.equal(loaded.ok, true);
  store.importSnapshot(loaded.data, { persist: false });
  assert.ok(store.listKB().some((e) => e.id === 'persist-1'), '재기동 복원이 되지 않았다');
});

/* ══════════ LLM 어댑터 ══════════ */

/** 호출 기록을 남기는 가짜 fetch. status/body/throw 를 시나리오로 준다. */
function fakeFetch(steps) {
  const calls = [];
  const queue = [...steps];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    const step = queue.length > 1 ? queue.shift() : queue[0];
    if (step.throws) {
      const e = new Error(step.throws === 'abort' ? 'aborted' : 'boom');
      if (step.throws === 'abort') e.name = 'AbortError';
      throw e;
    }
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      json: async () => step.json ?? {},
    };
  };
  fn.calls = calls;
  return fn;
}

function llmCfg(over = {}) {
  return {
    live: true,
    provider: 'anthropic',
    model: 'test-model',
    apiKey: 'sk-test',
    baseUrl: 'https://example.invalid',
    maxInputChars: 6000,
    maxOutputTokens: 200,
    timeoutMs: 500,
    retries: 1,
    maxCallsPerMinute: 60,
    ...over,
  };
}

const noSleep = async () => {};

test('LLM 게이트가 꺼져 있으면 네트워크 호출을 하지 않는다 [승인 필요 기본값]', opts, async () => {
  const llm = await importLib('llm', ['monitoring']);
  llm.resetLLMState();
  const f = fakeFetch([{ status: 200 }]);
  const r = await llm.complete({ system: 's', messages: [{ role: 'user', content: '안녕' }] }, {
    config: llmCfg({ live: false }),
    fetchImpl: f,
    sleep: noSleep,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'disabled');
  assert.equal(f.calls.length, 0, '게이트 OFF에서 외부 호출이 나가면 안 된다');
});

test('정상 경로 — 근거 자료로 답변을 생성하고 개인정보는 마스킹해 보낸다', opts, async () => {
  const llm = await importLib('llm', ['monitoring']);
  llm.resetLLMState();
  const f = fakeFetch([{ status: 200, json: { content: [{ type: 'text', text: '영업시간은 09시~18시입니다.' }] } }]);

  const r = await llm.generateGroundedAnswer(
    {
      question: '제 번호는 010-1234-5678인데 영업시간 알려주세요',
      docs: [{ id: 'kb-1', question: '영업시간', answer: '평일 09시~18시' }],
    },
    { config: llmCfg(), fetchImpl: f, sleep: noSleep },
  );

  assert.equal(r.failed, undefined);
  assert.equal(r.text, '영업시간은 09시~18시입니다.');
  assert.equal(f.calls.length, 1);

  const sent = JSON.stringify(f.calls[0].body);
  assert.equal(sent.includes('010-1234-5678'), false, '전화번호 원문이 외부로 나가면 안 된다');
  assert.match(sent, /01\*-\*\*\*\*-\*\*\*\*/);
  assert.match(f.calls[0].body.system, /자료/, '근거 자료가 시스템 프롬프트에 담겨야 한다');
  assert.equal(f.calls[0].body.max_tokens, 200, '출력 토큰 상한이 적용되어야 한다');
  assert.equal(f.calls[0].init.headers['x-api-key'], 'sk-test');
});

test('실패 경로 — 5xx는 재시도하고, 끝내 실패하면 사유만 남기고 throw 하지 않는다', opts, async () => {
  const llm = await importLib('llm', ['monitoring']);
  llm.resetLLMState();
  const f = fakeFetch([{ status: 503 }]);
  const r = await llm.complete({ system: 's', messages: [{ role: 'user', content: '질문' }] }, {
    config: llmCfg({ retries: 2 }),
    fetchImpl: f,
    sleep: noSleep,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'upstream_error');
  assert.equal(r.attempts, 3, 'retries=2 → 총 3회 시도');
  assert.equal(f.calls.length, 3);
});

test('실패 경로 — 4xx는 재시도하지 않는다(무의미한 재호출 금지)', opts, async () => {
  const llm = await importLib('llm', ['monitoring']);
  llm.resetLLMState();
  const f = fakeFetch([{ status: 400 }]);
  const r = await llm.complete({ system: 's', messages: [{ role: 'user', content: '질문' }] }, {
    config: llmCfg({ retries: 2 }),
    fetchImpl: f,
    sleep: noSleep,
  });
  assert.equal(r.ok, false);
  assert.equal(f.calls.length, 1);
});

test('실패 경로 — 타임아웃/네트워크 오류를 사유로 구분한다', opts, async () => {
  const llm = await importLib('llm', ['monitoring']);
  llm.resetLLMState();
  const t = await llm.complete({ system: 's', messages: [{ role: 'user', content: 'q' }] }, {
    config: llmCfg({ retries: 0 }),
    fetchImpl: fakeFetch([{ throws: 'abort' }]),
    sleep: noSleep,
  });
  assert.equal(t.reason, 'timeout');

  llm.resetLLMState();
  const n = await llm.complete({ system: 's', messages: [{ role: 'user', content: 'q' }] }, {
    config: llmCfg({ retries: 0 }),
    fetchImpl: fakeFetch([{ throws: 'net' }]),
    sleep: noSleep,
  });
  assert.equal(n.reason, 'network');
});

test('키가 없으면 호출 없이 not_configured (시크릿 하드코딩 금지 전제)', opts, async () => {
  const llm = await importLib('llm', ['monitoring']);
  llm.resetLLMState();
  const f = fakeFetch([{ status: 200 }]);
  const r = await llm.complete({ system: 's', messages: [{ role: 'user', content: 'q' }] }, {
    config: llmCfg({ apiKey: '' }),
    fetchImpl: f,
    sleep: noSleep,
  });
  assert.equal(r.reason, 'not_configured');
  assert.equal(f.calls.length, 0);
});

test('분당 호출 상한을 넘기면 비용이 새기 전에 막는다', opts, async () => {
  const llm = await importLib('llm', ['monitoring']);
  llm.resetLLMState();
  const f = fakeFetch([{ status: 200, json: { content: [{ type: 'text', text: '답' }] } }]);
  const cfg = llmCfg({ maxCallsPerMinute: 2, retries: 0 });
  const run = () => llm.complete({ system: 's', messages: [{ role: 'user', content: 'q' }] }, { config: cfg, fetchImpl: f, sleep: noSleep });

  assert.equal((await run()).ok, true);
  assert.equal((await run()).ok, true);
  const third = await run();
  assert.equal(third.ok, false);
  assert.equal(third.reason, 'budget_exceeded');
  assert.equal(f.calls.length, 2, '상한 초과분은 호출 자체가 나가지 않아야 한다');
});

test('연속 실패가 쌓이면 서킷을 열어 장애 중인 업스트림을 두들기지 않는다', opts, async () => {
  const llm = await importLib('llm', ['monitoring']);
  llm.resetLLMState();
  const f = fakeFetch([{ status: 500 }]);
  const cfg = llmCfg({ retries: 0 });
  for (let i = 0; i < llm.CIRCUIT_FAILURE_LIMIT; i += 1) {
    await llm.complete({ system: 's', messages: [{ role: 'user', content: 'q' }] }, { config: cfg, fetchImpl: f, sleep: noSleep });
  }
  const before = f.calls.length;
  const blocked = await llm.complete({ system: 's', messages: [{ role: 'user', content: 'q' }] }, { config: cfg, fetchImpl: f, sleep: noSleep });
  assert.equal(blocked.reason, 'circuit_open');
  assert.equal(f.calls.length, before, '서킷이 열린 동안 추가 호출이 나가면 안 된다');
  assert.equal(llm.llmState().circuitOpen, true);
  llm.resetLLMState();
});

test('입력 상한 — 오래된 턴부터 버리고 마지막 질문은 반드시 남긴다', opts, async () => {
  const llm = await importLib('llm', ['monitoring']);
  const msgs = [
    { role: 'user', content: 'A'.repeat(400) },
    { role: 'assistant', content: 'B'.repeat(400) },
    { role: 'user', content: '마지막 질문' },
  ];
  const c = llm.clampMessages('시스템', msgs, 500);
  assert.ok(c.dropped > 0, '오래된 턴이 버려져야 한다');
  assert.equal(c.messages[c.messages.length - 1].content, '마지막 질문');
  assert.ok(c.chars <= 500);
  assert.ok(llm.estimateTokens('안녕하세요') > llm.estimateTokens('hello'), '한국어 토큰 추정이 더 커야 한다');
});

/* ══════════ 대화 엔진 × LLM 폴백 ══════════ */

// 대화 엔진 모듈들은 **한 번의 컴파일 결과를 공유**해야 상태(KB·세션)가 통한다.
// importLib의 캐시 키는 [이름, ...deps] 이므로, 자기 자신을 뺀 같은 집합을 넘겨 키를 일치시킨다.
const ENGINE = [
  'chat', 'adminStore', 'knowledge', 'rules', 'normalize', 'session',
  'escalation', 'handoff', 'llm', 'monitoring', 'storage', 'logger', 'convlog',
];
const eng = (name) => importLib(name, ENGINE.filter((n) => n !== name));

/** 확신 매칭은 안 되지만 연관 제안(근거 자료)은 걸리는 질문을 만들어 LLM 경로를 태운다. */
async function seedLLMFixture() {
  process.env.ADMIN_PERSIST = 'false';
  const chat = await eng('chat');
  const store = await eng('adminStore');
  const session = await eng('session');
  const llm = await eng('llm');
  store.upsertKB({
    id: 'rt-llm-kb',
    category: '테스트',
    question: '핀번호 확인 방법',
    keywords: ['zzzzq'],
    answer: '마이페이지 > 내 정보에서 확인하실 수 있습니다.',
  });
  session.resetSessions();
  llm.resetLLMState();
  return { chat, store, session, llm, question: '핀번호' };
}

test('LLM 경로에 진입하려면 근거 자료(연관 FAQ)가 있어야 한다', opts, async () => {
  const { chat, question } = await seedLLMFixture();
  delete process.env.CHAT_LLM_LIVE;
  const base = chat.replyTo(question, 'rt-llm-base');
  assert.equal(base.source, 'fallback');
  assert.equal(base.suggestions?.length > 0, true, '연관 제안이 있어야 LLM에 줄 근거가 생긴다');
});

test('LLM이 실패해도 결정적 폴백 답변이 그대로 나간다(빈 화면 금지)', opts, async () => {
  const { chat, question } = await seedLLMFixture();
  process.env.CHAT_LLM_LIVE = 'true';
  try {
    const r = await chat.replyToAsync(question, 'rt-llm-fail', {
      config: llmCfg({ retries: 0 }),
      fetchImpl: fakeFetch([{ status: 500 }]),
      sleep: noSleep,
    });
    assert.equal(r.source, 'fallback', '실패했는데 생성 답변인 척하면 안 된다');
    assert.equal(r.llmFailure, 'upstream_error', '실패 사유가 로그용으로 남아야 한다');
    assert.ok(r.reply.length > 0, '사용자에게 보여줄 안내가 반드시 있어야 한다');
    assert.equal(r.reply.includes('undefined'), false);
    assert.match(r.reply, /상담원/, '막혔을 때 다음 행동을 제시해야 한다');
  } finally {
    delete process.env.CHAT_LLM_LIVE;
  }
});

test('LLM 성공 시 근거 자료를 넘기고 AI 생성 고지를 붙인다', opts, async () => {
  const { chat, question } = await seedLLMFixture();
  process.env.CHAT_LLM_LIVE = 'true';
  const f = fakeFetch([{ status: 200, json: { content: [{ type: 'text', text: '마이페이지에서 확인하실 수 있어요.' }] } }]);
  try {
    const r = await chat.replyToAsync(question, 'rt-llm-ok', {
      config: llmCfg({ retries: 0 }),
      fetchImpl: f,
      sleep: noSleep,
    });
    assert.equal(r.source, 'llm');
    assert.match(r.reply, /마이페이지에서 확인하실 수 있어요/);
    assert.match(r.reply, /AI가 등록된 자료를 근거로/, 'AI 생성 고지가 빠지면 안 된다');
    assert.equal(f.calls.length, 1);
    assert.match(f.calls[0].body.system, /핀번호 확인 방법/, '근거 자료가 프롬프트에 담겨야 한다');
  } finally {
    delete process.env.CHAT_LLM_LIVE;
  }
});

test('게이트가 꺼져 있으면 replyToAsync는 replyTo와 같은 답을 준다', opts, async () => {
  delete process.env.CHAT_LLM_LIVE;
  const chat = await eng('chat');
  const session = await eng('session');

  session.resetSessions();
  const sync = chat.replyTo('영업시간 알려주세요', 'rt-same-1');
  session.resetSessions();
  const asyncReply = await chat.replyToAsync('영업시간 알려주세요', 'rt-same-2');

  assert.equal(asyncReply.reply, sync.reply);
  assert.equal(asyncReply.source, sync.source);
});

/* ══════════ 웹훅 서명 검증 · 재시도 ══════════ */

test('정상 경로 — 올바른 서명은 통과한다', opts, async () => {
  const wa = await importLib('webhookAuth', []);
  const now = 1_700_000_000_000;
  const ts = String(Math.floor(now / 1000));
  const body = JSON.stringify({ userRequest: { utterance: '영업시간' } });
  const sig = wa.signPayload('secret-1', ts, body);

  assert.deepEqual(wa.verifySignature({ secret: 'secret-1', signature: sig, timestamp: ts, rawBody: body, nowMs: now }), { ok: true });
  assert.deepEqual(wa.verifySignature({ secret: 'secret-1', signature: `v1=${sig}`, timestamp: ts, rawBody: body, nowMs: now }), { ok: true });
});

test('실패 경로 — 본문 변조·시크릿 불일치·리플레이·누락을 각각 거절한다', opts, async () => {
  const wa = await importLib('webhookAuth', []);
  const now = 1_700_000_000_000;
  const ts = String(Math.floor(now / 1000));
  const body = JSON.stringify({ a: 1 });
  const sig = wa.signPayload('secret-1', ts, body);
  const base = { secret: 'secret-1', signature: sig, timestamp: ts, rawBody: body, nowMs: now };

  assert.equal(wa.verifySignature({ ...base, rawBody: JSON.stringify({ a: 2 }) }).reason, 'mismatch');
  assert.equal(wa.verifySignature({ ...base, secret: 'secret-2' }).reason, 'mismatch');
  assert.equal(wa.verifySignature({ ...base, nowMs: now + 10 * 60_000 }).reason, 'expired', '오래된 요청 재전송은 막아야 한다');
  assert.equal(wa.verifySignature({ ...base, signature: '' }).reason, 'missing_signature');
  assert.equal(wa.verifySignature({ ...base, timestamp: '' }).reason, 'missing_timestamp');
  assert.equal(wa.verifySignature({ ...base, timestamp: 'abc' }).reason, 'bad_timestamp');
  assert.equal(wa.verifySignature({ ...base, secret: '' }).reason, 'no_secret');
});

test('서명 비교는 값을 그대로 비교하지 않는다(상수 시간)', opts, async () => {
  const wa = await importLib('webhookAuth', []);
  assert.equal(wa.safeEqual('abc', 'abc'), true);
  assert.equal(wa.safeEqual('abc', 'abd'), false);
  assert.equal(wa.safeEqual('abc', 'abcdefghijk'), false, '길이가 달라도 예외 없이 false여야 한다');
  assert.equal(wa.safeEqual('', ''), true);
});

test('재시도(중복 전달)는 엔진을 다시 돌리지 않고 이전 응답을 돌려준다', opts, async () => {
  const wa = await importLib('webhookAuth', []);
  wa.resetDedupe();
  const now = 1_700_000_000_000;
  const key = wa.eventKey(['evt', 'delivery-1']);

  assert.equal(wa.dedupeCheck(key, { now }).duplicate, false, '첫 전달은 처리해야 한다');
  wa.dedupeRemember(key, { version: '2.0' }, { now });

  const again = wa.dedupeCheck(key, { now: now + 1000 });
  assert.equal(again.duplicate, true);
  assert.deepEqual(again.response, { version: '2.0' });

  // TTL이 지나면 다시 새 이벤트로 본다
  assert.equal(wa.dedupeCheck(key, { now: now + 120_000, ttlMs: 60_000 }).duplicate, false);
  wa.resetDedupe();
});

test('카카오 웹훅 인증 — 시크릿 미설정 시 정책(선택/필수)에 따라 갈린다', opts, async () => {
  const kakao = await importLib('kakao', ['webhookAuth']);
  const body = '{"userRequest":{"utterance":"안녕"}}';
  const h = (o = {}) => new Headers(o);

  assert.equal(kakao.authenticateKakao(h(), body, {}).ok, true, '미설정 + 선택 → 통과(현행 유지)');
  assert.equal(
    kakao.authenticateKakao(h(), body, { KAKAO_SIGNATURE_REQUIRED: 'true' }).reason,
    'no_secret',
    '필수인데 시크릿이 없으면 조용히 열지 말고 차단해야 한다',
  );
  assert.equal(kakao.authenticateKakao(h({ 'x-skill-token': 'wrong' }), body, { KAKAO_SKILL_TOKEN: 'right' }).reason, 'bad_token');
  assert.equal(kakao.authenticateKakao(h({ 'x-skill-token': 'right' }), body, { KAKAO_SKILL_TOKEN: 'right' }).ok, true);
});

test('카카오 웹훅 인증 — 시크릿이 있으면 서명이 맞아야만 통과한다', opts, async () => {
  const kakao = await importLib('kakao', ['webhookAuth']);
  const wa = await importLib('webhookAuth', []);
  const now = 1_700_000_000_000;
  const ts = String(Math.floor(now / 1000));
  const body = '{"userRequest":{"utterance":"안녕"}}';
  const env = { KAKAO_WEBHOOK_SECRET: 's3cr3t' };
  const sig = wa.signPayload('s3cr3t', ts, body);

  assert.equal(
    kakao.authenticateKakao(new Headers({ 'x-kakao-signature': sig, 'x-kakao-timestamp': ts }), body, env, now).ok,
    true,
  );
  assert.equal(
    kakao.authenticateKakao(new Headers({ 'x-kakao-signature': 'deadbeef', 'x-kakao-timestamp': ts }), body, env, now).reason,
    'mismatch',
  );
  assert.equal(kakao.authenticateKakao(new Headers(), body, env, now).reason, 'missing_signature');
});

/* ══════════ 관리자 인증 잠금 ══════════ */

test('토큰 대입이 반복되면 잠근다(성공하면 즉시 해제)', opts, async () => {
  const aa = await importLib('adminAuth', []);
  aa.resetLockouts();
  const now = 1_700_000_000_000;
  const threshold = aa.lockThreshold();

  let st;
  for (let i = 1; i <= threshold; i += 1) st = aa.recordAttempt('1.2.3.4', false, now + i);
  assert.equal(st.locked, true, `${threshold}회 실패하면 잠겨야 한다`);
  assert.ok(st.retryAfterSec > 0);

  // 잠긴 동안은 실패를 더 세지 않는다(잠금 무한 연장 방지)
  const during = aa.recordAttempt('1.2.3.4', false, now + 1000);
  assert.equal(during.failures, st.failures);

  // 다른 IP는 영향 없음
  assert.equal(aa.lockoutStatus('9.9.9.9', now).locked, false);

  // 잠금 시간이 지나면 다시 시도할 수 있고, 성공하면 카운트가 비워진다
  const after = now + aa.lockDurationMs() + 1000;
  assert.equal(aa.lockoutStatus('1.2.3.4', after).locked, false);
  assert.equal(aa.recordAttempt('1.2.3.4', true, after).failures, 0);
  aa.resetLockouts();
});
