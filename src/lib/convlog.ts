// 대화 로그·감사 스키마(스텁) — 인메모리 링버퍼.
// [승인 필요] 실대화 개인정보 영구 저장(DB)·감사 로그 외부 전송 — 전까지 메모리(최근 500건)만 유지.
import type { ReplySource } from '@/lib/chat';

export interface ChatTurnLog {
  id: string;
  sessionId: string;
  channel: 'web' | 'kakao' | 'call'; // 멀티채널 대비(현재 web만 사용)
  message: string;
  reply: string;
  intent: string;
  source: ReplySource;
  escalate: boolean;
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
  return { ...entry };
}

export function listTurns(limit = 50): ChatTurnLog[] {
  return logs.slice(-limit).reverse().map((l) => ({ ...l }));
}

export interface ConvStats {
  totalTurns: number;
  sessions: number;
  bySource: Record<string, number>;
  autoHandled: number; // rule/kb로 즉시 응답한 턴
  autoRate: number; // 자동처리율(0~1, 소수 3자리)
  escalatedTurns: number;
}

export function convStats(): ConvStats {
  const bySource: Record<string, number> = {};
  const sessions = new Set<string>();
  let autoHandled = 0;
  let escalatedTurns = 0;
  for (const l of logs) {
    bySource[l.source] = (bySource[l.source] || 0) + 1;
    sessions.add(l.sessionId);
    if (l.source === 'rule' || l.source === 'kb') autoHandled += 1;
    if (l.escalate) escalatedTurns += 1;
  }
  const totalTurns = logs.length;
  return {
    totalTurns,
    sessions: sessions.size,
    bySource,
    autoHandled,
    autoRate: totalTurns ? Math.round((autoHandled / totalTurns) * 1000) / 1000 : 0,
    escalatedTurns,
  };
}

export function resetLogs(): void {
  logs = [];
  seq = 0;
}
