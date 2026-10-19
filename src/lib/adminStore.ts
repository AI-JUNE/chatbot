// 관리 콘솔 런타임 스토어.
// 영속화는 `@/lib/storage` 어댑터(memory|file)에 위임한다 — 여기서는 도메인 로직만 다룬다.
// KB·룰 오버라이드·커스텀 룰은 개인정보가 아니므로 승인 없이 저장한다(파일 드라이버 기본).
import { KB, KBEntry } from '@/lib/knowledge';
import { keywordHit, prepare } from '@/lib/normalize';
import { flushSaves, loadJson, saveJson, saveNow, savedInfo, scheduleSave, type SavedInfo } from '@/lib/storage';
import { revOf } from '@/lib/rev';
import { CHANGED_TARGET_MESSAGE, RESTORE_FORMAT_MESSAGE, STALE_TARGET_MESSAGE } from '@/lib/refusal';

function cloneEntry(e: KBEntry): KBEntry {
  return { ...e, keywords: [...e.keywords] };
}

/**
 * 자동 식별자 — 같은 밀리초에 둘이 들어와도 **겹치지 않는다** (DS 44-1).
 *
 * 종전 식은 `kb_${Date.now().toString(36)}` 하나였다. 밀리초가 유일성의 전부였으므로 같은
 * 밀리초에 들어온 둘째는 첫째와 **같은 id** 를 받고, `upsertKB` 는 그것을 「이미 있는 항목」으로
 * 읽어 **덮어썼다**. 돌려서 확인했다: 커스텀 규칙 3건을 잇따라 만들면 목록에는 2건만 남고
 * 사라진 한 건은 「생성」이 아니라 「수정」으로 기록된다 — 만든 사람은 성공 메시지를 본다.
 * 사람의 두 번 클릭으로는 좀처럼 닿지 않는 자리지만, 겹치지 않게 만드는 값이 공짜라면
 * 「좀처럼」에 기대지 않는다(이 저장소의 다른 id 들은 전부 순번을 함께 쓴다).
 */
let autoSeq = 0;
function autoId(prefix: string, taken: (id: string) => boolean): string {
  for (;;) {
    autoSeq += 1;
    const id = `${prefix}_${Date.now().toString(36)}${autoSeq.toString(36)}`;
    if (!taken(id)) return id;
  }
}

let kbEntries: KBEntry[] = KB.map(cloneEntry);

export function listKB(): KBEntry[] {
  return kbEntries.map(cloneEntry);
}

export interface KBUpsertInput {
  id?: string;
  category?: string;
  question?: string;
  keywords?: string[] | string; // 배열 또는 콤마 구분 문자열
  answer?: string;
  source?: string; // 출처 라벨(업로드 문서명 등)
  /**
   * 편집을 **시작할 때 본** 모습 (DS 46-1). 보내면 그 사이 바뀐 자료를 덮어쓰지 않는다.
   * 보내지 않으면 종전과 같이 그대로 갈아 끼운다(문서 일괄 등록·복원처럼 겨룰 상대가 없는 자리).
   */
  baseRev?: string;
}

/**
 * 자료 한 건의 모습 (DS 46-1) — **목록에 실어 보내는 쪽과 저장 직전에 견주는 쪽이 같은 식**을 쓴다.
 * 두 벌로 계산하면 영영 어긋나거나(저장이 늘 거절된다) 영영 같아진다(경고가 조용히 사라진다).
 */
export function kbRev(e: KBEntry): string {
  return revOf({ id: e.id, category: e.category, question: e.question, keywords: e.keywords, answer: e.answer, source: e.source });
}

/** 커스텀 규칙 한 건의 모습 — `kbRev` 와 같은 규칙이다(만든 시각은 바뀌지 않으므로 뺀다). */
export function customRuleRev(r: CustomRule): string {
  return revOf({ intent: r.intent, label: r.label, keywords: r.keywords, reply: r.reply, escalate: r.escalate, enabled: r.enabled });
}

