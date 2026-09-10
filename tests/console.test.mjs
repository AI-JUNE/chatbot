/**
 * 관리 콘솔 화면 테스트 — admin/page.tsx 를 실제로 컴파일해 서버 렌더한 HTML을 검사한다.
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

/** admin/page.tsx 를 컴파일해 import 한다(외부 의존은 react 뿐이다). */
async function loadConsole() {
  if (cached) return cached;
  const dir = mkdtempSync(path.join(tmpdir(), 'gowon-console-'));
  cpSync(path.join(REPO, 'src', 'app', 'admin', 'page.tsx'), path.join(dir, 'AdminPage.tsx'));
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
      include: ['AdminPage.tsx'],
    }),
  );
  execFileSync(process.execPath, [TSC, '-p', 'tsconfig.json'], { cwd: dir, stdio: 'pipe' });
  renameSync(path.join(dir, 'out', 'AdminPage.js'), path.join(dir, 'out', 'AdminPage.mjs'));
  const mod = await import(pathToFileURL(path.join(dir, 'out', 'AdminPage.mjs')).href);
  cached = mod.default;
  return cached;
}

async function render() {
  const [{ renderToStaticMarkup }, { createElement }, Page] = await Promise.all([
    import('react-dom/server'),
    import('react'),
    loadConsole(),
  ]);
  return renderToStaticMarkup(createElement(Page));
}

test('콘솔 셸이 사이드바·현재 탭 강조·상단 헤더로 렌더된다 (DS 2-1)', opts, async () => {
  const html = await render();
  assert.match(html, /class="ac-shell"/, '셸 레이아웃');
  assert.match(html, /aria-label="콘솔 메뉴"/, '내비게이션 이름(스크린리더)');
  assert.match(html, /aria-current="page"/, '현재 탭이 강조돼야 한다');
  assert.match(html, /class="ac-top"/, '상단 헤더');
  assert.match(html, /<svg[^>]*aria-hidden="true"/, '메뉴 아이콘은 장식이므로 숨겨야 한다');
  // 모든 탭이 메뉴에 있다
  for (const label of ['대시보드', '상담원 요청', '테넌트 지식', '지식베이스', '시나리오 룰', '응답 테스트', '파트너·귀속', '정산 리포트', '설치', '감사 로그']) {
    assert.ok(html.includes(label), `메뉴 누락: ${label}`);
  }
  // 관리 토큰 입력에는 보이지 않는 라벨이라도 붙어 있어야 한다
  assert.match(html, /for="ac-token"/, '토큰 입력 라벨');
});

test('대시보드 KPI 4개가 값 없이도 「측정 중」으로 렌더된다 (DS 2-2)', opts, async () => {
  const html = await render();
  for (const k of ['오늘 대화', '자동완결률', '상담원 전환', '평균 응답 시간']) {
    assert.ok(html.includes(k), `KPI 누락: ${k}`);
  }
  assert.match(html, /측정 중/, '값이 없으면 「측정 중」이어야 한다');
  // 지어낸 수치가 들어가면 안 된다 — 로딩 상태에서 0건/0% 로 단정하지 않는다
  assert.equal(/ac-kpivalue[^>]*>0%/.test(html), false, '값이 없는데 0%로 단정하면 안 된다');
  assert.match(html, /aria-busy="true"/, '불러오는 중임을 알려야 한다');
});

test('콘솔 화면에 내부 구현 문구·미완성 값이 노출되지 않는다', opts, async () => {
  const html = await render();
  for (const leak of ['data/admin-store.json', '401이면', '서버 메모리 기준', 'undefined', 'NaN', 'process.env', 'localhost', 'intent ', 'source ']) {
    assert.equal(html.includes(leak), false, `콘솔 화면에 노출: ${leak}`);
  }
});

test('콘솔 셸이 375px 화면에서 접히도록 반응형 규칙을 갖춘다', opts, () => {
  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  assert.match(css, /\.ac-shell\{[^}]*grid-template-columns:236px/, '넓은 화면은 사이드바 고정폭');
  const mobile = css.slice(css.indexOf('@media (max-width:900px){'));
  assert.match(mobile, /\.ac-shell\{grid-template-columns:minmax\(0,1fr\)\}/, '좁은 화면에서는 한 단으로 접혀야 한다');
  assert.match(mobile, /\.ac-navgroup\{display:contents\}/, '메뉴가 가로 한 줄로 흘러야 한다');
  assert.match(mobile, /\.ac-group\{display:none\}/, '좁은 화면에서는 그룹 제목을 감춘다');
  // 터치 대상 최소 크기
  assert.match(css, /\.ac-navbtn\{[^}]*min-height:38px/, '메뉴 버튼은 손가락으로 누를 수 있어야 한다');
});

