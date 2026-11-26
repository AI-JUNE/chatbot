const fs = require('fs');
const root = 'D:/Desktop/GOWON/Dev/3. Chatbot/src/';
const targets = {
  'components/PublicFooter.tsx': [51],
  'app/privacy/page.tsx': [31, 36, 43, 93],
  'app/terms/page.tsx': [30, 32, 45, 54],
  'app/layout.tsx': [8],
  'components/ChatWidget.tsx': [1015, 1031, 1952, 1956, 1963, 1972, 1984, 1989, 2164, 2166, 2172, 2269],
};
for (const [f, lines] of Object.entries(targets)) {
  const p = root + f;
  const src = fs.readFileSync(p, 'utf8');
  const nl = src.includes('\r\n') ? '\r\n' : '\n';
  const arr = src.split(nl);
  for (const n of lines) {
    const before = arr[n - 1];
    arr[n - 1] = before.replace(/상담원이/g, '상담사가').replace(/상담원을/g, '상담사를').replace(/상담원/g, '상담사');
    if (before === arr[n - 1]) console.log('NO CHANGE', f, n);
  }
  fs.writeFileSync(p, arr.join(nl), 'utf8');
}
console.log('done');
