'use client';
import { useEffect, useRef, useState } from 'react';

interface Suggestion { id: string; question: string }
interface Msg { role: 'bot' | 'user'; text: string; escalate?: boolean; suggestions?: Suggestion[]; ticketId?: string }

// 표준 오류 응답(lib/http fail()) 소비 — code 기반 사용자 친화 문구.
interface ApiErrorLike { ok?: boolean; code?: string; message?: string; error?: string }
const ERROR_TEXT: Record<string, string> = {
  rate_limited: '메시지를 너무 빠르게 보내고 있어요.',
  payload_too_large: '메시지가 너무 길어요. 조금 줄여서 다시 보내주세요.',
  invalid_input: '메시지를 처리하지 못했어요. 내용을 바꿔 다시 보내주세요.',
  invalid_json: '요청 처리에 문제가 있었어요. 잠시 후 다시 시도해 주세요.',
  internal: '일시적인 오류가 발생했어요. 잠시 후 다시 시도해 주세요.',
};
function errorText(d: ApiErrorLike, res?: Response): string {
  const code = typeof d?.code === 'string' ? d.code : '';
  if (code === 'rate_limited') {
    const ra = Number(res?.headers.get('retry-after'));
    const wait = Number.isFinite(ra) && ra > 0 ? `약 ${Math.ceil(ra)}초 후` : '잠시 후';
    return `${ERROR_TEXT.rate_limited} ${wait} 다시 시도해 주세요.`;
  }
  return ERROR_TEXT[code] || d?.message || d?.error || '오류가 발생했어요. 잠시 후 다시 시도해 주세요.';
}

// embedded=true: embed.js가 iframe으로 띄우는 모드. 처음엔 버블만 보이고,
// 열림/닫힘 상태를 부모 페이지에 postMessage로 알려 iframe 크기를 맞춘다.
export const EMBED_SIZE = { open: { w: 400, h: 660 }, closed: { w: 104, h: 104 } };