/** 저장 직전 관문 — 내가 보던 것이 그 사이 지워졌거나 바뀌었으면 거절한다 (DS 46-1). */
function conflictOf<T>(baseRev: string | undefined, existing: T | undefined, revOfItem: (v: T) => string): 'gone' | 'changed' | null {
  const base = String(baseRev ?? '').trim();
  if (!base) return null;
  if (!existing) return 'gone';
  return revOfItem(existing) === base ? null : 'changed';
}

function normalizeKeywords(kw: KBUpsertInput['keywords']): string[] {
  if (!kw) return [];
  const arr = Array.isArray(kw) ? kw : String(kw).split(',');
  return arr.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
}

export type UpsertResult =
  | { ok: true; entry: KBEntry; created: boolean }
  /**
   * 거절. `conflict` 가 있으면 **입력이 틀린 것이 아니라** 그 사이 다른 화면에서 바뀐 것이다
   * (DS 46-1) — 부르는 쪽은 적던 글을 버리지 않고 다음 길을 준다. `current` 는 지금 저장된 값이다.
   */
  | { ok: false; error: string; conflict?: 'gone' | 'changed'; current?: KBEntry };

export function upsertKB(input: KBUpsertInput): UpsertResult {
  const id = (input.id || '').trim() || autoId('kb', (v) => kbEntries.some((e) => e.id === v));
  const keywords = normalizeKeywords(input.keywords);
  const existing = kbEntries.find((e) => e.id === id);

  // 내가 보던 모습을 들고 왔으면 **그 모습일 때만** 갈아 끼운다 (DS 46-1).
  const conflict = conflictOf(input.baseRev, existing, kbRev);
  if (conflict === 'gone') return { ok: false, error: STALE_TARGET_MESSAGE, conflict };
  if (conflict === 'changed') {
    return { ok: false, error: CHANGED_TARGET_MESSAGE, conflict, current: cloneEntry(existing as KBEntry) };
  }

  if (!existing) {
    const question = (input.question || '').trim();
    const answer = (input.answer || '').trim();
    if (!question || !answer || keywords.length === 0) {
      return { ok: false, error: '대표 질문·답변·키워드를 모두 입력해 주세요.' };
    }
    const source = (input.source || '').trim();
    const entry: KBEntry = {
      id,
      category: (input.category || '일반').trim() || '일반',
      question,
      keywords,
      answer,
      ...(source ? { source } : {}),
    };
    kbEntries.push(entry);
    schedulePersist();
    return { ok: true, entry: cloneEntry(entry), created: true };
  }

  if (input.category !== undefined) existing.category = String(input.category).trim() || existing.category;
  if (input.question !== undefined) existing.question = String(input.question).trim() || existing.question;
  if (input.answer !== undefined) existing.answer = String(input.answer).trim() || existing.answer;
  if (input.keywords !== undefined && keywords.length > 0) existing.keywords = keywords;
  if (input.source !== undefined) {
    const src = String(input.source).trim();
    if (src) existing.source = src;
    else delete existing.source;
  }
  schedulePersist();
  return { ok: true, entry: cloneEntry(existing), created: false };
}

/** 여러 항목을 한 번에 등록(문서 업로드 등). 실패 항목은 사유와 함께 돌려준다. */
export function bulkUpsertKB(inputs: KBUpsertInput[]): { created: KBEntry[]; updated: KBEntry[]; errors: string[] } {
  const created: KBEntry[] = [];
  const updated: KBEntry[] = [];
  const errors: string[] = [];
  for (const input of inputs) {
    const r = upsertKB(input);
    if (!r.ok) errors.push(r.error);
    else if (r.created) created.push(r.entry);
    else updated.push(r.entry);
  }
  return { created, updated, errors };
}

// ---- 문서 재업로드가 건드리는 자리 (DS 44-1) ----

/** 한 줄로 보여 줄 기존 항목 — 어느 자료인지 사람이 알아볼 만큼만 싣는다(개인정보 없음). */
export interface KBOverlapItem {
  id: string;
  question: string;
  source?: string;
}

