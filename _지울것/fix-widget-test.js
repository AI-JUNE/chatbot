const fs = require('fs');
const p = 'D:/Desktop/GOWON/Dev/3. Chatbot/tests/widget.test.mjs';
const src = fs.readFileSync(p, 'utf8');
const nl = src.includes('\r\n') ? '\r\n' : '\n';
const arr = src.split(nl);
for (const n of [840, 1124, 1140, 1231, 1236, 1323, 1479, 1509]) {
  const b = arr[n - 1];
  arr[n - 1] = b.replace(/상담원이/g, '상담사가').replace(/상담원/g, '상담사');
  if (b === arr[n - 1]) console.log('NO CHANGE', n);
}
fs.writeFileSync(p, arr.join(nl), 'utf8');
