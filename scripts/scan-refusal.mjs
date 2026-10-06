// 임시 점검 스크립트 — 서버가 쓰는 한국어 문장 중 영문 토큰이 남은 것을 찾는다.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const roots = ['src/lib', 'src/app/api'];
const files = [];
const walk = (d) => {
  for (const e of readdirSync(d)) {
    const p = path.join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.ts')) files.push(p);
  }
};
roots.forEach(walk);

const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

for (const f of files) {
  const src = stripComments(readFileSync(f, 'utf8'));
  const lits = src.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) || [];
  for (const lit of lits) {
    const body = lit.slice(1, -1);
    if (!/[가-힣]/.test(body)) continue;
    const ascii = body.match(/[A-Za-z_]{2,}/g);
    if (ascii) console.log(f, '→', body, '::', ascii.join(','));
  }
}
