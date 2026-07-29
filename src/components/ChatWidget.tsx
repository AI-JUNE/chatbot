'use client';
import { useEffect, useRef, useState } from 'react';

interface Msg { role: 'bot' | 'user'; text: string; escalate?: boolean }

export default function ChatWidget() {
  const [open, setOpen] = useState(true);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([
    { role: 'bot', text: '안녕하세요! 고원 상담 챗봇이에요. 무엇을 도와드릴까요?' },
  ]);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs, open]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setMsgs((m) => [...m, { role: 'user', text }]);
    setBusy(true);
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      const data = await r.json();
      setMsgs((m) => [...m, { role: 'bot', text: data.reply ?? '오류가 발생했어요.', escalate: data.escalate }]);
    } catch {
      setMsgs((m) => [...m, { role: 'bot', text: '연결이 원활하지 않아요. 잠시 후 다시 시도해 주세요.' }]);
    } finally {
      setBusy(false);
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
                {m.escalate && (
                  <button onClick={() => setMsgs((x) => [...x, { role: 'bot', text: '상담원 연결 요청이 접수됐어요. (데모: 실제 연결은 준비 중)' }])} style={{ marginTop: 5, fontSize: 12, fontWeight: 700, color: 'var(--brand-600)', background: 'var(--brand-50)', borderRadius: 8, padding: '6px 10px' }}>상담원 연결하기</button>
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
