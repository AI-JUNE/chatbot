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
  'escalation', 'handoff', 'llm', 'monitoring', 'storage', 'logger', 'convlog', 'slots',
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

/* ══════════ 멀티턴 슬롯 수집 — 순수 엔진 ══════════ */

const FIXED_NOW = new Date(2026, 8, 3, 10, 0, 0); // 2026-09-03(목) 10:00 — 상대 날짜 계산 기준 고정

test('날짜·시간 표현을 파싱한다(상대·절대·오전오후)', opts, async () => {
  const { parseDateTime } = await eng('slots');
  assert.equal(parseDateTime('내일 오후 2시', FIXED_NOW).value, '2026-09-04 14:00');
  assert.equal(parseDateTime('오늘 09:30', FIXED_NOW).value, '2026-09-03 09:30');
  assert.equal(parseDateTime('2026-09-10 14:30', FIXED_NOW).value, '2026-09-10 14:30');
  assert.equal(parseDateTime('9월 10일 14시', FIXED_NOW).value, '2026-09-10 14:00');
  // 연도 미기재이고 이미 지난 날짜면 내년으로 본다(예약은 미래가 기본)
  assert.equal(parseDateTime('1월 5일', FIXED_NOW).value, '2027-01-05 (시간 미정)');
});

test('알아볼 수 없는 날짜 입력은 null(실패 경로)', opts, async () => {
  const { parseDateTime } = await eng('slots');
  assert.equal(parseDateTime('아무때나요', FIXED_NOW), null);
  assert.equal(parseDateTime('', FIXED_NOW), null);
});

test('선택지는 번호·동의어 양쪽으로 고를 수 있다', opts, async () => {
  const { matchChoice } = await eng('slots');
  const choices = ['웹 챗봇', '카카오톡', '전화 콜봇', '기타'];
  assert.equal(matchChoice(choices, '2'), '카카오톡');
  assert.equal(matchChoice(choices, '2번'), '카카오톡');
  assert.equal(matchChoice(choices, '카톡'), '카카오톡', '동의어 사전이 적용돼야 한다');
  assert.equal(matchChoice(choices, '9'), null, '범위 밖 번호는 거절');
  assert.equal(matchChoice(choices, '몰라요'), null);
});

test('잘못된 입력은 어느 항목이 왜 틀렸는지 + 예시를 돌려준다', opts, async () => {
  const { validateSlot, getForm, slotOf } = await eng('slots');
  const form = getForm('reservation');
  const contact = slotOf(form, 'contact');
  const bad = validateSlot(contact, '그냥 아무거나', FIXED_NOW);
  assert.equal(bad.ok, false);
  assert.match(bad.message, /연락처/);
  assert.match(bad.message, /010-1234-5678/, '입력 예시를 함께 줘야 한다');
  const good = validateSlot(contact, '연락처는 010-1234-5678 입니다', FIXED_NOW);
  assert.equal(good.ok, true);
  assert.equal(good.value, '010-1234-5678');
});

test('필수 항목은 건너뛸 수 없고, 선택 항목은 건너뛴다', opts, async () => {
  const slots = await eng('slots');
  const reservation = slots.getForm('reservation');
  const started = slots.startForm(reservation);
  const skipRequired = slots.applyInput(reservation, started.state, '건너뛰기', FIXED_NOW);
  assert.equal(skipRequired.kind, 'invalid');
  assert.match(skipRequired.message, /꼭 필요/);

  const trouble = slots.getForm('trouble');
  let st = slots.startForm(trouble).state;
  st = slots.applyInput(trouble, st, '위젯이 열리지 않아요', FIXED_NOW).state;
  st = slots.applyInput(trouble, st, '1', FIXED_NOW).state;
  const done = slots.applyInput(trouble, st, '건너뛰기', FIXED_NOW);
  assert.equal(done.kind, 'complete', '선택 항목(연락처)은 건너뛰면 바로 완료');
  assert.equal('contact' in done.values, false, '건너뛴 값은 저장하지 않는다');
  assert.equal(done.values.channel, '웹 챗봇');
});

