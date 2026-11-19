import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// AICC 웹 개편 4단계: 랜딩 화면 문구에 꾸밈 기호와 과장 표현이 없다.
const src = readFileSync('src/app/page.tsx', 'utf8');
// 주석을 뺀 본문만 본다.
const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('랜딩 문구에 줄표·화살표·가운뎃점이 없다', () => {
  for (const ch of ['—', '→', '·']) {
    assert.ok(!body.includes(ch), `${ch} 가 화면 문구에 남아 있다`);
  }
});

test('랜딩 문구에 과장 표현이 없다', () => {
  for (const w of ['혁신', '획기', '차세대', '완벽', '놀라운', '경험하세요', '만나 보세요', '여정']) {
    assert.ok(!body.includes(w), `${w} 가 남아 있다`);
  }
});
