// AICC-Core 스키마 정합(드리프트) 검출기 — §5.3 Flow · 채널 렌더러.
//
// 왜 필요한가:
//  Core 를 사내 패키지로 배포하기 전까지 챗봇은 Core 타입을 `src/lib/sharedSchema.ts` 에 **미러링**한다.
//  미러는 주석으로 지켜지지 않는다. Core 가 렌더 문구 한 줄만 바꿔도 두 저장소의 시나리오는
//  조용히 갈라지고, "하나의 Flow 를 렌더러만 바꿔 실행한다"는 전제가 무너진다(설계서 §2 이중관리 회귀).
//  그래서 **Core 원본을 실제로 import 해 미러와 동작을 대조**한다. 문서가 아니라 실행이 판정한다.
//
// 무엇을 보는가(5축):
//  1) NodeKind 목록·순서            2) 채널 계약 버전
//  3) 어댑터↔매체 매핑              4) renderNode 출력(전 노드종류 × 전 채널) 완전 일치
//  5) 챗 채널 능력으로 렌더 불가한 노드가 엑스포트 번들에 들어 있지 않은지(배포 전 사전 판정)
//
// 종료코드: 0=정합 · 1=드리프트 발견 · 2=판정보류(Core 미발견·import 불가·미러 컴파일 불가)
// **판정보류를 통과로 넘기지 않는다** — 검사를 못 돌린 것은 정합의 근거가 아니다.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ── 대조 입력(순수) ────────────────────────────────────────────────────────── */

/**
 * 대조에 쓰는 노드 표본. **종류마다 최소 1개**가 있어야 한다 —
 * 표본이 빠진 종류는 렌더가 갈라져도 아무도 모른다(검사 구멍).
 * 개인정보를 넣지 않는다(§10.3).
 */
export const NODE_FIXTURES = [
  { id: 'n_say', kind: 'Say', text: '안녕하세요. 무엇을 도와드릴까요?', next: 'n_collect' },
  { id: 'n_collect', kind: 'Collect', slot: 'purpose', prompt: '용건을 말씀해 주세요.', maxRetry: 2 },
  { id: 'n_choice', kind: 'Choice', prompt: '무엇을 도와드릴까요?', options: [
    { label: '예약', value: 'booking' },
    { label: '장애 신고', value: 'incident' },
  ] },
  { id: 'n_confirm', kind: 'Confirm', prompt: '이대로 접수할까요?', onYes: 'n_say', onNo: 'n_say' },
  { id: 'n_transfer', kind: 'Transfer', queue: 'q_default' },
  { id: 'n_api_wait', kind: 'Api', connectorId: 'c_lookup', waitText: '조회하고 있습니다.' },
  { id: 'n_api_silent', kind: 'Api', connectorId: 'c_lookup' },
];

/** 대조 채널 축. Core 의 ChannelKind 3종을 모두 돈다. */
export const RENDER_CHANNELS = ['voice', 'visual', 'chat'];

/**
 * Core 소스에서 NodeKind 유니언을 읽는다.
 * NodeKind 는 **타입**이라 런타임 값으로 export 되지 않는다. 그래서 여기서만 원문을 읽는다.
 * 못 읽으면 null 을 돌려주고 호출부가 판정보류로 끝낸다 — 빈 목록을 만들어 통과시키지 않는다.
 * @param {string} src Core `src/flow/types.ts` 원문
 * @returns {string[] | null}
 */
export function parseNodeKinds(src) {
  const m = /export\s+type\s+NodeKind\s*=\s*([^;]+);/.exec(src);
  if (!m) return null;
  const kinds = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  return kinds.length > 0 ? kinds : null;
}

/* ── 대조(순수) ─────────────────────────────────────────────────────────────── */

