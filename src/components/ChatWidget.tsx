'use client';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';

interface Suggestion { id: string; question: string }
// 근거 인용 — 서버가 KB 원문에서 그대로 뽑은 문장(생성 요약 아님).
interface Citation { kbId: string; source: string; category: string; snippet: string }
// 접수 대기 상태 — 접수순 표시용(예상 대기시간을 계산하지 않는다).
interface QueueInfo { position: number; waiting: number }
// 상담원 전환 카드 상태 — 버튼 → 연락처 입력(form) → 접수 중(sending) → 접수 완료(done)/실패(error).
interface HandoffState {
  /** 어느 답변에서 시작했는지 — 카드를 그 답변 아래에 붙인다. */
  key: number;
  stage: 'form' | 'sending' | 'done' | 'error';
  contact: string;
  error: string;
  ticket?: { id: string; statusLabel: string; created: boolean };
  queue?: QueueInfo;
}

// 멀티턴 접수(예약·장애 신고) 진행 단계 — 서버가 알려주는 화면 상태값.
interface FormProgress { id: string; title: string; step: number; total: number; label: string; canSkip: boolean }
// 테넌트 CTA — 서버가 내려준 신청 버튼(라벨·URL). 링크는 http(s)만 서버에서 통과시킨다.
interface CTA { label: string; url: string; hint: string }
interface Msg {
  /** 렌더 키·피드백 대상 식별용(화면 안에서만 쓰는 일련번호). */
  key: number;
  role: 'bot' | 'user';
  text: string;
  /** 표시 시각(ms). 서버·클라이언트 시간대 차이로 인한 hydration 불일치를 피해 마운트 후에만 렌더한다. */
  at: number;
  escalate?: boolean;
  suggestions?: Suggestion[];
  ticketId?: string;
  citation?: Citation;
  queue?: QueueInfo;
  form?: FormProgress;
  cta?: CTA;
}

// 테넌트 공개 설정(서버 @/lib/tenants publicTenant()와 같은 모양).
export interface WidgetTenant {
  id: string;
  name: string;
  brandColor: string;
  badge: string;
  headerTitle: string;
  headerNote: string;
  greeting: string;
  aiNotice: string;
  cta: CTA;
  /** 대화 시작 전 보여줄 빠른 답장(등록된 FAQ 질문 문구). 서버가 실제 지식에서 채운다. */
  starters?: string[];
}

function isCTA(v: unknown): v is CTA {
  if (!v || typeof v !== 'object') return false;
  const c = v as Partial<CTA>;
  return typeof c.label === 'string' && typeof c.url === 'string' && /^https?:\/\//.test(c.url);
}

/** 테넌트 색을 위젯 CSS 변수로 바꾼다(6자리 hex만 허용, 아니면 기본 팔레트 유지). */
function brandVars(color?: string): CSSProperties {
  if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) return {};
  return { ['--brand' as string]: color, ['--brand-600' as string]: color, ['--brand-50' as string]: `${color}14` } as CSSProperties;
}

function isForm(v: unknown): v is FormProgress {
  if (!v || typeof v !== 'object') return false;
  const f = v as Partial<FormProgress>;
  return typeof f.title === 'string' && typeof f.label === 'string'
    && typeof f.step === 'number' && typeof f.total === 'number' && f.total > 0;
}

function isQueue(v: unknown): v is QueueInfo {
  if (!v || typeof v !== 'object') return false;
  const q = v as Partial<QueueInfo>;
  return typeof q.position === 'number' && typeof q.waiting === 'number';
}

function isCitation(v: unknown): v is Citation {
  if (!v || typeof v !== 'object') return false;
  const c = v as Partial<Citation>;
  return typeof c.source === 'string' && typeof c.snippet === 'string' && !!c.source && !!c.snippet;
}

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

// 이 폭 이하에서는 전체화면 시트로 전환한다(모바일 375px 기준).
const MOBILE_MAX = 480;

// 보조 동작 칩(빠른 답장·접수 진행 이전/건너뛰기/취소·평가) 공통 모양.
const chipStyle: CSSProperties = {
  fontSize: 12, fontWeight: 600, color: 'var(--brand-600)', background: '#fff',
  border: '1px solid var(--line)', borderRadius: 999, padding: '6px 11px', cursor: 'pointer',
  minHeight: 30,
};

