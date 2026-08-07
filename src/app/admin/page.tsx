'use client';

// 관리 콘솔(MVP): 지식베이스(FAQ) CRUD · 시나리오 룰 편집 · 응답 테스트.
// 저장은 인메모리 스텁 — [승인 필요] DB 영구 저장·관리자 인증(현재 ADMIN_TOKEN 미설정 시 개방).
import { useCallback, useEffect, useRef, useState } from 'react';

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

interface CustomRuleView {
  intent: string;
  label: string;
  keywords: string[];
  reply: string;
  escalate: boolean;
  enabled: boolean;
  createdAt: string;
}

interface CustomRuleForm {
  label: string;
  keywords: string;
  reply: string;
  escalate: boolean;
}

const EMPTY_CR_FORM: CustomRuleForm = { label: '', keywords: '', reply: '', escalate: false };

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
  conversation: {
    totalTurns: number;
    sessions: number;
    bySource: Record<string, number>;
    byChannel: Record<string, number>;
    topIntents: { intent: string; count: number }[];
    autoHandled: number;
    autoRate: number;
    escalatedTurns: number;
  };
}

interface TurnView {
  id: string;
  sessionId: string;
  channel: string;
  message: string;
  reply: string;
  intent: string;
  source: string;
  escalate: boolean;
  at: string;
}

const TICKET_STATUS_LABELS: Record<TicketView['status'], string> = {
  open: '접수',
  in_progress: '상담 중',
  resolved: '완료',
  canceled: '취소',
};

interface AuditView {
  id: string;
  at: string;
  action: string;
  target: string;
  detail: string;
  authed: boolean;
}

