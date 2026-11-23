/**
 * 화면 문구 금지어 검사 (AICC 웹 개편 기준 4절, 2026-11-23 대표 지시로 추가).
 * 기준: D:\Desktop\GOWON\Dev\_자동개발\prompts\_AICC_웹개편_기준.md
 * 화면에 나가는 소스(주석 줄 제외)에 과장, 번역투, AI 만능 표현이 들어가면 실패한다.
 * 금지어를 고치려면 기준서와 `_자동개발\tools\web_quality_check.py` 의 목록도 같이 고친다.
 * 원본: `_자동개발\tools\copy-lint.template.mjs`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const SCAN_DIRS = ["src"];
const BANNED = [
  '혁신적', '획기적', '차세대', '완벽한', '놀라운', '한 차원 높은', '새로운 패러다임',
  '게임 체인저', '게임체인저', '스마트한', '경험하세요', '경험해 보세요', '힘을 느껴',
  '만나 보세요', '만나보세요', '잠재력', 'AI가 모든', 'AI 가 모든', '스스로 학습', '사람처럼 이해',
  '데모 데이터', '여정',
];
const EXT = /\.(tsx|ts|jsx|js|mjs|html)$/;

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.') || name === '_지울것') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXT.test(name)) out.push(p);
  }
  return out;
}

function isComment(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--') || t.startsWith('{/*');
}

test('화면 문구에 금지어가 없다 (AICC 웹 개편 기준 4절)', () => {
  const hits = [];
  for (const d of SCAN_DIRS) {
    const abs = join(ROOT, d);
    if (!existsSync(abs)) continue;
    for (const f of walk(abs, [])) {
      readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (isComment(line)) return;
        for (const w of BANNED) if (line.includes(w)) hits.push(`${relative(ROOT, f)}:${i + 1} 「${w}」`);
      });
    }
  }
  assert.equal(hits.length, 0, `금지어 ${hits.length}곳. 업무 언어로 바꾸세요.\n${hits.slice(0, 30).join('\n')}`);
});