export default function ChatWidget({ embedded = false }: { embedded?: boolean }) {
  const [open, setOpen] = useState(!embedded);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([
    { role: 'bot', text: '안녕하세요! 고원 상담 챗봇이에요. 무엇을 도와드릴까요?' },
  ]);
  const [sessionId] = useState(() => `web_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
  const lastUserRef = useRef('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs, open]);

  // 임베드 모드: 부모(embed.js)에 iframe 크기 변경 요청.
  useEffect(() => {
    if (!embedded || typeof window === 'undefined' || window.parent === window) return;
    const size = open ? EMBED_SIZE.open : EMBED_SIZE.closed;
    window.parent.postMessage({ source: 'gowon-chat', type: 'resize', open, width: size.w, height: size.h }, '*');
  }, [embedded, open]);

  // 메시지 전송(입력창·연관질문 칩 공용)
  async function sendText(raw: string) {
    const text = raw.trim();
    if (!text || busy) return;
    setInput('');
    lastUserRef.current = text;
    setMsgs((m) => [...m, { role: 'user', text }]);
    setBusy(true);
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, sessionId }),
      });
      const data = await r.json();
      if (!r.ok || data?.ok === false || typeof data?.reply !== 'string') {
        setMsgs((m) => [...m, { role: 'bot', text: errorText(data, r) }]);
        return;
      }
      setMsgs((m) => [...m, {
        role: 'bot',
        text: data.reply,
        escalate: data.escalate,
        suggestions: Array.isArray(data.suggestions) ? data.suggestions : undefined,
        ticketId: typeof data.ticketId === 'string' ? data.ticketId : undefined,
      }]);
    } catch {
      setMsgs((m) => [...m, { role: 'bot', text: '연결이 원활하지 않아요. 잠시 후 다시 시도해 주세요.' }]);
    } finally {
      setBusy(false);
    }
  }

  function send() { sendText(input); }

  // 상담원 연결 접수 — 티켓 생성(인메모리 스텁, 실제 상담원 알림은 준비 중)
  async function requestAgent() {
    try {
      const r = await fetch('/api/escalation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, reason: 'user_request', message: lastUserRef.current }),
      });
      const d = await r.json();
      if (d.ok) {
        setMsgs((x) => [...x, {
          role: 'bot',
          text: d.created
            ? `상담원 연결 요청이 접수됐어요. 접수번호 ${d.ticket.id} — 순서대로 도와드릴게요. (데모: 실제 연결은 준비 중)`
            : `이미 접수된 요청이 있어요. 접수번호 ${d.ticket.id} (${d.ticket.statusLabel}) — 잠시만 기다려 주세요.`,
        }]);
      } else {
        setMsgs((x) => [...x, { role: 'bot', text: `상담원 연결 접수에 실패했어요. ${errorText(d, r)}` }]);
      }
    } catch {
      setMsgs((x) => [...x, { role: 'bot', text: '연결이 원활하지 않아요. 잠시 후 다시 시도해 주세요.' }]);
    }
  }

  return (
    <div style={{ position: 'fixed', right: 22, bottom: 22, zIndex: 50, fontFamily: 'var(--font)' }}>
      {open && (
        <div style={{ width: 340, height: 520, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 18, boxShadow: '0 20px 50px rgba(36,29,23,.18)', display: 'flex', flexDirection: 'column', overflow: 'hidden', marginBottom: 12 }}>
          <div style={{ background: 'var(--brand)', color: '#fff', padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 9 }}>
            <span style={{ width: 30, height: 30, borderRadius: 9, background: 'rgba(255,255,255,.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800 }}>고</span>
            <div style={{ lineHeight: 1.2 }}>
              <div style={{ fontWeight: 800, fontSize: 14 }}>고원 상담 챗봇</div>
              <div style={{ fontSize: 10.5, opacity: .9 }}>24시간 · AI 1차 응대</div>
            </div>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '14px 12px', background: '#f6f2ec', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {msgs.map((m, i) => (
              <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '82%' }}>
                <div style={{ background: m.role === 'user' ? 'var(--brand)' : '#fff', color: m.role === 'user' ? '#fff' : 'var(--ink)', border: m.role === 'user' ? 'none' : '1px solid var(--line)', borderRadius: 13, padding: '9px 12px', fontSize: 13.3, lineHeight: 1.5 }}>{m.text}</div>
                {m.suggestions && m.suggestions.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                    {m.suggestions.map((s) => (
                      <button key={s.id} onClick={() => sendText(s.question)} disabled={busy} style={{ fontSize: 12, fontWeight: 600, color: 'var(--brand-600)', background: '#fff', border: '1px solid var(--line)', borderRadius: 999, padding: '6px 11px', cursor: 'pointer' }}>{s.question}</button>
                    ))}
                  </div>
                )}
                {m.escalate && !m.ticketId && (
                  <button onClick={requestAgent} style={{ marginTop: 5, fontSize: 12, fontWeight: 700, color: 'var(--brand-600)', background: 'var(--brand-50)', borderRadius: 8, padding: '6px 10px' }}>상담원 연결하기</button>
                )}
              </div>
            ))}
            <div ref={endRef} />
          </div>
          <div style={{ display: 'flex', gap: 8, padding: 10, borderTop: '1px solid var(--line)', background: '#fff' }}>
            <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); }} placeholder="메시지를 입력하세요" aria-label="메시지 입력" style={{ flex: 1, border: '1px solid var(--line-2)', borderRadius: 999, padding: '9px 14px', fontSize: 13, outline: 'none' }} />
            <button onClick={send} disabled={busy} aria-label="전송" style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--brand)', color: '#fff', fontWeight: 800, opacity: busy ? .6 : 1 }}>↑</button>
          </div>
        </div>
      )}
      <button onClick={() => setOpen((o) => !o)} aria-label={open ? '상담 챗봇 닫기' : '상담 챗봇 열기'} aria-expanded={open} style={{ width: 58, height: 58, borderRadius: '50%', background: 'var(--brand)', color: '#fff', fontSize: 24, boxShadow: '0 10px 24px rgba(190,85,53,.4)', marginLeft: 'auto', display: 'block' }}>{open ? '×' : '💬'}</button>
    </div>
  );
}
