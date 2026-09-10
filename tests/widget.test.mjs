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
  cached = mod.default;
  return cached;
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
