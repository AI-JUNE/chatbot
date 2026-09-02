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
