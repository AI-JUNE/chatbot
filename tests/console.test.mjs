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
  assert.match(t, /busyBtn\(testBusy, testBusy/, '응답 대기 표시');
  assert.match(t, /gw-dot/, '타이핑 인디케이터(위젯과 같은 것)');
  // 주제는 서버가 붙여 준 이름을 그린다 — 화면이 사전을 따로 들고 코드를 폴백하지 않는다(DS 22-2).
  assert.match(t, /\{t\.intentLabel \|\| UNNAMED_TOPIC\}/, '주제는 서버가 준 이름으로');
  assert.match(t, /SOURCE_VIEW_LABELS\[t\.source\]/, '근거는 사람 말로');
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
  assert.match(t, /표현으로 이 규칙이 적용됩니다/, '적용 근거를 보여준다');
  assert.match(t, /규칙이 적용되지 않습니다/, '미적용 상태도 알려준다');
  assert.match(t, /「응답 테스트」에서 확인하세요/, '근사치임을 밝힌다');
  // 빈 상태·검색 0건·삭제 확인·토스트
  assert.match(t, /아직 만든 규칙이 없습니다/, '빈 상태');
  assert.match(t, /검색 결과가 없습니다/, '검색 0건');
  // 확인 절차는 유지하되, 브라우저 기본 대화상자가 아니라 브랜드 대화상자를 거친다(DS 5-4).
  // 무엇을 지우는지(규칙 이름)를 대화상자가 따로 강조한다.
  assert.match(src, /askConfirm\(\{[\s\S]{0,200}이 규칙을 삭제할까요/, '삭제는 확인을 거친다');
  assert.match(src, /target: target\?\.label \?\? intent/, '지우는 대상을 밝힌다');
  assert.match(src, /flash\(crEditing \? '규칙을 수정했습니다\.' : '규칙을 추가했습니다\.'\)/, '저장 토스트');
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
  assert.match(t, /aria-label="요청 검색\(고객 말·사유·접수번호\)"/, '검색 입력 라벨');
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
  assert.match(src, /<ScrollX label="설치 코드">[\s\S]{0,400}<code>\{installSnippet\(origin\)\}<\/code>/, '설치 코드 블록이 스크롤 영역 밖에 있다');
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

  assert.match(
    body('removeKB'),
    /if \(editingId === id\) \{ setEditingId\(null\); loadKbForm\(EMPTY_FORM\); setKbErr\(\{\}\); \}/,
    '지운 자료를 가리킨 폼이 남아 「수정 저장」이 그 자료를 되살린다',
  );
  // 규칙 쪽은 처음부터 거두고 있었다 — 두 탭이 갈라지면 같은 일을 다르게 하는 콘솔이 된다.
  assert.match(body('removeCustomRule'), /if \(crEditing === intent\) \{/, '규칙 쪽 거두기가 사라졌다');
  // 초기화는 **수정 중일 때만** 거둔다 — 새로 적던 글은 지워진 것과 아무 상관이 없다.
  assert.match(body('resetAll'), /if \(editingId\) \{ setEditingId\(null\); loadKbForm\(EMPTY_FORM\); setKbErr\(\{\}\); \}/, '초기화가 적던 새 자료까지 버린다');
});

/* ══════════ 29순위 — 백로그 소진 후 26차 재감사 (DS 29-x) ══════════ */

/** 모듈 안에만 있는 최상위 함수를 컴파일된 JS 에서 떼어내 실제로 돌린다(DS 27-2 와 같은 방식). */
async function loadConsoleFns(names) {
  await loadConsole();
  const parts = names.map((n) => {
    const i = cachedJs.indexOf(`function ${n}(`);
    assert.ok(i >= 0, `${n} 선언을 찾지 못했다`);
    const end = cachedJs.indexOf('\n}', i);
    assert.ok(end > i, `${n} 의 끝을 찾지 못했다`);
    return cachedJs.slice(i, end + 2);
  });
  return new Function(`${parts.join('\n')}\nreturn { ${names.join(', ')} };`)();
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
  const { josa } = await loadConsoleFns(['josa']);
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

  // ② 데이터 표 8장 전부가 정렬되는 머리칸을 가진다(설치 「선택 옵션」 표는 고정 안내라 제외).
  const lines = src.split('\n');
  const skip = new Set(['설치 선택 옵션']);
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
  assert.match(comp, /총 \{info\.total\.toLocaleString\('ko-KR'\)\}\{unit\} 중 \{info\.from\}–\{info\.to\}번째 · \{info\.page\}\/\{info\.pages\} 페이지/, '페이저 문구');
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
  assert.match(route, /feedback: feedbackSummary\(\)/, '응답에 평가가 실리지 않는다');

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
  assert.match(dash, /if \(d\.citation === NO_CITATION_LABEL\)/, '근거 없음 행도 자료처럼 누르게 둔다');
  assert.match(dash, /<div className="ac-row" data-static="">/, '누를 수 없는 행이 누를 수 있어 보인다');

  // 4) 「근거 없음」 표기는 서버 사전과 같아야 한다 — 어긋나면 그 행만 영영 자료로 데려간다.
  const label = (src.match(/const NO_CITATION_LABEL = '([^']+)'/) || [])[1];
  assert.ok(label, 'NO_CITATION_LABEL 이 없다');
  assert.ok(lib.includes(`e.citation || '${label}'`), `서버의 근거 없음 표기와 어긋난다: ${label}`);

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

  assert.match(route, /unanswered: unansweredQuestions\(8\)/, '서버가 답하지 못한 질문을 내려보내지 않는다');

  const dash = src.slice(src.indexOf("{tab === 'dash' && ("), src.indexOf('{/* ── 답변 평가'));
  assert.ok(dash.includes('<h2 style={S.h2}>자료에 없어 답하지 못한 질문</h2>'), '답하지 못한 질문 카드가 없다');
  // 보여 준 수를 찾은 수라 말하지 않는다(DS 31-3 과 같은 규칙) — 묶음 수·총 횟수를 함께 적는다.
  assert.match(dash, /unanswered\.groups > unanswered\.items\.length/, '자른 수를 전체라고 말한다');
  assert.match(dash, /가지 중 \$\{unanswered\.items\.length\}가지/, '몇 가지 중 몇 가지인지 말하지 않는다');
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
