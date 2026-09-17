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
  // 관리 토큰 입력은 헤더가 아니라 로그인 화면에 있다(DS 2-8) — 헤더에는 로그인/로그아웃 진입만 남긴다
  assert.equal(/id="ac-token"/.test(html), false, '헤더의 토큰 입력은 사라져야 한다');
  assert.match(html, />로그인</, '헤더에서 로그인 화면으로 갈 수 있어야 한다');
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
  assert.match(css, /\.ac-offline\{[^}]*#FFFBEB/, '경고 톤');
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
  assert.match(t, /aria-busy=\{testBusy/, '응답 대기 표시');
  assert.match(t, /gw-dot/, '타이핑 인디케이터(위젯과 같은 것)');
  assert.match(t, /INTENT_LABELS\[t\.intent\]/, '주제는 사람 말로');
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
  assert.match(t, /aria-busy=\{crBusy/, '저장 중 잠금');
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
  assert.match(login, /aria-busy=\{authBusy/, '확인 중 잠금');
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
  assert.match(d, /aria-busy=\{busy\}/, '상태 변경 중 잠금');
  assert.match(src, /e\.key === 'Escape'\) closeTicket\(\)/, 'ESC 로 닫힌다');
  assert.match(src, /ticketReturnRef\.current = from/, '닫으면 연 행으로 초점 복귀');
  // 마스킹 함수가 실제로 가린다
  assert.match(src, /digits\.slice\(0, 3\)\}-\*\*\*\*-\$\{digits\.slice\(-4\)/, '전화 가운데 마스킹');
  // 375px: 사유·시각 열은 접히고 서랍은 전체폭
  const mobile = css.slice(css.indexOf('@media (max-width:900px){\n  .ac-shell'));
  assert.match(mobile, /\.ac-col-wide\{display:none\}/);
  assert.match(mobile, /\.ac-drawer\{width:100vw\}/);
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
  assert.match(t, /<th scope="col">근거<\/th>/, '근거 라벨 열');
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
  assert.match(t, /aria-busy=\{partnerSaving \|\| undefined\}/, '저장 중 잠금');
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
  assert.match(t, /aria-busy=\{settleBusy \|\| undefined\}/, '계산 중 버튼 잠금');
  assert.match(t, /disabled=\{!r \|\| r\.rows\.length === 0\}/, '내려받을 것이 없으면 CSV 버튼 잠금');
  assert.match(t, /aria-disabled=\{dlBusy !== '' \|\| undefined\}/, '내려받는 중에는 중복 실행을 막는다');
  // 확정본이 아님은 계속 밝히되, 내부 개발 표기([승인 필요])를 화면에 쓰지 않는다(DS 5-3).
  assert.match(t, /실제 청구·지급은 계약서가 확정된 뒤에 진행합니다/, '확정 아님을 밝힌다');
  assert.equal(/#c0392b|#b26a00/.test(t), false, '색은 토큰만');
  assert.match(t, /className="ac-col-wide"/, '좁은 화면에서 접히는 열');
});
