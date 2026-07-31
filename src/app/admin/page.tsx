'use client';

// 관리 콘솔(MVP): 지식베이스(FAQ) CRUD · 시나리오 룰 편집 · 응답 테스트.
// 저장은 인메모리 스텁 — [승인 필요] DB 영구 저장·관리자 인증(현재 ADMIN_TOKEN 미설정 시 개방).
import { useCallback, useEffect, useState } from 'react';

interface KBEntryView {
  id: string;
  category: string;
  question: string;
  keywords: string[];
  answer: string;
}

interface RuleView {
  intent: string;
  label: string;
  pattern: string;
  escalate: boolean;
  defaultReply: string;
  enabled: boolean;
  replyOverride: string | null;
  effectiveReply: string;
}

interface TicketView {
  id: string;
  sessionId: string;
  reason: string;
  message: string;
  contact?: string;
  status: 'open' | 'in_progress' | 'resolved' | 'canceled';
  note?: string;
  createdAt: string;
  updatedAt: string;
}

interface OpsStats {
  escalation: { total: number; open: number; inProgress: number; resolved: number; canceled: number };
  conversation: { totalTurns: number; sessions: number; bySource: Record<string, number>; autoHandled: number; autoRate: number; escalatedTurns: number };
}

const TICKET_STATUS_LABELS: Record<TicketView['status'], string> = {
  open: '접수',
  in_progress: '상담 중',
  resolved: '완료',
  canceled: '취소',
};

interface KBForm {
  id: string;
  category: string;
  question: string;
  keywords: string;
  answer: string;
}

const EMPTY_FORM: KBForm = { id: '', category: '', question: '', keywords: '', answer: '' };

const S = {
  page: { maxWidth: 960, margin: '0 auto', padding: '32px 20px 80px' } as const,
  card: { background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--r)', padding: 20, marginBottom: 16 } as const,
  input: { width: '100%', border: '1px solid var(--line-2)', borderRadius: 'var(--r-sm)', padding: '8px 10px', fontSize: 14, marginBottom: 8 } as const,
  btn: { background: 'var(--brand)', color: '#fff', borderRadius: 'var(--r-sm)', padding: '8px 14px', fontSize: 14 } as const,
  btnGhost: { background: 'var(--brand-50)', color: 'var(--brand-600)', borderRadius: 'var(--r-sm)', padding: '8px 14px', fontSize: 14 } as const,
  tag: { fontSize: 12, color: 'var(--mut)' } as const,
};

