/**
 * 위젯 렌더 테스트 — ChatWidget.tsx 를 실제로 컴파일해 서버 렌더한 HTML을 검사한다.
 * (텍스트 계약 검사는 unit.test.mjs. 여기서는 "정말 그 화면이 나오는가"를 본다.)
 *
 * 컴파일 불가(typescript 미설치) 환경에서는 전체를 skip 한다 — 거짓 실패를 만들지 않는다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, existsSync, writeFileSync, renameSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const TSC = path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');
const CAN = existsSync(TSC) && existsSync(path.join(REPO, 'node_modules', 'react-dom'));
const opts = CAN ? {} : { skip: 'typescript/react-dom 미설치 — npm ci 후 실행' };

let cached = null;
let cachedMod = null;

/** ChatWidget.tsx 를 컴파일해 import 한다. */
async function loadWidget() {
  if (cached) return cached;
  const dir = mkdtempSync(path.join(tmpdir(), 'gowon-widget-'));
  cpSync(path.join(REPO, 'src', 'components', 'ChatWidget.tsx'), path.join(dir, 'ChatWidget.tsx'));
  symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2020',
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        esModuleInterop: true,
        skipLibCheck: true,
        outDir: 'out',
      },
      include: ['ChatWidget.tsx'],
    }),
  );
  execFileSync(process.execPath, [TSC, '-p', 'tsconfig.json'], { cwd: dir, stdio: 'pipe' });
  renameSync(path.join(dir, 'out', 'ChatWidget.js'), path.join(dir, 'out', 'ChatWidget.mjs'));
  const mod = await import(pathToFileURL(path.join(dir, 'out', 'ChatWidget.mjs')).href);
  cachedMod = mod;
  cached = mod.default;
  return cached;
}

/** 대화 이어가기 함수(loadThread·saveThread·clearThread)를 쓰기 위해 모듈 전체를 가져온다. */
async function loadModule() {
  if (!cachedMod) await loadWidget();
  return cachedMod;
}

/**
 * 브라우저 저장소 흉내. `throws: true` 면 접근 자체가 예외를 던진다 —
 * 서드파티 쿠키를 막은 브라우저의 iframe·사생활 보호 모드가 그렇게 동작한다.
 */
