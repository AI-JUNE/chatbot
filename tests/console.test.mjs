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
import { compileLibs, importLib } from './_compile.mjs';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const TSC = path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');
const CAN = existsSync(TSC) && existsSync(path.join(REPO, 'node_modules', 'react-dom'));
const opts = CAN ? {} : { skip: 'typescript/react-dom 미설치 — npm ci 후 실행' };

let cached = null;
let cachedJs = '';

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

/** admin/page.tsx 를 컴파일해 import 한다(외부 의존은 react 뿐이다). */
async function loadConsole() {
  if (cached) return cached;
  const dir = mkdtempSync(path.join(tmpdir(), 'gowon-console-'));
  cpSync(path.join(REPO, 'src', 'app', 'admin', 'page.tsx'), path.join(dir, 'AdminPage.tsx'));
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
      include: ['AdminPage.tsx'],
    }),
  );
  execFileSync(process.execPath, [TSC, '-p', 'tsconfig.json'], { cwd: dir, stdio: 'pipe' });
  const js = path.join(dir, 'out', 'AdminPage.mjs');
  renameSync(path.join(dir, 'out', 'AdminPage.js'), js);
  cachedJs = readFileSync(js, 'utf8');
  const mod = await import(pathToFileURL(js).href);
  cached = mod.default;
  return cached;
}

/**
 * 모듈 안에만 있는(내보내지 않는) 토큰 보관 함수 3개를 컴파일된 JS 에서 떼어내
 * **가짜 window** 위에서 실제로 실행한다 — 소스 검사만으로는 "정말 그렇게 저장하는가"를 못 본다.
 */
async function loadTokenStore(win) {
  await loadConsole();
  const key = (cachedJs.match(/const TOKEN_KEY = '([^']+)'/) || [])[1];
  assert.ok(key, 'TOKEN_KEY 를 찾지 못했다');
  const parts = ['tokenStore', 'readSavedToken', 'writeSavedToken'].map((n) => {
    const i = cachedJs.indexOf(`function ${n}(`);
    assert.ok(i >= 0, `${n} 선언을 찾지 못했다`);
    const end = cachedJs.indexOf('\n}', i); // 최상위 함수라 닫는 중괄호는 1열에 있다
    assert.ok(end > i, `${n} 의 끝을 찾지 못했다`);
    return cachedJs.slice(i, end + 2);
  });
  const make = new Function(
    'window',
    `const TOKEN_KEY = ${JSON.stringify(key)};\n${parts.join('\n')}\nreturn { TOKEN_KEY, tokenStore, readSavedToken, writeSavedToken };`,
  );
  return make(win);
}

/** 브라우저 저장소 흉내. `throws` 면 접근 자체가 예외를 던진다(사생활 보호 모드 등). */
function fakeStorage({ throws = false } = {}) {
  const map = new Map();
  return {
    map,
    getItem(k) { if (throws) throw new Error('blocked'); return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { if (throws) throw new Error('blocked'); map.set(k, String(v)); },
    removeItem(k) { if (throws) throw new Error('blocked'); map.delete(k); },
  };
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
  // 관리 토큰 입력은 헤더가 아니라 로그인 화면에 있다(DS 2-8) — 헤더에는 로그인/로그아웃 진입만 남긴다
  assert.equal(/id="ac-token"/.test(html), false, '헤더의 토큰 입력은 사라져야 한다');
  assert.match(html, />로그인</, '헤더에서 로그인 화면으로 갈 수 있어야 한다');
  // 화면의 어떤 링크·주소에도 관리 토큰이 실리지 않는다 — 주소창·방문 기록·접근 로그에 남는다(DS 5-8)
  assert.equal(/[?&]token=/.test(html), false, '렌더된 화면에 토큰이 실린 주소가 있다');
});

test('대시보드 KPI 4개가 값 없이도 「측정 중」으로 렌더된다 (DS 2-2)', opts, async () => {
  const html = await render();
  for (const k of ['오늘 대화', '자동완결률', '상담원 전환', '평균 응답 시간']) {
    assert.ok(html.includes(k), `KPI 누락: ${k}`);
  }
  // 지어낸 수치가 들어가면 안 된다 — 로딩 상태에서 0건/0% 로 단정하지 않는다
  assert.equal(/ac-kpivalue[^>]*>0%/.test(html), false, '값이 없는데 0%로 단정하면 안 된다');
  assert.equal(/ac-kpivalue[^>]*>0</.test(html), false, '값이 없는데 0건으로 단정하면 안 된다');
  assert.match(html, /aria-busy="true"/, '불러오는 중임을 알려야 한다');
  // 「측정 중」은 데이터가 *없을 때* 의 값이다(불러오는 중은 DS 4-2 스켈레톤). 소스에서 KPI 4개가 값 없으면 MEASURING 으로 떨어지는지 본다
  const page = readFileSync(path.join(REPO, 'src', 'app', 'admin', 'page.tsx'), 'utf8');
  const dashStart = page.indexOf("{tab === 'dash' && (");
  const dash = page.slice(dashStart, page.indexOf('최근 7일 대화량', dashStart));
  assert.ok((dash.match(/: MEASURING\}/g) || []).length >= 2, '값이 없으면 「측정 중」이어야 한다(0으로 단정 금지)');
  assert.equal(page.includes('위쪽 관리 토큰을 확인'), false, '헤더의 토큰 입력은 사라졌으므로 옛 안내가 남으면 안 된다');
});