test('대시보드 최근 대화가 서랍을 여는 행 목록으로 렌더된다 (DS 2-3)', opts, async () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  const html = await render();
  // 빈 상태: 일러스트 + 다음 행동
  assert.match(html, /아직 기록된 대화가 없습니다/, '빈 상태 안내');
  assert.match(html, /응답 테스트 열기/, '빈 상태에서 다음 행동을 제시해야 한다');
  // 서랍: dialog 시맨틱·ESC·초점 복귀·초점 순환
  assert.match(src, /role="dialog"[\s\S]*aria-modal="true"[\s\S]*aria-labelledby="ac-drawer-title"/, '서랍은 dialog 여야 한다');
  assert.match(src, /e\.key === 'Escape'\) closeDrawer\(\)/, 'ESC 로 닫힌다');
  assert.match(src, /drawerReturnRef\.current = from/, '닫으면 연 행으로 초점이 돌아가야 한다');
  assert.match(src, /e\.key !== 'Tab'/, '서랍 안에서 초점이 순환해야 한다');
  assert.match(src, /aria-haspopup="dialog"/, '행 버튼은 서랍을 연다고 알려야 한다');
  // 세션 식별자는 전부 노출하지 않는다
  assert.match(src, /function shortSession/, '대화 식별자 축약');
  // 375px: 서랍 전체폭·행 세로 배치
  const mobile = css.slice(css.indexOf('@media (max-width:900px){'));
  assert.match(mobile, /\.ac-drawer\{width:100vw\}/);
  assert.match(mobile, /\.ac-row\{flex-direction:column/);
  assert.match(css, /\.ac-drawer\{animation:none!important\}|,\.ac-drawer\{animation:none!important\}/, '모션 최소화 존중');
});

test('지식베이스가 표(검색·카테고리 필터)+우측 편집 폼으로 렌더되고 라벨·검증·빈 상태를 갖춘다 (DS 2-4)', opts, async () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  const kb = src.slice(src.indexOf("{tab === 'kb' &&"), src.indexOf("{tab === 'rules' &&"));
  assert.match(kb, /className="ac-split"/, '좌 표/우 폼 분할');
  assert.match(kb, /type="search"/, '검색 입력');
  assert.match(kb, /id="ac-kb-cat"[\s\S]*<option value="">모든 카테고리<\/option>/, '카테고리 필터');
  assert.match(kb, /className="ac-table"/, '표');
  for (const id of ['kb-category', 'kb-question', 'kb-keywords', 'kb-answer']) {
    assert.match(kb, new RegExp(`htmlFor="${id}"`), `폼 라벨 누락: ${id}`);
    assert.match(kb, new RegExp(`id="${id}"`), `입력 누락: ${id}`);
  }
  assert.match(kb, /aria-invalid=\{kbErr\.question/, '인라인 검증(질문)');
  assert.match(kb, /aria-describedby=\{kbErr\.answer/, '오류 문구 연결(답변)');
  assert.match(kb, /<EmptyArt kind="kb" \/>/, '빈 상태 일러스트');
  assert.match(kb, /검색 결과가 없습니다/, '검색 0건 안내');
  assert.match(kb, /aria-label=\{`삭제: \$\{e\.question\}`\}/, '행 버튼에 대상 이름이 있어야 한다');
  assert.match(src, /window\.confirm\('이 항목을 삭제할까요/, '삭제는 확인을 거친다');
  assert.match(src, /flash\(editingId \? '수정되었습니다\.' : '추가되었습니다\.'\)/, '저장 토스트');
  const mobile = css.slice(css.indexOf('@media (max-width:900px){'));
  assert.match(mobile, /\.ac-split,\.ac-split-test\{grid-template-columns:minmax\(0,1fr\)\}/, '좁은 화면에서는 한 단');
  assert.match(mobile, /\.ac-col-wide\{display:none\}/, '좁은 화면에서는 키워드 열을 감춘다');
});

test('응답 테스트가 좌 입력·근거 / 우 상담창 미리보기로 분할되고 내부 코드가 보이지 않는다 (DS 2-6)', opts, async () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const t = src.slice(src.indexOf("{tab === 'test' &&"), src.indexOf("{tab === 'install' &&"));
  assert.match(t, /className="ac-split ac-split-test"/, '분할 레이아웃');
  assert.match(t, /aria-label="상담창 미리보기"/, '미리보기 영역 이름');
  assert.match(t, /role="log" aria-live="polite"/, '미리보기 대화는 live region');
  assert.match(t, /htmlFor="ac-test-msg"/, '입력 라벨');
  assert.match(t, /aria-busy=\{testBusy/, '응답 대기 표시');
  assert.match(t, /gw-dot/, '타이핑 인디케이터(위젯과 같은 것)');
  assert.match(t, /INTENT_LABELS\[t\.intent\]/, '주제는 사람 말로');
  assert.match(t, /SOURCE_VIEW_LABELS\[t\.source\]/, '근거는 사람 말로');
  assert.equal(/intent: \{|source: \{/.test(t), false, '내부 코드 라벨을 그대로 보여주면 안 된다');
  assert.match(t, /실제 고객 정보는 넣지 마세요/, '개인정보 주의 안내');
  assert.match(src, /catch \{\n      data = \{ reply: '연결이 원활하지 않습니다/, '네트워크 실패 안내');
});
