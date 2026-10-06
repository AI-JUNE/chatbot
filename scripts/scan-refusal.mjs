// 임시 점검 스크립트 — unit.test.mjs 의 DS 29-3 검사가 **고치기 전 코드를 실제로 잡는지** 확인한다.
// (사용: node scripts/scan-refusal.mjs — HEAD 판본을 꺼내 같은 규칙으로 훑는다)
import { execFileSync } from 'node:child_process';

const FILES = [
  'src/lib/http.ts', 'src/lib/adminStore.ts', 'src/lib/audit.ts', 'src/lib/convlog.ts',
  'src/lib/escalation.ts', 'src/lib/partners.ts', 'src/lib/settlement.ts', 'src/lib/feedback.ts',
  'src/app/api/admin/auth/route.ts', 'src/app/api/admin/kb/route.ts', 'src/app/api/admin/rules/route.ts',
  'src/app/api/admin/partners/route.ts', 'src/app/api/admin/escalations/route.ts',
];

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const litText = (raw) => raw.replace(/\$\{[^{}]*\}/g, '');
const OK_WORDS = new Set(['CSV', 'URL', 'AI', 'GOWON']);
const BANNED_KO = ['배열', '객체', '파싱', '티켓', '상태값', '네임스페이스', '스냅샷'];

let hits = 0;
for (const f of FILES) {
  let src;
  try { src = execFileSync('git', ['show', `${process.argv[2] || 'HEAD'}:${f}`], { encoding: 'utf8' }); } catch { continue; }
  src = stripComments(src);
  const found = [
    ...src.matchAll(/fail\(\s*'[a-z_]+'\s*,\s*(?:'([^']*)'|`([^`]*)`)/g),
    ...src.matchAll(/\berror:\s*(?:'([^']*)'|`([^`]*)`)/g),
    ...src.matchAll(/\breason\s*=\s*(?:'([^']*)'|`([^`]*)`)/g),
    ...src.matchAll(/^\s*(?:export const )?[A-Z_]*MESSAGE[A-Z_]*\s*=\s*(?:'([^']*)'|`([^`]*)`)/gm),
    ...src.matchAll(/^\s{2}[a-z_]+:\s*'([^']*)'/gm),
  ].map((m) => litText(m[1] ?? m[2] ?? ''));
  for (const msg of found) {
    if (!/[가-힣]/.test(msg)) continue;
    const bad = [
      ...(msg.match(/[A-Za-z_]{2,}/g) || []).filter((w) => !OK_WORDS.has(w)),
      ...BANNED_KO.filter((k) => msg.includes(k)),
      ...(/YYYY|MM-DD|\bbp\b/.test(msg) ? ['형식/단위 토큰'] : []),
    ];
    if (bad.length) { hits += 1; console.log(`${f} :: ${msg} :: ${bad.join(',')}`); }
  }
}
console.log(`\n고치기 전 판본에서 잡힌 문장: ${hits}건`);
