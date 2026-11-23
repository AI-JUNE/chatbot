import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// AICC 웹 개편 5단계: 콘솔 표 머리와 배지가 콜봇 포털 규격(sand 바탕)을 따른다.
const css = readFileSync('src/app/globals.css', 'utf8');

test('sand 토큰이 기준값으로 정의돼 있다', () => {
  assert.match(css, /--sand:#F1F3F6/);
});

test('표 머리와 배지는 sand 바탕을 쓴다', () => {
  assert.match(css, /\.ac-table th\{[^}]*background:var\(--sand\)/);
  assert.match(css, /\.ac-badge\{[^}]*background:var\(--sand\)/);
});

test('콘솔 머리줄 상태 배지에 개발자 표현이 없다', () => {
  const page = readFileSync('src/app/admin/page.tsx', 'utf8');
  assert.ok(!page.includes("'인증 미설정'"));
  assert.match(page, /로그인 없이 열림/);
});

test('표 줄 높이가 넉넉하다', () => {
  assert.match(css, /\.ac-table td\{padding:13px 12px/);
});
