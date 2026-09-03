import { test } from 'node:test';
import { importLib } from './tests/_compile.mjs';
test('probe', async () => {
  process.env.CHAT_LLM_LIVE = 'true';
  const chat = await importLib('chat', ['knowledge','rules','normalize','adminStore','session','escalation','handoff','llm','monitoring','storage','logger','convlog']);
  const session = await importLib('session', []);
  const cands = ['도입 절차와 기간이 어떻게 되는지 자세히 설명해 주세요','무료 체험 관련해서 조건을 좀 더 자세히 알려주세요','우리 회사 업무에 맞게 바꿀 수 있는지 자세히','채널 지원 범위를 자세히 알려주세요'];
  for (const q of cands) {
    session.resetSessions();
    const r = chat.replyTo(q, 'p'+Math.random());
    console.log(JSON.stringify({q, source:r.source, intent:r.intent, sug:(r.suggestions||[]).map(s=>s.id)}));
  }
});