export interface DocOverlap {
  /** 새 후보와 id 가 같아 **내용이 갈아 끼워지는** 기존 항목(의도된 수정판 반영). */
  overwrite: KBOverlapItem[];
  /**
   * 같은 문서명으로 지난번에 등록됐지만 **이번 후보에는 없는** 항목.
   * 등록해도 지워지지 않고 남아, 봇이 지난 판과 새 판을 섞어 답한다.
   */
  stale: KBOverlapItem[];
  /**
   * 겹치는 자리에 **다른 문서명**으로 들어간 자료가 있다 — 제목이 다른데 id 앞자리가 같은 경우다
   * (슬러그는 공백·문장부호를 버리고 24자로 자른다: 「요금 안내」와 「요금 안내!!」가 한 자리다).
   * 이때 등록은 남의 문서를 덮어쓰는 일이므로, 수를 세는 것으로 끝내지 않고 **이름을** 말한다.
   */
  otherTitles: string[];
}

/**
 * 이 문서를 등록하면 지식베이스에서 무엇이 바뀌는가 — 등록 **전에** 답할 수 있어야 한다 (DS 44-1).
 *
 * `documentToCandidates` 의 id 는 `<앞자리>_001` 처럼 문서명과 순번으로만 만들어진다. 그래서
 * 같은 문서명의 수정판은 기존 항목을 갈아 끼우는데(의도), **조각 수가 줄면 남는 조각이 생긴다**.
 * 종전에는 그 사실을 아무도 말하지 않았다 — 화면은 「신규 0 · 갱신 2」라고만 적었고, 운영자는
 * 문서를 고쳤다고 믿은 채 **지운 문단이 그대로 답에 쓰이는** 상태로 운영했다.
 *
 * @param prefix `ingest.docIdPrefix(문서명)` — 두 벌로 계산하지 않는다
 * @param candidateIds 이번에 등록할 후보 id 전부
 * @param title 문서명 — 겹치는 자리의 주인이 다른 문서인지 가리는 데 쓴다
 */
export function docOverlap(prefix: string, candidateIds: readonly string[], title: string): DocOverlap {
  const head = `${prefix}_`;
  const keep = new Set(candidateIds);
  const name = (title || '').trim();
  const overwrite: KBOverlapItem[] = [];
  const stale: KBOverlapItem[] = [];
  const otherTitles: string[] = [];
  for (const e of kbEntries) {
    if (!e.id.startsWith(head)) continue;
    const item: KBOverlapItem = { id: e.id, question: e.question, ...(e.source ? { source: e.source } : {}) };
    (keep.has(e.id) ? overwrite : stale).push(item);
    // 출처 라벨은 `문서명` 또는 `문서명 — 소제목` 이다(ingest). 둘 다 아니면 다른 문서가 쓰던 자리다.
    const src = (e.source || '').trim();
    const other = src.split(' — ')[0].trim();
    if (name && other && other !== name && !otherTitles.includes(other)) otherTitles.push(other);
  }
  return { overwrite, stale, otherTitles: otherTitles.slice(0, 5) };
}

export function deleteKB(id: string): boolean {
  const before = kbEntries.length;
  kbEntries = kbEntries.filter((e) => e.id !== id);
  if (kbEntries.length < before) schedulePersist();
  return kbEntries.length < before;
}

export function resetKB(): void {
  kbEntries = KB.map(cloneEntry);
  schedulePersist();
}

// ---- 시나리오(인텐트 룰) 오버라이드: 활성화 여부·응답문만 편집(패턴은 코드 관리) ----
/**
 * 기본 규칙 답변을 덮어쓸 때의 길이 상한. 화면도 같은 값을 알고 있어야
 * **보내기 전에** 이유를 밝힐 수 있다(DS 29-1 — 거절은 그 칸에서 해야 한다).
 */
export const MAX_RULE_REPLY_LEN = 1000;

