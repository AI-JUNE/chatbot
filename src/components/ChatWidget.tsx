'use client';
import { useEffect, useRef, useState } from 'react';

interface Suggestion { id: string; question: string }
interface Msg { role: 'bot' | 'user'; text: string; escalate?: boolean; suggestions?: Suggestion[]; ticketId?: string }

export default function ChatWidget() {
  const [open, setOpen] = useState(true);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([
    { role: 'bot', text: '안녕하세요! 고원 상담 챗봇이에요. 무엇을 도와드릴까요?' },
  ]);
  const [sessionId] = useState(() => `web_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
  const lastUserRef = useRef('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs, open]);

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
      setMsgs((m) => [...m, {
        role: 'bot',
        text: data.reply ?? '오류가 발생했어요.',
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
        setMsgs((x) => [...x, { role: 'bot', text: '접수 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.' }]);
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
      <button onClick={() => setOpen((o) => !o)} aria-label="상담 챗봇 열기" style={{ width: 58, height: 58, borderRadius: '50%', background: 'var(--brand)', color: '#fff', fontSize: 24, boxShadow: '0 10px 24px rgba(190,85,53,.4)', marginLeft: 'auto', display: 'block' }}>{open ? '×' : '💬'}</button>
    </div>
  );
}
