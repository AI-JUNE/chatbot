const fs = require('fs');
const path = require('path');
const src = 'D:\\Desktop\\GOWON\\Dev\\2. Callbot\\v2\\callbot-portal\\public\\img\\landing';
const dst = path.join(__dirname, '..', 'public', 'img', 'landing');
fs.mkdirSync(dst, { recursive: true });
for (const f of ['hero-agent.webp', 'night-office.webp', 'ops-team.webp']) {
  fs.copyFileSync(path.join(src, f), path.join(dst, f));
  console.log('copied', f, fs.statSync(path.join(dst, f)).size);
}
