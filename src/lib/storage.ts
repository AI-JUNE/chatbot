/**
 * 저장소 어댑터 — 인메모리 스텁을 벗어나기 위한 최소 영속화 계층.
 *
 * 설계 원칙
 * - **드라이버 교체 가능**: `memory`(휘발) / `file`(원자적 쓰기). DB 드라이버는 같은 인터페이스로 추가한다.
 * - **오류를 삼키지 않는다**: 쓰기·읽기 실패는 상태(`storageStatus`)에 남고 로그·모니터링으로 나간다.
 *   단, 애플리케이션 흐름은 깨지 않는다(저장 실패해도 메모리 상태로 계속 동작).
 * - **읽기전용 FS 구분**: Vercel 런타임 등에서 나는 EROFS/EACCES/EPERM/ENOSPC는 "환경상 예상된 상태"로
 *   `readonly`로 분류해 오류와 구분한다(오탐 알림 방지).
 * - **개인정보 게이트**: `pii: true` 네임스페이스(티켓·대화로그)는 `PERSIST_PII=true` **[승인 필요]** 전까지
 *   디스크에 쓰지 않는다. 코드는 완성해 두고 스위치만 잠근다.
 *
 * 환경변수
 * - `STORAGE_DRIVER`  memory | file (기본 file)
 * - `STORAGE_DIR`     파일 드라이버 저장 디렉터리(기본 `<cwd>/data`)
 * - `PERSIST_PII`     true일 때만 개인정보 포함 네임스페이스 영속화 [승인 필요]
 * - `ADMIN_PERSIST=false`     전체 영속화 비활성(하위 호환)
 * - `ADMIN_PERSIST_FILE`      admin 네임스페이스 파일 경로 지정(하위 호환)
 */
import fs from 'fs';
import path from 'path';
import { log } from '@/lib/logger';
import { captureError } from '@/lib/monitoring';

export type DriverName = 'memory' | 'file';

/** 저장소 드라이버. 실패는 반드시 throw 한다(상위에서 분류·기록). */
export interface StorageDriver {
  readonly name: DriverName;
  read(ns: string): string | null;
  write(ns: string, payload: string): void;
  remove(ns: string): void;
}

// ---- 네임스페이스 등록 ----

export interface Namespace {
  /** 파일명·상태 키. 영숫자와 하이픈만. */
  id: string;
  /** 사람이 읽는 이름(관리 콘솔 표시용). */
  label: string;
  /** 개인정보를 포함할 수 있는가 — true면 PERSIST_PII 승인 전까지 디스크에 쓰지 않는다. */
  pii: boolean;
}

export const NAMESPACES: Record<string, Namespace> = {
  admin: { id: 'admin', label: '관리 콘텐츠(KB·룰)', pii: false },
  audit: { id: 'audit', label: '감사 로그', pii: false },
  partners: { id: 'partners', label: '파트너·계약 귀속', pii: false },
  tickets: { id: 'tickets', label: '상담 티켓', pii: true },
  convlog: { id: 'convlog', label: '대화 로그', pii: true },
};

// ---- 설정 ----

function envDriver(): DriverName {
  if (process.env.ADMIN_PERSIST === 'false') return 'memory';
  return process.env.STORAGE_DRIVER === 'memory' ? 'memory' : 'file';
}

/** 개인정보 포함 네임스페이스 영속화 승인 여부. 기본 false. */
export function piiPersistApproved(): boolean {
  return process.env.PERSIST_PII === 'true';
}

function baseDir(): string {
  return process.env.STORAGE_DIR || path.join(process.cwd(), 'data');
}

/** 네임스페이스별 파일 경로(admin은 하위 호환 경로 우선). */
export function filePathFor(ns: string): string {
  if (ns === 'admin' && process.env.ADMIN_PERSIST_FILE) return process.env.ADMIN_PERSIST_FILE;
  return path.join(baseDir(), `${ns}.json`);
}

// ---- 드라이버 구현 ----

class MemoryDriver implements StorageDriver {
  readonly name: DriverName = 'memory';
  private map = new Map<string, string>();
  read(ns: string): string | null {
    return this.map.has(ns) ? (this.map.get(ns) as string) : null;
  }
  write(ns: string, payload: string): void {
    this.map.set(ns, payload);
  }
  remove(ns: string): void {
    this.map.delete(ns);
  }
}