test('"이전"은 직전 항목을 지우고 다시 묻는다', opts, async () => {
  const slots = await eng('slots');
  const form = slots.getForm('reservation');
  let st = slots.startForm(form).state;
  st = slots.applyInput(form, st, '홍길동', FIXED_NOW).state;
  assert.equal(st.values.name, '홍길동');
  const back = slots.applyInput(form, st, '이전', FIXED_NOW);
  assert.equal(back.kind, 'progress');
  assert.equal(back.slot.key, 'name');
  assert.equal('name' in back.state.values, false, '되돌린 항목의 값은 비워야 한다');
  // 첫 항목에서 "이전"은 되돌릴 곳이 없다고 안내한다(무반응 금지)
  const noBack = slots.applyInput(form, back.state, '이전', FIXED_NOW);
  assert.equal(noBack.kind, 'invalid');
  assert.match(noBack.message, /취소/);
});

/* ══════════ 멀티턴 슬롯 수집 — 대화 엔진 통합 ══════════ */

async function freshEngine() {
  delete process.env.CHAT_SLOT_FORMS;
  delete process.env.CHAT_LLM_LIVE;
  process.env.ADMIN_PERSIST = 'false';
  const chat = await eng('chat');
  const session = await eng('session');
  const esc = await eng('escalation');
  session.resetSessions();
  return { chat, session, esc };
}

test('예약 접수: 안내 → 3단계 수집 → 티켓 접수(정상 경로)', opts, async () => {
  const { chat, esc } = await freshEngine();
  const sid = 'rt-form-ok';

  const start = chat.replyTo('예약하고 싶어요', sid);
  assert.equal(start.form.id, 'reservation');
  assert.equal(start.form.step, 1);
  assert.equal(start.form.total, 3);
  assert.match(start.reply, /성함/);

  const s2 = chat.replyTo('홍길동', sid);
  assert.equal(s2.form.step, 2);
  assert.match(s2.reply, /날짜/);

  const s3 = chat.replyTo('내일 오후 2시', sid);
  assert.equal(s3.form.step, 3);
  assert.match(s3.reply, /연락처|전화번호/);

  const done = chat.replyTo('010-1234-5678', sid);
  assert.equal(done.form, undefined, '완료 턴에는 진행 표시가 없다');
  assert.ok(done.ticketId, '접수 티켓이 생겨야 한다');
  assert.match(done.reply, /접수번호/);
  assert.equal(done.reply.includes('010-1234-5678'), false, '원문 연락처를 화면에 그대로 노출하지 않는다');
  assert.match(done.reply, /010-\*\*\*\*-5678/, '마스킹된 형태로 확인시켜 준다');

  const ticket = esc.listTickets().find((t) => t.id === done.ticketId);
  assert.equal(ticket.reasonCode, 'customer_request');
  assert.match(ticket.summary, /예약자 성함: 홍길동/);
  assert.match(ticket.summary, /희망 일시/);
  assert.equal(ticket.summary.includes('010-1234-5678'), false, '이관 요약에도 원문 연락처가 남으면 안 된다');
});

test('같은 항목을 3번 못 알아들으면 상담원으로 넘긴다(실패 경로)', opts, async () => {
  const { chat, esc } = await freshEngine();
  const sid = 'rt-form-retry';
  chat.replyTo('예약하고 싶어요', sid);
  chat.replyTo('홍길동', sid);

  const r1 = chat.replyTo('아무때나요', sid);
  assert.match(r1.reply, /알아보지 못했어요/, '무엇이 왜 틀렸는지 알려야 한다');
  assert.equal(r1.form.step, 2, '같은 항목을 다시 묻는다');
  const r2 = chat.replyTo('그냥 편한 시간', sid);
  assert.equal(r2.form.step, 2);
  const r3 = chat.replyTo('알아서 해주세요', sid);
  assert.equal(r3.escalate, true);
  assert.ok(r3.ticketId);
  assert.equal(r3.handoffReason, 'max_retry');
  const ticket = esc.listTickets().find((t) => t.id === r3.ticketId);
  assert.equal(ticket.reasonCode, 'max_retry');
  assert.match(ticket.summary, /미수집 정보/, '무엇을 못 받았는지 상담원에게 알려야 한다');
});

