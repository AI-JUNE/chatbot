const fs = require('fs');
const f = 'src/app/admin/page.tsx';
let s = fs.readFileSync(f, 'utf8');
const pairs = [
  ["{a.contractedAt || '—'}", "{a.contractedAt || '-'}"],
  ["{p.managerName || '—'}", "{p.managerName || '-'}"],
  ["<td style={{ color: 'var(--mut)' }}>—</td>", "<td style={{ color: 'var(--mut)' }}>-</td>"],
  ["<td className=\"ac-col-wide\" style={{ color: 'var(--mut)' }}>—</td>", "<td className=\"ac-col-wide\" style={{ color: 'var(--mut)' }}>-</td>"],
  ["<span style={{ color: 'var(--mut)' }}>—</span>", "<span style={{ color: 'var(--mut)' }}>-</span>"],
  ["`${label} — 세로로 스크롤할 수 있습니다`", "`${label}, 세로로 스크롤할 수 있습니다`"],
  ["`${label} — 가로로 스크롤할 수 있습니다`", "`${label}, 가로로 스크롤할 수 있습니다`"],
  ["`최근 7일 일자별 대화 건수 — ${label}`", "`최근 7일 일자별 대화 건수, ${label}`"],
  ["`${label} — 새 창에서 열립니다`", "`${label}, 새 창에서 열립니다`"],
];
let n = 0;
for (const [a, b] of pairs) {
  const c = s.split(a).length - 1;
  n += c;
  console.log(c, a);
  s = s.split(a).join(b);
}
fs.writeFileSync(f, s, 'utf8');
console.log('total', n);
