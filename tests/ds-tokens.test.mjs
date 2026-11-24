import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// GOWON 디자인 시스템 v1.0, 1단계: gowon-tokens.css 가 색의 단일 출처이고 globals.css 는 별칭만 둔다.
const ds = readFileSync('src/app/gowon-tokens.css', 'utf8');
const css = readFileSync('src/app/globals.css', 'utf8');
const layout = readFileSync('src/app/layout.tsx', 'utf8');
const root = css.split(':root{')[1].split('\n}')[0];

test('디자인 시스템 토큰 파일이 기준값을 담고 레이아웃이 globals.css 보다 먼저 싣는다', () => {
  for (const v of ['--gw-blue-600:#0C66E4', '--gw-blue-700:#0055CC', '--gw-blue-50:#E9F2FF', '--gw-n900:#172B4D', '--gw-r-lg:8px', '--gw-r-sm:3px']) {
    assert.ok(ds.includes(v), `${v} 가 없다`);
  }
  assert.ok(layout.indexOf("'./gowon-tokens.css'") > -1, '레이아웃이 토큰 파일을 싣지 않는다');
  assert.ok(layout.indexOf("'./gowon-tokens.css'") < layout.indexOf("'./globals.css'"), '토큰이 globals.css 보다 먼저 와야 한다');
});

test('토큰 파일에는 위젯 클래스와 겹치는 컴포넌트 규칙이 없다', () => {
  assert.equal(/\.gw-panel\s*\{/.test(ds), false, '.gw-panel 은 위젯의 기존 클래스다 — 토큰 파일에 넣지 않는다');
  assert.equal(/^\s*(body|html|h1|a)\s*\{/m.test(ds), false, '전역 요소 규칙은 토큰 파일에 두지 않는다');
});

test('globals.css 의 색·모서리·그림자 별칭은 --gw-* 를 가리키고 옛 hex 가 남지 않는다', () => {
  for (const k of ['--bg', '--surface', '--line', '--sand', '--ink', '--sub', '--brand', '--brand-600', '--brand-50', '--success', '--warn', '--danger', '--r', '--r-sm', '--r-lg', '--shadow-card', '--shadow-pop', '--font']) {
    assert.match(root, new RegExp(`${k}:var\\(--(gw|svc)-[a-z0-9-]+\\)`), `${k} 가 디자인 시스템 토큰을 가리키지 않는다`);
  }
  for (const old of ['#2457C5', '#1C459E', '#EEF3FC', '#191F28', '#4E5968', '#F7F8FA']) {
    assert.equal(css.includes(old), false, `옛 기준 값 ${old} 이 남아 있다`);
  }
});
