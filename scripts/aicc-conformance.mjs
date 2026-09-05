// AICC-Core 채널 계약 적합성 실행기 호출부(챗봇).
//
// 왜 이 얇은 파일이 있는가:
//  - Core 는 **별도 저장소**다. `file:` 의존으로 package.json 에 박으면 Core 가 없는 체크아웃에서
//    `npm ci` 자체가 실패한다 — 계약 검사를 붙이려다 저장소 CI 전체를 세우는 셈이다.
//    그래서 의존은 선언하지 않고, **있을 때만** 검사한다.
//  - 대신 import 경로는 안정 계약 경로(`aicc-core/channels/*`)를 그대로 쓴다. Core 가 내부 파일을
//    옮겨도 이 저장소가 조용히 깨지지 않게 하기 위해서다. 링크는 여기서 만든다(node_modules 는 gitignore).
//
// 종료코드: 0=통과 · 1=실패 · 2=판정보류(Core 미발견·링크 불가 포함)
// **판정보류를 통과로 넘기지 않는다** — 검사를 못 돌린 것은 통과의 근거가 아니다.
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 위치는 환경에서 온다. 기본값은 개발 PC의 형제 폴더이고, CI 는 AICC_CORE 로 체크아웃 위치를 준다.
const core = path.resolve(REPO, process.env.AICC_CORE ?? '../6. AICC-Core');
const runner = path.join(core, 'scripts', 'channel-conformance.mjs');

if (!existsSync(runner)) {
  console.error(`[aicc] 판정보류: AICC-Core 를 찾지 못했습니다(${core}).`);
  console.error('[aicc] AICC_CORE 환경변수로 위치를 지정하세요. 검사를 못 돌린 것은 통과가 아닙니다.');
  process.exit(2);
}

// 안정 계약 경로를 해석할 수 있게 링크한다. 이미 있으면 그대로 쓴다(설치된 패키지일 수도 있다).
const link = path.join(REPO, 'node_modules', 'aicc-core');
if (!existsSync(link)) {
  try {
    mkdirSync(path.join(REPO, 'node_modules'), { recursive: true });
    symlinkSync(core, link, 'junction');
  } catch (e) {
    console.error(`[aicc] 판정보류: aicc-core 링크를 만들지 못했습니다 — ${e.message}`);
    process.exit(2);
  }
}

const r = spawnSync(process.execPath, [
  runner,
  '--port', './ci/aicc-port.mjs',
  '--flows', './ci/aicc-flows.mjs',
  '--adapter', 'chatbot',
  '--timeout-ms', process.env.AICC_TIMEOUT_MS ?? '3000',
], { cwd: REPO, stdio: 'inherit' });

process.exit(r.status == null ? 1 : r.status);
