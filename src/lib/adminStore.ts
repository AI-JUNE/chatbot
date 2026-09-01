// 관리 콘솔 런타임 스토어(인메모리 스텁).
// [승인 필요] DB/파일 영구 저장 — 전까지 서버 재시작 시 기본값으로 복귀.
import fs from 'fs';
import path from 'path';
import { KB, KBEntry } from '@/lib/knowledge';
import { keywordHit, prepare } from '@/lib/normalize';

function cloneEntry(e: KBEntry): KBEntry {
  return { ...e, keywords: [...e.keywords] };
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
}

function normalizeKeywords(kw: KBUpsertInput['keywords']): string[] {
  if (!kw) return [];
  const arr = Array.isArray(kw) ? kw : String(kw).split(',');
  return arr.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
}

export type UpsertResult = { ok: true; entry: KBEntry; created: boolean } | { ok: false; error: string };

export function upsertKB(input: KBUpsertInput): UpsertResult {
  const id = (input.id || '').trim() || `kb_${Date.now().toString(36)}`;
  const keywords = normalizeKeywords(input.keywords);
  const existing = kbEntries.find((e) => e.id === id);

  if (!existing) {
    const question = (input.question || '').trim();
    const answer = (input.answer || '').trim();
    if (!question || !answer || keywords.length === 0) {
      return { ok: false, error: 'question, answer, keywords(1개 이상)는 필수입니다.' };
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
}

export type CustomRuleResult = { ok: true; rule: CustomRule; created: boolean } | { ok: false; error: string };

export function upsertCustomRule(input: CustomRuleInput): CustomRuleResult {
  const intent = (input.intent || '').trim() || `cr_${Date.now().toString(36)}`;
  const keywords = normalizeKeywords(input.keywords);
  const existing = customRules.find((r) => r.intent === intent);

  if (!existing) {
    const label = (input.label || '').trim();
    const reply = (input.reply || '').trim();
    if (!label || !reply || keywords.length === 0) {
      return { ok: false, error: 'label, reply, keywords(1개 이상)는 필수입니다.' };
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

// ---- 파일 영속화·백업(관리 콘텐츠 한정: KB·룰 오버라이드·커스텀 룰) ----
// 대화 로그·티켓 등 개인정보성 데이터는 포함하지 않는다(그쪽 영구 저장은 [승인 필요]).
// 로컬/단일 서버: data/admin-store.json 에 자동 저장·기동 시 복원.
// Vercel 등 읽기전용·휘발성 FS: 쓰기 실패를 조용히 무시 — /api/admin/backup 으로 수동 백업·복원.
// ADMIN_PERSIST=false 로 비활성화, ADMIN_PERSIST_FILE 로 경로 변경.

export interface AdminSnapshot {
  version: 1;
  savedAt: string;
  kb: KBEntry[];
  ruleOverrides: Record<string, RuleOverride>;
  customRules: CustomRule[];
}

const PERSIST_ENABLED = process.env.ADMIN_PERSIST !== 'false';
const PERSIST_FILE = process.env.ADMIN_PERSIST_FILE || path.join(process.cwd(), 'data', 'admin-store.json');

let persistTimer: ReturnType<typeof setTimeout> | null = null;

export function exportSnapshot(): AdminSnapshot {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    kb: listKB(),
    ruleOverrides: listRuleOverrides(),
    customRules: listCustomRules(),
  };
}

function persistNow(): void {
  if (!PERSIST_ENABLED) return;
  try {
    fs.mkdirSync(path.dirname(PERSIST_FILE), { recursive: true });
    fs.writeFileSync(PERSIST_FILE, JSON.stringify(exportSnapshot(), null, 2), 'utf8');
  } catch {
    // 읽기전용 FS(Vercel 런타임 등) — 저장 생략, 백업 API로 대체
  }
}

function schedulePersist(): void {
  if (!PERSIST_ENABLED) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 300);
}

function isStrArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export type ImportResult =
  | { ok: true; kb: number; overrides: number; customRules: number }
  | { ok: false; error: string };

/** 스냅샷 검증 후 관리 콘텐츠 전체 교체. 무효 항목은 건너뛴다. */
export function importSnapshot(input: unknown, opts: { persist?: boolean } = {}): ImportResult {
  if (!input || typeof input !== 'object') return { ok: false, error: '유효한 JSON 객체가 아닙니다.' };
  const snap = input as Partial<AdminSnapshot>;
  if (!Array.isArray(snap.kb) || !Array.isArray(snap.customRules) || typeof snap.ruleOverrides !== 'object' || snap.ruleOverrides === null) {
    return { ok: false, error: 'kb·customRules 배열과 ruleOverrides 객체가 필요합니다.' };
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

  if (opts.persist !== false) persistNow();
  return { ok: true, kb: kb.length, overrides: overrides.size, customRules: rules.length };
}

// 모듈 초기화 시 저장된 스냅샷 복원(없거나 실패하면 코드 기본값 유지).
(function loadPersisted() {
  if (!PERSIST_ENABLED) return;
  try {
    const raw = fs.readFileSync(PERSIST_FILE, 'utf8');
    importSnapshot(JSON.parse(raw), { persist: false });
  } catch {
    // 파일 없음·파싱 실패 — 기본값 유지
  }
})();