export interface RuleOverride {
  enabled: boolean;
  reply?: string; // 응답문 오버라이드(없으면 기본 응답)
}

const ruleOverrides = new Map<string, RuleOverride>();

export function getRuleOverride(intent: string): RuleOverride | undefined {
  return ruleOverrides.get(intent);
}

export function setRuleOverride(intent: string, patch: { enabled?: boolean; reply?: string | null }): RuleOverride {
  const cur = ruleOverrides.get(intent) ?? { enabled: true };
  let reply = cur.reply;
  if (patch.reply === null) reply = undefined;
  else if (patch.reply !== undefined) reply = String(patch.reply).trim() || undefined;
  const next: RuleOverride = { enabled: patch.enabled ?? cur.enabled, reply };
  ruleOverrides.set(intent, next);
  schedulePersist();
  return next;
}

export function listRuleOverrides(): Record<string, RuleOverride> {
  return Object.fromEntries(ruleOverrides);
}

/**
 * 기본 규칙 한 건에서 **운영자가 바꿀 수 있는 것**의 모습 (DS 46-1).
 * 패턴·기본 응답문은 코드 관리라 바뀌지 않는다 — 켜짐 여부와 덮어쓴 답변만 센다.
 */
export function ruleOverrideRev(intent: string): string {
  const ov = ruleOverrides.get(intent) ?? { enabled: true };
  return revOf({ intent, enabled: ov.enabled, reply: ov.reply ?? '' });
}

/**
 * 답변을 덮어쓰기 **직전** 관문 — 20분 걸려 쓴 남의 답변을 말없이 밀어내지 않는다 (DS 46-1).
 * 켜기/끄기만 보내는 자리는 들고 오지 않는다(한 칸만 바꾸는 패치라 잃을 글이 없다).
 */
export function overrideConflict(intent: string, baseRev?: string): 'changed' | null {
  const base = String(baseRev ?? '').trim();
  if (!base) return null;
  return ruleOverrideRev(intent) === base ? null : 'changed';
}

// ---- 커스텀 시나리오 룰(키워드 기반) — 관리 콘솔에서 추가/수정/삭제 ----
// 내장 룰(정규식)과 달리 운영자가 안전하게 키워드로 정의한다. 인메모리 스텁 — [승인 필요] DB 영구 저장.
export interface CustomRule {
  intent: string; // "cr_..." 자동 부여(또는 지정)
  label: string; // 관리 콘솔 표시용
  keywords: string[]; // 소문자 정규화, 1개 이상 포함 시 매칭
  reply: string;
  escalate: boolean; // true면 상담원 접수 흐름으로 연결
  enabled: boolean;
  createdAt: string; // ISO
}

let customRules: CustomRule[] = [];

function cloneCustomRule(r: CustomRule): CustomRule {
  return { ...r, keywords: [...r.keywords] };
}

export function listCustomRules(): CustomRule[] {
  return customRules.map(cloneCustomRule);
}

export interface CustomRuleInput {
  intent?: string;
  label?: string;
  keywords?: string[] | string; // 배열 또는 콤마 구분 문자열
  reply?: string;
  escalate?: boolean;
  enabled?: boolean;
  /** 편집을 시작할 때 본 모습 (DS 46-1). 켜기/끄기처럼 한 칸만 보내는 자리는 들고 오지 않는다. */
  baseRev?: string;
}

export type CustomRuleResult =
  | { ok: true; rule: CustomRule; created: boolean }
  | { ok: false; error: string; conflict?: 'gone' | 'changed'; current?: CustomRule };

