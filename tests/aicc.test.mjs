/**
 * AICC-Core 채널 어댑터 소비 검증.
 *
 * 이 테스트가 지키는 한 문장: **챗봇은 Core가 시킨 것만, 승인된 경우에만 매체로 내보낸다.**
 * 계약 자체의 적합성은 Core의 실행기(`npm run conformance:aicc`)가 CI에서 판정하고,
 * 여기서는 이 저장소가 책임지는 부분(렌더·활성화·실패 전파)을 본다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { importLib, tscPath } from './_compile.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const has = (p) => existsSync(new URL(`../${p}`, import.meta.url));
const CAN_COMPILE = tscPath() !== null;
const opts = CAN_COMPILE ? {} : { skip: 'typescript 미설치 — npm ci 후 실행' };

const env = { interactionId: 'i1', adapter: 'chatbot', channel: 'chat', kind: 'present' };

/* ── 배선(정적) ─────────────────────────────────────────────────────────────── */

test('적합성 검사 입력과 실행 스크립트가 저장소에 있다', () => {
  assert.equal(has('ci/aicc-port.mjs'), true, '검사할 포트 모듈이 없으면 CI가 계약을 확인할 수 없다');
  assert.equal(has('ci/aicc-flows.mjs'), true);
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.scripts['conformance:aicc'], '실행기 스크립트가 없으면 계약 드리프트가 조용히 쌓인다');
  assert.match(read('scripts/aicc-conformance.mjs'), /--flows/, '시나리오를 빼면 판정보류가 된다 — 통과로 넘기지 않는다');
  assert.match(read('scripts/aicc-conformance.mjs'), /--timeout-ms/, '응답 예산 없이 통과로 적지 않는다');
  assert.equal(pkg.devDependencies['aicc-core'], undefined, 'Core 를 file: 의존으로 박으면 Core 없는 체크아웃에서 npm ci 가 통째로 실패한다');
  assert.equal(has('scripts/aicc-conformance.mjs'), true, 'Core 위치를 찾지 못하면 판정보류로 끝내는 호출부가 있어야 한다');
  const runner = read('scripts/aicc-conformance.mjs');
  assert.match(runner, /exit\(2\)/, '검사를 못 돌린 경우를 통과(0)로 끝내지 않는다');
});

test('CI 포트는 드라이런이다 — 검사가 실매체로 나가지 않는다', () => {
  const s = read('ci/aicc-port.mjs');
  assert.equal(/activation:\s*'live'/.test(s), false, 'CI 포트가 live 면 검사 자체가 발송 사고가 된다');
  assert.equal(/transport:/.test(s), false, '전송기를 주입하지 않는다');
});

test('CI 시나리오에 개인정보가 들어 있지 않다(§10.3)', () => {
  const s = read('ci/aicc-flows.mjs');
  assert.equal(/01[016789]-?\d{3,4}-?\d{4}/.test(s), false, '전화번호 형태가 있으면 실자료가 섞인 것이다');
  assert.equal(/\d{6}-\d{7}/.test(s), false, '주민등록번호 형태 금지');
  assert.equal(/[\w.+-]+@[\w-]+\.[\w.]+/.test(s), false, '이메일 형태 금지');
});

/* ── 렌더(정상 경로) ────────────────────────────────────────────────────────── */

test('말하기·버튼·폼 단계가 각각의 챗 메시지로 렌더된다', opts, async () => {
  const m = await importLib('aiccTransport');
  const out = m.renderEnvelope({
    ...env,
    steps: [
      { channel: 'chat', nodeId: 'n1', kind: 'Say', text: '안녕하세요.' },
      { channel: 'chat', nodeId: 'n2', kind: 'Choice', text: '선택해 주세요.', ui: { type: 'buttons', items: [{ label: '안내', value: 'guide' }] } },
      { channel: 'chat', nodeId: 'n3', kind: 'Collect', text: '내용을 입력해 주세요.', ui: { type: 'form', slot: 'purpose' } },
    ],
  });
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((o) => o.kind), ['say', 'choice', 'form']);
  assert.deepEqual(out[1].quickReplies, [{ label: '안내', value: 'guide' }]);
  assert.equal(out[2].slot, 'purpose');
  assert.equal(out[0].interactionId, 'i1');
});

test('이관·종료는 고객 안내 문구로 바뀐다', opts, async () => {
  const m = await importLib('aiccTransport');
  const t = m.renderEnvelope({ ...env, kind: 'transfer', queue: 'q1', summaryMasked: '요약' });
  assert.equal(t.length, 1);
  assert.equal(t[0].kind, 'notice');
  assert.equal(t[0].queue, 'q1');
  const e = m.renderEnvelope({ ...env, kind: 'end', reasonKo: '고객 종료' });
  assert.equal(e[0].text, m.AICC_NOTICE_KO.end);
});

/* ── 렌더(실패·경계) ────────────────────────────────────────────────────────── */

test('상담사용 요약은 고객 메시지에 절대 실리지 않는다(§2·§10.3)', opts, async () => {
  const m = await importLib('aiccTransport');
  const out = m.renderEnvelope({ ...env, kind: 'transfer', queue: 'q1', summaryMasked: '카드 분실 접수, 본인확인 완료' });
  assert.equal(JSON.stringify(out).includes('본인확인'), false, '마스킹을 거쳤어도 상담사용 요약이지 고객 문장이 아니다');
});

