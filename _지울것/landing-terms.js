const fs = require('fs');
const f = 'src/app/page.tsx';
const lines = fs.readFileSync(f, 'utf8').split('\n');
const targets = [75, 80, 82, 89, 101, 106, 112, 113, 127, 128, 140, 199, 362, 387];
for (const n of targets) {
  let s = lines[n - 1];
  s = s.replace(/상담원/g, '상담사').replace("['자동 완결',", "['봇 처리율',").replace(/자동 완결과 전환 비율/g, '봇 처리율과 상담사 전환율').replace(/대화량, 자동 완결, 상담사 전환/g, '대화량, 봇 처리율, 상담사 전환율').replace("['상담사 전환',", "['상담사 전환율',");
  lines[n - 1] = s;
}
fs.writeFileSync(f, lines.join('\n'));