test('불러오는 동안 빈 상태 대신 스켈레톤을 그리고, 실패는 「다시 시도」로 드러낸다 (DS 4-2)', opts, async () => {
  const html = await render();
  // 첫 렌더(데이터 도착 전)에는 「없습니다」 빈 상태가 보이면 안 된다 — 불러오는 중 ≠ 0건
  assert.equal(html.includes('아직 기록된 대화가 없습니다'), false, '데이터 전에 빈 상태를 단정하면 안 된다');
  assert.match(html, /class="ac-skelrows" role="status" aria-live="polite" aria-busy="true"/, '스켈레톤 목록은 status 로 알린다');
  assert.match(html, /class="ac-srhide">최근 대화를 불러오는 중입니다</, '스크린리더에는 문장 하나');
  assert.match(html, /class="ac-skel" aria-hidden="true"/, '막대는 장식');
  assert.match(html, /class="ac-skelchart"/, '차트 자리도 스켈레톤');
  assert.equal(html.includes('불러오는 중…'), false, '텍스트만 있는 로딩 문구는 스켈레톤으로 바뀐다');

  const page = readFileSync(path.join(REPO, 'src', 'app', 'admin', 'page.tsx'), 'utf8');
  // 실패 경로: 네트워크 예외를 삼키지 않고 phase=error → role=alert + 다시 시도
  for (const k of ['kb', 'rules', 'esc', 'audit']) {
    assert.ok(new RegExp(`markPhase\\('${k}', 'error'\\)`).test(page), `${k} 실패 상태 기록 누락`);
    assert.ok(new RegExp(`markPhase\\('${k}', data\\.ok \\? 'done' : 'error'\\)`).test(page), `${k} 완료 상태 기록 누락`);
  }
  const ls = page.slice(page.indexOf('function LoadState('), page.indexOf('function TrendChart('));
  assert.match(ls, /role="alert"/, '실패는 alert');
  assert.match(ls, /다시 시도/, '실패에는 다시 시도');
  // 빈 상태는 phase 가 done 일 때만 — 5개 목록 전부
  for (const cond of ["recentTurns.length === 0 && phase.esc !== 'done'", "entries.length === 0 && phase.kb !== 'done'", "tickets.length === 0 && phase.esc !== 'done'", "auditEvents.length === 0 && phase.audit !== 'done'"]) {
    assert.ok(page.includes(cond), `빈 상태 게이트 누락: ${cond}`);
  }
  assert.match(page, /<LoadState phase=\{phase\.rules === 'done' \? 'error' : phase\.rules\}/, '기본 규칙 목록');
  assert.match(page, /<SkeletonRows rows=\{4\} label="고객사와 파트너 정보를 불러오는 중입니다" \/>/, '파트너 탭');
  assert.match(page, /<SkeletonRows rows=\{4\} label="테넌트 지식을 불러오는 중입니다" \/>/, '테넌트 탭');
  // KPI 카드는 불러오는 동안 값 자리를 비운다(측정 중으로 단정하지 않음)
  assert.match(page, /loading \? \([\s\S]{0,200}<Skeleton w="46%" h=\{26\}/, 'KPI 로딩 스켈레톤');

  const css = readFileSync(path.join(REPO, 'src', 'app', 'globals.css'), 'utf8');
  assert.match(css, /@keyframes ac-shimmer/, '반짝임 애니메이션');
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'), css.indexOf('/* ── 관리 콘솔 셸'));
  assert.match(reduced, /\.ac-skel::after\{animation:none\}/, '모션 최소화에서는 반짝임 제거');
  const mobile = css.slice(css.indexOf('@media (max-width:900px)'));
  assert.match(mobile, /\.ac-skelchart\{height:110px/, '375px: 차트 스켈레톤 높이 축소');
});

test('인터넷이 끊기면 헤더 아래 배너로 알린다 (DS 4-3)', opts, async () => {
  const page = readFileSync(path.join(REPO, 'src', 'app', 'admin', 'page.tsx'), 'utf8');
  assert.match(page, /window\.addEventListener\('offline', sync\)/, 'offline 이벤트 구독');
  assert.match(page, /window\.addEventListener\('online', sync\)/, 'online 이벤트 구독(복구 시 사라짐)');
  assert.match(page, /window\.removeEventListener\('offline', sync\)/, '해제');
  assert.match(page, /className="ac-offline" role="status" aria-live="assertive"/, '배너는 status + assertive');
  assert.match(page, /인터넷 연결이 끊겼습니다/, '사용자 언어 안내');
  const html = await render();
  assert.equal(html.includes('ac-offline'), false, '서버 렌더(연결 상태 미확인)에서는 배너를 그리지 않는다');
  const css = readFileSync(path.join(REPO, 'src', 'app', 'globals.css'), 'utf8');
  // 경고 톤은 토큰으로만 나온다(DS 11-2 — 틴트 하드코딩 금지).
  assert.match(css, /\.ac-offline\{[^}]*background:var\(--warn-50\)[^}]*color:var\(--warn\)/, '경고 톤');
  const mobile = css.slice(css.indexOf('@media (max-width:900px)'));
  assert.match(mobile, /\.ac-offline\{padding:9px 16px\}/, '375px 여백');
});

test('평균 응답 시간 KPI 가 실측(서버 처리 시간)으로 연결되고 값이 없을 때만 「측정 중」이다 (DS 2-14)', opts, () => {
  const page = readFileSync(path.join(REPO, 'src', 'app', 'admin', 'page.tsx'), 'utf8');
  assert.equal(page.includes('응답 시간 수집은 준비 중'), false, '영구 「준비 중」 카드는 사라져야 한다');
  assert.match(page, /avgLatencyMs/, 'KPI 는 집계 응답의 평균 처리 시간을 읽는다');
  assert.match(page, /서버가 답을 만드는 데 걸린 시간/, '네트워크 왕복이 아닌 서버 처리 시간임을 밝힌다');
  // 두 채널 모두 측정한다 — 한쪽만 재면 평균이 한 채널로 치우친다
  for (const route of ['src/app/api/chat/route.ts', 'src/app/api/kakao/webhook/route.ts']) {
    const src = readFileSync(path.join(REPO, route), 'utf8');
    assert.match(src, /latencyMs: Date\.now\(\) - startedAt/, `${route} 가 처리 시간을 기록해야 한다`);
  }
  // 집계는 표본이 없으면 null(0 아님)
  const conv = readFileSync(path.join(REPO, 'src', 'lib', 'convlog.ts'), 'utf8');
  assert.match(conv, /avgLatencyMs: latencySamples \? [^:]+ : null/, '표본 없으면 null');
});

test('헤더 전역 검색이 combobox 로 렌더되고 키보드·연락처 비색인·375px 규칙을 갖춘다 (DS 2-15)', opts, async () => {
  const html = await render();
  assert.match(html, /<label for="ac-gsearch" class="ac-srhide">/, '검색칸에 스크린리더 라벨');
  assert.match(html, /id="ac-gsearch"[^>]*role="combobox"/, 'WAI-ARIA combobox');
  assert.match(html, /aria-expanded="false"/, '처음에는 결과 목록이 닫혀 있다');
  assert.match(html, /aria-controls="ac-gsearch-list"/, '결과 목록과 연결');
  assert.equal(/role="listbox"/.test(html), false, '검색어가 없으면 목록을 그리지 않는다');
  assert.match(html, /class="ac-gsearch-kbd" aria-hidden="true">Ctrl K</, '단축키 힌트는 장식(스크린리더에는 설명 문장으로)');
  assert.match(html, /Ctrl\+K 로 바로 열 수 있습니다/, '스크린리더용 사용법');

  const page = readFileSync(path.join(REPO, 'src', 'app', 'admin', 'page.tsx'), 'utf8');
  const comp = page.slice(page.indexOf('function GlobalSearch('), page.indexOf('const S = {'));
  for (const key of ["'ArrowDown'", "'ArrowUp'", "'Enter'", "'Escape'"]) {
    assert.ok(comp.includes(key), `키보드 조작 누락: ${key}`);
  }
  assert.match(comp, /aria-activedescendant/, '활성 항목을 스크린리더에 알린다');
  assert.match(comp, /role="option"/, '결과는 option 이어야 한다');
  assert.match(comp, /role="status" aria-live="polite"/, '건수를 읽어 준다');
  assert.match(comp, /맞는 항목이 없습니다/, '빈 결과 안내');
  // 개인정보: 연락처·세션 원문은 색인하지 않는다(요청 서랍에서 「보기」를 눌러야 한다)
  const index = page.slice(page.indexOf('const searchAll = '), page.indexOf('const currentLabel ='));
  assert.equal(/\.contact\b/.test(index), false, '연락처는 검색 색인에 넣지 않는다');
  assert.equal(/t\.sessionId\)|t\.sessionId,/.test(index.replace(/shortSession\(t\.sessionId\)/g, '').replace(/openDrawer\(t\.sessionId/g, '')), false, '세션 원문은 색인·표시하지 않는다(서랍 열기 인자는 표시가 아니므로 제외)');
  assert.equal(/t\.id[,)]/.test(index.replace(/shortTicket\(t\.id\)/g, '').replace(/openTicket\(t\.id/g, '').replace(/`ticket:\$\{t\.id\}`|`turn:\$\{t\.id\}`/g, '')), false, '접수번호 전체는 색인하지 않는다');
  // 모든 출처가 색인된다
  for (const src of ['tickets', 'recentTurns', 'entries', 'customRules', 'rules', 'accounts', 'partners']) {
    assert.ok(new RegExp(`\\b${src}\\s*\\n?\\s*\\.filter`).test(index), `검색 출처 누락: ${src}`);
  }

  const css = readFileSync(path.join(REPO, 'src', 'app', 'globals.css'), 'utf8');
  const mobile = css.slice(css.indexOf('@media (max-width:900px)'));
  assert.match(mobile, /\.ac-gsearch\{order:3;flex-basis:100%/, '375px: 검색칸이 헤더 아래 한 줄 전체폭');
  assert.match(mobile, /\.ac-gsearch-kbd\{display:none\}/, '375px: 키보드 힌트 숨김');
  assert.match(css, /\.ac-gsearch-input:focus\{outline:2px solid var\(--brand\)/, '초점 표시');
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
  // 빈 상태: 일러스트 + 다음 행동 (데이터가 도착한 뒤에만 — 첫 렌더는 DS 4-2 스켈레톤)
  assert.match(src, /아직 기록된 대화가 없습니다/, '빈 상태 안내');
  assert.match(src, /응답 테스트 열기/, '빈 상태에서 다음 행동을 제시해야 한다');
  assert.match(html, /최근 대화를 불러오는 중입니다/, '첫 렌더는 불러오는 중');
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
  // 전체폭이지만 「큰 글씨」 배율로 화면보다 넓어지지는 않는다(DS 25-1 — --vz 로 먼저 나눈다)
  assert.match(mobile, /\.ac-drawer\{width:calc\(100vw \/ var\(--vz\)\)\}/);
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
  // 확인 절차는 유지하되, 브라우저 기본 대화상자가 아니라 브랜드 대화상자를 거친다(DS 5-4).
  assert.match(src, /askConfirm\(\{[\s\S]{0,200}이 안내 자료를 삭제할까요/, '삭제는 확인을 거친다');
  // 저장 토스트 — 끝났다고 말하는 한 문(`flashSaved`)을 지난다. 그 문은 서버가 보낸 보관
  // 결과를 함께 받아, 디스크에 닿지 않았으면 같은 문장에 그 사실을 적는다 (DS 47-1).
  assert.match(src, /flashSaved\(editingId \? '수정되었습니다\.' : '추가되었습니다\.', data\.saved\)/, '저장 토스트');
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
  assert.match(t, /busyBtn\(testBusy, testBusy/, '응답 대기 표시');
  assert.match(t, /gw-dot/, '타이핑 인디케이터(위젯과 같은 것)');
  // 주제는 서버가 붙여 준 이름을 그린다 — 화면이 사전을 따로 들고 코드를 폴백하지 않는다(DS 22-2).
  assert.match(t, /\{t\.intentLabel \|\| UNNAMED_TOPIC\}/, '주제는 서버가 준 이름으로');
  // 근거 이름을 붙이는 자도 한 벌이다 — 사전에 없는 코드를 글자째 그리지 않는다(DS 54-2).
  assert.match(t, /\{sourceView\(t\.source\)\}/, '근거는 사람 말로');
  assert.equal(/intent: \{|source: \{/.test(t), false, '내부 코드 라벨을 그대로 보여주면 안 된다');
  assert.match(t, /실제 고객 정보는 넣지 마세요/, '개인정보 주의 안내');
  assert.match(src, /catch \{\n      data = \{ reply: '연결이 원활하지 않습니다/, '네트워크 실패 안내');
});

test('시나리오 룰이 「조건 → 응답」 카드 빌더와 미리보기로 렌더된다 (DS 2-5)', opts, () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  const t = src.slice(src.indexOf("{tab === 'rules' &&"), src.indexOf("{tab === 'esc' &&"));
  assert.match(t, /className="ac-split"/, '좌 카드 목록 / 우 빌더 분할');
  assert.match(t, /className="ac-rulecard"/, '규칙 카드');
  assert.match(t, /고객이 이렇게 말하면[\s\S]*이렇게 답합니다/, '조건 → 응답 흐름이 사람 말로 적혀야 한다');
  assert.match(t, /className="ac-rulearrow" aria-hidden="true">→/, '화살표는 장식');
  // 토글은 스위치 시맨틱 + 이름
  assert.match(t, /role="switch"[\s\S]*aria-checked=\{r\.enabled\}[\s\S]*aria-label=\{`\$\{r\.label\} 규칙/, '켜기/끄기 스위치');
  // 빌더 폼: 라벨·필수·인라인 오류·잠금
  for (const id of ['cr-label', 'cr-keywords', 'cr-reply', 'cr-probe', 'ac-rule-q']) {
    assert.match(t, new RegExp(`htmlFor="${id}"`), `폼 라벨 누락: ${id}`);
    assert.match(t, new RegExp(`id="${id}"`), `입력 누락: ${id}`);
  }
  assert.match(t, /aria-invalid=\{crErr\.keywords/, '인라인 검증(표현)');
  assert.match(t, /aria-describedby=\{crErr\.reply/, '오류 문구 연결(답변)');
  assert.match(t, /busyBtn\(crBusy, crBusy/, '저장 중 잠금');
  // 미리보기: 시험 문장 → 적용 여부 + 말풍선, 최종 판정은 응답 테스트로 안내
  assert.match(t, /role="log" aria-live="polite"/, '미리보기는 live region');
  // 적용 근거(어느 표현이 걸렸는가)는 그대로 보여 주지만 「적용됩니다」라고 단정하지 않는다 —
  // 먼저 걸리는 규칙이 있으면 이 답은 나가지 않는다(DS 44-3 이 고친 문장).
  assert.match(t, /이 문장에 「\{probeHits\[0\]\}」 표현이 있습니다/, '적용 근거를 보여준다');
  assert.match(t, /규칙이 적용되지 않습니다/, '미적용 상태도 알려준다');
  assert.match(t, /「응답 테스트」에서 확인하세요/, '근사치임을 밝힌다');
  // 빈 상태·검색 0건·삭제 확인·토스트
  assert.match(t, /아직 만든 규칙이 없습니다/, '빈 상태');
  assert.match(t, /검색 결과가 없습니다/, '검색 0건');
  // 확인 절차는 유지하되, 브라우저 기본 대화상자가 아니라 브랜드 대화상자를 거친다(DS 5-4).
  // 무엇을 지우는지(규칙 이름)를 대화상자가 따로 강조한다.
  assert.match(src, /askConfirm\(\{[\s\S]{0,200}이 규칙을 삭제할까요/, '삭제는 확인을 거친다');
  assert.match(src, /target: target\?\.label \?\? intent/, '지우는 대상을 밝힌다');
  // 저장 토스트 — 자료 쪽과 같은 문(`flashSaved`)을 지난다 (DS 47-1).
  assert.match(src, /flashSaved\(crEditing \? '규칙을 수정했습니다\.' : '규칙을 추가했습니다\.', data\.saved/, '저장 토스트');
  // 내부 용어(intent·정규식·커스텀 룰)가 화면 문자열에 남지 않는다
  for (const leak of ['커스텀 룰', '정규식', '패턴: /', '({r.intent}', '>{r.intent}']) {
    assert.equal(t.includes(leak), false, `내부 용어 노출: ${leak}`);
  }
  // 375px: 조건/응답이 세로로 쌓이고 스위치 전환은 reduced-motion 존중
  const mobile = css.slice(css.indexOf('@media (max-width:900px){\n  .ac-shell'));
  assert.match(mobile, /\.ac-ruleflow\{grid-template-columns:minmax\(0,1fr\)\}/, '좁은 화면에서는 한 단');
  assert.match(css, /\.ac-switch:focus-visible\{outline/, '스위치 키보드 초점 표시');
  assert.match(css, /\.ac-switch,\.ac-switch-knob\{transition:none\}/, 'reduced-motion');
});

test('관리 토큰 입력이 브랜드 로그인 화면으로 옮겨졌다 (DS 2-8)', opts, () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const login = src.slice(src.indexOf('// ---- 로그인 화면'), src.indexOf('const currentLabel = TAB_GROUPS'));
  assert.match(login, /className="ac-login-card"[\s\S]*onSubmit=/, '폼 제출(Enter)로 로그인');
  assert.match(login, /<BrandMark size=\{34\} \/>/, '브랜드 마크');
  assert.match(login, /htmlFor="ac-login-token"[\s\S]*id="ac-login-token"/, '토큰 입력 라벨');
  assert.match(login, /type=\{showToken \? 'text' : 'password'\}/, '보기/숨기기');
  assert.match(login, /aria-pressed=\{showToken\}/, '토글 상태 알림');
  assert.match(login, /role="alert" className="ac-err"/, '오류는 alert');
  assert.match(login, /aria-invalid=\{authMsg \? 'true' : undefined\}/, '오류 시 입력에 표시');
  assert.match(login, /busyBtn\(authBusy, authBusy/, '확인 중 잠금');
  assert.match(login, /로그인하지 않고 돌아가기/, '인증이 필수가 아닐 때 돌아갈 수 있어야 한다');
  assert.equal(/🔒|localStorage|401/.test(login), false, '이모지·내부 문구 없음');
  // 헤더: 로그아웃은 토큰을 지운다
  assert.match(src, /로그아웃[\s\S]{0,40}/, '로그아웃 버튼');
  assert.match(src, /applyToken\(''\);\s*setAuthMsg\(''\);\s*setLoginOpen\(true\);/, '로그아웃 시 토큰 삭제 후 로그인 화면');
});

test('상담원 요청이 요약 KPI·상태 필터·표·상세 서랍으로 렌더된다 (DS 2-9)', opts, () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  const t = src.slice(src.indexOf("{tab === 'esc' &&"), src.indexOf("{tab === 'partner' &&"));
  assert.match(t, /className="ac-kpi"/, '상단 요약 카드');
  for (const k of ['대기 중', '상담 중', '완료', '자동 응대 완료율']) assert.ok(t.includes(k), `요약 누락: ${k}`);
  assert.match(t, /empty=\{autoRate === MEASURING\}/, '대화 0건이면 완료율을 0%로 단정하지 않는다');
  // 필터·검색·표
  assert.match(t, /role="group" aria-label="처리 상태로 거르기"/, '상태 필터 그룹 이름');
  assert.match(t, /aria-pressed=\{escFilter === f\.key\}/, '필터 칩은 눌림 상태를 알린다');
  // 고객사도 검색 대상이다(DS 36-2) — 「이음 건만 보기」가 운영자가 가장 먼저 하는 일이다.
  assert.match(t, /aria-label="요청 검색\(고객 말·고객사·사유·접수번호\)"/, '검색 입력 라벨');
  assert.match(t, /<table className="ac-table">/, '표');
  assert.match(t, /<th scope="col">/, '표 헤더 scope');
  assert.match(t, /aria-haspopup="dialog"/, '접수번호 버튼은 서랍을 연다');
  assert.match(t, /TICKET_STATUS_TONE\[t\.status\]/, '상태 pill 색');
  // 빈 상태·검색 0건
  assert.match(t, /접수된 상담원 연결 요청이 없습니다/, '빈 상태');
  assert.match(t, /조건에 맞는 요청이 없습니다/, '필터 0건');
  assert.match(t, /필터 지우기/, '필터 0건 복구 행동');
  // 식별자·세션은 전부 노출하지 않는다
  assert.match(src, /function shortTicket/, '접수번호 축약');
  assert.equal(/세션 \{t\.sessionId\}/.test(t), false, '세션 원문 노출 금지');
  // 서랍: dialog·ESC·초점 복귀·연락처 마스킹(보기 전까지)
  const d = src.slice(src.indexOf('function TicketDrawer'), src.indexOf('function KpiCard'));
  assert.match(d, /role="dialog" aria-modal="true" aria-labelledby="ac-ticket-title"/, '서랍 dialog');
  assert.match(d, /showContact \? t\.contact : maskContact\(t\.contact\)/, '연락처는 기본 마스킹');
  assert.match(d, /aria-pressed=\{showContact\}/, '보기/가리기 토글 상태');
  assert.match(d, /busyBtn\(busy, busy/, '상태 변경 중 잠금');
  assert.match(src, /e\.key === 'Escape'\) closeTicket\(\)/, 'ESC 로 닫힌다');
  assert.match(src, /ticketReturnRef\.current = from/, '닫으면 연 행으로 초점 복귀');
  // 마스킹 함수가 실제로 가린다
  assert.match(src, /digits\.slice\(0, 3\)\}-\*\*\*\*-\$\{digits\.slice\(-4\)/, '전화 가운데 마스킹');
  // 375px: 사유·시각 열은 접히고 서랍은 전체폭
  const mobile = css.slice(css.indexOf('@media (max-width:900px){\n  .ac-shell'));
  assert.match(mobile, /\.ac-col-wide\{display:none\}/);
  assert.match(mobile, /\.ac-drawer\{width:calc\(100vw \/ var\(--vz\)\)\}/);
});

test('감사 로그·저장소 상태가 표·카드 그리드로 렌더되고 환경변수명이 화면에 없다 (DS 2-10)', opts, () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  const t = src.slice(src.indexOf("{tab === 'audit' &&"), src.indexOf("{tab === 'test' &&"));
  assert.match(t, /htmlFor="audit-filter"[\s\S]*id="audit-filter"/, '작업 종류 필터 라벨');
  assert.match(t, /<table className="ac-table">/, '표');
  assert.match(t, /기록된 관리 작업이 없습니다/, '빈 상태');
  assert.match(t, /지식베이스 열기/, '빈 상태 다음 행동');
  assert.match(t, /선택한 종류의 작업이 없습니다/, '필터 0건');
  assert.match(t, /className="ac-nsgrid"/, '저장소 네임스페이스 카드 그리드');
  assert.match(t, /data-health=\{n\.health\}/, '카드 상태 색');
  assert.match(t, /aria-labelledby="storage-h"/, '저장소 섹션 이름');
  // 화면 문자열에 환경변수명·내부 문구 없음(주석 제외)
  const ui = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('/**') && !l.trim().startsWith('*')).join('\n');
  for (const leak of ['ADMIN_PERSIST', 'PERSIST_PII', '서버 메모리에만', 'data/&lt;', 'faq.json']) {
    assert.equal(ui.includes(leak), false, `콘솔 화면에 내부 문구 노출: ${leak}`);
  }
  assert.match(css, /\.ac-nsgrid\{display:grid/, '카드 그리드 CSS');
});

test('테넌트 지식이 요약 카드+FAQ 표로 렌더되고 편집 UI 가 없다 (DS 2-11)', opts, () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const t = src.slice(src.indexOf("{tab === 'tenant' &&"), src.indexOf("{tab === 'audit' &&"));
  assert.match(t, /className="ac-statgrid"/, '요약 카드');
  for (const k of ['상담창 이름', '적재된 FAQ', '신청 버튼 주소', 'AI 고지 문구']) assert.ok(t.includes(k), `요약 누락: ${k}`);
  assert.match(t, /배포 설정 적용됨[\s\S]*기본값 — 배포 설정 미등록/, 'CTA 출처를 사람 말로');
  assert.match(t, /<table className="ac-table">/, 'FAQ 표');
  // 머리칸은 정렬되는 머리칸(SortTh)으로 바뀌었다(DS 31-1) — scope 는 SortTh 가 붙인다.
  assert.match(t, /<SortTh label="근거" col="citation"/, '근거 라벨 열');
  assert.match(src, /function SortTh\([\s\S]{0,900}scope="col"/, 'SortTh 가 scope 를 붙여야 어느 열인지 읽힌다');
  assert.match(t, /적재된 FAQ가 0건입니다/, '0건 경고 상태');
  assert.match(t, /aria-hidden="true" style=\{\{ width: 14, height: 14, borderRadius: '50%', background: tenantView\.config\.brandColor/, '브랜드 색 견본은 장식');
  assert.equal(/<textarea|<input(?![^>]*type="search")/.test(t), false, '편집 입력이 없어야 한다');
});

test('파트너·귀속이 요약 KPI·고객사/파트너 표·우측 폼·상세 서랍으로 렌더되고 식별자 원문이 없다 (DS 2-12)', opts, () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  const t = src.slice(src.indexOf("{tab === 'partner' &&"), src.indexOf("{tab === 'settle' &&"));
  assert.match(t, /className="ac-kpi"/, '상단 요약 카드');
  for (const k of ['운영 중 파트너', '고객사', '계약 중', '검토 중']) assert.ok(t.includes(k), `요약 누락: ${k}`);
  assert.match(t, /empty=\{!partnerLoaded\}/, '불러오기 전에는 0을 지어내지 않는다');
  // 좌: 표 2개(고객사·파트너) + 검색·귀속 필터
  assert.match(t, /className="ac-split"/, '좌 표 / 우 폼 분할');
  assert.equal((t.match(/<table className="ac-table">/g) || []).length, 2, '고객사·파트너 표');
  assert.match(t, /aria-label="고객사 검색\(고객사명·파트너·담당자\)"/, '검색 입력 라벨');
  assert.match(t, /htmlFor="a-filter" className="ac-srhide"/, '귀속 필터 라벨(스크린리더)');
  assert.match(t, /ACCOUNT_STATUS_TONE\[a\.status\]/, '계약 상태 pill');
  assert.match(t, /PARTNER_STATUS_TONE\[p\.status\]/, '파트너 상태 pill');
  assert.match(t, /aria-haspopup="dialog"[\s\S]{0,80}상세 보기/, '고객사명 버튼은 서랍을 연다');
  // 식별자·내부 값 원문 노출 없음 — 파트너·고객사는 이름으로만 보인다
  assert.equal(/\{p\.id\}|\{a\.id\}|fromPartnerId\}|toPartnerId\}/.test(t.replace(/key=\{[^}]+\}|value=\{p\.id\}/g, '')), false, '식별자 원문을 화면에 쓰지 않는다(key·option value 제외)');
  assert.equal(/bp\b/.test(t.replace(/feeRateBp|pctToBp|bpToPct/g, '')), false, '「bp」 같은 내부 단위를 화면에 쓰지 않는다');
  assert.equal(/#c0392b/.test(t), false, '색은 토큰만');
  // 빈 상태·필터 0건
  assert.match(t, /등록된 고객사가 없습니다[\s\S]*첫 고객사 등록/, '고객사 빈 상태 + 다음 행동');
  assert.match(t, /등록된 파트너가 없습니다[\s\S]*첫 파트너 등록/, '파트너 빈 상태 + 다음 행동');
  assert.match(t, /조건에 맞는 고객사가 없습니다[\s\S]*필터 지우기/, '필터 0건');
  assert.match(t, /조회 전용 계정/, '읽기 전용 계정 안내');
  // 우: 폼 — 고객사/파트너 전환, 라벨, 인라인 오류, 저장 잠금, Enter 제출
  assert.match(t, /role="group" aria-label="등록 대상" className="ac-seg"/, '전환 그룹 이름');
  assert.match(t, /aria-pressed=\{partnerFormKind === 'account'\}/, '전환 상태 알림');
  assert.equal((t.match(/<form onSubmit=/g) || []).length, 2, '두 폼 모두 Enter 제출');
  for (const id of ['a-name', 'a-partner', 'a-source', 'a-status', 'a-date', 'a-fee', 'a-owner', 'a-note', 'p-name', 'p-manager', 'p-fee', 'p-status', 'p-memo']) {
    assert.match(t, new RegExp(`htmlFor="${id}"`), `라벨 누락: ${id}`);
    assert.match(t, new RegExp(`id="${id}"`), `입력 누락: ${id}`);
  }
  for (const f of ['aErr.name', 'aErr.partnerId', 'aErr.contractedAt', 'aErr.monthlyFeeKrw', 'pErr.name', 'pErr.feeRatePct']) {
    assert.ok(t.includes(`aria-invalid={${f} ? 'true' : undefined}`), `인라인 오류 표시 누락: ${f}`);
  }
  assert.match(t, /busyBtn\(partnerSaving, partnerSaving/, '저장 중 잠금');
  assert.match(t, /type="date"/, '계약일은 날짜 입력');
  assert.match(t, /수수료율\(%\)/, '수수료율은 %로 입력');
  // 검증·변환 로직
  const h = src.slice(src.indexOf('const submitPartner = async'), src.indexOf('const removePartner = async'));
  assert.match(h, /n < 0 \|\| n > 100/, '수수료율 % 범위 검사');
  assert.match(h, /feeRateBp: pForm\.feeRatePct\.trim\(\) === '' \? null : pctToBp\(pForm\.feeRatePct\)/, '저장은 bp — API 계약 유지');
  assert.match(h, /aForm\.source === 'partner' && !aForm\.partnerId/, '파트너 유치면 파트너 필수');
  assert.match(h, /aForm\.status === 'contracted'/, '계약 상태면 계약일 필수');
  assert.match(h, /네트워크 오류로 저장하지 못했습니다/, '네트워크 실패 안내');
  // 서랍: 계약 정보 + 귀속 이력 타임라인, 접근성
  const d = src.slice(src.indexOf('function AccountDrawer('), src.indexOf('function KpiCard('));
  assert.match(d, /role="dialog" aria-modal="true" aria-labelledby="ac-account-title"/, '서랍 대화상자');
  assert.match(d, /aria-label="상세 닫기"/, '닫기 버튼 이름');
  assert.match(d, /e\.key !== 'Tab'/, 'Tab 순환');
  assert.match(d, /className="ac-timeline"/, '귀속 이력 타임라인');
  assert.match(d, /아직 기록된 이력이 없습니다/, '이력 빈 상태');
  assert.match(d, /partnerName\(h\.fromPartnerId\)[\s\S]*partnerName\(h\.toPartnerId\)/, '이력은 식별자가 아니라 이름으로');
  assert.match(src, /if \(e\.key === 'Escape'\) closeAccount\(\);/, 'ESC 로 닫힘');
  assert.match(src, /accountReturnRef\.current = from;/, '닫으면 연 행으로 초점 복귀');
  // CSS
  assert.match(css, /\.ac-segbtn\[aria-pressed="true"\]/, '전환 버튼 눌림 스타일');
  assert.match(css, /\.ac-segbtn:focus-visible\{outline/, '전환 버튼 키보드 초점');
  assert.match(css, /\.ac-tl-dot\{/, '타임라인 점');
});

test('정산 리포트가 조건 툴바·요약 KPI·합계/근거 표·빈 상태로 렌더되고 확정 아님을 밝힌다 (DS 2-13)', opts, () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const t = src.slice(src.indexOf("{tab === 'settle' &&"), src.indexOf("{tab === 'tenant' &&"));
  assert.match(t, /className="ac-toolbar"[\s\S]*id="s-month"[\s\S]*id="s-partner"/, '기준월·파트너 조건 툴바');
  assert.match(t, /htmlFor="s-month" className="ac-srhide"/, '기준월 라벨(스크린리더)');
  assert.match(t, /htmlFor="s-partner" className="ac-srhide"/, '파트너 라벨(스크린리더)');
  assert.match(t, /className="ac-kpi"/, '요약 카드');
  for (const k of ['대상 고객사', '산출 완료', '미산출', '수수료 합계']) assert.ok(t.includes(k), `요약 누락: ${k}`);
  assert.match(t, /value=\{r \? String\(r\.totals\.accounts\) : MEASURING\}/, '리포트 전에는 「측정 중」');
  assert.match(t, /empty=\{feeEmpty\}/, '산출 건이 없으면 합계를 0원으로 보이지 않는다');
  assert.match(t, /'확정 금액 아님 — 미산출 건 제외'/, '부분 합계는 확정 금액이 아님을 밝힌다');
  assert.match(t, /이 합계는 확정 금액이 아닙니다/, '경고 문구');
  assert.equal((t.match(/<table className="ac-table">/g) || []).length, 2, '파트너별 합계·고객사별 근거 표');
  assert.match(t, /ISSUE_LABELS\[row\.issue\]/, '미산출 사유 pill');
  assert.match(t, /정산 대상 고객사가 없습니다[\s\S]*파트너·귀속 열기/, '빈 상태 + 다음 행동');
  assert.match(t, /role="alert"[\s\S]{0,400}다시 시도/, '오류에는 다시 시도');
  assert.match(t, /role="status" aria-live="polite"/, '계산 중 안내');
  assert.match(t, /busyBtn\(settleBusy, settleBusy/, '계산 중 버튼 잠금');
  assert.match(t, /busyBtn\(dlBusy === '정산 리포트', dlBusy !== '' \|\| !r \|\| r\.rows\.length === 0/, '내려받을 것이 없거나 진행 중이면 잠긴 모양이 된다');
  // 확정본이 아님은 계속 밝히되, 내부 개발 표기([승인 필요])를 화면에 쓰지 않는다(DS 5-3).
  assert.match(t, /실제 청구·지급은 계약서가 확정된 뒤에 진행합니다/, '확정 아님을 밝힌다');
  assert.equal(/#c0392b|#b26a00/.test(t), false, '색은 토큰만');
  assert.match(t, /className="ac-col-wide"/, '좁은 화면에서 접히는 열');
});

test('렌더된 화면에 비활성 버튼이 없다 — 초점을 떨어뜨리지 않는다 (DS 8-1)', opts, async () => {
  const html = await render();
  const bad = (html.match(/<button[^>]*\sdisabled[^>]*>/g) || []);
  assert.equal(bad.length, 0, `비활성 버튼 ${bad.length}곳: ${bad.slice(0, 2).join(' / ')}`);
  // 첫 렌더에는 진행 중인 동작이 없으므로 aria-disabled 도 없어야 한다 —
  // 아무것도 누르지 않았는데 잠겨 보이면 그 자체가 결함이다.
  assert.equal(/aria-disabled="true"/.test(html), false, '아무 동작도 하지 않았는데 잠긴 버튼이 있다');
});


test('가로로 넘치는 표·코드 블록이 키보드로 닿는 스크롤 영역 안에 있다 (DS 9-1)', opts, () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');

  // ① 표는 예외 없이 ScrollX 안에 있다. 하나라도 밖에 있으면 375px 에서 그 표가
  //    카드를 밀어내 화면 전체가 가로로 흐른다(상단바·사이드바가 어긋난다).
  const lines = src.split('\n');
  const tables = [];
  lines.forEach((ln, i) => {
    if (ln.includes('<table className="ac-table">')) tables.push(i);
  });
  assert.ok(tables.length >= 9, `콘솔 표가 ${tables.length}개뿐이다 — 표가 공통 규격을 벗어났는지 확인`);
  for (const i of tables) {
    let j = i - 1;
    while (j >= 0 && lines[j].trim() === '') j -= 1;
    assert.match(lines[j], /<ScrollX label="/, `${i + 1}행 표가 스크롤 영역 밖에 있다: ${lines[j].trim().slice(0, 60)}`);
  }
  // ② 넘침 처리는 한 곳(.ac-scrollx)만 쓴다 — 화면마다 따로 적으면 키보드 처리가 또 빠진다.
  assert.equal(/overflowX:\s*'auto'/.test(src), false, '표·코드 블록이 ScrollX 를 우회해 직접 overflowX 를 쓴다');
  assert.match(css, /\.ac-scrollx\{[^}]*overflow-x:auto/, '.ac-scrollx 가 없다');
  assert.match(css, /\.ac-scrollx:focus-visible\{[^}]*outline:/, '초점 테두리가 없으면 어디에 있는지 알 수 없다');

  // ③ 스크롤 영역은 넘치는 동안 초점을 받는다(넘치지 않으면 Tab 을 막지 않는다).
  const comp = src.slice(src.indexOf('function ScrollX'), src.indexOf('type LoadPhase'));
  assert.match(comp, /useState\(true\)/, '측정 전·서버 렌더에서는 닿을 수 있는 쪽이 기본값이어야 한다');
  assert.match(comp, /scrollWidth - el\.clientWidth > 1/, '실제로 넘치는지를 재서 정한다');
  assert.match(comp, /scrollable \? \{ role: 'region', tabIndex: 0, 'aria-label'/, '조건부 role·tabIndex·이름');
  assert.match(comp, /가로로 스크롤할 수 있습니다/, '스크린리더가 무엇을 할 수 있는지 알려준다');
  assert.match(comp, /ResizeObserver/, '칸 수가 바뀌면 다시 잰다');
  assert.match(comp, /addEventListener\('resize'/, 'ResizeObserver 가 없는 환경에서는 창 크기로 따라간다');
  assert.match(comp, /ro = null;/, '관찰을 걸지 못해도 예외가 새지 않는다');

  // ④ 설치 스니펫은 한 줄이라 좁은 화면에서 반드시 넘친다.
  //    (DS 59-3 이후 그 한 줄에 고른 옵션이 실린다 — 더 길어졌을 뿐 이 자리의 요구는 같다.)
  assert.match(src, /<ScrollX label="설치 코드">[\s\S]{0,400}<code>\{installSnippet\(origin[^)]*\)\}<\/code>/, '설치 코드 블록이 스크롤 영역 밖에 있다');
  assert.match(src, /width: 'max-content', minWidth: '100%'/, '스크롤해도 코드 블록 배경이 끊기지 않아야 한다');
});

test('설치 「선택 옵션」 표가 콘솔 공통 표 규격을 따른다 (DS 9-2)', opts, () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  // 테두리·여백을 화면마다 따로 적어 두면 표 규격을 손볼 때 이 화면만 어긋난다(DS 6-2 와 같은 종류).
  assert.equal(/borderCollapse/.test(src), false, '표 하나가 .ac-table 을 우회해 직접 표 스타일을 적는다');
  const block = src.slice(src.indexOf('선택 옵션</h3>'));
  const head = block.slice(0, 900);
  assert.match(head, /<table className="ac-table">/, '공통 표 규격');
  assert.equal((head.match(/scope="col"/g) || []).length, 2, '머리칸마다 scope 가 있어야 어느 열인지 읽힌다');
  assert.match(head, /<code style=\{\{ whiteSpace: 'nowrap' \}\}>\{opt\}/, '옵션 이름은 줄바꿈하지 않는다');
});

test('정산 기준월·파트너 조건이 주소에 남아 새로고침·링크 공유에서 살아남는다 (DS 9-3)', opts, () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');

  // 탭 이름과 조건을 같은 해시에서 읽는다(DS 6-3 이 세운 「주소가 화면의 출처」를 넓힌 것).
  assert.match(src, /function viewFromHash\(hash: string\): \{ tab: TabKey; params: URLSearchParams \}/, 'viewFromHash');
  assert.match(src, /function tabFromHash\(hash: string\): TabKey \{\s*return viewFromHash\(hash\)\.tab;/, 'tabFromHash 는 같은 파서를 쓴다');
  // page.tsx 는 기본 내보내기만 허용된다(라우트 파일 규칙과 같은 이유).
  assert.equal(/^export (?:function|const) (?:viewFromHash|tabFromHash|MONTH_RE)/m.test(src), false, '헬퍼를 내보내면 안 된다');

  // 주소에서 온 값은 믿지 않는다.
  const m = src.match(/const MONTH_RE = (\/.*\/);/);
  assert.ok(m, 'MONTH_RE 가 없다');
  const re = new RegExp(m[1].slice(1, -1));
  for (const good of ['2026-01', '2026-09', '1999-12']) assert.equal(re.test(good), true, `기준월로 받아야 한다: ${good}`);
  for (const bad of ['2026-13', '2026-00', '26-09', '2026-9', '2026-09-01', '', 'abcd-ef']) {
    assert.equal(re.test(bad), false, `기준월로 받으면 안 된다: ${bad}`);
  }
  assert.match(src, /MONTH_RE\.test\(m\) \? m : settleCond\.current\.month/, '이상한 값이면 보던 달을 지킨다');
  assert.match(src, /\(params\.get\('p'\) \?\? ''\)\.slice\(0, 64\)/, '파트너 식별자 길이를 자른다');

  // 주소 → 조건: 첫 진입과 뒤로/앞으로 둘 다.
  const reader = src.slice(src.indexOf("const { tab: t, params } = viewFromHash"), src.indexOf("// 조건 → 주소"));
  assert.match(reader, /if \(t !== 'settle'\) return;/, '다른 탭의 해시에는 손대지 않는다');
  assert.match(reader, /setSettleReport\(null\);/, '조건이 달라지면 이전 달의 표를 그대로 두지 않는다');
  assert.match(reader, /addEventListener\('hashchange', apply\)/, '뒤로/앞으로도 조건을 되받는다');
  assert.match(reader, /removeEventListener\('hashchange', apply\)/, '리스너를 걷는다');

  // 조건 → 주소: 기준월 변경은 방문 기록을 쌓지 않는다(뒤로가기는 탭 이동으로 남는다).
  const writer = src.slice(src.indexOf('// 조건 → 주소'));
  const w = writer.slice(0, 900);
  assert.match(w, /replaceState\(null, '', next\)/, '조건은 replaceState 로 남긴다');
  assert.equal(/pushState/.test(w), false, '기준월을 바꿀 때마다 방문 기록이 쌓이면 뒤로가기가 쓸모없어진다');
  assert.match(w, /`#settle\?\$\{qs\.toString\(\)\}`/, '해시 형식');
  assert.match(w, /if \(settlePartner\) qs\.set\('p', settlePartner\)/, '전체 조회일 때는 빈 값을 주소에 싣지 않는다');
  assert.match(w, /catch \{[\s\S]{0,160}정산 계산 자체는 막지 않는다/, '주소를 바꾸지 못해도 계산은 계속된다');
});

test('탭마다 브라우저 제목이 달라진다 — 북마크·방문 기록에서 열 화면이 구분된다 (DS 12-1)', opts, () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');

  // 라벨은 사이드바 정의(TAB_GROUPS) 하나에서만 나온다 — 헤더 h1·본문 이름·브라우저 제목이 같은 값을 본다.
  assert.match(src, /const TAB_LABEL = Object\.fromEntries\(TAB_GROUPS\.flatMap\(\(g\) => g\.tabs\)\)/, 'TAB_LABEL 단일 출처');
  assert.match(src, /const currentLabel = TAB_LABEL\[tab\]/, '헤더 제목도 같은 출처를 본다');
  assert.match(src, /function docTitle\(tab: TabKey\): string \{[\s\S]{0,140}TAB_LABEL\[tab\]/, 'docTitle');
  // page.tsx 는 기본 내보내기만 허용된다(라우트 파일 규칙과 같은 이유).
  assert.equal(/^export (?:function|const) (?:docTitle|TAB_LABEL)/m.test(src), false, '헬퍼를 내보내면 안 된다');

  // 탭이 바뀔 때마다 제목을 다시 쓴다. 의존 배열이 [tab] 이 아니면 첫 화면 제목에 머문다.
  const eff = src.slice(src.indexOf('// 화면 → 브라우저 제목'));
  assert.match(eff.slice(0, 400), /document\.title = docTitle\(tab\);/, '탭에서 제목을 만든다');
  assert.match(eff.slice(0, 400), /\}, \[tab\]\);/, '탭이 바뀌면 다시 쓴다');
  assert.match(eff.slice(0, 400), /catch \{/, '제목을 못 바꾸는 환경에서도 화면은 그대로 쓴다');

  // TabKey 열 개가 전부 사이드바에 있어야 docTitle 이 기본값으로 떨어지지 않는다.
  const keys = (src.match(/^type TabKey = (.+);$/m) || [])[1];
  assert.ok(keys, 'TabKey 정의를 찾지 못했다');
  const tabKeys = keys.split('|').map((s) => s.trim().replace(/'/g, ''));
  assert.equal(tabKeys.length, 10, '탭 수');
  const groups = src.slice(src.indexOf('const TAB_GROUPS'), src.indexOf('/** 주소(해시)에 쓰는 탭 이름'));
  const labelled = new Map((groups.match(/\['(\w+)', '([^']+)'\]/g) || []).map((p) => {
    const [, k, v] = p.match(/\['(\w+)', '([^']+)'\]/);
    return [k, v];
  }));
  for (const k of tabKeys) assert.ok(labelled.get(k), `사이드바에 라벨이 없는 탭: ${k}`);
  // 열 개의 제목이 서로 달라야 목록에서 구분된다.
  const titles = new Set(tabKeys.map((k) => `${labelled.get(k)} — 관리 콘솔 · GOWON Chat`));
  assert.equal(titles.size, tabKeys.length, '같은 제목을 쓰는 탭이 있다');
});

test('콘솔 표 9곳에 접근 이름이 있다 — 이름은 스크롤 영역과 같은 출처 (DS 13-3)', opts, () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const lines = src.split('\n');
  // DS 9-1 이 붙인 이름(「… — 가로로 스크롤할 수 있습니다」)은 **넘칠 때만** 나온다.
  // 넓은 화면에서는 표에 이름이 하나도 없어, 표 목록으로 이동하면 무엇의 표인지 알 수 없다.
  let tables = 0;
  lines.forEach((ln, i) => {
    if (!ln.includes('<table className="ac-table">')) return;
    tables += 1;
    let j = i - 1;
    while (j >= 0 && lines[j].trim() === '') j -= 1;
    const label = (lines[j].match(/<ScrollX label="([^"]+)">/) || [])[1];
    assert.ok(label, `${i + 1}행 표가 ScrollX 밖에 있다`);
    // 이름은 스크롤 영역 라벨과 **같은 글자**여야 한다 — 두 출처가 갈라지면 읽히는 이름이 둘이 된다.
    assert.equal(
      lines[i + 1].trim(),
      `<caption className="ac-srhide">${label}</caption>`,
      `${i + 1}행 표(${label})에 접근 이름이 없거나 스크롤 영역 라벨과 다르다`,
    );
  });
  assert.ok(tables >= 9, `콘솔 표가 ${tables}개뿐이다`);
  assert.equal((src.match(/<caption className="ac-srhide">/g) || []).length, tables, '이름 없는 표가 남아 있다');
  // 이름은 화면에 글자로 나타나지 않는다(표 위 제목과 두 번 보이지 않게) — 기존 숨김 규격을 그대로 쓴다.
  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  assert.match(css, /\.ac-srhide\{[^}]*clip:rect\(0 0 0 0\)/, '스크린리더 전용 숨김 규격이 없다');
});

test('터치 기기에서 입력칸이 화면을 확대시키지 않는다 (DS 14-1)', () => {
  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  // iOS Safari 는 16px 미만 입력칸에 초점이 가면 화면을 확대하고 되돌리지 않는다.
  // 콘솔·위젯·랜딩의 입력칸은 모두 13~14px 이므로(디자인 규격) 터치 기기에서만 한 곳에서 덮는다.
  const block = (css.match(/@media \(pointer:coarse\)\{[\s\S]*?\n\}/) || [])[0];
  assert.ok(block, '터치 기기용 입력칸 규칙이 없다');
  assert.match(block, /input,\s*select,\s*textarea\{font-size:16px!important\}/, '입력칸 3종을 모두 덮어야 한다');

  // 인라인 글자 크기(style={{fontSize:13.5}})보다 세야 하므로 !important 가 필요하다.
  assert.match(block, /!important/, '인라인 스타일을 이기지 못하면 규칙이 없는 것과 같다');

  // 확대 자체를 막는 길(maximum-scale·user-scalable=no)은 쓰지 않는다 — WCAG 1.4.4 위반이다.
  const layout = readFileSync(new URL('../src/app/layout.tsx', import.meta.url), 'utf8');
  assert.equal(/maximumScale|userScalable|user-scalable/.test(layout), false, '손으로 확대할 권리를 빼앗으면 안 된다');
});

test('관리 토큰은 탭을 닫으면 지워진다 — 공용 PC 에 남지 않는다 (DS 14-3)', opts, async () => {
  const ss = fakeStorage();
  const ls = fakeStorage();
  const win = { sessionStorage: ss, localStorage: ls };
  const t = await loadTokenStore(win);

  // 정상 경로: 저장은 탭 단위 저장소로만 간다.
  t.writeSavedToken('secret-token');
  assert.equal(ss.map.get(t.TOKEN_KEY), 'secret-token', '탭 저장소에 있어야 한다');
  assert.equal(ls.map.has(t.TOKEN_KEY), false, '브라우저를 닫아도 남는 저장소에 두면 안 된다');
  assert.equal(t.readSavedToken(), 'secret-token', '같은 탭에서는 새로고침해도 이어져야 한다');

  // 로그아웃: 값을 비우면 저장소에서 지운다(빈 문자열로 남기지 않는다).
  t.writeSavedToken('');
  assert.equal(ss.map.has(t.TOKEN_KEY), false, '로그아웃하면 지워야 한다');

  // 이전 판이 localStorage 에 남긴 토큰은 한 번 옮기고 원본을 지운다.
  ls.map.set(t.TOKEN_KEY, 'legacy-token');
  assert.equal(t.readSavedToken(), 'legacy-token', '이미 로그인해 둔 사람을 내쫓지 않는다');
  assert.equal(ls.map.has(t.TOKEN_KEY), false, '옛 저장처에서 지워야 영구히 남지 않는다');
  assert.equal(ss.map.get(t.TOKEN_KEY), 'legacy-token', '탭 저장소로 옮겨야 한다');

  // 실패 경로: 저장소 접근이 막혀도 예외가 새지 않는다(그 탭에서 다시 로그인하면 된다).
  const blocked = await loadTokenStore({ sessionStorage: fakeStorage({ throws: true }), localStorage: fakeStorage({ throws: true }) });
  assert.equal(blocked.readSavedToken(), '', '읽지 못하면 로그인 전과 같이 다룬다');
  assert.doesNotThrow(() => blocked.writeSavedToken('x'));
  assert.doesNotThrow(() => blocked.writeSavedToken(''));

  // 새 저장 경로가 생겨도 같은 결함이 다시 나지 않게 — 콘솔이 브라우저에 **영구히** 쓰는 것은
  // 비밀값이 아닌 보기 설정 하나(「큰 글씨」, DS 25-1)뿐이고, 그 값은 '1' 이다.
  // (보기 설정까지 탭 단위로 두면 매일 아침 다시 켜야 한다 — 눈에 달린 설정은 사람을 따라간다.)
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const perm = src.match(/window\.localStorage\.setItem\([^)]*\)/g) || [];
  assert.deepEqual(perm, ['window.localStorage.setItem(VIEW_SCALE_KEY, \'1\')'], '영구 저장소에 쓰는 자리는 보기 설정 하나여야 한다');
  assert.equal(/localStorage\.setItem\([^)]*[Tt]oken/.test(src), false, '관리 토큰을 영구 저장소에 쓰면 안 된다');
  // 화면 안내가 실제 보관 기간과 어긋나면 안 된다(「이 브라우저에만 저장」은 사실이 아니었다).
  assert.match(src, /이 탭에만 보관되고 브라우저를 닫으면 지워집니다/, '보관 기간을 밝혀야 한다');
});

/* ══════════ 디자인 스프린트 — 13차 재감사 (DS 16-3) ══════════ */

/**
 * 연락처 파기(escalation.updateTicket)는 tests/runtime.test.mjs 가 실제로 실행해 확인한다.
 * 여기서는 **화면과 기록**을 본다: 파기했다는 사실이 운영자에게 보이는가, 지우기 전에 묻는가,
 * 감사 로그에 남는가. 지워 놓고 말하지 않으면 운영자는 연락처가 원래 없었다고 오해한다.
 */
test('연락처 파기가 화면·확인·기록에 드러난다 (DS 16-3)', () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');

  // 1) 「처음부터 없음」과 「받았다가 파기함」을 다르게 말한다.
  const d = src.slice(src.indexOf('function TicketDrawer'), src.indexOf('function KpiCard'));
  assert.match(d, /t\.contactPurgedAt \? '연락처 파기됨' : '연락처 없음'/, '상세 머리에서 두 상태가 구분되지 않는다');
  assert.match(d, /timeLabel\(t\.contactPurgedAt\)/, '언제 파기했는지 보여야 한다');
  assert.match(d, /개인정보처리방침 4조/, '무슨 근거로 지웠는지 밝혀야 한다');
  assert.match(d, /되살릴 수 없습니다/, '되돌릴 수 없다는 사실을 알려야 한다');
  // 목록에서도 같은 구분을 한다.
  assert.match(src, /연락처 파기됨<\/span>[\s\S]{0,120}: null/, '목록 셀에서 파기 상태가 빠졌다');

  // 2) 지우기 전에 묻는다 — 되돌릴 수 없는 동작은 전부 askConfirm 을 거친다(DS 5-4 규약).
  const patch = src.slice(src.indexOf('const patchTicket ='), src.indexOf('const patchTicket =') + 1600);
  assert.match(patch, /status === 'resolved' \|\| status === 'canceled'/, '완료·취소에만 걸려야 한다');
  assert.match(patch, /target\?\.contact/, '지울 것이 없는 접수에는 묻지 않아야 한다');
  assert.match(patch, /askConfirm\(\{[\s\S]{0,400}연락처를 파기합니다/, '파기 전에 확인을 받지 않는다');
  assert.match(patch, /maskContact\(target\.contact\)/, '확인 대화상자에 연락처 원문을 싣지 말 것');
  assert.match(patch, /if \(!agreed\) return;/, '취소를 눌러도 진행된다');
  assert.match(patch, /연락처 파기'/, '무엇이 사라졌는지 토스트로 알려야 한다');

  // 3) 개인정보 파기는 감사 로그에 남는다 — 단, 연락처 원문은 싣지 않는다(§10.3).
  const route = readFileSync(new URL('../src/app/api/admin/escalations/route.ts', import.meta.url), 'utf8');
  assert.match(route, /const hadContact = Boolean\(getTicket\(id\.value\)\?\.contact\)/, '바꾸기 전 상태를 읽지 않으면 파기 여부를 알 수 없다');
  assert.match(route, /parts\.push\('연락처 파기'\)/, '파기가 감사 로그에 남지 않는다');
  assert.equal(/detail:[^\n]*\.contact\b/.test(route), false, '감사 로그에 연락처 원문이 실린다');

  // 4) 방침 문안과 동작이 어긋나지 않는다(문안을 고치면 이 테스트가 먼저 깨진다).
  const privacy = readFileSync(new URL('../src/app/privacy/page.tsx', import.meta.url), 'utf8');
  assert.match(privacy, /연락처는 상담[\s\S]{0,20}완료 후 지체 없이 파기합니다/, '방침의 파기 약속 문장을 찾지 못했다');
});

/* ══════════ 디자인 스프린트 — 17차 재감사 (DS 20-2) ══════════ */

/**
 * 컴파일된 JS 에서 최상위 함수 몇 개를 떼어내 실제로 실행한다(DS 14-3 의 방식과 같다).
 * 「마지막 조건까지 따라간다」는 소스 검사로는 확인할 수 없다 — 돌려 봐야 안다.
 */
async function loadFollowLatest() {
  await loadConsole();
  const parts = ['followLatest', 'sameSettleCond'].map((n) => {
    // `async` 를 빼고 떼어내면 본문의 await 가 문법 오류가 된다 — 선언부를 함께 잡는다.
    const m = new RegExp(`(?:async )?function ${n}\\(`).exec(cachedJs);
    assert.ok(m, `${n} 선언을 찾지 못했다`);
    const end = cachedJs.indexOf('\n}', m.index); // 최상위 함수라 닫는 중괄호는 1열에 있다
    assert.ok(end > m.index, `${n} 의 끝을 찾지 못했다`);
    return cachedJs.slice(m.index, end + 2);
  });
  return new Function(`${parts.join('\n')}\nreturn { followLatest, sameSettleCond };`)();
}

/**
 * DS 20-2 — 계산 중에 기준월을 다시 고르면 두 번째 요청이 **조용히** 버려졌다.
 *
 * `useRunOnce` 의 claim 이 거짓이면 종전 `loadSettlement` 는 그대로 돌아갔다(로딩도, 오류도 없음).
 * 그래서 조건만 새 달로 바뀌고 KPI·파트너별 합계·수수료 합계는 앞선 달 그대로 남았다 —
 * 운영자가 화면에서 그대로 옮겨 적는 금액이다(QUALITY_BAR §1·§3).
 */
test('정산 조회가 마지막으로 고른 조건까지 따라간다 (DS 20-2)', opts, async () => {
  const { followLatest, sameSettleCond } = await loadFollowLatest();

  assert.equal(sameSettleCond({ month: '2026-08', partnerId: '' }, { month: '2026-08', partnerId: '' }), true);
  assert.equal(sameSettleCond({ month: '2026-08', partnerId: '' }, { month: '2026-07', partnerId: '' }), false);
  assert.equal(sameSettleCond({ month: '2026-08', partnerId: 'p1' }, { month: '2026-08', partnerId: '' }), false, '파트너 조건도 함께 봐야 한다');

  // ① 조회가 도는 중에 기준월이 두 번 바뀐다 — 화면에 남는 것은 마지막 조건의 결과여야 한다.
  const want = { current: { month: '2026-08', partnerId: '' } };
  const queried = [];
  let applied = null;
  const nextCond = ['2026-07', '2026-06'];
  await followLatest(want, sameSettleCond, async (cond, stillWanted) => {
    queried.push(cond.month);
    // 응답을 기다리는 사이에 사용자가 기준월을 또 바꿨다.
    const n = nextCond.shift();
    if (n) want.current = { month: n, partnerId: '' };
    await Promise.resolve();
    if (!stillWanted()) return true; // 지금 화면의 답이 아니다 — 싣지 않는다
    applied = cond.month;
    return true;
  });
  assert.deepEqual(queried, ['2026-08', '2026-07', '2026-06'], '바뀐 조건으로 다시 조회하지 않는다');
  assert.equal(applied, '2026-06', '화면에 앞선 달의 금액이 남는다');

  // ② 조건이 그대로면 한 번만 조회한다(같은 계산을 되풀이하지 않는다).
  const once = { current: { month: '2026-08', partnerId: 'p1' } };
  let calls = 0;
  await followLatest(once, sameSettleCond, async () => { calls += 1; return true; });
  assert.equal(calls, 1, '조건이 그대로인데 다시 조회한다');

  // ③ 세션이 만료되면(step 이 false) 더 따라가지 않는다 — 잠금 화면 뒤에서 계속 물어보면 안 된다.
  const expired = { current: { month: '2026-08', partnerId: '' } };
  let tries = 0;
  await followLatest(expired, sameSettleCond, async () => {
    tries += 1;
    expired.current = { month: '2026-07', partnerId: '' };
    return false;
  });
  assert.equal(tries, 1, '세션이 끊겼는데 조회를 이어간다');
});

test('정산 화면은 고른 조건이 답한 리포트만 그린다 (DS 20-2)', () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  // 조회는 「마지막으로 고른 조건」 한 곳(settleWant)만 보고 followLatest 를 거친다.
  assert.match(src, /const settleWant = useRef<SettleCond>/, '원하는 조건을 담는 ref 가 없다');
  const load = src.slice(src.indexOf('const loadSettlement ='), src.indexOf('const settleView'));
  assert.match(load, /settleWant\.current = \{ month, partnerId \}/, '요청 조건을 남기지 않으면 따라갈 수 없다');
  assert.match(load, /await followLatest\(settleWant, sameSettleCond/, '조건 변경을 따라가지 않는다');
  assert.match(load, /if \(!stillWanted\(\)\) return true/, '지난 조건의 응답을 화면에 싣는다');
  // 그리기 직전에 한 번 더 대조한다 — KPI·표·CSV 가 같은 값(settleView)을 본다.
  assert.match(src, /const settleView = settleReport && \(!MONTH_RE\.test\(settleMonth\)/, '조건과 결과를 대조하지 않는다');
  assert.match(src, /if \(!settleView \|\| settleView\.rows\.length === 0\)/, 'CSV 내려받기가 화면과 다른 리포트를 본다');
  assert.match(src, /\{tab === 'settle' && \(\(\) => \{\s*\n\s*const r = settleView;/, '정산 화면이 대조를 거치지 않은 리포트를 그린다');
});

/* ══════════ 디자인 스프린트 — 18차 재감사 (DS 21-2) ══════════ */

/**
 * DS 21-2 — 기준월 기본값이 UTC 달이었다.
 *
 * `new Date().toISOString().slice(0, 7)` 은 한국 자정~오전 9시에 아직 지난달이다.
 * 정산은 월초 업무라 그 아홉 시간이 정확히 운영자가 이 탭을 여는 시간대다 —
 * 매월 1일 아침, 고르지도 않은 달의 수수료 합계가 「이번 달」인 것처럼 떴다.
 * 콘솔은 lib 을 불러오지 않으므로(클라이언트 번들) 계산식이 두 곳에 있다 — 여기서 맞춰 고정한다.
 */
test('콘솔의 기준월 기본값이 한국 시간 기준 이번 달이다 (DS 21-2)', opts, async () => {
  await loadConsole();
  const m = /function kstMonthNow\(/.exec(cachedJs);
  assert.ok(m, 'kstMonthNow 선언을 찾지 못했다');
  const end = cachedJs.indexOf('\n}', m.index);
  assert.ok(end > m.index, 'kstMonthNow 의 끝을 찾지 못했다');
  const { kstMonthNow } = new Function(`${cachedJs.slice(m.index, end + 2)}\nreturn { kstMonthNow };`)();

  // 대조는 독립 구현(ICU 시간대 데이터)으로 한다 — 같은 식을 두 번 적어 맞다고 하지 않는다.
  const oracle = (iso) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 7);
  for (const iso of ['2026-10-01T02:00:00+09:00', '2026-09-30T23:00:00+09:00', '2027-01-01T08:59:00+09:00', '2026-06-15T15:00:00Z']) {
    assert.equal(kstMonthNow(new Date(iso)), oracle(iso), iso);
  }
  // 고치기 전 값과 실제로 달라지는 시각인지 확인한다(이 간극이 결함의 크기다).
  assert.equal(new Date('2026-10-01T02:00:00+09:00').toISOString().slice(0, 7), '2026-09');
  assert.equal(kstMonthNow(new Date('2026-10-01T02:00:00+09:00')), '2026-10');

  // 서버 기본값(src/lib/kst.ts)과 같은 오프셋을 쓰는지 — 갈라지면 화면과 계산이 다른 달을 본다.
  const lib = readFileSync(new URL('../src/lib/kst.ts', import.meta.url), 'utf8');
  assert.match(lib, /9 \* 60 \* 60 \* 1000/, 'lib 의 KST 오프셋 선언이 바뀌었다');
  const page = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /9 \* 60 \* 60 \* 1000/, '화면의 KST 오프셋 선언이 바뀌었다');
  assert.match(page, /src\/lib\/kst\.ts/, '옮겨 적은 계산식의 원본을 밝히지 않았다');
});

/* ══════════ 디자인 스프린트 — 20차 재감사 (DS 23-2) ══════════ */

/** 컴파일된 콘솔에서 `afetch` 와 그 기본 기한을 떼어내 실제로 돌린다(DS 20-2 의 방식). */
async function loadAfetch() {
  await loadConsole();
  const konst = /const REQUEST_TIMEOUT_MS = \d+;/.exec(cachedJs);
  assert.ok(konst, 'REQUEST_TIMEOUT_MS 선언을 찾지 못했다');
  const m = /function afetch\(/.exec(cachedJs);
  assert.ok(m, 'afetch 선언을 찾지 못했다');
  const end = cachedJs.indexOf('\n}', m.index); // 최상위 함수라 닫는 중괄호는 1열에 있다
  assert.ok(end > m.index, 'afetch 의 끝을 찾지 못했다');
  return new Function(`${konst[0]}\n${cachedJs.slice(m.index, end + 2)}\nreturn afetch;`)();
}

/**
 * DS 23-2 — 끝나지 않는 요청 하나가 그 탭을 영구히 묶었다.
 *
 * 불러오기는 `phase: 'loading'` 에 머물러 스켈레톤만 반짝이고(「다시 시도」는 `error` 일 때만 뜬다),
 * 중복 실행 잠금(`claim`)은 `release` 를 만나지 못해 같은 기능을 다시 누를 수조차 없었다.
 * 「정말 끊기는가」는 소스 검사로 볼 수 없다 — 돌려 봐야 안다.
 */
test('콘솔 요청도 기한이 지나면 끊긴다 (DS 23-2)', opts, async () => {
  const afetch = await loadAfetch();
  const prev = globalThis.fetch;
  try {
    // ① 끝나지 않는 요청 — 진짜 fetch 처럼 **신호가 끊길 때만** 거절한다.
    const seen = [];
    globalThis.fetch = (url, init) => {
      seen.push({ url, init });
      return new Promise((_resolve, reject) => {
        if (!init?.signal) return; // 기한이 없으면 영원히 끝나지 않는다(종전 동작)
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      });
    };
    const t0 = Date.now();
    const err = await afetch('/api/admin/kb', { headers: { 'x-admin-token': 't' } }, 40).then(() => null, (e) => e);
    assert.ok(err, '끝나지 않는 요청인데 성공으로 돌아왔다');
    assert.equal(err.name, 'AbortError', `기한이 지나도 요청을 끊지 않는다(${err.name})`);
    assert.ok(Date.now() - t0 < 3000, '기한을 훨씬 넘겨서 끊는다');
    // 기존 요청 형태(인증 헤더)는 그대로 가야 한다 — 기한만 더한 것이다.
    assert.equal(seen[0].url, '/api/admin/kb');
    assert.equal(seen[0].init.headers['x-admin-token'], 't', '인증 헤더가 사라졌다');
    assert.ok(seen[0].init.signal, '요청에 끊을 수 있는 신호를 붙이지 않았다');

    // ② 기한 안에 온 응답은 그대로 통과한다(타이머가 받은 답을 끊지 않는다).
    const res = { ok: true, status: 200 };
    globalThis.fetch = async () => res;
    assert.equal(await afetch('/api/health', {}, 1000), res, '응답을 그대로 돌려주지 않는다');

    // ③ 기한을 적지 않은 호출도 기본 기한을 쓴다 — 요청마다 손으로 적게 하면 어느 하나는 빠진다.
    const noMs = [];
    globalThis.fetch = async (url, init) => { noMs.push(init); return res; };
    await afetch('/api/admin/rules');
    assert.ok(noMs[0].signal, '기한을 생략한 요청에는 신호가 붙지 않는다');
  } finally {
    globalThis.fetch = prev;
  }
});

/* ══════════ 디자인 스프린트 — 21차 재감사 (DS 24-1·24-2) ══════════ */

/** 컴파일된 콘솔에서 최상위 순수 함수를 떼어내 실제로 돌린다(DS 20-2·23-2 의 방식). */
async function loadFns(names) {
  await loadConsole();
  const parts = names.map((n) => {
    const i = cachedJs.indexOf(`function ${n}(`);
    assert.ok(i >= 0, `${n} 선언을 찾지 못했다`);
    const end = cachedJs.indexOf('\n}', i); // 최상위 함수라 닫는 중괄호는 1열에 있다
    assert.ok(end > i, `${n} 의 끝을 찾지 못했다`);
    return cachedJs.slice(i, end + 2);
  });
  return new Function(`${parts.join('\n')}\nreturn { ${names.join(', ')} };`)();
}

/**
 * DS 24-1 — 자동 확인이 **쉬어야 할 때 쉬는가**.
 *
 * 숨은 탭에서도 30초마다 관리 API를 두드리면 아무도 보지 않는 화면을 위해 서버를 때리는 셈이고,
 * 끊긴 동안 두드리면 실패만 쌓인다. 운영자가 접수 상태를 바꾸는 중이면 겹쳐 읽어 순서만 흔든다.
 * 「정말 쉬는가」는 소스를 읽어서는 알 수 없다 — 돌려 봐야 안다.
 */
test('자동 확인은 숨은 탭·끊긴 연결·쓰는 중에는 쉰다 (DS 24-1)', opts, async () => {
  const { shouldPoll } = await loadFns(['shouldPoll']);
  assert.equal(shouldPoll('visible', true, false), true, '보이는 화면에서조차 돌지 않는다');
  assert.equal(shouldPoll('hidden', true, false), false, '숨은 탭에서도 두드린다');
  assert.equal(shouldPoll('visible', false, false), false, '연결이 끊겼는데도 두드린다');
  assert.equal(shouldPoll('visible', true, true), false, '운영자가 쓰는 중인데 끼어든다');
  // 브라우저가 알려 주지 않는 상태(prerender 등)는 「숨김」이 아니다 — 멈춰 세우지 않는다.
  assert.equal(shouldPoll('prerender', true, false), true, '모르는 상태를 숨김으로 단정하면 영영 쉰다');
});

/**
 * DS 24-1 — 새로 들어온 것만 알린다.
 * 콘솔을 연 순간 이미 쌓여 있던 건수는 「방금 들어온 요청」이 아니다. 줄어든 경우(운영자가
 * 처리했다)도 알릴 일이 아니다. 알림이 사실과 어긋나면 다음부터 아무도 읽지 않는다.
 */
test('대기 건수가 늘어난 때만 알린다 (DS 24-1)', opts, async () => {
  const { newRequestNotice, waitingBadge } = await loadFns(['newRequestNotice', 'waitingBadge']);
  assert.equal(newRequestNotice(null, 3), '', '콘솔을 열자마자 「새 요청 3건」이라 알린다');
  assert.equal(newRequestNotice(0, 0), '', '아무 일도 없는데 알린다');
  assert.equal(newRequestNotice(3, 1), '', '처리해서 줄었는데 「새 요청」이라 알린다');
  const msg = newRequestNotice(1, 3);
  assert.match(msg, /2건/, '늘어난 만큼(2건)을 세지 않는다');
  assert.match(msg, /상담원 요청/, '어디서 확인하는지 알려주지 않는다');
  assert.equal(/[A-Za-z]/.test(msg), false, `알림에 영문 코드가 섞였다: ${msg}`);
  // 메뉴 배지는 세 자리를 넘으면 이름을 밀어낸다 — 숫자는 줄이되 뜻은 .ac-srhide 가 전한다.
  assert.equal(waitingBadge(0), '0');
  assert.equal(waitingBadge(99), '99');
  assert.equal(waitingBadge(100), '99+');
});

/**
 * DS 24-1 — 화면이 「언제 받은 값인지」와 「스스로 확인한다는 사실」을 밝힌다.
 * 첫 렌더에는 받은 값이 없으므로 시각을 지어내지 않는다(§13).
 */
test('대시보드가 자동 확인 사실과 기준 시각을 밝힌다 (DS 24-1)', opts, async () => {
  const html = await render();
  assert.ok(html.includes('30초마다 자동 확인'), '화면이 스스로 다시 확인한다는 사실을 밝히지 않는다');
  assert.ok(html.includes('확인 전'), '아직 받은 값이 없는데 기준 시각을 지어낸다');
  assert.ok(html.includes('새로고침'), '손으로 다시 부르는 길이 사라졌다');
  // 대기 건수를 아직 모르므로 배지를 그리지 않는다 — 0을 지어내지 않는다.
  assert.equal(/ac-navcount/.test(html), false, '받은 값이 없는데 대기 배지를 그린다');
});

/* ══════════ 디자인 스프린트 — 22차 재감사 (DS 25-x) ══════════ */

/**
 * DS 25-1 — 「큰 글씨」. 기준 원본(AICC Portal `admin.html` 의 `body.big{zoom:1.13}`)을 이식한다.
 * 이 콘솔의 글자 크기는 전부 px(인라인 포함)라 브라우저의 「기본 글꼴 크기」 설정이 닿지 않는다.
 * 켜고 끄는 문(화면), 다음 방문까지 남는 것(저장), 그리고 배율 때문에 레이아웃이 화면 밖으로
 * 밀리지 않는 것(--vz) 세 가지를 모두 본다 — 셋 중 하나만 빠지면 켠 뒤가 깨진다.
 */
test('콘솔에서 글자를 키울 수 있다 — 기준 원본의 「큰 글씨」 이식 (DS 25-1)', opts, async () => {
  const html = await render();
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');

  // 1) 화면: 헤더에 눌림 상태가 있는 토글. 「가」 모양은 장식이라 숨기고 이름은 글자로 남는다.
  assert.match(html, /class="ac-viewbtn" aria-pressed="false"/, '보기 설정 토글이 헤더에 없다');
  assert.match(html, /aria-hidden="true"[^>]*>가</, '「가」 모양은 장식이어야 한다');
  assert.ok(html.includes('큰 글씨'), '버튼에 읽을 수 있는 이름이 없다');
  // 서버는 저장된 설정을 모른다 — 첫 렌더에 켜진 상태를 그리면 하이드레이션이 어긋난다.
  assert.equal(/data-view-scale/.test(html), false, '서버 렌더에 보기 설정 표시가 들어갔다');

  // 2) 저장: 비밀값이 아니므로 브라우저 단위로 남긴다(토큰은 그대로 탭 단위 — DS 14-3).
  assert.match(src, /const VIEW_SCALE_KEY = '[^']+'/, '설정 키가 없다');
  assert.match(src, /function readBigText\(\)[\s\S]{0,300}return false;/, '저장소가 막혀도 꺼짐으로 시작해야 한다');
  assert.match(src, /body\.dataset\.viewScale = 'big'/, '켜짐을 화면 전체에 알리는 표시가 없다');
  assert.match(src, /delete body\.dataset\.viewScale/, '콘솔을 떠나면 표시를 거둬야 한다(랜딩은 대상이 아니다)');

  // 3) CSS: 배율은 CSS 한 곳에만 있고, 로그인 화면도 같이 커진다(토글 전에 보는 화면이다).
  assert.match(css, /body\[data-view-scale="big"\]\{--vz:1\.13\}/, '배율 토큰이 없다');
  assert.match(css, /body\[data-view-scale="big"\] \.ac-login\{zoom:1\.13\}/, '로그인 화면도 같이 커져야 한다');
  assert.match(css, /body\[data-view-scale="big"\] \.ac-shell,/, '셸이 커져야 한다');
  // 두 값이 갈라지면 뷰포트 단위 보정이 어긋난다 — 같은 수인지 고정한다.
  const vz = (css.match(/body\[data-view-scale="big"\]\{--vz:([\d.]+)\}/) || [])[1];
  const zoom = (css.match(/body\[data-view-scale="big"\] \.ac-login\{zoom:([\d.]+)\}/) || [])[1];
  assert.equal(vz, zoom, `--vz(${vz}) 와 zoom(${zoom}) 이 갈라졌다`);

  // 4) zoom 은 vh·vw 까지 곱한다 — 보정하지 않으면 사이드바 아래가 화면 밖으로 밀린다.
  //    셸 안에서 뷰포트 단위를 쓰는 자리는 **전부** --vz 로 나눠야 한다(clamp 안의 글자 크기는 제외 —
  //    배율로 커질 요소가 아니라 화면 폭에 따라 커지는 랜딩 제목이다).
  const decls = css.replace(/\/\*[\s\S]*?\*\//g, ''); // 주석은 규칙이 아니다
  const unguarded = (decls.match(/[\d.]+v[hw]\b(?!\s*\/\s*var\(--vz\))/g) || [])
    .filter((m) => !decls.includes(`clamp(24px,${m}`));
  assert.deepEqual(unguarded, [], `--vz 로 나누지 않은 뷰포트 단위가 남았다: ${unguarded.join(', ')}`);
  for (const rule of [
    /\.ac-shell\{[^}]*min-height:calc\(100vh \/ var\(--vz\)\)/,
    /\.ac-side\{[^}]*height:calc\(100vh \/ var\(--vz\)\)/,
    /\.ac-login\{min-height:calc\(100vh \/ var\(--vz\)\)/,
    /\.ac-drawer\{[^}]*width:min\(520px,calc\(100vw \/ var\(--vz\)\)\)/,
  ]) assert.match(css, rule, `보정 누락: ${rule}`);
  // 기본값은 1 — 꺼져 있을 때 지금까지의 레이아웃과 한 픽셀도 달라지지 않는다.
  assert.match(css, /--vz:1;/, '기본 배율이 1이 아니면 평소 화면이 바뀐다');

  // 5) 375px: 헤더가 접힐 때 토글이 사라지지 않는다(인쇄에서만 감춘다 — DS 25-3).
  const pr = css.slice(css.indexOf('@media print{'));
  assert.ok(pr.includes('.ac-viewbtn'), '인쇄에서는 보기 설정을 감춘다');
  const mobile = css.slice(css.indexOf('@media (max-width:900px){\n  .ac-shell'), css.indexOf('@media (forced-colors: active){'));
  assert.equal(/\.ac-viewbtn\{display:none\}/.test(mobile), false, '좁은 화면에서 토글을 지우면 안 된다');
});

/**
 * DS 25-2 — OS 고대비(강제 색) 모드.
 * 이 모드는 글자색·배경색·테두리색을 사용자가 고른 색으로 덮고 그림자를 지운다. 그런데 이 화면이
 * 「선택됨·켜짐」을 말하는 신호는 거의 전부 배경색 하나였다 — 치환되면 신호가 0이 된다.
 */
test('OS 고대비에서도 「지금 선택된 것」이 보인다 (DS 25-2)', opts, () => {
  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  const fc = css.slice(css.indexOf('@media (forced-colors: active){'), css.indexOf('@media print{'));
  assert.ok(fc.length > 0, '강제 색 모드 규칙이 없다');

  // 배경색 하나로만 말하던 자리 6곳이 모두 다시 보여야 한다.
  for (const [sel, why] of [
    ['.ac-navbtn[aria-current="page"]', '지금 보고 있는 탭'],
    ['.ac-segbtn[aria-pressed="true"]', '눌린 세그먼트(그림자도 지워진다)'],
    ['.ac-switch[aria-checked="true"]', '규칙 켜기/끄기'],
    ['.ac-chip[data-hit="true"]', '미리보기 적중 칩'],
    ['tr[data-editing="true"]', '편집 중인 행'],
    ['.ac-gsearch-opt[aria-selected="true"]', '↑↓ 로 고른 검색 결과'],
  ]) assert.ok(fc.includes(sel), `강제 색 모드에서 신호가 사라지는 자리: ${sel} (${why})`);

  // 색을 되살리지 않고 **시스템 색**으로 말한다 — 사용자가 고른 색을 우리가 되돌리면 안 된다.
  assert.match(fc, /background:Highlight/, '시스템 「선택」 색을 쓰지 않는다');
  assert.match(fc, /color:HighlightText/, '선택 색 위의 글자색 짝이 없다');
  assert.equal(/#[0-9a-fA-F]{3}|var\(--brand|var\(--success|var\(--line/.test(fc), false, '강제 색 모드에서 우리 색을 다시 밀어 넣고 있다');
  // 꺼짐/켜짐이 같은 색이 되는 스위치는 채움으로 구분한다.
  assert.match(fc, /\.ac-switch\{forced-color-adjust:none;background:Canvas;border:1px solid ButtonText\}/, '꺼진 스위치의 바탕·테두리');
  assert.match(fc, /\.ac-switch\[aria-checked="true"\] \.ac-switch-knob\{background:HighlightText\}/, '켜진 스위치의 손잡이');

  // 평소 화면은 건드리지 않는다 — 이 규칙은 미디어 쿼리 안에만 있다.
  assert.equal(/forced-color-adjust/.test(css.replace(fc, '')), false, '강제 색 전용 속성이 평소 경로로 새어 나왔다');
});

/**
 * DS 25-3 — 인쇄.
 * 정산 리포트·감사 로그를 Ctrl+P 하면 메뉴 10개·검색칸이 종이에 찍히고, 정작 표는 가로 스크롤
 * 상자(.ac-scrollx, DS 9-1)에 갇혀 **보이던 폭까지만** 인쇄된다 — 뒤쪽 열이 종이에서 사라진다.
 */
test('인쇄하면 화면 장치가 빠지고 표가 잘리지 않는다 (DS 25-3)', opts, () => {
  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  const pr = css.slice(css.indexOf('@media print{'));
  assert.ok(pr.length > 0, '인쇄 규칙이 없다');

  // 이것이 이 항목의 핵심이다 — 상자를 펴지 않으면 열이 사라진 표가 찍힌다.
  assert.match(pr, /\.ac-scrollx\{overflow:visible\}/, '가로 스크롤 상자를 펴지 않으면 표가 잘린다');
  // 여러 장이면 머리 행을 장마다 반복한다 — 둘째 장에 열 이름이 없으면 읽을 수 없다.
  assert.match(pr, /\.ac-table thead\{display:table-header-group\}/, '머리 행 반복');
  assert.match(pr, /\.ac-table tr\{break-inside:avoid\}/, '한 행이 두 장에 걸쳐 쪼개지면 안 된다');

  // 종이에서 쓸 수 없는 것은 덜어낸다(메뉴·검색·토스트·서랍·확인 대화상자·스켈레톤).
  for (const sel of ['.ac-side', '.ac-gsearch', '.ac-toast', '.ac-offline', '.skip-link', '.ac-drawer-root', '.ac-modal-root', '.ac-skelrows']) {
    assert.ok(pr.includes(sel), `인쇄에서 덜어내지 않은 화면 장치: ${sel}`);
  }
  // 본문은 한 단으로 펴고 사이드바 자리를 비운다.
  assert.match(pr, /\.ac-shell\{display:block;min-height:0\}/, '셸을 한 단으로 펴야 한다');
  assert.match(pr, /\.ac-split,\.ac-split-test\{grid-template-columns:minmax\(0,1fr\)\}/, '분할 화면도 한 단으로');
  assert.match(pr, /@page\{margin:14mm\}/, '종이 여백');
  // 브랜드색으로 채운 버튼은 글자가 흰색이다 — 배경을 생략하면 빈 칸으로 찍힌다.
  assert.match(pr, /\.ac-body button\{print-color-adjust:exact/, '채운 버튼의 배경을 지켜야 한다');

  // 평소 화면은 건드리지 않는다.
  assert.equal(/@page|print-color-adjust/.test(css.replace(pr, '')), false, '인쇄 전용 속성이 평소 경로로 새어 나왔다');
});

/* ══════════ 디자인 스프린트 — 23차 재감사 (DS 26-x) ══════════ */

/** 가짜 창·문서 — 잠금이 **정말** 뒤 화면을 막고, 풀 때 원래대로 되돌리는지 돌려 본다. */
function fakeWindow({ scrollY = 0, innerWidth = 1280, clientWidth = 1265, overflow = '', paddingRight = '' } = {}) {
  const scrolls = [];
  const body = { style: { overflow, paddingRight } };
  const win = {
    scrollY,
    innerWidth,
    scrollTo: (x, y) => scrolls.push([x, y]),
  };
  const doc = { body, documentElement: { clientWidth } };
  return { win, doc, body, scrolls };
}

/**
 * DS 26-1 — 서랍·대화상자가 열려 있는 동안 **뒤 화면이 함께 스크롤되지 않는가**.
 *
 * 고객사 사이트(`embed.js` 의 `lockHost`)와 전체화면 상담창에는 이 잠금이 있었는데 운영자 화면에는
 * 없었다 — 흐린 배경 위에서 휠을 굴리면 뒤의 표가 흘러가고, 닫으면 눌렀던 행은 화면 밖이다.
 * 「정말 잠그고, 정말 되돌리는가」는 소스를 읽어서는 알 수 없다 — 돌려 봐야 안다.
 */
test('덮개가 열린 동안 뒤 화면을 잠그고, 닫으면 그대로 되돌린다 (DS 26-1)', opts, async () => {
  const { lockPageScroll } = await loadFns(['lockPageScroll']);

  // 1) 잠그면 뒤 화면이 움직이지 않는다 + 사라진 스크롤바 폭(15px)만큼 메워 화면이 덜컥거리지 않는다.
  const a = fakeWindow({ scrollY: 940 });
  const unlock = lockPageScroll(a.win, a.doc);
  assert.equal(a.body.style.overflow, 'hidden', '뒤 화면이 그대로 스크롤된다');
  assert.equal(a.body.style.paddingRight, '15px', '스크롤바가 사라진 만큼 메우지 않아 표가 다시 배치된다');

  // 2) 풀면 원래 인라인 스타일과 **읽던 자리**로 돌아간다.
  unlock();
  assert.equal(a.body.style.overflow, '', '원래 스타일을 되돌리지 않는다');
  assert.equal(a.body.style.paddingRight, '', '메워 둔 폭이 남았다');
  assert.deepEqual(a.scrolls, [[0, 940]], '읽던 자리로 되돌리지 않는다');

  // 3) 호스트·화면이 이미 자기 스타일을 쓰고 있으면 그 값을 지킨다(지우면 안 된다).
  const b = fakeWindow({ overflow: 'auto', paddingRight: '8px' });
  lockPageScroll(b.win, b.doc)();
  assert.equal(b.body.style.overflow, 'auto', '남의 overflow 를 지웠다');
  assert.equal(b.body.style.paddingRight, '8px', '남의 여백을 지웠다');

  // 4) 덮개가 겹쳐 열려도(서랍 위의 확인 대화상자) 나중에 열린 것부터 풀리므로 값이 어긋나지 않는다.
  const c = fakeWindow({ scrollY: 120 });
  const un1 = lockPageScroll(c.win, c.doc);
  const un2 = lockPageScroll(c.win, c.doc);
  assert.equal(c.body.style.paddingRight, '15px', '두 번 잠그면 여백이 두 배가 된다');
  un2();
  assert.equal(c.body.style.overflow, 'hidden', '안쪽 덮개를 닫자 아직 열린 서랍의 잠금이 풀렸다');
  un1();
  assert.equal(c.body.style.overflow, '', '마지막 덮개를 닫아도 잠금이 남았다');

  // 5) 스크롤바가 자리를 차지하지 않는 환경(모바일·겹치는 스크롤바)에서는 메우지 않는다.
  const d = fakeWindow({ innerWidth: 390, clientWidth: 390 });
  lockPageScroll(d.win, d.doc);
  assert.equal(d.body.style.paddingRight, '', '스크롤바가 없는데 오른쪽을 메웠다');
  // 폭을 잴 수 없는 환경에서도 숫자가 새어 나오지 않는다.
  const e = fakeWindow({ innerWidth: NaN, clientWidth: NaN });
  lockPageScroll(e.win, e.doc);
  assert.equal(e.body.style.paddingRight, '', '잴 수 없는 폭이 NaNpx 로 들어갔다');
});

/**
 * DS 26-1 — 잠금이 **덮개 4곳 전부**에 붙어 있고, 덮개 자신은 스크롤될 수 있는가.
 * 뒤 화면을 잠그면 화면보다 긴 확인 대화상자의 「취소」·「삭제」에 닿을 길이 사라진다.
 */
test('서랍 3곳·확인 대화상자가 모두 뒤 화면을 잠근다 (DS 26-1)', opts, () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');

  // 잠금의 수명은 덮개의 수명과 같아야 한다 — 열림 상태를 따로 세지 않고 덮개 안에서 건다.
  for (const fn of ['ConfirmDialog', 'ConversationDrawer', 'TicketDrawer', 'AccountDrawer']) {
    const i = src.indexOf(`function ${fn}(`);
    assert.ok(i >= 0, `${fn} 을 찾지 못했다`);
    // 닫는 중괄호는 1열 + 빈 줄 — `}) {`(인자 타입의 끝)에 걸리지 않게 줄바꿈까지 본다.
    const body = src.slice(i, src.indexOf('\n}\n', i));
    assert.match(body, /useScrollLock\(\);/, `${fn} 이 뒤 화면을 잠그지 않는다`);
  }
  assert.equal((src.match(/useScrollLock\(\);/g) || []).length, 4, '덮개 4곳만 잠가야 한다');
  assert.match(src, /return lockPageScroll\(window, document\);/, '잠금 구현이 한 곳이 아니다');

  // 서랍 본문 끝에서 스크롤이 뒤 화면으로 넘어가지 않는다.
  assert.match(css, /\.ac-drawer-body\{[^}]*overscroll-behavior-y:contain/, '서랍 끝에서 스크롤이 뒤로 넘어간다');
  // 확인 대화상자는 화면보다 길 때 덮개 자신이 스크롤된다 — 가운데 정렬로 윗부분을 잘라먹지 않는다.
  assert.match(css, /\.ac-modal-root\{[^}]*overflow-y:auto\}/, '화면보다 긴 대화상자에 닿을 길이 없다');
  assert.match(css, /\.ac-modal-root\{[^}]*align-items:flex-start/, '가운데 정렬은 넘칠 때 윗부분을 자른다');
  assert.match(css, /\.ac-modal\{position:relative;margin:auto/, '여유가 있을 때는 가운데 있어야 한다');
  // 덮개가 스크롤되면 absolute 배경은 함께 밀려 올라간다.
  assert.match(css, /\.ac-modal-bg\{position:fixed;inset:0/, '배경이 함께 스크롤돼 흰 바닥이 드러난다');
});

/**
 * DS 26-2 — 세로로 넘치는 상자를 **키보드로 스크롤할 수 있는가**.
 *
 * 서랍 본문·미리보기 대화는 말풍선뿐이라 Tab 이 닿지 않고, 화살표 키는 초점이 있는 곳 기준으로
 * 뒤 화면을 굴린다 — 뒤 화면을 잠그면(DS 26-1) 그 길까지 사라진다. DS 9-1 이 가로 넘침에 세운
 * 규칙과 같다: 넘치는 상자는 초점을 받고, 넘치지 않으면 Tab 순서에 끼지 않는다.
 */
test('세로로 넘치는 상자는 초점을 받아 키보드로 스크롤된다 (DS 26-2)', opts, async () => {
  const { overflowsY, scrollFocusProps } = await loadFns(['overflowsY', 'scrollFocusProps']);

  // 넘치는지는 재서 정한다 — 경계에서 흔들리지 않아야 한다(1px 반올림 오차는 넘침이 아니다).
  assert.equal(overflowsY({ scrollHeight: 400, clientHeight: 400 }), false, '딱 맞는 상자에 Tab 이 멈춘다');
  assert.equal(overflowsY({ scrollHeight: 401, clientHeight: 400 }), false, '1px 오차를 넘침으로 본다');
  assert.equal(overflowsY({ scrollHeight: 402, clientHeight: 400 }), true, '넘치는데 초점을 주지 않는다');
  assert.equal(overflowsY({ scrollHeight: 1200, clientHeight: 300 }), true);

  // 이름이 이미 있는 상자(role="log")는 역할을 덮지 않는다 — 덮으면 「읽어 주는 영역」이 아니게 된다.
  assert.deepEqual(scrollFocusProps(false), {}, '넘치지 않는 상자가 Tab 순서에 낀다');
  assert.deepEqual(scrollFocusProps(true), { tabIndex: 0 }, '넘치는데 초점을 받지 못한다');
  const labelled = scrollFocusProps(true, '요청 내용');
  assert.equal(labelled.tabIndex, 0);
  assert.equal(labelled.role, 'region', '이름 없는 상자는 무엇인지 알려야 한다');
  assert.match(labelled['aria-label'], /요청 내용/, '초점이 갔을 때 무엇을 스크롤하는지 들리지 않는다');
  assert.match(labelled['aria-label'], /세로로 스크롤할 수 있습니다/, '쓰는 법을 알려주지 않는다');

  // 네 상자가 모두 같은 문을 지난다(서랍 3곳 + 미리보기 대화).
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  assert.equal((src.match(/useScrollableY<HTMLDivElement>\(/g) || []).length, 4, '넘치는 상자 하나가 빠졌다');
  assert.equal((src.match(/scrollFocusProps\(/g) || []).length, 5, '초점 속성을 손으로 적은 자리가 있다');
  for (const re of [
    /className="ac-drawer-body" role="log" aria-label="대화 내용" \{\.\.\.scrollFocusProps\(bodyScrolls\)\}/,
    /className="ac-drawer-body" \{\.\.\.scrollFocusProps\(bodyScrolls, '요청 내용'\)\}/,
    /className="ac-drawer-body" \{\.\.\.scrollFocusProps\(bodyScrolls, '계약 정보와 귀속 이력'\)\}/,
    /className="ac-preview-body"[^>]*\{\.\.\.scrollFocusProps\(previewScrolls\)\}/,
  ]) assert.match(src, re, `초점이 닿지 않는 스크롤 상자가 남았다: ${re}`);

  // 초점 표시는 상자 안쪽에 그린다 — 바깥에 그리면 서랍·카드 테두리에 잘린다.
  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  assert.match(css, /\.ac-drawer-body:focus-visible\{outline:2px solid var\(--brand\);outline-offset:-2px\}/);
  assert.match(css, /\.ac-preview-body:focus-visible\{outline:2px solid var\(--brand\);outline-offset:-2px\}/);

  // 재기 전에는 붙이지 않는다 — 넘치지 않는 상자에 Tab 이 멈추면 그 자체가 방해다.
  const hook = src.slice(src.indexOf('function useScrollableY<'));
  assert.match(hook.slice(0, hook.indexOf('\n}')), /useState\(false\)/, '재기 전에 초점을 붙인다');
  // 내용이 늘어나면(말풍선 추가) 다시 재야 한다 — 한 번만 재면 초점이 끝내 붙지 않는다.
  assert.match(hook.slice(0, hook.indexOf('\n}')), /\}, \[signal\]\);/, '내용이 늘어도 다시 재지 않는다');
});

/**
 * DS 26-3 — 스티키 편집 폼이 화면보다 길면 **아래쪽에 닿을 길이 없다**.
 * 윗변이 top 에 붙은 채 함께 내려오므로 「저장」·「삭제」가 화면 밖에 영원히 남는다
 * (규칙 빌더·고객사 폼은 입력이 6~8개다. 「큰 글씨」를 켜면 더 쉽게 넘는다).
 */
test('스티키 편집 폼은 화면에 들어갈 만큼만 차지한다 (DS 26-3)', opts, () => {
  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');

  // 높이를 가두고 넘치는 만큼은 상자 안에서 스크롤한다 — 뷰포트 단위는 배율로 먼저 나눈다(DS 25-1).
  assert.match(css, /\.ac-sticky\{position:sticky;top:84px;max-height:calc\(100vh \/ var\(--vz\) - 104px\);overflow-y:auto;overscroll-behavior-y:contain\}/, '스티키 폼의 아래쪽에 닿을 길이 없다');
  // 미리보기 카드는 자기 안에 스크롤 영역이 있다 — 카드째로 스크롤하면 브랜드 헤더가 밀려 올라간다.
  assert.match(css, /\.ac-sticky\.ac-preview\{overflow:hidden\}/, '미리보기 카드가 헤더까지 스크롤된다');
  assert.match(css, /\.ac-preview-body\{height:clamp\(160px,calc\(100vh \/ var\(--vz\) - 230px\),420px\)/, '낮은 화면에서 미리보기 아래가 잘린다');

  // 한 단으로 접히면 스티키가 아니다 — 가둔 채로 두면 폼 안에 또 하나의 스크롤이 생긴다.
  const mobile = css.slice(css.indexOf('@media (max-width:900px){\n  .ac-shell'), css.indexOf('@media (forced-colors: active){'));
  assert.match(mobile, /\.ac-sticky\{position:static;max-height:none;overflow:visible\}/, '좁은 화면에서 폼 안에 스크롤이 생긴다');

  // 인쇄에서는 편집 폼을 덜어낸다(DS 25-3) — 종이에서 누를 수 없다.
  const pr = css.slice(css.indexOf('@media print{'));
  assert.ok(pr.includes('.ac-sticky'), '인쇄에서 편집 폼을 덜어내지 않는다');
});

/* ══════════ 디자인 스프린트 — 24차 재감사 (DS 27-x) ══════════ */

/**
 * DS 27-2 — 「아직 저장하지 않은 내용」을 **값으로** 가리는가.
 *
 * 이 판정 하나가 두 관문을 먹인다(덮어쓰기 확인·떠날 때 경고). 너무 둔하면 적은 글이 사라지고,
 * 너무 예민하면 칸을 눌렀다 지운 것만으로도 확인이 떠서 정작 삭제 확인(DS 5-4)까지 무뎌진다.
 * 「정말 그렇게 가리는가」는 소스를 읽어서는 알 수 없다 — 돌려 봐야 안다.
 */
test('적던 내용이 있는지 값으로 가린다 (DS 27-2)', opts, async () => {
  const { formDirty } = await loadFns(['formDirty']);
  const base = { id: '', category: '', question: '', keywords: '', answer: '' };

  assert.equal(formDirty({ ...base }, base), false, '아무것도 적지 않았는데 확인이 뜬다');
  assert.equal(formDirty({ ...base, answer: '평일 09~18시입니다.' }, base), true, '적은 글을 말없이 버린다');
  // 눌렀다 지운 칸(공백만 남은 칸)은 적은 것이 아니다.
  assert.equal(formDirty({ ...base, question: '   ' }, base), false, '공백만의 차이에 확인이 뜬다');
  assert.equal(formDirty({ ...base, question: ' 요금 ' }, { ...base, question: '요금' }), false, '앞뒤 공백만 다른데 다르다고 본다');
  // 수정 중이던 값을 한 글자 고친 것도 「적던 내용」이다.
  assert.equal(formDirty({ ...base, id: 'kb_1', answer: '평일 09~18시' }, { ...base, id: 'kb_1', answer: '평일 09~18시.' }), true);

  // 체크박스는 다듬을 공백이 없다 — 그대로 견준다(규칙 빌더의 「상담원 접수」).
  assert.equal(formDirty({ label: '', escalate: false }, { label: '', escalate: true }), true, '체크를 바꾼 것을 놓친다');
  assert.equal(formDirty({ label: '', escalate: false }, { label: '', escalate: false }), false);
  // 한쪽에만 있는 칸도 본다(폼에 칸이 늘어난 뒤에도 판정이 새지 않게).
  assert.equal(formDirty({ a: '', b: 'x' }, { a: '' }), true);
  assert.equal(formDirty({ a: '' }, { a: '', b: 'x' }), true);
});

/**
 * DS 27-2 — 적던 내용을 버리는 길 전부가 **묻는 문**을 지나는가.
 *
 * 지금까지 확인을 거치는 것은 삭제·초기화뿐이었다. 20분 걸려 쓴 답변이 사라지는 더 흔한 길은
 * 표에서 **다른 행의 「수정」을 한 번 누르는 것**이고, 그 다음은 **새로고침**이었다.
 */
test('적던 내용을 덮어쓰거나 들고 떠날 때 먼저 묻는다 (DS 27-2)', opts, () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');

  // 1) 폼을 통째로 갈아 끼우는 자리 6곳이 전부 확인을 지난다
  //    (안내 자료·「이 질문으로 자료 만들기」(DS 32-2)·규칙·고객사·파트너·「파트너 추가」).
  assert.equal((src.match(/confirmDiscard\(formDirty\(/g) || []).length, 6, '덮어쓰기 자리 하나가 확인을 지나지 않는다');
  // 확인을 **기다려야** 하므로 전부 async 다 — 동기 함수면 물어보는 사이에 폼이 이미 갈린다.
  for (const decl of ['const editKB = async', 'const draftKbFromQuestion = async', 'const editPartner = async', 'const editAccount = async', 'const onEdit = async']) {
    assert.ok(src.includes(decl), `확인을 기다리지 않는다: ${decl}`);
  }
  // 적은 것이 없으면 묻지 않는다 — 뜻 없는 확인이 잦으면 삭제 확인까지 읽지 않고 누른다.
  const fn = src.slice(src.indexOf('const confirmDiscard = useCallback'));
  assert.match(fn.slice(0, fn.indexOf('}, [askConfirm]);')), /if \(!dirty\) return true;/, '적은 것이 없어도 묻는다');

  // 2) 기준선을 옮기지 않고 폼을 채우는 자리가 없어야 한다 — 남으면 비운 폼이 「적던 내용」으로 보인다.
  for (const bad of ['setForm(EMPTY_FORM)', 'setCrForm(EMPTY_CR_FORM)', 'setAForm(EMPTY_ACCOUNT_FORM)', 'setPForm(EMPTY_PARTNER_FORM)', 'setImp(EMPTY_IMPORT)']) {
    assert.equal(src.includes(bad), false, `기준선을 옮기지 않고 폼을 비운다: ${bad}`);
  }
  // 기준선을 옮기는 문은 `load*Form` 다섯 개뿐이다(손으로 옮기는 자리가 생기면 곧 어긋난다).
  assert.equal((src.match(/formBase\.current\.\w+ = /g) || []).length, 5, '기준선을 손으로 옮기는 자리가 있다');

  // 3) 떠날 때 — 적은 것이 있을 때만 걸고, 폼 5곳 전부가 판정에 들어간다.
  assert.match(src, /if \(!anyFormDirty\) return;/, '아무것도 쓰지 않은 사람에게도 경고가 뜬다');
  assert.match(src, /addEventListener\('beforeunload', onLeave\)/, '새로고침·창 닫기에 적던 내용이 말없이 사라진다');
  assert.match(src, /removeEventListener\('beforeunload', onLeave\)/, '경고가 치워지지 않고 남는다');
  const decl = src.slice(src.indexOf('const anyFormDirty ='));
  const judge = decl.slice(0, decl.indexOf(';'));
  for (const f of [
    'form, formBase.current.kb', 'imp, formBase.current.imp', 'crForm, formBase.current.rule',
    'aForm, formBase.current.account', 'pForm, formBase.current.partner',
  ]) {
    assert.ok(judge.includes(f), `떠날 때 판정에서 빠진 폼: ${f}`);
  }
  // 콘솔 안의 탭 전환은 같은 문서다 — 폼이 그대로 있으므로 묻지 않는다(DS 6-3).
  const goTab = src.slice(src.indexOf('const goTab = useCallback'));
  assert.equal(/beforeunload|confirmDiscard/.test(goTab.slice(0, goTab.indexOf('}, [setTab]);'))), false, '탭을 옮길 때마다 경고가 뜬다');
});

/**
 * DS 27-3 — 지운 자료를 가리키던 편집 폼을 거두는가.
 *
 * 거두지 않으면 「수정 저장」이 **지운 자료를 다시 만들고**(서버는 없는 식별자를 새로 만든다)
 * 화면은 「수정되었습니다」라고 말한다 — 변경 이력에는 「생성」으로 남아 둘이 어긋난다.
 */
test('지운 자료를 가리키던 편집 폼을 거둔다 (DS 27-3)', opts, () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const body = (name) => {
    const i = src.indexOf(`const ${name} = async`);
    assert.ok(i >= 0, `${name} 을 찾지 못했다`);
    return src.slice(i, src.indexOf('\n  };', i));
  };

  // 거두는 문에는 그 사이 바뀜을 들고 있던 값도 함께 따라간다(DS 46-1) — 검사의 뜻은 그대로다.
  assert.match(
    body('removeKB'),
    /if \(editingId === id\) \{ setEditingId\(null\);[^}]*loadKbForm\(EMPTY_FORM\); setKbErr\(\{\}\); \}/,
    '지운 자료를 가리킨 폼이 남아 「수정 저장」이 그 자료를 되살린다',
  );
  // 규칙 쪽은 처음부터 거두고 있었다 — 두 탭이 갈라지면 같은 일을 다르게 하는 콘솔이 된다.
  assert.match(body('removeCustomRule'), /if \(crEditing === intent\) \{/, '규칙 쪽 거두기가 사라졌다');
  // 초기화는 **수정 중일 때만** 거둔다 — 새로 적던 글은 지워진 것과 아무 상관이 없다.
  assert.match(body('resetAll'), /if \(editingId\) \{ setEditingId\(null\);[^}]*loadKbForm\(EMPTY_FORM\); setKbErr\(\{\}\); \}/, '초기화가 적던 새 자료까지 버린다');
});

/* ══════════ 29순위 — 백로그 소진 후 26차 재감사 (DS 29-x) ══════════ */

/**
 * 모듈 안에만 있는 최상위 함수를 컴파일된 JS 에서 떼어내 실제로 돌린다(DS 27-2 와 같은 방식).
 * @param names 떼어낼 함수 이름
 * @param consts 그 함수가 쓰는 최상위 `const` 한 줄 선언(정규식 표 등 · DS 62-1)
 */
async function loadConsoleFns(names, consts = []) {
  await loadConsole();
  const head = consts.map((n) => {
    const i = cachedJs.indexOf(`const ${n} = `);
    assert.ok(i >= 0, `${n} 선언을 찾지 못했다`);
    const end = cachedJs.indexOf('\n', i);
    return cachedJs.slice(i, end);
  });
  const parts = names.map((n) => {
    const i = cachedJs.indexOf(`function ${n}(`);
    assert.ok(i >= 0, `${n} 선언을 찾지 못했다`);
    const end = cachedJs.indexOf('\n}', i);
    assert.ok(end > i, `${n} 의 끝을 찾지 못했다`);
    return cachedJs.slice(i, end + 2);
  });
  return new Function(`${[...head, ...parts].join('\n')}\nreturn { ${names.join(', ')} };`)();
}

/**
 * DS 29-1 — 「첫 오류 칸」 판정을 실제로 돌린다.
 * 소스 검사는 「그 문을 지나는가」만 보고, 어느 칸으로 데려가는지는 이 판정이 정한다.
 */
test('거절한 칸 중 화면에서 가장 먼저 나오는 칸을 고른다 (DS 29-1)', opts, async () => {
  const { firstErrorId } = await loadConsoleFns(['firstErrorId']);
  const order = [['question', 'kb-question'], ['keywords', 'kb-keywords'], ['answer', 'kb-answer']];

  assert.equal(firstErrorId({}, order), null, '틀린 칸이 없으면 초점을 옮기지 않는다');
  assert.equal(firstErrorId({ answer: '답변을 입력해 주세요.' }, order), 'kb-answer');
  // 아래쪽 칸으로 데려가면 위에 남은 오류를 지나친다 — 반드시 화면 순서의 첫 칸이다.
  assert.equal(firstErrorId({ answer: 'x', question: 'y' }, order), 'kb-question');
  assert.equal(firstErrorId({ keywords: 'x', answer: 'y' }, order), 'kb-keywords');
  // 지워진 오류(undefined)·목록에 없는 키는 고르지 않는다.
  assert.equal(firstErrorId({ question: undefined, answer: 'y' }, order), 'kb-answer');
  assert.equal(firstErrorId({ category: '틀림' }, order), null, '화면 순서에 없는 칸으로 데려가면 안 된다');
  assert.equal(firstErrorId({ question: '' }, order), null, '빈 문구는 오류가 아니다');
});

test('콘솔의 조사 판정이 lib 사본과 같은 답을 낸다 (DS 29-3)', opts, async () => {
  // `josa` 는 제 판정을 하지 않고 `particle` 을 지난다(DS 61-1) — 함께 떼어내야 돈다.
  const { josa } = await loadConsoleFns(['batchimOf', 'particle', 'josa']);
  for (const [word, withB, withoutB, want] of [
    ['감사 로그', '을', '를', '감사 로그를'],
    ['대화 기록', '을', '를', '대화 기록을'],
    ['백업', '을', '를', '백업을'],
    ['CSV', '을', '를', 'CSV를'],
    ['', '을', '를', '를'],
  ]) {
    assert.equal(josa(word, withB, withoutB), want, `${word} 의 조사가 틀렸다`);
  }
});

/**
 * DS 29-2 — 첫 화면에는 알림이 없다. 머무는 실패 알림을 만들었으므로, 아무 일도 하지 않은
 * 사람에게 떠 있지 않다는 것(그리고 `role="alert"` 가 빈 채로 읽히지 않는다는 것)을 못 박는다.
 */
test('첫 화면에 알림이 떠 있지 않다 (DS 29-2)', opts, async () => {
  const html = await render();
  assert.equal(/class="ac-toast/.test(html), false, '아무 일도 하지 않았는데 알림이 떠 있다');
  assert.equal(/role="alert"/.test(html), false, '첫 화면에 실패 알림이 있다');
  assert.equal(/알림 닫기/.test(html), false, '치울 알림이 없는데 닫기 버튼이 초점 순서에 있다');
});

/**
 * ── DS 31-1·31-2 — 행이 많아진 뒤의 표 ──
 * 콘솔의 데이터 표는 거른 행을 전부 등록순으로 그렸다. 기준 원본(admin.html)이 이미 넣어 둔
 * 두 가지(헤더 정렬·페이저)를 이식했는지, 그리고 그 둘이 키보드·스크린리더·종이에서도 서는지를
 * 못 박는다. 아래 둘은 화면 쪽(머리칸·페이저), 그 다음은 판정 자체를 실제로 돌린다.
 */
test('데이터 표의 머리칸이 정렬되는 머리칸이다 — 방향은 색이 아니라 글자로 말한다 (DS 31-1)', opts, () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');

  // ① 머리칸 한 곳(SortTh)만 쓴다 — 표마다 따로 적으면 aria-sort 가 또 빠진다(DS 6-2 와 같은 종류).
  const comp = src.slice(src.indexOf('function SortTh('), src.indexOf('function Pager('));
  assert.match(comp, /scope="col"/, '어느 열인지 읽히려면 scope 가 필요하다');
  assert.match(comp, /aria-sort=\{active \? \(sort\?\.dir === 'asc' \? 'ascending' : 'descending'\) : 'none'\}/, '정렬 상태를 스크린리더에 알린다');
  assert.match(comp, /<button\n?\s*type="button"/, '머리칸은 눌리는 것이므로 button 이어야 한다(Enter·Space 가 그냥 된다)');
  assert.match(comp, /title=\{`\$\{label\} 기준으로 정렬`\}/, '무엇을 하는 머리칸인지 알려준다');
  assert.equal(/\{label\}<span/.test(comp), false, '머리칸 이름에 설명을 덧붙이면 셀마다 그 문장이 따라 읽힌다');

  // ② 데이터 표 8장 전부가 정렬되는 머리칸을 가진다.
  //    제외: 설치 「선택 옵션」 표는 고정 안내다. 「고객사별 현황」(DS 36-1)은 행이 등록된 고객사
  //    수만큼(현재 둘)이고 서버가 이미 대화 많은 곳부터 내려보낸다 — DS 31-1 이 고친 문제
  //    (「행이 많아지면 원하는 값을 찾기 어렵다」)가 생기지 않는 표다.
  const lines = src.split('\n');
  const skip = new Set(['설치 선택 옵션', '고객사별 현황']);
  let checked = 0;
  lines.forEach((ln, i) => {
    if (!ln.includes('<table className="ac-table">')) return;
    let j = i - 1;
    while (j >= 0 && lines[j].trim() === '') j -= 1;
    const label = (lines[j].match(/<ScrollX label="([^"]+)">/) || [])[1];
    if (skip.has(label)) return;
    const head = lines.slice(i, i + 14).join('\n');
    assert.match(head, /<SortTh label="/, `${label} 표의 머리칸에 정렬이 없다`);
    checked += 1;
  });
  assert.equal(checked, 8, `정렬되는 표가 ${checked}장이다 — 데이터 표 8장 전부여야 한다`);

  // ③ 방향 표시는 글리프(↕ ↑ ↓)다 — 색만으로 말하면 색을 구분하지 못하는 사람에게는 표시가 없다.
  assert.match(css, /\.ac-sortbtn::after\{content:'↕'/, '정렬 가능 표시');
  assert.match(css, /\.ac-th-sort\[aria-sort="ascending"\] \.ac-sortbtn::after\{content:'↑'/, '오름차순 표시');
  assert.match(css, /\.ac-th-sort\[aria-sort="descending"\] \.ac-sortbtn::after\{content:'↓'/, '내림차순 표시');
  assert.match(css, /\.ac-sortbtn:focus-visible\{outline:2px solid var\(--brand\)/, '키보드 초점 표시');
  assert.match(css, /\.ac-sortbtn\{[^}]*width:100%/, '머리칸 전체가 누르는 영역이어야 손가락이 빗나가지 않는다');
});

test('표가 길어지면 장을 나누고 「몇 건 중 어디인가」를 말한다 (DS 31-2)', opts, () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  const comp = src.slice(src.indexOf('function Pager('), src.indexOf('가로로 넘칠 수 있는 영역'));

  // 한 장에 들어가면 조작을 보이지 않는다.
  assert.match(comp, /if \(info\.pages <= 1\) return null;/, '장이 하나면 페이저를 그리지 않는다');
  // 총 건수·보고 있는 범위·장 번호를 모두 말한다(「n건」만 말하면 어디까지 보여 주는지 알 수 없다).
  // 끊어 적는 자는 한 벌이다 — 종전에는 총계만 `toLocaleString` 이라 한 문장 안에서 갈렸다(DS 60-3).
  assert.match(comp, /총 \{comma\(info\.total\)\}\{unit\} 중 \{comma\(info\.from\)\}–\{comma\(info\.to\)\}번째 · \{comma\(info\.page\)\}\/\{comma\(info\.pages\)\} 페이지/, '페이저 문구');
  assert.match(comp, /role="status" aria-live="polite"/, '장을 넘기면 바뀐 범위를 읽어 준다');
  assert.match(comp, /<nav className="ac-pager" aria-label=\{`\$\{label\} 페이지 이동`\}/, '페이저에 이름이 있어야 어느 표의 것인지 안다');
  // 끝에서 `disabled` 를 쓰지 않는다(DS 8-1) — 누른 버튼이 비활성이 되면 초점이 본문 밖으로 떨어진다.
  assert.equal(/\sdisabled/.test(comp.replace(/aria-disabled/g, '')), false, 'disabled 속성을 쓰면 안 된다');
  assert.match(comp, /busyBtn\(false, first, btn\)[\s\S]*busyBtn\(false, last, btn\)/, '끝은 aria-disabled 로 알린다');
  assert.match(comp, /if \(!first\) onPage\(info\.page - 1\)/, '끝에서는 눌려도 아무 일이 없어야 한다');

  // 길어지는 표 6장에 페이저가 붙어 있다(파트너·정산 합계는 행 수가 계약 수로 묶여 있어 정렬만).
  for (const label of ['안내 자료', '상담원 요청', '고객사', '고객사별 산출 근거', '테넌트 FAQ', '관리 작업 기록']) {
    assert.match(src, new RegExp(`<Pager info=\\{\\w+\\} label="${label}"`), `페이저 누락: ${label}`);
  }
  assert.equal((src.match(/<Pager info=/g) || []).length, 6, '페이저 수');
  assert.match(src, /const TABLE_PAGE_ROWS = 15;/, '한 장의 행 수는 기준 원본과 같은 15행');

  // 거르면 장 수가 줄어든다 — 조건이 바뀌면 1장으로 돌아가야 빈 표를 「결과 없음」으로 읽지 않는다.
  const view = src.slice(src.indexOf('const tableView = '), src.indexOf('const sortedRows = '));
  assert.match(view, /saved && saved\.sig === sig \? saved\.page : 1/, '조건(sig)이 바뀌면 첫 장으로');
  const toggle = src.slice(src.indexOf('const toggleSort = '), src.indexOf('const tableView = '));
  assert.match(toggle, /setTablePage\(\(m\) => \(m\[id\] \? \{ \.\.\.m, \[id\]: \{ \.\.\.m\[id\], page: 1 \} \} : m\)\)/, '정렬이 바뀌면 첫 장으로');

  // 종이: 넘길 수 없는 버튼은 덜어내되 「몇 건 중 어디까지」는 남긴다.
  const pr = css.slice(css.indexOf('@media print{'));
  assert.match(pr, /\.ac-pager button\{display:none\}/, '종이에 페이지 버튼을 찍지 않는다');
  assert.equal(/\.ac-pager\{display:none\}/.test(pr), false, '건수 줄까지 지우면 한 장만 찍힌 표를 전체로 읽는다');
});

test('표 정렬·페이지 판정을 실제로 돌린다 (DS 31-1·31-2)', opts, async () => {
  const { compareCell, sortRows, pageSlice } = await loadConsoleFns(['compareCell', 'sortRows', 'pageSlice']);

  // ① 숫자는 숫자로 — 글자로 비교하면 「10」이 「2」보다 앞에 선다.
  assert.ok(compareCell(2, 10, 'asc') < 0, '숫자 오름차순');
  assert.ok(compareCell(2, 10, 'desc') > 0, '숫자 내림차순');
  assert.ok(compareCell('2건', '10건', 'asc') < 0, '숫자가 섞인 글자도 자리수대로');
  assert.ok(compareCell('가나', '다라', 'asc') < 0, '한국어 사전 순');
  // 빈 값은 방향과 무관하게 뒤 — 오름차순 첫 장이 「—」로 가득 차면 정렬한 뜻이 없다.
  for (const dir of ['asc', 'desc']) {
    assert.ok(compareCell(null, 1000, dir) > 0, `빈 값(null)은 뒤: ${dir}`);
    assert.ok(compareCell('', '가', dir) > 0, `빈 값(빈 문자열)은 뒤: ${dir}`);
    assert.ok(compareCell(undefined, 0, dir) > 0, `빈 값(undefined)은 뒤: ${dir}`);
  }
  assert.equal(compareCell(null, '', 'asc'), 0, '둘 다 비었으면 순서를 바꾸지 않는다');

  // ② 고른 열이 없으면 원래 순서 그대로 — 기본 순서가 뜻을 가진 표가 있다(접수는 최신순).
  const rows = [{ n: '다', v: 3 }, { n: '가', v: 1 }, { n: '나', v: null }, { n: '라', v: 1 }];
  const cols = { n: (r) => r.n, v: (r) => r.v };
  assert.equal(sortRows(rows, undefined, cols), rows, '정렬 전에는 받은 배열을 그대로 돌려준다');
  assert.deepEqual(sortRows(rows, { col: '없는열', dir: 'asc' }, cols).map((r) => r.n), ['다', '가', '나', '라'], '모르는 열은 순서를 바꾸지 않는다');

  // 정렬은 사본에만 한다(원본이 흔들리면 다른 화면의 셈이 어긋난다).
  assert.deepEqual(sortRows(rows, { col: 'n', dir: 'asc' }, cols).map((r) => r.n), ['가', '나', '다', '라']);
  assert.deepEqual(rows.map((r) => r.n), ['다', '가', '나', '라'], '원본을 건드리면 안 된다');
  assert.deepEqual(sortRows(rows, { col: 'n', dir: 'desc' }, cols).map((r) => r.n), ['라', '다', '나', '가']);
  // 빈 값은 끝으로, 같은 값은 원래 순서(안정 정렬)
  assert.deepEqual(sortRows(rows, { col: 'v', dir: 'asc' }, cols).map((r) => r.n), ['가', '라', '다', '나'], '같은 값은 원래 순서를 지키고 빈 값은 맨 뒤');

  // ③ 한 장 잘라내기 — 「몇 건 중 몇 번째」가 틀리면 페이저가 거짓말을 한다.
  const many = Array.from({ length: 23 }, (_, i) => i + 1);
  const p1 = pageSlice(many, 1, 10);
  assert.deepEqual([p1.page, p1.pages, p1.total, p1.from, p1.to], [1, 3, 23, 1, 10]);
  assert.deepEqual(p1.rows, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const p3 = pageSlice(many, 3, 10);
  assert.deepEqual([p3.page, p3.from, p3.to, p3.rows.length], [3, 21, 23, 3], '마지막 장은 남은 만큼만');
  // 거르고 나니 장이 줄었다 — 빈 장을 보여 주면 「조건에 맞는 것이 없다」와 구분되지 않는다.
  assert.equal(pageSlice(many, 9, 10).page, 3, '범위를 넘은 장은 마지막 장으로 끌어온다');
  assert.equal(pageSlice(many, 0, 10).page, 1, '0장·음수는 첫 장');
  const empty = pageSlice([], 2, 10);
  assert.deepEqual([empty.page, empty.pages, empty.total, empty.from, empty.to, empty.rows.length], [1, 1, 0, 0, 0, 0], '0건이면 「0번째」라고 말하지 않는다');
  assert.equal(pageSlice(many, 1, 50).pages, 1, '한 장에 다 들어가면 장이 하나(페이저를 그리지 않는다)');
});

/**
 * ── DS 31-3 — 보여 준 수는 찾은 수가 아니다 ──
 * 전역 검색은 종류별로 3건만 집어 오면서 「검색 결과 3건」이라고 말했다. 자료 300건에서
 * 「환불」을 찾은 운영자는 세 건을 보고 「이것뿐」이라 읽고, 나머지로 가는 길도 없었다.
 */
test('전역 검색이 보여 준 수가 아니라 찾은 수를 말하고 전체로 가는 길을 둔다 (DS 31-3)', opts, () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const index = src.slice(src.indexOf('const searchAll = '), src.indexOf('const currentLabel ='));

  // 색인은 종류별로 **찾은 건수**를 함께 돌려준다.
  assert.match(index, /const searchAll = \(term: string, raw: string\): SearchResult =>/, '찾은 건수를 담아 돌려준다');
  assert.match(index, /found\[kind\] = list\.length;/, '자르기 전의 건수를 센다');
  assert.match(index, /hits\.push\(\.\.\.list\.slice\(0, SEARCH_PER_KIND\)\)/, '보여 주는 것은 종류별 상위 몇 건');
  assert.match(index, /if \(all && list\.length > SEARCH_PER_KIND\)/, '넘칠 때만 「모두 보기」를 붙인다');
  assert.match(index, /title: `\$\{kind\} \$\{list\.length\}건 모두 보기`/, '「모두 보기」에 실제 건수를 적는다');
  assert.equal(/SEARCH_MAX/.test(src), false, '전체 상한으로 또 자르면 뒤쪽 종류가 말없이 사라진다');

  // 「모두 보기」는 그 탭의 같은 검색어로 데려간다 — 길이 없으면 건수만 알려 주고 끝이다.
  assert.match(index, /const word = raw\.trim\(\);/, '정규화한 말이 아니라 사람이 친 말로 데려간다');
  for (const setter of ['setEscQuery(word)', 'setKbQuery(word)', 'setRuleQuery(word)', 'setAccountQuery(word)']) {
    assert.ok(index.includes(setter), `「모두 보기」가 검색어를 넘기지 않는다: ${setter}`);
  }
  // 개인정보 규칙(DS 2-15)은 그대로 — 「모두 보기」 경로에도 연락처가 없다.
  assert.equal(/\.contact\b/.test(index), false, '연락처는 검색 색인·이동 경로에 넣지 않는다');

  const comp = src.slice(src.indexOf('function GlobalSearch('), src.indexOf('관리 토큰 보관함'));
  assert.match(comp, /const foundTotal = Object\.values\(result\.found\)\.reduce/, '건수는 찾은 수의 합이다');
  assert.match(comp, /const shownTotal = hits\.filter\(\(h\) => !h\.more\)\.length;/, '「모두 보기」 줄은 결과 수에서 뺀다');
  assert.match(comp, /검색 결과 \$\{foundTotal\}건 — 종류별 상위 \$\{SEARCH_PER_KIND\}건을 보여 줍니다/, '잘렸으면 잘렸다고 읽어 준다');
  assert.match(comp, /const count = total > shown \? `\$\{total\}건 중 \$\{shown\}건` : `\$\{total\}건`;/, '머리줄에 「n건 중 m건」');
  assert.match(comp, /aria-label=\{`\$\{g\.kind\} \$\{count\}`\}/, '그룹 이름에도 같은 수를 담는다(머리줄은 장식이다)');
  assert.match(comp, /data-more=\{h\.more \? 'true' : undefined\}/, '「모두 보기」 줄을 구분해 둔다');
});

/**
 * ── DS 32-1 — 고객이 누른 평가를 볼 수 있는가 ──
 * 위젯은 답변마다 「도움이 됐나요」를 묻고, 서버는 「개선 대상 상위 5」까지 계산해 두었는데
 * 그 집계를 부르는 라우트·화면이 한 곳도 없었다. 랜딩은 「평가가 곧 보완 목록」이라 약속한다.
 */
test('고객이 누른 평가가 대시보드에 모이고, 0건을 0%로 단정하지 않는다 (DS 32-1)', opts, async () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const route = readFileSync(new URL('../src/app/api/admin/escalations/route.ts', import.meta.url), 'utf8');
  const lib = readFileSync(new URL('../src/lib/feedback.ts', import.meta.url), 'utf8');

  // 1) 서버가 집계를 실제로 내려보낸다 — 함수만 있고 부르는 곳이 없으면 화면은 영원히 비어 있다.
  assert.match(route, /import \{ feedbackSummary \} from '@\/lib\/feedback'/, '평가 집계를 불러오지 않는다');
  // 집계를 부르는 곳이 있어야 한다. 이름은 **지금 KB 의 이름**을 붙여 보낸다(DS 43-2 이후) —
  // 평가가 자료 id 로 묶이면서 라벨 해석이 집계 시점으로 옮겨 갔다.
  assert.match(route, /feedback: feedbackSummary\(kbLabelMap\(\)\)/, '응답에 평가가 실리지 않는다');

  // 2) 평가는 재시작을 넘겨 남는다(저장소 네임스페이스 등록 + 기록할 때마다 예약).
  const storage = readFileSync(new URL('../src/lib/storage.ts', import.meta.url), 'utf8');
  const nsBlock = (storage.split('export const NAMESPACES')[1] ?? '').split('};')[0];
  assert.match(nsBlock, /feedback:[^\n]*pii: false/, '평가 네임스페이스가 등록되지 않았다');
  assert.match(lib, /scheduleSave\(FEEDBACK_NS, exportFeedback\)/, '평가를 기록해도 저장을 예약하지 않는다');

  // 3) 화면 — 카드·KPI 값·보완 목록·개인정보 안내.
  const dash = src.slice(src.indexOf("{tab === 'dash' && ("), src.indexOf('{/* ── 최근 대화 ── */}'));
  assert.ok(dash.includes('<h2 style={S.h2}>답변 평가</h2>'), '대시보드에 평가 카드가 없다');
  assert.match(dash, /stats\.feedback && stats\.feedback\.total > 0/, '평가 0건에서도 비율을 그린다');
  assert.match(dash, /stats\.feedback\.helpfulRate === null \? MEASURING/, '표본이 없는데 비율을 단정한다');
  assert.ok(dash.includes('보완이 필요한 자료'), '👎가 많은 자료 목록이 없다');
  assert.ok(dash.includes('평가에는 대화 내용이 들어 있지 않습니다'), '무엇을 기록하는지 밝히지 않는다');
  // 보완 목록은 그 자료가 있는 곳으로 데려간다 — 건수만 보여 주면 고칠 길이 없다.
  assert.match(dash, /onClick=\{\(\) => \{ goTab\('kb'\); setKbCat\(''\); setKbQuery\(d\.citation\); \}\}/, '자료로 데려가지 않는다');
  // 「근거 없음」은 고칠 자료가 없다 — 데려갈 곳이 없으므로 버튼으로 만들지 않는다.
  // DS 43-2 이후에는 **지워진 자료**도 같은 가지로 간다(검색해도 0건이다).
  // DS 58-2 이후에는 **이름을 되돌리지 못한 복원분**도 같은 가지다(검색할 이름 자체가 없다).
  assert.match(dash, /const dead = d\.citation === NO_CITATION_LABEL \|\| lost \|\| d\.missing;/, '근거 없음 행도 자료처럼 누르게 둔다');
  assert.match(dash, /<div className="ac-row" data-static="">/, '누를 수 없는 행이 누를 수 있어 보인다');

  // 4) 「근거 없음」 표기는 서버 사전과 같아야 한다 — 어긋나면 그 행만 영영 자료로 데려간다.
  const label = (src.match(/const NO_CITATION_LABEL = '([^']+)'/) || [])[1];
  assert.ok(label, 'NO_CITATION_LABEL 이 없다');
  assert.ok(lib.includes(`export const NO_CITATION_LABEL = '${label}'`), `서버의 근거 없음 표기와 어긋난다: ${label}`);

  // 5) 첫 렌더(집계 도착 전)에는 평가 카드를 그리지 않는다 — 불러오는 중 ≠ 평가 0건.
  const html = await render();
  assert.equal(html.includes('답변 평가'), false, '집계가 오기 전에 평가 카드를 단정한다');
  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  assert.match(css, /\.ac-row\[data-static\]:hover\{background:transparent\}/, '누를 수 없는 행이 손을 올리면 밝아진다');
});

/**
 * ── DS 32-2 — 「기본 안내 n건」을 무엇을 더 쓸지로 바꾼다 ──
 * 대시보드는 근거 pill 로 「기본 안내 12건」이라 말하면서 그 12건이 **어떤 질문**이었는지는
 * 어디에도 보여 주지 않았다. 숫자를 줄이는 길이 화면에 없으면 그 숫자는 읽고 넘기는 글자다.
 */
test('답하지 못한 질문 목록이 뜨고 그 질문으로 자료를 만들 수 있다 (DS 32-2)', opts, async () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const route = readFileSync(new URL('../src/app/api/admin/escalations/route.ts', import.meta.url), 'utf8');

  assert.match(route, /unansweredQuestions\(8\)/, '서버가 답하지 못한 질문을 내려보내지 않는다');

  const dash = src.slice(src.indexOf("{tab === 'dash' && ("), src.indexOf('{/* ── 답변 평가'));
  assert.ok(dash.includes('<h2 style={S.h2}>자료에 없어 답하지 못한 질문</h2>'), '답하지 못한 질문 카드가 없다');
  // 보여 준 수를 찾은 수라 말하지 않는다(DS 31-3 과 같은 규칙) — 묶음 수·총 횟수를 함께 적는다.
  assert.match(dash, /unanswered\.groups > unanswered\.items\.length/, '자른 수를 전체라고 말한다');
  assert.match(dash, /가지 중 \$\{comma\(unanswered\.items\.length\)\}가지/, '몇 가지 중 몇 가지인지 말하지 않는다');
  assert.match(dash, /<span style=\{S\.tag\} role="status">/, '건수가 바뀌어도 스크린리더가 모른다');
  // 아직 받지 못한 것과 0건을 구분한다 — null 이면 카드 자체를 그리지 않는다.
  assert.match(dash, /\{unanswered && unanswered\.items\.length > 0 && \(/, '불러오기 전에 0건을 단정한다');
  assert.match(src, /const \[unanswered, setUnanswered\] = useState<UnansweredView \| null>\(null\)/, '초기값이 0건이면 안 된다');
  assert.match(src, /setUnanswered\(data\.unanswered \|\| null\)/, '받은 목록을 화면에 싣지 않는다');

  // 질문을 베껴 적게 하지 않는다 — 폼의 질문 칸에 그대로 채우고 폼으로 데려간다.
  assert.match(dash, /onClick=\{\(\) => draftKbFromQuestion\(u\.question\)\}/, '「이 질문으로 자료 만들기」가 없다');
  const fn = src.slice(src.indexOf('const draftKbFromQuestion = async'), src.indexOf('const removeKB = async'));
  assert.match(fn, /confirmDiscard\(formDirty\(form, formBase\.current\.kb\)/, '적던 내용을 말없이 갈아 끼운다(DS 27-2)');
  assert.match(fn, /loadKbForm\(\{ \.\.\.EMPTY_FORM, question \}\)/, '질문을 채우지 않거나 기준선을 옮기지 않는다');
  assert.match(fn, /setEditingId\(null\)/, '수정 중인 자료를 가리킨 채 새 자료를 만든다');
  assert.match(fn, /kbFormRef\.current\?\.scrollIntoView/, '좁은 화면에서 폼이 보이지 않는다');

  const html = await render();
  assert.equal(html.includes('자료에 없어 답하지 못한 질문'), false, '목록이 오기 전에 카드를 단정한다');
});

/**
 * ── DS 36-1·36-2 — 어느 고객사의 손님인가 ──
 * 이 제품은 고객사마다 `data-tenant` 로 임베드되고, 고객사 위젯은 **그 고객사 자료만** 근거로
 * 답한다. 그런데 운영 화면은 모든 고객사를 한 줄에 섞어 놓고 있었다 — 최근 대화·접수 큐·내려받기
 * ·대시보드·보완 목록 어디에도 「어느 회사 손님인가」가 없었다. 이름은 어휘를 아는 서버가 붙인다.
 */
test('대화·접수·내려받기가 어느 고객사에서 왔는지 말한다 (DS 36-1·36-2)', opts, async () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const route = readFileSync(new URL('../src/app/api/admin/escalations/route.ts', import.meta.url), 'utf8');
  // 내려받는 표를 만드는 곳은 라우트가 아니라 `@/lib/convlog` 다(DS 40-1 에서 옮겼다).
  const csv = readFileSync(new URL('../src/lib/convlog.ts', import.meta.url), 'utf8');

  // ① 이름은 서버가 붙여 보낸다(`intentLabel`·`actionLabel` 과 같은 규칙) — 콘솔이 사전을 따로
  //    들고 있으면 고객사가 늘 때마다 어긋나 운영자 화면에 `eum` 같은 코드가 뜬다.
  assert.match(route, /import \{ tenantLabel \} from '@\/lib\/tenants'/, '이름을 붙이는 쪽을 불러오지 않는다');
  // 목록은 DS 43-3 이후 한 묶음(`queryTickets`)으로 내려온다 — 고객사 이름은 그대로 붙는다.
  assert.match(route, /tickets: page\.tickets\.map\(\(t\) => \(\{[\s\S]{0,200}?tenantLabel: tenantLabel\(t\.tenant \?\? null\),/, '접수에 고객사 이름이 붙지 않는다');
  assert.match(route, /tenantLabel: tenantLabel\(t\.tenant \?\? null\),/, '최근 대화에 고객사 이름이 붙지 않는다');
  assert.match(route, /byTenant: conversation\.byTenant\.map/, '고객사별 집계에 이름이 붙지 않는다');
  assert.match(route, /items: u\.items\.map\(\(i\) => \(\{ \.\.\.i, tenantLabel: tenantLabel\(i\.tenant\) \}\)\)/, '못 답한 질문에 고객사 이름이 붙지 않는다');

  // ② 내려받기 파일에도 열이 있다 — 받는 사람이 가장 먼저 거르는 값이다.
  assert.match(csv, /'번호', '시각', '채널', '고객사', '대화'/, 'CSV 에 고객사 열이 없다');
  assert.match(csv, /tenantLabel\(l\.tenant \?\? null\)/, 'CSV 가 고객사를 이름으로 적지 않는다');

  // ③ 최근 대화 한 줄과 상세 서랍이 모두 말한다 — 표에만 있으면 서랍에서는 다시 알 수 없다.
  const dash = src.slice(src.indexOf("{tab === 'dash' && ("), src.indexOf("{tab === 'kb' &&"));
  assert.match(dash, /<span className="ac-pill">\{t\.tenantLabel \|\| UNNAMED_TENANT\}<\/span>/, '최근 대화 줄에 고객사가 없다');
  const drawer = src.slice(src.indexOf('function ConversationDrawer('), src.indexOf('function TicketDrawer('));
  assert.match(drawer, /const tenantName = turns\[0\]\?\.tenantLabel \|\| UNNAMED_TENANT/, '대화 상세가 고객사를 읽지 않는다');
  assert.match(drawer, /\{tenantName\} · \{CHANNEL_LABELS\[channel\]/, '대화 상세 제목에 고객사가 없다');

  // ④ 접수 큐(열) + 접수 상세(줄) + 검색·정렬.
  const esc = src.slice(src.indexOf("{tab === 'esc' &&"), src.indexOf("{tab === 'partner' &&"));
  assert.match(esc, /<SortTh label="고객사" col="tenant" className="ac-col-wide"/, '접수 표에 고객사 열이 없다');
  assert.match(esc, /\{t\.tenantLabel \|\| UNNAMED_TENANT\}<\/td>/, '접수 표가 고객사를 그리지 않는다');
  assert.match(esc, /tenant: \(t: TicketView\) => t\.tenantLabel \|\| ''/, '고객사 열로 정렬할 수 없다');
  assert.match(esc, /t\.tenantLabel \?\? '',/, '고객사 이름으로 검색되지 않는다');
  const ticket = src.slice(src.indexOf('function TicketDrawer('), src.indexOf('/** 고객사 상세 서랍'));
  assert.match(ticket, /고객사 · \{t\.tenantLabel \|\| UNNAMED_TENANT\}/, '접수 상세에 고객사가 없다');

  // ⑤ 「못 답한 질문」은 고칠 자료가 있는 곳으로만 데려간다 — 고객사 자료는 파일이 원본이라
  //    콘솔에서 고칠 수 없다. 섞어 두면 운영자가 엉뚱한 자료에 적어 넣고도 그 위젯은 그대로다.
  assert.match(dash, /const ownKb = !u\.tenant;/, '고칠 자료가 어디 있는지 가리지 않는다');
  assert.match(dash, /ownKb \? \(/, '모든 질문에 「자료 만들기」를 준다');
  assert.ok(dash.includes('고객사 자료 확인'), '고객사 자료를 확인할 길이 없다');
  assert.match(dash, /goTab\('tenant'\);/, '고객사 자료 화면으로 데려가지 않는다');

  // ⑥ 고객사별 현황은 **둘 이상일 때만** 그린다(한 곳뿐이면 위의 KPI 와 같은 수다).
  assert.match(dash, /\(stats\.conversation\.byTenant\?\.length \?\? 0\) > 1 && \(/, '고객사가 한 곳인데도 카드를 세운다');
  assert.ok(dash.includes('<h2 style={S.h2}>고객사별 현황</h2>'), '고객사별 수치가 어디에도 없다');

  // ⑦ 선택 상자에 내부 식별자(`eum`)를 그대로 쓰지 않는다 — 이름을 받아 쓴다.
  assert.match(src, /<option key=\{t\.id\} value=\{t\.id\}>\{t\.name \|\| t\.id\}<\/option>/, '고객사 선택에 코드가 뜬다');
  assert.equal(/<option key=\{id\} value=\{id\}>\{id\}<\/option>/.test(src), false, '식별자를 그대로 보여주는 선택 상자가 남았다');

  // ⑧ 첫 렌더(집계 도착 전)에는 고객사별 현황을 단정하지 않는다.
  const html = await render();
  assert.equal(html.includes('고객사별 현황'), false, '수치가 오기 전에 카드를 세운다');
});

/**
 * ── DS 36-3 — 「응답 테스트」가 고객사 기준으로 물을 수 있는가 ──
 * 종전에는 테스트가 고객사를 실어 보내지 않아 **언제나 기본 구성으로** 답했다. 운영자는 최근
 * 대화에서 이음 손님이 못 받은 답을 보고 같은 말을 그대로 쳐 보는데, 돌아온 답은 고원 자료로
 * 만든 다른 답이었고 미리보기는 그것을 「실제 상담창과 같은 답변」이라 말했다.
 */
test('응답 테스트가 어느 고객사 기준인지 고르고 그 기준으로 묻는다 (DS 36-3)', opts, () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const tenants = readFileSync(new URL('../src/lib/tenants.ts', import.meta.url), 'utf8');
  const tenantKB = readFileSync(new URL('../src/lib/tenantKB.ts', import.meta.url), 'utf8');

  // ① 기준을 고를 수 있고, 고른 값이 요청에 실린다(위젯이 보내는 것과 같은 값).
  assert.match(src, /const \[testTenant, setTestTenant\] = useState\(''\)/, '기준을 고르는 상태가 없다');
  // 세션도 함께 실어 보낸다(DS 51-2) — 보내는 값이 늘었고, 고객사를 싣는 규칙은 그대로다.
  assert.match(src, /message: q,\n\s*sessionId: testSessionRef\.current,\n\s*\.\.\.\(tenantAtSend \? \{ tenant: tenantAtSend \} : \{\}\),/, '고른 기준을 보내지 않는다');
  assert.match(src, /<select\n\s*id="ac-test-tenant"/, '기준 선택 상자가 없다');
  assert.match(src, /<label htmlFor="ac-test-tenant"/, '선택 상자에 라벨이 없다');

  // ② 보낼 때 고른 기준을 그 자리에서 붙들어 둔다 — 답을 기다리는 사이에 바꿀 수 있다(DS 33-x).
  assert.match(src, /const basis = testTenantName;/, '보낸 기준을 기록에 남기지 않는다');
  assert.match(src, /const tenantAtSend = testTenant;/, '보내는 값이 지금 고른 값으로 흔들린다');
  assert.match(src, /<dt>기준<\/dt><dd>\{t\.basis \|\| DEFAULT_TENANT_VIEW_LABEL\}<\/dd>/, '「왜 이렇게 답했나」가 기준을 말하지 않는다');

  // ③ 미리보기가 고른 고객사의 모습이다 — 이음 기준으로 물었는데 헤더가 고원이면 그 화면이 거짓말을 한다.
  assert.match(src, /const sel = testTenant \? tenantList\.find\(\(t\) => t\.id === testTenant\) : undefined;/, '미리보기가 고른 고객사를 모른다');
  assert.match(src, /\{sel\?\.badge \|\| 'G'\}/, '미리보기 아바타가 고정이다');
  assert.match(src, /sel\?\.brandColor \? \(\{ '--brand': sel\.brandColor \}/, '미리보기가 고객사 색을 쓰지 않는다');
  assert.match(src, /미리보기 · \{testTenantName\} 기준/, '무엇을 기준으로 보여 주는지 밝히지 않는다');
  // 공개 설정값(색·한 글자)을 서버가 실제로 내려보낸다 — 화면이 지어내면 실제 위젯과 달라진다.
  assert.match(tenantKB, /brandColor: preset\.brandColor,\n\s*badge: preset\.badge,/, '목록 응답에 공개 설정값이 없다');

  // ④ 목록은 「응답 테스트」를 열 때 가져온다 — 테넌트 지식 탭을 먼저 열어야 쓸 수 있으면 안 된다.
  assert.match(src, /if \(tab === 'test' && tenantList\.length === 0\) loadTenantList\(\);/, '기준 목록을 가져오지 않는다');

  // ⑤ 기본 구성의 표시명은 서버 사전과 **같은 글자**여야 한다 — 어긋나면 같은 것이 두 이름으로 뜬다
  //    (`NO_CITATION_LABEL` 과 같은 방식: 콘솔은 lib 을 불러오지 않으므로 테스트가 두 쪽을 대조한다).
  const viewLabel = (src.match(/const DEFAULT_TENANT_VIEW_LABEL = '([^']+)'/) || [])[1];
  assert.ok(viewLabel, 'DEFAULT_TENANT_VIEW_LABEL 이 없다');
  assert.ok(tenants.includes(`export const DEFAULT_TENANT_LABEL = '${viewLabel}'`), `서버의 기본 구성 표시명과 어긋난다: ${viewLabel}`);
});

/**
 * ── DS 39-1·39-2 — 가렸으면 가렸다고 말한다 ──
 * 대화 기록·접수 본문은 저장될 때 개인정보가 가려진다. 그 사실을 화면이 말하지 않으면 운영자는
 * `***-****-****` 를 보고 **고객이 그렇게 쓴 것인지 우리가 가린 것인지** 모른다. 종류 이름은
 * 서버가 붙여 보내고(`piiLabels`), 화면은 사전을 들고 있지 않다.
 */
test('가린 개인정보를 화면이 말한다 (DS 39-1·39-2)', opts, async () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');

  // ① 한 줄 만드는 자리는 한 곳이고, 가린 것이 없으면 아무것도 그리지 않는다.
  assert.match(src, /function piiNotice\(labels: string\[\] \| undefined\): string/, '가림 안내를 만드는 자리가 없다');
  assert.match(src, /return list\.length \? `개인정보 가림 · \$\{list\.join\(', '\)\}` : '';/, '가린 것이 없는데 말한다');
  // 코드 어휘(`rrn`·`phone`)를 화면이 번역하지 않는다 — 사전을 들면 종류가 늘 때 어긋난다(DS 22-x).
  assert.equal(/rrn: '주민등록번호'/.test(src), false, '콘솔이 마스킹 사전을 따로 들고 있다');

  // ② 대화 상세 — 말풍선의 `***` 가 고객이 쓴 글자가 아니라는 사실을 서랍 머리에서 말한다.
  const drawer = src.slice(src.indexOf('function ConversationDrawer('), src.indexOf('function TicketDrawer('));
  assert.match(drawer, /const piiLabels = Array\.from\(new Set\(turns\.flatMap\(\(t\) => t\.piiLabels \?\? \[\]\)\)\);/, '대화 상세가 가린 종류를 모으지 않는다');
  assert.match(drawer, /\{piiLabels\.length > 0 && <span className="ac-pill" style=\{TONE\.brand\}>\{piiNotice\(piiLabels\)\}<\/span>\}/, '대화 상세가 가린 사실을 말하지 않는다');

  // ③ 접수 상세 — 「고객이 마지막으로 한 말」 바로 아래. 연락처는 아래 칸에서 따로 다룬다.
  const ticket = src.slice(src.indexOf('function TicketDrawer('), src.indexOf('/** 고객사 상세 서랍'));
  assert.match(ticket, /\{piiNotice\(t\.piiLabels\) && \(/, '접수 본문이 가린 사실을 말하지 않는다');
  assert.match(ticket, /연락처는 아래 칸에서 확인하세요/, '가린 뒤 어디를 보라는 말이 없다');

  // ④ 뷰 타입에 칸이 있어야 서버가 보낸 값이 화면까지 온다(옛 응답에는 없으므로 optional).
  assert.match(src, /\/\*\* 이 턴에서 가린 개인정보의 표시명\(서버가 `@\/lib\/pii` 로 붙인다 — DS 39-1\)\. \*\/\n\s*piiLabels\?: string\[\];/, '대화 뷰에 가린 종류 칸이 없다');
  assert.match(src, /piiLabels\?: string\[\];\n\s*contact\?: string;/, '접수 뷰에 가린 종류 칸이 없다');
});

/* ══════════ 41순위 — 백로그 소진 후 38차 재감사 (DS 41-2·41-3) ══════════ */

/** 컴파일된 JS 에서 중첩 함수 하나를 **중괄호를 세어** 떼어낸다(최상위가 아니라 `\n}` 로는 못 찾는다). */
function sliceFn(src, decl) {
  const i = src.indexOf(decl);
  assert.ok(i >= 0, `${decl} 를 찾지 못했다`);
  let depth = 0;
  for (let j = src.indexOf('{', i); j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1);
  }
  throw new Error(`${decl} 의 끝을 찾지 못했다`);
}

/** 전역 검색 컴포넌트 안쪽만 떼어낸다 — 같은 이름의 핸들러가 콘솔에 여럿 있다. */
async function globalSearchRegion() {
  await loadConsole();
  const i = cachedJs.indexOf('function GlobalSearch(');
  assert.ok(i >= 0, 'GlobalSearch 선언을 찾지 못했다');
  const end = cachedJs.indexOf('\n}', i); // 최상위 함수라 닫는 중괄호는 1열에 있다
  assert.ok(end > i, 'GlobalSearch 의 끝을 찾지 못했다');
  return cachedJs.slice(i, end + 2);
}

/**
 * DS 41-2 — 한글을 치는 중에 누른 Enter 가 **첫 결과로 뛰었다**.
 *
 * 한국어 입력기에서 Enter 는 조합 중인 음절을 확정하는 키다. 「환불」을 치려면 마지막 음절을
 * 확정해야 하는데, 검색칸은 키 이름만 보고 `hits[0]` 을 골라 `run()` 을 돌렸다 — 탭이 바뀌고
 * 서랍이 열리며 적던 검색어는 지워진다(`setQ('')`). Esc 도 음절 취소가 아니라 검색어 지우기였다.
 * 「정말 뛰는가」는 소스를 읽어서는 알 수 없다 — 떼어내 돌려 본다.
 */
test('조합 중에 누른 Enter·Esc 는 검색을 움직이지 않는다 (DS 41-2)', opts, async () => {
  const { composingKey } = await loadConsoleFns(['composingKey']);
  assert.equal(composingKey({ nativeEvent: { isComposing: true } }), true, '합성 이벤트의 조합 상태를 못 본다');
  assert.equal(composingKey({ nativeEvent: { isComposing: false } }), false, '조합이 끝난 키를 조합 중이라 한다');
  assert.equal(composingKey({ isComposing: true }), true, '네이티브 이벤트의 조합 상태를 못 본다');
  assert.equal(composingKey({}), false, '조합 상태를 모르면 조합 중이라 단정한다');

  const src = sliceFn(await globalSearchRegion(), 'const onKeyDown = (e)');
  const hits = [{ key: 'a' }, { key: 'b' }];
  const make = (text) => {
    const log = { picked: [], q: '환불', cleared: false, active: 0 };
    const fn = new Function(
      'composingKey', 'hits', 'activeIdx', 'pick', 'setOpen', 'setActive', 'q', 'setQ',
      `${text}\nreturn onKeyDown;`,
    )(
      composingKey, hits, 0,
      (h) => log.picked.push(h.key),
      () => {},
      (f) => { log.active = typeof f === 'function' ? f(log.active) : f; },
      log.q,
      (v) => { log.cleared = v === ''; },
    );
    return [fn, log];
  };
  const ev = (key, composing) => ({ key, nativeEvent: { isComposing: composing }, preventDefault() {}, stopPropagation() {} });

  // ① 조합 중에는 결과를 고르지도, 적던 검색어를 지우지도 않는다.
  const [fn, log] = make(src);
  fn(ev('Enter', true));
  assert.deepEqual(log.picked, [], '조합을 확정하는 Enter 에 첫 결과로 뛴다');
  fn(ev('Escape', true));
  assert.equal(log.cleared, false, '음절을 취소하는 Esc 에 적던 검색어를 지운다');
  fn(ev('ArrowDown', true));
  assert.equal(log.active, 0, '조합 중에 고른 항목이 움직인다');

  // ② 조합이 끝난 뒤에는 종전과 똑같이 동작한다(화살표로 고르고 Enter 로 이동).
  fn(ev('Enter', false));
  assert.deepEqual(log.picked, ['a'], '조합이 끝난 Enter 로는 이동하지 않는다');
  fn(ev('Escape', false));
  assert.equal(log.cleared, true, '조합이 끝난 Esc 로는 검색어가 지워지지 않는다');
  fn(ev('ArrowDown', false));
  assert.equal(log.active, 1, '화살표로 다음 항목으로 내려가지 않는다');

  // ③ 종전 식 재현 — 조합 확인이 없으면 같은 키 입력에 실제로 뛴다(이것이 결함의 크기다).
  const old = src.replace(/if \(composingKey\(e\)\)\s*return;/, '');
  assert.notEqual(old, src, '조합 확인 한 줄을 찾지 못했다 — 재현이 아무것도 지키지 않는다');
  const [oldFn, oldLog] = make(old);
  oldFn(ev('Enter', true));
  assert.deepEqual(oldLog.picked, ['a'], '종전 식에서도 뛰지 않는다 — 결함이 재현되지 않는다');
});

/**
 * DS 41-3 — 덮개가 열려 있는데 단축키가 초점을 **덮개 밖으로** 끌어냈다.
 *
 * `Ctrl+K`·`/` 는 창 전체(window)에서 듣는다. 서랍·확인 대화상자는 `aria-modal="true"` 로
 * 「여기 말고는 쓸 수 없다」고 알려 둔 화면인데, 그 위에서 단축키가 들으면 초점이 헤더 검색칸으로
 * 나간다 — 덮개의 Esc·Tab 가둠은 모두 **제 패널의 `onKeyDown`** 에 걸려 있으므로 그 뒤로는
 * Esc 로 덮개를 닫는 길이 막히고, 확인 대화상자는 약속이 풀리지 않아 그 작업이 멈춘 채 남는다.
 */
test('덮개가 열려 있으면 검색 단축키가 초점을 빼내지 않는다 (DS 41-3)', opts, async () => {
  const { composingKey } = await loadConsoleFns(['composingKey']);
  const src = sliceFn(await globalSearchRegion(), 'const onKey = (e)');

  const run = (text, modal, ev) => {
    const log = { focused: 0, selected: 0 };
    const doc = { querySelector: (sel) => (modal && sel === '[aria-modal="true"]' ? { tagName: 'DIV' } : null) };
    new Function('composingKey', 'document', 'inputRef', `${text}\nreturn onKey;`)(
      composingKey,
      doc,
      { current: { focus: () => { log.focused += 1; }, select: () => { log.selected += 1; } } },
    )(ev);
    return log;
  };
  const key = (k, extra = {}) => ({ key: k, target: { tagName: 'BODY' }, preventDefault() {}, ...extra });

  // ① 덮개가 없으면 종전대로 검색칸으로 데려간다.
  assert.equal(run(src, false, key('/')).focused, 1, '「/」로 검색칸에 가지 못한다');
  assert.equal(run(src, false, key('k', { ctrlKey: true })).focused, 1, 'Ctrl+K 로 검색칸에 가지 못한다');
  // ② 덮개가 열려 있으면 듣지 않는다 — 초점은 덮개 안에 남는다.
  assert.equal(run(src, true, key('/')).focused, 0, '덮개 위에서도 「/」가 초점을 빼낸다');
  assert.equal(run(src, true, key('k', { ctrlKey: true })).focused, 0, '덮개 위에서도 Ctrl+K 가 초점을 빼낸다');
  // ③ 조합 중인 키도 단축키가 아니다(글자를 만드는 키다).
  assert.equal(run(src, false, key('k', { ctrlKey: true, nativeEvent: { isComposing: true } })).focused, 0, '조합 중인 키에 초점을 옮긴다');

  // ④ 종전 식 재현 — 덮개 확인이 없으면 같은 키 입력에 실제로 초점이 빠져나간다.
  const old = src.replace(/ \|\| document\.querySelector\('\[aria-modal="true"\]'\)/, '');
  assert.notEqual(old, src, '덮개 확인을 찾지 못했다 — 재현이 아무것도 지키지 않는다');
  assert.equal(run(old, true, key('/')).focused, 1, '종전 식에서도 빠져나가지 않는다 — 결함이 재현되지 않는다');
});

/* ══════════ 42순위 — 백로그 소진 후 39차 재감사 (DS 42-1·42-3) ══════════ */

/**
 * DS 42-1 — 같은 말을 찾는 자가 **화면마다 달랐다**.
 *
 * 헤더 전역 검색만 띄어쓰기를 무시하고(`searchNorm`), 각 탭의 검색칸은 `toLowerCase()` 만 했다.
 * 그래서 「환불정책」을 치면 헤더에서는 「환불 정책 안내」가 나오고 **안내 자료 탭에서는 0건**이었다.
 * 어느 쪽이 제품의 뜻인지는 분명하다 — 한 자로 모으고, 그 자가 서버의 `compact` 와 같은지 돌려 본다.
 */
test('콘솔의 모든 검색칸이 서버와 같은 자를 쓴다 (DS 42-1)', opts, async () => {
  const { searchNorm, searchMatch, probeKeywords } = await loadConsoleFns(['searchNorm', 'searchMatch', 'probeKeywords']);
  const { compact } = await importLib('normalize', []);

  // ① 콘솔 사본과 서버 원본이 **같은 입력에 같은 결과**를 낸다(콘솔은 lib 을 불러올 수 없다).
  const samples = [
    '환불 정책 안내', '(주)고원 커머스', 'ENVIRONMENT 인증서', '좋아요오오오',
    '환불되나요?', '  띄어쓰기  섞인   말  ', 'T-2026-0001', '요금·가격 문의', '',
    '환불 정책 안내'.normalize('NFD'), '(주)고원 커머스'.normalize('NFD'),
  ];
  for (const s of samples) {
    assert.equal(searchNorm(s), compact(s), `콘솔과 서버의 자가 갈라졌다: ${JSON.stringify(s)}`);
  }

  // ② 종전 식 재현 — 탭 검색칸이 쓰던 자는 같은 말을 찾지 못한다(이것이 결함의 크기다).
  const oldNorm = (v) => v.trim().toLowerCase();
  assert.equal('환불 정책 안내'.toLowerCase().includes(oldNorm('환불정책')), false, '종전 식에서도 찾는다 — 재현이 아무것도 지키지 않는다');
  assert.equal(searchMatch(searchNorm('환불정책'), '환불 정책 안내'), true, '띄어쓰기를 지운 말로 찾지 못한다');
  assert.equal(searchMatch(searchNorm('주고원'), '(주)고원 커머스'), true, '문장부호를 지운 말로 찾지 못한다');
  assert.equal(searchMatch(searchNorm('환불정책'.normalize('NFD')), '환불 정책 안내'), true, '분해형으로 친 말을 다른 글자로 본다');
  assert.equal(searchMatch(searchNorm('없는말'), '환불 정책 안내'), false, '없는 말까지 찾아낸다');
  assert.equal(searchMatch(searchNorm('환불'), undefined, ''), false, '빈 칸을 뒤져 찾았다고 한다');

  // ③ 조건 시험(규칙 빌더)도 같은 자를 쓴다 — 빈 표현이 모든 문장에 걸리던 자리도 함께 막는다.
  assert.deepEqual(probeKeywords('환불 정책이 궁금해요', ['환불정책', '배송']), ['환불정책']);
  assert.deepEqual(probeKeywords('환불 정책이 궁금해요', ['  ', '···']), [], '빈 표현이 모든 문장에 걸린다');

  // ④ 탭 검색칸이 **전부** 그 자를 지난다 — 하나라도 빠지면 그 탭만 다른 제품이 된다.
  await loadConsole();
  for (const name of ['kbQuery', 'ruleQuery', 'escQuery', 'accountQuery']) {
    assert.ok(cachedJs.includes(`searchNorm(${name})`), `${name} 가 공통 검색 자를 지나지 않는다`);
  }
  assert.equal(/Query\.trim\(\)\.toLowerCase\(\)/.test(cachedJs), false, '탭 검색칸이 제 자를 따로 적고 있다');
});

/**
 * DS 42-3 — 붙여 넣은 본문의 글자 수를 **코드 단위**로 셌다.
 *
 * 분해형 한글은 한 음절이 코드 2~3개다. macOS 파일·PDF 에서 긁어온 본문이 그 모습이라,
 * 4만 자짜리 한글 문서가 12만 자로 읽혀 **보내 보기도 전에** 「10만 자를 넘습니다」로 막혔다.
 */
test('붙여 넣은 본문의 글자 수를 사람이 보는 글자로 센다 (DS 42-3)', opts, async () => {
  const { docLen } = await loadConsoleFns(['docLen']);
  const text = '환불 안내입니다. '.repeat(1000);
  assert.equal(docLen(text), text.length, '완성형에서 글자 수가 달라졌다');
  assert.ok(text.normalize('NFD').length > text.length * 2, '재현 조건(분해형이 더 길다)이 성립하지 않는다');
  assert.equal(docLen(text.normalize('NFD')), text.length, '분해형을 더 긴 글로 센다');
  assert.equal(docLen(''), 0);
  assert.equal(docLen(undefined), 0, '값이 없을 때 세다가 멈춘다');

  // 화면에 적히는 수와 거절 판정이 **같은 함수**를 지난다 — 둘이 갈라지면 「통과인데 거절」이 된다.
  await loadConsole();
  assert.ok(cachedJs.includes('docLen(imp.text) > MAX_DOC_CHARS'), '거절 판정이 제 수로 센다');
  assert.ok(cachedJs.includes('comma(docLen(imp.text))'), '화면에 적히는 수가 제 수로 센다');
  assert.equal(/imp\.text\.length/.test(cachedJs), false, '본문 길이를 코드 단위로 세는 자리가 남아 있다');
});

/**
 * DS 43-1 — 막대 그래프가 **기록이 없는 날**을 0건으로 그렸다.
 *
 * 스크린리더 사용자에게는 `aria-label` 의 문장이 그래프의 전부다. 종전에는 그 문장이
 * 「10월 11일 0건」이었고, 그 날 기록이 보관 한도에 밀려 사라졌다는 사실은 어디에도 없었다.
 */
test('기록이 없는 날을 「0건」으로 읽어 주지 않는다 (DS 43-1)', opts, async () => {
  const { dayRead } = await loadConsoleFns(['dayRead']);

  // 기록이 없는 날 — 수를 말하지 않는다(종전에는 「0건」이었다).
  const gap = dayRead({ date: '2026-10-11', turns: 0, escalated: 0, coverage: 'none' });
  assert.equal(gap, '10월 11일 기록 없음');
  assert.equal(/0건/.test(gap), false, '기록 없는 날을 0건이라 읽는다');
  // 경계에 걸친 날 — 그 날 전부가 아니라는 사실을 함께 읽는다.
  assert.equal(dayRead({ date: '2026-10-12', turns: 7, escalated: 0, coverage: 'partial' }), '10월 12일 7건(보관된 범위만)');
  // 전부 들고 있는 날 — 0건이면 **정말** 대화가 없었던 날이다.
  assert.equal(dayRead({ date: '2026-10-13', turns: 0, escalated: 0, coverage: 'full' }), '10월 13일 0건');
  assert.equal(dayRead({ date: '2026-10-14', turns: 12, escalated: 1, coverage: 'full' }), '10월 14일 12건');
  // 옛 응답(coverage 없음)에는 종전처럼 건수만 — 모르는 것을 단정하지 않는다.
  assert.equal(dayRead({ date: '2026-10-15', turns: 3, escalated: 0 }), '10월 15일 3건');

  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const lib = readFileSync(new URL('../src/lib/convlog.ts', import.meta.url), 'utf8');
  // 어휘는 서버와 같아야 한다 — 콘솔이 모르는 값을 받으면 그 날이 조용히 0건으로 돌아간다.
  assert.match(lib, /export type DayCoverage = 'full' \| 'partial' \| 'none';/, '서버 어휘가 바뀌었다');
  assert.match(src, /type DayCoverage = 'full' \| 'partial' \| 'none';/, '콘솔 어휘가 서버와 어긋난다');
  // 막대 대신 점선을 긋고, 그 표시가 무엇인지 적는다(색이 아니라 글자·선이다).
  const chart = src.slice(src.indexOf('function TrendChart('), src.indexOf('interface TurnView'));
  assert.match(chart, /const gap = d\.coverage === 'none';/, '기록 없는 날을 가려내지 않는다');
  assert.match(chart, /strokeDasharray="3 3"/, '기록 없는 날이 빈 칸(=0)으로 남는다');
  assert.ok(chart.includes('기록이 남지 않은 날'), '「—」가 무엇인지 적지 않는다');
  assert.ok(chart.includes('대화가 0건이었다는 뜻이 아닙니다'), '빈 칸을 0으로 읽게 둔다');
  // 오늘 수와 그래프 머리가 **모수**를 밝힌다.
  const dash = src.slice(src.indexOf("{tab === 'dash' && ("), src.indexOf('{/* ── 고객사별 현황'));
  assert.match(dash, /today\?\.coverage === 'partial'/, '오늘 수가 그날 전부인지 말하지 않는다');
  assert.ok(dash.includes('이후만 집계'), '오늘 수의 모수를 밝히지 않는다');
  assert.ok(dash.includes('이후 보관된 기록 기준'), '그래프가 언제부터의 기록인지 말하지 않는다');
  assert.ok(dash.includes('보관된 기록 안에는 대화가 없습니다'), '빈 그래프를 「대화가 없었다」고 단정한다');
});

/**
 * DS 43-2 — 평가가 **바뀌는 이름**으로 묶여 있었다(배선 쪽 고정).
 * 위젯이 자료 id 를 보내지 않으면 서버가 아무리 id 로 묶어도 옛 모양 그대로다.
 */
test('평가가 어느 자료에 대한 것인지 id 로 오간다 (DS 43-2)', opts, () => {
  const widget = readFileSync(new URL('../src/components/ChatWidget.tsx', import.meta.url), 'utf8');
  const route = readFileSync(new URL('../src/app/api/feedback/route.ts', import.meta.url), 'utf8');
  const lib = readFileSync(new URL('../src/lib/feedback.ts', import.meta.url), 'utf8');
  const tenantKB = readFileSync(new URL('../src/lib/tenantKB.ts', import.meta.url), 'utf8');
  const knowledge = readFileSync(new URL('../src/lib/knowledge.ts', import.meta.url), 'utf8');
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');

  // ① 위젯이 자료 id 를 함께 보낸다.
  assert.match(widget, /kbId: m\.citation\?\.kbId \|\| ''/, '위젯이 자료 id 를 보내지 않는다');
  // ② 라우트가 받아 넘긴다 — 검증을 거치고(길이 상한) 이름과 한 쌍으로 저장소로 간다.
  //    (50차에 라벨은 서버가 붙이게 되었다 · DS 53-2 — 그 배선은 아래 DS 53-2 테스트가 센다.)
  assert.match(route, /optStr\(parsed\.data\.kbId, 'kbId', 60\)/, '라우트가 자료 id 를 검증 없이 받는다');
  assert.match(route, /resolveKb\(kbId\.value, kbLabelMap\(\)\)/, '라우트가 자료 id 를 버린다');
  // ③ 묶음 열쇠가 id 우선이다 — 라벨로만 묶으면 이름을 고칠 때마다 줄이 갈라진다.
  //    (DS 58-2 가 이름을 되돌리지 못한 복원분을 `lost:` 한 줄로 가른 뒤에도 id 가 먼저다.)
  assert.match(lib, /const key = e\.kbId\s*\n?\s*\? `id:\$\{e\.kbId\}`/, '평가를 라벨로 묶는다');
  assert.match(lib, /: `label:\$\{e\.citation \|\| NO_CITATION_LABEL\}`/, '이름이 있는 평가를 라벨로 묶지 않는다');
  // ④ 이름 규칙이 근거 라벨과 같다 — 운영자가 답변 아래에서 본 그 이름이 목록에 떠야 한다.
  assert.match(knowledge, /source: entry\.source\?\.trim\(\) \|\| entry\.question,/, '근거 라벨 규칙이 바뀌었다');
  assert.match(tenantKB, /const label = \(e\.source \|\| ''\)\.trim\(\) \|\| \(e\.question \|\| ''\)\.trim\(\);/, '목록의 이름 규칙이 근거 라벨과 어긋난다');
  // 기본 구성과 등록된 고객사 FAQ 를 모두 담는다(평가에는 고객사를 적지 않는다).
  assert.match(tenantKB, /put\(listKB\(\)\);/, '관리 콘솔 자료의 이름을 찾지 못한다');
  assert.match(tenantKB, /for \(const id of Object\.keys\(TENANTS\)\) put\(tenantKB\(TENANTS\[id\]\)\);/, '고객사 FAQ 의 이름을 찾지 못한다');
  // ⑤ 화면은 지워진 자료를 검색으로 데려가지 않는다(0건 화면 앞에 세우지 않는다).
  const dash = src.slice(src.indexOf('보완이 필요한 자료'), src.indexOf('{/* ── 최근 대화 ── */}'));
  assert.ok(dash.includes('지금은 없는 자료입니다'), '지워진 자료를 그냥 자료처럼 보여 준다');
  assert.match(dash, /const key = d\.key \|\| d\.citation;/, '화면이 열쇠를 다시 만든다');
});

/**
 * DS 43-3 — 접수 목록을 요청마다 **전부** 받았다(30초마다 되풀이).
 * 상한을 두면 「보여 준 수를 전체라 말하지 않는다」(DS 31-3)를 함께 지켜야 한다.
 */
test('접수 목록을 한 묶음씩 받고 전체 수를 따로 말한다 (DS 43-3)', opts, async () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const route = readFileSync(new URL('../src/app/api/admin/escalations/route.ts', import.meta.url), 'utf8');
  const lib = readFileSync(new URL('../src/lib/escalation.ts', import.meta.url), 'utf8');

  // ① 서버가 상한을 적용하고 전체 수를 함께 보낸다.
  assert.match(route, /queryTickets\(intQuery\(req, 'tickets', TICKET_PAGE_DEFAULT, 1, TICKET_PAGE_MAX\)\)/, '라우트가 전부 실어 보낸다');
  assert.match(route, /ticketPage: \{ total: page\.total, shown: page\.tickets\.length, limit: page\.limit, truncated: page\.truncated \}/, '전체 수를 말하지 않는다');
  assert.equal(/listTickets\(\)\.map/.test(route), false, '전부 보내는 자리가 남아 있다');

  // ② 상한 값이 서버와 콘솔에서 같다 — 어긋나면 화면이 「더 불러오기」를 못 멈춘다.
  const def = Number((lib.match(/export const TICKET_PAGE_DEFAULT = (\d+);/) || [])[1]);
  const max = Number((lib.match(/export const TICKET_PAGE_MAX = (\d+);/) || [])[1]);
  assert.ok(def > 0 && max >= def, '서버 상한을 읽지 못했다');
  assert.equal(Number((src.match(/const TICKET_PAGE_STEP = (\d+);/) || [])[1]), def, '콘솔의 묶음 크기가 서버 기본값과 다르다');
  assert.equal(Number((src.match(/const TICKET_PAGE_MAX = (\d+);/) || [])[1]), max, '콘솔의 상한이 서버와 다르다');

  // ③ 콘솔이 상한을 실어 보내고(되풀이 확인도 같은 수로), 서버가 말한 모수를 들고 있는다.
  assert.match(src, /\/api\/admin\/escalations\?logs=true&tickets=\$\{ticketLimitRef\.current\}/, '콘솔이 상한 없이 요청한다');
  assert.match(src, /setTicketPage\(data\.ticketPage \?\? null\)/, '모수를 버린다');

  // ④ 상태별 수는 **서버가 센 전체**를 쓴다 — 불러온 행을 세면 처리한 일의 수가 화면 상한에 따라 달라진다.
  const esc = src.slice(src.indexOf("{tab === 'esc' && (()"), src.indexOf("{tab === 'partner'"));
  assert.match(esc, /const totals = stats[\s\S]{0,260}escalation\.resolved,/, '상태별 수를 불러온 행으로 센다');
  assert.match(esc, /\{ key: 'all', label: '전체', n: ticketTotal \}/, '전체 칩이 불러온 수를 말한다');
  assert.ok(esc.includes('value={String(totals.open)}'), '대기 중 KPI 가 불러온 행만 센다');

  // ⑤ 잘렸으면 그 사실을 말하고, 더 불러올 길을 준다. 대기 건이 빠지지 않는다는 사실도 적는다.
  assert.ok(esc.includes('건만 불러왔습니다'), '보여 준 수를 전체라고 말한다');
  assert.ok(esc.includes('건 더 불러오기'), '더 불러올 길이 없다');
  assert.ok(esc.includes('대기·상담 중 요청은 모두 들어 있고'), '무엇이 빠졌는지 말하지 않는다');
  // 상한에 닿으면 「더 불러오기」를 그리지 않고, 그 사실을 사유로 적는다(없는 조작을 보이지 않는다).
  assert.match(esc, /ticketPage\?\.truncated && ticketLimit < TICKET_PAGE_MAX/, '상한에서도 더 불러오기를 보여 준다');
  assert.ok(esc.includes('상한('), '상한에 닿은 사실을 적지 않는다');

  // ⑥ 첫 렌더(응답 전)에는 잘렸다고 말하지 않는다 — 불러오는 중 ≠ 잘림.
  const html = await render();
  assert.equal(html.includes('건만 불러왔습니다'), false, '응답 전에 잘렸다고 단정한다');
});

/**
 * DS 44-1 — 다시 올린 문서가 **지난 판의 조각을 남기는데** 화면은 「신규 0 · 갱신 2」만 말했다.
 * 등록 전에 무엇이 바뀌고 무엇이 남는지 말하고, 남은 것을 지우는 길까지 같은 자리에 둔다.
 */
test('다시 올린 문서가 덮어쓰는 것·남기는 것을 화면이 말한다 (DS 44-1)', opts, async () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const route = readFileSync(new URL('../src/app/api/admin/kb/import/route.ts', import.meta.url), 'utf8');
  const store = readFileSync(new URL('../src/lib/adminStore.ts', import.meta.url), 'utf8');

  // ① 서버가 **등록 전에** 잰다 — 등록 뒤에 재면 갈아 끼운 것과 남는 것을 구분할 수 없다.
  assert.match(route, /const overlap = docOverlap\(docIdPrefix\(title\.value\), candidates\.map\(\(c\) => c\.id\), title\.value\);/, '라우트가 바뀌는 자리를 재지 않는다');
  assert.ok(route.indexOf('const overlap =') < route.indexOf('const result = bulkUpsertKB('), '등록 뒤에 재고 있다');
  // (DS 58-3 이 같은 응답에 「빠진 조각」을 더했다 — 바뀌는 자리는 그대로 실려야 한다.)
  assert.match(route, /return ok\(\{ committed: false, count: candidates\.length, candidates, overlap,/, '미리보기가 바뀌는 자리를 말하지 않는다');
  assert.match(route, /지난 등록분 \$\{overlap\.stale\.length\}건 남음/, '남은 조각이 변경 이력에 남지 않는다');
  // id 앞자리는 **한 벌**이다 — 두 벌로 적으면 어긋나는 날 경고가 조용히 사라진다.
  assert.match(store, /export function docOverlap\(prefix: string, candidateIds: readonly string\[\], title: string\): DocOverlap/, '겹치는 자리를 재는 함수가 없다');
  assert.equal(/doc_\$\{slugify/.test(src), false, '콘솔이 id 앞자리를 따로 만든다');

  // ② 자동 식별자가 같은 밀리초에 겹치지 않는다(겹치면 둘째가 첫째를 덮어쓴다).
  assert.match(store, /function autoId\(prefix: string, taken: \(id: string\) => boolean\): string/, '겹치지 않는 식별자 생성기가 없다');
  // 자동 식별자를 만드는 자리는 둘뿐이다 — 둘 다 그 문을 지난다(주석의 옛 식은 설명이므로 센다는 뜻이 아니다).
  assert.match(store, /const id = \(input\.id \|\| ''\)\.trim\(\) \|\| autoId\('kb', \(v\) => kbEntries\.some/, '자료 식별자가 밀리초 하나로 만들어진다');
  assert.match(store, /const intent = \(input\.intent \|\| ''\)\.trim\(\) \|\| autoId\('cr', \(v\) => customRules\.some/, '규칙 식별자가 밀리초 하나로 만들어진다');

  // ③ 화면은 세 가지를 **글로** 말한다: 덮어쓰기 · 다른 문서 · 남는 것.
  const imp = src.slice(src.indexOf('aria-labelledby="ac-kb-import"'), src.indexOf('{/* ── 우: 편집 폼(스티키) ── */}'));
  assert.ok(imp.includes('의 내용이 이번 문서로 바뀝니다'), '덮어쓰는 건수를 말하지 않는다');
  assert.ok(imp.includes('이 자리에는 다른 문서'), '남의 문서를 덮어쓰는 것을 말하지 않는다');
  assert.ok(imp.includes('등록해도 지워지지 않고 남아'), '남는 조각을 말하지 않는다');
  assert.ok(imp.includes('지난 등록분'), '남은 것을 지우는 길이 없다');
  assert.match(imp, /onClick=\{\(\) => removeStaleDoc\(impOverlap\.stale\)\}/, '지우기 버튼이 남은 목록을 받지 않는다');
  // 등록한 뒤에도 남는다 — 사라지는 토스트에 맡기면 아무도 보지 못한다.
  assert.match(src, /setImpOverlap\(overlap && overlap\.stale\.length > 0 \? overlap : null\)/, '등록 뒤에 경고를 버린다');
  assert.match(src, /지난 등록분 \$\{overlap\.stale\.length\}건이 남았습니다/, '등록 결과가 남은 것을 말하지 않는다');
  // 되돌릴 수 없는 일이라 확인을 거치고, 반만 지우고 성공이라 하지 않는다.
  assert.match(src, /askConfirm\(\{\s*\n\s*title: `지난 등록분 \$\{items\.length\}건을 지울까요\?`/, '남은 조각을 확인 없이 지운다');
  assert.ok(src.includes('건을 지웠고 나머지는 지우지 못했습니다'), '중간에 실패한 사실을 숨긴다');

  // ④ 첫 렌더에는 아무 경고도 없다 — 재 보기 전에 단정하지 않는다.
  const html = await render();
  assert.equal(html.includes('등록해도 지워지지 않고 남아'), false, '재 보기도 전에 남는다고 말한다');
});

/**
 * DS 44-2 — 「등록」은 화면의 후보가 아니라 **지금 칸의 값**을 다시 보낸다.
 * 미리보기를 만든 뒤 본문을 갈아 넣고 등록하면, 보지 않은 것이 등록됐다(미리보기의 존재 이유가 무너진다).
 */
test('미리보기 뒤에 입력이 바뀌면 보지 않은 것을 등록하지 않는다 (DS 44-2)', opts, async () => {
  const { impSig } = await loadConsoleFns(['impSig']);
  const form = { title: '요금 안내', category: '문서', maxChars: '500', text: '본문입니다.' };

  // 같은 입력은 같은 값 — 공백·빈 카테고리는 **보내는 값**과 같은 기준으로 다룬다(없는 변경을 만들지 않는다).
  assert.equal(impSig(form), impSig({ ...form, title: ' 요금 안내 ' }));
  assert.equal(impSig(form), impSig({ ...form, maxChars: ' 500 ' }));
  assert.equal(impSig({ ...form, category: '' }), impSig({ ...form, category: '문서' }), '빈 카테고리를 다른 값으로 본다');
  // 보내는 값이 달라지면 다른 값이다 — 네 칸 전부가 후보를 바꾼다.
  for (const patch of [{ title: '다른 문서' }, { category: '요금' }, { maxChars: '800' }, { text: '다른 본문입니다.' }]) {
    assert.notEqual(impSig(form), impSig({ ...form, ...patch }), `이 칸이 바뀌어도 같은 미리보기로 본다: ${Object.keys(patch)[0]}`);
  }

  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  // ① 등록은 미리보기와 입력이 같을 때만 간다(막는 자리는 보내기 **전**이다).
  assert.match(src, /if \(commit && \(!candidates \|\| impSig\(imp\) !== impSeen\)\) \{/, '바뀐 입력을 그대로 등록한다');
  assert.ok(src.includes('미리보기와 다릅니다'), '막은 이유를 말하지 않는다');
  assert.match(src, /focusErrorField\('kb-imp-preview'\)/, '다시 미리보기 할 자리로 데려가지 않는다');
  assert.match(src, /id="kb-imp-preview"/, '데려갈 버튼에 이름이 없다');
  // ② 미리보기를 만든 그때의 입력을 들고 있는다.
  assert.match(src, /setImpSeen\(impSig\(imp\)\)/, '미리보기 시점의 입력을 기억하지 않는다');
  assert.match(src, /const impChanged = !!candidates && impSig\(imp\) !== impSeen;/, '바뀜 판정이 없다');
  // ③ 버튼은 `disabled` 가 아니라 aria 로 알린다(눌러 초점을 잃지 않는다 — DS 8-1).
  assert.match(src, /busyBtn\(impBusy === 'commit', impBusy !== '' \|\| !candidates \|\| impChanged, S\.btn\)/, '등록 버튼이 바뀜을 모른다');
  assert.equal(/disabled=\{impChanged/.test(src), false, 'disabled 로 막아 초점을 잃는다');
  // ④ 화면의 후보가 「지난 것」임을 글자로 말한다(흐리게만 하면 대비가 떨어진다).
  assert.ok(src.includes('지난 미리보기'), '지난 후보를 그대로 「후보」라 적는다');
  assert.ok(src.includes('미리보기를 만든 뒤 입력이 바뀌었습니다'), '왜 등록이 막혔는지 그 자리에서 말하지 않는다');
  assert.match(src, /\{impBusy === 'preview' \? '미리보기 만드는 중…' : impChanged \? '다시 미리보기' : '미리보기'\}/, '다시 미리보기 하라고 말하지 않는다');
});

/**
 * DS 44-3 — 가려진 규칙(먼저 걸리는 규칙이 있어 **한 번도 쓰이지 않는** 규칙)을 화면이 말해야 한다.
 * 판정은 엔진이 한다 — 콘솔이 패턴을 다시 해석하면 경고가 실제와 어긋난다.
 */
test('가려져 쓰이지 않는 규칙을 화면이 말하고 다음에 할 일을 준다 (DS 44-3)', opts, async () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const route = readFileSync(new URL('../src/app/api/admin/rules/route.ts', import.meta.url), 'utf8');
  const chat = readFileSync(new URL('../src/lib/chat.ts', import.meta.url), 'utf8');

  // ① 판정은 엔진과 **같은 자**로 한다 — 기본 규칙은 matchRule(deny·압축형), 내 규칙은 keywordHit.
  assert.match(chat, /export function shadowOfRule\(keywords: readonly string\[\], selfIntent = ''\): RuleShadow \| null/, '가려짐 판정이 엔진에 없다');
  assert.match(chat, /if \(matchRule\(r, text, pre\.compact\)\) return \{ kind: 'builtin'/, '기본 규칙을 엔진과 다른 자로 잰다');
  assert.match(chat, /keywordHit\(pre\.compact, pre\.jamo, k\)\.kind !== 'none'/, '내 규칙을 엔진과 다른 자로 잰다');
  assert.match(chat, /if \(ov && ov\.enabled === false\) continue;/, '끈 기본 규칙이 여전히 가린다고 말한다');
  assert.match(chat, /if \(c\.intent === selfIntent\) break;/, '뒤에 있는 규칙이 앞의 규칙을 가린다고 말한다');

  // ② 조회·저장 응답이 그 판정을 싣는다(저장은 됐지만 쓰이지 않는 규칙을 그 자리에서 알린다).
  assert.match(route, /shadowedBy: r\.enabled \? shadowOfRule\(r\.keywords, r\.intent\) : null/, '목록이 가려짐을 말하지 않는다');
  assert.match(route, /customRules: listCustomRules\(\)\.map\(customRuleView\)/, '조회가 가려짐을 싣지 않는다');
  assert.match(route, /shadowedBy: customRuleView\(result\.rule\)\.shadowedBy/, '저장 응답이 가려짐을 말하지 않는다');

  // ③ 목록이 그 사실과 **다음에 할 일**을 함께 적는다 — 기본 규칙이면 그 규칙으로 데려간다.
  const t = src.slice(src.indexOf("{tab === 'rules' &&"), src.indexOf("{tab === 'esc' &&"));
  assert.ok(t.includes('가려짐'), '가려진 규칙에 표시가 없다');
  // 조사는 규칙 이름의 받침에 맞춰 붙는다(DS 61-3) — 문장의 나머지는 종전 그대로다.
  assert.ok(t.includes(" 먼저 답합니다 — 이 규칙은 상담창에서 쓰이지 않습니다"), '쓰이지 않는다는 사실을 말하지 않는다');
  assert.ok(t.includes('기본 규칙 열기'), '먼저 답하는 기본 규칙으로 데려가지 않는다');
  assert.ok(t.includes('그 규칙의 표현을 좁히거나'), '먼저 만든 내 규칙일 때 할 일을 말하지 않는다');
  assert.match(src, /const goToBuiltinRule = \(intent: string\) => \{\n\s*setRuleQuery\(''\);/, '검색에 가려진 규칙으로 데려가다 길을 잃는다');
  assert.match(src, /focusErrorField\(`ac-rule-reply-\$\{intent\}`\)/, '데려간 뒤 초점을 옮기지 않는다');
  // 저장 직후에도 말한다(목록을 내려다보지 않는 사람을 위해).
  assert.match(src, /규칙을 저장했지만 상담창에서는 쓰이지 않습니다/, '저장 응답의 가려짐을 흘려보낸다');
  assert.match(src, /const shadow = data\.shadowedBy as RuleShadowView \| null \| undefined;/, '저장 응답을 읽지 않는다');

  // ④ 미리보기는 「적용됩니다」라고 단정하지 않는다 — 먼저 걸리는 규칙이 있으면 그 답은 나가지 않는다.
  assert.equal(t.includes('표현으로 이 규칙이 적용됩니다'), false, '나가지 않을 답을 적용된다고 말한다');
  assert.ok(t.includes('기본 규칙이나 먼저 만든 규칙이 같은 표현을 쓰면 그쪽이 먼저 답하므로'), '미리보기가 한계를 밝히지 않는다');

  // ⑤ 옛 응답(가려짐 없음)에는 아무 말도 하지 않는다 — 모르는 것을 단정하지 않는다.
  const html = await render();
  assert.equal(html.includes('가려짐'), false, '규칙을 받기도 전에 가려졌다고 말한다');
});

/* ══════════ 디자인 스프린트 — 42차 재감사 (DS 46-1·46-2) ══════════ */

/**
 * DS 46-1 — 관리 콘솔은 **여러 사람이 같은 토큰으로** 들어오는 화면인데, 모든 쓰기 경로가
 * 「받은 대로 갈아 끼우기」였다. 편집 폼은 연 순간의 사진이고 저장은 그 사진을 통째로 덮는다:
 *  ① 그 사이 남이 고친 답변은 **말없이 사라지고**
 *  ② 그 사이 남이 지운 자료는 「수정 저장」이 **되살린다**(없는 식별자를 새로 만든다 —
 *     DS 27-3 이 같은 탭에서 닫았던 자리가 두 사람 사이에서는 그대로 열려 있었다).
 */
test('그 사이 남이 고친 것을 말없이 덮어쓰지 않는다 (DS 46-1)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  const DEPS = ['knowledge', 'normalize', 'storage', 'logger', 'monitoring', 'refusal', 'rev'];
  const store = await importLib('adminStore', DEPS);
  store.resetKB();

  const made = store.upsertKB({ question: '환불 기간은?', keywords: ['환불'], answer: '7일 이내' });
  assert.equal(made.ok, true);
  const id = made.entry.id;
  const find = () => store.listKB().find((e) => e.id === id);

  // ① 종전 식 재현 — 내가 본 모습을 들고 가지 않으면 그 사이 바뀐 것을 그대로 덮는다.
  const seen = store.kbRev(made.entry); // A 가 편집을 시작할 때 본 모습
  store.upsertKB({ id, answer: '14일 이내' }); // 그 사이 B 가 고쳤다
  assert.equal(store.upsertKB({ id, answer: '7일 이내' }).ok, true);
  assert.equal(find().answer, '7일 이내', '재현 조건이 성립하지 않는다 — 덮어쓰기가 일어나지 않았다');

  // ② 들고 가면 거절한다 — **지금 값을 함께** 돌려준다(화면이 무엇을 덮는지 보여줄 수 있어야 한다).
  store.upsertKB({ id, answer: '30일 이내' });
  const r = store.upsertKB({ id, answer: '7일 이내', baseRev: seen });
  assert.equal(r.ok, false);
  assert.equal(r.conflict, 'changed');
  assert.equal(r.current.answer, '30일 이내', '지금 저장된 값을 돌려주지 않는다');
  assert.equal(find().answer, '30일 이내', '거절해 놓고 덮어썼다');
  // 거절 문장은 화면에 그대로 뜬다 — 코드 어휘를 보이지 않는다(DS 29-3).
  assert.equal(/rev|conflict|baseRev|id/.test(r.error), false, `거절 문장에 코드 어휘가 있다: ${r.error}`);

  // ③ 지금 모습을 들고 가면 그대로 저장된다 — 없는 충돌을 만들지 않는다.
  const ok2 = store.upsertKB({ id, answer: '45일 이내', baseRev: store.kbRev(find()) });
  assert.equal(ok2.ok, true);
  assert.equal(ok2.created, false);
  assert.equal(find().answer, '45일 이내');

  // ④ 그 사이 **지워진** 자료는 「생성」으로 되살아나지 않는다.
  const goneRev = store.kbRev(find());
  assert.equal(store.deleteKB(id), true);
  const revive = store.upsertKB({ id, question: '환불 기간은?', keywords: ['환불'], answer: '7일 이내' });
  assert.equal(revive.ok && revive.created, true, '재현 조건이 성립하지 않는다 — 지운 자료가 되살아나지 않았다');
  assert.equal(store.deleteKB(id), true);
  const refused = store.upsertKB({ id, question: '환불 기간은?', keywords: ['환불'], answer: '7일 이내', baseRev: goneRev });
  assert.equal(refused.ok, false);
  assert.equal(refused.conflict, 'gone');
  assert.equal(store.listKB().some((e) => e.id === id), false, '거절해 놓고 되살렸다');

  // ⑤ 커스텀 규칙도 **같은 관문**을 지난다 — 같은 일을 두 탭이 다르게 하지 않는다.
  for (const cr of store.listCustomRules()) store.deleteCustomRule(cr.intent);
  const rule = store.upsertCustomRule({ label: '배송 문의', keywords: ['배송'], reply: '2~3일 걸려요' });
  const ruleSeen = store.customRuleRev(rule.rule);
  store.upsertCustomRule({ intent: rule.rule.intent, reply: 'B 가 고친 답변' });
  const rr = store.upsertCustomRule({ intent: rule.rule.intent, reply: 'A 가 쓴 답변', baseRev: ruleSeen });
  assert.equal(rr.ok, false);
  assert.equal(rr.conflict, 'changed');
  assert.equal(rr.current.reply, 'B 가 고친 답변');
  assert.equal(store.listCustomRules()[0].reply, 'B 가 고친 답변', '거절해 놓고 덮어썼다');
  assert.equal(store.upsertCustomRule({ intent: rule.rule.intent, reply: 'A 가 쓴 답변', baseRev: store.customRuleRev(store.listCustomRules()[0]) }).ok, true);
  store.deleteCustomRule(rule.rule.intent);
  assert.equal(store.upsertCustomRule({ intent: rule.rule.intent, label: 'x', keywords: ['배송'], reply: 'y', baseRev: ruleSeen }).conflict, 'gone');

  // ⑥ 기본 규칙 답변도 같은 자로 잰다. 켜기/끄기는 **들고 오지 않으므로** 막히지 않는다
  //    (한 칸 패치라 밀어낼 글이 없다 — 길을 막기만 하는 거절은 두지 않는다).
  const ovSeen = store.ruleOverrideRev('hours');
  store.setRuleOverride('hours', { reply: 'B 가 쓴 답변' });
  assert.equal(store.overrideConflict('hours', ovSeen), 'changed');
  assert.equal(store.overrideConflict('hours', store.ruleOverrideRev('hours')), null);
  assert.equal(store.overrideConflict('hours', undefined), null, '들고 오지 않은 요청까지 막는다');
  assert.equal(store.overrideConflict('hours', ''), null);

  // ⑦ 재는 자는 **한 벌**이다 — 같은 내용이면 같은 값, 한 글자라도 다르면 다른 값(DS 42-2).
  const a = { id: 'kb_1', category: '일반', question: 'q', keywords: ['k'], answer: 'a' };
  assert.equal(store.kbRev(a), store.kbRev({ ...a }));
  assert.notEqual(store.kbRev(a), store.kbRev({ ...a, answer: 'b' }));
  assert.notEqual(store.kbRev(a), store.kbRev({ ...a, keywords: ['k', 'k2'] }));
  // 한글 한 글자 차이를 놓치지 않는다(상위 바이트를 함께 섞지 않으면 같은 값이 될 수 있다).
  assert.notEqual(store.kbRev({ ...a, answer: '요금' }), store.kbRev({ ...a, answer: '요구' }));

  // ⑧ 문서 일괄 등록은 종전 그대로다 — 겨룰 상대가 없는 자리까지 막지 않는다.
  const bulk = store.bulkUpsertKB([{ id: 'doc_t_001', question: '문서 질문', keywords: ['문서'], answer: '문서 답변' }]);
  assert.equal(bulk.errors.length, 0);
  assert.equal(bulk.created.length + bulk.updated.length, 1);
});

/**
 * DS 46-2 — 접수 상태는 **되돌아갈 수 있었다**. A 가 완료로 바꾸면 연락처는 그 자리에서
 * 파기되는데(개인정보처리방침 4조·되돌릴 수 없다), 30초 묵은 B 의 화면은 그 접수를 그대로
 * 「상담 시작」으로 되돌릴 수 있었다 — 큐에는 **아무도 전화할 수 없는 건**이 하나 선다.
 */
test('그 사이 끝난 접수를 묵은 화면이 되돌리지 않는다 (DS 46-2)', opts, async () => {
  process.env.ADMIN_PERSIST = 'false';
  const esc = await importLib('escalation', ['handoff', 'storage', 'refusal', 'pii', 'limits', 'logger', 'monitoring', 'normalize', 'rev']);
  esc.resetTickets();

  const t = esc.createTicket({ sessionId: 's-1', tenant: null, message: '전화 주세요', contact: '010-1234-5678' }).ticket;
  const seen = esc.ticketRev(t); // B 의 화면이 받은 모습

  // ① A 가 완료 처리 — 연락처는 그 자리에서 파기된다.
  const done = esc.updateTicket(t.id, { status: 'resolved' });
  assert.equal(done.ok, true);
  assert.equal(done.ticket.contact, undefined);
  assert.ok(done.ticket.contactPurgedAt, '파기 사실이 남지 않는다');

  // ② 종전 식 재현 — 묵은 화면의 「상담 시작」이 그대로 되돌린다(회신할 곳 없는 대기 건이 생긴다).
  const back = esc.updateTicket(t.id, { status: 'in_progress' });
  assert.equal(back.ok, true);
  assert.equal(back.ticket.status, 'in_progress', '재현 조건이 성립하지 않는다');
  assert.equal(back.ticket.contact, undefined, '파기한 연락처가 되살아났다');

  // ③ 내가 본 모습을 들고 가면 거절한다 — **지금 무엇인지**를 이름으로 말한다.
  assert.equal(esc.updateTicket(t.id, { status: 'resolved' }).ok, true);
  const r = esc.updateTicket(t.id, { status: 'in_progress', baseRev: seen });
  assert.equal(r.ok, false);
  assert.equal(r.conflict, 'changed');
  assert.ok(r.error.includes('완료'), `지금 무엇인지 말하지 않는다: ${r.error}`);
  assert.equal(/resolved|rev|conflict|status/.test(r.error), false, `거절 문장에 코드 어휘가 있다: ${r.error}`);
  assert.equal(esc.getTicket(t.id).status, 'resolved', '거절해 놓고 바꿨다');

  // ④ 지금 모습을 들고 가면 바뀐다. 들고 오지 않으면 종전 그대로다(옛 화면을 막지 않는다).
  assert.equal(esc.updateTicket(t.id, { status: 'open', baseRev: esc.ticketRev(esc.getTicket(t.id)) }).ok, true);
  assert.equal(esc.updateTicket(t.id, { status: 'resolved' }).ok, true);

  // ⑤ 같은 접수를 둘이 붙잡는 자리 — 뒤의 요청은 앞의 변경을 모른 채 들어온다.
  const two = esc.createTicket({ sessionId: 's-2', tenant: null, message: '연락 바랍니다' }).ticket;
  const bothSaw = esc.ticketRev(two);
  assert.equal(esc.updateTicket(two.id, { status: 'in_progress', baseRev: bothSaw }).ok, true);
  const second = esc.updateTicket(two.id, { status: 'in_progress', baseRev: bothSaw });
  assert.equal(second.ok, false, '둘 다 자기가 처음 붙잡았다고 믿는다');
  assert.equal(second.conflict, 'changed');

  // ⑥ 없는 접수는 「바뀜」이 아니라 「사라짐」이다 — 두 사실에 다른 말을 한다.
  const none = esc.updateTicket('ESC-9999', { status: 'resolved', baseRev: bothSaw });
  assert.equal(none.ok, false);
  assert.equal(none.conflict, 'gone');
  assert.notEqual(none.error, second.error);

  // ⑦ 모습은 **상태·메모·연락처 유무·시각**으로 만든다 — 같은 값으로 되돌아와도 손댄 것을 안다.
  const three = esc.createTicket({ sessionId: 's-3', tenant: null, message: '…' }).ticket;
  const before = esc.ticketRev(three);
  assert.equal(esc.updateTicket(three.id, { note: '메모' }).ok, true);
  assert.notEqual(esc.ticketRev(esc.getTicket(three.id)), before, '메모만 바뀐 것을 모른다');
});

/**
 * DS 46-1·46-2 — 화면 쪽 배선: **무엇을 보고 고치기 시작했는지**를 들고 다니고, 거절당했을 때
 * 적던 글을 버리지 않으며, 그 자리에서 다음 길(불러오기·덮어쓰기·새로 등록)을 준다.
 */
test('편집 폼이 「내가 본 모습」을 들고 다니고 거절을 그 자리에서 말한다 (DS 46-1·46-2)', opts, async () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const kbRoute = readFileSync(new URL('../src/app/api/admin/kb/route.ts', import.meta.url), 'utf8');
  const ruleRoute = readFileSync(new URL('../src/app/api/admin/rules/route.ts', import.meta.url), 'utf8');
  const escRoute = readFileSync(new URL('../src/app/api/admin/escalations/route.ts', import.meta.url), 'utf8');
  const store = readFileSync(new URL('../src/lib/adminStore.ts', import.meta.url), 'utf8');
  const refusal = readFileSync(new URL('../src/lib/refusal.ts', import.meta.url), 'utf8');

  // ① 재는 자는 한 벌이고(`@/lib/rev`), 목록 응답이 그 값을 실어 보낸다.
  assert.match(store, /export function kbRev\(e: KBEntry\): string/, '자료의 모습을 재는 자가 없다');
  assert.match(store, /export function customRuleRev\(r: CustomRule\): string/, '규칙의 모습을 재는 자가 없다');
  assert.match(kbRoute, /entries: listKB\(\)\.map\(\(e\) => \(\{ \.\.\.e, rev: kbRev\(e\) \}\)\)/, '자료 목록이 모습을 싣지 않는다');
  assert.match(ruleRoute, /rev: customRuleRev\(r\)/, '규칙 목록이 모습을 싣지 않는다');
  assert.match(ruleRoute, /rev: ruleOverrideRev\(r\.intent\)/, '기본 규칙 목록이 모습을 싣지 않는다');
  assert.match(escRoute, /rev: ticketRev\(t\)/, '접수 목록이 모습을 싣지 않는다');
  // 콘솔이 모습을 **따로 계산하지 않는다** — 두 벌이면 영영 어긋나거나 영영 같아진다(DS 42-2).
  assert.equal(/from '@\/lib\/rev'/.test(src), false, '콘솔이 모습을 따로 계산한다');

  // ② 거절 문장은 거절하는 한 곳에 있다(DS 29-3) — 콘솔·서버가 각자 적지 않는다.
  assert.match(refusal, /export const CHANGED_TARGET_MESSAGE =/, '바뀐 대상을 말하는 문장이 없다');
  assert.match(refusal, /export function changedStatusMessage\(statusLabel: string\): string/, '접수가 지금 무엇인지 말하는 문장이 없다');
  assert.equal(/그 사이 다른 화면에서 이 항목이 바뀌었습니다/.test(src), false, '콘솔이 서버 문장을 베껴 적는다');

  // ③ 편집을 시작할 때 본 모습을 들고, 저장할 때 돌려보낸다(새 자료에는 들고 갈 것이 없다).
  assert.match(src, /setEditingRev\(e\.rev \?\? null\)/, '자료 편집이 본 모습을 들고 있지 않다');
  assert.match(src, /setCrEditingRev\(r\.rev \?\? null\)/, '규칙 편집이 본 모습을 들고 있지 않다');
  assert.match(src, /\.\.\.\(editingId && editingRev \? \{ baseRev: editingRev \} : \{\}\)/, '자료 저장이 본 모습을 보내지 않는다');
  assert.match(src, /\.\.\.\(crEditing && crEditingRev \? \{ baseRev: crEditingRev \} : \{\}\)/, '규칙 저장이 본 모습을 보내지 않는다');
  assert.match(src, /\.\.\.\(target\?\.rev \? \{ baseRev: target\.rev \} : \{\}\)/, '접수 상태 변경이 본 모습을 보내지 않는다');
  // 켜기/끄기는 들고 가지 않는다 — 밀어낼 글이 없는데 막으면 길만 막는다.
  assert.match(src, /const base = patch\.reply !== undefined \? rules\.find\(\(r\) => r\.intent === intent\)\?\.rev : undefined;/, '기본 규칙 저장이 답변일 때만 모습을 들고 가지 않는다');

  // ④ 거절당해도 **적던 글은 그대로** 둔다 — 폼을 거두는 문보다 먼저 돌아선다.
  const submit = src.slice(src.indexOf('const submitKB = async ()'), src.indexOf('const reloadKbConflict'));
  assert.match(submit, /if \(data\.conflict\) \{/, '자료 저장이 「그 사이 바뀜」을 가려내지 않는다');
  assert.ok(submit.indexOf('setKbConflict({') < submit.indexOf('loadKbForm(EMPTY_FORM)'), '거절당한 자리에서 적던 글을 버린다');

  // ⑤ 그 자리에서 다음 길을 준다 — 불러오기(확인을 거친다)·덮어쓰기, 지워진 것에는 새로 등록.
  assert.match(src, /function ConflictNote\(\{ notice, nowLabel, onReload, onOverwrite, onRecreate \}/, '그 자리에서 말하는 자리가 없다');
  assert.ok(src.includes('그 사이 다른 화면에서 바뀌었습니다'), '무슨 일이 일어났는지 말하지 않는다');
  assert.ok(src.includes('그 사이 다른 화면에서 지워졌습니다'), '지워진 것을 바뀐 것과 같이 말한다');
  assert.ok(src.includes('적으신 내용은 이 칸에 그대로 있습니다'), '적던 글이 남아 있다는 사실을 말하지 않는다');
  assert.ok(src.includes('지금 저장된 내용 불러오기') && src.includes('내가 적은 내용으로 덮어쓰기'), '다음 길이 없다');
  assert.ok(src.includes('이 내용으로 새로 등록하기'), '지워진 자료에서 갈 곳이 없다');
  assert.match(src, /title: '지금 저장된 내용을 불러올까요\?'/, '적던 글을 확인 없이 버린다');
  // 지워진 자료를 되살릴 때는 「수정」이라 말하지 않는다 — 변경 이력에는 「생성」으로 남는다.
  assert.match(src, /const recreateKbConflict = \(\) => \{\n\s*setEditingId\(null\);/, '지워진 자료를 수정이라 부른다');

  // ⑥ 접수는 「바꾸지 않았다」는 사실까지 말하고 목록을 새로 받는다(그 줄이 지금 값으로 돌아온다).
  const pt = src.slice(src.indexOf('const patchTicket = async ('), src.indexOf('// ---- Test ----'));
  assert.match(pt, /} else if \(data\.conflict\) \{/, '접수가 「그 사이 바뀜」을 가려내지 않는다');
  assert.ok(pt.includes('이번 변경은 적용되지 않았습니다'), '바꾸지 않았다는 사실을 말하지 않는다');
  assert.match(pt, /await loadEsc\(\);\n\s*notify\(/, '거절당한 줄을 묵은 값 그대로 둔다');

  // ⑦ 서버는 「입력이 틀렸다」와 다른 코드로 돌려준다 — 화면이 둘을 다르게 다룬다.
  assert.match(kbRoute, /return fail\('conflict', result\.error, \{/, '자료 저장이 충돌을 입력 오류로 돌려준다');
  assert.match(ruleRoute, /return fail\('conflict', result\.error, \{/, '규칙 저장이 충돌을 입력 오류로 돌려준다');
  assert.match(escRoute, /if \(result\.conflict === 'changed'\) \{/, '접수가 충돌을 「없는 접수」로 돌려준다');

  // ⑧ 첫 렌더에는 아무 경고도 없다 — 겪기 전에 말하지 않는다.
  const html = await render();
  assert.equal(html.includes('그 사이 다른 화면에서'), false, '겪기도 전에 바뀌었다고 말한다');
});

/* ══════════ 디자인 스프린트 — 44차 재감사 (DS 47-1·47-2·47-3) ══════════ */

/**
 * 저장소와 스토어가 **같은 한 벌**을 보게 한 번에 컴파일한다.
 * `importLib` 를 따로 두 번 부르면 컴파일 키가 달라 서로 다른 `storage` 인스턴스를 들고
 * 돌아온다 — 드라이버를 바꿔도 스토어 쪽은 꿈쩍하지 않는다.
 */
async function loadPersistLibs(dir) {
  process.env.STORAGE_DIR = dir;
  const out = compileLibs(['adminStore', 'partners', 'storage', 'knowledge', 'normalize', 'logger', 'monitoring', 'refusal', 'rev', 'pii']);
  const load = (n) => import(pathToFileURL(path.join(out, `${n}.mjs`)).href);
  return { storage: await load('storage'), store: await load('adminStore'), partners: await load('partners') };
}

/**
 * DS 47-1 — 이 제품은 「서버 메모리에 반영됨」과 「디스크에 보관됨」을 한 번도 구분해 말하지
 * 않았다. 쓰기 라우트는 메모리를 갈아 끼운 뒤 곧바로 성공을 돌려주고, 디스크 쓰기는 응답
 * **뒤** 300ms 디바운스 타이머(`unref()`)에 맡겼다. 그래서
 *  ① 「저장되었습니다」라고 말하는 그 순간 디스크에는 아무것도 닿지 않았고
 *  ② 뒤이어 쓰기가 실패해도(읽기전용 FS — 라이브 배포의 기본값) 그 사실은 저장소 상태 탭에만 남고
 *  ③ 백업 복원은 파트너·고객사를 **디스크에 적지도 않았다**(관리 콘텐츠 쪽만 적었다).
 */
test('저장했다는 말이 디스크를 보고 나온다 (DS 47-1)', opts, async () => {
  delete process.env.ADMIN_PERSIST;
  const dir = mkdtempSync(path.join(tmpdir(), 'gowon-persist-'));
  const { storage, store, partners } = await loadPersistLibs(dir);
  storage.setDriver('file');
  const file = path.join(dir, 'admin.json');
  const diskHas = (s) => existsSync(file) && readFileSync(file, 'utf8').includes(s);

  // ① 종전 식 재현 — 저장 함수가 돌아온 그 순간 디스크에는 아무것도 없다(쓰기는 뒤에 일어난다).
  store.resetKB();
  storage.resetStorageState(); // 대기 중인 쓰기를 거둔다 — 아직 디스크는 비어 있다
  assert.equal(existsSync(file), false, '재현 조건이 성립하지 않는다 — 이미 파일이 있다');
  const made = store.upsertKB({ question: '환불 기간은?', keywords: ['환불'], answer: '7일 이내' });
  assert.equal(made.ok, true);
  assert.equal(existsSync(file), false, '재현 조건이 성립하지 않는다 — 디바운스 없이 즉시 쓰였다');

  // ② 「저장되었습니다」라고 말하기 전에 지나는 문 — 지나면 디스크에 있다.
  assert.deepEqual(store.saveAdminNow(), { persisted: true });
  assert.ok(diskHas('7일 이내'), '보관했다고 답했는데 디스크에 없다');

  // ③ 바뀐 것이 없으면 그대로 「보관됨」이다 — 없는 실패를 만들지 않는다.
  assert.deepEqual(store.saveAdminNow(), { persisted: true });

  // ④ 쓰기가 실패하는 환경(읽기전용 FS)에서는 **보관되지 않았다고 말한다**.
  storage.setDriver({
    name: 'file',
    read: () => null,
    write: () => { throw Object.assign(new Error("EROFS: read-only file system, open '/var/task/data/admin.json'"), { code: 'EROFS' }); },
    remove: () => {},
  });
  store.upsertKB({ id: made.entry.id, answer: '14일 이내' });
  const refused = store.saveAdminNow();
  assert.equal(refused.persisted, false, '쓰기가 실패했는데 보관했다고 말한다');
  assert.equal(refused.reason, 'readonly');
  // 사유는 **코드**로만 간다 — 오류 원문·파일 경로가 화면까지 가지 않는다(DS 29-3).
  const wire = JSON.stringify(refused);
  assert.equal(/EROFS|var\/task|admin\.json/.test(wire), false, `오류 원문이 화면으로 간다: ${wire}`);
  // 보관만 못 한 것이다 — 화면 속 값과 서비스는 멀쩡하다.
  assert.equal(store.listKB().find((e) => e.id === made.entry.id).answer, '14일 이내');
  assert.equal(storage.storageStatus().namespaces.find((n) => n.ns === 'admin').health, 'readonly', '사유가 상태에 남지 않는다');

  // ⑤ 저장이 꺼진 배포에서는 **다른 사유**를 말한다(읽기전용과 섞지 않는다).
  storage.setDriver('file');
  process.env.ADMIN_PERSIST = 'false';
  store.upsertKB({ id: made.entry.id, answer: '30일 이내' });
  assert.deepEqual(store.saveAdminNow(), { persisted: false, reason: 'disabled' });
  delete process.env.ADMIN_PERSIST;

  // ⑥ 백업 복원이 **디스크에 적는다** — 종전에는 파트너·고객사만 메모리에 갈아 끼우고 끝났다.
  const pfile = path.join(dir, 'partners.json');
  const iso = new Date().toISOString();
  const snap = {
    version: 1, savedAt: iso, partnerSeq: 1, accountSeq: 1,
    partners: [{ id: 'PTR-0001', name: '제이투모로우원', status: 'active', feeRateBp: 1000, createdAt: iso, updatedAt: iso }],
    accounts: [{ id: 'ACC-0001', name: '이음', partnerId: 'PTR-0001', source: 'partner', status: 'contracted', contractedAt: '2026-09-01', createdAt: iso, updatedAt: iso }],
  };
  const restored = partners.importPartners(snap);
  assert.equal(restored.ok, true);
  assert.deepEqual(restored.saved, { persisted: true });
  assert.ok(existsSync(pfile), '복원한 파트너가 디스크에 없다 — 재시작하면 복원 전으로 돌아간다');
  assert.ok(readFileSync(pfile, 'utf8').includes('제이투모로우원'), '복원한 파트너가 디스크에 없다');
  assert.ok(readFileSync(pfile, 'utf8').includes('이음'), '복원한 고객사가 디스크에 없다');

  // 기동 때 읽어 들이는 길은 **되쓰지 않는다** — 방금 읽은 것을 다시 적지 않는다.
  assert.equal(partners.importPartners(snap, { persist: false }).saved, undefined, '읽어 들이기가 디스크를 되쓴다');

  // ⑦ 파트너 쪽도 같은 문을 지난다(같은 일을 두 탭이 다르게 하지 않는다).
  partners.upsertPartner({ name: '새 파트너' });
  assert.deepEqual(partners.savePartnersNow(), { persisted: true });

  partners.resetPartners();
  store.resetKB();
  delete process.env.STORAGE_DIR;
});

/**
 * DS 47-1 (배선) — 쓰기 응답이 보관 결과를 싣고, 화면이 그것을 **머무는 안내**로 말한다.
 */
test('쓰기 응답이 보관 결과를 싣고 화면이 그 사실을 말한다 (DS 47-1)', opts, async () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const routes = {
    '안내 자료': readFileSync(new URL('../src/app/api/admin/kb/route.ts', import.meta.url), 'utf8'),
    '문서 등록': readFileSync(new URL('../src/app/api/admin/kb/import/route.ts', import.meta.url), 'utf8'),
    '규칙': readFileSync(new URL('../src/app/api/admin/rules/route.ts', import.meta.url), 'utf8'),
    '파트너': readFileSync(new URL('../src/app/api/admin/partners/route.ts', import.meta.url), 'utf8'),
    '백업 복원': readFileSync(new URL('../src/app/api/admin/backup/route.ts', import.meta.url), 'utf8'),
  };
  // ① 쓰기 라우트는 하나도 빠짐없이 보관 결과를 싣는다.
  for (const [what, route] of Object.entries(routes)) {
    assert.match(route, /saved/, `${what} 쓰기가 보관 결과를 보내지 않는다`);
  }
  assert.match(routes['안내 자료'], /saved: saveAdminNow\(\)/, '자료 저장이 디스크를 보지 않는다');
  assert.match(routes['규칙'], /saved: saveAdminNow\(\)/, '규칙 저장이 디스크를 보지 않는다');
  assert.match(routes['파트너'], /saved: savePartnersNow\(\)/, '파트너 저장이 디스크를 보지 않는다');

  // ② 사유 문장은 **한 벌**이다 — 저장소 상태 패널과 같은 사전을 쓴다(두 군데서 다르게 적지 않는다).
  assert.match(src, /function savedWarning\(saved: SavedView \| undefined \| null\): string \| null \{/, '보관 결과를 말하는 한 곳이 없다');
  assert.match(src, /STORAGE_HEALTH\[saved\.reason\]\?\.hint/, '사유 문장을 베껴 적었다');
  assert.ok(src.includes('다만 이 변경은 서버에 보관되지 않았습니다'), '무슨 일이 일어났는지 말하지 않는다');
  // 「아래」처럼 자리를 가리키는 말이 섞이면 토스트에서는 가리킬 곳이 없다 — 두 자리가 같은 문장을 쓴다.
  assert.equal(/hint: '아래/.test(src), false, '토스트에서 가리킬 수 없는 자리를 가리킨다');

  // ③ 그 안내는 **머물러 있다** — 2.5초 뒤 사라지면 「백업을 받아 두세요」가 전달되지 않는다(DS 29-2).
  const gate = src.slice(src.indexOf('const flashSaved = ('), src.indexOf('const flashSaved = (') + 400);
  assert.match(gate, /notify\(`\$\{msg\} \$\{warn\}`, 'fail'\)/, '보관 실패 안내가 스스로 사라진다');

  // ④ 저장·삭제를 말하는 자리는 전부 그 문을 지난다 — 한 자리라도 빠지면 그 화면만 거짓이 된다.
  assert.equal(/\bflash\('삭제되었습니다/.test(src), false, '자료 삭제가 보관 결과를 보지 않는다');
  for (const sig of [
    /flashSaved\(editingId \? '수정되었습니다/,
    /flashSaved\('삭제되었습니다\.', data\.saved/,
    /flashSaved\('기본 지식베이스로 초기화했습니다\.', data\.saved/,
    /flashSaved\(crEditing \? '규칙을 수정했습니다/,
    /flashSaved\('규칙을 삭제했습니다\.', data\.saved/,
    /flashSaved\(data\.created \? '파트너를 등록했습니다/,
    /flashSaved\(data\.created \? '고객사를 등록했습니다/,
    /flashSaved\('파트너를 삭제했습니다\.', data\.saved/,
  ]) assert.match(src, sig, `보관 결과를 보지 않는 저장 안내가 있다: ${sig}`);
  // 복원은 「모두 덮어씁니다」라고 말하고 확인까지 받은 자리다 — 그것이 디스크까지 갔는지 말한다.
  // 귀속 파트너를 찾을 수 없는 고객사가 있으면 **사라지지 않는 쪽**으로 가는데(DS 53-3),
  // 그 길에도 보관 사실을 덧붙인다(토스트는 한 번에 하나다 · 아래 ⑤ 와 같은 규칙).
  assert.match(src, /const done = `복원 완료:/, '복원이 결과 문장을 만들지 않는다');
  assert.match(src, /flashSaved\(done, data\.saved as SavedView \| undefined\);/, '복원이 보관 결과를 보지 않는다');
  // 55차(DS 55-3)에 「같은 식별자 중복」이 같은 자리에 더해지면서 문장을 모으는 식이 바뀌었다 —
  // 고정하는 것은 그대로다: 사라지지 않는 그 안내가 보관 사실을 **덮지 않는다**.
  assert.match(src, /const warn = savedWarning\(data\.saved as SavedView \| undefined\);[\s\S]{0,300}?warn \? ` \$\{warn\}` : ''/, '귀속 안내가 보관 사실을 덮는다');

  // ⑤ 이미 머무는 안내(쓰이지 않는 규칙·남는 조각)에는 **덧붙인다** — 토스트는 한 번에 하나다.
  assert.match(src, /목록에서 다음에 할 일을 확인해 주세요\.\$\{savedWarn \? ` \$\{savedWarn\}` : ''\}/, '쓰이지 않는 규칙 안내가 보관 사실을 덮는다');
  // 58차(DS 58-3)에 「검색어 없어 빠진 조각」이 같은 토스트에 더해지면서 문장을 모으는 식이
  // 바뀌었다 — 고정하는 것은 그대로다: 머무는 두 안내가 보관 사실을 **덮지 않는다**.
  assert.match(src, /\$\{done\}\$\{stale\}\$\{left\}\$\{warn \? ` \$\{warn\}` : ''\}/, '남는 조각·빠진 조각 안내가 보관 사실을 덮는다');
  assert.match(src, /아래에서 확인해 주세요\.` : ''/, '머무는 안내가 「아래」를 가리키지 않는다');

  // ⑥ 첫 렌더에는 아무 경고도 없다 — 겪기 전에 말하지 않는다.
  const html = await render();
  assert.equal(html.includes('서버에 보관되지 않'), false, '겪기도 전에 보관 실패를 말한다');
});

/**
 * DS 47-2 — 「보관할 수 있는가」와 「보관한 적이 있는가」를 `persisted` 한 칸으로 답했다.
 * 접수 탭은 그 값만 보고 사유를 「저장 승인 전」으로 단정했다 — 승인이 **이미 난** 환경에서도
 * 첫 접수가 들어오기 전에는 false 라서, 멀쩡히 보관되는 접수를 두고 「재시작되면 사라집니다」라고
 * 말했다. `/api/health` 는 그 반대쪽이다: 주석은 읽기전용을 degraded 라 적어 두었는데 코드는
 * `error` 만 세어, 모든 쓰기가 실패하는 동안에도 밖에서 보는 신호등이 초록이었다.
 */
test('보관되지 않는 사유를 틀리게 말하지 않는다 (DS 47-2)', opts, async () => {
  delete process.env.ADMIN_PERSIST;
  const dir = mkdtempSync(path.join(tmpdir(), 'gowon-persist2-'));
  const { storage } = await loadPersistLibs(dir);
  storage.setDriver('file');
  const nsOf = (ns) => storage.storageStatus().namespaces.find((n) => n.ns === ns);

  // ① 승인이 **나지 않은** 환경 — 사유는 「승인 대기」다.
  delete process.env.PERSIST_PII;
  storage.resetStorageState();
  assert.equal(storage.loadJson('tickets').ok, false);
  assert.equal(nsOf('tickets').health, 'awaiting_approval');
  assert.equal(nsOf('tickets').persisted, false);

  // ② 승인이 **난** 환경인데 아직 저장분이 없다 — 종전 식 재현: `persisted` 는 여전히 false 다.
  //    그 값으로 사유를 단정하면 **이미 난 승인을 안 났다고** 말한다.
  process.env.PERSIST_PII = 'true';
  storage.resetStorageState();
  assert.equal(storage.loadJson('tickets').reason, 'empty');
  assert.equal(nsOf('tickets').persisted, false, '재현 조건이 성립하지 않는다');
  assert.equal(nsOf('tickets').health, 'empty', '승인이 난 환경을 승인 대기라 말한다');
  delete process.env.PERSIST_PII;

  // ③ 화면은 `persisted` 가 아니라 **사유를 아는 칸**을 읽고, 문장도 한 벌을 쓴다.
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  assert.equal(/ticketsPersisted/.test(src), false, '접수 탭이 보관 이력으로 사유를 단정한다');
  assert.match(src, /const ticketsHealth = storage\?\.namespaces\.find\(\(n\) => n\.ns === 'tickets'\)\?\.health \?\? null;/, '접수 탭이 사유를 읽지 않는다');
  assert.match(src, /ticketsHealth !== 'ok' && ticketsHealth !== 'empty'/, '보관되는 상태에도 경고를 띄운다');
  assert.match(src, /STORAGE_HEALTH\[ticketsHealth\]\.hint/, '사유 문장을 베껴 적었다');
  assert.equal(src.includes('저장 승인 전까지는 서비스가 재시작되면 사라집니다'), false, '사유를 단정하는 문장이 남아 있다');

  // ④ 밖에서 보는 신호등 — **보관해야 하는데 못 하는 것**을 센다.
  const health = readFileSync(new URL('../src/app/api/health/route.ts', import.meta.url), 'utf8');
  assert.match(health, /n\.health === 'error' \|\| n\.health === 'readonly'/, '읽기전용 환경을 정상이라 보고한다');
  // 의도된 설정(승인 대기·저장 끔)은 degraded 가 아니다 — 영영 노랑인 신호등은 뜻이 없다.
  const judge = health.slice(health.indexOf('const failing'), health.indexOf('const failing') + 200);
  assert.equal(/awaiting_approval|disabled/.test(judge), false, '의도된 설정까지 장애로 센다');

  delete process.env.STORAGE_DIR;
});

/**
 * DS 47-3 — 저장소 상태 카드의 제목은 화면이 **베껴 적은 사전**에서 왔다. 서버는 같은 이름을
 * 이미 들고 있었는데(`NAMESPACES[].label`) 응답에 싣지 않아 두 벌이 되었고, 그 뒤 늘어난 두 칸
 * (파트너·귀속 / 답변 평가)이 사전에 없어 카드 제목에 `partners`·`feedback` 이라는 **영문 코드가
 * 그대로** 그려졌다 — 콘솔 진단이 걷어낸 바로 그 내부 문구다.
 */
test('저장 영역 이름을 화면이 베껴 적지 않는다 (DS 47-3)', opts, async () => {
  delete process.env.ADMIN_PERSIST;
  const dir = mkdtempSync(path.join(tmpdir(), 'gowon-persist3-'));
  const { storage } = await loadPersistLibs(dir);

  // ① 모든 저장 영역에 **사람 말 이름**이 있다 — 새 영역이 늘면 이 검사가 먼저 걸린다.
  const list = storage.storageStatus().namespaces;
  assert.ok(list.length >= 6, `저장 영역이 줄었다: ${list.length}`);
  for (const n of list) {
    assert.ok(n.label && n.label !== n.ns, `이름 없는 저장 영역: ${n.ns}`);
    assert.equal(/^[ -~]+$/.test(n.label), false, `영문 코드가 이름 자리에 있다: ${n.ns} → ${n.label}`);
  }
  // 종전에 화면 사전에 없어 코드가 뜨던 두 칸.
  assert.equal(list.find((n) => n.ns === 'partners').label, '파트너·귀속');
  assert.equal(list.find((n) => n.ns === 'feedback').label, '답변 평가');
  // 개인정보가 들어 있다는 사실은 이름에 적는다 — 승인 대기의 사유가 그것이다.
  for (const ns of ['tickets', 'convlog']) {
    assert.match(list.find((n) => n.ns === ns).label, /개인정보/, `개인정보 영역임을 이름이 말하지 않는다: ${ns}`);
  }

  // ② 이름은 서버가 보내고, 화면은 사전을 들고 있지 않다.
  const health = readFileSync(new URL('../src/app/api/health/route.ts', import.meta.url), 'utf8');
  assert.match(health, /label: n\.label/, '이름을 응답에 싣지 않는다');
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  assert.equal(/STORAGE_NS_LABELS/.test(src), false, '화면이 이름 사전을 베껴 들고 있다');
  assert.match(src, /\{n\.label \|\| UNNAMED_STORAGE_NS\}/, '카드 제목이 서버가 보낸 이름을 쓰지 않는다');
  // 이름을 모르면 코드를 그리는 대신 사람 말로 뭉갠다(옛 응답을 받았을 때의 마지막 그물).
  assert.match(src, /const UNNAMED_STORAGE_NS = '저장 영역';/, '이름을 모를 때 코드가 뜬다');

  delete process.env.STORAGE_DIR;
});

/* ══════════ 디자인 스프린트 — 45차 재감사 (DS 48-1·48-2·48-3) ══════════ */

/** 변경 이력과 저장소를 **같은 한 벌**로 컴파일한다(드라이버를 바꾸면 양쪽이 같이 움직이도록). */
async function loadAuditLibs(dir) {
  process.env.STORAGE_DIR = dir;
  const out = compileLibs(['audit', 'storage', 'csv', 'kst', 'refusal', 'retention', 'logger', 'monitoring']);
  const load = (n) => import(pathToFileURL(path.join(out, `${n}.mjs`)).href);
  return { storage: await load('storage'), audit: await load('audit') };
}

/** 내려받기 파일의 꼬리 주석만 — 표와 빈 줄로 떨어져 있고 모두 `#` 로 시작한다. */
function csvNotes(csv) {
  return csv.split('\r\n').filter((l) => l.startsWith('# ') || l.startsWith('"# '));
}

/**
 * DS 48-1 — 변경 이력은 「누가 무엇을 바꿨는가」의 증거인데 **빠진 것을 말하지 않았다**.
 * 서버는 최근 500건만 들고 한도를 넘기면 가장 오래된 것을 말없이 버리는데
 *  ① 화면은 「최근 100건」이라고만 적었고(그 100건이 전부인지 일부인지 말하지 않았다)
 *  ② 내려받은 파일은 한도를 한 글자도 말하지 않아 받는 사람이 **전체 이력으로 읽었다**.
 * 43차가 대화 기록에 세운 규칙(DS 43-1)이 정작 증거 쪽에는 서 있지 않았다.
 */
test('변경 이력이 「무엇까지 들고 있는가」를 말한다 (DS 48-1)', opts, async () => {
  delete process.env.ADMIN_PERSIST;
  const dir = mkdtempSync(path.join(tmpdir(), 'gowon-audit1-'));
  const { audit } = await loadAuditLibs(dir);

  // ① 모수를 답하는 한 곳이 있다 — 대화 기록(`turnRetention`)과 **같은 모양**이다.
  audit.resetAudit();
  for (const q of ['환불', '배송', '예약']) audit.logAudit({ action: 'kb.upsert', target: q, detail: `수정: ${q}`, authed: true });
  const r = audit.auditRetention();
  assert.deepEqual(Object.keys(r).sort(), ['dropped', 'kept', 'knownFrom', 'limit'], '모수의 모양이 대화 기록과 다르다');
  assert.equal(r.kept, 3);
  assert.equal(r.limit, 500);
  assert.equal(r.dropped, false, '버린 적이 없는데 버렸다고 말한다');
  assert.equal(audit.auditCount(), 3);

  // ② 내려받는 파일이 제 모수를 말한다 — 종전에는 시각 기준 한 줄뿐이었다.
  const notes = csvNotes(audit.auditToCsv()).join('\n');
  assert.ok(notes.includes('한국 시간'), '파일이 시각 기준을 말하지 않는다');
  assert.ok(notes.includes('관리 작업 3건'), `담긴 건수를 말하지 않는다:\n${notes}`);
  assert.ok(notes.includes('보관 한도 500건'), '보관 한도를 말하지 않는다');
  assert.ok(notes.includes('이후의 기록만 담겨 있습니다'), '언제부터의 기록인지 말하지 않는다');
  assert.ok(notes.includes('「관리 작업 0건」이 아니라 「기록 없음」'), '빈 기간을 0건으로 읽게 둔다');
  // 조사는 받침에 맞춘다 — 화면 말에 「은(는)」을 남기지 않는다(DS 29-3 과 같은 규칙).
  assert.ok(notes.includes('오래된 관리 작업은'), `조사가 어긋났다:\n${notes}`);
  assert.equal(csvNotes(audit.auditToCsv()).length, 3, '주석 수가 다르다');

  // ③ 종전 식 재현 — 한도를 넘기면 가장 오래된 기록이 **말없이** 사라진다.
  audit.resetAudit();
  for (let i = 0; i < 505; i += 1) audit.logAudit({ action: 'kb.delete', target: `K-${i}`, authed: true });
  const kept = audit.listAudit(500);
  assert.equal(kept.length, 500, '재현 조건이 성립하지 않는다');
  assert.equal(kept.some((e) => e.target === 'K-0'), false, '재현 조건이 성립하지 않는다 — 버려지지 않았다');
  // 이제는 **버렸다는 사실이 남는다**(그 앞은 「변경 없음」이 아니라 「기록 없음」이다).
  const after = audit.auditRetention();
  assert.equal(after.dropped, true, '버린 사실이 남지 않는다');
  assert.equal(after.kept, 500);
  assert.equal(after.knownFrom, kept[kept.length - 1].at, '경계가 남은 가장 오래된 기록을 가리키지 않는다');

  // ④ 두 내려받기 파일이 **같은 틀**로 말한다 — 나란히 받은 사람이 기준을 헷갈리지 않게.
  const auditSrc = readFileSync(new URL('../src/lib/audit.ts', import.meta.url), 'utf8');
  const convSrc = readFileSync(new URL('../src/lib/convlog.ts', import.meta.url), 'utf8');
  for (const [what, s] of [['변경 이력', auditSrc], ['대화 기록', convSrc]]) {
    assert.match(s, /from '@\/lib\/retention'/, `${what} 이 보관 범위를 제 손으로 적는다`);
    assert.match(s, /retentionNotes\(/, `${what} 파일이 모수를 한 벌로 말하지 않는다`);
  }

  // ⑤ 화면·응답 배선 — 서버가 모수를 싣고, 화면이 보여 준 수를 전부라 말하지 않는다.
  const route = readFileSync(new URL('../src/app/api/admin/audit/route.ts', import.meta.url), 'utf8');
  assert.match(route, /retention: auditRetention\(\)/, '응답이 모수를 싣지 않는다');
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  assert.match(src, /setAuditRange\(\(data\.retention as RetentionView \| undefined\) \|\| null\)/, '화면이 모수를 받지 않는다');
  assert.ok(src.includes('보관 중인 ${comma(auditRange.kept)}건 중 최근'), '보여 준 수의 모수를 적지 않는다');
  assert.ok(src.includes('한도를 넘어선 더 오래된 기록은 서버에도 남아 있지 않습니다'), '버린 사실을 화면이 말하지 않는다');
  assert.equal(src.includes('백업 복원 이력(최근 100건)'), false, '보여 준 수를 전부라 말하던 문장이 남아 있다');

  audit.resetAudit();
  delete process.env.STORAGE_DIR;
});

/**
 * DS 48-2 — 44차(DS 47-1)가 안내 자료·규칙·파트너 저장에 「보관되지 않았습니다」를 붙였는데,
 * 정작 **변경 이력 자신**은 아무 말도 하지 않았다. 이 기록의 쓰기도 같은 디바운스를 쓰므로
 * 읽기전용 환경에서는 메모리에만 남고, 재시작하면 「누가 무엇을 바꿨는가」가 통째로 사라진다.
 */
test('변경 이력이 자기 보관 상태를 말한다 (DS 48-2)', opts, async () => {
  delete process.env.ADMIN_PERSIST;
  const dir = mkdtempSync(path.join(tmpdir(), 'gowon-audit2-'));
  const { audit, storage } = await loadAuditLibs(dir);

  // ① 쓰기가 막힌 환경 — 기록은 남지만 **디스크에는 닿지 않는다**(서비스는 멀쩡하다).
  audit.resetAudit();
  storage.resetStorageState();
  storage.setDriver({
    name: 'file',
    read: () => null,
    write: () => { throw Object.assign(new Error("EROFS: read-only file system, open '/var/task/data/audit.json'"), { code: 'EROFS' }); },
    remove: () => {},
  });
  audit.logAudit({ action: 'backup.restore', target: 'snap', detail: '복원', authed: true });
  const saved = storage.saveJson('audit', audit.exportAudit());
  assert.equal(saved.ok, false, '재현 조건이 성립하지 않는다 — 쓰기가 성공했다');
  assert.equal(saved.reason, 'readonly');
  assert.equal(storage.storageStatus().namespaces.find((n) => n.ns === 'audit').health, 'readonly', '사유가 상태에 남지 않는다');
  assert.equal(audit.listAudit(10).length, 1, '보관 실패가 기록을 지웠다');
  storage.setDriver('file');

  // ② 화면은 **사유를 아는 칸**을 읽고, 문장은 한 벌(`STORAGE_HEALTH`)에서 꺼낸다.
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  assert.match(src, /const auditHealth = storage\?\.namespaces\.find\(\(n\) => n\.ns === 'audit'\)\?\.health \?\? null;/, '변경 이력 탭이 사유를 읽지 않는다');
  assert.match(src, /auditHealth !== 'ok' && auditHealth !== 'empty'/, '보관되는 상태에도 경고를 띄운다');
  assert.match(src, /STORAGE_HEALTH\[auditHealth\]\.hint/, '사유 문장을 베껴 적었다');
  assert.ok(src.includes('이 기록은 지금 서버에 보관되지 않습니다 — 재시작하면 사라집니다.'), '보관되지 않는다는 사실을 말하지 않는다');

  // ③ 그 값은 **탭을 열 때** 다시 읽는다 — 로그인할 때 한 번 받은 값으로는 계속 괜찮다고 말한다.
  assert.match(src, /if \(tab !== 'audit' \|\| !authInfo\?\.allowed\) return;\n\s*loadAudit\(true\);\n\s*loadStorage\(\);/, '보관 상태를 묵은 값으로 말한다');

  // ④ 겪기 전에는 말하지 않는다(첫 렌더에 경고가 없다).
  const html = await render();
  assert.equal(html.includes('이 기록은 지금 서버에 보관되지 않습니다'), false, '겪기도 전에 경고한다');

  audit.resetAudit();
  delete process.env.STORAGE_DIR;
});

/**
 * DS 48-3 — 보관이 막힌 환경에서 화면이 운영자에게 하라고 말하는 일이 「백업 내려받기」인데
 * (DS 47-1 의 읽기전용 안내), **그 파일에 변경 이력이 들어 있지 않았다**. 증거만 인스턴스
 * 메모리에 남아 다음 콜드 스타트에 사라졌다. 그렇다고 복원이 이 칸을 덮어서도 안 된다 —
 * 백업을 뜬 뒤의 기록이 사라지면 복원 자체가 증거를 지우는 일이 된다.
 */
test('백업이 변경 이력을 들고 나가고, 복원은 덮지 않고 합친다 (DS 48-3)', opts, async () => {
  delete process.env.ADMIN_PERSIST;
  const dir = mkdtempSync(path.join(tmpdir(), 'gowon-audit3-'));
  const { audit, storage } = await loadAuditLibs(dir);
  storage.setDriver('file');
  storage.resetStorageState();

  // ① 종전 식 재현 — 「덮어쓰기」로 되돌리면 백업 **뒤에** 일어난 일의 기록이 사라진다.
  audit.resetAudit();
  audit.logAudit({ action: 'kb.upsert', target: 'KB-1', detail: '수정: 환불 기간', authed: true });
  audit.logAudit({ action: 'rule.override', target: 'greeting', detail: '답변 수정', authed: true });
  const snap = audit.exportAudit();
  audit.logAudit({ action: 'partner.delete', target: 'PTR-0009', detail: '', authed: false });
  assert.equal(audit.auditCount(), 3);
  audit.importAudit(snap);
  assert.equal(audit.auditCount(), 2, '재현 조건이 성립하지 않는다');
  assert.equal(audit.listAudit(10).some((e) => e.target === 'PTR-0009'), false, '재현 조건이 성립하지 않는다 — 기록이 남았다');

  // ② 합치는 문 — 재시작으로 비어 있던 자리에 파일 속 기록이 **더해지고**, 그 사이의 기록은 남는다.
  audit.resetAudit();
  audit.logAudit({ action: 'partner.delete', target: 'PTR-0009', detail: '', authed: false });
  const merged = audit.mergeAudit(snap);
  assert.equal(merged.ok, true);
  assert.equal(merged.added, 2, '파일 속 기록을 더하지 않는다');
  assert.equal(merged.kept, 3);
  const all = audit.listAudit(500).map((e) => e.target);
  assert.ok(all.includes('PTR-0009'), '복원이 그 사이의 기록을 지웠다');
  assert.ok(all.includes('KB-1') && all.includes('greeting'), '파일 속 기록이 들어오지 않았다');

  // ③ 두 번 올려도 늘지 않는다 — 같은 건인지는 번호가 아니라 **내용 전체**로 가린다.
  const again = audit.mergeAudit(snap);
  assert.equal(again.added, 0, '같은 파일을 두 번 올리면 기록이 불어난다');
  assert.equal(again.skipped, 2);
  assert.equal(audit.auditCount(), 3);
  assert.equal(again.saved, undefined, '더한 것이 없는데 디스크를 되쓴다');

  // ④ 번호가 같아도 **내용이 다르면 다른 일**이다(번호는 인스턴스마다 1번부터 다시 매겨진다).
  const sameId = {
    version: 1, savedAt: new Date().toISOString(), seq: 1,
    events: [{ id: snap.events[0].id, at: '2026-01-02T03:04:05.000Z', action: 'kb.delete', target: '다른 자료', detail: '', authed: true }],
  };
  assert.equal(audit.mergeAudit(sameId).added, 1, '같은 번호라는 이유로 다른 일을 버린다');
  assert.ok(audit.listAudit(500).some((e) => e.target === '다른 자료'));
  // 시각순으로 선다 — 목록·파일·한도 버리기가 모두 「뒤가 최신」을 전제로 돈다.
  const ats = audit.listAudit(500).map((e) => e.at);
  assert.deepEqual(ats, [...ats].sort().reverse(), '합친 뒤 시간순이 깨졌다');

  // ⑤ 합친 결과는 **디스크까지 간다**(「합쳤습니다」가 메모리만 가리키지 않게 · DS 47-1).
  const file = path.join(dir, 'audit.json');
  assert.ok(existsSync(file), '합친 기록이 디스크에 없다');
  assert.ok(readFileSync(file, 'utf8').includes('PTR-0009'), '합친 기록이 디스크에 없다');

  // ⑥ 백업 파일이 아닌 것·모르는 작업 코드는 종전 규칙 그대로다(삼키지 않고, 늘리지도 않는다).
  const bad = audit.mergeAudit(null);
  assert.equal(bad.ok, false);
  assert.ok(bad.error.includes('백업 파일'), `거절 문장이 코드 어휘다: ${bad.error}`);
  const before = audit.auditCount();
  assert.equal(audit.mergeAudit({ events: [{ id: 'X-1', action: 'someone.new' }] }).added, 0, '모르는 작업을 받아들인다');
  assert.equal(audit.auditCount(), before);

  // ⑦ 한도는 합칠 때도 지킨다 — 넘긴 만큼 가장 오래된 쪽을 버리고 **그 사실을 남긴다**.
  audit.resetAudit();
  const many = {
    version: 1, savedAt: new Date().toISOString(), seq: 600,
    events: Array.from({ length: 520 }, (_, i) => ({
      id: `A-${String(i).padStart(6, '0')}`,
      at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
      action: 'kb.upsert', target: `K-${i}`, detail: '', authed: true,
    })),
  };
  const big = audit.mergeAudit(many);
  assert.equal(big.added, 520);
  assert.equal(big.kept, 500, '한도를 넘겨 들고 있다');
  assert.equal(audit.auditRetention().dropped, true, '버린 사실이 남지 않는다');
  assert.equal(audit.listAudit(500).some((e) => e.target === 'K-0'), false, '한도를 넘긴 기록이 남아 있다');

  // ⑧ 배선 — 내려받기에 싣고(제 자신을 꺼내 간 사실까지), 복원은 덮는 문을 쓰지 않는다.
  const route = readFileSync(new URL('../src/app/api/admin/backup/route.ts', import.meta.url), 'utf8');
  assert.match(route, /JSON\.stringify\(\{ \.\.\.snapshot, partners, audit \}/, '백업 파일에 변경 이력이 없다');
  assert.ok(route.indexOf("action: 'backup.export'") < route.indexOf('const audit = exportAudit();'), '파일이 제 자신을 꺼내 간 사실을 담지 않는다');
  assert.match(route, /const a = mergeAudit\(rawAudit\);/, '복원이 변경 이력을 합치지 않는다');
  assert.equal(/importAudit/.test(route), false, '복원이 변경 이력을 덮어쓰는 문을 쓴다');
  assert.match(route, /auditAdded,/, '더한 수를 화면에 보내지 않는다');

  // ⑨ 화면은 「덮었다」가 아니라 「더했다」로 말하고, 묻기 전에 그 사실을 알린다.
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  assert.ok(src.includes('변경 이력은 덮어쓰지 않고, 파일에만 있는 기록을 더합니다.'), '무엇이 그대로인지 묻기 전에 말하지 않는다');
  assert.ok(src.includes('변경 이력 ${added}건 추가'), '더한 수를 결과에 적지 않는다');
  // 번호가 겹칠 수 있으므로 줄을 가르는 열쇠에 시각이 들어간다.
  assert.ok(src.includes('<tr key={`${e.id}\\u0000${e.at}`}>'), '같은 번호 두 줄이 한 줄로 뭉개진다');

  audit.resetAudit();
  delete process.env.STORAGE_DIR;
});

/* ══════════ 디자인 스프린트 — 52차 재감사 (DS 55-1·55-2) ══════════ */

/** 모듈 안에만 있는(내보내지 않는) 최상위 함수 하나를 컴파일된 JS 에서 떼어내 실행한다. */
async function loadConsoleFn(name) {
  await loadConsole();
  const i = cachedJs.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `${name} 선언을 찾지 못했다`);
  const end = cachedJs.indexOf('\n}', i); // 최상위 함수라 닫는 중괄호는 1열에 있다
  assert.ok(end > i, `${name} 의 끝을 찾지 못했다`);
  return new Function(`${cachedJs.slice(i, end + 2)}\nreturn ${name};`)();
}

/**
 * DS 55-1 — 콘솔이 「지금 찾을 수 없는 파트너」를 **서버와 다른 말로** 적고, 서버가 세운
 * 그 줄을 파트너 표에서 **떨어뜨렸다**.
 *
 * 50차(DS 53-3)는 그 이름을 `partners.missingPartnerName` 한 곳으로 모으고, 파트너별 집계가
 * 그 고객사를 떨어뜨리지 않게 줄을 세웠다 — 「두 곳이 각자 적으면 같은 사실이 화면마다 다른
 * 말로 뜬다」가 그때 적어 둔 까닭이다. 그런데 콘솔은 그 규칙 밖에 있었다: 고객사 표·상세
 * 서랍·검색 결과가 「이름 없는 파트너」라고 적었고(파트너는 이름 없이 등록될 수 없으므로
 * **없는 사실**이다), 바로 옆 탭의 정산 리포트는 같은 고객사를 「(삭제된 파트너 PTR-0001)」로
 * 적었다. 그리고 파트너 표는 등록된 파트너만 돌아, 서버가 세운 그 줄과 거기 달린 고객사 수가
 * 화면에서 사라졌다 — 위의 「고객사 n곳」 KPI 와 표의 합이 어긋나는데 아무도 말하지 않았다.
 */
test('찾을 수 없는 귀속을 콘솔이 서버와 같은 말로 적고 표에서 떨어뜨리지 않는다 (DS 55-1)', opts, async () => {
  const fn = await loadConsoleFn('missingPartnerName');
  const P = await importLib('partners', ['storage', 'normalize', 'refusal', 'kst', 'logger', 'monitoring']);
  // ① 두 벌이 **같은 글자**를 낸다 — 갈라지면 같은 고객사의 귀속이 탭마다 다른 이름으로 뜬다.
  for (const id of ['PTR-0001', 'PTR-9999', 'legacy-id']) {
    assert.equal(fn(id), P.missingPartnerName(id), `이름이 갈라졌다: ${id}`);
  }
  // ② 고치기 전 말은 남아 있지 않다(그 말은 「이름이 비었다」는 **없는 사실**을 가리켰다).
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  assert.equal(src.includes("?? '이름 없는 파트너'"), false, '찾을 수 없는 귀속을 아직 다른 말로 적는다');
  // 이름을 붙이는 세 자리(고객사 표·상세 서랍·검색 결과)가 모두 그 함수를 지난다.
  assert.equal((src.match(/\?\? missingPartnerName\(/g) || []).length, 3, '이름을 따로 적는 자리가 남아 있다');
  assert.match(src, /src\/lib\/partners\.ts/, '옮겨 적은 문장의 원본을 밝히지 않았다');

  // ③ 서버가 세운 줄을 화면이 그린다 — 수정·삭제 단추 없이(고칠 대상이 지금 없다).
  assert.match(src, /const missingRollups = rollup\.filter\(\(r\) => r\.partnerId !== null && !partners\.some\(\(p\) => p\.id === r\.partnerId\)\);/, '찾을 수 없는 귀속 줄을 고르지 않는다');
  // 두 자리에 그 목록이 쓰인다(거르개 · 파트너 표 · DS 56-2) — 여기서 보는 것은 **표의 줄**이다.
  const row = src.slice(src.lastIndexOf('{missingRollups.map('), src.indexOf('{directRollup && directRollup.total > 0 &&'));
  assert.ok(row.length > 0 && row.length < 1200, '그 줄을 표에 그리지 않는다');
  assert.ok(row.includes('{r.partnerName}'), '이름을 서버가 붙인 그대로 쓰지 않는다');
  assert.ok(row.includes('찾을 수 없음'), '무슨 줄인지 말하지 않는다');
  assert.ok(row.includes('{r.total}곳'), '그 줄에 달린 고객사 수를 세지 않는다');
  assert.equal(/>수정<|>삭제</.test(row), false, '없는 파트너에 수정·삭제 단추를 단다');
  // 파트너가 한 곳도 없어도 그 줄이 있으면 빈 상태로 덮지 않는다.
  assert.match(src, /\{partners\.length === 0 && missingRollups\.length === 0 \? \(/, '빈 상태가 그 줄을 덮는다');
  // 운영자가 **할 일**을 말한다(정산에서 왜 빠지는지 · 어떻게 되돌리는지).
  assert.ok(src.includes('같은 식별자로 파트너를 다시 등록하거나, 고객사의 귀속을 옮겨 주세요'), '다음 길을 주지 않는다');
});

/**
 * DS 55-2 — 귀속 이력의 날짜가 **UTC 원문을 잘라** 적혔다.
 *
 * 기록의 `at` 은 ISO(UTC)이고 타임라인은 `h.at.slice(0, 10)` 으로 열 자를 떼어 썼다. 그래서
 * 한국 자정~오전 9시에 바꾼 귀속이 **전날**로 적힌다(`2026-10-21T15:30:00Z` → 「2026-10-21」,
 * 실제로는 10월 22일 오전 0시 30분). 같은 변경을 변경 이력 표는 `timeLabel` 로 적으므로 한
 * 사건이 두 화면에서 다른 날에 있었다 — 귀속은 정산 분쟁에서 가장 먼저 꺼내는 근거다.
 * 읽을 수 없는 값이 들어오면 그 **글자가 그대로** 날짜 칸에 올랐고, 정렬 비교식은 `NaN` 을
 * 돌려줘 멀쩡한 줄들의 앞뒤까지 흔들었다.
 */
test('귀속 이력의 날짜가 한국 날짜이고 읽을 수 없는 값을 지어내지 않는다 (DS 55-2)', opts, async () => {
  const kstDateLabel = await loadConsoleFn('kstDateLabel');
  // 대조는 독립 구현(ICU 시간대 데이터)으로 한다 — 같은 식을 두 번 적어 맞다고 하지 않는다.
  const oracle = (iso) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  for (const iso of ['2026-10-21T15:30:00.000Z', '2026-10-21T14:59:59.000Z', '2027-01-01T08:59:00+09:00', '2026-06-15T15:00:00Z']) {
    assert.equal(kstDateLabel(iso), oracle(iso), iso);
  }
  // 고치기 전 값과 실제로 달라지는 시각인지 확인한다(이 간극이 결함의 크기다).
  assert.equal('2026-10-21T15:30:00.000Z'.slice(0, 10), '2026-10-21');
  assert.equal(kstDateLabel('2026-10-21T15:30:00.000Z'), '2026-10-22');
  // 읽을 수 없는 값에는 날짜를 **지어내지 않는다**(글자를 잘라 올리지도 않는다 · DS 40-1).
  for (const bad of ['', '어제', '2026-13-45']) assert.equal(kstDateLabel(bad), '시각 모름', JSON.stringify(bad));

  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  assert.equal(src.includes('{h.at.slice(0, 10)}'), false, 'UTC 를 잘라 적던 식이 남아 있다');
  assert.match(src, /\{kstDateLabel\(h\.at\)\}/, '타임라인이 한국 날짜를 쓰지 않는다');
  // 서버(src/lib/kst.ts)와 같은 오프셋 — 갈라지면 화면과 파일이 다른 날을 가리킨다.
  const lib = readFileSync(new URL('../src/lib/kst.ts', import.meta.url), 'utf8');
  assert.match(lib, /9 \* 60 \* 60 \* 1000/, 'lib 의 KST 오프셋 선언이 바뀌었다');
  assert.match(src.slice(src.indexOf('function kstDateLabel(')), /9 \* 60 \* 60 \* 1000/, '화면의 KST 오프셋 선언이 바뀌었다');
  // 읽을 수 없는 시각이 **줄 세우기를 흔들지 않는다** — 비교가 일관되지 않으면 멀쩡한 줄도 흔들린다.
  assert.equal(/sort\(\(x, y\) => new Date\(y\.at\)\.getTime\(\) - new Date\(x\.at\)\.getTime\(\)\)/.test(src), false, '종전 비교식이 남아 있다');
  const cmp = src.slice(src.indexOf('const instant = (v: string) =>'), src.indexOf('id="ac-account-title"'));
  assert.match(cmp, /Number\.isNaN\(t\) \? -Infinity : t/, '읽을 수 없는 시각을 걸러내지 않는다');
  assert.match(cmp, /bx === by \? 0 : by - bx/, '같은 값끼리 비교가 NaN 이 된다');
});

/* ══════════ 디자인 스프린트 — 53차 재감사 (DS 56-1·56-2) ══════════ */

/**
 * DS 56-1 — 찾을 수 없는 귀속을 가진 고객사의 **편집 폼이 그 귀속을 말하지 않았다**.
 *
 * 52차(DS 55-1)는 그 고객사의 표 칸·상세 서랍·집계 줄을 「(삭제된 파트너 PTR-0001)」로 적게
 * 했다. 그런데 「수정」을 누르면 들어가는 **고르개**는 등록된 파트너만 돌며 그린다 — 지금 가진
 * 귀속에 해당하는 항목이 없으므로 그 칸은 **아무것도 고르지 않은 빈 칸**으로 떴다. 화면이 바로
 * 옆에서 이름을 적고 있는 그 귀속을, 편집 폼만 없는 것처럼 보여 준 것이다. 그리고 손대지 않고
 * 저장하면 서버가 요청 전체를 거절했다(런타임 쪽 테스트가 그 자리를 본다).
 */
test('찾을 수 없는 귀속이 편집 폼의 고르개에 서고 다음 길을 말한다 (DS 56-1)', opts, async () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  // ① 「고르개에 없는 귀속인가」를 판단하는 자리가 있다(집계 줄을 고르는 식과 같은 모양이다).
  assert.match(
    src,
    /const aFormOrphan = Boolean\(aForm\.partnerId\) && !partners\.some\(\(p\) => p\.id === aForm\.partnerId\);/,
    '편집 중인 귀속이 고르개에 있는지 보지 않는다',
  );
  // ② 그 귀속이 고르개에 **골라진 그대로** 선다 — 이름은 한 벌(`missingPartnerName`)이다.
  const sel = src.slice(src.indexOf('<select id="a-partner"'), src.indexOf('<label htmlFor="a-source">'));
  assert.ok(sel.length > 0 && sel.length < 2600, '귀속 고르개를 찾지 못했다');
  assert.match(sel, /\{aFormOrphan && <option value=\{aForm\.partnerId\}>\{missingPartnerName\(aForm\.partnerId\)\}<\/option>\}/, '찾을 수 없는 귀속이 고르개에 서지 않는다');
  // ③ 무슨 일인지·다음에 무엇을 할지 말한다(「다른 칸만 고쳐도 귀속은 남는다」가 요점이다).
  assert.ok(sel.includes('id="a-partner-missing"'), '그 사실을 적는 안내가 없다');
  assert.ok(sel.includes('다른 칸만 고쳐 저장하면 귀속은 그대로 남습니다'), '고칠 수 있다는 사실을 말하지 않는다');
  assert.ok(sel.includes('고르면 그 사유가 이력에 남습니다'), '귀속을 옮기면 이력이 남는다고 말하지 않는다');
  // ④ 스크린리더가 그 안내를 **그 칸에서** 듣는다(아래 문단을 따로 찾아 읽게 두지 않는다).
  assert.match(sel, /aria-describedby=\{\[aErr\.partnerId \? 'a-partner-err' : '', aFormOrphan \? 'a-partner-missing' : ''\]\.filter\(Boolean\)\.join\(' '\) \|\| undefined\}/, '안내가 고르개에 묶여 있지 않다');
});

/**
 * DS 56-2 — 「귀속으로 거르기」에 **찾을 수 없는 귀속이 없었다** (52차에 적어 둔 다음 차례).
 *
 * DS 55-1 이 그 줄을 파트너 표에 세웠지만 고르개는 등록된 파트너만 돌아서, 표에서는 보이는데
 * 「그것만 골라 보기」가 되지 않았다. 고객사가 수백 곳이면 눈으로 찾는 수밖에 없고, 그 몇 곳이
 * 바로 정산 리포트가 `partial: true` 로 가리키는 고객사다. 서버 거르개는 그 식별자를 그대로
 * 받으므로(`queryAccounts`) 고르개에 세우는 것만으로 동작한다.
 */
test('귀속 거르개에서 찾을 수 없는 귀속만 골라 볼 수 있다 (DS 56-2)', opts, async () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const sel = src.slice(src.indexOf('<select\n                      id="a-filter"'), src.indexOf('</select>', src.indexOf('id="a-filter"')));
  assert.ok(sel.length > 0, '귀속 거르개를 찾지 못했다');
  assert.ok(sel.includes('<option value="">모든 귀속</option>'), '거르개의 기존 항목이 사라졌다');
  assert.ok(sel.includes('<option value="direct">직접 계약</option>'), '직접 계약 항목이 사라졌다');
  // 이름은 서버가 집계에 붙여 보낸 그대로 쓴다 — 콘솔이 다시 적으면 표와 고르개가 갈라진다.
  assert.match(sel, /\{missingRollups\.map\(\(r\) => <option key=\{r\.partnerId\} value=\{r\.partnerId \?\? ''\}>\{r\.partnerName\}<\/option>\)\}/, '찾을 수 없는 귀속을 고를 수 없다');
  // 고른 값은 서버 조회에 그대로 실린다(거르개는 종전부터 그 값을 `loadPartners` 에 넘긴다).
  assert.match(src, /onChange=\{\(e\) => \{ setPartnerFilter\(e\.target\.value\); loadPartners\(e\.target\.value\); \}\}/, '고른 귀속으로 다시 조회하지 않는다');
});

/**
 * DS 56-3(화면 쪽) — 파트너·고객사 편집이 **동시 편집 관문 밖**에 있었다.
 *
 * DS 46-1 이 안내 자료·규칙·접수에 세운 관문(`baseRev` → 거절 → 폼 안에서 다음 길)의 전제가
 * 「편집 폼은 연 순간의 사진이고 저장은 그 사진을 통째로 덮어쓴다」인데, 이 탭만 그 목록에
 * 없었다 — 하필 **월 이용료**(정산 수수료의 기준)를 고치는 화면이다.
 */
test('파트너·고객사 편집이 내가 본 모습을 들고 가고 거절을 폼 안에서 말한다 (DS 56-3)', opts, async () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  // ① 「수정」을 누를 때 그 모습을 들고 간다.
  assert.match(src, /setAEditRev\(a\.rev \?\? null\);/, '고객사 편집이 본 모습을 들고 가지 않는다');
  assert.match(src, /setPEditRev\(p\.rev \?\? null\);/, '파트너 편집이 본 모습을 들고 가지 않는다');
  // ② 저장에 실어 보낸다 — **수정에만**(새 항목에는 겨룰 상대가 없다).
  assert.match(src, /\.\.\.\(aForm\.id && aEditRev \? \{ baseRev: aEditRev \} : \{\}\)/, '고객사 저장이 baseRev 를 보내지 않는다');
  assert.match(src, /\.\.\.\(pForm\.id && pEditRev \? \{ baseRev: pEditRev \} : \{\}\)/, '파트너 저장이 baseRev 를 보내지 않는다');
  // ③ 거절당하면 **적던 글은 그대로 두고** 폼 안에서 다음 길을 준다(사라지는 토스트에 맡기지 않는다).
  for (const [what, state] of [['고객사', 'aConflict'], ['파트너', 'pConflict']]) {
    const note = src.slice(src.indexOf(`{${state} && (`), src.indexOf(`{${state} && (`) + 700);
    assert.ok(note.includes('<ConflictNote'), `${what} 쪽에 그 자리 안내가 없다`);
    assert.ok(note.includes('nowLabel'), `${what} 쪽이 무엇을 덮게 되는지 보여 주지 않는다`);
    assert.ok(note.includes('onReload') && note.includes('onOverwrite'), `${what} 쪽에 두 길이 없다`);
  }
  // 무엇을 덮는지 보여 주는 줄에 **월 이용료**가 있다(이 화면에서 사라지면 가장 아픈 값이다).
  assert.match(src, /월 이용료 \$\{wonLabel\(aConflict\.current\.monthlyFeeKrw\)\}/, '덮을 금액을 보여 주지 않는다');
  // ④ 폼을 비우는 자리들이 그 모습·그 안내도 함께 버린다(남으면 다음 저장이 엉뚱하게 거절된다).
  const resetSites = (call, rev) => {
    let from = 0;
    let n = 0;
    for (;;) {
      const i = src.indexOf(call, from);
      if (i < 0) break;
      n += 1;
      const near = src.slice(i, i + 200);
      assert.ok(near.includes(rev), `폼을 비우면서 본 모습을 남겨 둔다: ${call} (${n}번째)`);
      from = i + call.length;
    }
    return n;
  };
  assert.ok(resetSites('loadAccountForm(EMPTY_ACCOUNT_FORM)', 'setAEditRev(null)') >= 2, '고객사 폼을 비우는 자리를 찾지 못했다');
  assert.ok(resetSites('loadPartnerForm(EMPTY_PARTNER_FORM)', 'setPEditRev(null)') >= 3, '파트너 폼을 비우는 자리를 찾지 못했다');
});

/* ══════════ 디자인 스프린트 — 54차 재감사 (DS 57-1·57-3) ══════════ */

/**
 * DS 57-1(화면 쪽) — **삭제가 「내가 본 모습」을 들고 가지 않았다.**
 *
 * DS 56-3 이 이 탭의 저장에 관문을 세웠는데 바로 옆의 「삭제」 단추는 식별자만 보냈다.
 * 확인 대화상자를 읽는 동안에도 다른 화면은 같은 파트너를 고치고 있을 수 있다 — 그래서
 * 운영자가 **읽고 승인한 이름**과 실제로 지워지는 것이 다를 수 있었다. 되돌릴 수 없는 동작이다.
 */
test('파트너 삭제가 목록에서 본 모습을 들고 가고 거절을 그 자리에서 말한다 (DS 57-1)', opts, async () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const from = src.indexOf('const removePartner = async');
  // 같은 표지(「정산 리포트」)가 위쪽 타입 묶음에도 있어 **삭제 함수 뒤쪽**에서 찾는다.
  const fn = src.slice(from, src.indexOf('// ---- 정산 리포트 ----', from));
  assert.ok(fn.length > 0 && fn.length < 3000, '삭제 함수를 찾지 못했다');
  // ① 목록 응답에 실려 온 그 값을 그대로 보낸다(화면이 다시 계산하지 않는다 · DS 42-2).
  assert.match(fn, /if \(p\.rev\) qs\.set\('baseRev', p\.rev\);/, '삭제가 본 모습을 들고 가지 않는다');
  assert.match(fn, /qs = new URLSearchParams\(\{ partnerId: p\.id \}\)/, '식별자를 싣는 자리가 바뀌었다');
  assert.ok(fn.includes("method: 'DELETE'"), '삭제 요청이 아니다');
  // ② 되돌릴 수 없는 동작이므로 확인 절차는 그대로 둔다(그 절차가 무뎌지면 다른 확인도 함께 무뎌진다 · DS 5-4).
  assert.ok(fn.includes('askConfirm'), '확인 절차가 사라졌다');
  // ③ 거절당하면 **지금 저장된 내용**을 적어 준다 — 무엇이 그 사이 바뀌었는지 보고 다시 고르게.
  assert.ok(fn.includes("data.conflict === 'changed' && data.current"), '그 사이 바뀐 경우를 가리지 않는다');
  assert.match(fn, /지금 저장된 내용: \$\{\(data\.current as PartnerView\)\.name\} \/ 수수료율 \$\{feeLabel\(/, '지금 저장된 이름·수수료율을 보여 주지 않는다');
  // ④ 목록을 **먼저** 받고 그 뒤에 적는다 — `loadPartners` 가 이 칸을 비우고 시작한다.
  const idx = fn.indexOf('if (data.conflict) await loadPartners(partnerFilter);');
  assert.ok(idx > 0, '거절 뒤에 목록을 새로 받지 않는다');
  assert.ok(fn.indexOf('setPartnerErr(`${data.message', idx) > idx, '목록을 받기 전에 적어 두면 그 글이 지워진다');
  // ⑤ 그 글이 서 있는 자리는 읽어 주는 영역이다(눌린 버튼만으로는 무슨 일이 났는지 모른다).
  assert.match(src, /\{partnerErr && \(\s*<p role="alert"/, '파트너 탭의 오류 문단이 alert 가 아니다');
});

/**
 * DS 57-3 — 정산 대상이 0건인 달은 **왜 0건인지 한 줄도 말하지 않았다.**
 *
 * 「산출 기준·한계」는 고객사별 산출 근거 **표 안에만** 있었다. 그래서 대상이 없는 달에는
 * 화면이 「정산 대상 고객사가 없습니다」로 끝났고, 제외 사유(해지 n곳·검토 중 n곳·계약일이
 * 기간 이후 n곳…)는 어디에서도 볼 수 없었다 — 하필 그 달은 CSV 단추도 눌리지 않는다
 * (내보낼 행이 없다). 파트너가 「우리 고객사는 왜 빠졌습니까」라고 묻는 달이 바로 그 달이다.
 */
test('정산 대상이 0건인 달에도 제외 사유를 보여 준다 (DS 57-3)', opts, async () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  // ① 두 자리가 **같은 요소**를 쓴다(한쪽만 고쳐 두면 다시 갈라진다).
  assert.ok(src.includes('function SettleNotes('), '주석을 그리는 요소가 없다');
  assert.equal((src.match(/<SettleNotes /g) || []).length, 2, '두 자리에서 같은 요소를 쓰지 않는다');
  // ② 서버가 적어 보낸 문장을 **그대로** 보여 준다(화면이 다시 세거나 다시 적지 않는다 · DS 57-2).
  const cmp = src.slice(src.indexOf('function SettleNotes('), src.indexOf('interface RollupView'));
  assert.match(cmp, /notes\.map\(\(n, i\) => <li key=\{i\}[^>]*>\{n\}<\/li>\)/, '주석을 그대로 싣지 않는다');
  assert.ok(!/\d+곳|제외/.test(cmp.replace(/\*[^\n]*/g, '')), '화면이 사유를 다시 적는다');
  assert.ok(cmp.includes('if (notes.length === 0) return null;'), '주석이 없을 때 빈 상자를 그린다');
  // ③ 빈 상태에서는 **펼친 채로** 뜬다 — 접힌 요약 한 줄로는 「왜 없는가」가 보이지 않는다.
  const empty = src.slice(src.indexOf('에 정산 대상 고객사가 없습니다'), src.indexOf("{r && r.rows.length > 0 && ("));
  assert.match(empty, /<SettleNotes notes=\{r\.notes\} open \/>/, '빈 상태에서 제외 사유가 펼쳐지지 않는다');
  assert.ok(empty.includes('파트너·귀속 열기'), '빈 상태의 다음 행동이 사라졌다');
  // ④ 표가 있는 자리는 종전처럼 접힌 채로 둔다(그 달에는 표가 먼저 읽혀야 한다).
  assert.match(src, /\{\/\* 표가 있는 자리와 없는 자리가[^\n]*\n\s*<SettleNotes notes=\{r\.notes\} \/>/, '표 아래 주석 자리가 바뀌었다');
});

/* ══════════ 디자인 스프린트 — 55차 재감사 (DS 58-1·58-2·58-3) ══════════ */

/**
 * DS 58-1(화면 쪽) — 합친 백업이 경계보다 앞선 기록을 들고 왔으면 **그 사이**를 말해야 한다.
 * 변경 이력 탭은 「{경계} 이후」 한 줄만 적었고, 그 줄은 합친 뒤 1월을 가리켰다 — 1월부터
 * 지금까지가 성한 기록으로 읽혔다(그 사이는 한 줄도 들고 있지 않다).
 */
test('변경 이력 탭이 합친 백업과 지금 기록 사이의 구멍을 말한다 (DS 58-1)', opts, async () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');

  // ① 화면이 그 칸을 받는다 — 옛 응답에는 없으므로 optional 이다(없으면 아무 말도 하지 않는다).
  const view = src.slice(src.indexOf('interface RetentionView {'), src.indexOf('interface StorageNsView {'));
  assert.match(view, /mergedFrom\?: string;/, '화면이 섞인 구간을 받지 않는다');

  // ② 경계 한 줄과 **따로** 적는다 — 한 문장으로 뭉치면 둘 중 하나가 거짓이 된다.
  const tab = src.slice(src.indexOf('<h2 id="audit-h"'), src.indexOf('<label htmlFor="audit-filter"'));
  assert.ok(tab.includes('${timeLabel(auditRange.knownFrom)} 이후'), '경계를 말하지 않는다');
  assert.match(tab, /auditRange\?\.mergedFrom && \(/, '섞인 구간을 말하지 않는다');
  assert.ok(tab.includes('올린 백업에 적혀 있던 기록만 있습니다'), '그 사이에 무엇이 있는지 말하지 않는다');
  assert.ok(tab.includes('「변경 없음」이 아니라 「기록 없음」'), '빈 구간을 「변경 없음」으로 읽게 둔다');
  // 겪기 전에는 말하지 않는다 — 섞인 것이 없으면 그 줄 자체가 없다.
  assert.equal(/mergedFrom\s*\?\s*`/.test(tab), false, '섞이지 않았을 때도 글자를 만든다');

  // ③ 첫 렌더에는 없다(모수가 오기 전에 단정하지 않는다).
  const html = await render();
  assert.equal(html.includes('올린 백업에 적혀 있던 기록만 있습니다'), false, '겪기도 전에 구멍을 말한다');
});

/**
 * DS 58-2(화면 쪽) — 「보완이 필요한 자료」의 **세 사실**이 두 가지로 적혀 있었다.
 * 이름을 되돌리지 못한 복원분까지 「근거 없음」 줄로 들어가, 화면은 그 줄에 「등록된 자료 없이
 * 답한 답변입니다. 위의 「답하지 못한 질문」부터 채워 주세요」라고 적었다 — 없던 일을 사실로
 * 말하고 운영자를 엉뚱한 일로 보냈다.
 */
test('이름을 되돌리지 못한 평가를 화면이 다르게 적는다 (DS 58-2)', opts, async () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const lib = readFileSync(new URL('../src/lib/feedback.ts', import.meta.url), 'utf8');

  // ① 표기는 **서버 사전과 같은 글자**여야 한다 — 어긋나면 그 줄만 영영 자료로 데려간다.
  const label = (src.match(/const UNKNOWN_KB_LABEL = '([^']+)'/) || [])[1];
  assert.ok(label, '콘솔에 「알 수 없음」 표기가 없다');
  assert.ok(lib.includes(`export const UNKNOWN_KB_LABEL = '${label}'`), `서버 표기와 어긋난다: ${label}`);
  const no = (src.match(/const NO_CITATION_LABEL = '([^']+)'/) || [])[1];
  assert.notEqual(label, no, '두 사실을 같은 말로 적는다');

  // ② 사실은 **서버가 보낸 표시**로 가린다(글자 비교로 가리면 같은 이름의 자료에 걸린다).
  const dash = src.slice(src.indexOf('보완이 필요한 자료'), src.indexOf('{/* ── 최근 대화 ── */}'));
  assert.match(dash, /const lost = Boolean\(d\.citationLost\);/, '화면이 서버의 표시를 읽지 않는다');
  assert.match(dash, /const dead = d\.citation === NO_CITATION_LABEL \|\| lost \|\| d\.missing;/, '데려갈 곳 없는 줄을 누르게 둔다');
  // ③ 세 줄이 **서로 다른 말**을 한다.
  assert.ok(dash.includes('등록된 자료 없이 답한 답변입니다'), '근거 없는 답변 문장이 사라졌다');
  assert.ok(dash.includes('지금은 없는 자료입니다'), '지워진 자료 문장이 사라졌다');
  assert.ok(dash.includes('백업에서 되살린 평가입니다'), '되돌리지 못한 평가를 말하지 않는다');
  assert.ok(dash.includes('이 수만으로 고칠 자료를 고르지 마세요'), '그 수를 믿고 일하게 둔다');
  // 「답하지 못한 질문부터 채우라」는 **근거 없음 줄에만** 붙는다(이쪽은 고칠 자료가 없다).
  const lostLine = (dash.match(/'백업에서 되살린 평가입니다[^']*'/) || [])[0];
  assert.ok(lostLine, '되돌리지 못한 평가의 문장을 찾지 못했다');
  assert.equal(lostLine.includes('답하지 못한 질문'), false, '되돌리지 못한 평가에 엉뚱한 다음 일을 적는다');
  // ④ 누를 수 없는 줄의 설명은 **깎지 않는다** — 375px 에서 다음에 할 일이 잘려 보이지 않는다
  //    (`.ac-row-reply` 는 한 줄로 말줄임한다 — 자료 이름 줄에는 맞지만 설명 줄에는 맞지 않는다).
  assert.match(dash, /<span className="ac-row-reply" style=\{\{ whiteSpace: 'normal', overflow: 'visible' \}\}>/, '설명이 한 줄로 깎인다');
});

/**
 * DS 58-3(화면 쪽) — 검색어가 없어 **등록되지 않는 조각**을 화면이 말하지 않았다.
 * 「후보 N개」만 적혀 있어 운영자는 올린 문서가 통째로 들어간 줄 알았고, 목록 번호(`#n`)에
 * 난 구멍이 유일한 단서였다(그 구멍이 무엇인지는 어디에도 없었다).
 */
test('업로드 미리보기가 등록되지 않는 조각을 말한다 (DS 58-3)', opts, async () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  const route = readFileSync(new URL('../src/app/api/admin/kb/import/route.ts', import.meta.url), 'utf8');

  // ① 서버가 세어 보낸다 — 거르는 쪽과 세는 쪽이 **한 벌**이다(`ingestDocument`).
  assert.match(route, /const ingested = ingestDocument\(text\.value, \{/, '라우트가 빠진 조각을 세지 않는다');
  assert.equal(/documentToCandidates/.test(route), false, '세지 않는 문이 남아 있다');
  assert.match(route, /chunks: ingested\.chunks, dropped: ingested\.dropped/, '미리보기가 빠진 조각을 말하지 않는다');
  assert.ok(route.includes('chunks: ingested.chunks,\n    dropped: ingested.dropped,'), '등록 뒤에는 말하지 않는다');
  assert.match(route, /검색어 없어 제외 \$\{ingested\.dropped\.length\}조각/, '빠진 조각이 변경 이력에 남지 않는다');
  // 전부 걸러진 경우에는 **그렇게 말한다**(「본문이 너무 짧다」는 사실이 아니다 · DS 42-3).
  assert.match(route, /모든 조각에서 검색에 쓸 낱말을 찾지 못했습니다/, '전부 걸러졌을 때 사유가 사실과 다르다');

  // ② 화면이 받아 **등록 뒤에도** 남긴다(사라지는 토스트에 맡기지 않는다 · DS 44-1 과 같은 규칙).
  assert.match(src, /interface DroppedChunkView \{/, '화면이 빠진 조각을 받지 않는다');
  assert.match(src, /const dropped = \(data\.dropped as DroppedChunkView\[\] \| undefined\) \?\? \[\];/, '옛 응답을 「빠진 것 없음」으로 읽는다');
  assert.match(src, /setImpDropped\(dropped\);/, '빠진 조각을 버린다');
  assert.match(src, /setImpDropped\(\[\]\)/, '미리보기를 지워도 경고가 남는다');

  // ③ 그 목록이 **무엇이 빠졌는지** 가리킨다 — 번호·제목·길이·첫 글자.
  const imp = src.slice(src.indexOf('aria-labelledby="ac-kb-import"'), src.indexOf('{/* ── 우: 편집 폼(스티키) ── */}'));
  assert.match(imp, /\{impDropped\.length > 0 && \(/, '빠진 조각 안내가 없다');
  assert.ok(imp.includes('은 등록되지 않습니다'), '등록되지 않는다는 사실을 말하지 않는다');
  assert.ok(imp.includes('챗봇은 기본 안내로 답합니다'), '그래서 무슨 일이 벌어지는지 말하지 않는다');
  assert.ok(imp.includes("'제목 없음(문서 맨 앞)'"), '제목 없는 조각을 빈칸으로 둔다');
  assert.ok(imp.includes('빠진 번호'), '번호의 구멍이 무엇인지 말하지 않는다');
  assert.ok(imp.includes('오른쪽 「새 자료 추가」로 직접 넣어 주세요'), '다음 할 일이 없다');
  // 긴 목록은 다섯 줄까지만 — 나머지는 수로 말한다(남는 조각 안내와 같은 모양).
  assert.match(imp, /impDropped\.slice\(0, 5\)\.map/, '목록이 끝없이 길어진다');
  assert.ok(imp.includes('외 {impDropped.length - 5}조각'), '자른 뒤 나머지를 말하지 않는다');
  // 머무는 안내는 `role="status"` 로 읽힌다(초점을 빼앗지 않는다 · DS 44-1 과 같은 자리).
  assert.match(imp, /\{impDropped\.length > 0 && \(\n\s*<div role="status"/, '스크린리더가 그 사실을 읽지 못한다');

  // ④ 겪기 전에는 말하지 않는다(첫 렌더에 경고가 없다).
  const html = await render();
  assert.equal(html.includes('은 등록되지 않습니다'), false, '겪기도 전에 경고한다');
});

/* ══════════ 59순위 — 백로그 소진 후 56차 재감사 (DS 59-3) ══════════ */

/** 설치 스니펫을 만드는 자를 떼어내 실제로 돌린다(상수까지 함께 — 상한·형식이 그 안에 있다). */
async function loadInstall() {
  await loadConsole();
  const konst = [/const INSTALL_OFFSET_MAX = \d+;/, /const INSTALL_TENANT_RE = \/.+\/;/].map((re) => {
    const m = re.exec(cachedJs);
    assert.ok(m, `${re} 선언을 찾지 못했다`);
    return m[0];
  });
  const fns = ['installOffset', 'installSnippet'].map((n) => {
    const i = cachedJs.indexOf(`function ${n}(`);
    assert.ok(i >= 0, `${n} 선언을 찾지 못했다`);
    const end = cachedJs.indexOf('\n}', i);
    assert.ok(end > i, `${n} 의 끝을 찾지 못했다`);
    return cachedJs.slice(i, end + 2);
  });
  return new Function(`${konst.join('\n')}\n${fns.join('\n')}\nreturn { installOffset, installSnippet };`)();
}

/**
 * DS 59-3 — 고객사에 보낼 한 줄을 운영자가 **손으로 조립**했다.
 *
 * 화면은 기본 한 줄만 주고 `data-tenant="eum"` 같은 속성은 아래 표를 보고 직접 붙이게 했다.
 * 그렇게 적은 식별자가 틀리면 상담창은 멀쩡히 뜨고 **고객사 안내 자료가 아닌 기본 구성**으로
 * 답한다 — 화면에서는 보이지 않는 사고다(DS 59-2 가 설치한 사람에게 말해 주기로 한 그 자리).
 * 그러니 애초에 손으로 적지 않게 한다: 고른 그대로의 한 줄을 만들어 주고, 그 줄은 반드시
 * `public/embed.js` 가 받는 값이어야 한다.
 */
test('설치 코드가 고른 고객사·위치·여백 그대로 만들어진다 (DS 59-3)', opts, async () => {
  const { installSnippet, installOffset } = await loadInstall();
  const base = 'https://chatbot-gowon.vercel.app';

  // ① 아무것도 고르지 않으면 종전과 같은 한 줄이다(기존 안내를 바꾸지 않는다).
  const plain = { tenant: '', position: 'right', offset: 0 };
  assert.equal(installSnippet(base, plain), `<script src="${base}/embed.js" async></script>`);
  assert.equal(installSnippet(base), `<script src="${base}/embed.js" async></script>`, '옵션 없이 부르던 자리가 깨졌다');

  // ② 고른 것만 실린다 — 기본값은 적지 않는다(설치 코드가 길어질수록 틀릴 자리가 는다).
  assert.equal(
    installSnippet(base, { tenant: 'eum', position: 'left', offset: 24 }),
    `<script src="${base}/embed.js" data-tenant="eum" data-position="left" data-offset="24" async></script>`,
  );
  assert.equal(
    installSnippet(base, { tenant: 'eum', position: 'right', offset: 0 }),
    `<script src="${base}/embed.js" data-tenant="eum" async></script>`,
  );

  // ③ 주소를 아직 읽지 못했어도 사람이 채울 자리를 남긴다(하드코딩 금지).
  assert.match(installSnippet('', plain), /^<script src="https:\/\/<배포도메인>\/embed\.js"/);

  // ④ 만들어 주는 한 줄은 embed.js 가 **반드시 받는** 값이다 — 형식을 벗어나면 싣지 않는다.
  assert.equal(
    installSnippet(base, { tenant: 'eum"><script>', position: 'right', offset: 0 }),
    `<script src="${base}/embed.js" async></script>`,
    '식별자 형식을 보지 않고 그대로 싣는다',
  );
  assert.equal(
    /data-offset="\d+"/.exec(installSnippet(base, { tenant: '', position: 'right', offset: 9999 }))[0],
    'data-offset="200"',
    '화면 밖으로 나가는 여백을 그대로 적는다',
  );

  // ⑤ 여백 칸은 사람이 치는 칸이다 — 무엇을 쳐도 0~상한의 정수가 된다.
  assert.equal(installOffset(''), 0);
  assert.equal(installOffset('abc'), 0);
  assert.equal(installOffset('-5'), 0);
  assert.equal(installOffset('24'), 24);
  assert.equal(installOffset('24.6'), 25);
  assert.equal(installOffset('9999'), 200);

  // ⑥ 상한·형식은 embed.js 와 **같은 값**이어야 한다(어긋나면 우리가 만든 줄을 우리가 거절한다).
  const embed = readFileSync(new URL('../public/embed.js', import.meta.url), 'utf8');
  assert.match(embed, /var OFFSET_MAX = 200;/, '여백 상한이 두 곳에서 갈라졌다');
  assert.match(embed, /\/\^\[a-z0-9\]\[a-z0-9_-\]\{0,31\}\$\//, '식별자 형식이 두 곳에서 갈라졌다');
  const page = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /const INSTALL_OFFSET_MAX = 200;/, '화면의 여백 상한이 바뀌었다');
  assert.match(page, /const INSTALL_TENANT_RE = \/\^\[a-z0-9\]\[a-z0-9_-\]\{0,31\}\$\/;/, '화면의 식별자 형식이 바뀌었다');
});

/** DS 59-3 — 고르는 자리가 실제로 화면에 있고, 복사하는 것이 보이는 그 줄인가. */
test('설치 화면에 고객사·위치·여백 고르개가 있고 복사가 보이는 줄을 준다 (DS 59-3)', opts, () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  // 목록은 「응답 테스트」와 같은 출처다(DS 36-3) — 설치 화면에서도 불러온다.
  assert.match(src, /tab === 'install' && tenantList\.length === 0\) loadTenantList\(\);/, '설치 화면이 고객사 목록을 불러오지 않는다');
  const tab = src.slice(src.indexOf("{tab === 'install' && ("), src.indexOf('설치 코드는 운영자용 정보라'));
  for (const [id, label] of [['ac-install-tenant', '고객사'], ['ac-install-side', '위치'], ['ac-install-gap', '여백']]) {
    assert.ok(tab.includes(`htmlFor="${id}"`), `${label} 고르개에 라벨이 없다`);
    assert.ok(tab.includes(`id="${id}"`), `${label} 고르개가 없다`);
  }
  // 코드가 아니라 이름으로 고른다(운영자 화면에 내부 식별자를 적지 않는다 · DS 36-3 과 같은 규칙).
  assert.match(tab, /<option key=\{t\.id\} value=\{t\.id\}>\{t\.name \|\| t\.id\}<\/option>/, '고객사를 식별자로 고르게 한다');
  assert.ok(tab.includes('{DEFAULT_TENANT_VIEW_LABEL}'), '기본 구성을 고를 자리가 없다');
  // 보이는 줄과 복사되는 줄이 **같은 함수·같은 값**이다.
  assert.equal((tab.match(/installSnippet\(origin, installOpts\)/g) || []).length, 2, '복사되는 줄이 화면의 줄과 다르다');
  // 여백 칸은 상한을 화면에서도 말한다(치고 나서 거절당하지 않게).
  assert.ok(tab.includes('max={INSTALL_OFFSET_MAX}'), '여백 칸에 상한이 없다');
  // 인쇄·형식 안내는 설치하는 사람이 알아야 하는 사실이다(DS 59-1·59-2 의 결과).
  assert.ok(tab.includes('#gowon-chat-frame'), '고객사가 고를 이름을 알려 주지 않는다');
  assert.ok(tab.includes('인쇄할 때는 상담창이 종이에 찍히지'), '인쇄에서 빠진다는 사실을 말하지 않는다');
});

/* ══════════ 60순위 — 백로그 소진 후 57차 재감사 (DS 60-1·60-3) ══════════ */

/**
 * DS 60-1 — 화면의 시각이 **파일·타임라인과 같은 시계·같은 글자**인가.
 *
 * 콘솔은 lib 을 불러오지 않으므로(클라이언트 번들 · `kstMonthNow`·`kstDateLabel` 과 같은 규약)
 * `timeLabel` 은 `lib/kst.kstMinute` 의 **사본**이다. 두 쪽이 갈라지는 날 화면과 내려받은 파일이
 * 같은 한 건을 다른 시각으로 적는다 — 그래서 떼어내 **실제로 돌려** 글자까지 대조한다.
 */
test('화면의 시각이 한국 시간이고 파일과 같은 글자다 (DS 60-1)', opts, async () => {
  const { timeLabel, kstDateLabel } = await loadFns(['timeLabel', 'kstDateLabel']);
  const K = await importLib('kst');

  const CASES = [
    '2026-10-22T16:00:00.000Z', // KST 10/23 01:00 — 대시보드는 이 건을 「오늘(23일)」로 센다
    '2026-01-01T00:00:00.000Z', // DS 58-1 이 다룬 복원된 1월 백업의 경계
    '2025-12-31T16:30:00.000Z', // 해를 넘긴다 — 연도가 없으면 1월 줄이 12월 줄보다 위에 선다
    '2026-07-04T23:59:59.000Z',
  ];
  for (const iso of CASES) {
    // ① lib 의 단일 출처와 **같은 글자**다(사본이 갈라지지 않았다).
    assert.equal(timeLabel(iso), K.kstMinute(iso), `lib 과 다른 시각을 적는다: ${iso}`);
    // ② 내려받은 파일의 시각 칸과 **초만 다르다**.
    assert.equal(timeLabel(iso), K.kstDateTime(iso).slice(0, 16), `파일과 다른 시각을 적는다: ${iso}`);
    // ③ 바로 아래 귀속 타임라인의 날짜와 **같은 날**이다(DS 55-2 가 닫은 갈라짐).
    assert.equal(timeLabel(iso).slice(0, 10), kstDateLabel(iso), `타임라인과 다른 날을 적는다: ${iso}`);
    // ④ 연도를 적고, 영문(AM/PM)이 섞이지 않는다.
    assert.match(timeLabel(iso), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, `모양이 다르다: ${timeLabel(iso)}`);
  }
  // 하루 24시간 어디서도 영문이 섞이지 않는다(런타임 CLDR 판본에 맡기지 않는다).
  for (let h = 0; h < 24; h += 1) {
    const s = timeLabel(new Date(Date.UTC(2026, 2, 1, h, 7)).toISOString());
    assert.equal(/[A-Za-z]/.test(s), false, `영문이 섞였다: ${s}`);
  }
  // 읽을 수 없는 값에는 **지어내지 않는다**(부르는 쪽이 아무것도 그리지 않는다 — 종전 그대로).
  for (const bad of ['', '어제', 'not-a-date']) assert.equal(timeLabel(bad), '');
});

/** DS 60-1 — 화면이 제 시각 기준을 말하고, 그 문장이 파일 꼬리와 같은 기준인가. */
test('화면이 시각 기준(KST)을 말한다 (DS 60-1)', opts, async () => {
  await loadConsole();
  const K = await importLib('kst');
  const note = (cachedJs.match(/const KST_SCREEN_NOTE = '([^']+)'/) || [])[1];
  assert.equal(note, K.KST_SCREEN_NOTE, '화면의 시각 기준 문장이 lib 과 다르다');

  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  // 「무엇이 빠졌는가」를 말하는 두 자리 — 보관 경계를 적는 문장은 기준 시계를 함께 말한다.
  assert.ok(src.includes('보관 한도 ${comma(auditRange.limit)}건 · ${KST_SCREEN_NOTE}'), '변경 이력의 보관 경계가 시각 기준을 말하지 않는다');
  assert.ok(src.includes('최대 ${comma(stats.conversation.retention.limit)}건 · ${KST_SCREEN_NOTE}'), '대화 보관 경계가 시각 기준을 말하지 않는다');
  // 시각 열은 자릿수 폭을 고정한다 — 고정 길이 글자가 열마다 흔들리지 않게(DS 60-1).
  assert.equal(
    (src.match(/whiteSpace: 'nowrap', color: 'var\(--sub\)', fontVariantNumeric: 'tabular-nums' \}\}>\{timeLabel/g) || []).length,
    1,
    '변경 이력의 시각 열이 숫자 폭을 고정하지 않는다',
  );
});

/**
 * DS 60-3 — 화면의 **수**가 한 자로 적히는가.
 *
 * 종전에는 `toLocaleString('ko-KR')` 이 28곳에 흩어져 있었다. 이 화면은 클라이언트 컴포넌트지만
 * 첫 그림은 서버가 그리므로, ICU 가 작은 런타임에서는 서버와 브라우저가 다른 글자를 내
 * 수화(hydration)가 어긋난다 — 그리고 쪽수 줄은 **한 문장 안에서** 자가 갈려 있었다
 * (「총 1,234건 중 1001–1050번째」).
 */
test('화면의 수가 lib 과 같은 자로 끊긴다 (DS 60-3)', opts, async () => {
  const { comma } = await loadFns(['comma']);
  const N = await importLib('num');

  for (const v of [0, 7, 999, 1000, 2000, 100000, 1234567, -1200, 1234.5, -0.25, NaN, Infinity]) {
    assert.equal(comma(v), N.comma(v), `lib 과 다른 자로 끊는다: ${String(v)}`);
  }

  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  // 화면 코드에 Intl 서식이 **한 곳도** 남지 않았다(주석의 설명 문장은 센 자리가 아니다).
  const calls = src.replace(/`[^`]*`/g, '``').match(/\.toLocale(String|TimeString|DateString)\(/g) || [];
  assert.deepEqual(calls, [], `Intl 서식이 남아 있다: ${calls.join(', ')}`);
  // 쪽수 줄은 한 문장 안에서 자가 갈리지 않는다.
  assert.ok(
    src.includes('총 {comma(info.total)}{unit} 중 {comma(info.from)}–{comma(info.to)}번째'),
    '쪽수 줄이 총계만 끊어 적는다',
  );
});

/* ══════════ 61순위 — 백로그 소진 후 58차 재감사 (DS 61-3) ══════════ */

/**
 * DS 61-3 — 운영자가 **적은 이름**에 조사를 손으로 붙인 자리.
 *
 * 가려진 규칙 안내(DS 44-3)는 토스트와 목록 두 곳에서 같은 말을 한다. 그 문장은 운영자가
 * 직접 적은 **키워드**와 **규칙 이름**을 끼워 넣는데, 조사는 글자로 박혀 있었다 —
 * 「「환불」는 기본 규칙 「요금 안내」이 먼저 답합니다」. 둘 다 운영자가 저장을 누른 직후
 * 가장 먼저 읽는 문장이다.
 *
 * 콘솔은 lib 을 불러오지 않으므로(클라이언트 묶음) 판정은 `src/lib/refusal.ts` 의 **사본**이다 —
 * 떼어내 실제로 돌려 두 결과를 글자까지 대조한다(`timeLabel`·`comma` 와 같은 규약).
 */
test('콘솔이 운영자가 적은 이름에 맞는 조사를 붙인다 (DS 61-3)', opts, async () => {
  const { josa, particle } = await loadConsoleFns(['batchimOf', 'particle', 'josa']);
  const R = await importLib('refusal');

  const WORDS = ['환불', '요금 안내', '배송 문의', '서울', '취소', 'CSV', 'eum', 'gmail', 'ESC-0001', 'ESC-0010', '010-****-5673', '「환불」', '***', ''];
  const PAIRS = [['은', '는'], ['이', '가'], ['을', '를'], ['으로', '로'], ['과', '와']];
  for (const w of WORDS) {
    for (const [a, b] of PAIRS) {
      assert.equal(particle(w, a, b), R.particle(w, a, b), `lib 과 다른 조사를 고른다: ${w} ${a}/${b}`);
      assert.equal(josa(w, a, b), R.josa(w, a, b), `lib 과 다른 글자를 적는다: ${w} ${a}/${b}`);
    }
  }
  // 종전 결함이 재현되는 값인가 — 사본이 한글만 보던 때 이 셋은 모두 받침 없는 쪽으로 떨어졌다.
  assert.equal(particle('환불', '은', '는'), '은');
  assert.equal(particle('ESC-0010', '으로', '로'), '으로');
  assert.equal(particle('gmail', '은', '는'), '은');

  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  // 두 자리(저장 직후 토스트·목록 줄)가 **같은 자**로 고른다 — 한쪽만 고치면 또 갈라진다.
  assert.ok(
    src.includes("「${shadow.keyword}」${particle(shadow.keyword, '은', '는')}"),
    '저장 직후 안내가 키워드의 조사를 손으로 적는다',
  );
  assert.ok(
    src.includes("「${shadow.label}」${particle(shadow.label, '이', '가')}"),
    '저장 직후 안내가 규칙 이름의 조사를 손으로 적는다',
  );
  assert.ok(
    src.includes("「{r.shadowedBy.keyword}」{particle(r.shadowedBy.keyword, '은', '는')}"),
    '목록 줄이 키워드의 조사를 손으로 적는다',
  );
  assert.ok(
    src.includes("「{r.shadowedBy.label}」{particle(r.shadowedBy.label, '이', '가')}"),
    '목록 줄이 규칙 이름의 조사를 손으로 적는다',
  );
  // 사본임을 밝혀 둔다 — 밝히지 않으면 다음 사람이 한쪽만 고친다(DS 29-3 의 규약).
  assert.match(src, /원본은 `src\/lib\/refusal\.ts`\(particle\)/, '사본임을 밝히지 않는다');
  assert.match(src, /원본은 `src\/lib\/refusal\.ts`\(batchimOf\)/, '사본임을 밝히지 않는다');
});

/**
 * DS 61-3 — 값 바로 뒤에 조사를 **글자로** 적은 자리가 화면 코드에 남지 않았는가.
 * (다시 생기는 것을 막는 자리다 — 새 문장이 「…}는」으로 들어오면 여기서 걸린다.)
 */
test('화면이 값 뒤에 조사를 글자로 박아 두지 않는다 (DS 61-3)', opts, () => {
  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  // 주석은 센 자리가 아니다 — 블록 주석·줄 주석을 먼저 걷어낸다.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  // 값 바로 뒤(닫는 괄호·따옴표 하나는 넘겨 가며)에 조사가 붙은 자리.
  // 「건」·「가지」·「번째」 같은 셈말은 조사가 아니다 — 조사 다음이 공백·문장부호인 자리만 센다.
  const hits = code.match(/\}[」』'"]?(은|는|을|를|이|가|으로|와|과)[\s.,·—]/g) || [];
  assert.deepEqual(hits, [], `값 뒤에 조사를 글자로 적은 자리가 남았다: ${hits.join(' / ')}`);
});

/* ══════════ 62순위 — 백로그 소진 후 59차 재감사 (DS 62-1·62-2) ══════════ */

/**
 * DS 62-1·62-2 — 콘솔이 목록 한 줄을 **줄이는 자**.
 *
 * 이 화면이 줄이는 값은 고객이 적은 질문·운영자가 적은 이름·답변 본문이다. `slice` 는 글자가
 * 아니라 UTF-16 칸을 세므로, 상한이 이모지 가운데 떨어지면 목록 끝에 `�` 가 보였다. 콘솔은
 * lib 을 불러오지 않으므로(클라이언트 묶음) 판정은 `src/lib/limits.ts` 의 **사본**이다 —
 * 떼어내 실제로 돌려 두 결과를 글자까지 대조한다(`josa`·`comma` 와 같은 규약).
 */
test('콘솔이 줄이는 자가 글자를 쪼개지 않고 lib 과 같은 글자를 적는다 (DS 62-1·62-2)', opts, async () => {
  const { cutEnd, ellipsize } = await loadConsoleFns(['cutEnd', 'ellipsize'], ['JOINS_LEFT', 'REGIONAL']);
  const L = await importLib('limits');
  const survivesUtf8 = (s) => Buffer.from(s, 'utf8').toString('utf8') === s;

  const VALUES = [
    '환불 수수료가 어떻게 되나요',
    `${'가'.repeat(8)}🙏${'나'.repeat(8)}`,
    `${'가'.repeat(8)}👩‍👩‍👧${'나'.repeat(8)}`,
    `${'가'.repeat(8)}👍\u{1F3FB}${'나'.repeat(8)}`,
    `${'가'.repeat(8)}1️⃣${'나'.repeat(8)}`,
    `${'가'.repeat(8)}\u{1F1F0}\u{1F1F7}${'나'.repeat(8)}`,
    `${'가'.repeat(8)}각${'나'.repeat(8)}`,
    '짧다',
    '',
  ];
  for (const v of VALUES) {
    for (let n = 0; n <= v.length + 2; n += 1) {
      assert.equal(cutEnd(v, n), L.cutEnd(v, n), `lib 과 다른 자리에서 자른다: ${JSON.stringify(v)} n=${n}`);
      assert.equal(ellipsize(v, n), L.ellipsize(v, n), `lib 과 다른 글자를 적는다: ${JSON.stringify(v)} n=${n}`);
      assert.ok(survivesUtf8(ellipsize(v, n)), `반쪽 글자가 남았다: ${JSON.stringify(v)} n=${n}`);
      assert.ok(ellipsize(v, n).length <= n, `상한을 넘겼다: ${JSON.stringify(v)} n=${n}`);
    }
  }
  // 종전 결함이 재현되는 값인가 — 사본이 칸만 세던 때 이 자리는 반쪽 글자로 끝났다.
  const v = `${'가'.repeat(8)}🙏${'나'.repeat(8)}`;
  assert.equal(survivesUtf8(`${v.slice(0, 8)}…`), true, '재현 조건이 바뀌었다');
  assert.equal(survivesUtf8(`${v.slice(0, 9)}…`), false, '재현 조건이 성립하지 않는다 — 종전 식도 멀쩡하다');
  assert.equal(ellipsize(v, 10), '가가가가가가가가…', '이모지가 들어갈 자리가 없으면 그 앞에서 끊는다');

  const src = readFileSync(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
  // 줄이는 자는 화면에 **한 곳**이다 — 목록 요약(`clip`)도 그 자를 지난다.
  assert.ok(
    src.includes("function clip(v: string, n = 64): string {\n  return ellipsize(v.replace(/\\s+/g, ' ').trim(), n);\n}"),
    '목록 요약이 따로 자른다',
  );
  // 사본임을 밝혀 둔다 — 밝히지 않으면 다음 사람이 한쪽만 고친다.
  assert.ok(src.includes('원본은 `src/lib/limits.ts`(JOINS_LEFT·REGIONAL)'), '사본임을 밝히지 않는다(JOINS_LEFT)');
  assert.ok(src.includes('`src/lib/limits.ts`(cutEnd)'), '사본임을 밝히지 않는다(cutEnd)');
  assert.ok(src.includes('`src/lib/limits.ts`(ellipsize·ELLIPSIS)'), '사본임을 밝히지 않는다(ellipsize)');
  // 손으로 자른 뒤 「…」를 붙이는 자리가 남지 않았다(다시 생기는 것을 막는 자리다).
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const hits = code.match(/\.length > \w+ \? `?\$?\{?\w+\.slice\(0,[^\n]*…/g) || [];
  assert.deepEqual(hits, [], `손으로 자르는 자리가 남았다: ${hits.join(' / ')}`);
});