test('silent·빈 텍스트 단계는 빈 말풍선이 되지 않는다', opts, async () => {
  const m = await importLib('aiccTransport');
  const out = m.renderEnvelope({
    ...env,
    steps: [
      { channel: 'chat', nodeId: 'n1', kind: 'Api', text: '', silent: true },
      { channel: 'chat', nodeId: 'n2', kind: 'Say', text: '' },
    ],
  });
  assert.deepEqual(out, []);
});

test('챗 채널이 못 하는 지시에는 엉뚱한 말을 하지 않는다', opts, async () => {
  const m = await importLib('aiccTransport');
  assert.deepEqual(m.renderEnvelope({ ...env, kind: 'routeToLegacyIvr', reasonKo: 'x' }), []);
  assert.deepEqual(m.renderEnvelope({ ...env, kind: 'invite', target: 'visual' }), []);
  assert.deepEqual(m.renderEnvelope({ ...env, steps: [] }), []);
});

/* ── 전송기 ─────────────────────────────────────────────────────────────────── */

test('전송 실패는 위로 던진다 — 삼키면 고객은 무응답을 본다', opts, async () => {
  const m = await importLib('aiccTransport');
  const t = m.createAiccTransport({ sink: async () => { throw new Error('메신저 거부'); } });
  await assert.rejects(
    () => t.deliver({ ...env, steps: [{ channel: 'chat', nodeId: 'n1', kind: 'Say', text: '안녕하세요.' }] }),
    /메신저 거부/,
  );
});

test('내보낼 메시지가 없으면 전송기를 부르지 않는다', opts, async () => {
  const m = await importLib('aiccTransport');
  let calls = 0;
  const t = m.createAiccTransport({ sink: async () => { calls += 1; } });
  await t.deliver({ ...env, steps: [{ channel: 'chat', nodeId: 'n1', kind: 'Api', text: '', silent: true }] });
  assert.equal(calls, 0);
  await t.deliver({ ...env, steps: [{ channel: 'chat', nodeId: 'n2', kind: 'Say', text: '안녕하세요.' }] });
  assert.equal(calls, 1);
});

test('전송기 없이 transport 를 만들 수 없다', opts, async () => {
  const m = await importLib('aiccTransport');
  assert.throws(() => m.createAiccTransport({}), /sink/);
});

/* ── 활성화: build now, activate on approval ────────────────────────────────── */

test('기본은 dry_run 이다', opts, async () => {
  const m = await importLib('aiccTransport');
  assert.equal(m.aiccActivation({}).activation, 'dry_run');
});

test('플래그만으로는 실전송이 열리지 않는다 — 승인 근거가 있어야 한다', opts, async () => {
  const m = await importLib('aiccTransport');
  const s = m.aiccActivation({ CHATBOT_AICC_LIVE: 'true' });
  assert.equal(s.activation, 'dry_run');
  assert.match(s.reasonKo, /승인 필요/);
  assert.equal(m.aiccActivation({ CHATBOT_AICC_LIVE: 'true', CHATBOT_AICC_APPROVAL_REF: '   ' }).activation, 'dry_run', '공백은 근거가 아니다');
  assert.equal(m.aiccActivation({ CHATBOT_AICC_APPROVAL_REF: 'TICKET-1' }).activation, 'dry_run', '근거만으로도 열리지 않는다');
  assert.equal(m.aiccActivation({ CHATBOT_AICC_LIVE: 'true', CHATBOT_AICC_APPROVAL_REF: 'TICKET-1' }).activation, 'live');
});

test('live 인데 전송기가 없으면 dry_run 으로 내리고 이유를 남긴다', opts, async () => {
  const m = await importLib('aiccTransport');
  const o = m.aiccPortOptions({ CHATBOT_AICC_LIVE: 'true', CHATBOT_AICC_APPROVAL_REF: 'TICKET-1' });
  assert.equal(o.activation, 'dry_run');
  assert.match(o.reasonKo, /sink|전송기/);
  assert.equal(o.approvalRef, undefined, 'dry_run 인데 승인 근거를 달아 두면 켜진 것처럼 보인다');
});

test('응답 예산은 설정값일 때만 채운다 — 기본값을 만들지 않는다(§13-3)', opts, async () => {
  const m = await importLib('aiccTransport');
  const sink = async () => {};
  assert.equal(m.aiccPortOptions({}, sink).timeoutMs, undefined);
  assert.equal(m.aiccPortOptions({ CHATBOT_AICC_TIMEOUT_MS: '이천' }, sink).timeoutMs, undefined);
  assert.equal(m.aiccPortOptions({ CHATBOT_AICC_TIMEOUT_MS: '-5' }, sink).timeoutMs, undefined);
  assert.equal(m.aiccPortOptions({ CHATBOT_AICC_TIMEOUT_MS: '2500' }, sink).timeoutMs, 2500);
});

test('승인·전송기가 모두 갖춰지면 live 옵션이 만들어진다', opts, async () => {
  const m = await importLib('aiccTransport');
  const o = m.aiccPortOptions({ CHATBOT_AICC_LIVE: 'true', CHATBOT_AICC_APPROVAL_REF: 'TICKET-1' }, async () => {});
  assert.equal(o.activation, 'live');
  assert.equal(o.approvalRef, 'TICKET-1');
  assert.equal(typeof o.transport.deliver, 'function');
  assert.equal(o.id, 'chatbot');
});