export default function AdminPage() {
  const [tab, setTab] = useState<'kb' | 'rules' | 'esc' | 'test'>('kb');
  const [notice, setNotice] = useState('');

  // ---- KB ----
  const [entries, setEntries] = useState<KBEntryView[]>([]);
  const [form, setForm] = useState<KBForm>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);

  const loadKB = useCallback(async () => {
    const res = await fetch('/api/admin/kb');
    const data = await res.json();
    if (data.ok) setEntries(data.entries);
  }, []);

  // ---- Rules ----
  const [rules, setRules] = useState<RuleView[]>([]);
  const loadRules = useCallback(async () => {
    const res = await fetch('/api/admin/rules');
    const data = await res.json();
    if (data.ok) setRules(data.rules);
  }, []);

  // ---- Escalations ----
  const [tickets, setTickets] = useState<TicketView[]>([]);
  const [stats, setStats] = useState<OpsStats | null>(null);
  const loadEsc = useCallback(async () => {
    const res = await fetch('/api/admin/escalations');
    const data = await res.json();
    if (data.ok) {
      setTickets(data.tickets);
      setStats(data.stats);
    }
  }, []);

  useEffect(() => {
    loadKB();
    loadRules();
    loadEsc();
  }, [loadKB, loadRules, loadEsc]);

  const flash = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(''), 2500);
  };

  const submitKB = async () => {
    const body = {
      id: editingId ?? form.id,
      category: form.category,
      question: form.question,
      keywords: form.keywords,
      answer: form.answer,
    };
    const res = await fetch('/api/admin/kb', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) {
      flash(`저장 실패: ${data.error}`);
      return;
    }
    setForm(EMPTY_FORM);
    setEditingId(null);
    await loadKB();
    flash(editingId ? '수정되었습니다.' : '추가되었습니다.');
  };

  const editKB = (e: KBEntryView) => {
    setEditingId(e.id);
    setForm({ id: e.id, category: e.category, question: e.question, keywords: e.keywords.join(', '), answer: e.answer });
    setTab('kb');
  };

  const removeKB = async (id: string) => {
    const res = await fetch(`/api/admin/kb?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.ok) {
      await loadKB();
      flash('삭제되었습니다.');
    } else {
      flash(`삭제 실패: ${data.error}`);
    }
  };

  const resetAll = async () => {
    await fetch('/api/admin/kb', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reset: true }),
    });
    await loadKB();
    flash('기본 지식베이스로 초기화했습니다.');
  };

  const patchRule = async (intent: string, patch: { enabled?: boolean; reply?: string | null }) => {
    const res = await fetch('/api/admin/rules', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent, ...patch }),
    });
    const data = await res.json();
    if (data.ok) {
      setRules((prev) => prev.map((r) => (r.intent === intent ? data.rule : r)));
    } else {
      flash(`저장 실패: ${data.error}`);
    }
  };

  const patchTicket = async (id: string, status: TicketView['status']) => {
    const res = await fetch('/api/admin/escalations', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status }),
    });
    const data = await res.json();
    if (data.ok) {
      await loadEsc();
      flash(`${id} → ${TICKET_STATUS_LABELS[status]}`);
    } else {
      flash(`변경 실패: ${data.error}`);
    }
  };

  // ---- Test ----
  const [testInput, setTestInput] = useState('');
  const [testLog, setTestLog] = useState<{ q: string; reply: string; intent: string; source: string }[]>([]);

  const runTest = async () => {
    const q = testInput.trim();
    if (!q) return;
    setTestInput('');
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: q }),
    });
    const data = await res.json();
    setTestLog((prev) => [{ q, reply: data.reply ?? '(오류)', intent: data.intent ?? '-', source: data.source ?? '-' }, ...prev].slice(0, 20));
  };

  return (
    <main style={S.page}>
      <h1 style={{ fontSize: 24, marginBottom: 4 }}>관리 콘솔</h1>
      <p style={{ color: 'var(--sub)', fontSize: 14, marginBottom: 16 }}>
        지식베이스·시나리오 편집은 서버 메모리에만 반영됩니다(재시작 시 초기화 · 영구 저장은 준비 중).
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {(
          [
            ['kb', '지식베이스'],
            ['rules', '시나리오 룰'],
            ['esc', '상담원 요청'],
            ['test', '응답 테스트'],
          ] as const
        ).map(([key, label]) => (
          <button key={key} style={tab === key ? S.btn : S.btnGhost} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
        {notice && <span style={{ alignSelf: 'center', fontSize: 13, color: 'var(--brand-600)' }}>{notice}</span>}
      </div>

      {tab === 'kb' && (
        <>
          <section style={S.card}>
            <h2 style={{ fontSize: 16, marginBottom: 10 }}>{editingId ? `수정: ${editingId}` : '새 FAQ 추가'}</h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <input style={S.input} placeholder="id(비우면 자동 생성)" value={form.id} disabled={editingId !== null} onChange={(e) => setForm({ ...form, id: e.target.value })} />
              <input style={S.input} placeholder="카테고리(예: 요금)" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
            </div>
            <input style={S.input} placeholder="대표 질문" value={form.question} onChange={(e) => setForm({ ...form, question: e.target.value })} />
            <input style={S.input} placeholder="키워드(콤마 구분, 예: 요금, 가격, 얼마)" value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} />
            <textarea style={{ ...S.input, minHeight: 80 }} placeholder="답변" value={form.answer} onChange={(e) => setForm({ ...form, answer: e.target.value })} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={S.btn} onClick={submitKB}>
                {editingId ? '수정 저장' : '추가'}
              </button>
              {editingId && (
                <button
                  style={S.btnGhost}
                  onClick={() => {
                    setEditingId(null);
                    setForm(EMPTY_FORM);
                  }}
                >
                  취소
                </button>
              )}
              <button style={{ ...S.btnGhost, marginLeft: 'auto' }} onClick={resetAll}>
                기본값으로 초기화
              </button>
            </div>
          </section>
          {entries.map((e) => (
            <section key={e.id} style={S.card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <div>
                  <div style={S.tag}>
                    [{e.category}] {e.id}
                  </div>
                  <strong>{e.question}</strong>
                  <p style={{ fontSize: 14, color: 'var(--sub)', margin: '6px 0' }}>{e.answer}</p>
                  <div style={S.tag}>키워드: {e.keywords.join(', ')}</div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <button style={S.btnGhost} onClick={() => editKB(e)}>
                    수정
                  </button>
                  <button style={{ ...S.btnGhost, color: '#a33' }} onClick={() => removeKB(e.id)}>
                    삭제
                  </button>
                </div>
              </div>
            </section>
          ))}
        </>
      )}

      {tab === 'rules' && (
        <>
          <p style={{ ...S.tag, marginBottom: 12 }}>패턴(정규식)은 코드에서 관리하며, 여기서는 활성화 여부와 응답문만 편집합니다.</p>
          {rules.map((r) => (
            <section key={r.intent} style={S.card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <div>
                  <strong>{r.label}</strong> <span style={S.tag}>({r.intent}{r.escalate ? ' · 상담원 연결' : ''})</span>
                  <div style={S.tag}>패턴: /{r.pattern}/</div>
                </div>
                <button style={r.enabled ? S.btn : S.btnGhost} onClick={() => patchRule(r.intent, { enabled: !r.enabled })}>
                  {r.enabled ? '활성' : '비활성'}
                </button>
              </div>
              <textarea
                style={{ ...S.input, minHeight: 60, marginBottom: 4 }}
                defaultValue={r.effectiveReply}
                onBlur={(ev) => {
                  const v = ev.target.value.trim();
                  if (v !== r.effectiveReply) patchRule(r.intent, { reply: v === r.defaultReply ? null : v });
                }}
              />
              {r.replyOverride && (
                <button style={S.btnGhost} onClick={() => patchRule(r.intent, { reply: null })}>
                  기본 응답으로 되돌리기
                </button>
              )}
            </section>
          ))}
        </>
      )}

      {tab === 'esc' && (
        <>
          <section style={S.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ fontSize: 16 }}>운영 현황</h2>
              <button style={S.btnGhost} onClick={loadEsc}>새로고침</button>
            </div>
            {stats && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 10, fontSize: 14 }}>
                <span>대화 <strong>{stats.conversation.totalTurns}</strong>턴 · 세션 <strong>{stats.conversation.sessions}</strong></span>
                <span>자동처리율 <strong>{Math.round(stats.conversation.autoRate * 100)}%</strong> (룰/KB {stats.conversation.autoHandled}턴)</span>
                <span>상담원 요청 <strong>{stats.escalation.total}</strong>건 (대기 {stats.escalation.open} · 상담 중 {stats.escalation.inProgress} · 완료 {stats.escalation.resolved})</span>
              </div>
            )}
            <p style={{ ...S.tag, marginTop: 8 }}>로그·티켓은 서버 메모리에만 저장됩니다(재시작 시 초기화 · 영구 저장은 준비 중).</p>
          </section>
          {tickets.length === 0 && (
            <section style={S.card}>
              <p style={{ fontSize: 14, color: 'var(--sub)' }}>접수된 상담원 연결 요청이 없습니다. 위젯에서 &quot;상담원&quot;을 입력해 테스트할 수 있어요.</p>
            </section>
          )}
          {tickets.map((t) => (
            <section key={t.id} style={S.card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                <div>
                  <strong>{t.id}</strong>{' '}
                  <span style={S.tag}>
                    {TICKET_STATUS_LABELS[t.status]} · 세션 {t.sessionId} · 사유 {t.reason}
                  </span>
                  {t.message && <p style={{ fontSize: 14, color: 'var(--sub)', margin: '6px 0' }}>마지막 메시지: {t.message}</p>}
                  <div style={S.tag}>접수 {new Date(t.createdAt).toLocaleString()} · 갱신 {new Date(t.updatedAt).toLocaleString()}</div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {t.status === 'open' && (
                    <button style={S.btn} onClick={() => patchTicket(t.id, 'in_progress')}>상담 시작</button>
                  )}
                  {(t.status === 'open' || t.status === 'in_progress') && (
                    <>
                      <button style={S.btnGhost} onClick={() => patchTicket(t.id, 'resolved')}>완료</button>
                      <button style={{ ...S.btnGhost, color: '#a33' }} onClick={() => patchTicket(t.id, 'canceled')}>취소</button>
                    </>
                  )}
                  {(t.status === 'resolved' || t.status === 'canceled') && (
                    <button style={S.btnGhost} onClick={() => patchTicket(t.id, 'open')}>다시 열기</button>
                  )}
                </div>
              </div>
            </section>
          ))}
        </>
      )}

      {tab === 'test' && (
        <section style={S.card}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input
              style={{ ...S.input, marginBottom: 0 }}
              placeholder="고객 메시지를 입력해 응답을 확인하세요"
              value={testInput}
              onChange={(e) => setTestInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runTest()}
            />
            <button style={S.btn} onClick={runTest}>
              보내기
            </button>
          </div>
          {testLog.map((t, i) => (
            <div key={i} style={{ borderTop: '1px solid var(--line)', padding: '10px 0' }}>
              <div style={{ fontSize: 14 }}>
                <strong>Q.</strong> {t.q}
              </div>
              <div style={{ fontSize: 14, color: 'var(--sub)' }}>
                <strong>A.</strong> {t.reply}
              </div>
              <div style={S.tag}>
                intent: {t.intent} · source: {t.source}
              </div>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