/**
 * Core 사실과 미러 사실을 대조해 **한국어 사유 목록**을 반환한다. 빈 배열이면 정합.
 * 순수 함수이므로 Core 없이도 테스트한다.
 *
 * @param {{kinds:string[], contractVersion:number, adapterChannel:Record<string,string>,
 *          render:(node:object, channel:string)=>object, flowIssues?:{severity:string,messageKo:string}[]}} core
 * @param {{kinds:readonly string[], contractVersion:number, channelKind:Record<string,string>,
 *          render:(node:object, channel:string)=>object}} mirror
 * @returns {string[]}
 */
export function compareContract(core, mirror) {
  const issues = [];

  // 1) NodeKind 목록·순서. 순서까지 보는 이유: 번들 `coreContract.flowNodeKinds` 가 순서로 비교된다.
  const a = core.kinds.join(',');
  const b = [...mirror.kinds].join(',');
  if (a !== b) issues.push(`NodeKind 불일치 — Core [${a}] ≠ 미러 [${b}]`);

  // 2) 채널 계약 버전
  if (core.contractVersion !== mirror.contractVersion) {
    issues.push(`채널 계약 버전 불일치 — Core ${core.contractVersion} ≠ 미러 ${mirror.contractVersion}`);
  }

  // 3) 어댑터↔매체 매핑. 챗봇 저장소는 web·kakao 를 chat 으로, call 을 voice 로 보낸다.
  const expect = [
    ['web', core.adapterChannel.chatbot, 'chatbot'],
    ['kakao', core.adapterChannel.chatbot, 'chatbot'],
    ['call', core.adapterChannel.callbot, 'callbot'],
  ];
  for (const [sharedChannel, coreKind, adapter] of expect) {
    const mine = mirror.channelKind[sharedChannel];
    if (coreKind === undefined) {
      issues.push(`Core ADAPTER_CHANNEL 에 '${adapter}' 어댑터가 없습니다 — 매핑을 확인할 수 없습니다.`);
      continue;
    }
    if (mine !== coreKind) {
      issues.push(`채널 매핑 불일치 — '${sharedChannel}' 는 Core 기준 '${coreKind}'(${adapter}) 인데 미러는 '${String(mine)}'`);
    }
  }

  // 4) 렌더 출력 완전 일치. 표본이 빠진 종류가 있으면 그것부터 문제다.
  const covered = new Set(NODE_FIXTURES.map((n) => n.kind));
  for (const k of core.kinds) {
    if (!covered.has(k)) issues.push(`대조 표본 누락 — '${k}' 노드를 검사하지 않고 있습니다(검사 구멍).`);
  }
  for (const node of NODE_FIXTURES) {
    for (const channel of RENDER_CHANNELS) {
      let mine;
      let theirs;
      try {
        theirs = core.render(node, channel);
      } catch (e) {
        issues.push(`Core 렌더 실패 — ${node.kind}/${channel}: ${e.message}`);
        continue;
      }
      try {
        mine = mirror.render(node, channel);
      } catch (e) {
        issues.push(`미러 렌더 실패 — ${node.kind}/${channel}: ${e.message}`);
        continue;
      }
      const ts = stable(theirs);
      const ms = stable(mine);
      if (ts !== ms) issues.push(`렌더 결과 불일치 — ${node.kind}/${channel}\n    Core : ${ts}\n    미러 : ${ms}`);
    }
  }

  // 5) 챗 채널 능력 사전 판정(Core checkFlowSupported 결과). error 만 드리프트로 본다.
  for (const i of core.flowIssues ?? []) {
    if (i.severity === 'error') issues.push(`챗 채널에서 렌더 불가한 노드가 엑스포트 번들에 있습니다 — ${i.messageKo}`);
  }

  return issues;
}

/** 키 순서에 흔들리지 않는 비교용 직렬화. undefined 키는 없는 것으로 본다. */
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
}

/* ── 실행 ───────────────────────────────────────────────────────────────────── */

const HOLD = 2;