test('"취소"로 수집을 중단하면 다음 질문은 정상 처리된다', opts, async () => {
  const { chat } = await freshEngine();
  const sid = 'rt-form-cancel';
  chat.replyTo('예약하고 싶어요', sid);
  const cancelled = chat.replyTo('취소', sid);
  assert.equal(cancelled.form, undefined);
  assert.match(cancelled.reply, /중단/);
  assert.equal(cancelled.ticketId, undefined, '취소는 접수를 만들지 않는다');

  const after = chat.replyTo('영업시간 알려주세요', sid);
  assert.equal(after.intent, 'hours', '취소 후 일반 대화로 즉시 복귀한다');
});

test('수집 중 상담원을 요청하면 즉시 이관한다', opts, async () => {
  const { chat } = await freshEngine();
  const sid = 'rt-form-agent';
  chat.replyTo('예약하고 싶어요', sid);
  const r = chat.replyTo('상담원 연결해 주세요', sid);
  assert.equal(r.escalate, true);
  assert.ok(r.ticketId);
  assert.equal(r.form, undefined);

  // 반대로 '연결이 안 돼요' 같은 증상 설명은 이관으로 새면 안 된다
  const sid2 = 'rt-form-agent-2';
  chat.replyTo('오류가 났어요', sid2);
  const symptom = chat.replyTo('연결이 안 돼요', sid2);
  assert.equal(symptom.form.id, 'trouble');
  assert.equal(symptom.form.step, 2, '증상으로 받아들이고 다음 항목으로 진행해야 한다');
});

test('게이트를 끄면(CHAT_SLOT_FORMS=false) 기존 룰 응답만 나간다', opts, async () => {
  const { chat } = await freshEngine();
  process.env.CHAT_SLOT_FORMS = 'false';
  try {
    const r = chat.replyTo('예약하고 싶어요', 'rt-form-off');
    assert.equal(r.form, undefined);
    assert.equal(r.intent, 'reservation');
    assert.equal(r.source, 'rule');
  } finally {
    delete process.env.CHAT_SLOT_FORMS;
  }
});

test('모든 폼 정의에 라벨·질문·예시가 채워져 있다(빈 화면 방지)', opts, async () => {
  const { FORMS } = await eng('slots');
  assert.ok(FORMS.length > 0);
  for (const form of FORMS) {
    assert.ok(form.title && form.slots.length > 0, `${form.id}: 제목·슬롯 필요`);
    for (const slot of form.slots) {
      assert.ok(slot.label && slot.prompt && slot.hint, `${form.id}.${slot.key}: 라벨·질문·예시 필요`);
      if (slot.kind === 'choice') assert.ok(slot.choices?.length >= 2, `${form.id}.${slot.key}: 선택지 필요`);
    }
  }
});

test('마스킹이 날짜를 계좌번호로 오인하지 않는다(회귀)', opts, async () => {
  const { maskPii } = await eng('handoff');
  const r = maskPii('예약 일시 2026-09-04 14:00, 연락처 010-1234-5678');
  assert.match(r.text, /2026-09-04 14:00/, '날짜는 원문 그대로 남아야 상담원이 일정을 안다');
  assert.match(r.text, /010-\*\*\*\*-5678/, '연락처는 마스킹돼야 한다');
  assert.equal(r.hits.includes('phone'), true);
  assert.equal(r.hits.includes('account'), false, '날짜를 계좌로 집계하면 통계가 틀어진다');
  // 진짜 계좌번호는 여전히 마스킹한다
  assert.match(maskPii('계좌 110-234-567890').text, /\*\*\*-\*\*\*\*-\*\*\*\*/);
});

/* ══════════ 파트너(채널) · 매출 귀속 ══════════ */

async function partnersLib() {
  process.env.ADMIN_PERSIST = 'false'; // 테스트는 디스크에 쓰지 않는다
  const lib = await importLib('partners', ['storage', 'logger', 'monitoring']);
  lib.resetPartners();
  return lib;
}