const AUDIT_ACTION_LABELS: Record<string, string> = {
  'kb.upsert': 'KB 등록/수정',
  'kb.delete': 'KB 삭제',
  'kb.reset': 'KB 초기화',
  'rule.override': '내장 룰 변경',
  'rule.custom.upsert': '커스텀 룰 등록/수정',
  'rule.custom.delete': '커스텀 룰 삭제',
  'escalation.update': '티켓 변경',
  'backup.restore': '백업 복원',
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
  const [tab, setTab] = useState<'dash' | 'kb' | 'rules' | 'esc' | 'test' | 'audit'>('dash');
  const [notice, setNotice] = useState('');

  // ---- 관리 토큰(ADMIN_TOKEN 설정 시 x-admin-token 필수) ----
  const [adminToken, setAdminToken] = useState('');
  const tokenRef = useRef('');
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('cb_admin_token') || '';
      if (saved) {
        setAdminToken(saved);
        tokenRef.current = saved;
      }
    } catch {
      /* localStorage 미지원 환경 무시 */
    }
  }, []);
  const applyToken = (v: string) => {
    setAdminToken(v);
    tokenRef.current = v;
    try {
      window.localStorage.setItem('cb_admin_token', v);
    } catch {
      /* ignore */
    }
  };
  const authHeaders = (json = false): Record<string, string> => ({
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(tokenRef.current ? { 'x-admin-token': tokenRef.current } : {}),
  });

  // ---- KB ----
  const [entries, setEntries] = useState<KBEntryView[]>([]);
  const [form, setForm] = useState<KBForm>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);

  const loadKB = useCallback(async () => {
    const res = await fetch('/api/admin/kb', { headers: authHeaders() });
    const data = await res.json();
    if (data.ok) setEntries(data.entries);
  }, []);

  // ---- Rules ----
  const [rules, setRules] = useState<RuleView[]>([]);
  const [customRules, setCustomRules] = useState<CustomRuleView[]>([]);
  const [crForm, setCrForm] = useState<CustomRuleForm>(EMPTY_CR_FORM);
  const [crEditing, setCrEditing] = useState<string | null>(null);
  const loadRules = useCallback(async () => {
    const res = await fetch('/api/admin/rules', { headers: authHeaders() });
    const data = await res.json();
    if (data.ok) {
      setRules(data.rules);
      setCustomRules(data.customRules || []);
    }
  }, []);

  // ---- Escalations ----
  const [tickets, setTickets] = useState<TicketView[]>([]);
  const [stats, setStats] = useState<OpsStats | null>(null);
  const [recentTurns, setRecentTurns] = useState<TurnView[]>([]);
  const loadEsc = useCallback(async () => {
    const res = await fetch('/api/admin/escalations?logs=true', { headers: authHeaders() });
    const data = await res.json();
    if (data.ok) {
      setTickets(data.tickets);
      setStats(data.stats);
      setRecentTurns(data.recentTurns || []);
    }
  }, []);

  // ---- Audit ----
  const [auditEvents, setAuditEvents] = useState<AuditView[]>([]);
  const loadAudit = useCallback(async () => {
    const res = await fetch('/api/admin/audit?limit=100', { headers: authHeaders() });
    const data = await res.json();
    if (data.ok) setAuditEvents(data.events || []);
  }, []);

  useEffect(() => {
    loadKB();
    loadRules();
    loadEsc();
    loadAudit();
  }, [loadKB, loadRules, loadEsc, loadAudit]);

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
      headers: authHeaders(true),
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
    const res = await fetch(`/api/admin/kb?id=${encodeURIComponent(id)}`, { method: 'DELETE', headers: authHeaders() });
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
      headers: authHeaders(true),
      body: JSON.stringify({ reset: true }),
    });
    await loadKB();
    flash('기본 지식베이스로 초기화했습니다.');
  };

  const patchRule = async (intent: string, patch: { enabled?: boolean; reply?: string | null }) => {
    const res = await fetch('/api/admin/rules', {
      method: 'PATCH',
      headers: authHeaders(true),
      body: JSON.stringify({ intent, ...patch }),
    });
    const data = await res.json();
    if (data.ok) {
      setRules((prev) => prev.map((r) => (r.intent === intent ? data.rule : r)));
    } else {
      flash(`저장 실패: ${data.error}`);
    }
  };

  const submitCustomRule = async () => {
    const body = {
      ...(crEditing ? { intent: crEditing } : {}),
      label: crForm.label,
      keywords: crForm.keywords,
      reply: crForm.reply,
      escalate: crForm.escalate,
    };
    const res = await fetch('/api/admin/rules', {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) {
      flash(`저장 실패: ${data.error}`);
      return;
    }
    setCrForm(EMPTY_CR_FORM);
    setCrEditing(null);
    await loadRules();
    flash(crEditing ? '커스텀 룰이 수정되었습니다.' : '커스텀 룰이 추가되었습니다.');
  };

  const toggleCustomRule = async (r: CustomRuleView) => {
    const res = await fetch('/api/admin/rules', {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ intent: r.intent, enabled: !r.enabled }),
    });
    const data = await res.json();
    if (data.ok) await loadRules();
    else flash(`변경 실패: ${data.error}`);
  };

  const removeCustomRule = async (intent: string) => {
    const res = await fetch(`/api/admin/rules?intent=${encodeURIComponent(intent)}`, { method: 'DELETE', headers: authHeaders() });
    const data = await res.json();
    if (data.ok) {
      if (crEditing === intent) {
        setCrEditing(null);
        setCrForm(EMPTY_CR_FORM);
      }
      await loadRules();
      flash('커스텀 룰이 삭제되었습니다.');
    } else {
      flash(`삭제 실패: ${data.error}`);
    }
  };

  const downloadLogsCsv = () => {
    const t = tokenRef.current;
    window.open('/api/admin/logs/export' + (t ? `?token=${encodeURIComponent(t)}` : ''), '_blank');
  };

  // ---- 관리 콘텐츠 백업·복원(KB·룰 — 개인정보 없음) ----
  const restoreInputRef = useRef<HTMLInputElement | null>(null);

  const downloadBackup = () => {
    const t = tokenRef.current;
    window.open('/api/admin/backup' + (t ? `?token=${encodeURIComponent(t)}` : ''), '_blank');
  };

  const restoreBackup = async (file: File) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      flash('복원 실패: JSON 파일이 아닙니다.');
      return;
    }
    const res = await fetch('/api/admin/backup', {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify(parsed),
    });
    const data = await res.json();
    if (!data.ok) {
      flash(`복원 실패: ${data.error}`);
      return;
    }
    await Promise.all([loadKB(), loadRules()]);
    flash(`복원 완료: KB ${data.kb} · 커스텀 룰 ${data.customRules} · 오버라이드 ${data.overrides}`);
  };

  const patchTicket = async (id: string, status: TicketView['status']) => {
    const res = await fetch('/api/admin/escalations', {
      method: 'PATCH',
      headers: authHeaders(true),
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
        지식베이스·시나리오 편집은 서버에 저장됩니다(로컬: data/admin-store.json 자동 저장 · 서버리스는 대시보드의 백업 JSON/복원 사용). 대화 로그·통계는 메모리 유지.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        {(
          [
            ['dash', '대시보드'],
            ['kb', '지식베이스'],
            ['rules', '시나리오 룰'],
            ['esc', '상담원 요청'],
            ['test', '응답 테스트'],
            ['audit', '감사 로그'],
          ] as const
        ).map(([key, label]) => (
          <button key={key} style={tab === key ? S.btn : S.btnGhost} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
        {notice && <span style={{ alignSelf: 'center', fontSize: 13, color: 'var(--brand-600)' }}>{notice}</span>}
        <input
          style={{ marginLeft: 'auto', border: '1px solid var(--line-2)', borderRadius: 'var(--r-sm)', padding: '6px 10px', fontSize: 13, width: 170 }}
          type="password"
          placeholder="관리 토큰(설정 시)"
          aria-label="관리 토큰"
          value={adminToken}
          onChange={(e) => applyToken(e.target.value)}
          onBlur={() => {
            loadKB();
            loadRules();
            loadEsc();
            loadAudit();
          }}
        />
      </div>

      {tab === 'dash' && (
        <>
          <section style={S.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ fontSize: 16 }}>운영 대시보드</h2>
              <div style={{ display: 'flex', gap: 8 }}>
                <button style={S.btnGhost} onClick={downloadLogsCsv}>로그 CSV</button>
                <button style={S.btnGhost} onClick={downloadBackup}>백업 JSON</button>
                <button style={S.btnGhost} onClick={() => restoreInputRef.current?.click()}>복원</button>
                <input
                  ref={restoreInputRef}
                  type="file"
                  accept="application/json,.json"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) restoreBackup(f);
                    e.target.value = '';
                  }}
                />
                <button style={S.btnGhost} onClick={loadEsc}>새로고침</button>
              </div>
            </div>
            {stats ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginTop: 12 }}>
                {[
                  ['총 대화 턴', String(stats.conversation.totalTurns)],
                  ['세션 수', String(stats.conversation.sessions)],
                  ['자동처리율', `${Math.round(stats.conversation.autoRate * 100)}%`],
                  ['상담원 요청', `${stats.escalation.total}건 (대기 ${stats.escalation.open})`],
                ].map(([k, v]) => (
                  <div key={k} style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', padding: '12px 14px' }}>
                    <div style={S.tag}>{k}</div>
                    <div style={{ fontSize: 21, fontWeight: 800 }}>{v}</div>
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ fontSize: 14, color: 'var(--sub)', marginTop: 8 }}>통계를 불러오는 중입니다… (401이면 우측 상단에 관리 토큰을 입력하세요)</p>
            )}
            {stats && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 12, fontSize: 13, color: 'var(--sub)' }}>
                <span>응답 소스: {Object.entries(stats.conversation.bySource).map(([k, v]) => `${k} ${v}`).join(' · ') || '-'}</span>
                <span>채널: {Object.entries(stats.conversation.byChannel).map(([k, v]) => `${k} ${v}`).join(' · ') || '-'}</span>
                <span>상담원 제안 턴: {stats.conversation.escalatedTurns}</span>
              </div>
            )}
            <p style={{ ...S.tag, marginTop: 8 }}>통계·로그는 서버 메모리 기준입니다(재시작 시 초기화 · 영구 저장은 준비 중).</p>
          </section>
          {stats && stats.conversation.topIntents.length > 0 && (
            <section style={S.card}>
              <h2 style={{ fontSize: 16, marginBottom: 8 }}>인텐트 TOP {stats.conversation.topIntents.length}</h2>
              {stats.conversation.topIntents.map((t) => {
                const max = stats.conversation.topIntents[0].count || 1;
                return (
                  <div key={t.intent} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ width: 160, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.intent}</span>
                    <div style={{ flex: 1, background: 'var(--brand-50)', borderRadius: 999, height: 10 }}>
                      <div style={{ width: `${Math.max(6, Math.round((t.count / max) * 100))}%`, background: 'var(--brand)', borderRadius: 999, height: 10 }} />
                    </div>
                    <span style={{ ...S.tag, width: 36, textAlign: 'right' }}>{t.count}</span>
                  </div>
                );
              })}
            </section>
          )}
          <section style={S.card}>
            <h2 style={{ fontSize: 16, marginBottom: 8 }}>최근 대화 (최대 30건)</h2>
            {recentTurns.length === 0 && (
              <p style={{ fontSize: 14, color: 'var(--sub)' }}>아직 대화 로그가 없습니다. 위젯이나 응답 테스트 탭에서 대화해 보세요.</p>
            )}
            {recentTurns.map((t) => (
              <div key={t.id} style={{ borderTop: '1px solid var(--line)', padding: '8px 0' }}>
                <div style={S.tag}>
                  {new Date(t.at).toLocaleString()} · {t.channel} · {t.sessionId} · intent {t.intent} · source {t.source}
                  {t.escalate ? ' · 상담원 제안' : ''}
                </div>
                <div style={{ fontSize: 14 }}><strong>Q.</strong> {t.message}</div>
                <div style={{ fontSize: 14, color: 'var(--sub)' }}><strong>A.</strong> {t.reply}</div>
              </div>
            ))}
          </section>
        </>
      )}

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
          <section style={S.card}>
            <h2 style={{ fontSize: 16, marginBottom: 4 }}>{crEditing ? `커스텀 룰 수정: ${crEditing}` : '커스텀 룰 추가'}</h2>
            <p style={{ ...S.tag, marginBottom: 10 }}>키워드가 포함된 메시지에 지정한 응답을 보냅니다. 내장 룰 다음, FAQ 매칭 이전에 적용됩니다.</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <input style={S.input} placeholder="이름(예: 배송 문의)" value={crForm.label} onChange={(e) => setCrForm({ ...crForm, label: e.target.value })} />
              <input style={S.input} placeholder="키워드(콤마 구분, 예: 배송, 택배, 언제 와)" value={crForm.keywords} onChange={(e) => setCrForm({ ...crForm, keywords: e.target.value })} />
            </div>
            <textarea style={{ ...S.input, minHeight: 60 }} placeholder="응답문" value={crForm.reply} onChange={(e) => setCrForm({ ...crForm, reply: e.target.value })} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginBottom: 8 }}>
              <input type="checkbox" checked={crForm.escalate} onChange={(e) => setCrForm({ ...crForm, escalate: e.target.checked })} />
              상담원 접수로 연결(응답 후 접수번호 발급·연락처 요청)
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={S.btn} onClick={submitCustomRule}>{crEditing ? '수정 저장' : '추가'}</button>
              {crEditing && (
                <button
                  style={S.btnGhost}
                  onClick={() => {
                    setCrEditing(null);
                    setCrForm(EMPTY_CR_FORM);
                  }}
                >
                  취소
                </button>
              )}
            </div>
          </section>
          {customRules.map((r) => (
            <section key={r.intent} style={S.card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <div>
                  <strong>{r.label}</strong>{' '}
                  <span style={S.tag}>({r.intent} · 커스텀{r.escalate ? ' · 상담원 연결' : ''})</span>
                  <div style={S.tag}>키워드: {r.keywords.join(', ')}</div>
                  <p style={{ fontSize: 14, color: 'var(--sub)', margin: '6px 0 0' }}>{r.reply}</p>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <button style={r.enabled ? S.btn : S.btnGhost} onClick={() => toggleCustomRule(r)}>
                    {r.enabled ? '활성' : '비활성'}
                  </button>
                  <button
                    style={S.btnGhost}
                    onClick={() => {
                      setCrEditing(r.intent);
                      setCrForm({ label: r.label, keywords: r.keywords.join(', '), reply: r.reply, escalate: r.escalate });
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                    }}
                  >
                    수정
                  </button>
                  <button style={{ ...S.btnGhost, color: '#a33' }} onClick={() => removeCustomRule(r.intent)}>
                    삭제
                  </button>
                </div>
              </div>
            </section>
          ))}
          <p style={{ ...S.tag, margin: '4px 0 12px' }}>아래 내장 룰은 패턴(정규식)을 코드에서 관리하며, 여기서는 활성화 여부와 응답문만 편집합니다.</p>
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

      {tab === 'audit' && (
        <>
          <section style={S.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <h2 style={{ fontSize: 16 }}>관리 작업 감사 로그</h2>
              <div style={{ display: 'flex', gap: 8 }}>
                <button style={S.btnGhost} onClick={loadAudit}>새로고침</button>
                <a
                  style={{ ...S.btnGhost, textDecoration: 'none' }}
                  href={`/api/admin/audit?format=csv${adminToken ? `&token=${encodeURIComponent(adminToken)}` : ''}`}
                >
                  CSV 다운로드
                </a>
              </div>
            </div>
            <p style={{ ...S.tag, marginTop: 8 }}>
              KB·룰 편집, 티켓 상태 변경, 백업 복원 이력(최근 500건)입니다. 서버 메모리에만 저장되며(재시작 시 초기화) 토큰 값은 기록하지 않습니다.
            </p>
          </section>
          {auditEvents.length === 0 && (
            <section style={S.card}>
              <p style={{ fontSize: 14, color: 'var(--sub)' }}>기록된 관리 작업이 없습니다. 지식베이스나 룰을 수정하면 이곳에 이력이 남아요.</p>
            </section>
          )}
          {auditEvents.map((e) => (
            <section key={e.id} style={{ ...S.card, padding: '12px 20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
                <div style={{ fontSize: 14 }}>
                  <strong>{AUDIT_ACTION_LABELS[e.action] || e.action}</strong>
                  {e.target && <span style={{ color: 'var(--sub)' }}> · {e.target}</span>}
                  {e.detail && <span style={{ color: 'var(--sub)' }}> — {e.detail}</span>}
                </div>
                <span style={S.tag}>
                  {new Date(e.at).toLocaleString()} · {e.authed ? '토큰 인증' : '미인증(토큰 미설정)'}
                </span>
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
