// 관리 콘솔 런타임 스토어(인메모리 스텁).
// [승인 필요] DB/파일 영구 저장 — 전까지 서버 재시작 시 기본값으로 복귀.
import { KB, KBEntry } from '@/lib/knowledge';

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
    const entry: KBEntry = { id, category: (input.category || '일반').trim() || '일반', question, keywords, answer };
    kbEntries.push(entry);
    return { ok: true, entry: cloneEntry(entry), created: true };
  }

  if (input.category !== undefined) existing.category = String(input.category).trim() || existing.category;
  if (input.question !== undefined) existing.question = String(input.question).trim() || existing.question;
  if (input.answer !== undefined) existing.answer = String(input.answer).trim() || existing.answer;
  if (input.keywords !== undefined && keywords.length > 0) existing.keywords = keywords;
  return { ok: true, entry: cloneEntry(existing), created: false };
}

export function deleteKB(id: string): boolean {
  const before = kbEntries.length;
  kbEntries = kbEntries.filter((e) => e.id !== id);
  return kbEntries.length < before;
}

export function resetKB(): void {
  kbEntries = KB.map(cloneEntry);
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
    return { ok: true, rule: cloneCustomRule(rule), created: true };
  }

  if (input.label !== undefined) existing.label = String(input.label).trim() || existing.label;
  if (input.reply !== undefined) existing.reply = String(input.reply).trim() || existing.reply;
  if (input.keywords !== undefined && keywords.length > 0) existing.keywords = keywords;
  if (input.escalate !== undefined) existing.escalate = input.escalate === true;
  if (input.enabled !== undefined) existing.enabled = input.enabled !== false;
  return { ok: true, rule: cloneCustomRule(existing), created: false };
}

export function deleteCustomRule(intent: string): boolean {
  const before = customRules.length;
  customRules = customRules.filter((r) => r.intent !== intent);
  return customRules.length < before;
}

/** 활성 커스텀 룰 중 키워드가 포함된 첫 항목(등록순). 없으면 null. 띄어쓰기 무시 비교 포함. */
export function matchCustomRule(text: string): CustomRule | null {
  const lower = text.toLowerCase();
  const compact = lower.replace(/\s+/g, '');
  for (const r of customRules) {
    if (!r.enabled) continue;
    const hit = r.keywords.some((k) => {
      const kw = k.toLowerCase();
      return lower.includes(kw) || compact.includes(kw.replace(/\s+/g, ''));
    });
    if (hit) return cloneCustomRule(r);
  }
  return null;
}
