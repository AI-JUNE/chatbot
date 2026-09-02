// 대화 로그 — 인메모리 링버퍼(최근 500건) + 영속화 어댑터 연결.
// 대화 본문은 **개인정보 포함 데이터**이므로 `PERSIST_PII=true` **[승인 필요]** 전까지 디스크에 쓰지 않는다.
// 코드 경로는 완성되어 있고 스위치만 잠겨 있다(승인 전 동작은 기존과 동일 — 메모리만).
// [승인 필요] 외부 DB 저장·분석 파이프라인 전송.
import type { ReplySource } from '@/lib/chat';
import { loadJson, scheduleSave } from '@/lib/storage';

export interface ChatTurnLog {
  id: string;
  sessionId: string;
  channel: 'web' | 'kakao' | 'call'; // 멀티채널 대비(현재 web만 사용)
  message: string;
  reply: string;
  intent: string;
  source: ReplySource;
  escalate: boolean;
  /** 엔진 내부 신뢰도(0~1). 자동 전환 판정 근거이며 측정된 정확도 지표가 아니다. */
  confidence?: number;
  at: string; // ISO
}

const MAX_LOGS = 500;
let logs: ChatTurnLog[] = [];
let seq = 0;

export function logTurn(input: Omit<ChatTurnLog, 'id' | 'at'>): ChatTurnLog {
  seq += 1;
  const entry: ChatTurnLog = {
    ...input,
    message: input.message.slice(0, 500),
    reply: input.reply.slice(0, 500),
    id: `T-${String(seq).padStart(6, '0')}`,
    at: new Date().toISOString(),
  };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS);
  scheduleSave(CONVLOG_NS, exportTurns);
  return { ...entry };
}

export const CONVLOG_NS = 'convlog';

export interface ConvLogSnapshot {
  version: 1;
  savedAt: string;
  seq: number;
  turns: ChatTurnLog[];
}

export function exportTurns(): ConvLogSnapshot {
  return { version: 1, savedAt: new Date().toISOString(), seq, turns: listAllTurns() };
}

const CHANNELS = new Set(['web', 'kakao', 'call']);

/** 스냅샷 복원. 형식 위반 항목은 건너뛴다. */
export function importTurns(input: unknown): { ok: true; count: number } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: '유효한 JSON 객체가 아닙니다.' };
  const snap = input as Partial<ConvLogSnapshot>;
  if (!Array.isArray(snap.turns)) return { ok: false, error: 'turns 배열이 필요합니다.' };
  const restored: ChatTurnLog[] = [];
  for (const raw of snap.turns) {
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as ChatTurnLog;
    if (typeof t.id !== 'string' || !t.id.trim()) continue;
    if (typeof t.sessionId !== 'string' || !t.sessionId) continue;
    if (!CHANNELS.has(t.channel)) continue;
    restored.push({
      ...t,
      message: String(t.message ?? '').slice(0, 500),
      reply: String(t.reply ?? '').slice(0, 500),
      intent: String(t.intent ?? ''),
      escalate: t.escalate === true,
      at: typeof t.at === 'string' && t.at ? t.at : new Date().toISOString(),
    });
  }
  logs = restored.slice(-MAX_LOGS);
  const maxSeq = logs.reduce((m, l) => {
    const n = Number(String(l.id).replace(/[^0-9]/g, ''));
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  seq = typeof snap.seq === 'number' && snap.seq > maxSeq ? snap.seq : maxSeq;
  return { ok: true, count: logs.length };
}

export function listTurns(limit = 50): ChatTurnLog[] {
  return logs.slice(-limit).reverse().map((l) => ({ ...l }));
}

/** 전체 로그(시간순, 메모리 보존분 최대 500건) — CSV 내보내기용. */
export function listAllTurns(): ChatTurnLog[] {
  return logs.map((l) => ({ ...l }));
}

export interface ConvStats {
  totalTurns: number;
  sessions: number;
  bySource: Record<string, number>;
  byChannel: Record<string, number>;
  topIntents: { intent: string; count: number }[]; // 상위 10개
  autoHandled: number; // rule/kb로 즉시 응답한 턴
  autoRate: number; // 자동처리율(0~1, 소수 3자리)
  escalatedTurns: number;
}

export function convStats(): ConvStats {
  const bySource: Record<string, number> = {};
  const byChannel: Record<string, number> = {};
  const byIntent: Record<string, number> = {};
  const sessions = new Set<string>();
  let autoHandled = 0;
  let escalatedTurns = 0;
  for (const l of logs) {
    bySource[l.source] = (bySource[l.source] || 0) + 1;
    byChannel[l.channel] = (byChannel[l.channel] || 0) + 1;
    byIntent[l.intent] = (byIntent[l.intent] || 0) + 1;
    sessions.add(l.sessionId);
    if (l.source === 'rule' || l.source === 'kb') autoHandled += 1;
    if (l.escalate) escalatedTurns += 1;
  }
  const topIntents = Object.entries(byIntent)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([intent, count]) => ({ intent, count }));
  const totalTurns = logs.length;
  return {
    totalTurns,
    sessions: sessions.size,
    bySource,
    byChannel,
    topIntents,
    autoHandled,
    autoRate: totalTurns ? Math.round((autoHandled / totalTurns) * 1000) / 1000 : 0,
    escalatedTurns,
  };
}

export function resetLogs(): void {
  logs = [];
  seq = 0;
  scheduleSave(CONVLOG_NS, exportTurns);
}

// 기동 시 복원 — 승인 전(PERSIST_PII 미설정)에는 storage가 차단하므로 아무 일도 일어나지 않는다.
(function loadPersisted() {
  const r = loadJson(CONVLOG_NS);
  if (!r.ok) return;
  importTurns(r.data);
})();