// 헤더 우측 아이콘 버튼(최소화·닫기) 공통 모양.
const headerBtn: CSSProperties = {
  width: 28, height: 28, borderRadius: 8, color: '#fff', background: 'rgba(255,255,255,.16)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, lineHeight: 1,
  flexShrink: 0,
};

/** 초점을 가둘 수 있는 요소들(포커스 트랩용). */
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** 연락처 형식 검사 — 전화번호 또는 이메일. 서버도 길이를 다시 검증한다. */
export function validContact(v: string): boolean {
  const t = v.trim();
  if (t.length < 5 || t.length > 100) return false;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t)) return true;
  return /^[0-9][0-9\s()+-]{7,}$/.test(t) && t.replace(/\D/g, '').length >= 9;
}

/** 표시 시각 — 오전/오후 h:mm. 마운트 이후에만 호출한다. */
function clock(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

let msgSeq = 0;
function nextKey(): number { msgSeq += 1; return msgSeq; }

export default function ChatWidget({ embedded = false, tenant }: { embedded?: boolean; tenant?: WidgetTenant }) {
  const greeting = tenant?.greeting || '안녕하세요! 저는 인공지능(AI) 상담 챗봇입니다. 무엇을 도와드릴까요?';
  const [open, setOpen] = useState(!embedded);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([{ key: nextKey(), role: 'bot', text: greeting, at: 0 }]);
  // 답변 평가 상태 — 메시지 key → 보낸 평가('up'|'down') 또는 'error'(재시도 안내).
  const [rated, setRated] = useState<Record<number, 'up' | 'down' | 'error'>>({});
  // 상담원 전환 — 한 번에 한 건만 진행한다(중복 접수 방지).
  const [handoff, setHandoff] = useState<HandoffState | null>(null);
  const [sessionId] = useState(() => `web_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
  const lastUserRef = useRef('');
  const endRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);

  // 시각 표기는 마운트 이후에만 — 서버 렌더 결과와 어긋나지 않게 한다.
  useEffect(() => {
    setMounted(true);
    setMsgs((m) => m.map((x) => (x.at === 0 ? { ...x, at: Date.now() } : x)));
  }, []);

  // 전체화면 전환 판단.
  // - 일반 페이지: 실제 뷰포트 폭으로 판단한다.
  // - 임베드(iframe): iframe 폭은 위젯 크기라 뷰포트가 아니다 → 호스트(embed.js)가 알려준 폭을 쓴다.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (embedded) {
      const onHost = (ev: MessageEvent) => {
        const d = ev.data as { source?: string; type?: string; width?: number } | null;
        if (!d || d.source !== 'gowon-chat-host' || d.type !== 'viewport') return;
        if (typeof d.width === 'number') setMobile(d.width <= MOBILE_MAX);
      };
      window.addEventListener('message', onHost);
      return () => window.removeEventListener('message', onHost);
    }
    const mq = window.matchMedia(`(max-width: ${MOBILE_MAX}px)`);
    const sync = () => setMobile(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, [embedded]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs, busy, open]);

  // 열리면 입력창으로 초점을 옮긴다(키보드 사용자가 바로 입력할 수 있게).
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [open]);

  // 임베드 모드: 위젯이 그려졌음을 부모(embed.js)에 알린다 → 그때 iframe이 나타난다(첫 로드 깜빡임 제거).
  useEffect(() => {
    if (!embedded || typeof window === 'undefined' || window.parent === window) return;
    window.parent.postMessage({ source: 'gowon-chat', type: 'ready' }, '*');
  }, [embedded]);

  // 임베드 모드: 부모(embed.js)에 iframe 크기 변경 요청.
  useEffect(() => {
    if (!embedded || typeof window === 'undefined' || window.parent === window) return;
    const size = open ? EMBED_SIZE.open : EMBED_SIZE.closed;
    window.parent.postMessage(
      { source: 'gowon-chat', type: 'resize', open, width: size.w, height: size.h, fullscreen: open && mobile },
      '*',
    );
  }, [embedded, open, mobile]);

  const closePanel = useCallback((reset: boolean) => {
    setOpen(false);
    if (reset) {
      setMsgs([{ key: nextKey(), role: 'bot', text: greeting, at: Date.now() }]);
      setRated({});
      setHandoff(null);
      setInput('');
      lastUserRef.current = '';
    }
    setTimeout(() => launcherRef.current?.focus(), 0);
  }, [greeting]);

  // ESC로 닫고, Tab은 위젯 안에서 순환시킨다(뒤 페이지로 초점이 새지 않게).
  function onPanelKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closePanel(false);
      return;
    }
    if (e.key !== 'Tab') return;
    const nodes = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (!nodes || nodes.length === 0) return;
    const list = Array.from(nodes);
    const first = list[0];
    const last = list[list.length - 1];
    if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    }
  }

  function pushBot(patch: Omit<Msg, 'key' | 'role' | 'at'>) {
    setMsgs((m) => [...m, { key: nextKey(), role: 'bot', at: Date.now(), ...patch }]);
  }

  // 메시지 전송(입력창·빠른 답장 칩 공용)
  async function sendText(raw: string) {
    const text = raw.trim();
    if (!text || busy) return;
    setInput('');
    lastUserRef.current = text;
    setMsgs((m) => [...m, { key: nextKey(), role: 'user', text, at: Date.now() }]);
    setBusy(true);
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, sessionId, ...(tenant ? { tenant: tenant.id } : {}) }),
      });
      const data = await r.json();
      if (!r.ok || data?.ok === false || typeof data?.reply !== 'string') {
        pushBot({ text: errorText(data, r) });
        return;
      }
      pushBot({
        text: data.reply,
        escalate: data.escalate,
        suggestions: Array.isArray(data.suggestions) ? data.suggestions : undefined,
        ticketId: typeof data.ticketId === 'string' ? data.ticketId : undefined,
        citation: isCitation(data.citation) ? data.citation : undefined,
        queue: isQueue(data.queue) ? data.queue : undefined,
        form: isForm(data.form) ? data.form : undefined,
        cta: isCTA(data.cta) ? data.cta : undefined,
      });
    } catch {
      pushBot({ text: '연결이 원활하지 않아요. 잠시 후 다시 시도해 주세요.' });
    } finally {
      setBusy(false);
    }
  }

  function send() { sendText(input); }

  // 답변 평가(👍/👎) — 평가값과 근거 라벨만 보낸다(대화 본문은 보내지 않는다).
  async function rate(m: Msg, verdict: 'up' | 'down') {
    setRated((s) => ({ ...s, [m.key]: verdict }));
    try {
      const r = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, verdict, citation: m.citation?.source || '' }),
      });
      if (!r.ok) setRated((s) => ({ ...s, [m.key]: 'error' }));
    } catch {
      setRated((s) => ({ ...s, [m.key]: 'error' }));
    }
  }

  // ── 상담원 전환 ──
  // 버튼을 누르면 바로 접수하지 않고 연락처 입력 카드를 연다(회신 수단이 있어야 상담이 이어진다).
  function openHandoff(key: number) {
    setHandoff({ key, stage: 'form', contact: '', error: '' });
  }

  // 접수 요청. 연락처는 비워도 접수되지만, 그때는 대화창으로만 안내가 돌아간다.
  async function submitHandoff(contact: string) {
    if (!handoff || handoff.stage === 'sending') return;
    const trimmed = contact.trim();
    setHandoff({ ...handoff, contact, stage: 'sending', error: '' });
    try {
      const r = await fetch('/api/escalation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          reason: 'user_request',
          message: lastUserRef.current,
          ...(trimmed ? { contact: trimmed } : {}),
        }),
      });
      const d = await r.json();
      if (r.ok && d?.ok && d?.ticket?.id) {
        setHandoff({
          key: handoff.key,
          stage: 'done',
          contact,
          error: '',
          ticket: {
            id: String(d.ticket.id),
            statusLabel: typeof d.ticket.statusLabel === 'string' ? d.ticket.statusLabel : '',
            created: d.created !== false,
          },
          queue: isQueue(d.queue) ? d.queue : undefined,
        });
        return;
      }
      setHandoff({ ...handoff, contact, stage: 'error', error: errorText(d, r) });
    } catch {
      setHandoff({ ...handoff, contact, stage: 'error', error: '연결이 원활하지 않아요. 잠시 후 다시 시도해 주세요.' });
    }
  }

  const fullscreen = open && mobile;
  const starters = (tenant?.starters ?? []).slice(0, 4);
  const showStarters = starters.length > 0 && msgs.length === 1 && !busy;
  const title = tenant?.headerTitle || '고원 상담 챗봇';
  const avatarChar = tenant?.badge || '고';
  const lastKey = msgs[msgs.length - 1]?.key;

  const wrapStyle: CSSProperties = fullscreen
    ? { position: 'fixed', inset: 0, zIndex: 50, fontFamily: 'var(--font)', ...brandVars(tenant?.brandColor) }
    : { position: 'fixed', right: 22, bottom: 22, zIndex: 50, fontFamily: 'var(--font)', ...brandVars(tenant?.brandColor) };

  const panelStyle: CSSProperties = fullscreen
    ? { width: '100%', height: '100%', background: 'var(--surface)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }
    : {
        width: 380, height: 600, maxWidth: 'calc(100vw - 24px)', maxHeight: 'calc(100vh - 24px)',
        background: 'var(--surface)', border: '1px solid var(--line)',
        borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-pop)', display: 'flex',
        flexDirection: 'column', overflow: 'hidden', marginBottom: 12,
      };

  return (
    <div style={wrapStyle}>
      {open && (
        <div
          ref={panelRef}
          className="gw-panel"
          role="dialog"
          aria-modal={fullscreen ? true : undefined}
          aria-label={`${title} 대화창`}
          onKeyDown={onPanelKeyDown}
          style={panelStyle}
        >
          {/* ── 헤더: 아바타 · 이름 · AI 고지 배지 · 최소화/닫기 ── */}
          <header style={{ background: 'var(--brand)', color: '#fff', padding: '13px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              aria-hidden="true"
              style={{
                width: 36, height: 36, borderRadius: '50%', background: 'rgba(255,255,255,.18)',
                border: '1px solid rgba(255,255,255,.28)', display: 'flex', alignItems: 'center',
                justifyContent: 'center', fontWeight: 800, fontSize: 15, flexShrink: 0,
              }}
            >
              {avatarChar}
            </span>
            <div style={{ lineHeight: 1.25, minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 800, fontSize: 14.5, letterSpacing: '-.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 3 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 700, background: 'rgba(255,255,255,.2)', borderRadius: 999, padding: '2px 7px', flexShrink: 0 }}>
                  <span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: '50%', background: '#fff', display: 'inline-block' }} />
                  AI가 응대합니다
                </span>
                <span style={{ fontSize: 10.5, opacity: .88, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tenant?.headerNote || '24시간 상담'}</span>
              </div>
            </div>
            <button onClick={() => closePanel(false)} aria-label="대화 최소화 (대화 내용 유지)" title="최소화" style={headerBtn}>−</button>
            <button onClick={() => closePanel(true)} aria-label="대화 닫고 처음으로" title="닫기" style={headerBtn}>×</button>
          </header>

          {/* ── 대화 목록 ── */}
          <div
            role="log"
            aria-live="polite"
            aria-relevant="additions text"
            aria-label="대화 내용"
            style={{ flex: 1, overflowY: 'auto', padding: '16px 14px', background: 'var(--bg)', display: 'flex', flexDirection: 'column', gap: 12 }}
          >
            {msgs.map((m) => {
              const mine = m.role === 'user';
              return (
                <div key={m.key} className="gw-rise" style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexDirection: mine ? 'row-reverse' : 'row' }}>
                  {!mine && (
                    <span
                      aria-hidden="true"
                      style={{
                        width: 26, height: 26, borderRadius: '50%', background: 'var(--brand)', color: '#fff',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11.5,
                        fontWeight: 800, flexShrink: 0, marginBottom: 18,
                      }}
                    >
                      {avatarChar}
                    </span>
                  )}
                  <div style={{ maxWidth: '80%', minWidth: 0 }}>
                    <div
                      style={{
                        background: mine ? 'var(--brand)' : 'var(--surface)',
                        color: mine ? '#fff' : 'var(--ink)',
                        border: mine ? '1px solid transparent' : '1px solid var(--line)',
                        boxShadow: mine ? 'none' : 'var(--shadow-card)',
                        borderRadius: 14,
                        borderBottomRightRadius: mine ? 4 : 14,
                        borderBottomLeftRadius: mine ? 14 : 4,
                        padding: '10px 13px',
                        fontSize: 13.5,
                        lineHeight: 1.6,
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {m.text}
                    </div>
                    <div style={{ fontSize: 10.5, color: 'var(--mut)', marginTop: 4, textAlign: mine ? 'right' : 'left' }}>
                      {mounted && m.at ? clock(m.at) : ''}
                    </div>

                    {m.form && (
                      <div
                        role="status"
                        aria-live="polite"
                        aria-label={`${m.form.title} 진행 상황: 총 ${m.form.total}단계 중 ${m.form.step}단계, 현재 입력 항목 ${m.form.label}`}
                        style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 12, padding: '9px 11px' }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11.5, fontWeight: 700, color: 'var(--brand-600)' }}>
                          <span>{m.form.title}</span>
                          <span>{m.form.step}/{m.form.total} 단계</span>
                        </div>
                        <div aria-hidden="true" style={{ marginTop: 6, height: 4, borderRadius: 999, background: 'var(--brand-50)', overflow: 'hidden' }}>
                          <div style={{ width: `${Math.round((m.form.step / m.form.total) * 100)}%`, height: '100%', background: 'var(--brand)' }} />
                        </div>
                        {m.key === lastKey && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                            {m.form.step > 1 && (
                              <button onClick={() => sendText('이전')} disabled={busy} aria-label="이전 항목으로 돌아가기" style={chipStyle}>이전</button>
                            )}
                            {m.form.canSkip && (
                              <button onClick={() => sendText('건너뛰기')} disabled={busy} aria-label="이 항목 건너뛰기" style={chipStyle}>건너뛰기</button>
                            )}
                            <button onClick={() => sendText('취소')} disabled={busy} aria-label={`${m.form.title} 중단하기`} style={chipStyle}>취소</button>
                          </div>
                        )}
                      </div>
                    )}

                    {m.queue && (
                      <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--brand-600)', background: 'var(--brand-50)', borderRadius: 10, padding: '7px 11px', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span aria-hidden="true">⏳</span>
                        <span>상담 접수 대기 중 · 접수 순번 {m.queue.position}번 (대기 {m.queue.waiting}건)</span>
                      </div>
                    )}

                    {m.citation && (
                      <div style={{ fontSize: 11.5, lineHeight: 1.55, color: 'var(--sub)', background: 'var(--surface)', border: '1px solid var(--line)', borderLeft: '3px solid var(--brand)', borderRadius: 10, padding: '8px 10px' }}>
                        <div style={{ fontWeight: 700, color: 'var(--brand-600)', fontSize: 11 }}>근거 · {m.citation.source}</div>
                        <div style={{ marginTop: 3 }}>“{m.citation.snippet}”</div>
                      </div>
                    )}

                    {m.cta && (
                      <a
                        href={m.cta.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ display: 'inline-block', marginTop: 8, fontSize: 12.5, fontWeight: 700, color: '#fff', background: 'var(--brand)', borderRadius: 10, padding: '9px 14px', textDecoration: 'none' }}
                      >
                        {m.cta.label} ↗
                      </a>
                    )}

                    {m.suggestions && m.suggestions.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                        {m.suggestions.map((s) => (
                          <button key={s.id} onClick={() => sendText(s.question)} disabled={busy} style={chipStyle}>{s.question}</button>
                        ))}
                      </div>
                    )}

                    {/* ── 상담원 전환: 버튼 → 연락처 카드 → 접수 완료 ── */}
                    {m.escalate && !m.ticketId && handoff?.key !== m.key && (
                      handoff?.stage === 'done' && handoff.ticket ? (
                        <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--sub)' }}>
                          접수번호 {handoff.ticket.id}로 상담원 연결이 접수돼 있어요.
                        </div>
                      ) : (
                        <button
                          onClick={() => openHandoff(m.key)}
                          style={{ marginTop: 8, fontSize: 12.5, fontWeight: 700, color: '#fff', background: 'var(--brand)', borderRadius: 10, padding: '9px 14px' }}
                        >
                          상담원 연결하기
                        </button>
                      )
                    )}

                    {handoff?.key === m.key && (
                      <div
                        className="gw-rise"
                        role="group"
                        aria-label="상담원 연결 접수"
                        style={{
                          marginTop: 8, background: 'var(--surface)', border: '1px solid var(--line)',
                          borderLeft: '3px solid var(--brand)', borderRadius: 12, padding: '11px 12px',
                          boxShadow: 'var(--shadow-card)',
                        }}
                      >
                        {(handoff.stage === 'form' || handoff.stage === 'sending' || handoff.stage === 'error') && (
                          <>
                            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--brand-600)' }}>상담원 연결</div>
                            <p style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--sub)', marginTop: 4 }}>
                              연락 받으실 곳을 남겨 주세요. 지금까지 나눈 대화가 상담원에게 함께 전달됩니다.
                            </p>
                            <label htmlFor="gw-handoff-contact" style={{ display: 'block', fontSize: 11.5, fontWeight: 700, color: 'var(--ink)', margin: '9px 0 5px' }}>
                              연락처 (전화번호 또는 이메일)
                            </label>
                            <input
                              id="gw-handoff-contact"
                              value={handoff.contact}
                              onChange={(e) => setHandoff({ ...handoff, contact: e.target.value, error: '' })}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.nativeEvent.isComposing && validContact(handoff.contact)) submitHandoff(handoff.contact);
                              }}
                              disabled={handoff.stage === 'sending'}
                              inputMode="text"
                              autoComplete="off"
                              aria-describedby="gw-handoff-hint"
                              placeholder="010-0000-0000 또는 name@example.com"
                              style={{
                                width: '100%', border: '1px solid var(--line-2)', borderRadius: 10,
                                padding: '9px 11px', fontSize: 13, color: 'var(--ink)', background: 'var(--bg)', outline: 'none',
                              }}
                            />
                            <p id="gw-handoff-hint" style={{ fontSize: 10.5, lineHeight: 1.5, color: 'var(--mut)', marginTop: 5 }}>
                              회신 목적으로만 사용하고, 상담이 끝나면 파기합니다.
                            </p>
                            {handoff.stage === 'error' && (
                              <p role="alert" style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: 6 }}>{handoff.error}</p>
                            )}
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 9 }}>
                              <button
                                onClick={() => submitHandoff(handoff.contact)}
                                disabled={handoff.stage === 'sending' || !validContact(handoff.contact)}
                                aria-busy={handoff.stage === 'sending'}
                                style={{
                                  fontSize: 12.5, fontWeight: 700, color: '#fff', background: 'var(--brand)',
                                  borderRadius: 10, padding: '9px 14px', minHeight: 36,
                                  opacity: handoff.stage === 'sending' || !validContact(handoff.contact) ? 0.5 : 1,
                                }}
                              >
                                {handoff.stage === 'sending' ? '접수 중…' : handoff.stage === 'error' ? '다시 시도' : '접수하기'}
                              </button>
                              <button
                                onClick={() => submitHandoff('')}
                                disabled={handoff.stage === 'sending'}
                                style={chipStyle}
                              >
                                연락처 없이 접수
                              </button>
                              <button
                                onClick={() => setHandoff(null)}
                                disabled={handoff.stage === 'sending'}
                                style={{ ...chipStyle, color: 'var(--mut)' }}
                              >
                                취소
                              </button>
                            </div>
                          </>
                        )}

                        {handoff.stage === 'done' && handoff.ticket && (
                          <div role="status" aria-live="polite">
                            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--brand-600)' }}>
                              <span aria-hidden="true">✓ </span>
                              {handoff.ticket.created ? '상담원 연결이 접수됐어요' : '이미 접수된 요청이 있어요'}
                            </div>
                            <div style={{ fontSize: 12.5, color: 'var(--ink)', marginTop: 6 }}>
                              접수번호 <strong>{handoff.ticket.id}</strong>
                              {handoff.ticket.statusLabel ? ` · ${handoff.ticket.statusLabel}` : ''}
                            </div>
                            {handoff.queue && (
                              <div style={{ fontSize: 11.5, color: 'var(--sub)', marginTop: 4 }}>
                                접수 순번 {handoff.queue.position}번 (대기 {handoff.queue.waiting}건)
                              </div>
                            )}
                            <p style={{ fontSize: 11.5, lineHeight: 1.55, color: 'var(--sub)', marginTop: 7 }}>
                              {handoff.contact.trim()
                                ? '남겨주신 연락처로 상담원이 확인 후 연락드립니다.'
                                : '연락처를 남기지 않으셔서, 이 대화창으로 안내드립니다.'}
                              {' '}추가로 궁금한 점은 계속 물어보셔도 괜찮아요.
                            </p>
                          </div>
                        )}
                      </div>
                    )}

                    {/* 답변 평가 — 근거가 붙은 답변에만 묻는다(인사·오류 안내에는 묻지 않는다). */}
                    {!mine && m.citation && (
                      <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, fontSize: 11.5, color: 'var(--mut)' }}>
                        {rated[m.key] === undefined && (
                          <>
                            <span>도움이 됐나요?</span>
                            <button onClick={() => rate(m, 'up')} aria-label="이 답변이 도움이 됐어요" style={{ ...chipStyle, padding: '4px 9px', minHeight: 26 }}>👍</button>
                            <button onClick={() => rate(m, 'down')} aria-label="이 답변이 도움이 되지 않았어요" style={{ ...chipStyle, padding: '4px 9px', minHeight: 26 }}>👎</button>
                          </>
                        )}
                        {rated[m.key] === 'up' && <span role="status">의견 감사합니다.</span>}
                        {rated[m.key] === 'down' && <span role="status">알려주셔서 감사합니다. 안내 자료를 보완할게요.</span>}
                        {rated[m.key] === 'error' && (
                          <>
                            <span role="status" style={{ color: 'var(--danger)' }}>평가를 보내지 못했어요.</span>
                            <button onClick={() => rate(m, 'up')} aria-label="평가 다시 보내기" style={{ ...chipStyle, padding: '4px 9px', minHeight: 26 }}>다시 시도</button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {/* 타이핑 인디케이터 — 답변을 만드는 동안 멈춘 것처럼 보이지 않게 한다. */}
            {busy && (
              <div className="gw-rise" style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                <span aria-hidden="true" style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--brand)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11.5, fontWeight: 800, flexShrink: 0 }}>
                  {avatarChar}
                </span>
                <div
                  role="status"
                  aria-label="답변을 작성하고 있습니다"
                  style={{ background: 'var(--surface)', border: '1px solid var(--line)', boxShadow: 'var(--shadow-card)', borderRadius: 14, borderBottomLeftRadius: 4, padding: '12px 14px', display: 'flex', gap: 4, alignItems: 'center' }}
                >
                  <span className="gw-dot" /><span className="gw-dot" /><span className="gw-dot" />
                </div>
              </div>
            )}
            <div ref={endRef} />
          </div>

          {/* ── 빠른 답장(등록된 FAQ 질문 그대로) ── */}
          {showStarters && (
            <div style={{ padding: '10px 14px 0', background: 'var(--surface)', borderTop: '1px solid var(--line)' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--mut)', marginBottom: 7 }}>이런 걸 물어보실 수 있어요</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {starters.map((q) => (
                  <button key={q} onClick={() => sendText(q)} disabled={busy} style={chipStyle}>{q}</button>
                ))}
              </div>
            </div>
          )}

          {/* ── 입력 ── */}
          <div style={{ display: 'flex', gap: 8, padding: '12px 14px 8px', background: 'var(--surface)', borderTop: showStarters ? 'none' : '1px solid var(--line)' }}>
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) send(); }}
              placeholder="메시지를 입력하세요"
              aria-label="메시지 입력"
              style={{ flex: 1, minWidth: 0, border: '1px solid var(--line-2)', borderRadius: 999, padding: '11px 15px', fontSize: 13.5, color: 'var(--ink)', background: 'var(--bg)', outline: 'none' }}
            />
            <button
              onClick={send}
              disabled={busy || !input.trim()}
              aria-label="메시지 전송"
              style={{ width: 42, height: 42, flexShrink: 0, borderRadius: '50%', background: 'var(--brand)', color: '#fff', fontWeight: 800, fontSize: 16, opacity: busy || !input.trim() ? .5 : 1 }}
            >
              ↑
            </button>
          </div>
          <div style={{ padding: '0 14px 10px', background: 'var(--surface)', fontSize: 10.5, lineHeight: 1.45, color: 'var(--mut)', textAlign: 'center' }}>
            {tenant?.aiNotice || 'AI 자동응답 · 정확한 확인이 필요하면 상담원을 연결해 주세요'}
          </div>
        </div>
      )}

      {/* 전체화면일 때는 헤더의 닫기 버튼이 그 역할을 하므로 런처를 감춘다. */}
      {!fullscreen && (
        <button
          ref={launcherRef}
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? `${title} 최소화` : `${title} 열기`}
          aria-expanded={open}
          style={{
            width: 58, height: 58, borderRadius: '50%', background: 'var(--brand)', color: '#fff',
            fontSize: 23, boxShadow: 'var(--shadow-pop)', marginLeft: 'auto', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
          }}
        >
          <span aria-hidden="true">{open ? '×' : '💬'}</span>
        </button>
      )}
    </div>
  );
}