test('고객사는 파트너 없이도 등록된다(직접 계약이 기본)', opts, async () => {
  const P = await partnersLib();
  const r = P.upsertAccount({ name: 'OO의원' });
  assert.equal(r.ok, true);
  assert.equal(r.account.partnerId, null, 'partnerId는 nullable — 없으면 직접 계약');
  assert.equal(r.account.source, 'unknown');
  assert.equal(r.account.attribution.length, 1, '최초 등록도 귀속 근거로 남는다');
  assert.equal(r.account.attribution[0].note, '최초 등록');
});

test('귀속을 바꾸면 이전 값·사유가 이력으로 남는다(정산 근거)', opts, async () => {
  const P = await partnersLib();
  const p = P.upsertPartner({ name: '제이투모로우원', feeRateBp: 1500 });
  assert.equal(p.ok, true);
  const created = P.upsertAccount({ name: 'AA치과' });

  const moved = P.upsertAccount({
    id: created.account.id,
    name: 'AA치과',
    partnerId: p.partner.id,
    source: 'partner',
    attributionNote: '파트너 소개로 최초 미팅(2026-08-20)',
    authed: true,
  });
  assert.equal(moved.ok, true);
  assert.equal(moved.account.partnerId, p.partner.id);
  assert.equal(moved.account.attribution.length, 2);
  const last = moved.account.attribution[1];
  assert.equal(last.fromPartnerId, null);
  assert.equal(last.toPartnerId, p.partner.id);
  assert.match(last.note, /파트너 소개/);
  assert.equal(last.authed, true, '인증 여부가 남아야 분쟁 시 근거가 된다');

  // 귀속이 바뀌지 않는 단순 수정은 이력을 늘리지 않는다(노이즈 방지)
  const renamed = P.upsertAccount({ id: created.account.id, name: 'AA치과의원', partnerId: p.partner.id, source: 'partner' });
  assert.equal(renamed.account.attribution.length, 2);
});

test('잘못된 입력은 거절하고 이유를 돌려준다(실패 경로)', opts, async () => {
  const P = await partnersLib();
  assert.equal(P.upsertAccount({ name: '  ' }).error, '고객사명을 입력해 주세요.');
  assert.match(P.upsertAccount({ name: 'BB', partnerId: 'PTR-9999' }).error, /존재하지 않는 파트너/);
  assert.match(P.upsertAccount({ name: 'BB', source: 'partner' }).error, /파트너를 지정/);
  assert.match(P.upsertAccount({ name: 'BB', contractedAt: '2026-02-31' }).error, /실제 날짜/);
  assert.match(P.upsertAccount({ name: 'BB', status: 'contracted' }).error, /계약일이 필요/);
  assert.match(P.upsertPartner({ name: 'X', feeRateBp: 99999 }).error, /0~10000bp/);
  assert.match(P.upsertPartner({ name: '' }).error, /파트너명/);
});

test('연결된 고객사가 있는 파트너는 삭제되지 않는다(되돌릴 수 없는 동작 보호)', opts, async () => {
  const P = await partnersLib();
  const p = P.upsertPartner({ name: '테스트파트너' });
  P.upsertAccount({ name: 'CC사', partnerId: p.partner.id, source: 'partner' });
  const blocked = P.deletePartner(p.partner.id);
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /연결된 고객사가 1곳/);

  // 귀속을 직접 계약으로 옮기면 삭제할 수 있다
  const acc = P.queryAccounts({ partnerId: p.partner.id })[0];
  P.upsertAccount({ id: acc.id, name: acc.name, partnerId: '', source: 'direct', attributionNote: '직접 계약으로 전환' });
  assert.equal(P.deletePartner(p.partner.id).ok, true);
});

