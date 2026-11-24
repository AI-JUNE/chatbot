// 전체 테스트를 돌려 실패와 요약만 출력한다.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const files = fs.readdirSync('tests').filter((f) => f.endsWith('.test.mjs')).map((f) => 'tests/' + f);
const r = spawnSync(process.execPath, ['--test', ...files], { encoding: 'utf8', maxBuffer: 1 << 28 });
const text = (r.stdout || '') + (r.stderr || '');
const lines = text.split('\n');
const out = [];
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (/^\s*✖/.test(l) || /^ℹ (tests|pass|fail|cancelled|skipped)/.test(l)) out.push(l);
}
// 실패 상세(처음 몇 건)
const idx = lines.findIndex((l) => /failing tests:/.test(l));
if (idx >= 0) out.push(...lines.slice(idx, idx + 120));
console.log(out.join('\n'));