export function upsertCustomRule(input: CustomRuleInput): CustomRuleResult {
  const intent = (input.intent || '').trim() || autoId('cr', (v) => customRules.some((r) => r.intent === v));
  const keywords = normalizeKeywords(input.keywords);
  const existing = customRules.find((r) => r.intent === intent);

  // 자료 쪽과 같은 관문 (DS 46-1) — 같은 일을 두 탭이 다르게 하지 않는다.
  const conflict = conflictOf(input.baseRev, existing, customRuleRev);
  if (conflict === 'gone') return { ok: false, error: STALE_TARGET_MESSAGE, conflict };
  if (conflict === 'changed') {
    return { ok: false, error: CHANGED_TARGET_MESSAGE, conflict, current: cloneCustomRule(existing as CustomRule) };
  }

  if (!existing) {
    const label = (input.label || '').trim();
    const reply = (input.reply || '').trim();
    if (!label || !reply || keywords.length === 0) {
      return { ok: false, error: '규칙 이름·고객이 쓸 표현·답변을 모두 입력해 주세요.' };
    }
    const rule: CustomRule = {
      intent,
      label,
      keywords,
      reply,
      escalate: input.escalate === true,
      enabled: input.enabled !== false,
      createdAt: new Date().toISOString(),
    };
    customRules.push(rule);
    schedulePersist();
    return { ok: true, rule: cloneCustomRule(rule), created: true };
  }

  if (input.label !== undefined) existing.label = String(input.label).trim() || existing.label;
  if (input.reply !== undefined) existing.reply = String(input.reply).trim() || existing.reply;
  if (input.keywords !== undefined && keywords.length > 0) existing.keywords = keywords;
  if (input.escalate !== undefined) existing.escalate = input.escalate === true;
  if (input.enabled !== undefined) existing.enabled = input.enabled !== false;
  schedulePersist();
  return { ok: true, rule: cloneCustomRule(existing), created: false };
}

export function deleteCustomRule(intent: string): boolean {
  const before = customRules.length;
  customRules = customRules.filter((r) => r.intent !== intent);
  if (customRules.length < before) schedulePersist();
  return customRules.length < before;
}

/** 활성 커스텀 룰 중 키워드가 걸린 첫 항목(등록순). 없으면 null.
 *  띄어쓰기 무시 + 동의어 + 자모 오타 보정(src/lib/normalize)을 함께 적용한다. */
export function matchCustomRule(text: string): CustomRule | null {
  const pre = prepare(text);
  if (!pre.compact) return null;
  for (const r of customRules) {
    if (!r.enabled) continue;
    const hit = r.keywords.some((k) => keywordHit(pre.compact, pre.jamo, k).kind !== 'none');
    if (hit) return cloneCustomRule(r);
  }
  return null;
}

// ---- 영속화·백업(관리 콘텐츠 한정: KB·룰 오버라이드·커스텀 룰) ----
// 대화 로그·티켓 등 개인정보성 데이터는 이 스냅샷에 포함하지 않는다(각자 네임스페이스에서 관리).
// 저장 위치·드라이버·실패 사유는 `@/lib/storage`가 관리하고 /api/health·관리 콘솔에 노출된다.

export interface AdminSnapshot {
  version: 1;
  savedAt: string;
  kb: KBEntry[];
  ruleOverrides: Record<string, RuleOverride>;
  customRules: CustomRule[];
}

export const ADMIN_NS = 'admin';

export function exportSnapshot(): AdminSnapshot {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    kb: listKB(),
    ruleOverrides: listRuleOverrides(),
    customRules: listCustomRules(),
  };
}

function schedulePersist(): void {
  scheduleSave(ADMIN_NS, exportSnapshot);
}

/** 대기 중인 저장을 즉시 반영(백업 내려받기·종료 직전). */
export function flushAdminPersist(): void {
  flushSaves();
}

/**
 * 방금 한 변경이 **서버에 보관되었는가** (DS 47-1) — 「저장되었습니다」라고 답하기 전에 지난다.
 * 라우트는 이 값을 응답에 실어 보내고, 화면은 보관되지 않았으면 그 사실을 말한다.
 */
export function saveAdminNow(): SavedInfo {
  return savedInfo(saveNow(ADMIN_NS));
}

function isStrArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export type ImportResult =
  /** `saved` 는 **쓰기를 시도한 복원**에만 있다(기동 때의 읽어 들이기에는 없다 · DS 47-1). */
  | { ok: true; kb: number; overrides: number; customRules: number; saved?: SavedInfo }
  | { ok: false; error: string };

/** 스냅샷 검증 후 관리 콘텐츠 전체 교체. 무효 항목은 건너뛴다. */
export function importSnapshot(input: unknown, opts: { persist?: boolean } = {}): ImportResult {
  if (!input || typeof input !== 'object') return { ok: false, error: RESTORE_FORMAT_MESSAGE };
  const snap = input as Partial<AdminSnapshot>;
  if (!Array.isArray(snap.kb) || !Array.isArray(snap.customRules) || typeof snap.ruleOverrides !== 'object' || snap.ruleOverrides === null) {
    return { ok: false, error: RESTORE_FORMAT_MESSAGE };
  }

  const kb: KBEntry[] = [];
  for (const e of snap.kb) {
    if (!e || typeof e !== 'object') continue;
    const { id, category, question, answer, keywords } = e as KBEntry;
    if (typeof id !== 'string' || !id.trim()) continue;
    if (typeof question !== 'string' || !question.trim() || typeof answer !== 'string' || !answer.trim()) continue;
    if (!isStrArray(keywords) || keywords.length === 0) continue;
    const src = (e as KBEntry).source;
    kb.push({
      id: id.trim(),
      category: typeof category === 'string' && category.trim() ? category.trim() : '일반',
      question: question.trim(),
      keywords: keywords.map((k) => k.trim().toLowerCase()).filter(Boolean),
      answer: answer.trim(),
      ...(typeof src === 'string' && src.trim() ? { source: src.trim() } : {}),
    });
  }

  const rules: CustomRule[] = [];
  for (const r of snap.customRules) {
    if (!r || typeof r !== 'object') continue;
    const { intent, label, keywords, reply, escalate, enabled, createdAt } = r as CustomRule;
    if (typeof intent !== 'string' || !intent.trim()) continue;
    if (typeof label !== 'string' || !label.trim() || typeof reply !== 'string' || !reply.trim()) continue;
    if (!isStrArray(keywords) || keywords.length === 0) continue;
    rules.push({
      intent: intent.trim(),
      label: label.trim(),
      keywords: keywords.map((k) => k.trim().toLowerCase()).filter(Boolean),
      reply: reply.trim(),
      escalate: escalate === true,
      enabled: enabled !== false,
      createdAt: typeof createdAt === 'string' && createdAt ? createdAt : new Date().toISOString(),
    });
  }

  const overrides = new Map<string, RuleOverride>();
  for (const [intent, o] of Object.entries(snap.ruleOverrides)) {
    if (!o || typeof o !== 'object') continue;
    const ov = o as RuleOverride;
    overrides.set(intent, {
      enabled: ov.enabled !== false,
      reply: typeof ov.reply === 'string' && ov.reply.trim() ? ov.reply.trim() : undefined,
    });
  }

  kbEntries = kb;
  customRules = rules;
  ruleOverrides.clear();
  for (const [k, v] of overrides) ruleOverrides.set(k, v);

  // 복원은 「모두 덮어씁니다」라고 말하고 확인까지 받은 자리다 — 그 쓰기가 실패했는지를
  // 부르는 쪽이 알 수 있어야 한다(DS 47-1).
  const saved = opts.persist === false ? undefined : savedInfo(saveJson(ADMIN_NS, exportSnapshot()));
  return { ok: true, kb: kb.length, overrides: overrides.size, customRules: rules.length, ...(saved ? { saved } : {}) };
}

// 모듈 초기화 시 저장된 스냅샷 복원(없거나 손상되면 코드 기본값 유지 — 실패 사유는 storage 상태에 남는다).
(function loadPersisted() {
  const r = loadJson(ADMIN_NS);
  if (!r.ok) return; // empty/disabled/error — storageStatus()에서 확인 가능
  importSnapshot(r.data, { persist: false });
})();