/** 판정보류로 끝낸다. 통과(0)로 넘기지 않는다. */
function hold(reason) {
  console.error(`[drift] 판정보류: ${reason}`);
  console.error('[drift] 검사를 못 돌린 것은 정합의 근거가 아닙니다. AICC_CORE 로 Core 위치를 지정하세요.');
  process.exit(HOLD);
}

async function main() {
  const core = path.resolve(REPO, process.env.AICC_CORE ?? '../6. AICC-Core');
  const typesPath = path.join(core, 'src', 'flow', 'types.ts');
  const contractPath = path.join(core, 'src', 'channels', 'contract.ts');
  const profilesPath = path.join(core, 'src', 'channels', 'profiles.ts');
  for (const p of [typesPath, contractPath, profilesPath]) {
    if (!existsSync(p)) hold(`AICC-Core 파일을 찾지 못했습니다(${p}).`);
  }

  let coreTypes;
  let coreContract;
  let coreProfiles;
  try {
    coreTypes = await import(pathToFileURL(typesPath).href);
    coreContract = await import(pathToFileURL(contractPath).href);
    coreProfiles = await import(pathToFileURL(profilesPath).href);
  } catch (e) {
    // Node 22 미만 등 TS 소스를 직접 못 읽는 런타임. 통과로 넘기지 않는다.
    hold(`Core 모듈을 불러오지 못했습니다 — ${e.message}. Node 22.6+ (타입 스트립) 이 필요합니다.`);
  }

  const kinds = parseNodeKinds(await readFile(typesPath, 'utf8'));
  if (kinds === null) hold('Core 의 NodeKind 정의를 읽지 못했습니다(형식이 바뀌었을 수 있습니다).');

  // 미러는 Next 별칭(@/lib/*)을 쓰므로 테스트 하네스로 컴파일해 불러온다.
  let mirror;
  try {
    const { importLib } = await import(pathToFileURL(path.join(REPO, 'tests', '_compile.mjs')).href);
    mirror = await importLib('sharedSchema');
  } catch (e) {
    hold(`미러(sharedSchema)를 컴파일하지 못했습니다 — ${e.message}. npm ci 후 다시 실행하세요.`);
  }

  // 실제 엑스포트되는 Flow 를 챗 채널 능력으로 사전 판정한다(§5.3).
  let flowIssues = [];
  try {
    flowIssues = coreContract.checkFlowSupported(mirror.escalationFlow(), coreProfiles.CHANNEL_PROFILES.chatbot);
  } catch (e) {
    hold(`Flow 사전 판정을 실행하지 못했습니다 — ${e.message}`);
  }

  const issues = compareContract(
    {
      kinds,
      contractVersion: coreContract.CHANNEL_CONTRACT_VERSION,
      adapterChannel: coreContract.ADAPTER_CHANNEL,
      render: coreTypes.renderNode,
      flowIssues,
    },
    {
      kinds: mirror.CORE_FLOW_NODE_KINDS,
      contractVersion: mirror.CORE_CHANNEL_CONTRACT_VERSION,
      channelKind: mirror.CORE_CHANNEL_KIND,
      render: mirror.renderSharedNode,
    },
  );

  if (issues.length === 0) {
    console.log(`[drift] 정합 확인 — 노드 ${kinds.length}종 × 채널 ${RENDER_CHANNELS.length}개, 계약 v${coreContract.CHANNEL_CONTRACT_VERSION}.`);
    process.exit(0);
  }
  console.error(`[drift] 드리프트 ${issues.length}건 — Core 와 미러(src/lib/sharedSchema.ts)가 갈라졌습니다.`);
  for (const i of issues) console.error(`  - ${i}`);
  console.error('[drift] Core 가 기준입니다. 미러를 맞추거나, 의도된 변경이면 Core 를 먼저 고치세요.');
  process.exit(1);
}

// 라이브러리로 import 될 때는 실행하지 않는다(테스트가 순수 함수만 쓴다).
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((e) => hold(`예상치 못한 오류 — ${e?.message ?? String(e)}`));
}