class FileDriver implements StorageDriver {
  readonly name: DriverName = 'file';
  read(ns: string): string | null {
    const p = filePathFor(ns);
    try {
      return fs.readFileSync(p, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
  /** 임시 파일에 쓰고 rename — 쓰는 도중 죽어도 반쪽 파일이 남지 않는다. */
  write(ns: string, payload: string): void {
    const p = filePathFor(ns);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${Date.now().toString(36)}.tmp`;
    try {
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, p);
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* 임시 파일 정리 실패는 무시 — 원래 오류를 그대로 올린다 */
      }
      throw e;
    }
  }
  remove(ns: string): void {
    try {
      fs.unlinkSync(filePathFor(ns));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}

let driver: StorageDriver = envDriver() === 'memory' ? new MemoryDriver() : new FileDriver();

export function currentDriver(): DriverName {
  return driver.name;
}

/** 테스트·마이그레이션용 드라이버 교체. */
export function setDriver(next: DriverName | StorageDriver): void {
  if (typeof next === 'string') driver = next === 'memory' ? new MemoryDriver() : new FileDriver();
  else driver = next;
}

// ---- 상태(오류를 삼키지 않기 위한 기록) ----

export type NsHealth = 'ok' | 'empty' | 'disabled' | 'awaiting_approval' | 'readonly' | 'error';

export interface NsStatus {
  ns: string;
  label: string;
  /** 실제로 디스크(또는 드라이버)에 쓰고 있는가. */
  persisted: boolean;
  health: NsHealth;
  /** 마지막 성공 저장 시각(ISO). 없으면 null. */
  lastSavedAt: string | null;
  /** 마지막 실패 요약(마스킹된 코드·메시지). 없으면 null. */
  lastError: string | null;
  lastErrorAt: string | null;
  bytes: number;
}

const status = new Map<string, NsStatus>();

function initialStatus(ns: string): NsStatus {
  const meta = NAMESPACES[ns];
  return {
    ns,
    label: meta ? meta.label : ns,
    persisted: false,
    health: 'empty',
    lastSavedAt: null,
    lastError: null,
    lastErrorAt: null,
    bytes: 0,
  };
}

function getStatus(ns: string): NsStatus {
  let s = status.get(ns);
  if (!s) {
    s = initialStatus(ns);
    status.set(ns, s);
  }
  return s;
}

/** 환경상 예상되는 실패(읽기전용 FS 등)인지 — 오류 알림 대상에서 제외한다. */
const READONLY_CODES = new Set(['EROFS', 'EACCES', 'EPERM', 'ENOSPC', 'EDQUOT']);

export function isReadonlyError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && READONLY_CODES.has(code);
}

/** 저장소 전체 상태(민감정보 없음) — /api/health·관리 콘솔에서 사용. */
export function storageStatus(): {
  driver: DriverName;
  piiApproved: boolean;
  namespaces: NsStatus[];
} {
  return {
    driver: driver.name,
    piiApproved: piiPersistApproved(),
    namespaces: Object.keys(NAMESPACES).map((ns) => ({ ...getStatus(ns) })),
  };
}

// ---- 영속화 가능 여부 ----

export type PersistBlock = null | 'disabled' | 'awaiting_approval';

/** ns를 지금 디스크에 쓸 수 있는가. 막혀 있으면 사유를 돌려준다. */
export function persistBlock(ns: string): PersistBlock {
  if (process.env.ADMIN_PERSIST === 'false') return 'disabled';
  const meta = NAMESPACES[ns];
  if (meta && meta.pii && !piiPersistApproved()) return 'awaiting_approval';
  return null;
}

export function isPersistEnabled(ns: string): boolean {
  return persistBlock(ns) === null;
}

// ---- 읽기·쓰기 ----

export type LoadResult =
  | { ok: true; data: unknown }
  | { ok: false; reason: 'disabled' | 'awaiting_approval' | 'empty' | 'error'; error?: string };

/** 저장된 JSON 1건 읽기. 실패해도 throw 하지 않고 사유를 돌려준다. */
export function loadJson(ns: string): LoadResult {
  const blocked = persistBlock(ns);
  if (blocked) {
    const s = getStatus(ns);
    s.persisted = false;
    s.health = blocked;
    return { ok: false, reason: blocked };
  }
  const s = getStatus(ns);
  try {
    const raw = driver.read(ns);
    if (raw === null || raw.trim() === '') {
      s.health = 'empty';
      return { ok: false, reason: 'empty' };
    }
    const data = JSON.parse(raw) as unknown;
    s.bytes = raw.length;
    s.health = 'ok';
    s.persisted = true;
    return { ok: true, data };
  } catch (e) {
    recordFailure(ns, e, 'load');
    return { ok: false, reason: 'error', error: describeError(e) };
  }
}

export type SaveResult =
  | { ok: true; bytes: number }
  | { ok: false; reason: 'disabled' | 'awaiting_approval' | 'readonly' | 'error'; error?: string };

/** JSON 1건 저장. 실패해도 throw 하지 않지만 조용히 넘어가지도 않는다(상태·로그에 남는다). */
export function saveJson(ns: string, value: unknown): SaveResult {
  const blocked = persistBlock(ns);
  if (blocked) {
    const s = getStatus(ns);
    s.persisted = false;
    s.health = blocked;
    return { ok: false, reason: blocked };
  }
  const s = getStatus(ns);
  let payload: string;
  try {
    payload = JSON.stringify(value, null, 2);
  } catch (e) {
    recordFailure(ns, e, 'serialize');
    return { ok: false, reason: 'error', error: describeError(e) };
  }
  try {
    driver.write(ns, payload);
    s.bytes = payload.length;
    s.lastSavedAt = new Date().toISOString();
    s.lastError = null;
    s.lastErrorAt = null;
    s.health = 'ok';
    s.persisted = true;
    return { ok: true, bytes: payload.length };
  } catch (e) {
    const readonly = isReadonlyError(e);
    recordFailure(ns, e, 'save', readonly);
    return { ok: false, reason: readonly ? 'readonly' : 'error', error: describeError(e) };
  }
}

/** 저장 실패를 상태·로그·모니터링에 남긴다. 여기서 예외가 다시 나가지 않게 감싼다. */
function recordFailure(ns: string, e: unknown, op: string, readonly = false): void {
  const s = getStatus(ns);
  s.persisted = false;
  s.health = readonly ? 'readonly' : 'error';
  s.lastError = describeError(e);
  s.lastErrorAt = new Date().toISOString();
  try {
    // 읽기전용 FS는 배포 환경상 예상되는 상태 → warn, 그 외는 error + 모니터링 리포트
    log(readonly ? 'warn' : 'error', 'storage', {
      ns,
      op,
      driver: driver.name,
      error: s.lastError,
    });
    if (!readonly) void captureError(e, { route: 'storage', ns, op });
  } catch {
    /* 로깅 실패가 서비스에 영향을 주지 않는다 */
  }
}

/** 오류를 사람이 읽는 짧은 문자열로(경로·개인정보 미포함). */
export function describeError(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  const name = e instanceof Error ? e.name : 'Error';
  const msg = e instanceof Error ? e.message : String(e);
  // 파일 경로가 메시지에 섞여 나오므로 마지막 파일명만 남긴다
  const safe = msg.replace(/(['"]?)(\/|[A-Za-z]:\\)[^\s'"]+/g, (m) => `…/${m.split(/[\\/]/).pop() || ''}`);
  return `${code ? `${code}: ` : `${name}: `}${safe}`.slice(0, 200);
}

// ---- 디바운스 저장 ----

interface PendingSave {
  timer: ReturnType<typeof setTimeout>;
  produce: () => unknown;
}

const timers = new Map<string, PendingSave>();
const DEBOUNCE_MS = 300;

/**
 * 짧은 시간 내 여러 변경을 한 번의 쓰기로 합친다.
 * 저장 시점의 최신 상태가 필요하므로 값이 아니라 **생성 함수**를 받는다.
 */
export function scheduleSave(ns: string, produce: () => unknown): void {
  if (!isPersistEnabled(ns)) {
    // 상태만 갱신해 관리 콘솔에서 "왜 저장되지 않는지" 보이게 한다
    const blocked = persistBlock(ns);
    const s = getStatus(ns);
    s.persisted = false;
    if (blocked) s.health = blocked;
    return;
  }
  const prev = timers.get(ns);
  if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(() => {
    timers.delete(ns);
    runSave(ns, produce);
  }, DEBOUNCE_MS);
  // 이 타이머 때문에 프로세스가 살아있지 않도록(테스트·서버리스)
  (timer as unknown as { unref?: () => void }).unref?.();
  timers.set(ns, { timer, produce });
}

function runSave(ns: string, produce: () => unknown): void {
  try {
    saveJson(ns, produce());
  } catch (e) {
    recordFailure(ns, e, 'produce');
  }
}

/**
 * 대기 중인 디바운스 저장을 **즉시 실행**한다(종료 훅·테스트·백업 직전).
 * 타이머만 취소하고 넘어가면 마지막 변경이 소리 없이 사라진다.
 */
export function flushSaves(): void {
  const pending = [...timers.entries()];
  timers.clear();
  for (const [ns, p] of pending) {
    clearTimeout(p.timer);
    runSave(ns, p.produce);
  }
}

/** 테스트용 초기화 — 대기 저장을 버리고 상태를 비운다(드라이버는 유지). */
export function resetStorageState(): void {
  for (const [, p] of timers) clearTimeout(p.timer);
  timers.clear();
  status.clear();
}
