/**
 * 위젯 렌더 테스트 — ChatWidget.tsx 를 실제로 컴파일해 서버 렌더한 HTML을 검사한다.
 * (텍스트 계약 검사는 unit.test.mjs. 여기서는 "정말 그 화면이 나오는가"를 본다.)
 *
 * 컴파일 불가(typescript 미설치) 환경에서는 전체를 skip 한다 — 거짓 실패를 만들지 않는다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, existsSync, writeFileSync, renameSync, symlinkSync, readFileSync } from 'node:fs';
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

/**
 * 임시 폴더에 node_modules 를 잇는다.
 * Windows 의 디렉터리 심볼릭 링크는 관리자·개발자 모드가 아니면 EPERM 이라 정션을 쓴다
 * (정션은 권한이 필요 없다). 그래도 안 되면 심볼릭 링크로 되돌린다.
 */
function linkNodeModules(dir) {
  const target = path.join(REPO, 'node_modules');
  const link = path.join(dir, 'node_modules');
  if (process.platform === 'win32') {
    try { symlinkSync(target, link, 'junction'); return; } catch { /* 아래 심볼릭 링크로 */ }
  }
  symlinkSync(target, link, 'dir');
}

/** ChatWidget.tsx 를 컴파일해 import 한다. */
async function loadWidget() {
  if (cached) return cached;
  const dir = mkdtempSync(path.join(tmpdir(), 'gowon-widget-'));
  cpSync(path.join(REPO, 'src', 'components', 'ChatWidget.tsx'), path.join(dir, 'ChatWidget.tsx'));
  linkNodeModules(dir);
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

test('tenant 없는 기본 위젯도 fallbackStarters 로 빠른 답장을 보여준다 (DS 19-1)', opts, async () => {
  const FALLBACK = ['환불은 어떻게 하나요?', '상담원과 연결하고 싶어요', '영업시간이 어떻게 되나요?', '요금은 얼마인가요?'];
  const html = await render({ fallbackStarters: FALLBACK });
  assert.ok(html.includes('이런 걸 물어보실 수 있어요'), '기본 위젯도 지식이 있으면 칩을 보여줘야 한다');
  for (const q of FALLBACK) assert.ok(html.includes(q), `빠른 답장 누락: ${q}`);
});

test('tenant 가 있으면 자기 starters 가 비어 있어도 fallbackStarters 로 새지 않는다 (테넌트 격리, DS 19-1)', opts, async () => {
  const html = await render({ tenant: { ...TENANT, starters: [] }, fallbackStarters: ['일반 지식 질문 하나'] });
  assert.equal(html.includes('이런 걸 물어보실 수 있어요'), false, '테넌트 대화에 일반 지식 칩이 섞이면 안 된다');
  assert.equal(html.includes('일반 지식 질문 하나'), false, 'fallbackStarters 문구가 테넌트 위젯에 새어 나가면 안 된다');
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

/* ── 말풍선이 긴 URL·주문번호로 대화창 밖으로 밀려나지 않는다 (DS 18-1) ── */

test('말풍선이 끊을 수 없는 긴 문자열(URL 등)에 word-break:break-word 로 대비한다 (DS 18-1)', opts, async () => {
  const html = await render({ tenant: TENANT });
  // body 전역 규칙은 한글 어절 보존을 위해 word-break:keep-all 이다(globals.css) — 라틴 문자로만
  // 이어진 긴 문자열(URL·주문번호)은 그 규칙 아래서는 어디서도 끊기지 않는다. 콘솔의 응답 테스트
  // 미리보기(.ac-pv-user/.ac-pv-bot)는 이미 word-break:break-word 를 갖고 있었는데, 정작 실제
  // 위젯 말풍선(인사말이 쓰는 것과 같은 스타일 블록)에는 닿지 않았었다 — 라이브 375px 실측:
  // 168자 URL 한 줄을 치면 대화 영역이 scrollWidth 1290px/clientWidth 349px 로 가로로 밀렸다.
  const bubbleStyleMatch = html.match(/<div style="([^"]*white-space:pre-wrap[^"]*)">안녕하세요/);
  assert.ok(bubbleStyleMatch, '인사말 말풍선을 찾지 못했다');
  assert.match(bubbleStyleMatch[1], /word-break:break-word/, '말풍선에 word-break:break-word 가 없다');
});

test('근거 인용문도 같은 이유로 word-break:break-word 를 갖는다 (DS 18-1)', opts, async () => {
  const source = readFileSync(path.join(REPO, 'src', 'components', 'ChatWidget.tsx'), 'utf8');
  const line = source.split('\n').find((l) => l.includes('m.citation.snippet'));
  assert.ok(line, '근거 인용 div 를 찾지 못했다');
  assert.match(line, /wordBreak: 'break-word'/, '근거 인용 div 에 wordBreak 대비가 없다');
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

/**
 * DS 20-3 — 되살린 대화에서 상담원을 연결하면 접수에 마지막 말이 실리지 않았다.
 *
 * 임베드 위젯은 호스트가 페이지를 옮길 때마다 새로 뜬다(그래서 DS 7-1 이 대화를 되살린다).
 * 접수에 싣는 마지막 고객 말을 전송할 때 채우는 ref 로 들고 있으면 그 순간 빈 값이라,
 * 운영자 화면에는 「남긴 메시지 없음」이 떴다 — 고객은 분명히 물어봤다.
 * 여기서는 **저장 → 복원 → 접수에 실을 값** 왕복을 실제로 돌려 본다.
 */
test('되살린 대화에서도 접수에 실을 마지막 고객 말이 남는다 (DS 20-3)', opts, async () => {
  const m = await loadModule();
  assert.equal(typeof m.lastUserText, 'function', 'lastUserText 를 내보내야 한다');
  const st = fakeStorage();
  await withStorage(st, () => {
    const msgs = [
      { key: 1, role: 'bot', text: '안녕하세요', at: 1000 },
      { key: 2, role: 'user', text: '어제 주문한 물건이 아직 안 왔어요', at: 2000 },
      { key: 3, role: 'bot', text: '배송 조회를 도와드릴게요.', at: 3000, escalate: true },
    ];
    m.saveThread('default', 'web_abc', msgs, 4000);
    const back = m.loadThread('default', 5000);
    assert.ok(back, '되살리지 못했다');
    assert.equal(
      m.lastUserText(back.msgs),
      '어제 주문한 물건이 아직 안 왔어요',
      '되살린 대화에서 접수에 실을 말이 비면 운영자에게 「남긴 메시지 없음」으로 간다',
    );
  });
  // 봇 말만 있는 대화(인사말뿐)에는 실을 말이 없다 — 없는 것을 지어내지 않는다.
  assert.equal(m.lastUserText([{ key: 1, role: 'bot', text: '안녕하세요', at: 1 }]), '');
  assert.equal(m.lastUserText([]), '');
  // 여러 번 주고받았으면 **마지막** 고객 말이다.
  assert.equal(m.lastUserText([
    { key: 1, role: 'user', text: '첫 질문', at: 1 },
    { key: 2, role: 'bot', text: '답', at: 2 },
    { key: 3, role: 'user', text: '두 번째 질문', at: 3 },
    { key: 4, role: 'bot', text: '답', at: 4 },
  ]), '두 번째 질문');
});

test('서버 렌더에는 이어가기 표시가 없다 (DS 7-1)', opts, async () => {
  const html = await render({ tenant: TENANT });
  assert.equal(html.includes('이전 대화를 이어서 보고 있습니다'), false, '저장소를 읽기 전에 이어간다고 단정한다');
});

/* ── 보내지 않은 입력 (DS 27-1) ── */

/**
 * DS 27-1 — DS 7-1 은 **보낸 말**만 되살렸다.
 *
 * 임베드 위젯은 호스트가 페이지를 옮길 때마다 iframe 이 통째로 다시 뜬다. 긴 문의·주문번호를
 * 치던 중 링크를 한 번 누르면 적던 말이 사라지는데, 되살릴 수단도 사라졌다는 안내도 없었다.
 * 「정말 되살아나는가」는 돌려 봐야 안다.
 */
test('보내지 않은 입력을 같은 방문 안에서 되살린다 (DS 27-1)', opts, async () => {
  const m = await loadModule();
  for (const fn of ['saveDraft', 'loadDraft', 'clearDraft']) {
    assert.equal(typeof m[fn], 'function', `${fn} 을 내보내야 한다`);
  }
  const st = fakeStorage();
  await withStorage(st, () => {
    const typed = '주문번호 2026-10-04-00193 인데 환불이 가능한가요? 받은 상자가 찌그러져 있었습니다.';
    m.saveDraft('eum', typed, 1000);
    assert.equal(m.loadDraft('eum', 2000), typed, '페이지를 옮기면 적던 말이 사라진다');
    // 테넌트마다 따로 둔다 — 다른 안내 챗봇의 입력칸에 남의 글이 뜨면 안 된다.
    assert.equal(m.loadDraft('default', 2000), '', '다른 테넌트의 초안이 섞인다');

    // 대화 본문과 **다른 열쇠**를 쓴다 — 한 글자 칠 때마다 말풍선 40개를 다시 직렬화하지 않는다.
    const keys = [...st.calls.keys()];
    assert.equal(keys.length, 1, `열쇠가 하나여야 한다: ${keys.join(',')}`);
    assert.ok(keys[0].startsWith('gowon-chat-draft:'), `대화 본문과 같은 열쇠를 쓴다: ${keys[0]}`);
  });
});

test('보냈거나 비우거나 대화를 지우면 적던 말이 남지 않는다 (DS 27-1)', opts, async () => {
  const m = await loadModule();
  const st = fakeStorage();
  await withStorage(st, () => {
    // 보내면 입력칸이 비고(위젯이 `setInput('')`), 그 값이 그대로 보관으로 내려온다 → 지워야 한다.
    m.saveDraft('eum', '환불 문의', 1000);
    m.saveDraft('eum', '', 1100);
    assert.equal(m.loadDraft('eum', 1200), '', '보낸 뒤에도 지난 글이 칸에 떠 있다');
    // 공백만 남은 칸을 되살릴 이유가 없다.
    m.saveDraft('eum', '   \n ', 1300);
    assert.equal(m.loadDraft('eum', 1400), '');
    assert.equal(st.calls.size, 0, '빈 값을 저장소에 남긴다');

    // 「닫고 처음으로」 — 대화를 지우면 적던 말도 끝이다(새 대화의 빈 칸에 지난 글이 떠 있으면 안 된다).
    m.saveDraft('eum', '쓰다 만 글', 1500);
    m.clearThread('eum');
    assert.equal(m.loadDraft('eum', 1600), '', '대화를 지웠는데 적던 말이 남는다');
  });
});

test('기한이 지난 초안은 되살리지 않고 지운다 (DS 27-1)', opts, async () => {
  const m = await loadModule();
  const st = fakeStorage();
  await withStorage(st, () => {
    // 대화 본문과 **같은 기한**이다 — 서버가 문맥을 잊은 뒤(DS 24-3) 지난 질문이 칸에 떠 있으면
    // 고객은 그것이 아직 유효한 줄 알고 그대로 보낸다.
    m.saveDraft('eum', '아까 물어보려던 것', 0);
    assert.equal(m.loadDraft('eum', m.THREAD_TTL_MS - 1), '아까 물어보려던 것', '기한 안인데 버린다');
    assert.equal(m.loadDraft('eum', m.THREAD_TTL_MS + 1), '', '기한이 지난 글을 되살린다');
    assert.equal(st.calls.size, 0, '버린 글이 저장소에 남는다');
  });
});

test('너무 긴 글은 잘라서 되살리지 않는다 (DS 27-1)', opts, async () => {
  const m = await loadModule();
  const st = fakeStorage();
  await withStorage(st, () => {
    // 보낼 수 있는 길이의 두 배까지는 담는다(한계를 넘겨 치는 중에도 보관된다 — 화면이 이유를 밝힌다).
    const long = 'ㄱ'.repeat(m.MAX_INPUT_LEN + 100);
    m.saveDraft('eum', long, 1000);
    assert.equal(m.loadDraft('eum', 1100).length, long.length, '한계를 넘겨 친 글을 보관하지 않는다');
    // 상한을 넘으면 **자르지 않고** 보관을 건너뛴다 — 잘라서 되살리면 고객이 적은 글이 말없이 바뀐다.
    m.saveDraft('eum', 'ㄱ'.repeat(m.MAX_INPUT_LEN * 2 + 1), 1200);
    assert.equal(m.loadDraft('eum', 1300), '', '잘린 글을 되살린다');
    assert.equal(st.calls.size, 0, '넘친 글을 받아 저장소를 채운다');
  });
});

test('저장소가 막혀 있어도 초안 때문에 위젯이 죽지 않는다 (DS 27-1 실패 경로)', opts, async () => {
  const m = await loadModule();
  // 서드파티 쿠키를 막은 브라우저의 iframe·사생활 보호 모드 — 접근 자체가 예외를 던진다.
  await withStorage(fakeStorage({ throws: true }), () => {
    assert.doesNotThrow(() => m.saveDraft('eum', '문의 내용', 1));
    assert.doesNotThrow(() => m.clearDraft('eum'));
    assert.equal(m.loadDraft('eum', 1), '');
  });
  // 깨진 값·남의 데이터 — 빈 칸으로 시작한다(사용자에게 알릴 실패가 아니다).
  const st = fakeStorage();
  await withStorage(st, () => {
    st.setItem('gowon-chat-draft:eum', '{ 깨진');
    assert.equal(m.loadDraft('eum', 1), '');
    st.setItem('gowon-chat-draft:eum', JSON.stringify({ v: 99, at: 1, text: '다른 판' }));
    assert.equal(m.loadDraft('eum', 1), '', '모르는 형식을 그대로 화면에 올린다');
  });
  // 저장소가 아예 없는 환경(서버 렌더).
  await withStorage(null, () => {
    assert.equal(m.loadDraft('eum', 1), '');
    assert.doesNotThrow(() => m.saveDraft('eum', 'x', 1));
  });
});

test('초안 복원은 대화 복원 뒤에 있고, 서버 렌더에는 없다 (DS 27-1)', opts, () => {
  const src = readFileSync(new URL('../src/components/ChatWidget.tsx', import.meta.url), 'utf8');
  // 서버에는 저장소가 없다 — 초기값으로 읽으면 하이드레이션이 어긋난다(DS 7-1 과 같은 규칙).
  assert.match(src, /const \[input, setInput\] = useState\(''\);/, '초기값에서 저장소를 읽는다');
  // 기한이 지난 대화는 `loadThread` 안에서 초안까지 지운다 — 그보다 **먼저** 읽으면 지운 글이 화면에만 남는다.
  const i = src.indexOf('const saved = loadThread(threadId);');
  const j = src.indexOf('const savedDraft = loadDraft(threadId);');
  assert.ok(i > 0 && j > i, '초안을 대화보다 먼저 읽으면 이미 지운 글이 칸에 남는다');
  // 보관하는 자리는 한 곳뿐이다(입력이 바뀔 때).
  assert.equal((src.match(/saveDraft\(/g) || []).length, 2, '초안을 손으로 저장하는 자리가 늘었다');
  assert.match(src, /saveDraft\(threadId, input\);/, '입력이 바뀔 때 보관하지 않는다');
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


test('연락처 칸이 자동 채우기 쓰임새를 알리고 모바일 자판이 맞다 (DS 12-2)', opts, async () => {
  const mod = await loadModule();
  const { contactPurpose } = mod;
  assert.equal(typeof contactPurpose, 'function', 'contactPurpose 를 내보내야 한다');

  // 빈 칸은 전화번호로 둔다(안내 문구가 전화번호를 앞에 놓는다). 토큰이 비는 상태가 없어야 한다.
  for (const v of ['', '010', '010-1234-5678', '01012345678', '02 123 4567', '+82 10 1234 5678']) {
    assert.equal(contactPurpose(v), 'tel', `전화번호로 봐야 한다: "${v}"`);
  }
  for (const v of ['name@example.com', 'name', 'a', '010@', '홍길동 name@x.kr']) {
    assert.equal(contactPurpose(v), 'email', `이메일로 봐야 한다: "${v}"`);
  }
  // 한글만으로는 이메일이 될 수 없다 — 영문/`@` 가 나타나야 바꾼다.
  assert.equal(contactPurpose('전화'), 'tel', '한글은 아직 이메일 신호가 아니다');

  const src = readFileSync(new URL('../src/components/ChatWidget.tsx', import.meta.url), 'utf8');
  const field = src.slice(src.indexOf('id="gw-handoff-contact"'), src.indexOf('id="gw-handoff-hint"'));
  assert.equal(/autoComplete="off"/.test(field), false, '자기 연락처 칸에 자동 채우기를 막지 않는다(WCAG 1.3.5)');
  assert.match(field, /autoComplete=\{contactPurpose\(handoff\.contact\)\}/, '쓰임새를 적은 내용에서 고른다');
  // `tel` 자판에는 글자가 없어 이메일을 칠 수 없다 — 둘 다 칠 수 있는 자판은 `email` 뿐이다.
  assert.match(field, /inputMode="email"/, '전화번호·이메일을 둘 다 칠 수 있는 자판');
  assert.match(field, /autoCapitalize="off"/, 'iOS 가 name@ 를 Name@ 으로 바꾸지 않게');
  assert.match(field, /autoCorrect="off"/, '자동 고침이 주소를 건드리지 않게');
  assert.match(field, /spellCheck=\{false\}/, '맞춤법 밑줄을 긋지 않는다');
});

test('호스트 화면의 「상담창 열기」가 실제로 상담창을 연다 (DS 12-3)', opts, () => {
  const src = readFileSync(new URL('../src/components/ChatWidget.tsx', import.meta.url), 'utf8');
  const land = readFileSync(new URL('../src/app/page.tsx', import.meta.url), 'utf8');

  // 위젯이 위임 방식으로 듣는다 — 호스트(랜딩)는 서버 컴포넌트 그대로 두고 속성만 붙인다.
  const eff = src.slice(src.indexOf('// 호스트 화면의 「상담창 열기」 단추'));
  const body = eff.slice(0, 900);
  assert.match(body, /if \(embedded \|\| typeof document === 'undefined'\) return;/, '임베드 프레임 안에서는 호스트 단추가 없다');
  assert.match(body, /closest\('\[data-gowon-open\]'\)/, '속성 하나가 출처다');
  assert.match(body, /document\.addEventListener\('click', onClick\)/, '듣는다');
  assert.match(body, /document\.removeEventListener\('click', onClick\)/, '리스너를 걷는다');
  // 펼치는 자리는 한 곳(openPanel)이다 — 런처와 갈라지면 「여기부터 읽지 않은 답변」 경계를
  // 한쪽에서만 정하게 된다(DS 28-3).
  assert.match(body, /openPanel\(\);/, '펼치는 문 하나를 지난다');
  const door = src.slice(src.indexOf('const openPanel = useCallback'));
  assert.match(door.slice(0, 500), /inputRef\.current\?\.focus\(\)/, '이미 열려 있으면 입력창으로 초점을 옮긴다');
  assert.equal(/preventDefault/.test(body), false, '기본 이동을 막으면 스크립트가 죽었을 때 갈 곳이 없다');

  // 랜딩: 히어로 CTA 는 링크를 유지한 채(스크립트 없이도 섹션으로 간다) 상담창을 연다.
  const hero = land.slice(land.indexOf('상담창 열어보기') - 400, land.indexOf('상담창 열어보기'));
  assert.match(hero, /<a href="#demo" data-gowon-open/, '히어로 CTA 가 적힌 대로 동작한다');

  // 체험 섹션: 「오른쪽 아래」 같은 위치 안내만으로 시작하게 두지 않는다(WCAG 1.3.3).
  assert.match(land, /<button type="button" data-gowon-open[\s\S]{0,320}상담창 열기/, '누를 수 있는 단추가 있다');
  assert.equal(/오른쪽 아래 상담창/.test(land), false, '위치로만 안내하는 문구를 남기지 않는다');
  assert.equal(/화면 오른쪽 아래에서 지금 물어보세요/.test(land), false, '제목도 위치에 기대지 않는다');

  // 속성을 붙인 곳은 전부 누를 수 있는 요소여야 한다(div 에 붙이면 키보드로 닿지 않는다).
  const marks = land.match(/<(\w+)[^>]*data-gowon-open/g) || [];
  assert.ok(marks.length >= 2, '랜딩에 상담창을 여는 자리가 둘 이상');
  for (const m of marks) {
    assert.match(m, /^<(a|button)\b/, `키보드로 닿지 않는 요소에 붙였다: ${m}`);
  }
});

test('위젯 입력칸이 키보드 초점 표시를 지우지 않는다 (DS 14-2)', opts, async () => {
  const src = readFileSync(new URL('../src/components/ChatWidget.tsx', import.meta.url), 'utf8');
  // 고객이 직접 글을 치는 칸은 둘뿐이다(메시지·연락처). 둘 다 outline 을 지워 두면
  // Tab 으로 옮겨 온 사람은 지금 어디에 있는지 알 수 없다(WCAG 2.4.7).
  assert.equal(/outline: *'none'/.test(src), false, '위젯에서 초점 표시를 지우면 안 된다');

  // 실제로 그린 화면에도 남아 있지 않아야 한다(인라인 스타일이므로 렌더 결과에 그대로 나온다).
  const html = await render({ tenant: TENANT });
  assert.ok(html.includes('aria-label="메시지 입력"'), '메시지 입력칸이 렌더돼야 한다');
  assert.equal(/outline:none/.test(html), false, '렌더된 위젯에 초점 표시를 지운 칸이 있다');

  // 지운 자리를 대신하는 것은 공용 규칙이다 — 화면마다 따로 그리지 않는다.
  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  assert.match(css, /:focus-visible\{outline:2px solid var\(--brand\)/, '공용 초점 표시 규칙이 없다');
});

/* ══════════ 디자인 스프린트 — 20차 재감사 (DS 23-1) ══════════ */

/**
 * 끝나지 않는 요청 흉내. 진짜 `fetch` 와 같게 **신호가 끊길 때만** 거절한다 —
 * 지하철에서 신호가 끊긴 요청이 브라우저에서 그렇게 남는다(응답도, 오류도 없다).
 */
function hangingFetch(seen) {
  return (url, init) => {
    seen.push({ url, init });
    return new Promise((_resolve, reject) => {
      if (!init?.signal) return; // 기한이 없으면 영원히 끝나지 않는다(종전 동작)
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });
  };
}

/** `globalThis.fetch` 를 잠시 바꿔 치고 되돌린다. */
async function withFetch(impl, fn) {
  const prev = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = prev; }
}

/**
 * DS 23-1 — 답이 끝내 오지 않으면 위젯은 영원히 기다렸다.
 *
 * 브라우저 `fetch` 에는 시간 제한이 없다. 그 사이 `busy` 는 참이라 타이핑 점 3개가 계속 돌고
 * `sendText` 앞단의 `if (!text || busy) return` 이 **다시 보내기까지 조용히 무시**했다.
 * 소스 검사로는 "정말 끊기는가"를 볼 수 없으므로 여기서는 컴파일한 함수를 실제로 돌린다.
 */
test('기한이 지나면 요청을 끊는다 (DS 23-1)', opts, async () => {
  const mod = await loadModule();
  const seen = [];

  const t0 = Date.now();
  const err = await withFetch(hangingFetch(seen), () =>
    mod.postJson('/api/chat', { message: '안녕하세요' }, 40).then(
      () => null,
      (e) => e,
    ),
  );
  assert.ok(err, '끝나지 않는 요청인데 성공으로 돌아왔다');
  assert.equal(err.name, 'AbortError', `기한이 지나도 요청을 끊지 않는다(${err.name})`);
  assert.ok(Date.now() - t0 < 3000, '기한을 훨씬 넘겨서 끊는다');
  assert.ok(seen[0].init.signal, '요청에 끊을 수 있는 신호를 붙이지 않았다');
  assert.equal(seen[0].init.method, 'POST', '기존 요청 형태가 바뀌었다');
  assert.equal(JSON.parse(seen[0].init.body).message, '안녕하세요', '본문이 그대로 가지 않는다');
});

test('기한 안에 온 답은 그대로 쓰고 끊지 않는다 (DS 23-1)', opts, async () => {
  const mod = await loadModule();

  // ① 정상 응답 — 타이머가 받은 답을 끊어 버리면 안 된다.
  const okRes = await withFetch(
    async () => ({ ok: true, status: 200, json: async () => ({ ok: true, reply: '안내해 드릴게요' }) }),
    () => mod.postJson('/api/chat', {}, 1000),
  );
  assert.equal(okRes.r.ok, true);
  assert.equal(okRes.data.reply, '안내해 드릴게요', '응답 본문을 그대로 돌려주지 않는다');

  // ② 본문이 JSON 이 아닐 때(중간 장비의 HTML 오류 페이지) — 파싱 실패로 안내까지 잃지 않는다.
  const badRes = await withFetch(
    async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('not json'); } }),
    () => mod.postJson('/api/chat', {}, 1000),
  );
  assert.equal(badRes.data, null, '본문을 읽지 못하면 예외가 새어 나간다');
  assert.equal(badRes.r.status, 502, '응답 자체는 부르는 쪽에 전해져야 한다(상태별 안내)');
});

/* ══════════ 디자인 스프린트 — 21차 재감사 (DS 24-3) ══════════ */

/**
 * DS 24-3 — 상담창을 열어 둔 채 자리를 비운 사람.
 *
 * 서버는 30분 동안 말이 없던 대화의 문맥을 지운다. 페이지를 옮기면 복원 관문(`loadThread`)이
 * 그 사실을 보고 새로 시작하지만, 창을 그대로 둔 사람은 그 관문을 지나지 않는다 — 화면에는
 * 「예약 접수 · 성함을 알려주세요」 카드가 그대로 떠 있다. 「지금 보낸 것이 서버에 남은 문맥과
 * 이어지는가」를 보는 판정이라 경계값(정확히 TTL·첫 발화)을 돌려서 확인한다.
 */
test('한동안 비워 둔 대화를 알아본다 (DS 24-3)', opts, async () => {
  const mod = await loadModule();
  const TTL = mod.THREAD_TTL_MS;
  assert.equal(TTL, 30 * 60 * 1000, '서버 세션 TTL 과 다른 값이면 판정 자체가 어긋난다');

  // 아직 한 번도 주고받지 않았으면 지울 문맥도 없다 — 첫 질문에 「초기화됐습니다」가 뜨면 안 된다.
  assert.equal(mod.threadExpired(0, Date.now()), false, '첫 발화에 지난 대화가 있다고 말한다');
  // 경계: 딱 TTL 까지는 서버 문맥이 살아 있다(`now - at > TTL` 일 때만 지운다).
  assert.equal(mod.threadExpired(1_000_000, 1_000_000 + TTL), false, '아직 살아 있는 문맥을 지웠다고 말한다');
  assert.equal(mod.threadExpired(1_000_000, 1_000_000 + TTL + 1), true, '사라진 문맥을 살아 있다고 본다');

  // 마지막 주고받음은 **화면에 남아 있는 대화**에서 찾는다(되살린 대화든 방금 시작한 대화든 같다).
  assert.equal(mod.lastTurnAt([]), 0);
  assert.equal(mod.lastTurnAt([{ key: 1, role: 'bot', text: '안녕하세요', at: 0 }]), 0, '서버 렌더(시각 없음)를 과거로 보면 안 된다');
  assert.equal(
    mod.lastTurnAt([
      { key: 1, role: 'bot', text: '안녕하세요', at: 100 },
      { key: 2, role: 'user', text: '예약하고 싶어요', at: 200 },
      { key: 3, role: 'bot', text: '성함을 알려주세요', at: 300 },
    ]),
    300,
    '마지막이 아니라 다른 말풍선의 시각을 본다',
  );
});

/* ══════════ 디자인 스프린트 — 23차 재감사 (DS 26-1·26-2) ══════════ */

/**
 * DS 26-2 — 대화 목록을 **키보드로 거슬러 올라갈 수 있는가**.
 *
 * 지난 말풍선에는 초점 받을 것이 없다(평가 버튼은 근거가 붙은 **마지막** 답변에만 뜬다).
 * 초점은 입력칸에 있고 화살표 키는 목록이 아니라 그 바깥을 굴린다 — 즉 방금 받은 안내를
 * 다시 읽으려고 위로 올라갈 수단이 마우스·손가락뿐이었다(WCAG 2.1.1).
 * 넘치는 동안에만 목록 자체가 초점을 받는다 — 넘치지 않는데 Tab 이 멈추면 그 자체가 방해다.
 */
test('대화 목록이 넘치면 키보드로 스크롤할 수 있다 (DS 26-2)', opts, async () => {
  const src = readFileSync(new URL('../src/components/ChatWidget.tsx', import.meta.url), 'utf8');
  assert.match(src, /const \[logRef, logScrolls\] = useScrollableY<HTMLDivElement>/, '대화 목록이 넘치는지 재지 않는다');
  assert.match(src, /\{\.\.\.\(logScrolls \? \{ tabIndex: 0 \} : \{\}\)\}/, '넘치는 목록이 초점을 받지 못한다');
  // 초점 표시는 목록 안쪽에 그린다 — 바깥에 그리면 상담창 테두리에 잘린다.
  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  assert.match(css, /\.gw-log:focus-visible\{outline:2px solid var\(--brand\);outline-offset:-2px\}/, '초점 표시가 없다');

  // 첫 렌더에는 붙지 않는다(아직 재지 않았다) — 짧은 대화에 헛 Tab 이 생기지 않아야 한다.
  const html = await render({ tenant: TENANT });
  assert.match(html, /class="gw-log"/, '대화 목록에 초점 표시를 걸 자리가 없다');
  assert.equal(/class="gw-log"[^>]*tabindex/.test(html), false, '재기 전에 초점을 붙였다');
  // 목록의 뜻(role=log·읽어 주는 영역)은 그대로다 — 초점만 더한다.
  assert.match(html, /class="gw-log" role="log" aria-live="polite"/, '대화 목록의 역할이 바뀌었다');
});

/**
 * DS 26-1 — 전체화면 상담창 뒤에서 호스트 페이지가 움직이지 않는가.
 * 잠금 자체는 관리 콘솔과 **같은 사본**(`lockPageScroll`)이 하고, 그 동작은 콘솔 테스트가
 * 가짜 창 위에서 실제로 돌려 본다(`tests/console.test.mjs` DS 26-1).
 * 두 사본이 갈라지지 않는지는 `tests/unit.test.mjs` 가 글자까지 대조한다.
 */
test('전체화면일 때만 뒤 페이지를 잠근다 (DS 26-1)', opts, () => {
  const src = readFileSync(new URL('../src/components/ChatWidget.tsx', import.meta.url), 'utf8');
  const i = src.indexOf('function lockPageScroll(');
  assert.ok(i >= 0, '잠금 함수가 없다');
  // 조건: 임베드가 아니고(호스트 문서는 embed.js 가 맡는다) 전체화면으로 열려 있을 때만.
  const eff = src.slice(src.indexOf('if (embedded || typeof document'), src.indexOf('const closePanel'));
  assert.match(eff, /if \(!\(open && mobile\)\) return;/, '데스크톱에서 열어 두면 페이지를 읽을 수 없게 된다');
  assert.match(eff, /return lockPageScroll\(window, document\);/, '잠금을 손으로 다시 적었다');
  // 잠그지 못하는 환경에서도 상담창은 열려야 한다.
  assert.match(eff, /catch \{\n *return undefined;/, '잠금 실패가 상담창을 막는다');
});

/* ── 접어 둔 사이에 온 답 (DS 28-1·28-2·28-3) ── */

/**
 * DS 28-1 — 「최소화」는 대화를 끝내지 않는다(끝내는 것은 「닫고 처음으로」뿐이다).
 *
 * 답을 기다리다 상담창을 접은 고객에게 호스트 페이지에 남는 것은 런처 하나이고, 그 런처는
 * 열림/닫힘만 말했다 — 답이 도착한 사실을 알 길이 없었다. 「접어 둔 사이의 것만 세는가」는
 * 소스를 읽어서는 알 수 없다(돌려 봐야 안다).
 */
test('접어 둔 사이에 늘어난 말풍선만 읽지 않은 것으로 센다 (DS 28-1)', opts, async () => {
  const m = await loadModule();
  assert.equal(typeof m.unreadCount, 'function', 'unreadCount 를 내보내야 한다');

  assert.equal(m.unreadCount(1, 1), 0, '인사말만 있는 런처에 숫자가 뜬다');
  assert.equal(m.unreadCount(3, 3), 0, '보이는 동안 늘어난 말풍선을 안 읽은 것으로 센다');
  assert.equal(m.unreadCount(3, 1), 2, '접어 둔 사이에 온 답을 세지 않는다');
  // 「닫고 처음으로」로 대화가 인사말 하나로 줄어든 자리 — 음수가 숫자로 뜨면 안 된다.
  assert.equal(m.unreadCount(1, 5), 0, '지운 대화에서 음수가 샌다');
  assert.equal(m.unreadCount(-2, -3), 0, '이상한 값이 숫자로 뜬다');
  // 접수 결과는 말풍선이 아니다(DS 28-2) — 말풍선이 없어도 알릴 것이 있다.
  assert.equal(m.unreadCount(1, 1, 1), 1, '접수 결과만 바뀐 경우를 세지 않는다');
  assert.equal(m.unreadCount(3, 1, 1), 3, '답 2개와 접수 결과를 함께 세지 않는다');

  // 런처 위 숫자는 58px 원을 덮지 않아야 한다.
  assert.equal(m.unreadBadge(99), '99');
  assert.equal(m.unreadBadge(100), '99+', '세 자리가 런처를 덮는다');
});

test('런처가 읽지 않은 답을 이름과 소리로도 말한다 (DS 28-1)', opts, async () => {
  const m = await loadModule();
  // 숫자 뱃지는 보는 사람에게만 보인다 — 접근 이름이 같은 것을 말해야 한다(색·숫자만으로 알리지 않는다).
  assert.equal(m.launcherLabel(false, '이음 안내 챗봇', 0), '이음 안내 챗봇 열기');
  assert.equal(m.launcherLabel(false, '이음 안내 챗봇', 2), '이음 안내 챗봇 열기 — 읽지 않은 답변 2개');
  assert.match(m.launcherLabel(false, 'GOWON Chat', 120), /99개 이상/, '세 자리는 「많다」가 더 정확하다');
  // 열려 있으면 읽지 않은 것이 없다 — 이름이 「최소화」로 남아야 한다.
  assert.equal(m.launcherLabel(true, 'GOWON Chat', 3), 'GOWON Chat 최소화');

  // 접힌 상담창의 대화 목록(aria-live)은 DOM 에 없다 — 알리는 영역이 따로 있어야 한다.
  assert.equal(m.unreadNotice('GOWON Chat', 0), '', '알릴 것이 없는데 말한다');
  assert.match(m.unreadNotice('GOWON Chat', 1), /새 답변 1개/);
  assert.match(m.unreadNotice('GOWON Chat', 1), /상담창을 열어/, '무엇을 하라는 말이 없다');
});

/**
 * DS 28-2 — 접수(상담원 연결)의 결과는 말풍선이 아니라 **카드 안에서** 바뀐다.
 * 접수를 누르고 상담창을 접은 고객은 접수번호가 발급됐는지, 실패해 다시 눌러야 하는지를
 * 런처에서 알 수 없었다. 「그 사이에 바뀌었는가」이므로 접기 전에 보여 준 단계와 대조한다.
 */
test('접수 결과가 접어 둔 사이에 바뀐 것만 알린다 (DS 28-2)', opts, async () => {
  const m = await loadModule();
  assert.equal(m.handoffChanged('done', 'sending'), true, '접수번호가 나온 것을 알리지 않는다');
  assert.equal(m.handoffChanged('error', 'sending'), true, '다시 눌러야 하는 것을 알리지 않는다');
  // 접수 완료를 보고 나서 접은 사람에게 다시 알리지 않는다.
  assert.equal(m.handoffChanged('done', 'done'), false, '이미 본 결과를 다시 알린다');
  assert.equal(m.handoffChanged('error', 'error'), false, '이미 본 실패를 다시 알린다');
  // 결과가 아닌 단계 변화는 알릴 것이 아니다(카드를 열거나 보내는 중).
  assert.equal(m.handoffChanged('form', undefined), false, '카드를 연 것을 「새 답」이라 말한다');
  assert.equal(m.handoffChanged('sending', 'form'), false, '보내는 중을 결과라 말한다');
  assert.equal(m.handoffChanged(undefined, undefined), false, '접수가 없는데 알린다');

  const src = readFileSync(new URL('../src/components/ChatWidget.tsx', import.meta.url), 'utf8');
  // 보여 준 단계를 옮기는 자리는 「열려 있는 동안」과 대화를 지울 때뿐이다.
  const moves = src.match(/seenStageRef\.current = /g) || [];
  assert.equal(moves.length, 2, `보여 준 단계를 옮기는 자리가 늘었다(${moves.length}곳) — 손으로 옮기면 곧 어긋난다`);
});

test('접어 둔 런처의 읽지 않은 표시가 첫 렌더에는 없다 (DS 28-1)', opts, async () => {
  // 임베드 위젯은 런처만 보이는 상태로 시작한다 — 열어 본 적도 없는데 숫자가 뜨면 안 된다.
  const html = await render({ embedded: true, tenant: TENANT });
  assert.match(html, /aria-label="이음 안내 챗봇 열기"/, '런처 이름이 열기여야 한다');
  assert.equal(/class="gw-unread"/.test(html), false, '첫 렌더부터 읽지 않은 숫자가 떠 있다');
  assert.equal(/읽지 않은 답변/.test(html), false, '첫 렌더부터 읽지 않은 답을 말한다');
  // 알리는 영역은 비어 있어도 항상 DOM 에 있어야 한다(없던 영역이 생기면 읽히지 않는다).
  assert.match(html, /class="gw-srhide" role="status" aria-live="polite"/, '알릴 자리가 없다');

  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  // 테넌트 색(이음 #BE5535)이 무엇이든 구분되게 카드 색 테두리를 두른다.
  assert.match(css, /\.gw-unread\{[\s\S]*?border:2px solid var\(--surface\)/, '런처 색과 섞인다');
  assert.match(css, /\.gw-unread\{[\s\S]*?font-variant-numeric:tabular-nums/, '숫자가 흔들린다');
  // 같은 종류의 숫자(콘솔 대기 건수 배지)와 같은 토큰을 쓴다 — 화면마다 색이 다르면 같은 제품이 아니다.
  assert.match(css, /\.gw-unread\{[\s\S]*?background:var\(--warn\);color:#fff/, '콘솔 배지와 색이 갈라진다');
  assert.match(css, /\.ac-navcount\{[^}]*background:var\(--warn\);color:#fff/, '콘솔 배지 쪽이 바뀌었다');
  // 고대비 모드에서 배경이 지워지면 아이콘 위에 겹친 맨 숫자가 된다(DS 25-2 와 같은 기준).
  const forced = css.slice(css.indexOf('@media (forced-colors: active)'));
  assert.match(forced, /\.gw-unread\{border:2px solid ButtonText\}/, '고대비에서 뱃지가 사라진다');
});

/**
 * DS 28-3 — 다시 열면 **맨 아래로** 내려가 먼저 온 답을 건너뛴다.
 * 긴 답변을 끝부터 보여 주면 고객은 답의 시작을 찾아 거슬러 올라가야 한다.
 */
test('다시 열면 읽지 않은 답의 시작으로 간다 (DS 28-3)', opts, async () => {
  const src = readFileSync(new URL('../src/components/ChatWidget.tsx', import.meta.url), 'utf8');

  // 경계는 **말풍선 열쇠**다 — 「다시 보내기」가 안내 말풍선을 지우면 자리 번호는 어긋난다.
  assert.match(src, /const \[newFromKey, setNewFromKey\] = useState<number \| null>\(null\)/, '경계를 두지 않는다');
  assert.match(src, /m\.key === newFromKey \?/, '구분선을 자리 번호로 그린다');
  assert.match(src, /여기부터 읽지 않은 답변/, '어디부터 새 답인지 말하지 않는다');

  // 경계는 펼치는 그 렌더에서 함께 정해야 한다 — 한 렌더 뒤에 정하면 대화 맨 위가 한 번 비친다.
  const door = src.slice(src.indexOf('const openPanel = useCallback'), src.indexOf('// 새 말풍선으로 따라 내려간다'));
  assert.match(door, /setNewFromKey\(first \? first\.key : null\)/, '펼치는 자리에서 경계를 정하지 않는다');
  assert.match(door, /jumpRef\.current = !!first/, '갈 곳을 정하지 않는다');

  // 구분선이 그려지기 전에는 아무 데도 가지 않는다(맨 아래로 갔다가 다시 올라오면 화면이 튄다).
  const scroll = src.slice(src.indexOf('// 새 말풍선으로 따라 내려간다'), src.indexOf('// 연결 상태 —'));
  assert.match(scroll, /if \(!newFromRef\.current\) return;/, '그려지기 전에 자리를 옮긴다');
  assert.match(scroll, /newFromRef\.current\.scrollIntoView\(\{ behavior: 'auto', block: 'start' \}\)/, '안 읽은 자리를 화면 위에 두지 않는다');
  assert.match(scroll, /\[msgs, busy, open, newFromKey\]/, '경계가 생겨도 다시 보지 않는다');

  // 지난 경계는 지운다 — 다시 말을 건 사람에게도, 대화를 지운 사람에게도 남아 있으면 안 된다.
  const sendFn = src.slice(src.indexOf('async function sendText('), src.indexOf('async function sendText(') + 700);
  assert.match(sendFn, /setNewFromKey\(null\)/, '다시 말을 걸어도 지난 경계가 남는다');
  const reset = src.slice(src.indexOf('const closePanel = useCallback'), src.indexOf('// ESC로 닫고'));
  assert.match(reset, /readLenRef\.current = 1/, '지운 대화의 읽은 지점이 남는다');
  assert.match(reset, /setNewFromKey\(null\)/, '사라진 말풍선을 가리키는 경계가 남는다');

  // 읽은 지점을 옮기는 자리는 셋뿐이다: 되살린 대화·열려 있는 동안·대화를 지울 때.
  const moves = src.match(/readLenRef\.current = /g) || [];
  assert.equal(moves.length, 3, `읽은 지점을 옮기는 자리가 늘었다(${moves.length}곳)`);

  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  assert.match(css, /\.gw-newline\{/, '구분선 규격이 없다');
  assert.match(css, /\.gw-newline::before,\.gw-newline::after\{content:"";flex:1/, '구분선에 선이 없다');
});

test('열린 상담창에는 구분선도 읽지 않은 숫자도 없다 (DS 28-3)', opts, async () => {
  // 펼친 채로 그려지는 화면(랜딩·`/widget`)에는 「읽지 않은 것」이라는 개념이 없다.
  const html = await render({ tenant: TENANT });
  assert.equal(html.includes('여기부터 읽지 않은 답변'), false, '열린 상담창에 구분선이 그려진다');
  assert.equal(/class="gw-unread"/.test(html), false, '열린 상담창의 런처에 숫자가 뜬다');
  assert.match(html, /aria-label="이음 안내 챗봇 최소화"/, '열린 런처의 이름이 최소화가 아니다');
});