test('조회는 queryAccounts 한 곳을 지난다(2계층 확장 지점)', opts, async () => {
  const P = await partnersLib();
  const p1 = P.upsertPartner({ name: '파트너1' }).partner;
  const p2 = P.upsertPartner({ name: '파트너2' }).partner;
  P.upsertAccount({ name: '가나사', partnerId: p1.id, source: 'partner', status: 'contracted', contractedAt: '2026-09-01' });
  P.upsertAccount({ name: '다라사', partnerId: p2.id, source: 'partner' });
  P.upsertAccount({ name: '마바사', source: 'direct' });

  assert.equal(P.queryAccounts().length, 3);
  assert.equal(P.queryAccounts({ partnerId: p1.id }).length, 1);
  assert.equal(P.queryAccounts({ partnerId: 'direct' }).length, 1, '직접 계약만 걸러낼 수 있어야 한다');
  assert.equal(P.queryAccounts({ status: 'contracted' })[0].name, '가나사');
  assert.equal(P.queryAccounts({ q: '다라' }).length, 1);
  assert.equal(P.queryAccounts({ q: '없는회사' }).length, 0);
});

test('수수료율은 설정값이며, 미설정이면 임의 수치를 만들지 않는다', opts, async () => {
  const P = await partnersLib();
  delete process.env.PARTNER_DEFAULT_FEE_RATE_BP;
  const noFee = P.upsertPartner({ name: '수수료미정' }).partner;
  assert.equal(noFee.feeRateBp, null);
  assert.equal(P.effectiveFeeRateBp(noFee), null, '기본값이 없으면 null이어야 한다(임의 KPI 금지)');
  process.env.PARTNER_DEFAULT_FEE_RATE_BP = '1000';
  try {
    assert.equal(P.effectiveFeeRateBp(noFee), 1000, '설정값이 있으면 그것을 쓴다');
    assert.equal(P.effectiveFeeRateBp({ feeRateBp: 2000 }), 2000, '파트너 개별 설정이 우선');
  } finally {
    delete process.env.PARTNER_DEFAULT_FEE_RATE_BP;
  }
});

test('집계는 건수만 센다(금액·성과 수치를 지어내지 않는다)', opts, async () => {
  const P = await partnersLib();
  const p = P.upsertPartner({ name: '집계파트너' }).partner;
  P.upsertAccount({ name: 'A', partnerId: p.id, source: 'partner', status: 'contracted', contractedAt: '2026-09-01' });
  P.upsertAccount({ name: 'B', partnerId: p.id, source: 'partner' });
  P.upsertAccount({ name: 'C', source: 'direct' });

  const rows = P.rollupByPartner();
  const row = rows.find((r) => r.partnerId === p.id);
  assert.equal(row.total, 2);
  assert.equal(row.contracted, 1);
  assert.equal(row.prospect, 1);
  const direct = rows.find((r) => r.partnerId === null);
  assert.equal(direct.total, 1);
  assert.equal(Object.keys(row).some((k) => /revenue|amount|매출/.test(k)), false, '금액 필드는 아직 없다');
});

test('스냅샷 복원: 손상 항목은 건너뛰고 고아 귀속은 직접 계약으로 되돌린다', opts, async () => {
  const P = await partnersLib();
  const bad = P.importPartners({ partners: 'nope' });
  assert.equal(bad.ok, false, '형식이 어긋나면 실패를 알린다');

  const r = P.importPartners({
    version: 1,
    partners: [
      { id: 'PTR-0003', name: '복원파트너', status: 'active', feeRateBp: 1200 },
      { id: '', name: '이름없는id' },
    ],
    accounts: [
      { id: 'ACC-0007', name: '정상사', partnerId: 'PTR-0003', source: 'partner', status: 'contracted', contractedAt: '2026-01-02', attribution: [] },
      { id: 'ACC-0008', name: '고아사', partnerId: 'PTR-9999', source: 'partner' },
      { id: 'ACC-0009' },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.partners, 1, '무효 파트너는 건너뛴다');
  assert.equal(r.accounts, 2, '무효 고객사는 건너뛴다');
  assert.equal(P.getAccount('ACC-0008').partnerId, null, '없는 파트너를 가리키면 직접 계약으로 되돌린다');
  // 복원 후 새로 만든 id가 기존 id와 충돌하지 않는다
  const next = P.upsertAccount({ name: '신규사' });
  assert.equal(next.account.id, 'ACC-0010');
  assert.equal(P.upsertPartner({ name: '신규파트너' }).partner.id, 'PTR-0004');
});