function fakeStorage({ throws = false, setThrows = false } = {}) {
  const map = new Map();
  return {
    get calls() { return map; },
    getItem(k) { if (throws) throw new Error('blocked'); return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { if (throws || setThrows) throw new Error('blocked'); map.set(k, String(v)); },
    removeItem(k) { if (throws) throw new Error('blocked'); map.delete(k); },
  };
}

/** window.sessionStorage 를 갈아 끼우고 돌려놓는다(다른 테스트의 렌더에 영향을 주지 않게). */
async function withStorage(store, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const prev = globalThis.window;
  globalThis.window = store === null ? undefined : { sessionStorage: store };
  try {
    return await fn();
  } finally {
    if (had) globalThis.window = prev;
    else delete globalThis.window;
  }
}

const TENANT = {
  id: 'eum',
  name: '이음',
  brandColor: '#BE5535',
  badge: '이',
  headerTitle: '이음 안내 챗봇',
  headerNote: 'AI가 등록된 안내 자료로 답변합니다',
  greeting: '안녕하세요! 이음 안내 챗봇입니다.',
  aiNotice: 'AI 자동응답 · 등록된 안내 자료 기반',
  cta: { label: '이음 참여 신청하기', url: 'https://example.com', hint: '' },
  starters: ['신청은 어떻게 하나요?', '활동 시간은 어떻게 되나요?', '활동확인서를 받을 수 있나요?', '참여 자격이 어떻게 되나요?'],
};

async function render(props) {
  const [{ renderToStaticMarkup }, { createElement }, Widget] = await Promise.all([
    import('react-dom/server'),
    import('react'),
    loadWidget(),
  ]);
  return renderToStaticMarkup(createElement(Widget, props));
}

test('위젯이 테넌트 브랜드색·헤더·AI 고지와 함께 렌더된다', opts, async () => {
  const html = await render({ tenant: TENANT });
  assert.match(html, /--brand:#BE5535/, '테넌트 색이 CSS 변수로 적용돼야 한다');
  assert.ok(html.includes('이음 안내 챗봇'), '헤더 이름');
  assert.ok(html.includes('AI가 응대합니다'), 'AI 고지 배지');
  assert.ok(html.includes(TENANT.aiNotice), '하단 AI 고지');
  assert.match(html, /aria-label="대화 최소화/, '최소화 버튼');
  assert.match(html, /aria-label="대화 닫고 처음으로"/, '닫기 버튼');
});

test('위젯이 빠른 답장 칩을 등록된 질문 그대로 보여준다', opts, async () => {
  const html = await render({ tenant: TENANT });
  assert.ok(html.includes('이런 걸 물어보실 수 있어요'));
  for (const q of TENANT.starters) assert.ok(html.includes(q), `빠른 답장 누락: ${q}`);
});

test('빠른 답장 지식이 없으면 칩 영역 자체를 만들지 않는다(빈 상태)', opts, async () => {
  const html = await render({ tenant: { ...TENANT, starters: [] } });
  assert.equal(html.includes('이런 걸 물어보실 수 있어요'), false, '없는 안내를 만들어 보여주면 안 된다');
});

test('위젯 렌더 결과에 접근성 속성과 내부 구현 문구 검사', opts, async () => {
  const html = await render({ tenant: TENANT });
  for (const a of ['role="dialog"', 'aria-live="polite"', 'aria-label="메시지 입력"', 'aria-label="메시지 전송"']) {
    assert.ok(html.includes(a), `접근성 속성 누락: ${a}`);
  }
  for (const leak of ['data/admin-store.json', '401이면', 'undefined', 'NaN', 'process.env']) {
    assert.equal(html.includes(leak), false, `화면에 내부 문구 노출: ${leak}`);
  }
});

test('테넌트가 없어도 기본 위젯이 AI 고지와 함께 렌더된다', opts, async () => {
  const html = await render({});
  assert.ok(html.includes('인공지능(AI)'), '기본 인사말의 AI 고지');
  assert.ok(html.includes('AI가 응대합니다'), '헤더 AI 고지');
  assert.equal(html.includes('이런 걸 물어보실 수 있어요'), false, '지식 없이 칩을 만들면 안 된다');
});

/* ── 대화 이어가기 (DS 7-1) ── */

test('저장한 대화를 같은 방문 안에서 그대로 되살린다 (DS 7-1)', opts, async () => {
  const m = await loadModule();
  const st = fakeStorage();
  await withStorage(st, () => {
    const msgs = [
      { key: 1, role: 'bot', text: '안녕하세요', at: 1000 },
      { key: 2, role: 'user', text: '신청은 어떻게 하나요?', at: 2000 },
      { key: 3, role: 'bot', text: '신청은 홈페이지에서 하실 수 있어요.', at: 3000 },
    ];
    m.saveThread('eum', 'web_abc', msgs, 5000);
    const back = m.loadThread('eum', 6000);
    assert.ok(back, '저장한 대화를 되살리지 못했다');
    assert.equal(back.id, 'web_abc', '세션 식별자가 이어지지 않으면 서버 문맥과 끊긴다');
    assert.deepEqual(back.msgs.map((x) => x.text), msgs.map((x) => x.text));
    // 테넌트가 다르면 남의 대화를 보여주면 안 된다.
    assert.equal(m.loadThread('default', 6000), null, '다른 테넌트의 대화가 섞인다');
  });
});

test('인사말뿐이거나 지나간 오류 안내는 저장하지 않는다 (DS 7-1)', opts, async () => {
  const m = await loadModule();
  const st = fakeStorage();
  await withStorage(st, () => {
    m.saveThread('eum', 'web_abc', [{ key: 1, role: 'bot', text: '안녕하세요', at: 1 }], 1000);
    assert.equal(m.loadThread('eum', 1000), null, '이어갈 대화가 없는데 저장한다');
    // 전송 실패 안내는 그때의 상황이다 — 다시 열었을 때 남아 있으면 지나간 오류를 현재로 읽는다.
    m.saveThread('eum', 'web_abc', [
      { key: 1, role: 'bot', text: '안녕하세요', at: 1 },
      { key: 2, role: 'user', text: '문의드려요', at: 2 },
      { key: 3, role: 'bot', text: '연결이 원활하지 않아 메시지를 보내지 못했습니다.', at: 3, failed: '문의드려요' },
    ], 1000);
    const back = m.loadThread('eum', 1000);
    assert.ok(back);
    assert.equal(back.msgs.length, 2, '지나간 오류 안내까지 되살린다');
    assert.equal(back.msgs.some((x) => x.failed !== undefined), false);
  });
});

test('서버 세션이 만료된 대화는 되살리지 않고 지운다 (DS 7-1)', opts, async () => {
  const m = await loadModule();
  const st = fakeStorage();
  await withStorage(st, () => {
    const msgs = [
      { key: 1, role: 'bot', text: '안녕하세요', at: 1 },
      { key: 2, role: 'user', text: '문의드려요', at: 2 },
    ];
    m.saveThread('eum', 'web_abc', msgs, 0);
    assert.ok(m.loadThread('eum', m.THREAD_TTL_MS - 1), '유효 시간 안인데 버린다');
    m.saveThread('eum', 'web_abc', msgs, 0);
    assert.equal(m.loadThread('eum', m.THREAD_TTL_MS + 1), null, '서버 문맥이 사라진 대화를 이어 보인다');
    assert.equal(st.calls.size, 0, '만료된 대화가 저장소에 그대로 남는다');
  });
});

test('저장소가 막혀 있어도 위젯이 죽지 않는다 (DS 7-1 실패 경로)', opts, async () => {
  const m = await loadModule();
  const msgs = [
    { key: 1, role: 'bot', text: '안녕하세요', at: 1 },
    { key: 2, role: 'user', text: '문의드려요', at: 2 },
  ];
  // 접근 자체가 예외를 던지는 환경(쿠키 차단 iframe·사생활 보호 모드).
  await withStorage(fakeStorage({ throws: true }), () => {
    assert.doesNotThrow(() => m.saveThread('eum', 'web_abc', msgs, 1));
    assert.equal(m.loadThread('eum', 1), null);
    assert.doesNotThrow(() => m.clearThread('eum'));
  });
  // 저장 공간 초과 — 읽기는 되고 쓰기만 실패한다.
  await withStorage(fakeStorage({ setThrows: true }), () => {
    assert.doesNotThrow(() => m.saveThread('eum', 'web_abc', msgs, 1));
  });
  // 깨진 값이 들어 있으면 새 대화로 시작한다.
  const broken = fakeStorage();
  broken.calls.set('gowon-chat-thread:eum', '{ not json');
  await withStorage(broken, () => {
    assert.equal(m.loadThread('eum', 1), null, '깨진 저장값에 위젯이 걸려 넘어진다');
  });
  // 서버 렌더에는 저장소가 없다.
  await withStorage(null, () => {
    assert.equal(m.loadThread('eum', 1), null);
    assert.doesNotThrow(() => m.saveThread('eum', 'web_abc', msgs, 1));
  });
});

test('서버 렌더에는 이어가기 표시가 없다 (DS 7-1)', opts, async () => {
  const html = await render({ tenant: TENANT });
  assert.equal(html.includes('이전 대화를 이어서 보고 있습니다'), false, '저장소를 읽기 전에 이어간다고 단정한다');
});

test('렌더된 위젯에 비활성 버튼이 없다 (DS 8-2)', opts, async () => {
  const html = await render({ tenant: TENANT, defaultOpen: true });
  const bad = (html.match(/<button[^>]*\sdisabled[^>]*>/g) || []);
  assert.equal(bad.length, 0, `비활성 버튼 ${bad.length}곳: ${bad.slice(0, 2).join(' / ')}`);
});

test('연락처 형식 오류를 사람 말로 구분해 알려준다 (DS 8-2)', opts, async () => {
  const m = await loadModule();
  // 통과해야 하는 값
  for (const ok of ['010-1234-5678', 'name@example.com', '02 123 4567']) {
    assert.equal(m.contactError(ok), '', `막으면 안 되는 값: ${ok}`);
    assert.equal(m.validContact(ok), true, `막으면 안 되는 값: ${ok}`);
  }
  // 막아야 하는 값은 **왜** 막았는지가 서로 달라야 한다 — 한 문장으로 뭉치면 고칠 수가 없다.
  assert.match(m.contactError(''), /입력해 주세요/, '비었을 때');
  assert.match(m.contactError('  '), /연락처 없이 접수/, '비었을 때는 남기지 않는 길도 알려준다');
  assert.match(m.contactError('name@example'), /name@example\.com/, '이메일 형식');
  assert.match(m.contactError('010-12'), /010-0000-0000/, '전화번호 자릿수');
  assert.match(m.contactError('아무개'), /전화번호.*또는 이메일|이메일.*또는 전화번호/, '형식을 알 수 없을 때');
  assert.match(m.contactError('a'.repeat(120)), /너무 깁니다/, '너무 길 때');
  // contactError 와 validContact 가 어긋나면 「눌러도 안 되는데 오류도 없는」 상태가 된다.
  for (const v of ['010-1234-5678', 'name@example.com', '', '010-12', '아무개', 'x'.repeat(120)]) {
    assert.equal(m.contactError(v) === '', m.validContact(v.trim()), `판정이 어긋난다: ${v.slice(0, 12)}`);
  }
});

