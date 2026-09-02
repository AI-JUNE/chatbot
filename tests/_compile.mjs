/**
 * 런타임 테스트용 TS 컴파일 하네스.
 *
 * 목적: 정적(텍스트) 검사만으로는 "실제로 그렇게 동작하는가"를 보장할 수 없다.
 * next/react에 의존하지 않는 순수 lib 모듈을 tsc로 임시 디렉터리에 컴파일해
 * node:test에서 실제로 import하여 동작을 검증한다.
 *
 * 제약
 * - 대상은 `src/lib/*.ts` 중 next/react를 import하지 않는 모듈만.
 * - 경로 별칭 `@/lib/x` 는 컴파일 후 `./x.mjs` 로 치환한다(모두 평면 구조).
 * - typescript 미설치 등으로 컴파일이 불가하면 예외를 던진다(테스트에서 skip 처리).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('../', import.meta.url));

/** typescript 컴파일러 실행 파일 경로(없으면 null). */
export function tscPath() {
  const bin = path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');
  return existsSync(bin) ? bin : null;
}

let cachedOutDir = null;
let cachedKey = '';

/**
 * lib 모듈들을 컴파일하고 출력 디렉터리를 반환한다.
 * @param {string[]} names 예: ['logger', 'monitoring']
 * @returns {string} 컴파일 결과 디렉터리(<out>/lib/<name>.mjs)
 */
export function compileLibs(names) {
  const key = [...names].sort().join(',');
  if (cachedOutDir && cachedKey === key) return cachedOutDir;

  const tsc = tscPath();
  if (!tsc) throw new Error('typescript가 설치되어 있지 않습니다(npm ci 필요).');

  const work = mkdtempSync(path.join(tmpdir(), 'cb-rt-'));
  const outDir = path.join(work, 'out');
  mkdirSync(outDir, { recursive: true });

  const files = names.map((n) => path.join(REPO, 'src', 'lib', `${n}.ts`));
  for (const f of files) if (!existsSync(f)) throw new Error(`대상 파일이 없습니다: ${f}`);

  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      lib: ['ES2022', 'DOM'],
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: false,
      skipLibCheck: true,
      esModuleInterop: true,
      noEmit: false,
      declaration: false,
      sourceMap: false,
      outDir,
      rootDir: path.join(REPO, 'src'),
      baseUrl: REPO,
      paths: { '@/*': ['src/*'] },
      types: [],
    },
    files,
  };
  const cfgPath = path.join(work, 'tsconfig.json');
  writeFileSync(cfgPath, JSON.stringify(tsconfig), 'utf8');

  // 타입 오류가 있어도 emit은 진행된다(타입 검증은 별도 `npm run typecheck` 책임).
  try {
    execFileSync(process.execPath, [tsc, '-p', cfgPath], { stdio: 'pipe' });
  } catch {
    /* emit만 확인한다 */
  }

  const libDir = path.join(outDir, 'lib');
  if (!existsSync(libDir)) throw new Error('컴파일 산출물이 없습니다.');

  for (const f of readdirSync(libDir).filter((f) => f.endsWith('.js'))) {
    const p = path.join(libDir, f);
    const src = readFileSync(p, 'utf8')
      .replace(/(from\s+['"])@\/lib\/([\w-]+)(['"])/g, '$1./$2.mjs$3')
      .replace(/(import\s*\(\s*['"])@\/lib\/([\w-]+)(['"])/g, '$1./$2.mjs$3');
    writeFileSync(p, src, 'utf8');
    renameSync(p, p.replace(/\.js$/, '.mjs'));
  }

  cachedOutDir = libDir;
  cachedKey = key;
  return libDir;
}

/** 컴파일 후 모듈 하나를 import 한다. */
export async function importLib(name, deps = []) {
  const dir = compileLibs([name, ...deps]);
  const file = path.join(dir, `${name}.mjs`);
  if (!existsSync(file)) throw new Error(`컴파일 결과에 ${name}.mjs 가 없습니다.`);
  return import(pathToFileURL(file).href);
}
