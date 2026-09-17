'use client';

// 관리 콘솔(MVP): 지식베이스(FAQ) CRUD · 시나리오 룰 편집 · 응답 테스트.
// 저장은 인메모리 스텁 — [승인 필요] DB 영구 저장·관리자 인증(현재 ADMIN_TOKEN 미설정 시 개방).
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

interface KBEntryView {
  id: string;
  category: string;
  question: string;
  keywords: string[];
  answer: string;
  source?: string;
}

/** 문서 업로드 미리보기 항목(등록 전 후보). */
interface KBCandidateView extends KBEntryView {
  chunkIndex: number;
}

interface ImportForm {
  title: string;
  category: string;
  maxChars: string;
  text: string;
}

const EMPTY_IMPORT: ImportForm = { title: '', category: '문서', maxChars: '500', text: '' };

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

const HANDOFF_REASON_LABELS: Record<string, string> = {
  low_confidence: '인식 신뢰도 부족',
  customer_request: '고객 요청',
  policy: '정책상 상담원 처리',
  error: '시스템 오류',
  max_retry: '재시도 한도 초과',
};

interface TicketView {
  id: string;
  sessionId: string;
  reason: string;
  reasonCode?: string;
  summary?: string;
  message: string;
  contact?: string;
  status: 'open' | 'in_progress' | 'resolved' | 'canceled';
  note?: string;
  createdAt: string;
  updatedAt: string;
}

interface OpsStats {
  escalation: {
    total: number;
    open: number;
    inProgress: number;
    resolved: number;
    canceled: number;
    byReason?: Record<string, number>;
  };
  conversation: {
    totalTurns: number;
    sessions: number;
    bySource: Record<string, number>;
    byChannel: Record<string, number>;
    topIntents: { intent: string; count: number }[];
    autoHandled: number;
    autoRate: number;
    escalatedTurns: number;
    /** 최근 7일 일자별 집계(서버 @/lib/convlog convStats()와 같은 모양). 구버전 응답 대비 optional. */
    daily?: { date: string; turns: number; escalated: number }[];
    today?: { turns: number; sessions: number; escalated: number };
    /** 평균 서버 처리 시간(ms). 기록된 턴이 없으면 null. 구버전 응답 대비 optional. */
    avgLatencyMs?: number | null;
    latencySamples?: number;
  };
}

/** 처리 시간을 사람이 읽는 단위로 — 1초 미만은 ms, 그 이상은 소수 1자리 초. */
function latencyLabel(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}초`;
}

/** 값이 아직 없는 지표는 0을 지어내지 않고 「측정 중」으로 표시한다(§13). */
const MEASURING = '측정 중';

/** 대화 식별자는 화면에 전부 보여주지 않는다(개인 추적 방지) — 앞 6자만. */
function shortSession(id: string): string {
  return id.length > 6 ? `${id.slice(0, 6)}…` : id;
}

/** 접수번호는 앞 8자만 보여준다(전체는 서랍 제목의 title 로). */
function shortTicket(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/** 연락처는 기본 마스킹 — 전화는 가운데, 이메일은 아이디 뒷부분을 가린다. 원문은 운영자가 「보기」를 눌렀을 때만. */
function maskContact(raw: string): string {
  const v = raw.trim();
  if (v.includes('@')) {
    const [id, domain] = v.split('@');
    return `${id.slice(0, 2)}${'*'.repeat(Math.max(1, id.length - 2))}@${domain}`;
  }
  const digits = v.replace(/\D/g, '');
  if (digits.length >= 7) return `${digits.slice(0, 3)}-****-${digits.slice(-4)}`;
  return v.length > 2 ? `${v.slice(0, 2)}${'*'.repeat(v.length - 2)}` : '**';
}

/** 처리 상태 pill 색 — 토큰만 쓴다(성공/경고/기본). */
const TICKET_STATUS_TONE: Record<TicketView['status'], { background: string; color: string }> = {
  open: { background: '#FFFBEB', color: 'var(--warn)' },
  in_progress: { background: 'var(--brand-50)', color: 'var(--brand-600)' },
  resolved: { background: '#F0FDF4', color: 'var(--success)' },
  canceled: { background: 'var(--bg)', color: 'var(--mut)' },
};

function timeLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** 빈 상태 일러스트 — 장식이므로 스크린리더에서는 숨긴다. 색은 토큰만 쓴다. */
function EmptyArt({ kind }: { kind: 'kb' | 'chat' }) {
  return (
    <svg aria-hidden="true" focusable="false" width="120" height="84" viewBox="0 0 120 84" fill="none" style={{ display: 'block', margin: '0 auto 12px' }}>
      <rect x="14" y="14" width="92" height="58" rx="12" fill="var(--brand-50)" />
      {kind === 'kb' ? (
        <>
          <rect x="30" y="30" width="60" height="6" rx="3" fill="var(--brand)" opacity=".55" />
          <rect x="30" y="42" width="44" height="6" rx="3" fill="var(--brand)" opacity=".35" />
          <rect x="30" y="54" width="52" height="6" rx="3" fill="var(--brand)" opacity=".25" />
        </>
      ) : (
        <>
          <rect x="28" y="28" width="40" height="12" rx="6" fill="var(--surface)" stroke="var(--line-2)" />
          <rect x="52" y="46" width="40" height="12" rx="6" fill="var(--brand)" opacity=".55" />
        </>
      )}
    </svg>
  );
}

/** 확인 대화상자에 넘길 내용. `resolve` 는 버튼을 누르면 호출된다. */
type ConfirmReq = {
  title: string;
  body: string;
  /** 지우는 대상 이름 등, 무엇에 대한 동작인지 한 줄로. 없으면 생략한다. */
  target?: string;
  confirmLabel: string;
  resolve: (ok: boolean) => void;
};

/**
 * 확인 대화상자 — 되돌릴 수 없는 동작(삭제·초기화) 앞에 세운다.
 * 브라우저 기본 `confirm()` 을 대신한다: 기본 대화상자는 브랜드를 따르지 않고 주소가 함께 노출돼
 * 「같은 회사 제품」으로 보이지 않으며, 무엇을 지우는지 강조할 수단도 없다(DS 5-4).
 * 기본 초점은 취소에 둔다 — Enter 를 눌러 실수로 지우지 않게.
 */
function ConfirmDialog({ req }: { req: ConfirmReq }) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => { cancelRef.current?.focus(); }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.stopPropagation(); req.resolve(false); return; }
    if (e.key !== 'Tab' || !panelRef.current) return;
    const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>('button')).filter((el) => !el.hasAttribute('disabled'));
    if (items.length === 0) return;
    const firstEl = items[0];
    const lastEl = items[items.length - 1];
    if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
  };

  return (
    <div className="ac-modal-root">
      <div className="ac-modal-bg" onClick={() => req.resolve(false)} aria-hidden="true" />
      <div
        ref={panelRef}
        className="ac-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="ac-confirm-title"
        aria-describedby="ac-confirm-body"
        onKeyDown={onKeyDown}
      >
        <div className="ac-modal-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" focusable="false">
            <path d="M8 5.2v3.4M8 11.1h.01M6.9 2.4 1.9 11a1.3 1.3 0 0 0 1.1 1.9h10a1.3 1.3 0 0 0 1.1-1.9L9.1 2.4a1.3 1.3 0 0 0-2.2 0z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h2 id="ac-confirm-title" style={{ fontSize: 16, fontWeight: 800, letterSpacing: '-.01em' }}>{req.title}</h2>
        {req.target && (
          <p style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)', marginTop: 8, background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', padding: '8px 10px', wordBreak: 'break-all' }}>
            {req.target}
          </p>
        )}
        <p id="ac-confirm-body" style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--sub)', marginTop: 8 }}>{req.body}</p>
        <div className="ac-modal-foot">
          <button ref={cancelRef} type="button" style={{ ...S.btnGhost, background: 'var(--bg)', color: 'var(--sub)', minHeight: 40 }} onClick={() => req.resolve(false)}>
            취소
          </button>
          <button type="button" style={{ ...S.btn, background: 'var(--danger)', minHeight: 40 }} onClick={() => req.resolve(true)}>
            {req.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 최근 대화 상세 서랍 — 같은 대화(세션)의 흐름 전체·주제·근거·상담원 전환 여부를 보여준다. */
function ConversationDrawer({
  sessionId, turns, ticket, onClose, onOpenTicket, closeRef,
}: {
  sessionId: string;
  turns: TurnView[];
  ticket: TicketView | undefined;
  onClose: () => void;
  onOpenTicket: () => void;
  closeRef: RefObject<HTMLButtonElement>;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const escalated = turns.some((t) => t.escalate);
  const channel = turns[0]?.channel ?? '';
  const first = turns[0]?.at;
  const last = turns[turns.length - 1]?.at;

  // 초점 순환(Tab/Shift+Tab 이 서랍 밖으로 나가지 않는다). ESC 는 부모가 처리한다.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !panelRef.current) return;
    const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>('button,[href],input,textarea,select,[tabindex]:not([tabindex="-1"])'))
      .filter((el) => !el.hasAttribute('disabled'));
    if (items.length === 0) return;
    const firstEl = items[0];
    const lastEl = items[items.length - 1];
    if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
  };

  return (
    <div className="ac-drawer-root">
      <div className="ac-drawer-bg" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className="ac-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ac-drawer-title"
        onKeyDown={onKeyDown}
      >
        <div className="ac-drawer-head">
          <div style={{ minWidth: 0 }}>
            <h2 id="ac-drawer-title" style={{ fontSize: 16, fontWeight: 800, letterSpacing: '-.01em' }}>대화 상세</h2>
            <p style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
              대화 {shortSession(sessionId)} · {CHANNEL_LABELS[channel] || channel || '채널 미상'}
              {first && last ? ` · ${timeLabel(first)}${first !== last ? ` ~ ${timeLabel(last)}` : ''}` : ''}
            </p>
          </div>
          <button ref={closeRef} type="button" className="ac-iconbtn" onClick={onClose} aria-label="상세 닫기">
            <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
        </div>

        <div className="ac-drawer-meta">
          <span className="ac-pill">주고받은 메시지 {turns.length}쌍</span>
          <span className="ac-pill" style={escalated ? { background: '#FFFBEB', color: 'var(--warn)' } : { background: '#F0FDF4', color: 'var(--success)' }}>
            {escalated ? '상담원 제안됨' : '자동 응대로 완료'}
          </span>
          {ticket && <span className="ac-pill">접수 {TICKET_STATUS_LABELS[ticket.status]}</span>}
        </div>

        <div className="ac-drawer-body" role="log" aria-label="대화 내용">
          {turns.map((t) => (
            <div key={t.id} className="ac-turn">
              <div className="ac-bubble ac-bubble-user">
                <span className="ac-bubble-who">고객</span>
                <p>{t.message}</p>
              </div>
              <div className="ac-bubble ac-bubble-bot">
                <span className="ac-bubble-who">챗봇</span>
                <p>{t.reply}</p>
                <div className="ac-bubble-tags">
                  <span className="ac-pill">{INTENT_LABELS[t.intent] || t.intent}</span>
                  <span className="ac-pill">{SOURCE_VIEW_LABELS[t.source] || t.source}</span>
                  {t.escalate && <span className="ac-pill" style={{ background: '#FFFBEB', color: 'var(--warn)' }}>상담원 제안</span>}
                  <span style={{ fontSize: 11, color: 'var(--mut)', marginLeft: 'auto' }}>{timeLabel(t.at)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="ac-drawer-foot">
          {ticket ? (
            <button type="button" style={S.btn} onClick={onOpenTicket}>상담원 요청 보기</button>
          ) : (
            <span style={{ fontSize: 12.5, color: 'var(--mut)' }}>이 대화에서 접수된 상담원 요청은 없습니다.</span>
          )}
          <button type="button" style={{ ...S.btnGhost, marginLeft: 'auto' }} onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>
  );
}

/** 상담원 요청 상세 서랍 — 고객의 마지막 말·사유·이관 요약·연락처(마스킹)·처리 상태 변경. */
function TicketDrawer({
  ticket, hasConversation, busy, onClose, onStatus, onOpenConversation, closeRef,
}: {
  ticket: TicketView;
  hasConversation: boolean;
  busy: boolean;
  onClose: () => void;
  onStatus: (status: TicketView['status']) => void;
  onOpenConversation: () => void;
  closeRef: RefObject<HTMLButtonElement>;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [showContact, setShowContact] = useState(false);
  const t = ticket;
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !panelRef.current) return;
    const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>('button,[href],input,textarea,select,[tabindex]:not([tabindex="-1"])'))
      .filter((el) => !el.hasAttribute('disabled'));
    if (items.length === 0) return;
    const firstEl = items[0];
    const lastEl = items[items.length - 1];
    if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
  };
  const reasonLabel = t.reasonCode ? (HANDOFF_REASON_LABELS[t.reasonCode] ?? t.reasonCode) : t.reason;

  return (
    <div className="ac-drawer-root">
      <div className="ac-drawer-bg" onClick={onClose} aria-hidden="true" />
      <div ref={panelRef} className="ac-drawer" role="dialog" aria-modal="true" aria-labelledby="ac-ticket-title" onKeyDown={onKeyDown}>
        <div className="ac-drawer-head">
          <div style={{ minWidth: 0 }}>
            <h2 id="ac-ticket-title" style={{ fontSize: 16, fontWeight: 800, letterSpacing: '-.01em' }}>
              상담원 요청 <span title={t.id} style={{ fontWeight: 600, color: 'var(--sub)' }}>{shortTicket(t.id)}</span>
            </h2>
            <p style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
              접수 {timeLabel(t.createdAt)} · 마지막 변경 {timeLabel(t.updatedAt)} · 대화 {shortSession(t.sessionId)}
            </p>
          </div>
          <button ref={closeRef} type="button" className="ac-iconbtn" onClick={onClose} aria-label="상세 닫기">
            <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
        </div>

        <div className="ac-drawer-meta">
          <span className="ac-pill" style={TICKET_STATUS_TONE[t.status]}>{TICKET_STATUS_LABELS[t.status]}</span>
          <span className="ac-pill">사유 · {reasonLabel}</span>
          {t.contact ? <span className="ac-pill">연락처 남김</span> : <span className="ac-pill" style={{ background: 'var(--bg)', color: 'var(--mut)' }}>연락처 없음</span>}
        </div>

        <div className="ac-drawer-body">
          <span className="ac-rulekey">고객이 마지막으로 한 말</span>
          {t.message ? (
            <div className="ac-bubble ac-bubble-user" style={{ marginBottom: 16 }}>
              <span className="ac-bubble-who">고객</span>
              <p>{t.message}</p>
            </div>
          ) : (
            <p style={{ fontSize: 13, color: 'var(--mut)', marginBottom: 16 }}>남긴 메시지가 없습니다.</p>
          )}

          <span className="ac-rulekey">연락처</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            {t.contact ? (
              <>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>
                  {showContact ? t.contact : maskContact(t.contact)}
                </span>
                <button type="button" className="ac-linkbtn" aria-pressed={showContact} onClick={() => setShowContact((v) => !v)}>
                  {showContact ? '가리기' : '보기'}
                </button>
                <span style={{ fontSize: 11.5, color: 'var(--mut)', flexBasis: '100%' }}>연락 목적으로만 쓰고 다른 곳에 옮겨 적지 마세요.</span>
              </>
            ) : (
              <span style={{ fontSize: 13, color: 'var(--mut)' }}>고객이 연락처 없이 접수했습니다. 대화 기록으로 맥락을 확인하세요.</span>
            )}
          </div>

          <span className="ac-rulekey">이관 요약</span>
          {t.summary ? (
            <div className="ac-summary">{t.summary}</div>
          ) : (
            <p style={{ fontSize: 13, color: 'var(--mut)' }}>요약이 만들어지지 않았습니다.</p>
          )}
          {t.note && (
            <>
              <span className="ac-rulekey" style={{ marginTop: 16 }}>메모</span>
              <p style={{ fontSize: 13.5, color: 'var(--ink)', whiteSpace: 'pre-wrap' }}>{t.note}</p>
            </>
          )}
        </div>

        <div className="ac-drawer-foot" style={{ flexWrap: 'wrap' }}>
          {t.status === 'open' && (
            <button type="button" style={S.btn} disabled={busy} aria-busy={busy} onClick={() => onStatus('in_progress')}>상담 시작</button>
          )}
          {t.status === 'in_progress' && (
            <button type="button" style={S.btn} disabled={busy} aria-busy={busy} onClick={() => onStatus('resolved')}>완료 처리</button>
          )}
          {(t.status === 'open' || t.status === 'in_progress') && (
            <button type="button" className="ac-linkbtn" data-tone="danger" disabled={busy} onClick={() => onStatus('canceled')}>취소</button>
          )}
          {(t.status === 'resolved' || t.status === 'canceled') && (
            <button type="button" style={S.btnGhost} disabled={busy} aria-busy={busy} onClick={() => onStatus('open')}>다시 열기</button>
          )}
          {hasConversation && (
            <button type="button" className="ac-linkbtn" onClick={onOpenConversation}>대화 전체 보기</button>
          )}
          <button type="button" style={{ ...S.btnGhost, marginLeft: 'auto' }} onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>
  );
}

/** 고객사 상세 서랍 — 계약 정보와 귀속 이력(누가 언제 어떤 근거로 바꿨는지)을 시간순으로 보여준다. */
function AccountDrawer({
  account, partnerName, canWrite, onClose, onEdit, closeRef,
}: {
  account: AccountView;
  partnerName: (id: string | null) => string;
  canWrite: boolean;
  onClose: () => void;
  onEdit: () => void;
  closeRef: RefObject<HTMLButtonElement>;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const a = account;
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !panelRef.current) return;
    const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>('button,[href],input,textarea,select,[tabindex]:not([tabindex="-1"])'))
      .filter((el) => !el.hasAttribute('disabled'));
    if (items.length === 0) return;
    const firstEl = items[0];
    const lastEl = items[items.length - 1];
    if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
  };
  const history = a.attribution.slice().sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime());

  return (
    <div className="ac-drawer-root">
      <div className="ac-drawer-bg" onClick={onClose} aria-hidden="true" />
      <div ref={panelRef} className="ac-drawer" role="dialog" aria-modal="true" aria-labelledby="ac-account-title" onKeyDown={onKeyDown}>
        <div className="ac-drawer-head">
          <div style={{ minWidth: 0 }}>
            <h2 id="ac-account-title" style={{ fontSize: 16, fontWeight: 800, letterSpacing: '-.01em' }}>{a.name}</h2>
            <p style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
              {a.partnerId ? `${partnerName(a.partnerId)} 귀속` : '직접 계약'} · {SOURCE_LABELS[a.source] ?? '미확인'}
            </p>
          </div>
          <button ref={closeRef} type="button" className="ac-iconbtn" onClick={onClose} aria-label="상세 닫기">
            <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
        </div>

        <div className="ac-drawer-meta">
          <span className="ac-pill" style={ACCOUNT_STATUS_TONE[a.status]}>{ACCOUNT_STATUS_LABELS[a.status]}</span>
          <span className="ac-pill">{a.contractedAt ? `계약일 ${a.contractedAt}` : '계약일 없음'}</span>
          <span className="ac-pill" style={typeof a.monthlyFeeKrw === 'number' ? undefined : { background: 'var(--bg)', color: 'var(--mut)' }}>
            월 {wonLabel(a.monthlyFeeKrw)}
          </span>
        </div>

        <div className="ac-drawer-body">
          <span className="ac-rulekey">계약 정보</span>
          <dl className="ac-dl" style={{ gridTemplateColumns: '84px minmax(0,1fr)', marginBottom: 18 }}>
            <dt>귀속</dt><dd>{partnerName(a.partnerId)}</dd>
            <dt>유입 경로</dt><dd>{SOURCE_LABELS[a.source] ?? '미확인'}</dd>
            <dt>고원 담당</dt><dd>{a.ownerName || <span style={{ color: 'var(--mut)' }}>미지정</span>}</dd>
            <dt>월 이용료</dt><dd>{wonLabel(a.monthlyFeeKrw)}{typeof a.monthlyFeeKrw !== 'number' && <span style={{ color: 'var(--mut)' }}> — 정산 합계에서 제외됩니다</span>}</dd>
            {a.memo && <><dt>메모</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{a.memo}</dd></>}
          </dl>

          <span className="ac-rulekey">귀속 이력 {history.length}건</span>
          {history.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--mut)' }}>아직 기록된 이력이 없습니다. 귀속을 바꾸면 여기에 근거와 함께 남습니다.</p>
          ) : (
            <ol className="ac-timeline">
              {history.map((h, idx) => (
                <li key={idx} className="ac-tl-item">
                  <span className="ac-tl-dot" aria-hidden="true" />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, color: 'var(--mut)', fontVariantNumeric: 'tabular-nums' }}>{h.at.slice(0, 10)}</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>
                        {partnerName(h.fromPartnerId)} <span aria-hidden="true" style={{ color: 'var(--mut)' }}>→</span><span className="ac-srhide">에서</span> {partnerName(h.toPartnerId)}
                      </span>
                      <span className="ac-pill" style={{ background: 'var(--bg)', color: 'var(--sub)' }}>{SOURCE_LABELS[h.source] ?? '미확인'}</span>
                      {h.authed && <span className="ac-pill" style={{ background: '#F0FDF4', color: 'var(--success)' }}>인증됨</span>}
                    </div>
                    {h.note && <p style={{ fontSize: 12.5, color: 'var(--sub)', marginTop: 3, whiteSpace: 'pre-wrap' }}>{h.note}</p>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="ac-drawer-foot">
          {canWrite && <button type="button" style={S.btn} onClick={onEdit}>수정</button>}
          <button type="button" style={{ ...S.btnGhost, marginLeft: 'auto' }} onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>
  );
}

function KpiCard({ label, value, note, empty, loading }: { label: string; value: string; note: string; empty?: boolean; loading?: boolean }) {
  return (
    <div className="ac-kpicard">
      <div className="ac-kpilabel">{label}</div>
      {loading ? (
        // 불러오는 동안은 값을 단정하지 않는다 — 「측정 중」은 데이터가 없을 때만 쓴다.
        <div className="ac-kpivalue" aria-hidden="true"><Skeleton w="46%" h={26} style={{ marginTop: 6 }} /></div>
      ) : (
        <div className="ac-kpivalue" data-empty={empty ? 'true' : undefined}>{value}</div>
      )}
      <div className="ac-kpinote">{note}</div>
    </div>
  );
}

/** 자리 표시 막대 — 장식이므로 스크린리더에서 숨긴다(문장은 SkeletonRows 가 하나만 읽힌다). */
function Skeleton({ w = '100%', h = 12, style }: { w?: number | string; h?: number; style?: React.CSSProperties }) {
  return <span className="ac-skel" aria-hidden="true" style={{ width: w, height: h, ...style }} />;
}

/** 표·목록이 오기 전의 자리 표시 — 빈 상태 문구를 먼저 보이지 않게 한다(불러오는 중 ≠ 0건). */
function SkeletonRows({ rows = 4, label }: { rows?: number; label: string }) {
  const widths = ['52%', '38%', '46%', '34%', '42%', '30%'];
  return (
    <div className="ac-skelrows" role="status" aria-live="polite" aria-busy="true">
      <span className="ac-srhide">{label}</span>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="ac-skelrow">
          <Skeleton w={widths[i % widths.length]} h={13} />
          <Skeleton w="16%" h={11} />
          <Skeleton w="12%" h={11} />
        </div>
      ))}
    </div>
  );
}

type LoadPhase = 'loading' | 'done' | 'error';

/** 목록 자리: 불러오는 중이면 스켈레톤, 실패면 이유 + 「다시 시도」. done 이면 아무것도 그리지 않는다. */
function LoadState({ phase, busy, fail, onRetry, rows = 4 }: { phase: LoadPhase; busy: string; fail: string; onRetry: () => void; rows?: number }) {
  if (phase === 'error') {
    return (
      <div className="ac-empty" role="alert">
        <p style={{ fontSize: 14, fontWeight: 700 }}>{fail}</p>
        <p style={{ fontSize: 13, color: 'var(--mut)', marginTop: 4 }}>네트워크 상태를 확인한 뒤 다시 시도해 주세요. 계속 반복되면 로그인 상태를 확인해 주세요.</p>
        <button type="button" style={{ ...S.btnGhost, marginTop: 12 }} onClick={onRetry}>다시 시도</button>
      </div>
    );
  }
  return <SkeletonRows rows={rows} label={busy} />;
}

/** 최근 7일 대화량 막대 차트 — 실제 로그에서만 그린다. 기록이 없으면 차트를 만들지 않는다. */
function TrendChart({ daily }: { daily: { date: string; turns: number; escalated: number }[] }) {
  const max = daily.reduce((m, d) => Math.max(m, d.turns), 0);
  const label = daily.map((d) => `${d.date.slice(5).replace('-', '월 ')}일 ${d.turns}건`).join(', ');
  const W = 560;
  const H = 132;
  const pad = { l: 4, r: 4, t: 10, b: 22 };
  const slot = (W - pad.l - pad.r) / daily.length;
  const barW = Math.min(38, slot * 0.52);
  return (
    <figure style={{ margin: 0 }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-label={`최근 7일 일자별 대화 건수 — ${label}`}
        style={{ display: 'block', overflow: 'visible' }}
      >
        {[0, 0.5, 1].map((r) => (
          <line key={r} x1={pad.l} x2={W - pad.r} y1={pad.t + (H - pad.t - pad.b) * r} y2={pad.t + (H - pad.t - pad.b) * r} stroke="var(--line)" strokeWidth="1" />
        ))}
        {daily.map((d, i) => {
          const full = H - pad.t - pad.b;
          const h = max > 0 ? Math.round((d.turns / max) * full) : 0;
          const x = pad.l + slot * i + (slot - barW) / 2;
          const y = pad.t + full - h;
          const eh = max > 0 ? Math.round((d.escalated / max) * full) : 0;
          return (
            <g key={d.date}>
              {h > 0 && <rect x={x} y={y} width={barW} height={h} rx="5" fill="var(--brand)" />}
              {eh > 0 && <rect x={x} y={pad.t + full - eh} width={barW} height={eh} rx="5" fill="var(--warn)" />}
              <text x={x + barW / 2} y={H - 6} textAnchor="middle" fontSize="10.5" fill="var(--mut)">
                {d.date.slice(8)}
              </text>
              {d.turns > 0 && (
                <text x={x + barW / 2} y={y - 4} textAnchor="middle" fontSize="10.5" fontWeight="700" fill="var(--sub)">
                  {d.turns}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption style={{ display: 'flex', gap: 14, fontSize: 11.5, color: 'var(--mut)', marginTop: 6 }}>
        <span><span aria-hidden="true" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 3, background: 'var(--brand)', marginRight: 5 }} />대화</span>
        <span><span aria-hidden="true" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 3, background: 'var(--warn)', marginRight: 5 }} />상담원 제안</span>
        <span style={{ marginLeft: 'auto' }}>일자는 한국 시간 기준</span>
      </figcaption>
    </figure>
  );
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

/** 응답 근거 표시 — 화면에서는 내부 코드 대신 사람이 읽는 말로 보여준다. */
const SOURCE_VIEW_LABELS: Record<string, string> = {
  rule: '시나리오 규칙',
  kb: '등록 자료',
  llm: 'AI 생성',
  context: '이어지는 대화',
  fallback: '기본 안내',
  empty: '내용 없음',
  error: '연결 오류',
};

const CHANNEL_LABELS: Record<string, string> = {
  web: '홈페이지',
  kakao: '카카오톡',
  call: '전화',
};

/** 대화 주제(인텐트) 표시명. 사전에 없으면 원래 값을 그대로 쓴다. */
const INTENT_LABELS: Record<string, string> = {
  greeting: '인사',
  hours: '운영 시간',
  price: '요금 문의',
  location: '위치 안내',
  refund: '환불·취소',
  handoff: '상담원 연결',
  unknown: '분류 전',
  faq: '자료 안내',
  error: '연결 오류',
};

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
  'kb.import': '문서 업로드 등록',
  'rule.override': '내장 룰 변경',
  'rule.custom.upsert': '규칙 등록/수정',
  'rule.custom.delete': '규칙 삭제',
  'escalation.update': '티켓 변경',
  'backup.restore': '백업 복원',
};

interface StorageNsView {
  ns: string;
  persisted: boolean;
  health: 'ok' | 'empty' | 'disabled' | 'awaiting_approval' | 'readonly' | 'error';
  lastSavedAt: string | null;
  lastError: string | null;
}

/** 테넌트(고객사 프리셋) 지식 — /api/admin/tenants 응답. 읽기 전용이며 비밀값이 없다. */
interface TenantFAQView {
  id: string;
  citation: string;
  category: string;
  question: string;
  answer: string;
  keywords: string[];
}

interface TenantDetailView {
  status: { id: string; name: string; entries: number; skipped: number; ctaUrl: string; ctaFromEnv: boolean };
  config: { headerTitle: string; greeting: string; aiNotice: string; brandColor: string; cta: { label: string; url: string; hint: string } };
  faq: TenantFAQView[];
  warnings: string[];
}

interface StorageView {
  driver: 'memory' | 'file';
  piiApproved: boolean;
  namespaces: StorageNsView[];
}

const STORAGE_NS_LABELS: Record<string, string> = {
  admin: '관리 콘텐츠(KB·룰)',
  audit: '감사 로그',
  tickets: '상담 티켓(개인정보)',
  convlog: '대화 로그(개인정보)',
};

const STORAGE_HEALTH: Record<StorageNsView['health'], { label: string; hint: string }> = {
  ok: { label: '저장됨', hint: '디스크에 반영되었습니다.' },
  empty: { label: '저장분 없음', hint: '아직 저장된 내용이 없습니다. 편집하면 자동 저장됩니다.' },
  disabled: { label: '저장 꺼짐', hint: '배포 설정에서 저장이 꺼져 있어 재시작하면 사라집니다.' },
  awaiting_approval: { label: '승인 대기', hint: '개인정보가 포함되어 있어, 저장 승인이 나기 전까지는 서버에 보관하지 않습니다.' },
  readonly: { label: '읽기전용 환경', hint: '이 환경에서는 변경 내용을 서버에 보관할 수 없습니다. 「백업 내려받기」로 파일을 받아 두세요.' },
  error: { label: '저장 실패', hint: '아래 오류를 확인해 주세요. 데이터는 메모리에 남아 있습니다.' },
};

interface KBForm {
  id: string;
  category: string;
  question: string;
  keywords: string;
  answer: string;
}

const EMPTY_FORM: KBForm = { id: '', category: '', question: '', keywords: '', answer: '' };

// ---- 파트너(채널)·고객사 귀속 ----
interface PartnerView {
  id: string;
  name: string;
  status: 'active' | 'paused';
  managerName?: string;
  feeRateBp: number | null;
  memo?: string;
}
interface AttributionView {
  at: string;
  fromPartnerId: string | null;
  toPartnerId: string | null;
  source: string;
  note: string;
  authed: boolean;
}
interface AccountView {
  id: string;
  name: string;
  partnerId: string | null;
  source: string;
  status: 'prospect' | 'contracted' | 'churned';
  contractedAt?: string;
  ownerName?: string;
  monthlyFeeKrw?: number;
  memo?: string;
  attribution: AttributionView[];
}

// ---- 정산 리포트 ----
interface SettlementRowView {
  partnerId: string;
  partnerName: string;
  accountId: string;
  accountName: string;
  contractedAt: string;
  baseAmountKrw: number | null;
  feeRateBp: number | null;
  feeAmountKrw: number | null;
  issue: 'none' | 'no_fee_rate' | 'no_base_amount' | 'no_fee_rate_and_base';
}
interface SettlementPartnerTotalView {
  partnerId: string; partnerName: string; accounts: number; billable: number;
  baseAmountKrw: number; feeAmountKrw: number; incomplete: number;
}
interface SettlementReportView {
  month: string;
  periodStart: string;
  periodEnd: string;
  rows: SettlementRowView[];
  partnerTotals: SettlementPartnerTotalView[];
  totals: { accounts: number; billable: number; incomplete: number; baseAmountKrw: number; feeAmountKrw: number; partial: boolean };
  notes: string[];
}
const ISSUE_LABELS: Record<SettlementRowView['issue'], string> = {
  none: '',
  no_fee_rate: '수수료율 미설정',
  no_base_amount: '월 이용료 미입력',
  no_fee_rate_and_base: '월 이용료·수수료율 미설정',
};
/** 금액 표시 — 값이 없으면 임의로 0을 쓰지 않고 "미입력"이라고 밝힌다. */
function wonLabel(v: number | null | undefined): string {
  return typeof v === 'number' ? `${v.toLocaleString('ko-KR')}원` : '미입력';
}
interface RollupView {
  partnerId: string | null;
  partnerName: string;
  feeRateBp: number | null;
  total: number;
  contracted: number;
  prospect: number;
  churned: number;
}
const SOURCE_LABELS: Record<string, string> = {
  direct: '직접 영업',
  partner: '파트너 유치',
  referral: '고객 소개',
  inbound: '인바운드 문의',
  unknown: '미확인',
};
const ACCOUNT_STATUS_LABELS: Record<AccountView['status'], string> = {
  prospect: '검토 중',
  contracted: '계약',
  churned: '해지',
};
interface PartnerForm { id: string; name: string; managerName: string; feeRatePct: string; status: 'active' | 'paused'; memo: string }
const EMPTY_PARTNER_FORM: PartnerForm = { id: '', name: '', managerName: '', feeRatePct: '', status: 'active', memo: '' };
interface AccountForm {
  id: string; name: string; partnerId: string; source: string;
  status: AccountView['status']; contractedAt: string; ownerName: string; monthlyFeeKrw: string; attributionNote: string;
}
const EMPTY_ACCOUNT_FORM: AccountForm = {
  id: '', name: '', partnerId: '', source: 'unknown', status: 'prospect', contractedAt: '', ownerName: '', monthlyFeeKrw: '', attributionNote: '',
};

/** 베이시스포인트 → 사람이 읽는 수수료율. 미설정이면 임의 수치를 만들지 않는다. */
function feeLabel(bp: number | null): string {
  return bp === null || bp === undefined ? '미설정' : `${(bp / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}
/** 화면은 %로 받고 저장은 bp(1% = 100bp)로 한다 — API 계약은 그대로다. */
function pctToBp(pct: string): number {
  return Math.round(Number(pct) * 100);
}
function bpToPct(bp: number): string {
  return (bp / 100).toFixed(2).replace(/\.?0+$/, '');
}

/** 계약 상태 pill 색 — 토큰만 쓴다. */
const ACCOUNT_STATUS_TONE: Record<AccountView['status'], { background: string; color: string }> = {
  prospect: { background: '#FFFBEB', color: 'var(--warn)' },
  contracted: { background: '#F0FDF4', color: 'var(--success)' },
  churned: { background: 'var(--bg)', color: 'var(--mut)' },
};
const PARTNER_STATUS_TONE: Record<PartnerView['status'], { background: string; color: string }> = {
  active: { background: '#F0FDF4', color: 'var(--success)' },
  paused: { background: 'var(--bg)', color: 'var(--mut)' },
};

// ── 콘솔 내비게이션 ──
// 탭 목록은 사이드바(넓은 화면)와 상단 가로 스크롤 바(좁은 화면)에 같은 순서로 쓰인다.
type TabKey = 'dash' | 'kb' | 'rules' | 'esc' | 'partner' | 'settle' | 'tenant' | 'test' | 'install' | 'audit';

const TAB_GROUPS: { group: string; tabs: readonly (readonly [TabKey, string])[] }[] = [
  { group: '운영', tabs: [['dash', '대시보드'], ['esc', '상담원 요청'], ['tenant', '테넌트 지식']] },
  { group: '콘텐츠', tabs: [['kb', '지식베이스'], ['rules', '시나리오 룰'], ['test', '응답 테스트']] },
  { group: '사업', tabs: [['partner', '파트너·귀속'], ['settle', '정산 리포트']] },
  { group: '설정', tabs: [['install', '설치'], ['audit', '감사 로그']] },
];

/** 상단 헤더에 쓰는 탭 설명 — 이 화면에서 무엇을 하는지 한 줄로 알린다. */
const TAB_DESC: Record<TabKey, string> = {
  dash: '오늘의 응대 현황과 최근 대화를 확인합니다.',
  kb: '챗봇이 답변 근거로 쓰는 안내 자료를 등록·수정합니다.',
  rules: '특정 표현에 정해진 답을 돌려주는 규칙을 관리합니다.',
  esc: '상담원 연결 요청을 확인하고 처리 상태를 바꿉니다.',
  partner: '파트너와 고객사, 유치 경로를 관리합니다.',
  settle: '월별 파트너 수수료를 집계해 내려받습니다.',
  tenant: '지금 배포본이 무엇을 근거로 답하는지 확인합니다(읽기 전용).',
  test: '고객에게 나갈 답변을 미리 보내보고 근거를 확인합니다.',
  install: '고객사 홈페이지에 상담창을 붙이는 방법을 안내합니다.',
  audit: '누가 무엇을 바꿨는지 기록을 확인합니다.',
};

/** 내비게이션 아이콘 — 16px 뷰박스의 선 아이콘(현재 글자색을 따른다). */
const TAB_ICON: Record<TabKey, string> = {
  dash: 'M2.5 2.5h4v4h-4zM9.5 2.5h4v4h-4zM2.5 9.5h4v4h-4zM9.5 9.5h4v4h-4z',
  kb: 'M2.5 3.5h4a2 2 0 0 1 1.5.7 2 2 0 0 1 1.5-.7h4v8h-4a2 2 0 0 0-1.5.7 2 2 0 0 0-1.5-.7h-4zM8 4.2v8',
  rules: 'M2.5 4.5h4l3 4h4M13.5 8.5l-2-2M13.5 8.5l-2 2M6.5 4.5v7h3',
  esc: 'M8 7.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM3.5 13.5c0-2.3 2-3.5 4.5-3.5s4.5 1.2 4.5 3.5',
  partner: 'M6 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM11.3 7.4a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2M2 13.4c0-2.1 1.8-3.2 4-3.2s4 1.1 4 3.2M11 10.3c1.7.1 2.9 1.1 2.9 2.9',
  settle: 'M2.5 13.5h11M4.5 11V6.5M8 11V3.5M11.5 11V8.5',
  tenant: 'M3.5 13.5V3.5h6v10M9.5 7h3v6.5M5.5 6h2M5.5 8.5h2M5.5 11h2',
  test: 'M2.5 3.5h11v7H8l-3.5 2.5V10.5h-2z',
  install: 'M6 5.5 3.5 8 6 10.5M10 5.5 12.5 8 10 10.5',
  audit: 'M3.5 3.5h9M3.5 7h9M3.5 10.5h5.5M11.5 12.5l1.5-1.5',
};

/** 브랜드 마크 — 말풍선 + 이니셜. 원본은 `src/app/icon.svg`(파비콘)이며 경로 데이터를 같이 쓴다. */
const MARK_BODY = 'M7 2.5h18A5.5 5.5 0 0 1 30.5 8v11a5.5 5.5 0 0 1-5.5 5.5H13l-5 5v-5H7A5.5 5.5 0 0 1 1.5 19V8A5.5 5.5 0 0 1 7 2.5Z';
const MARK_G = 'M20.9 9.9A6 6 0 1 0 22 13.5h-5.2';

function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 32 32" style={{ flexShrink: 0 }}>
      <path d={MARK_BODY} fill="var(--brand)" />
      <path d={MARK_G} fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function NavIcon({ tab }: { tab: TabKey }) {
  return (
    <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
      <path d={TAB_ICON[tab]} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---- 전역 검색(헤더) — 대화·안내 자료·규칙·상담원 요청·고객사를 한 칸에서 찾아 그 화면으로 보낸다 ----
type SearchKind = '화면' | '지식베이스' | '시나리오 룰' | '상담원 요청' | '최근 대화' | '고객사' | '파트너';
const SEARCH_KIND_ORDER: SearchKind[] = ['화면', '상담원 요청', '최근 대화', '지식베이스', '시나리오 룰', '고객사', '파트너'];
/** 종류별 최대 표시 수 · 전체 상한 — 목록이 화면을 덮지 않게 한다. */
const SEARCH_PER_KIND = 3;
const SEARCH_MAX = 12;

interface SearchHit {
  key: string;
  kind: SearchKind;
  title: string;
  detail: string;
  /** 선택 시 실행. `from` 은 검색 입력칸 — 서랍을 열면 닫힐 때 초점이 여기로 돌아온다. */
  run: (from: HTMLElement | null) => void;
}

/** 띄어쓰기·대소문자를 무시하고 포함 여부를 본다(한국어 검색에서 띄어쓰기 차이로 놓치지 않게). */
function searchNorm(v: string): string {
  return v.toLowerCase().replace(/\s+/g, '');
}
function searchMatch(q: string, ...hay: (string | undefined)[]): boolean {
  return hay.some((h) => !!h && searchNorm(h).includes(q));
}
/** 목록에 보일 요약 — 길면 줄인다. */
function clip(v: string, n = 64): string {
  const t = v.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function GlobalSearch({ search, onFirstOpen }: { search: (q: string) => SearchHit[]; onFirstOpen?: () => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const openedOnce = useRef(false);

  // Ctrl/⌘+K 또는 입력 중이 아닐 때 "/" 로 검색칸에 초점
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isK = (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k';
      const target = e.target as HTMLElement | null;
      const editing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      const isSlash = e.key === '/' && !editing && !e.ctrlKey && !e.metaKey && !e.altKey;
      if (isK || isSlash) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const term = searchNorm(q);
  const hits = open && term ? search(term) : [];
  const listId = 'ac-gsearch-list';
  const optId = (i: number) => `ac-gsearch-opt-${i}`;
  const activeIdx = Math.min(active, Math.max(hits.length - 1, 0));

  const pick = (h: SearchHit) => {
    setOpen(false);
    setQ('');
    setActive(0);
    h.run(inputRef.current);
  };
  const onFocus = () => {
    setOpen(true);
    if (!openedOnce.current) {
      openedOnce.current = true;
      onFirstOpen?.();
    }
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      if (hits.length) setActive((i) => (i + 1) % hits.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (hits.length) setActive((i) => (i - 1 + hits.length) % hits.length);
    } else if (e.key === 'Enter') {
      if (hits[activeIdx]) {
        e.preventDefault();
        pick(hits[activeIdx]);
      }
    } else if (e.key === 'Escape') {
      if (q) {
        e.preventDefault();
        e.stopPropagation();
        setQ('');
      }
      setOpen(false);
    }
  };

  // 종류별로 묶되, 순서는 운영에서 급한 것(요청·대화) 우선
  const grouped = SEARCH_KIND_ORDER.map((k) => ({ kind: k, items: hits.map((h, i) => ({ h, i })).filter(({ h }) => h.kind === k) })).filter((g) => g.items.length);

  return (
    <div className="ac-gsearch" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}>
      <label htmlFor="ac-gsearch" className="ac-srhide">전체 검색 — 대화·안내 자료·규칙·상담원 요청·고객사</label>
      <svg className="ac-gsearch-icon" aria-hidden="true" focusable="false" width="15" height="15" viewBox="0 0 16 16" fill="none">
        <path d="M7 12.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <input
        ref={inputRef}
        id="ac-gsearch"
        className="ac-gsearch-input"
        type="search"
        role="combobox"
        autoComplete="off"
        placeholder="대화·자료·규칙·요청·고객사 검색"
        value={q}
        aria-expanded={open && !!term}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && hits[activeIdx] ? optId(activeIdx) : undefined}
        aria-describedby="ac-gsearch-hint"
        onFocus={onFocus}
        onChange={(e) => { setQ(e.target.value); setActive(0); setOpen(true); }}
        onKeyDown={onKeyDown}
      />
      <kbd className="ac-gsearch-kbd" aria-hidden="true">Ctrl K</kbd>
      <span id="ac-gsearch-hint" className="ac-srhide">Ctrl+K 로 바로 열 수 있습니다. 위아래 화살표로 고르고 Enter 로 이동합니다.</span>
      <span role="status" aria-live="polite" className="ac-srhide">{open && term ? `검색 결과 ${hits.length}건` : ''}</span>
      {open && term && (
        <div className="ac-gsearch-pop">
          <ul id={listId} role="listbox" aria-label="검색 결과" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {hits.length === 0 && (
              <li role="presentation" className="ac-gsearch-empty">
                「{clip(q, 30)}」에 맞는 항목이 없습니다. 다른 말로 찾아보세요.
              </li>
            )}
            {grouped.map((g) => (
              <li key={g.kind} role="presentation">
                <div className="ac-gsearch-group" aria-hidden="true">{g.kind}</div>
                <ul role="group" aria-label={g.kind} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {g.items.map(({ h, i }) => (
                    <li
                      key={h.key}
                      id={optId(i)}
                      role="option"
                      aria-selected={i === activeIdx}
                      className="ac-gsearch-opt"
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => pick(h)}
                    >
                      <span className="ac-gsearch-title">{h.title}</span>
                      {h.detail && <span className="ac-gsearch-detail">{h.detail}</span>}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const S = {
  page: { maxWidth: 960, margin: '0 auto', padding: '32px 20px 80px' } as const,
  h2: { fontSize: 16, fontWeight: 800, letterSpacing: '-.01em' } as const,
  card: { background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--r)', padding: 20, marginBottom: 16 } as const,
  input: { width: '100%', border: '1px solid var(--line-2)', borderRadius: 'var(--r-sm)', padding: '8px 10px', fontSize: 14, marginBottom: 8 } as const,
  btn: { background: 'var(--brand)', color: '#fff', borderRadius: 'var(--r-sm)', padding: '8px 14px', fontSize: 14 } as const,
  btnGhost: { background: 'var(--brand-50)', color: 'var(--brand-600)', borderRadius: 'var(--r-sm)', padding: '8px 14px', fontSize: 14 } as const,
  tag: { fontSize: 12, color: 'var(--mut)' } as const,
};

/** 쉼표·줄바꿈으로 나눈 표현 목록(빈 항목·중복 제거). */
function splitKeywords(raw: string): string[] {
  const out: string[] = [];
  for (const k of raw.split(/[,\n]/)) {
    const v = k.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** 조건 시험(화면용 근사치): 띄어쓰기를 무시하고 표현이 포함되는지 본다. 실제 판정은 응답 테스트에서 확인한다. */
function probeKeywords(sentence: string, keywords: string[]): string[] {
  const compact = sentence.replace(/\s+/g, '').toLowerCase();
  if (!compact) return [];
  return keywords.filter((k) => compact.includes(k.replace(/\s+/g, '').toLowerCase()));
}

/** 내장 룰의 정규식을 사람이 읽을 예시 표현으로 푼다(첫 그룹의 대안만, 최대 6개). */
function patternExamples(pattern: string): string[] {
  const m = /\(([^()]+)\)/.exec(pattern);
  const body = m ? m[1] : pattern;
  return body
    .split('|')
    .map((s) => s.replace(/[\\^$.*+?[\]{}]/g, '').replace(/ ?\?/g, '').trim())
    .filter((s) => s && !/[|()]/.test(s))
    .slice(0, 6);
}

/** 고객사에 안내할 설치 스니펫. 배포 주소는 지금 보고 있는 주소를 그대로 쓴다. */
function installSnippet(origin: string): string {
  const base = origin || 'https://<배포도메인>';
  return `<script src="${base}/embed.js" async></script>`;
}

/** 설치 스니펫에 붙일 수 있는 선택 속성(공개 계약 — embed.js 와 같이 유지한다). */
const INSTALL_OPTIONS: [string, string][] = [
  ['data-position="left"', '상담창을 화면 왼쪽 아래에 붙입니다(기본값: 오른쪽).'],
  ['data-offset="24"', '화면 가장자리와의 여백(px).'],
  ['data-z="2147483000"', '다른 요소에 가려질 때 쌓임 순서를 올립니다.'],
  ['data-tenant="eum"', '고객사 전용 문구·색·안내 자료를 적용합니다.'],
];

export default function AdminPage() {
  const [tab, setTab] = useState<TabKey>('dash');
  // 탭을 바꾸면 화면 전체가 바뀌는데 초점은 사이드바 버튼에 남아 있었다 — 키보드 사용자는
  // 새 화면에 닿으려고 다시 Tab 을 눌러야 했고, 스크린리더는 바뀐 사실조차 알리지 않았다.
  // 본문으로 초점을 옮기면 aria-label(현재 화면 이름)이 읽힌다. 첫 렌더에서는 옮기지 않는다.
  const mainRef = useRef<HTMLElement | null>(null);
  const tabMounted = useRef(false);
  useEffect(() => {
    if (!tabMounted.current) { tabMounted.current = true; return; }
    mainRef.current?.focus();
  }, [tab]);
  // 설치 코드에 넣을 배포 주소 — 브라우저가 보고 있는 주소를 그대로 쓴다(하드코딩 금지).
  const [origin, setOrigin] = useState('');
  const [copied, setCopied] = useState('');
  useEffect(() => {
    try { setOrigin(window.location.origin); } catch { setOrigin(''); }
  }, []);
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

  // ---- 인증 상태(잠금 화면·토큰 검증 피드백) ----
  interface AuthInfo {
    authRequired: boolean;
    tokenConfigured: boolean;
    allowed: boolean;
    authed: boolean;
  }
  const [authInfo, setAuthInfo] = useState<AuthInfo | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authMsg, setAuthMsg] = useState('');
  const [loginOpen, setLoginOpen] = useState(false);
  const [showToken, setShowToken] = useState(false);

  /** 데이터 API가 401을 돌려주면 잠금 화면으로 전환한다. true = 401 처리됨. */
  const on401 = (res: Response): boolean => {
    if (res.status !== 401) return false;
    setAuthInfo((p) => (p ? { ...p, allowed: false, authed: false } : { authRequired: true, tokenConfigured: true, allowed: false, authed: false }));
    setAuthMsg('인증이 만료되었거나 토큰이 올바르지 않습니다.');
    return true;
  };

  // ---- 초기 데이터 로드 상태 (DS 4-2) — 오기 전엔 빈 상태를 보이지 않고, 실패는 숨기지 않는다 ----
  type DataKey = 'kb' | 'rules' | 'esc' | 'audit';
  const [phase, setPhase] = useState<Record<DataKey, LoadPhase>>({ kb: 'loading', rules: 'loading', esc: 'loading', audit: 'loading' });
  const markPhase = (k: DataKey, v: LoadPhase) => setPhase((p) => (p[k] === v ? p : { ...p, [k]: v }));

  // ---- 네트워크 연결 상태 (DS 4-3) — 끊기면 헤더 아래 배너로 알리고, 복구되면 조용히 사라진다 ----
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const sync = () => setOffline(typeof navigator !== 'undefined' && navigator.onLine === false);
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);

  // ---- KB ----
  const [entries, setEntries] = useState<KBEntryView[]>([]);
  const [form, setForm] = useState<KBForm>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [kbQuery, setKbQuery] = useState('');
  const [kbCat, setKbCat] = useState('');
  const [kbErr, setKbErr] = useState<{ question?: string; answer?: string }>({});
  const [kbBusy, setKbBusy] = useState(false);
  const kbFormRef = useRef<HTMLDivElement | null>(null);

  const loadKB = useCallback(async () => {
    markPhase('kb', 'loading');
    try {
      const res = await fetch('/api/admin/kb', { headers: authHeaders() });
      if (on401(res)) return;
      const data = await res.json();
      if (data.ok) setEntries(data.entries);
      markPhase('kb', data.ok ? 'done' : 'error');
    } catch {
      markPhase('kb', 'error');
    }
  }, []);

  // ---- 문서 업로드(청킹 → KB 후보) ----
  const [imp, setImp] = useState<ImportForm>(EMPTY_IMPORT);
  const [candidates, setCandidates] = useState<KBCandidateView[] | null>(null);
  const [impBusy, setImpBusy] = useState(false);

  const runImport = async (commit: boolean) => {
    if (!imp.title.trim() || !imp.text.trim()) {
      flash('문서명과 본문을 입력해 주세요.');
      return;
    }
    setImpBusy(true);
    try {
      const res = await fetch('/api/admin/kb/import', {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({
          title: imp.title.trim(),
          category: imp.category.trim() || '문서',
          maxChars: Number(imp.maxChars) || 500,
          text: imp.text,
          commit,
        }),
      });
      if (on401(res)) return;
      const data = await res.json();
      if (!data.ok) {
        flash(data.error || '문서를 처리하지 못했습니다.');
        return;
      }
      if (commit) {
        setCandidates(null);
        setImp(EMPTY_IMPORT);
        await loadKB();
        flash(`문서 등록 완료: 신규 ${data.created} · 갱신 ${data.updated}${data.errors?.length ? ` · 실패 ${data.errors.length}` : ''}`);
      } else {
        setCandidates(data.candidates as KBCandidateView[]);
        flash(`미리보기 ${data.count}개 — 확인 후 "등록"을 눌러주세요.`);
      }
    } finally {
      setImpBusy(false);
    }
  };

  // ---- Rules ----
  const [rules, setRules] = useState<RuleView[]>([]);
  const [customRules, setCustomRules] = useState<CustomRuleView[]>([]);
  const [crForm, setCrForm] = useState<CustomRuleForm>(EMPTY_CR_FORM);
  const [crEditing, setCrEditing] = useState<string | null>(null);
  const [crErr, setCrErr] = useState<{ label?: string; keywords?: string; reply?: string }>({});
  const [crBusy, setCrBusy] = useState(false);
  const [ruleProbe, setRuleProbe] = useState('');
  const [ruleQuery, setRuleQuery] = useState('');
  const ruleFormRef = useRef<HTMLDivElement | null>(null);
  const loadRules = useCallback(async () => {
    markPhase('rules', 'loading');
    try {
      const res = await fetch('/api/admin/rules', { headers: authHeaders() });
      if (on401(res)) return;
      const data = await res.json();
      if (data.ok) {
        setRules(data.rules);
        setCustomRules(data.customRules || []);
      }
      markPhase('rules', data.ok ? 'done' : 'error');
    } catch {
      markPhase('rules', 'error');
    }
  }, []);

  // ---- Escalations ----
  const [tickets, setTickets] = useState<TicketView[]>([]);
  const [stats, setStats] = useState<OpsStats | null>(null);
  const [recentTurns, setRecentTurns] = useState<TurnView[]>([]);

  // ---- 최근 대화 상세 서랍(대시보드) ----
  const [drawerSession, setDrawerSession] = useState<string | null>(null);
  const drawerReturnRef = useRef<HTMLElement | null>(null);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);
  const openDrawer = (sessionId: string, from: HTMLElement | null) => {
    drawerReturnRef.current = from;
    setDrawerSession(sessionId);
  };
  const closeDrawer = useCallback(() => {
    setDrawerSession(null);
    const el = drawerReturnRef.current;
    drawerReturnRef.current = null;
    window.setTimeout(() => el?.focus(), 0);
  }, []);
  useEffect(() => {
    if (!drawerSession) return;
    const t = window.setTimeout(() => drawerCloseRef.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDrawer();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('keydown', onKey);
    };
  }, [drawerSession, closeDrawer]);
  // ---- 상담원 요청 큐(필터·검색·상세 서랍) ----
  const [escFilter, setEscFilter] = useState<'all' | TicketView['status']>('all');
  const [escQuery, setEscQuery] = useState('');
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [ticketBusy, setTicketBusy] = useState(false);
  const ticketReturnRef = useRef<HTMLElement | null>(null);
  const ticketCloseRef = useRef<HTMLButtonElement>(null);
  const openTicket = (id: string, from: HTMLElement | null) => {
    ticketReturnRef.current = from;
    setTicketId(id);
  };
  const closeTicket = useCallback(() => {
    setTicketId(null);
    const el = ticketReturnRef.current;
    ticketReturnRef.current = null;
    window.setTimeout(() => el?.focus(), 0);
  }, []);
  useEffect(() => {
    if (!ticketId) return;
    const t = window.setTimeout(() => ticketCloseRef.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeTicket();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('keydown', onKey);
    };
  }, [ticketId, closeTicket]);
  // ---- 감사 로그 필터 ----
  const [auditFilter, setAuditFilter] = useState('all');
  const loadEsc = useCallback(async () => {
    markPhase('esc', 'loading');
    try {
      const res = await fetch('/api/admin/escalations?logs=true', { headers: authHeaders() });
      if (on401(res)) return;
      const data = await res.json();
      if (data.ok) {
        setTickets(data.tickets);
        setStats(data.stats);
        setRecentTurns(data.recentTurns || []);
      }
      markPhase('esc', data.ok ? 'done' : 'error');
    } catch {
      markPhase('esc', 'error');
    }
  }, []);

  // ---- 파트너(채널)·고객사 귀속 ----
  const [partners, setPartners] = useState<PartnerView[]>([]);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [rollup, setRollup] = useState<RollupView[]>([]);
  const [partnerFilter, setPartnerFilter] = useState('');
  const [partnerErr, setPartnerErr] = useState('');
  const [partnerBusy, setPartnerBusy] = useState(false);
  const [partnerLoaded, setPartnerLoaded] = useState(false);
  const [pForm, setPForm] = useState<PartnerForm>(EMPTY_PARTNER_FORM);
  const [aForm, setAForm] = useState<AccountForm>(EMPTY_ACCOUNT_FORM);
  // 우측 폼은 고객사/파트너 중 하나만 보여준다(한 화면에 긴 폼 두 개를 쌓지 않는다).
  const [partnerFormKind, setPartnerFormKind] = useState<'account' | 'partner'>('account');
  const [pErr, setPErr] = useState<{ name?: string; feeRatePct?: string }>({});
  const [aErr, setAErr] = useState<{ name?: string; partnerId?: string; contractedAt?: string; monthlyFeeKrw?: string }>({});
  const [partnerSaving, setPartnerSaving] = useState(false);
  const [accountQuery, setAccountQuery] = useState('');
  const partnerFormRef = useRef<HTMLDivElement | null>(null);
  // 파트너 담당자 계정은 읽기 전용이다 — 서버가 403으로 막지만, 화면에서도 쓰기 UI를 감춘다.
  const [canWrite, setCanWrite] = useState(true);

  // 고객사 상세 서랍(귀속 이력) — 연 행으로 초점을 되돌린다.
  const [accountId, setAccountId] = useState<string | null>(null);
  const accountReturnRef = useRef<HTMLElement | null>(null);
  const accountCloseRef = useRef<HTMLButtonElement>(null);
  const openAccount = (id: string, from: HTMLElement | null) => {
    accountReturnRef.current = from;
    setAccountId(id);
  };
  const closeAccount = useCallback(() => {
    setAccountId(null);
    const el = accountReturnRef.current;
    accountReturnRef.current = null;
    window.setTimeout(() => el?.focus(), 0);
  }, []);
  useEffect(() => {
    if (!accountId) return;
    const t = window.setTimeout(() => accountCloseRef.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAccount();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('keydown', onKey);
    };
  }, [accountId, closeAccount]);

  const loadPartners = useCallback(async (filter = '') => {
    setPartnerBusy(true);
    setPartnerErr('');
    try {
      const qs = filter ? `?partnerId=${encodeURIComponent(filter)}` : '';
      const res = await fetch(`/api/admin/partners${qs}`, { headers: authHeaders(), cache: 'no-store' });
      if (on401(res)) return;
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setPartnerErr(data?.message || data?.error || '파트너 정보를 불러오지 못했습니다.');
        return;
      }
      setPartners(data.partners || []);
      setAccounts(data.accounts || []);
      setRollup(data.rollup || []);
      setCanWrite(data.canWrite !== false);
      setPartnerLoaded(true);
    } catch {
      setPartnerErr('네트워크 오류로 파트너 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      setPartnerBusy(false);
    }
  }, []);

  /** 폼으로 스크롤(좁은 화면에서는 폼이 목록 아래에 있다). */
  const focusPartnerForm = (kind: 'account' | 'partner') => {
    setPartnerFormKind(kind);
    window.setTimeout(() => partnerFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  };
  const editPartner = (p: PartnerView) => {
    setPForm({ id: p.id, name: p.name, managerName: p.managerName ?? '', feeRatePct: p.feeRateBp === null ? '' : bpToPct(p.feeRateBp), status: p.status, memo: p.memo ?? '' });
    setPErr({});
    focusPartnerForm('partner');
  };
  const editAccount = (a: AccountView) => {
    setAForm({
      id: a.id, name: a.name, partnerId: a.partnerId ?? '', source: a.source,
      status: a.status, contractedAt: a.contractedAt ?? '', ownerName: a.ownerName ?? '',
      monthlyFeeKrw: typeof a.monthlyFeeKrw === 'number' ? String(a.monthlyFeeKrw) : '', attributionNote: '',
    });
    setAErr({});
    focusPartnerForm('account');
  };

  const submitPartner = async () => {
    if (partnerSaving) return;
    // 서버도 같은 규칙으로 거절하지만, 어느 칸이 왜 틀렸는지는 화면에서 먼저 알린다.
    const errs: typeof pErr = {};
    if (!pForm.name.trim()) errs.name = '파트너명을 입력해 주세요.';
    if (pForm.feeRatePct.trim() !== '') {
      const n = Number(pForm.feeRatePct);
      if (!Number.isFinite(n) || n < 0 || n > 100) errs.feeRatePct = '수수료율은 0~100 사이의 숫자(%)여야 합니다.';
    }
    setPErr(errs);
    if (Object.keys(errs).length > 0) return;
    setPartnerErr('');
    setPartnerSaving(true);
    try {
      const res = await fetch('/api/admin/partners', {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({
          kind: 'partner', id: pForm.id, name: pForm.name, managerName: pForm.managerName, status: pForm.status, memo: pForm.memo,
          feeRateBp: pForm.feeRatePct.trim() === '' ? null : pctToBp(pForm.feeRatePct),
        }),
      });
      if (on401(res)) return;
      const data = await res.json();
      if (!data.ok) {
        setPartnerErr(data.message || data.error || '저장하지 못했습니다.');
        return;
      }
      setPForm(EMPTY_PARTNER_FORM);
      await loadPartners(partnerFilter);
      flash(data.created ? '파트너를 등록했습니다.' : '파트너를 수정했습니다.');
    } catch {
      setPartnerErr('네트워크 오류로 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      setPartnerSaving(false);
    }
  };

  const submitAccount = async () => {
    if (partnerSaving) return;
    const errs: typeof aErr = {};
    if (!aForm.name.trim()) errs.name = '고객사명을 입력해 주세요.';
    if (aForm.source === 'partner' && !aForm.partnerId) errs.partnerId = '유입 경로가 「파트너 유치」이면 귀속 파트너를 골라야 합니다.';
    const date = aForm.contractedAt.trim();
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) errs.contractedAt = '계약일은 2026-09-01 처럼 연-월-일 형식이어야 합니다.';
    if (!date && aForm.status === 'contracted') errs.contractedAt = '계약 상태로 두려면 계약일이 필요합니다(정산 기준일).';
    if (aForm.monthlyFeeKrw.trim() !== '') {
      const n = Number(aForm.monthlyFeeKrw);
      if (!Number.isFinite(n) || n < 0) errs.monthlyFeeKrw = '월 이용료는 0 이상의 숫자(원)여야 합니다.';
    }
    setAErr(errs);
    if (Object.keys(errs).length > 0) return;
    setPartnerErr('');
    setPartnerSaving(true);
    try {
      const res = await fetch('/api/admin/partners', {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({ kind: 'account', ...aForm }),
      });
      if (on401(res)) return;
      const data = await res.json();
      if (!data.ok) {
        setPartnerErr(data.message || data.error || '저장하지 못했습니다.');
        return;
      }
      setAForm(EMPTY_ACCOUNT_FORM);
      await loadPartners(partnerFilter);
      flash(data.created ? '고객사를 등록했습니다.' : '고객사를 수정했습니다.');
    } catch {
      setPartnerErr('네트워크 오류로 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      setPartnerSaving(false);
    }
  };

  const removePartner = async (p: PartnerView) => {
    // 되돌릴 수 없는 동작 — 확인 절차를 거친다(연결 고객사가 있으면 서버가 거절한다).
    const ok = await askConfirm({
      title: '파트너를 삭제할까요?',
      target: p.name,
      body: '삭제하면 되돌릴 수 없습니다. 연결된 고객사가 있으면 삭제되지 않습니다.',
      confirmLabel: '삭제',
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/admin/partners?partnerId=${encodeURIComponent(p.id)}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (on401(res)) return;
      const data = await res.json();
      if (!data.ok) {
        setPartnerErr(data.message || data.error || '삭제하지 못했습니다.');
        return;
      }
      if (pForm.id === p.id) setPForm(EMPTY_PARTNER_FORM);
      await loadPartners(partnerFilter);
      flash('파트너를 삭제했습니다.');
    } catch {
      setPartnerErr('연결이 원활하지 않아 삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    }
  };

  // ---- 정산 리포트 ----
  const [settleMonth, setSettleMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [settlePartner, setSettlePartner] = useState('');
  const [settleReport, setSettleReport] = useState<SettlementReportView | null>(null);
  const [settleErr, setSettleErr] = useState('');
  const [settleBusy, setSettleBusy] = useState(false);

  const loadSettlement = useCallback(async (month: string, partnerId: string) => {
    setSettleBusy(true);
    setSettleErr('');
    try {
      const qs = new URLSearchParams({ month });
      if (partnerId) qs.set('partnerId', partnerId);
      const res = await fetch(`/api/admin/settlement?${qs.toString()}`, { headers: authHeaders(), cache: 'no-store' });
      if (on401(res)) return;
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setSettleReport(null);
        setSettleErr(data?.message || data?.error || '정산 리포트를 불러오지 못했습니다.');
        return;
      }
      setSettleReport(data.report as SettlementReportView);
    } catch {
      setSettleReport(null);
      setSettleErr('네트워크 오류로 정산 리포트를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      setSettleBusy(false);
    }
  }, []);

  const downloadSettlementCsv = () => {
    const t = tokenRef.current;
    const qs = new URLSearchParams({ month: settleMonth, format: 'csv' });
    if (settlePartner) qs.set('partnerId', settlePartner);
    if (t) qs.set('token', t);
    window.open(`/api/admin/settlement?${qs.toString()}`, '_blank');
  };

  // ---- Audit ----
  const [auditEvents, setAuditEvents] = useState<AuditView[]>([]);
  const loadAudit = useCallback(async () => {
    markPhase('audit', 'loading');
    try {
      const res = await fetch('/api/admin/audit?limit=100', { headers: authHeaders() });
      if (on401(res)) return;
      const data = await res.json();
      if (data.ok) setAuditEvents(data.events || []);
      markPhase('audit', data.ok ? 'done' : 'error');
    } catch {
      markPhase('audit', 'error');
    }
  }, []);

  // ---- 저장소 상태(/api/health) ----
  const [storage, setStorage] = useState<StorageView | null>(null);
  const [storageErr, setStorageErr] = useState('');
  const [storageBusy, setStorageBusy] = useState(false);
  const loadStorage = useCallback(async () => {
    setStorageBusy(true);
    setStorageErr('');
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      const data = await res.json();
      const st = data?.dependencies?.storage;
      if (!res.ok || !st) {
        setStorage(null);
        setStorageErr('저장소 상태를 확인하지 못했습니다. 잠시 후 새로고침해 주세요.');
        return;
      }
      setStorage(st as StorageView);
    } catch {
      setStorage(null);
      setStorageErr('네트워크 오류로 저장소 상태를 확인하지 못했습니다.');
    } finally {
      setStorageBusy(false);
    }
  }, []);

  // ---- 테넌트 지식(읽기 전용) ----
  // 편집 화면이 아니다. "지금 배포본이 무엇을 근거로 답하는가"를 확인하는 창구다.
  const [tenantId, setTenantId] = useState('eum');
  const [tenantIdList, setTenantIdList] = useState<string[]>([]);
  const [tenantView, setTenantView] = useState<TenantDetailView | null>(null);
  const [tenantErr, setTenantErr] = useState('');
  const [tenantBusy, setTenantBusy] = useState(false);
  const loadTenant = useCallback(async (id: string) => {
    setTenantBusy(true);
    setTenantErr('');
    try {
      const list = await fetch('/api/admin/tenants', { headers: authHeaders(), cache: 'no-store' });
      if (on401(list)) return;
      const listData = await list.json();
      if (listData.ok) setTenantIdList(listData.ids || []);

      const res = await fetch(`/api/admin/tenants?id=${encodeURIComponent(id)}`, { headers: authHeaders(), cache: 'no-store' });
      if (on401(res)) return;
      const data = await res.json();
      if (!data.ok || !data.tenant) {
        setTenantView(null);
        setTenantErr(data.message || '테넌트 지식을 불러오지 못했습니다.');
        return;
      }
      setTenantView(data.tenant as TenantDetailView);
    } catch {
      setTenantView(null);
      setTenantErr('네트워크 오류로 테넌트 지식을 불러오지 못했습니다.');
    } finally {
      setTenantBusy(false);
    }
  }, []);

  /** 토큰 검증(/api/admin/auth) 후 통과 시 데이터 로드. 실패 시 잠금 화면 + 사유 표시. */
  const verifyAuth = useCallback(async () => {
    setAuthBusy(true);
    try {
      const res = await fetch('/api/admin/auth', { headers: authHeaders() });
      const data = await res.json();
      if (data.ok) {
        setAuthInfo({ authRequired: data.authRequired, tokenConfigured: data.tokenConfigured, allowed: data.allowed, authed: data.authed });
        if (data.allowed) {
          setAuthMsg('');
          if (data.authed || !data.tokenConfigured) setLoginOpen(false);
          else if (tokenRef.current) setAuthMsg('토큰이 올바르지 않습니다. 다시 확인해 주세요.');
          loadKB();
          loadRules();
          loadEsc();
          loadAudit();
          loadStorage();
        } else {
          setAuthMsg(data.reason || '관리 토큰을 확인해 주세요.');
        }
      } else if (data.code === 'rate_limited') {
        setAuthMsg(`시도가 너무 잦습니다. ${data.retryAfterSec ?? 60}초 후 다시 시도해 주세요.`);
      } else {
        setAuthMsg(data.message || data.error || '인증 상태를 확인하지 못했습니다.');
      }
    } catch {
      setAuthMsg('네트워크 오류로 인증 상태를 확인하지 못했습니다.');
    } finally {
      setAuthBusy(false);
    }
  }, [loadKB, loadRules, loadEsc, loadAudit, loadStorage]);

  useEffect(() => {
    verifyAuth();
  }, [verifyAuth]);

  // 파트너 탭은 열었을 때만 불러온다(불필요한 관리 API 호출을 만들지 않는다).
  useEffect(() => {
    if (tab === 'partner' && !partnerLoaded && !partnerBusy) loadPartners(partnerFilter);
    // 정산 탭은 파트너 목록(필터 선택지)이 필요하므로 함께 채운다.
    if (tab === 'settle') {
      if (!partnerLoaded && !partnerBusy) loadPartners('');
      if (!settleReport && !settleBusy && !settleErr) loadSettlement(settleMonth, settlePartner);
    }
    // 테넌트 지식도 탭을 열었을 때만 불러온다.
    if (tab === 'tenant' && !tenantView && !tenantBusy && !tenantErr) loadTenant(tenantId);
  }, [tab, partnerLoaded, partnerBusy, loadPartners, partnerFilter, settleReport, settleBusy, settleErr, loadSettlement, settleMonth, settlePartner, tenantView, tenantBusy, tenantErr, loadTenant, tenantId]);

  const flash = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(''), 2500);
  };

  // ---- 확인 대화상자 ----
  // 되돌릴 수 없는 동작은 전부 이 함수를 거친다. `await askConfirm(...)` 가 false 면 아무것도 하지 않는다.
  const [confirmReq, setConfirmReq] = useState<ConfirmReq | null>(null);
  const askConfirm = useCallback((opts: Omit<ConfirmReq, 'resolve'>) => new Promise<boolean>((resolve) => {
    setConfirmReq({ ...opts, resolve: (ok) => { setConfirmReq(null); resolve(ok); } });
  }), []);

  /**
   * 실패한 동작을 조용히 넘기지 않는다(QUALITY_BAR §3).
   * 네트워크 예외·JSON 파싱 실패까지 잡아 사용자가 읽을 수 있는 문구로 알린다.
   */
  const failed = (what: string, detail?: unknown) => {
    const hint = typeof detail === 'string' && detail.trim() ? detail.trim() : '';
    flash(hint ? `${what}: ${hint}` : `${what}. 잠시 후 다시 시도해 주세요.`);
  };

  const submitKB = async () => {
    const errs: { question?: string; answer?: string } = {};
    if (!form.question.trim()) errs.question = '대표 질문을 입력해 주세요.';
    if (!form.answer.trim()) errs.answer = '답변을 입력해 주세요.';
    setKbErr(errs);
    if (errs.question || errs.answer) return;
    if (kbBusy) return;
    setKbBusy(true);
    const body = {
      id: editingId ?? form.id,
      category: form.category,
      question: form.question,
      keywords: form.keywords,
      answer: form.answer,
    };
    let data: { ok?: boolean; error?: string };
    try {
      const res = await fetch('/api/admin/kb', {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify(body),
      });
      data = await res.json();
    } catch {
      data = { ok: false, error: '연결이 원활하지 않습니다. 잠시 후 다시 시도해 주세요.' };
    } finally {
      setKbBusy(false);
    }
    if (!data.ok) {
      failed('저장하지 못했습니다', data.error);
      return;
    }
    setForm(EMPTY_FORM);
    setEditingId(null);
    setKbErr({});
    await loadKB();
    flash(editingId ? '수정되었습니다.' : '추가되었습니다.');
  };

  const editKB = (e: KBEntryView) => {
    setEditingId(e.id);
    setKbErr({});
    setForm({ id: e.id, category: e.category, question: e.question, keywords: e.keywords.join(', '), answer: e.answer });
    setTab('kb');
    // 좁은 화면에서는 편집 폼이 표 아래에 있으므로 보이는 곳으로 옮긴다.
    window.setTimeout(() => kbFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  };

  const removeKB = async (id: string) => {
    // 되돌릴 수 없는 동작 — 확인을 거친다(QUALITY_BAR §3).
    const target = entries.find((e) => e.id === id);
    const ok = await askConfirm({
      title: '이 안내 자료를 삭제할까요?',
      ...(target ? { target: target.question } : {}),
      body: '삭제하면 되돌릴 수 없습니다. 이 자료를 근거로 답하던 질문은 더 이상 답변되지 않습니다.',
      confirmLabel: '삭제',
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/admin/kb?id=${encodeURIComponent(id)}`, { method: 'DELETE', headers: authHeaders() });
      if (on401(res)) return;
      const data = await res.json();
      if (data.ok) {
        await loadKB();
        flash('삭제되었습니다.');
      } else {
        failed('삭제하지 못했습니다', data.message || data.error);
      }
    } catch {
      failed('삭제하지 못했습니다');
    }
  };

  const resetAll = async () => {
    const ok = await askConfirm({
      title: '기본 자료로 되돌릴까요?',
      body: '등록한 안내 자료를 모두 지우고 처음 상태로 되돌립니다. 되돌릴 수 없으니, 필요하면 먼저 「백업 내려받기」로 받아 두세요.',
      confirmLabel: '모두 지우고 초기화',
    });
    if (!ok) return;
    try {
      const res = await fetch('/api/admin/kb', {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({ reset: true }),
      });
      if (on401(res)) return;
      const data = await res.json();
      if (!data.ok) {
        failed('초기화하지 못했습니다', data.message || data.error);
        return;
      }
      await loadKB();
      flash('기본 지식베이스로 초기화했습니다.');
    } catch {
      failed('초기화하지 못했습니다');
    }
  };

  const patchRule = async (intent: string, patch: { enabled?: boolean; reply?: string | null }) => {
    try {
      const res = await fetch('/api/admin/rules', {
        method: 'PATCH',
        headers: authHeaders(true),
        body: JSON.stringify({ intent, ...patch }),
      });
      if (on401(res)) return;
      const data = await res.json();
      if (data.ok) {
        setRules((prev) => prev.map((r) => (r.intent === intent ? data.rule : r)));
      } else {
        failed('저장하지 못했습니다', data.message || data.error);
      }
    } catch {
      failed('저장하지 못했습니다');
    }
  };

  const submitCustomRule = async () => {
    const errs: { label?: string; keywords?: string; reply?: string } = {};
    if (!crForm.label.trim()) errs.label = '규칙 이름을 입력해 주세요.';
    if (splitKeywords(crForm.keywords).length === 0) errs.keywords = '고객이 쓸 표현을 한 개 이상 입력해 주세요.';
    if (!crForm.reply.trim()) errs.reply = '고객에게 보낼 답변을 입력해 주세요.';
    setCrErr(errs);
    if (Object.keys(errs).length) return;
    const body = {
      ...(crEditing ? { intent: crEditing } : {}),
      label: crForm.label,
      keywords: crForm.keywords,
      reply: crForm.reply,
      escalate: crForm.escalate,
    };
    setCrBusy(true);
    try {
      const res = await fetch('/api/admin/rules', {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify(body),
      });
      if (on401(res)) return;
      const data = await res.json();
      if (!data.ok) {
        flash(`저장하지 못했습니다: ${data.message || data.error}`);
        return;
      }
      setCrForm(EMPTY_CR_FORM);
      setCrEditing(null);
      await loadRules();
      flash(crEditing ? '규칙을 수정했습니다.' : '규칙을 추가했습니다.');
    } catch {
      flash('네트워크 오류로 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      setCrBusy(false);
    }
  };

  const toggleCustomRule = async (r: CustomRuleView) => {
    const res = await fetch('/api/admin/rules', {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ intent: r.intent, enabled: !r.enabled }),
    });
    const data = await res.json();
    if (data.ok) await loadRules();
    else failed('변경하지 못했습니다', data.message || data.error);
  };

  const removeCustomRule = async (intent: string) => {
    const target = customRules.find((r) => r.intent === intent);
    const ok = await askConfirm({
      title: '이 규칙을 삭제할까요?',
      target: target?.label ?? intent,
      body: '삭제하면 되돌릴 수 없습니다. 이 규칙이 처리하던 질문은 안내 자료 검색으로 넘어갑니다.',
      confirmLabel: '삭제',
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/admin/rules?intent=${encodeURIComponent(intent)}`, { method: 'DELETE', headers: authHeaders() });
      if (on401(res)) return;
      const data = await res.json();
      if (data.ok) {
        if (crEditing === intent) {
          setCrEditing(null);
          setCrForm(EMPTY_CR_FORM);
        }
        await loadRules();
        flash('규칙을 삭제했습니다.');
      } else {
        failed('삭제하지 못했습니다', data.message || data.error);
      }
    } catch {
      failed('삭제하지 못했습니다');
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
      failed('복원하지 못했습니다', data.message || data.error);
      return;
    }
    await Promise.all([loadKB(), loadRules()]);
    flash(`복원 완료: 안내 자료 ${data.kb}건 · 규칙 ${data.customRules}건 · 기본 규칙 답변 수정 ${data.overrides}건`);
  };

  const patchTicket = async (id: string, status: TicketView['status']) => {
    setTicketBusy(true);
    try {
      const res = await fetch('/api/admin/escalations', {
        method: 'PATCH',
        headers: authHeaders(true),
        body: JSON.stringify({ id, status }),
      });
      const data = await res.json();
      if (data.ok) {
        await loadEsc();
        flash(`접수 ${shortTicket(id)} → ${TICKET_STATUS_LABELS[status]}`);
      } else {
        failed('상태를 바꾸지 못했습니다', data.message || data.error);
      }
    } catch {
      flash('상태를 바꾸지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.');
    } finally {
      setTicketBusy(false);
    }
  };

  // ---- Test ----
  const [testInput, setTestInput] = useState('');
  const [testLog, setTestLog] = useState<
    {
      q: string;
      reply: string;
      intent: string;
      source: string;
      confidence?: number;
      citation?: { source: string; snippet: string };
    }[]
  >([]);

  const [testBusy, setTestBusy] = useState(false);
  const testEndRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    testEndRef.current?.scrollIntoView({ block: 'end' });
  }, [testLog, testBusy]);

  const runTest = async () => {
    const q = testInput.trim();
    if (!q || testBusy) return;
    setTestInput('');
    setTestBusy(true);
    let data: Record<string, unknown> = {};
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: q }),
      });
      data = (await res.json()) as Record<string, unknown>;
    } catch {
      data = { reply: '연결이 원활하지 않습니다. 잠시 후 다시 시도해 주세요.', intent: 'error', source: 'error' };
    } finally {
      setTestBusy(false);
    }
    const c = data.citation as { source?: unknown; snippet?: unknown } | undefined;
    const cite = c && typeof c.source === 'string' && typeof c.snippet === 'string'
      ? { source: c.source, snippet: c.snippet }
      : undefined;
    setTestLog((prev) =>
      [
        {
          q,
          reply: typeof data.reply === 'string' ? data.reply : '답변을 받지 못했습니다. 다시 시도해 주세요.',
          intent: typeof data.intent === 'string' ? data.intent : '-',
          source: typeof data.source === 'string' ? data.source : '-',
          confidence: typeof data.confidence === 'number' ? data.confidence : undefined,
          citation: cite,
        },
        ...prev,
      ].slice(0, 20),
    );
  };

  // ---- 로그인 화면: 인증 게이트에 막혔거나 운영자가 직접 열었을 때 콘솔 대신 보여준다 ----
  if ((authInfo && !authInfo.allowed) || loginOpen) {
    const canReturn = Boolean(authInfo?.allowed);
    return (
      <main className="ac-login" aria-labelledby="ac-login-title">
        <form
          className="ac-login-card"
          onSubmit={(e) => {
            e.preventDefault();
            if (!authBusy) verifyAuth();
          }}
        >
          <div className="ac-brand" style={{ padding: '0 0 18px' }}>
            <BrandMark size={34} />
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 15, fontWeight: 800, letterSpacing: '-.01em' }}>GOWON Chat</span>
              <span style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--brand-600)' }}>관리 콘솔</span>
            </span>
          </div>
          <h1 id="ac-login-title" style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-.02em', marginBottom: 6 }}>로그인</h1>
          <p style={{ fontSize: 13.5, color: 'var(--sub)', marginBottom: 18 }}>운영자에게 받은 관리 토큰으로 콘솔을 엽니다.</p>
          <div className="ac-field">
            <label htmlFor="ac-login-token">관리 토큰</label>
            <div className="ac-login-input">
              <input
                id="ac-login-token"
                style={{ ...S.input, marginBottom: 0, paddingRight: 64 }}
                type={showToken ? 'text' : 'password'}
                autoComplete="current-password"
                autoFocus
                value={adminToken}
                aria-describedby={authMsg ? 'ac-login-err' : 'ac-login-help'}
                aria-invalid={authMsg ? 'true' : undefined}
                onChange={(e) => applyToken(e.target.value)}
              />
              <button type="button" className="ac-login-eye" aria-pressed={showToken} onClick={() => setShowToken((v) => !v)}>
                {showToken ? '숨기기' : '보기'}
              </button>
            </div>
            {authMsg ? (
              <p id="ac-login-err" role="alert" className="ac-err">{authMsg}</p>
            ) : (
              <p id="ac-login-help" className="ac-rulehint">토큰은 이 브라우저에만 저장되며, 서버에는 확인할 때만 전송됩니다.</p>
            )}
          </div>
          <button type="submit" style={{ ...S.btn, width: '100%', padding: '11px 14px', opacity: authBusy ? 0.6 : 1 }} disabled={authBusy} aria-busy={authBusy || undefined}>
            {authBusy ? '확인 중…' : '로그인'}
          </button>
          {canReturn && (
            <button type="button" className="ac-linkbtn" style={{ width: '100%', marginTop: 8 }} onClick={() => setLoginOpen(false)}>
              로그인하지 않고 돌아가기
            </button>
          )}
          <p className="ac-login-foot">토큰을 모르시면 서비스 운영자에게 문의하세요. 잘못된 토큰을 여러 번 입력하면 잠시 잠깁니다.</p>
        </form>
      </main>
    );
  }

  /** 전역 검색 색인 — 화면에 이미 불러온 목록만 뒤진다(추가 API 호출 없음). 연락처·세션 원문은 색인하지 않는다. */
  const searchAll = (term: string): SearchHit[] => {
    const hits: SearchHit[] = [];
    const take = (list: SearchHit[]) => {
      hits.push(...list.slice(0, SEARCH_PER_KIND));
    };

    take(TAB_GROUPS.flatMap((g) => g.tabs.map(([key, label]) => ({ key, label, group: g.group })))
      .filter(({ key, label, group }) => searchMatch(term, label, TAB_DESC[key], group))
      .map(({ key, label }) => ({
        key: `tab:${key}`,
        kind: '화면' as const,
        title: label,
        detail: TAB_DESC[key],
        run: () => setTab(key),
      })));

    take(tickets
      .filter((t) => searchMatch(term, t.message, t.reason, shortTicket(t.id), HANDOFF_REASON_LABELS[t.reasonCode ?? ''], TICKET_STATUS_LABELS[t.status]))
      .map((t) => ({
        key: `ticket:${t.id}`,
        kind: '상담원 요청' as const,
        title: `${shortTicket(t.id)} · ${TICKET_STATUS_LABELS[t.status]}`,
        detail: clip(t.message),
        run: (from: HTMLElement | null) => { setTab('esc'); setEscFilter('all'); setEscQuery(''); openTicket(t.id, from); },
      })));

    take(recentTurns
      .filter((t) => searchMatch(term, t.message, t.reply, shortSession(t.sessionId)))
      .map((t) => ({
        key: `turn:${t.id}`,
        kind: '최근 대화' as const,
        title: clip(t.message, 48),
        detail: `${timeLabel(t.at)} · 대화 ${shortSession(t.sessionId)} · ${t.escalate ? '상담원 제안' : '자동 응대'}`,
        run: (from: HTMLElement | null) => { setTab('dash'); openDrawer(t.sessionId, from); },
      })));

    take(entries
      .filter((e) => searchMatch(term, e.question, e.answer, e.category, e.keywords.join(' ')))
      .map((e) => ({
        key: `kb:${e.id}`,
        kind: '지식베이스' as const,
        title: clip(e.question, 48),
        detail: `${e.category || '분류 없음'} · ${clip(e.answer, 56)}`,
        run: () => { setTab('kb'); setKbCat(''); setKbQuery(e.question); },
      })));

    take([
      ...customRules
        .filter((r) => searchMatch(term, r.label, r.keywords.join(' '), r.reply))
        .map((r) => ({
          key: `rule:${r.intent}`,
          kind: '시나리오 룰' as const,
          title: r.label,
          detail: `내가 만든 규칙 · ${r.keywords.slice(0, 4).join(', ')}`,
          run: () => { setTab('rules'); setRuleQuery(r.label); },
        })),
      ...rules
        .filter((r) => searchMatch(term, r.label, patternExamples(r.pattern).join(' '), r.effectiveReply))
        .map((r) => ({
          key: `builtin:${r.intent}`,
          kind: '시나리오 룰' as const,
          title: r.label,
          detail: `기본 규칙 · ${patternExamples(r.pattern).slice(0, 4).join(', ')}`,
          run: () => { setTab('rules'); setRuleQuery(r.label); },
        })),
    ]);

    take(accounts
      .filter((a) => searchMatch(term, a.name, a.ownerName, ACCOUNT_STATUS_LABELS[a.status]))
      .map((a) => ({
        key: `account:${a.id}`,
        kind: '고객사' as const,
        title: a.name,
        detail: `${ACCOUNT_STATUS_LABELS[a.status]} · ${a.partnerId ? `${partners.find((p) => p.id === a.partnerId)?.name ?? '이름 없는 파트너'} 귀속` : '직접 계약'}`,
        run: () => { setTab('partner'); setAccountQuery(a.name); },
      })));

    take(partners
      .filter((p) => searchMatch(term, p.name, p.managerName))
      .map((p) => ({
        key: `partner:${p.id}`,
        kind: '파트너' as const,
        title: p.name,
        detail: `파트너 · ${p.status === 'active' ? '운영 중' : '일시 중지'}${p.managerName ? ` · 담당 ${p.managerName}` : ''}`,
        run: () => { setTab('partner'); setAccountQuery(''); setPartnerFormKind('partner'); },
      })));

    return hits.slice(0, SEARCH_MAX);
  };

  const currentLabel = TAB_GROUPS.flatMap((g) => g.tabs).find(([k]) => k === tab)?.[1] ?? '대시보드';

  return (
    <div className="ac-shell">
      {/* 키보드 사용자는 메뉴 10개·전역 검색·인증 버튼을 지나야 본문에 닿는다 — 건너뛰기 링크(DS 5-6). */}
      <a href="#ac-main" className="skip-link">본문 바로가기</a>

      {/* ── 좌측 내비게이션(좁은 화면에서는 상단 가로 스크롤 바) ── */}
      <aside className="ac-side">
        <div className="ac-brand">
          <BrandMark size={30} />
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 14, fontWeight: 800, letterSpacing: '-.01em' }}>GOWON Chat</span>
            <span style={{ display: 'block', fontSize: 10.5, fontWeight: 700, color: 'var(--brand-600)' }}>관리 콘솔</span>
          </span>
        </div>
        <nav aria-label="콘솔 메뉴" className="ac-nav">
          {TAB_GROUPS.map((g) => (
            <div key={g.group} className="ac-navgroup">
              <div className="ac-group">{g.group}</div>
              {g.tabs.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className="ac-navbtn"
                  aria-current={tab === key ? 'page' : undefined}
                  onClick={() => setTab(key)}
                >
                  <NavIcon tab={key} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <div style={{ minWidth: 0 }}>
        {/* ── 상단 헤더: 현재 화면 · 인증 상태 · 관리 토큰 ── */}
        <header className="ac-top">
          <div style={{ minWidth: 0, flex: 1 }}>
            <h1 style={{ fontSize: 19, fontWeight: 800, letterSpacing: '-.02em' }}>{currentLabel}</h1>
            <p style={{ fontSize: 12.5, color: 'var(--sub)', marginTop: 2 }}>{TAB_DESC[tab]}</p>
          </div>
          <GlobalSearch
            search={searchAll}
            // 고객사·파트너는 탭을 열기 전엔 비어 있으므로, 검색을 처음 열 때 한 번 채운다
            onFirstOpen={() => { if (!partnerLoaded && !partnerBusy) loadPartners(''); }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {authInfo && (
              <span
                className="ac-badge"
                data-tone={authInfo.authed ? 'on' : authInfo.tokenConfigured ? 'warn' : 'off'}
                title={authInfo.authed ? '관리 토큰으로 로그인한 상태입니다.' : authInfo.tokenConfigured ? '로그인하면 변경 이력에 관리자 인증이 남습니다.' : '아직 관리자 인증이 설정되지 않아 누구나 열 수 있습니다.'}
              >
                {authInfo.authed ? '로그인됨' : authInfo.tokenConfigured ? '로그인 전' : '인증 미설정'}
              </span>
            )}
            {authInfo?.authed ? (
              <button
                type="button"
                className="ac-linkbtn"
                onClick={() => {
                  applyToken('');
                  setAuthMsg('');
                  setLoginOpen(true);
                }}
              >
                로그아웃
              </button>
            ) : (
              <button type="button" className="ac-linkbtn" onClick={() => { setAuthMsg(''); setLoginOpen(true); }}>
                로그인
              </button>
            )}
          </div>
        </header>
        {offline && (
          <div className="ac-offline" role="status" aria-live="assertive">
            <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M2 2l20 20" /><path d="M8.5 16.4a5 5 0 0 1 7 0" /><path d="M5 12.9a10 10 0 0 1 4.2-2.5" /><path d="M12 8a14 14 0 0 1 10 4.1" /><circle cx="12" cy="20" r=".8" /></svg>
            인터넷 연결이 끊겼습니다. 화면은 볼 수 있지만 저장·새로고침은 연결이 돌아온 뒤에 됩니다.
          </div>
        )}

        <main id="ac-main" ref={mainRef} tabIndex={-1} aria-label={currentLabel} className="ac-body">
      {tab === 'dash' && (
        <>
          <section style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            <h2 style={{ ...S.h2, marginRight: 'auto' }}>오늘의 응대 현황</h2>
            <button style={S.btnGhost} onClick={loadEsc}>새로고침</button>
            <button style={S.btnGhost} onClick={downloadLogsCsv}>대화 기록 내려받기</button>
            <button style={S.btnGhost} onClick={downloadBackup}>백업 내려받기</button>
            <button style={S.btnGhost} onClick={() => restoreInputRef.current?.click()}>백업 복원</button>
            <input
              ref={restoreInputRef}
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              aria-label="복원할 백업 파일 선택"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) restoreBackup(f);
                e.target.value = '';
              }}
            />
          </section>

          {/* ── KPI 4 — 값이 없으면 0을 지어내지 않고 「측정 중」 ── */}
          {stats ? (
            <div className="ac-kpi" style={{ marginBottom: 16 }}>
              <KpiCard
                label="오늘 대화"
                value={`${(stats.conversation.today?.turns ?? 0).toLocaleString('ko-KR')}건`}
                note={`대화 상대 ${(stats.conversation.today?.sessions ?? 0).toLocaleString('ko-KR')}명 · 보관 중 ${stats.conversation.totalTurns.toLocaleString('ko-KR')}건`}
              />
              <KpiCard
                label="자동완결률"
                value={stats.conversation.totalTurns > 0 ? `${Math.round(stats.conversation.autoRate * 100)}%` : MEASURING}
                empty={stats.conversation.totalTurns === 0}
                note={
                  stats.conversation.totalTurns > 0
                    ? `등록된 안내 자료·규칙으로 바로 답한 비율 (${stats.conversation.autoHandled.toLocaleString('ko-KR')}/${stats.conversation.totalTurns.toLocaleString('ko-KR')})`
                    : '대화가 쌓이면 계산됩니다.'
                }
              />
              <KpiCard
                label="상담원 전환"
                value={`${(stats.conversation.today?.escalated ?? 0).toLocaleString('ko-KR')}건`}
                note={`접수 대기 ${stats.escalation.open.toLocaleString('ko-KR')}건 · 누적 접수 ${stats.escalation.total.toLocaleString('ko-KR')}건`}
              />
              <KpiCard
                label="평균 응답 시간"
                value={typeof stats.conversation.avgLatencyMs === 'number' ? latencyLabel(stats.conversation.avgLatencyMs) : MEASURING}
                empty={typeof stats.conversation.avgLatencyMs !== 'number'}
                note={
                  typeof stats.conversation.avgLatencyMs === 'number'
                    ? `서버가 답을 만드는 데 걸린 시간 · 최근 ${(stats.conversation.latencySamples ?? 0).toLocaleString('ko-KR')}건 평균`
                    : '대화가 쌓이면 서버 처리 시간 기준으로 계산됩니다.'
                }
              />
            </div>
          ) : (
            <div className="ac-kpi" style={{ marginBottom: 16 }} aria-busy="true">
              {['오늘 대화', '자동완결률', '상담원 전환', '평균 응답 시간'].map((k) => (
                <KpiCard key={k} label={k} value="" loading note={phase.esc === 'error' ? '현황을 불러오지 못했습니다.' : '현황을 불러오는 중입니다.'} />
              ))}
            </div>
          )}

          {!stats && phase.esc === 'error' && (
            <section style={S.card}>
              <LoadState phase="error" busy="" fail="현황을 불러오지 못했습니다" onRetry={loadEsc} />
            </section>
          )}

          {!stats && phase.esc !== 'error' && (
            <section style={S.card} aria-busy="true">
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
                <h2 style={S.h2}>최근 7일 대화량</h2>
                <span style={S.tag}>보관 중인 기록 기준</span>
              </div>
              <div className="ac-skelchart" role="status" aria-live="polite">
                <span className="ac-srhide">현황을 불러오는 중입니다</span>
                {[46, 70, 58, 92, 64, 80, 52].map((h, i) => <Skeleton key={i} h={h} style={{ height: `${h}%` }} />)}
              </div>
            </section>
          )}

          {/* ── 최근 7일 대화량 ── */}
          {stats && (
            <section style={S.card}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
                <h2 style={S.h2}>최근 7일 대화량</h2>
                <span style={S.tag}>보관 중인 기록 기준</span>
              </div>
              {stats.conversation.daily && stats.conversation.daily.some((d) => d.turns > 0) ? (
                <TrendChart daily={stats.conversation.daily} />
              ) : (
                <p style={{ fontSize: 13.5, color: 'var(--mut)' }}>
                  {MEASURING} — 최근 7일 안에 기록된 대화가 없습니다. 위젯이나 「응답 테스트」에서 대화하면 여기에 쌓입니다.
                </p>
              )}
            </section>
          )}

          {/* ── 무엇을 많이 묻는가 ── */}
          {stats && (
            <section style={S.card}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
                <h2 style={S.h2}>많이 묻는 주제</h2>
                <span style={S.tag}>상위 {stats.conversation.topIntents.length || 0}개</span>
              </div>
              {stats.conversation.topIntents.length > 0 ? (
                stats.conversation.topIntents.map((t) => {
                  const max = stats.conversation.topIntents[0].count || 1;
                  return (
                    <div key={t.intent} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                      <span style={{ width: 150, fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {INTENT_LABELS[t.intent] || t.intent}
                      </span>
                      <div style={{ flex: 1, background: 'var(--brand-50)', borderRadius: 999, height: 10, minWidth: 60 }}>
                        <div style={{ width: `${Math.max(6, Math.round((t.count / max) * 100))}%`, background: 'var(--brand)', borderRadius: 999, height: 10 }} />
                      </div>
                      <span style={{ ...S.tag, width: 40, textAlign: 'right' }}>{t.count}건</span>
                    </div>
                  );
                })
              ) : (
                <p style={{ fontSize: 13.5, color: 'var(--mut)' }}>{MEASURING} — 아직 집계할 대화가 없습니다.</p>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
                {Object.entries(stats.conversation.bySource).map(([k, v]) => (
                  <span key={k} className="ac-pill">{SOURCE_VIEW_LABELS[k] || k} {v}건</span>
                ))}
                {Object.entries(stats.conversation.byChannel).map(([k, v]) => (
                  <span key={k} className="ac-pill">{CHANNEL_LABELS[k] || k} {v}건</span>
                ))}
              </div>
            </section>
          )}

          {/* ── 최근 대화 ── */}
          <section style={S.card}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
              <h2 style={S.h2}>최근 대화</h2>
              <span style={S.tag}>최대 30건</span>
            </div>
            {recentTurns.length === 0 && phase.esc !== 'done' ? (
              <LoadState phase={phase.esc} busy="최근 대화를 불러오는 중입니다" fail="최근 대화를 불러오지 못했습니다" onRetry={loadEsc} rows={5} />
            ) : recentTurns.length === 0 ? (
              <div className="ac-empty">
                <EmptyArt kind="chat" />
                <p style={{ fontSize: 14, fontWeight: 700 }}>아직 기록된 대화가 없습니다</p>
                <p style={{ fontSize: 13, color: 'var(--mut)', marginTop: 4 }}>홈페이지의 상담창이나 「응답 테스트」에서 대화하면 여기에 쌓입니다.</p>
                <button type="button" style={{ ...S.btnGhost, marginTop: 12 }} onClick={() => setTab('test')}>응답 테스트 열기</button>
              </div>
            ) : (
              <ul className="ac-rows" aria-label="최근 대화 목록">
                {recentTurns.map((t) => (
                  <li key={t.id}>
                  <button
                    type="button"
                    className="ac-row"
                    aria-haspopup="dialog"
                    onClick={(e) => openDrawer(t.sessionId, e.currentTarget)}
                  >
                    <span className="ac-row-main">
                      <span className="ac-row-msg">{t.message}</span>
                      <span className="ac-row-reply">{t.reply}</span>
                    </span>
                    <span className="ac-row-side">
                      <span style={{ fontSize: 11.5, color: 'var(--mut)', whiteSpace: 'nowrap' }}>{timeLabel(t.at)}</span>
                      <span className="ac-pill">{INTENT_LABELS[t.intent] || t.intent}</span>
                      <span className="ac-pill">{SOURCE_VIEW_LABELS[t.source] || t.source}</span>
                      {t.escalate && <span className="ac-pill" style={{ background: '#FFFBEB', color: 'var(--warn)' }}>상담원 제안</span>}
                    </span>
                  </button>
                  </li>
                ))}
              </ul>
            )}
            <p style={{ ...S.tag, marginTop: 12 }}>
              대화 기록은 최근 분량만 보관합니다. 오래 보관하려면 위의 「대화 기록 내려받기」를 이용해 주세요.
            </p>
          </section>
        </>
      )}

      {tab === 'kb' && (() => {
        const q = kbQuery.trim().toLowerCase();
        const cats = Array.from(new Set(entries.map((e) => e.category).filter(Boolean))).sort();
        const shown = entries.filter((e) => {
          if (kbCat && e.category !== kbCat) return false;
          if (!q) return true;
          return [e.question, e.answer, e.category, e.id, e.keywords.join(' '), e.source || ''].join(' ').toLowerCase().includes(q);
        });
        return (
        <>
          <div className="ac-split">
            {/* ── 좌: 검색·필터 + 표 ── */}
            <div style={{ minWidth: 0 }}>
              <section style={{ ...S.card, padding: 0, overflow: 'hidden' }} aria-labelledby="ac-kb-list">
                <div className="ac-toolbar">
                  <h2 id="ac-kb-list" style={{ ...S.h2, marginRight: 'auto' }}>안내 자료 <span style={{ fontSize: 12.5, color: 'var(--mut)', fontWeight: 600 }}>{shown.length}/{entries.length}건</span></h2>
                  <label htmlFor="ac-kb-q" className="ac-srhide">검색</label>
                  <input
                    id="ac-kb-q"
                    className="ac-search"
                    type="search"
                    placeholder="질문·답변·키워드 검색"
                    value={kbQuery}
                    onChange={(e) => setKbQuery(e.target.value)}
                  />
                  <label htmlFor="ac-kb-cat" className="ac-srhide">카테고리</label>
                  <select id="ac-kb-cat" className="ac-select" value={kbCat} onChange={(e) => setKbCat(e.target.value)}>
                    <option value="">모든 카테고리</option>
                    {cats.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                {entries.length === 0 && phase.kb !== 'done' ? (
                  <LoadState phase={phase.kb} busy="안내 자료를 불러오는 중입니다" fail="안내 자료를 불러오지 못했습니다" onRetry={loadKB} rows={5} />
                ) : entries.length === 0 ? (
                  <div className="ac-empty">
                    <EmptyArt kind="kb" />
                    <p style={{ fontSize: 14, fontWeight: 700 }}>등록된 안내 자료가 없습니다</p>
                    <p style={{ fontSize: 13, color: 'var(--mut)', marginTop: 4 }}>오른쪽 폼에서 질문과 답변을 넣거나, 아래에서 문서를 붙여넣어 한 번에 만드세요.</p>
                    <button type="button" style={{ ...S.btnGhost, marginTop: 12 }} onClick={resetAll}>기본 자료 불러오기</button>
                  </div>
                ) : shown.length === 0 ? (
                  <div className="ac-empty">
                    <p style={{ fontSize: 14, fontWeight: 700 }}>검색 결과가 없습니다</p>
                    <p style={{ fontSize: 13, color: 'var(--mut)', marginTop: 4 }}>다른 말로 검색하거나 카테고리 필터를 풀어 보세요.</p>
                    <button type="button" style={{ ...S.btnGhost, marginTop: 12 }} onClick={() => { setKbQuery(''); setKbCat(''); }}>필터 지우기</button>
                  </div>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table className="ac-table">
                      <thead>
                        <tr>
                          <th scope="col" style={{ width: 96 }}>카테고리</th>
                          <th scope="col">질문 · 답변</th>
                          <th scope="col" style={{ width: 160 }} className="ac-col-wide">키워드</th>
                          <th scope="col" style={{ width: 116 }}><span className="ac-srhide">작업</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((e) => (
                          <tr key={e.id} data-editing={editingId === e.id ? 'true' : undefined}>
                            <td><span className="ac-pill">{e.category || '미분류'}</span></td>
                            <td style={{ minWidth: 220 }}>
                              <div style={{ fontWeight: 700, color: 'var(--ink)' }}>{e.question}</div>
                              <div className="ac-clamp" style={{ fontSize: 12.5, color: 'var(--sub)', marginTop: 3 }}>{e.answer}</div>
                              {e.source && <div style={{ fontSize: 11.5, color: 'var(--mut)', marginTop: 3 }}>출처 · {e.source}</div>}
                            </td>
                            <td className="ac-col-wide" style={{ fontSize: 12, color: 'var(--sub)' }}>{e.keywords.join(', ')}</td>
                            <td>
                              <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                                <button type="button" className="ac-linkbtn" onClick={() => editKB(e)} aria-label={`수정: ${e.question}`}>수정</button>
                                <button type="button" className="ac-linkbtn" data-tone="danger" onClick={() => removeKB(e.id)} aria-label={`삭제: ${e.question}`}>삭제</button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

          <section style={S.card} aria-labelledby="ac-kb-import">
            <h2 id="ac-kb-import" style={{ ...S.h2, marginBottom: 6 }}>문서로 안내 자료 만들기</h2>
            <p style={{ fontSize: 12.5, color: 'var(--mut)', marginBottom: 10 }}>
              안내문·약관·매뉴얼 텍스트를 붙여넣으면 제목·문단 단위로 잘라 FAQ 후보를 만듭니다. 미리보기로 확인한 뒤 등록하세요.
              등록된 항목은 답변에 <strong>출처(근거)</strong>가 함께 표시됩니다. 키워드는 자동 추출값이므로 등록 후 보정하는 것을 권장합니다.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8 }}>
              <input style={S.input} placeholder="문서명(출처로 표시됨, 예: 2026 이용안내)" value={imp.title} onChange={(e) => setImp({ ...imp, title: e.target.value })} />
              <input style={S.input} placeholder="카테고리" value={imp.category} onChange={(e) => setImp({ ...imp, category: e.target.value })} />
              <input style={S.input} placeholder="청크 길이(120~2000)" value={imp.maxChars} onChange={(e) => setImp({ ...imp, maxChars: e.target.value })} />
            </div>
            <textarea
              style={{ ...S.input, minHeight: 150, fontFamily: 'inherit' }}
              placeholder={'문서 본문을 붙여넣으세요.\n# 제목, ## 소제목, "1. 항목", "제1조" 형식을 구분 기준으로 인식합니다.'}
              value={imp.text}
              onChange={(e) => setImp({ ...imp, text: e.target.value })}
            />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button style={S.btnGhost} disabled={impBusy} onClick={() => runImport(false)}>미리보기</button>
              <button style={S.btn} disabled={impBusy || !candidates} onClick={() => runImport(true)}>등록</button>
              {candidates && (
                <button style={S.btnGhost} onClick={() => setCandidates(null)}>미리보기 지우기</button>
              )}
              <span style={{ ...S.tag, marginLeft: 'auto' }}>{imp.text.length.toLocaleString()}자</span>
            </div>
            {candidates && (
              <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
                <div style={{ ...S.tag, marginBottom: 6 }}>후보 {candidates.length}개</div>
                {candidates.map((c) => (
                  <div key={c.id} style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', padding: 10, marginBottom: 8 }}>
                    <div style={S.tag}>#{c.chunkIndex} · {c.id} · 출처: {c.source}</div>
                    <strong style={{ fontSize: 14 }}>{c.question}</strong>
                    <p style={{ fontSize: 13, color: 'var(--sub)', margin: '5px 0', whiteSpace: 'pre-wrap' }}>{c.answer}</p>
                    <div style={S.tag}>키워드: {c.keywords.join(', ')}</div>
                  </div>
                ))}
              </div>
            )}
          </section>
            </div>

            {/* ── 우: 편집 폼(스티키) ── */}
            <div ref={kbFormRef} style={{ minWidth: 0 }}>
              <section className="ac-sticky" style={S.card} aria-labelledby="ac-kb-form">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <h2 id="ac-kb-form" style={{ ...S.h2, marginRight: 'auto' }}>{editingId ? '자료 수정' : '새 자료 추가'}</h2>
                  {editingId && <span className="ac-pill">{editingId}</span>}
                </div>
                <div className="ac-field">
                  <label htmlFor="kb-category">카테고리</label>
                  <input id="kb-category" style={S.input} placeholder="예: 요금" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
                </div>
                <div className="ac-field">
                  <label htmlFor="kb-question">대표 질문 <span aria-hidden="true" style={{ color: 'var(--danger)' }}>*</span></label>
                  <input
                    id="kb-question"
                    style={{ ...S.input, ...(kbErr.question ? { borderColor: 'var(--danger)' } : {}) }}
                    placeholder="고객이 묻는 말 그대로"
                    value={form.question}
                    aria-required="true"
                    aria-invalid={kbErr.question ? 'true' : undefined}
                    aria-describedby={kbErr.question ? 'kb-question-err' : undefined}
                    onChange={(e) => { setForm({ ...form, question: e.target.value }); if (kbErr.question) setKbErr({ ...kbErr, question: undefined }); }}
                  />
                  {kbErr.question && <p id="kb-question-err" className="ac-err">{kbErr.question}</p>}
                </div>
                <div className="ac-field">
                  <label htmlFor="kb-keywords">키워드 <span style={{ color: 'var(--mut)', fontWeight: 500 }}>(쉼표로 구분)</span></label>
                  <input id="kb-keywords" style={S.input} placeholder="예: 요금, 가격, 얼마" value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} />
                </div>
                <div className="ac-field">
                  <label htmlFor="kb-answer">답변 <span aria-hidden="true" style={{ color: 'var(--danger)' }}>*</span></label>
                  <textarea
                    id="kb-answer"
                    style={{ ...S.input, minHeight: 110, ...(kbErr.answer ? { borderColor: 'var(--danger)' } : {}) }}
                    placeholder="고객에게 그대로 나가는 문장입니다."
                    value={form.answer}
                    aria-required="true"
                    aria-invalid={kbErr.answer ? 'true' : undefined}
                    aria-describedby={kbErr.answer ? 'kb-answer-err' : undefined}
                    onChange={(e) => { setForm({ ...form, answer: e.target.value }); if (kbErr.answer) setKbErr({ ...kbErr, answer: undefined }); }}
                  />
                  {kbErr.answer && <p id="kb-answer-err" className="ac-err">{kbErr.answer}</p>}
                </div>
                {!editingId && (
                  <details style={{ marginBottom: 10 }}>
                    <summary style={{ fontSize: 12.5, color: 'var(--mut)', cursor: 'pointer' }}>고급: 식별자 직접 지정</summary>
                    <div className="ac-field" style={{ marginTop: 8 }}>
                      <label htmlFor="kb-id">식별자 <span style={{ color: 'var(--mut)', fontWeight: 500 }}>(비우면 자동 생성)</span></label>
                      <input id="kb-id" style={S.input} value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} />
                    </div>
                  </details>
                )}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button type="button" style={{ ...S.btn, opacity: kbBusy ? 0.6 : 1 }} onClick={submitKB} disabled={kbBusy} aria-busy={kbBusy || undefined}>
                    {kbBusy ? '저장 중…' : editingId ? '수정 저장' : '추가'}
                  </button>
                  {editingId && (
                    <button
                      type="button"
                      style={S.btnGhost}
                      onClick={() => {
                        setEditingId(null);
                        setForm(EMPTY_FORM);
                        setKbErr({});
                      }}
                    >
                      취소
                    </button>
                  )}
                </div>
                <p style={{ ...S.tag, marginTop: 12 }}>저장하면 바로 상담창 답변에 반영되고, 답변 아래에 출처로 표시됩니다.</p>
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
                  <button type="button" className="ac-linkbtn" onClick={resetAll}>기본 자료로 초기화</button>
                </div>
              </section>
            </div>
          </div>
        </>
        );
      })()}

      {tab === 'rules' && (() => {
        const q = ruleQuery.trim().toLowerCase();
        const hit = (s: string) => !q || s.toLowerCase().includes(q);
        const shownCustom = customRules.filter((r) => hit([r.label, r.keywords.join(' '), r.reply].join(' ')));
        const shownBuiltin = rules.filter((r) => hit([r.label, r.pattern, r.effectiveReply].join(' ')));
        const formKeywords = splitKeywords(crForm.keywords);
        const probeHits = probeKeywords(ruleProbe, formKeywords);
        const onEdit = (r: CustomRuleView) => {
          setCrEditing(r.intent);
          setCrForm({ label: r.label, keywords: r.keywords.join(', '), reply: r.reply, escalate: r.escalate });
          setCrErr({});
          ruleFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        };
        return (
        <div className="ac-split">
          {/* ── 좌: 규칙 카드 목록(조건 → 응답) ── */}
          <div style={{ minWidth: 0 }}>
            <section style={{ ...S.card, padding: 0, overflow: 'hidden' }} aria-labelledby="ac-rule-custom">
              <div className="ac-toolbar">
                <h2 id="ac-rule-custom" style={{ ...S.h2, marginRight: 'auto' }}>내가 만든 규칙 <span style={{ fontSize: 12.5, color: 'var(--mut)', fontWeight: 600 }}>{shownCustom.length}/{customRules.length}건</span></h2>
                <label htmlFor="ac-rule-q" className="ac-srhide">규칙 검색</label>
                <input id="ac-rule-q" className="ac-search" type="search" placeholder="이름·표현·답변 검색" value={ruleQuery} onChange={(e) => setRuleQuery(e.target.value)} />
              </div>
              <p style={{ ...S.tag, padding: '10px 16px 0' }}>고객 말에 아래 표현이 들어 있으면 정해진 답을 보냅니다. 기본 규칙 다음, 안내 자료 검색 이전에 적용됩니다.</p>
              {customRules.length === 0 ? (
                <div className="ac-empty">
                  <svg width="72" height="56" viewBox="0 0 72 56" aria-hidden="true" fill="none" stroke="var(--line-2)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="4" y="10" width="26" height="18" rx="6" />
                    <path d="M30 19h10m0 0-4-4m4 4-4 4" stroke="var(--brand)" />
                    <rect x="42" y="10" width="26" height="18" rx="6" />
                    <path d="M12 18h10M50 18h10" />
                    <rect x="20" y="36" width="32" height="14" rx="6" strokeDasharray="3 3" />
                  </svg>
                  <p style={{ fontSize: 14, fontWeight: 700, marginTop: 8 }}>아직 만든 규칙이 없습니다</p>
                  <p style={{ fontSize: 13, color: 'var(--sub)', marginTop: 4 }}>오른쪽에서 「고객이 쓰는 표현 → 답변」을 정하면 바로 상담창에 적용됩니다.</p>
                </div>
              ) : shownCustom.length === 0 ? (
                <div className="ac-empty">
                  <p style={{ fontSize: 14, fontWeight: 700 }}>검색 결과가 없습니다</p>
                  <button type="button" className="ac-linkbtn" onClick={() => setRuleQuery('')}>검색 지우기</button>
                </div>
              ) : (
                <ul className="ac-rulelist">
                  {shownCustom.map((r) => (
                    <li key={r.intent} className="ac-rulecard" data-editing={crEditing === r.intent ? 'true' : undefined} data-off={r.enabled ? undefined : 'true'}>
                      <div className="ac-rulehead">
                        <strong className="ac-rulename">{r.label}</strong>
                        {r.escalate && <span className="ac-pill" style={{ background: '#FFFBEB', color: 'var(--warn)' }}>상담원 연결</span>}
                        <button
                          type="button"
                          role="switch"
                          aria-checked={r.enabled}
                          aria-label={`${r.label} 규칙 ${r.enabled ? '사용 중' : '사용 안 함'}`}
                          className="ac-switch"
                          onClick={() => toggleCustomRule(r)}
                        >
                          <span className="ac-switch-knob" aria-hidden="true" />
                        </button>
                      </div>
                      <div className="ac-ruleflow">
                        <div className="ac-rulecond">
                          <span className="ac-rulekey">고객이 이렇게 말하면</span>
                          <div className="ac-chips">
                            {r.keywords.map((k) => <span key={k} className="ac-chip">{k}</span>)}
                          </div>
                        </div>
                        <span className="ac-rulearrow" aria-hidden="true">→</span>
                        <div className="ac-rulereply">
                          <span className="ac-rulekey">이렇게 답합니다</span>
                          <p className="ac-clamp">{r.reply}</p>
                        </div>
                      </div>
                      <div className="ac-ruleactions">
                        <button type="button" className="ac-linkbtn" onClick={() => onEdit(r)}>수정</button>
                        <button type="button" className="ac-linkbtn" data-tone="danger" onClick={() => removeCustomRule(r.intent)}>삭제</button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section style={{ ...S.card, padding: 0, overflow: 'hidden' }} aria-labelledby="ac-rule-builtin">
              <div className="ac-toolbar">
                <h2 id="ac-rule-builtin" style={{ ...S.h2, marginRight: 'auto' }}>기본 규칙 <span style={{ fontSize: 12.5, color: 'var(--mut)', fontWeight: 600 }}>{shownBuiltin.length}/{rules.length}건</span></h2>
              </div>
              <p style={{ ...S.tag, padding: '10px 16px 0' }}>인사·요금·상담원 연결처럼 어느 상담에나 필요한 규칙입니다. 켜고 끄거나 답변 문구만 바꿀 수 있고, 조건은 바꿀 수 없습니다.</p>
              {rules.length === 0 ? (
                <LoadState phase={phase.rules === 'done' ? 'error' : phase.rules} busy="규칙을 불러오는 중입니다" fail="규칙을 불러오지 못했습니다" onRetry={loadRules} rows={4} />
              ) : shownBuiltin.length === 0 ? (
                <div className="ac-empty">
                  <p style={{ fontSize: 14, fontWeight: 700 }}>검색 결과가 없습니다</p>
                  <button type="button" className="ac-linkbtn" onClick={() => setRuleQuery('')}>검색 지우기</button>
                </div>
              ) : (
                <ul className="ac-rulelist">
                  {shownBuiltin.map((r) => {
                    const ex = patternExamples(r.pattern);
                    return (
                      <li key={r.intent} className="ac-rulecard" data-off={r.enabled ? undefined : 'true'}>
                        <div className="ac-rulehead">
                          <strong className="ac-rulename">{r.label}</strong>
                          {r.escalate && <span className="ac-pill" style={{ background: '#FFFBEB', color: 'var(--warn)' }}>상담원 연결</span>}
                          {r.replyOverride && <span className="ac-pill">답변 수정됨</span>}
                          <button
                            type="button"
                            role="switch"
                            aria-checked={r.enabled}
                            aria-label={`${r.label} 규칙 ${r.enabled ? '사용 중' : '사용 안 함'}`}
                            className="ac-switch"
                            onClick={() => patchRule(r.intent, { enabled: !r.enabled })}
                          >
                            <span className="ac-switch-knob" aria-hidden="true" />
                          </button>
                        </div>
                        <div className="ac-ruleflow">
                          <div className="ac-rulecond">
                            <span className="ac-rulekey">예를 들어</span>
                            <div className="ac-chips">
                              {ex.map((k) => <span key={k} className="ac-chip">{k}</span>)}
                              {ex.length === 6 && <span className="ac-chip" style={{ color: 'var(--mut)' }}>…</span>}
                            </div>
                          </div>
                          <span className="ac-rulearrow" aria-hidden="true">→</span>
                          <div className="ac-rulereply">
                            <label htmlFor={`ac-rule-reply-${r.intent}`} className="ac-rulekey">이렇게 답합니다</label>
                            <textarea
                              id={`ac-rule-reply-${r.intent}`}
                              className="ac-rulereply-input"
                              defaultValue={r.effectiveReply}
                              rows={2}
                              onBlur={(ev) => {
                                const v = ev.target.value.trim();
                                if (v !== r.effectiveReply) patchRule(r.intent, { reply: v === r.defaultReply ? null : v });
                              }}
                            />
                            <span className="ac-rulehint">입력칸을 벗어나면 저장됩니다.</span>
                          </div>
                        </div>
                        {r.replyOverride && (
                          <div className="ac-ruleactions">
                            <button type="button" className="ac-linkbtn" onClick={() => patchRule(r.intent, { reply: null })}>기본 답변으로 되돌리기</button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>

          {/* ── 우: 규칙 만들기(조건 → 응답) + 미리보기 ── */}
          <div ref={ruleFormRef} style={{ minWidth: 0 }}>
            <section className="ac-sticky" style={S.card} aria-labelledby="ac-rule-form">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <h2 id="ac-rule-form" style={{ ...S.h2, marginRight: 'auto' }}>{crEditing ? '규칙 수정' : '새 규칙 만들기'}</h2>
                {crEditing && <span className="ac-pill">수정 중</span>}
              </div>

              <div className="ac-field">
                <label htmlFor="cr-label">규칙 이름 <span aria-hidden="true" style={{ color: 'var(--danger)' }}>*</span></label>
                <input
                  id="cr-label"
                  style={{ ...S.input, ...(crErr.label ? { borderColor: 'var(--danger)' } : {}) }}
                  placeholder="예: 배송 문의"
                  value={crForm.label}
                  aria-required="true"
                  aria-invalid={crErr.label ? 'true' : undefined}
                  aria-describedby={crErr.label ? 'cr-label-err' : undefined}
                  onChange={(e) => { setCrForm({ ...crForm, label: e.target.value }); if (crErr.label) setCrErr({ ...crErr, label: undefined }); }}
                />
                {crErr.label && <p id="cr-label-err" className="ac-err">{crErr.label}</p>}
              </div>

              <div className="ac-step">
                <span className="ac-stepno" aria-hidden="true">1</span>
                <div className="ac-field" style={{ flex: 1, marginBottom: 0 }}>
                  <label htmlFor="cr-keywords">고객이 이렇게 말하면 <span aria-hidden="true" style={{ color: 'var(--danger)' }}>*</span> <span style={{ color: 'var(--mut)', fontWeight: 500 }}>(쉼표로 구분)</span></label>
                  <input
                    id="cr-keywords"
                    style={{ ...S.input, ...(crErr.keywords ? { borderColor: 'var(--danger)' } : {}) }}
                    placeholder="예: 배송, 택배, 언제 와"
                    value={crForm.keywords}
                    aria-required="true"
                    aria-invalid={crErr.keywords ? 'true' : undefined}
                    aria-describedby={crErr.keywords ? 'cr-keywords-err' : 'cr-keywords-help'}
                    onChange={(e) => { setCrForm({ ...crForm, keywords: e.target.value }); if (crErr.keywords) setCrErr({ ...crErr, keywords: undefined }); }}
                  />
                  {crErr.keywords ? (
                    <p id="cr-keywords-err" className="ac-err">{crErr.keywords}</p>
                  ) : (
                    <p id="cr-keywords-help" className="ac-rulehint">한 표현만 들어 있어도 규칙이 적용됩니다.</p>
                  )}
                  {formKeywords.length > 0 && (
                    <div className="ac-chips" style={{ marginTop: 6 }} aria-label="입력한 표현">
                      {formKeywords.map((k) => <span key={k} className="ac-chip" data-hit={probeHits.includes(k) ? 'true' : undefined}>{k}</span>)}
                    </div>
                  )}
                </div>
              </div>

              <div className="ac-step">
                <span className="ac-stepno" aria-hidden="true">2</span>
                <div className="ac-field" style={{ flex: 1, marginBottom: 0 }}>
                  <label htmlFor="cr-reply">이렇게 답합니다 <span aria-hidden="true" style={{ color: 'var(--danger)' }}>*</span></label>
                  <textarea
                    id="cr-reply"
                    style={{ ...S.input, minHeight: 90, ...(crErr.reply ? { borderColor: 'var(--danger)' } : {}) }}
                    placeholder="고객에게 그대로 나가는 문장입니다."
                    value={crForm.reply}
                    aria-required="true"
                    aria-invalid={crErr.reply ? 'true' : undefined}
                    aria-describedby={crErr.reply ? 'cr-reply-err' : undefined}
                    onChange={(e) => { setCrForm({ ...crForm, reply: e.target.value }); if (crErr.reply) setCrErr({ ...crErr, reply: undefined }); }}
                  />
                  {crErr.reply && <p id="cr-reply-err" className="ac-err">{crErr.reply}</p>}
                  <label className="ac-check">
                    <input type="checkbox" checked={crForm.escalate} onChange={(e) => setCrForm({ ...crForm, escalate: e.target.checked })} />
                    <span>답변 뒤에 상담원 접수를 안내합니다<span className="ac-rulehint" style={{ display: 'block' }}>접수번호를 발급하고 연락처를 받습니다.</span></span>
                  </label>
                </div>
              </div>

              {/* 미리보기: 시험 문장 → 규칙 적용 여부 + 고객에게 보일 말풍선 */}
              <div className="ac-rulepreview" aria-labelledby="ac-rule-pv">
                <div className="ac-field" style={{ marginBottom: 8 }}>
                  <label id="ac-rule-pv" htmlFor="cr-probe">미리보기 — 고객이 보낼 말을 적어 보세요</label>
                  <input id="cr-probe" style={S.input} placeholder="예: 택배가 언제 오나요?" value={ruleProbe} onChange={(e) => setRuleProbe(e.target.value)} />
                </div>
                <div className="ac-pv-mini" role="log" aria-live="polite">
                  {ruleProbe.trim() && <div className="ac-pv-user">{ruleProbe.trim()}</div>}
                  {ruleProbe.trim() && probeHits.length > 0 && crForm.reply.trim() ? (
                    <div className="ac-pv-bot">
                      {crForm.reply.trim()}
                      <span className="ac-pv-cite">「{probeHits[0]}」 표현으로 이 규칙이 적용됩니다{crForm.escalate ? ' · 이어서 상담원 접수 안내' : ''}</span>
                    </div>
                  ) : ruleProbe.trim() ? (
                    <p className="ac-pv-note">{probeHits.length === 0 ? '이 문장에는 입력한 표현이 없어 규칙이 적용되지 않습니다.' : '답변을 입력하면 말풍선으로 보여 드립니다.'}</p>
                  ) : (
                    <p className="ac-pv-note">문장을 입력하면 이 규칙이 적용되는지 바로 확인할 수 있습니다.</p>
                  )}
                </div>
                <p className="ac-rulehint" style={{ marginTop: 6 }}>여기서는 표현 포함 여부만 봅니다. 기본 규칙·안내 자료까지 합친 최종 답은 「응답 테스트」에서 확인하세요.</p>
              </div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                <button type="button" style={{ ...S.btn, opacity: crBusy ? 0.6 : 1 }} onClick={submitCustomRule} disabled={crBusy} aria-busy={crBusy || undefined}>
                  {crBusy ? '저장 중…' : crEditing ? '수정 저장' : '규칙 추가'}
                </button>
                {crEditing && (
                  <button type="button" style={S.btnGhost} onClick={() => { setCrEditing(null); setCrForm(EMPTY_CR_FORM); setCrErr({}); }}>
                    취소
                  </button>
                )}
              </div>
            </section>
          </div>
        </div>
        );
      })()}

      {tab === 'esc' && (() => {
        const counts = { open: 0, in_progress: 0, resolved: 0, canceled: 0 } as Record<TicketView['status'], number>;
        for (const t of tickets) counts[t.status] += 1;
        const q = escQuery.trim().toLowerCase();
        const filtered = tickets
          .filter((t) => escFilter === 'all' || t.status === escFilter)
          .filter((t) => !q || [t.message, t.reason, t.id, HANDOFF_REASON_LABELS[t.reasonCode ?? ''] ?? ''].some((v) => (v ?? '').toLowerCase().includes(q)))
          .slice()
          .sort((x, y) => new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime());
        const turnsTotal = stats?.conversation.totalTurns ?? 0;
        const autoRate = stats && turnsTotal > 0 ? `${Math.round(stats.conversation.autoRate * 100)}%` : MEASURING;
        const FILTERS: { key: 'all' | TicketView['status']; label: string; n: number }[] = [
          { key: 'all', label: '전체', n: tickets.length },
          { key: 'open', label: '대기', n: counts.open },
          { key: 'in_progress', label: '상담 중', n: counts.in_progress },
          { key: 'resolved', label: '완료', n: counts.resolved },
          { key: 'canceled', label: '취소', n: counts.canceled },
        ];
        const nextAction = (t: TicketView): { label: string; status: TicketView['status']; primary: boolean } =>
          t.status === 'open' ? { label: '상담 시작', status: 'in_progress', primary: true }
          : t.status === 'in_progress' ? { label: '완료', status: 'resolved', primary: true }
          : { label: '다시 열기', status: 'open', primary: false };
        const ticketsPersisted = storage?.namespaces.find((n) => n.ns === 'tickets')?.persisted ?? null;
        return (
          <>
            <div className="ac-kpi" style={{ marginBottom: 16 }}>
              <KpiCard label="대기 중" value={String(counts.open)} note="아직 상담을 시작하지 않은 요청" />
              <KpiCard label="상담 중" value={String(counts.in_progress)} note="상담원이 응대하고 있는 요청" />
              <KpiCard label="완료" value={String(counts.resolved)} note={`취소 ${counts.canceled}건 별도`} />
              <KpiCard label="자동 응대 완료율" value={autoRate} empty={autoRate === MEASURING} note={turnsTotal > 0 ? `전체 ${turnsTotal}쌍 중 ${stats?.conversation.autoHandled ?? 0}쌍은 챗봇이 마무리` : '대화가 쌓이면 계산합니다'} />
            </div>

            <section style={{ ...S.card, padding: 0 }} aria-labelledby="esc-h">
              <div className="ac-toolbar">
                <h2 id="esc-h" style={{ ...S.h2, marginRight: 4 }}>요청 목록</h2>
                <div role="group" aria-label="처리 상태로 거르기" className="ac-chips">
                  {FILTERS.map((f) => (
                    <button
                      key={f.key}
                      type="button"
                      className="ac-chip"
                      data-hit={escFilter === f.key ? 'true' : undefined}
                      aria-pressed={escFilter === f.key}
                      onClick={() => setEscFilter(f.key)}
                    >
                      {f.label} {f.n}
                    </button>
                  ))}
                </div>
                <input
                  className="ac-search"
                  type="search"
                  aria-label="요청 검색(고객 말·사유·접수번호)"
                  placeholder="고객 말·사유·접수번호 검색"
                  value={escQuery}
                  onChange={(e) => setEscQuery(e.target.value)}
                  style={{ marginLeft: 'auto' }}
                />
                <span style={S.tag} aria-live="polite">{filtered.length}/{tickets.length}건</span>
                <button type="button" style={S.btnGhost} onClick={loadEsc}>새로고침</button>
              </div>

              {tickets.length === 0 && phase.esc !== 'done' ? (
                <LoadState phase={phase.esc} busy="상담원 요청을 불러오는 중입니다" fail="상담원 요청을 불러오지 못했습니다" onRetry={loadEsc} rows={4} />
              ) : tickets.length === 0 ? (
                <div className="ac-empty">
                  <EmptyArt kind="chat" />
                  <p style={{ fontSize: 14, fontWeight: 700 }}>접수된 상담원 연결 요청이 없습니다</p>
                  <p style={{ fontSize: 13, color: 'var(--mut)', marginTop: 4 }}>고객이 상담창에서 「상담원 연결하기」를 누르거나 챗봇이 답하지 못하면 여기에 쌓입니다.</p>
                  <button type="button" style={{ ...S.btnGhost, marginTop: 12 }} onClick={() => setTab('test')}>응답 테스트에서 시험해 보기</button>
                </div>
              ) : filtered.length === 0 ? (
                <div className="ac-empty">
                  <p style={{ fontSize: 14, fontWeight: 700 }}>조건에 맞는 요청이 없습니다</p>
                  <button type="button" style={{ ...S.btnGhost, marginTop: 12 }} onClick={() => { setEscFilter('all'); setEscQuery(''); }}>필터 지우기</button>
                </div>
              ) : (
                <table className="ac-table">
                  <thead>
                    <tr>
                      <th scope="col">접수</th>
                      <th scope="col">상태</th>
                      <th scope="col">고객이 마지막으로 한 말</th>
                      <th scope="col" className="ac-col-wide">사유</th>
                      <th scope="col" className="ac-col-wide">접수 시각</th>
                      <th scope="col"><span className="ac-srhide">처리</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((t) => {
                      const act = nextAction(t);
                      return (
                        <tr key={t.id}>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            <button
                              type="button"
                              className="ac-linkbtn"
                              aria-haspopup="dialog"
                              aria-label={`접수 ${shortTicket(t.id)} 상세 보기`}
                              onClick={(e) => openTicket(t.id, e.currentTarget)}
                            >
                              {shortTicket(t.id)}
                            </button>
                          </td>
                          <td><span className="ac-pill" style={TICKET_STATUS_TONE[t.status]}>{TICKET_STATUS_LABELS[t.status]}</span></td>
                          <td style={{ minWidth: 160 }}>
                            <span className="ac-clamp" style={{ color: t.message ? 'var(--ink)' : 'var(--mut)' }}>{t.message || '남긴 메시지 없음'}</span>
                            {t.contact && <span style={{ ...S.tag, display: 'block', marginTop: 2 }}>연락처 남김</span>}
                          </td>
                          <td className="ac-col-wide" style={{ color: 'var(--sub)' }}>{t.reasonCode ? (HANDOFF_REASON_LABELS[t.reasonCode] ?? t.reasonCode) : t.reason}</td>
                          <td className="ac-col-wide" style={{ color: 'var(--sub)', whiteSpace: 'nowrap' }}>{timeLabel(t.createdAt)}</td>
                          <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                            <button
                              type="button"
                              className="ac-linkbtn"
                              style={act.primary ? { background: 'var(--brand)', color: '#fff' } : undefined}
                              disabled={ticketBusy}
                              aria-label={`접수 ${shortTicket(t.id)} ${act.label}`}
                              onClick={() => patchTicket(t.id, act.status)}
                            >
                              {act.label}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </section>
            {ticketsPersisted === false && (
              <p style={{ ...S.tag, marginTop: -6 }}>
                상담 요청에는 개인정보가 들어 있어 저장 승인 전까지는 서비스가 재시작되면 사라집니다. 승인 상태는 「감사 로그 › 저장소 상태」에서 확인할 수 있습니다.
              </p>
            )}
          </>
        );
      })()}

      {tab === 'partner' && (() => {
        const counts = { prospect: 0, contracted: 0, churned: 0 } as Record<AccountView['status'], number>;
        for (const a of accounts) counts[a.status] += 1;
        const activePartners = partners.filter((p) => p.status === 'active').length;
        const partnerName = (id: string | null) => (id ? partners.find((p) => p.id === id)?.name ?? '이름 없는 파트너' : '직접 계약');
        const q = accountQuery.trim().toLowerCase();
        const filteredAccounts = accounts
          .filter((a) => !q || [a.name, partnerName(a.partnerId), a.ownerName ?? '', SOURCE_LABELS[a.source] ?? '', ACCOUNT_STATUS_LABELS[a.status]].some((v) => v.toLowerCase().includes(q)))
          .slice()
          .sort((x, y) => x.name.localeCompare(y.name, 'ko'));
        const rollupOf = (id: string | null) => rollup.find((r) => (r.partnerId ?? null) === id);
        const directRollup = rollupOf(null);
        const filtering = Boolean(partnerFilter) || Boolean(q);
        const inputStyle = (bad?: string) => ({ ...S.input, ...(bad ? { borderColor: 'var(--danger)' } : {}) });
        return (
          <>
            <div className="ac-kpi" style={{ marginBottom: 16 }}>
              <KpiCard label="운영 중 파트너" value={partnerLoaded ? String(activePartners) : MEASURING} empty={!partnerLoaded} note={partnerLoaded ? `중지 ${partners.length - activePartners}곳 별도` : '파트너 정보를 불러오는 중'} />
              <KpiCard label="고객사" value={partnerLoaded ? String(accounts.length) : MEASURING} empty={!partnerLoaded} note={partnerFilter ? '현재 귀속 필터 기준' : '직접 계약 포함 전체'} />
              <KpiCard label="계약 중" value={partnerLoaded ? String(counts.contracted) : MEASURING} empty={!partnerLoaded} note={`해지 ${counts.churned}곳 별도`} />
              <KpiCard label="검토 중" value={partnerLoaded ? String(counts.prospect) : MEASURING} empty={!partnerLoaded} note="아직 계약 전인 고객사" />
            </div>

            {partnerErr && (
              <p role="alert" style={{ fontSize: 13, color: 'var(--danger)', fontWeight: 600, marginBottom: 12 }}>{partnerErr}</p>
            )}
            {!canWrite && (
              <p role="note" style={{ ...S.card, fontSize: 13, padding: '12px 16px' }}>
                <b>조회 전용 계정</b>입니다. 파트너 담당자 계정은 자기 파트너에 귀속된 고객사만 볼 수 있고 등록·수정은 할 수 없습니다. 변경이 필요하면 고원 관리자에게 요청해 주세요.
              </p>
            )}

            <div className="ac-split">
              {/* ── 좌: 고객사 표 → 파트너 표 ── */}
              <div style={{ minWidth: 0 }}>
                <section style={{ ...S.card, padding: 0 }} aria-labelledby="account-list-h">
                  <div className="ac-toolbar">
                    <h2 id="account-list-h" style={{ ...S.h2, marginRight: 4 }}>고객사</h2>
                    <input
                      className="ac-search"
                      type="search"
                      aria-label="고객사 검색(고객사명·파트너·담당자)"
                      placeholder="고객사명·파트너·담당자 검색"
                      value={accountQuery}
                      onChange={(e) => setAccountQuery(e.target.value)}
                    />
                    <label htmlFor="a-filter" className="ac-srhide">귀속으로 거르기</label>
                    <select
                      id="a-filter"
                      className="ac-select"
                      value={partnerFilter}
                      onChange={(e) => { setPartnerFilter(e.target.value); loadPartners(e.target.value); }}
                    >
                      <option value="">모든 귀속</option>
                      <option value="direct">직접 계약</option>
                      {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    <span style={{ ...S.tag, marginLeft: 'auto' }} aria-live="polite">{filteredAccounts.length}/{accounts.length}곳</span>
                    <button type="button" style={S.btnGhost} onClick={() => loadPartners(partnerFilter)} disabled={partnerBusy} aria-busy={partnerBusy || undefined}>
                      {partnerBusy ? '불러오는 중…' : '새로고침'}
                    </button>
                  </div>

                  {!partnerLoaded && partnerBusy ? (
                    <SkeletonRows rows={4} label="고객사와 파트너 정보를 불러오는 중입니다" />
                  ) : accounts.length === 0 && !filtering ? (
                    <div className="ac-empty">
                      <EmptyArt kind="kb" />
                      <p style={{ fontSize: 14, fontWeight: 700 }}>등록된 고객사가 없습니다</p>
                      <p style={{ fontSize: 13, color: 'var(--mut)', marginTop: 4 }}>첫 고객사를 등록하면 유입 경로와 귀속 이력이 함께 기록되고, 정산 리포트의 기준이 됩니다.</p>
                      {canWrite && <button type="button" style={{ ...S.btnGhost, marginTop: 12 }} onClick={() => focusPartnerForm('account')}>첫 고객사 등록</button>}
                    </div>
                  ) : filteredAccounts.length === 0 ? (
                    <div className="ac-empty">
                      <p style={{ fontSize: 14, fontWeight: 700 }}>조건에 맞는 고객사가 없습니다</p>
                      <button type="button" style={{ ...S.btnGhost, marginTop: 12 }} onClick={() => { setAccountQuery(''); if (partnerFilter) { setPartnerFilter(''); loadPartners(''); } }}>필터 지우기</button>
                    </div>
                  ) : (
                    <table className="ac-table">
                      <thead>
                        <tr>
                          <th scope="col">고객사</th>
                          <th scope="col">귀속</th>
                          <th scope="col">상태</th>
                          <th scope="col" className="ac-col-wide">유입 경로</th>
                          <th scope="col" className="ac-col-wide">계약일</th>
                          <th scope="col" className="ac-col-wide">월 이용료</th>
                          <th scope="col"><span className="ac-srhide">동작</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredAccounts.map((a) => (
                          <tr key={a.id} data-editing={aForm.id === a.id ? 'true' : undefined}>
                            <td style={{ minWidth: 140 }}>
                              <button
                                type="button"
                                className="ac-linkbtn"
                                style={{ padding: '2px 0', minHeight: 0, fontSize: 13.5, color: 'var(--ink)' }}
                                aria-haspopup="dialog"
                                aria-label={`${a.name} 상세 보기`}
                                onClick={(e) => openAccount(a.id, e.currentTarget)}
                              >
                                {a.name}
                              </button>
                              {a.ownerName && <span style={{ ...S.tag, display: 'block', marginTop: 2 }}>담당 {a.ownerName}</span>}
                            </td>
                            <td style={{ color: a.partnerId ? 'var(--ink)' : 'var(--sub)' }}>{partnerName(a.partnerId)}</td>
                            <td><span className="ac-pill" style={ACCOUNT_STATUS_TONE[a.status]}>{ACCOUNT_STATUS_LABELS[a.status]}</span></td>
                            <td className="ac-col-wide" style={{ color: 'var(--sub)' }}>{SOURCE_LABELS[a.source] ?? '미확인'}</td>
                            <td className="ac-col-wide" style={{ color: 'var(--sub)', whiteSpace: 'nowrap' }}>{a.contractedAt || '—'}</td>
                            <td className="ac-col-wide" style={{ whiteSpace: 'nowrap', color: typeof a.monthlyFeeKrw === 'number' ? 'var(--ink)' : 'var(--mut)' }}>{wonLabel(a.monthlyFeeKrw)}</td>
                            <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                              {canWrite && (
                                <button type="button" className="ac-linkbtn" aria-label={`${a.name} 수정`} onClick={() => editAccount(a)}>수정</button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </section>

                <section style={{ ...S.card, padding: 0 }} aria-labelledby="partner-list-h">
                  <div className="ac-toolbar">
                    <h2 id="partner-list-h" style={{ ...S.h2, marginRight: 4 }}>파트너</h2>
                    <span style={S.tag}>{partners.length}곳 · 고객사 수는 귀속 기준 건수만 셉니다</span>
                    {canWrite && partners.length > 0 && (
                      <button type="button" style={{ ...S.btnGhost, marginLeft: 'auto' }} onClick={() => { setPForm(EMPTY_PARTNER_FORM); setPErr({}); focusPartnerForm('partner'); }}>파트너 추가</button>
                    )}
                  </div>
                  {partners.length === 0 ? (
                    <div className="ac-empty">
                      <p style={{ fontSize: 14, fontWeight: 700 }}>등록된 파트너가 없습니다</p>
                      <p style={{ fontSize: 13, color: 'var(--mut)', marginTop: 4 }}>파트너를 등록하면 고객사를 그 파트너에 귀속시키고 수수료를 집계할 수 있습니다.</p>
                      {canWrite && <button type="button" style={{ ...S.btnGhost, marginTop: 12 }} onClick={() => focusPartnerForm('partner')}>첫 파트너 등록</button>}
                    </div>
                  ) : (
                    <table className="ac-table">
                      <thead>
                        <tr>
                          <th scope="col">파트너</th>
                          <th scope="col">상태</th>
                          <th scope="col">수수료율</th>
                          <th scope="col" className="ac-col-wide">담당</th>
                          <th scope="col">고객사</th>
                          <th scope="col"><span className="ac-srhide">동작</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {partners.map((p) => {
                          const r = rollupOf(p.id);
                          return (
                            <tr key={p.id} data-editing={pForm.id === p.id ? 'true' : undefined}>
                              <td style={{ fontWeight: 700 }}>{p.name}</td>
                              <td><span className="ac-pill" style={PARTNER_STATUS_TONE[p.status]}>{p.status === 'active' ? '운영 중' : '중지'}</span></td>
                              <td style={{ color: p.feeRateBp === null ? 'var(--mut)' : 'var(--ink)', whiteSpace: 'nowrap' }}>{feeLabel(p.feeRateBp)}</td>
                              <td className="ac-col-wide" style={{ color: 'var(--sub)' }}>{p.managerName || '—'}</td>
                              <td style={{ whiteSpace: 'nowrap' }}>
                                {r ? <>{r.total}곳<span style={{ ...S.tag, marginLeft: 4 }}>계약 {r.contracted}</span></> : <span style={S.tag}>0곳</span>}
                              </td>
                              <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                                {canWrite && (
                                  <>
                                    <button type="button" className="ac-linkbtn" aria-label={`${p.name} 수정`} onClick={() => editPartner(p)}>수정</button>
                                    <button type="button" className="ac-linkbtn" data-tone="danger" aria-label={`${p.name} 삭제`} onClick={() => removePartner(p)}>삭제</button>
                                  </>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                        {directRollup && directRollup.total > 0 && (
                          <tr>
                            <td style={{ fontWeight: 700, color: 'var(--sub)' }}>직접 계약</td>
                            <td><span className="ac-pill" style={{ background: 'var(--bg)', color: 'var(--mut)' }}>고원 직접</span></td>
                            <td style={{ color: 'var(--mut)' }}>—</td>
                            <td className="ac-col-wide" style={{ color: 'var(--mut)' }}>—</td>
                            <td style={{ whiteSpace: 'nowrap' }}>{directRollup.total}곳<span style={{ ...S.tag, marginLeft: 4 }}>계약 {directRollup.contracted}</span></td>
                            <td />
                          </tr>
                        )}
                      </tbody>
                    </table>
                  )}
                </section>
                <p style={S.tag}>
                  계약 주체는 고원이고 파트너는 유치와 운영을 맡습니다. 여기에는 어느 고객사를 누가 데려왔는지만 기록하며, 담당자는 이름만 저장합니다. 실제 정산·청구는 계약서가 확정된 뒤에 진행합니다.
                </p>
              </div>

              {/* ── 우: 등록·수정 폼(스티키) — 고객사/파트너 전환 ── */}
              {canWrite && (
                <div ref={partnerFormRef} style={{ minWidth: 0 }}>
                  <section className="ac-sticky" style={S.card} aria-labelledby="partner-form-h">
                    <div role="group" aria-label="등록 대상" className="ac-seg" style={{ marginBottom: 14 }}>
                      <button type="button" className="ac-segbtn" aria-pressed={partnerFormKind === 'account'} onClick={() => setPartnerFormKind('account')}>고객사</button>
                      <button type="button" className="ac-segbtn" aria-pressed={partnerFormKind === 'partner'} onClick={() => setPartnerFormKind('partner')}>파트너</button>
                    </div>

                    {partnerFormKind === 'account' ? (
                      <form onSubmit={(e) => { e.preventDefault(); submitAccount(); }} noValidate>
                        <h2 id="partner-form-h" style={{ ...S.h2, marginBottom: 12 }}>{aForm.id ? '고객사 수정' : '새 고객사'}</h2>
                        <div className="ac-field">
                          <label htmlFor="a-name">고객사명 <span aria-hidden="true" style={{ color: 'var(--danger)' }}>*</span></label>
                          <input id="a-name" style={inputStyle(aErr.name)} value={aForm.name} placeholder="예: OO의원" aria-required="true"
                            aria-invalid={aErr.name ? 'true' : undefined} aria-describedby={aErr.name ? 'a-name-err' : undefined}
                            onChange={(e) => { setAForm({ ...aForm, name: e.target.value }); if (aErr.name) setAErr({ ...aErr, name: undefined }); }} />
                          {aErr.name && <p id="a-name-err" className="ac-err">{aErr.name}</p>}
                        </div>
                        <div className="ac-field">
                          <label htmlFor="a-partner">귀속 파트너</label>
                          <select id="a-partner" className="ac-select" style={{ width: '100%', ...(aErr.partnerId ? { borderColor: 'var(--danger)' } : {}) }} value={aForm.partnerId}
                            aria-invalid={aErr.partnerId ? 'true' : undefined} aria-describedby={aErr.partnerId ? 'a-partner-err' : undefined}
                            onChange={(e) => { setAForm({ ...aForm, partnerId: e.target.value }); if (aErr.partnerId) setAErr({ ...aErr, partnerId: undefined }); }}>
                            <option value="">직접 계약(파트너 없음)</option>
                            {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                          {aErr.partnerId && <p id="a-partner-err" className="ac-err">{aErr.partnerId}</p>}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                          <div className="ac-field">
                            <label htmlFor="a-source">유입 경로</label>
                            <select id="a-source" className="ac-select" style={{ width: '100%' }} value={aForm.source} onChange={(e) => setAForm({ ...aForm, source: e.target.value })}>
                              {Object.entries(SOURCE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                            </select>
                          </div>
                          <div className="ac-field">
                            <label htmlFor="a-status">계약 상태</label>
                            <select id="a-status" className="ac-select" style={{ width: '100%' }} value={aForm.status} onChange={(e) => setAForm({ ...aForm, status: e.target.value as AccountView['status'] })}>
                              {Object.entries(ACCOUNT_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                            </select>
                          </div>
                        </div>
                        <div className="ac-field">
                          <label htmlFor="a-date">계약일 <span style={{ color: 'var(--mut)', fontWeight: 500 }}>(계약 상태면 필수 · 정산 기준일)</span></label>
                          <input id="a-date" type="date" style={inputStyle(aErr.contractedAt)} value={aForm.contractedAt}
                            aria-invalid={aErr.contractedAt ? 'true' : undefined} aria-describedby={aErr.contractedAt ? 'a-date-err' : undefined}
                            onChange={(e) => { setAForm({ ...aForm, contractedAt: e.target.value }); if (aErr.contractedAt) setAErr({ ...aErr, contractedAt: undefined }); }} />
                          {aErr.contractedAt && <p id="a-date-err" className="ac-err">{aErr.contractedAt}</p>}
                        </div>
                        <div className="ac-field">
                          <label htmlFor="a-fee">월 이용료(원) <span style={{ color: 'var(--mut)', fontWeight: 500 }}>(계약서 금액 · 비우면 정산 합계에서 제외)</span></label>
                          <input id="a-fee" style={inputStyle(aErr.monthlyFeeKrw)} inputMode="numeric" value={aForm.monthlyFeeKrw} placeholder="예: 300000"
                            aria-invalid={aErr.monthlyFeeKrw ? 'true' : undefined} aria-describedby={aErr.monthlyFeeKrw ? 'a-fee-err' : undefined}
                            onChange={(e) => { setAForm({ ...aForm, monthlyFeeKrw: e.target.value }); if (aErr.monthlyFeeKrw) setAErr({ ...aErr, monthlyFeeKrw: undefined }); }} />
                          {aErr.monthlyFeeKrw && <p id="a-fee-err" className="ac-err">{aErr.monthlyFeeKrw}</p>}
                        </div>
                        <div className="ac-field">
                          <label htmlFor="a-owner">고원 담당자 이름</label>
                          <input id="a-owner" style={S.input} value={aForm.ownerName} placeholder="예: 이담당" onChange={(e) => setAForm({ ...aForm, ownerName: e.target.value })} />
                        </div>
                        <div className="ac-field">
                          <label htmlFor="a-note">귀속 근거 <span style={{ color: 'var(--mut)', fontWeight: 500 }}>(이력에 남습니다)</span></label>
                          <input id="a-note" style={S.input} value={aForm.attributionNote} placeholder="예: 파트너 소개로 최초 미팅(2026-08-20)" onChange={(e) => setAForm({ ...aForm, attributionNote: e.target.value })} />
                        </div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <button type="submit" style={{ ...S.btn, opacity: partnerSaving ? 0.6 : 1 }} disabled={partnerSaving} aria-busy={partnerSaving || undefined}>
                            {partnerSaving ? '저장 중…' : aForm.id ? '수정 저장' : '고객사 등록'}
                          </button>
                          {aForm.id && <button type="button" style={S.btnGhost} onClick={() => { setAForm(EMPTY_ACCOUNT_FORM); setAErr({}); }}>취소</button>}
                        </div>
                      </form>
                    ) : (
                      <form onSubmit={(e) => { e.preventDefault(); submitPartner(); }} noValidate>
                        <h2 id="partner-form-h" style={{ ...S.h2, marginBottom: 12 }}>{pForm.id ? '파트너 수정' : '새 파트너'}</h2>
                        <div className="ac-field">
                          <label htmlFor="p-name">파트너명 <span aria-hidden="true" style={{ color: 'var(--danger)' }}>*</span></label>
                          <input id="p-name" style={inputStyle(pErr.name)} value={pForm.name} placeholder="예: 제이투모로우원" aria-required="true"
                            aria-invalid={pErr.name ? 'true' : undefined} aria-describedby={pErr.name ? 'p-name-err' : undefined}
                            onChange={(e) => { setPForm({ ...pForm, name: e.target.value }); if (pErr.name) setPErr({ ...pErr, name: undefined }); }} />
                          {pErr.name && <p id="p-name-err" className="ac-err">{pErr.name}</p>}
                        </div>
                        <div className="ac-field">
                          <label htmlFor="p-manager">담당자 이름 <span style={{ color: 'var(--mut)', fontWeight: 500 }}>(연락처는 저장하지 않습니다)</span></label>
                          <input id="p-manager" style={S.input} value={pForm.managerName} placeholder="예: 김담당" onChange={(e) => setPForm({ ...pForm, managerName: e.target.value })} />
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                          <div className="ac-field">
                            <label htmlFor="p-fee">수수료율(%) <span style={{ color: 'var(--mut)', fontWeight: 500 }}>(비우면 미설정)</span></label>
                            <input id="p-fee" style={inputStyle(pErr.feeRatePct)} inputMode="decimal" value={pForm.feeRatePct} placeholder="예: 15"
                              aria-invalid={pErr.feeRatePct ? 'true' : undefined} aria-describedby={pErr.feeRatePct ? 'p-fee-err' : undefined}
                              onChange={(e) => { setPForm({ ...pForm, feeRatePct: e.target.value }); if (pErr.feeRatePct) setPErr({ ...pErr, feeRatePct: undefined }); }} />
                            {pErr.feeRatePct && <p id="p-fee-err" className="ac-err">{pErr.feeRatePct}</p>}
                          </div>
                          <div className="ac-field">
                            <label htmlFor="p-status">상태</label>
                            <select id="p-status" className="ac-select" style={{ width: '100%' }} value={pForm.status} onChange={(e) => setPForm({ ...pForm, status: e.target.value as PartnerForm['status'] })}>
                              <option value="active">운영 중</option>
                              <option value="paused">중지</option>
                            </select>
                          </div>
                        </div>
                        <div className="ac-field">
                          <label htmlFor="p-memo">메모</label>
                          <input id="p-memo" style={S.input} value={pForm.memo} placeholder="예: 경기 남부 병의원 전담" onChange={(e) => setPForm({ ...pForm, memo: e.target.value })} />
                        </div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <button type="submit" style={{ ...S.btn, opacity: partnerSaving ? 0.6 : 1 }} disabled={partnerSaving} aria-busy={partnerSaving || undefined}>
                            {partnerSaving ? '저장 중…' : pForm.id ? '수정 저장' : '파트너 등록'}
                          </button>
                          {pForm.id && <button type="button" style={S.btnGhost} onClick={() => { setPForm(EMPTY_PARTNER_FORM); setPErr({}); }}>취소</button>}
                        </div>
                      </form>
                    )}
                  </section>
                </div>
              )}
            </div>
          </>
        );
      })()}

      {tab === 'settle' && (() => {
        const r = settleReport;
        const won = (v: number) => `${v.toLocaleString('ko-KR')}원`;
        const feeTotal = !r ? MEASURING : r.rows.length === 0 ? '대상 없음' : r.totals.billable === 0 ? '산출 불가' : won(r.totals.feeAmountKrw);
        const feeEmpty = !r || r.rows.length === 0 || r.totals.billable === 0;
        const monthLabel = r ? `${r.month.slice(0, 4)}년 ${Number(r.month.slice(5, 7))}월` : '';
        const ISSUE_TONE = { background: '#FFFBEB', color: 'var(--warn)' } as const;
        return (
          <>
            <section style={{ ...S.card, padding: 0 }} aria-labelledby="settle-h">
              <div className="ac-toolbar">
                <h2 id="settle-h" style={{ ...S.h2, marginRight: 4 }}>정산 조건</h2>
                <label htmlFor="s-month" className="ac-srhide">기준월</label>
                <input
                  id="s-month"
                  type="month"
                  className="ac-select"
                  value={settleMonth}
                  onChange={(e) => { setSettleMonth(e.target.value); loadSettlement(e.target.value, settlePartner); }}
                />
                <label htmlFor="s-partner" className="ac-srhide">파트너</label>
                <select
                  id="s-partner"
                  className="ac-select"
                  value={settlePartner}
                  onChange={(e) => { setSettlePartner(e.target.value); loadSettlement(settleMonth, e.target.value); }}
                >
                  <option value="">모든 파트너</option>
                  {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <span role="status" aria-live="polite" style={{ ...S.tag, marginLeft: 'auto' }}>
                  {settleBusy ? '계산하는 중…' : r ? `${r.periodStart} ~ ${r.periodEnd}` : ''}
                </span>
                <button type="button" style={S.btnGhost} onClick={() => loadSettlement(settleMonth, settlePartner)} disabled={settleBusy} aria-busy={settleBusy || undefined}>다시 계산</button>
                <button type="button" style={S.btn} onClick={downloadSettlementCsv} disabled={!r || r.rows.length === 0}>CSV 내려받기</button>
              </div>
              <p style={{ ...S.tag, padding: '10px 16px' }}>
                월 이용료(계약서 입력값) × 수수료율로 산출 근거를 만듭니다. 값이 없는 항목은 0으로 채우지 않고 합계에서 빼며 사유를 표시합니다. 실제 청구·지급은 계약서가 확정된 뒤에 진행합니다.
              </p>
            </section>

            {settleErr && (
              <div role="alert" style={{ ...S.card, borderColor: '#FECACA', background: '#FEF2F2', padding: '12px 16px', fontSize: 13, color: 'var(--danger)', fontWeight: 600 }}>
                {settleErr}
                <button type="button" className="ac-linkbtn" style={{ marginLeft: 8 }} onClick={() => loadSettlement(settleMonth, settlePartner)}>다시 시도</button>
              </div>
            )}

            <div className="ac-kpi" style={{ marginBottom: 16 }}>
              <KpiCard label="대상 고객사" value={r ? String(r.totals.accounts) : MEASURING} empty={!r} note={r ? `${monthLabel} 기준 계약 중` : '리포트를 불러오는 중'} />
              <KpiCard label="산출 완료" value={r ? String(r.totals.billable) : MEASURING} empty={!r} note="월 이용료·수수료율이 모두 있는 건" />
              <KpiCard label="미산출" value={r ? String(r.totals.incomplete) : MEASURING} empty={!r} note={r && r.totals.incomplete > 0 ? '근거가 부족해 합계에서 뺐습니다' : '근거 부족 건 없음'} />
              <KpiCard label="수수료 합계" value={feeTotal} empty={feeEmpty} note={r && r.totals.partial ? '확정 금액 아님 — 미산출 건 제외' : r && r.totals.billable > 0 ? `기준금액 ${won(r.totals.baseAmountKrw)}` : '산출된 건이 없습니다'} />
            </div>

            {r && r.totals.partial && (
              <p role="alert" style={{ ...S.card, borderColor: '#FDE68A', background: '#FFFBEB', padding: '12px 16px', fontSize: 13, color: 'var(--warn)', fontWeight: 600 }}>
                근거가 부족한 {r.totals.incomplete}건이 합계에서 빠져 있습니다. 이 합계는 확정 금액이 아닙니다. 「파트너·귀속」에서 월 이용료와 수수료율을 채우면 다시 계산됩니다.
              </p>
            )}

            {r && r.rows.length === 0 && !settleErr && (
              <section style={S.card}>
                <div className="ac-empty">
                  <EmptyArt kind="kb" />
                  <p style={{ fontSize: 14, fontWeight: 700 }}>{monthLabel}에 정산 대상 고객사가 없습니다</p>
                  <p style={{ fontSize: 13, color: 'var(--mut)', marginTop: 4 }}>파트너 귀속 고객사를 「계약」 상태로 두고 계약일을 입력하면 그 달부터 여기에 나타납니다.</p>
                  <button type="button" style={{ ...S.btnGhost, marginTop: 12 }} onClick={() => setTab('partner')}>파트너·귀속 열기</button>
                </div>
              </section>
            )}

            {r && r.rows.length > 0 && (
              <>
                <section style={{ ...S.card, padding: 0 }} aria-labelledby="settle-sum-h">
                  <div className="ac-toolbar">
                    <h2 id="settle-sum-h" style={S.h2}>파트너별 합계</h2>
                    <span style={S.tag}>근거가 갖춰진 건만 합산</span>
                  </div>
                  <table className="ac-table">
                    <thead>
                      <tr>
                        <th scope="col">파트너</th>
                        <th scope="col">대상</th>
                        <th scope="col">산출</th>
                        <th scope="col">미산출</th>
                        <th scope="col" className="ac-col-wide">기준금액</th>
                        <th scope="col" style={{ textAlign: 'right' }}>수수료</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.partnerTotals.map((t) => (
                        <tr key={t.partnerId}>
                          <td style={{ fontWeight: 700 }}>{t.partnerName}</td>
                          <td>{t.accounts}</td>
                          <td>{t.billable}</td>
                          <td>{t.incomplete > 0 ? <span className="ac-pill" style={ISSUE_TONE}>{t.incomplete}건</span> : <span style={{ color: 'var(--mut)' }}>0</span>}</td>
                          <td className="ac-col-wide" style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{won(t.baseAmountKrw)}</td>
                          <td style={{ whiteSpace: 'nowrap', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{won(t.feeAmountKrw)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>

                <section style={{ ...S.card, padding: 0 }} aria-labelledby="settle-rows-h">
                  <div className="ac-toolbar">
                    <h2 id="settle-rows-h" style={S.h2}>고객사별 산출 근거</h2>
                    <span style={S.tag}>{r.rows.length}건</span>
                  </div>
                  <table className="ac-table">
                    <thead>
                      <tr>
                        <th scope="col">고객사</th>
                        <th scope="col">파트너</th>
                        <th scope="col" className="ac-col-wide">계약일</th>
                        <th scope="col" className="ac-col-wide">월 이용료</th>
                        <th scope="col" className="ac-col-wide">수수료율</th>
                        <th scope="col" style={{ textAlign: 'right' }}>수수료</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.rows.map((row) => (
                        <tr key={row.accountId}>
                          <td style={{ fontWeight: 700, minWidth: 120 }}>
                            {row.accountName}
                            {row.issue !== 'none' && <span className="ac-pill" style={{ ...ISSUE_TONE, display: 'block', width: 'fit-content', marginTop: 4 }}>{ISSUE_LABELS[row.issue]}</span>}
                          </td>
                          <td style={{ color: 'var(--sub)' }}>{row.partnerName}</td>
                          <td className="ac-col-wide" style={{ color: 'var(--sub)', whiteSpace: 'nowrap' }}>{row.contractedAt}</td>
                          <td className="ac-col-wide" style={{ whiteSpace: 'nowrap', color: row.baseAmountKrw === null ? 'var(--mut)' : 'var(--ink)' }}>{wonLabel(row.baseAmountKrw)}</td>
                          <td className="ac-col-wide" style={{ color: row.feeRateBp === null ? 'var(--mut)' : 'var(--ink)' }}>{feeLabel(row.feeRateBp)}</td>
                          <td style={{ whiteSpace: 'nowrap', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: row.feeAmountKrw === null ? 500 : 700, color: row.feeAmountKrw === null ? 'var(--mut)' : 'var(--ink)' }}>
                            {row.feeAmountKrw === null ? '산출 불가' : won(row.feeAmountKrw)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <details style={{ padding: '12px 16px' }}>
                    <summary style={{ fontSize: 12.5, color: 'var(--mut)', cursor: 'pointer' }}>산출 기준·한계 {r.notes.length}건</summary>
                    <ul style={{ margin: '6px 0 0 16px', padding: 0, fontSize: 12.5, color: 'var(--sub)' }}>
                      {r.notes.map((n, i) => <li key={i} style={{ marginBottom: 3 }}>{n}</li>)}
                    </ul>
                  </details>
                </section>
              </>
            )}
          </>
        );
      })()}

      {tab === 'tenant' && (
        <>
          <section style={S.card} aria-labelledby="tenant-h">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div>
                <h2 id="tenant-h" style={S.h2}>배포본이 답변 근거로 쓰는 자료</h2>
                <p style={{ ...S.tag, marginTop: 4 }}>
                  고객사(테넌트) 상담창이 실제로 참조하는 FAQ입니다. 원본은 배포 파일에 담겨 있어 이 화면에서는 <strong>편집하지 않고 확인만</strong> 합니다.
                </p>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <label htmlFor="tenant-select" style={{ ...S.tag, fontWeight: 700 }}>테넌트</label>
                <select
                  id="tenant-select"
                  className="ac-select"
                  value={tenantId}
                  onChange={(e) => {
                    setTenantId(e.target.value);
                    setTenantView(null);
                    loadTenant(e.target.value);
                  }}
                >
                  {(tenantIdList.length ? tenantIdList : [tenantId]).map((id) => (
                    <option key={id} value={id}>{id}</option>
                  ))}
                </select>
                <button style={S.btnGhost} onClick={() => loadTenant(tenantId)} disabled={tenantBusy} aria-busy={tenantBusy}>
                  {tenantBusy ? '불러오는 중…' : '새로고침'}
                </button>
              </div>
            </div>

            <div role="status" aria-live="polite">
              {tenantErr && (
                <p style={{ fontSize: 14, color: 'var(--danger)', marginTop: 12 }}>
                  {tenantErr} <button style={{ ...S.btnGhost, marginLeft: 6 }} onClick={() => loadTenant(tenantId)}>다시 시도</button>
                </p>
              )}
              {!tenantErr && tenantBusy && !tenantView && (
                <SkeletonRows rows={4} label="테넌트 지식을 불러오는 중입니다" />
              )}
              {!tenantErr && !tenantBusy && !tenantView && (
                <p style={{ fontSize: 14, color: 'var(--sub)', marginTop: 12 }}>표시할 테넌트가 없습니다.</p>
              )}
            </div>

            {tenantView && (
              <>
                <div className="ac-statgrid">
                  <div className="ac-stat">
                    <div className="ac-statlabel">상담창 이름</div>
                    <div className="ac-statvalue" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span aria-hidden="true" style={{ width: 14, height: 14, borderRadius: '50%', background: tenantView.config.brandColor, flexShrink: 0, border: '1px solid var(--line)' }} />
                      {tenantView.status.name}
                    </div>
                  </div>
                  <div className="ac-stat">
                    <div className="ac-statlabel">적재된 FAQ</div>
                    <div className="ac-statvalue">
                      {tenantView.status.entries}건
                      {tenantView.status.skipped > 0 && <span className="ac-pill" style={{ marginLeft: 6, background: '#FEF2F2', color: 'var(--danger)' }}>제외 {tenantView.status.skipped}건</span>}
                    </div>
                  </div>
                  <div className="ac-stat">
                    <div className="ac-statlabel">신청 버튼 주소</div>
                    <div className="ac-statvalue">
                      <a href={tenantView.status.ctaUrl} target="_blank" rel="noreferrer noopener">{tenantView.status.ctaUrl}</a>
                      <span className="ac-pill" style={{ marginLeft: 6, ...(tenantView.status.ctaFromEnv ? { background: '#F0FDF4', color: 'var(--success)' } : { background: '#FFFBEB', color: 'var(--warn)' }) }}>
                        {tenantView.status.ctaFromEnv ? '배포 설정 적용됨' : '기본값 — 배포 설정 미등록'}
                      </span>
                    </div>
                  </div>
                  <div className="ac-stat">
                    <div className="ac-statlabel">AI 고지 문구</div>
                    <div className="ac-statvalue" style={{ fontWeight: 500, color: 'var(--sub)' }}>{tenantView.config.aiNotice}</div>
                  </div>
                </div>
                {tenantView.status.skipped > 0 && (
                  <ul style={{ marginTop: 10, paddingLeft: 18, fontSize: 13, color: 'var(--danger)' }}>
                    {tenantView.warnings.map((w) => (
                      <li key={w}>형식 오류로 제외됨: {w}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>

          {tenantView && (
            <section style={{ ...S.card, padding: 0 }} aria-labelledby="tenant-faq-h">
              <div className="ac-toolbar">
                <h2 id="tenant-faq-h" style={S.h2}>FAQ 목록</h2>
                <span style={S.tag}>{tenantView.faq.length}건 · 답변 아래 근거 카드에 「근거」 열의 라벨이 그대로 표시됩니다</span>
              </div>
              {tenantView.faq.length === 0 ? (
                <div className="ac-empty">
                  <EmptyArt kind="kb" />
                  <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--danger)' }}>적재된 FAQ가 0건입니다</p>
                  <p style={{ fontSize: 13, color: 'var(--mut)', marginTop: 4 }}>이 상태에서는 답변 근거가 없어 모든 질문이 담당자 연결로 넘어갑니다. 배포 파일의 FAQ 자료를 확인해 주세요.</p>
                </div>
              ) : (
                <table className="ac-table">
                  <thead>
                    <tr>
                      <th scope="col">근거</th>
                      <th scope="col">질문</th>
                      <th scope="col" className="ac-col-wide">답변</th>
                      <th scope="col" className="ac-col-wide">표현</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tenantView.faq.map((f) => (
                      <tr key={f.id}>
                        <td style={{ whiteSpace: 'nowrap' }}><span className="ac-pill">{f.citation}</span></td>
                        <td style={{ minWidth: 160 }}>
                          <span style={{ fontWeight: 700 }}>{f.question}</span>
                          {f.category && <span style={{ ...S.tag, display: 'block', marginTop: 2 }}>{f.category}</span>}
                        </td>
                        <td className="ac-col-wide" style={{ color: 'var(--sub)', maxWidth: 420 }}><span className="ac-clamp">{f.answer}</span></td>
                        <td className="ac-col-wide" style={{ color: 'var(--sub)', whiteSpace: 'nowrap' }}>{f.keywords.length}개</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}
        </>
      )}

      {tab === 'audit' && (() => {
        const actions = Array.from(new Set(auditEvents.map((e) => e.action)));
        const shown = auditEvents.filter((e) => auditFilter === 'all' || e.action === auditFilter);
        return (
          <>
            <section style={{ ...S.card, padding: 0 }} aria-labelledby="audit-h">
              <div className="ac-toolbar">
                <div style={{ marginRight: 4 }}>
                  <h2 id="audit-h" style={S.h2}>관리 작업 기록</h2>
                  <p style={{ ...S.tag, marginTop: 2 }}>안내 자료·규칙 편집, 상담 요청 처리, 백업 복원 이력(최근 100건). 토큰 값은 기록하지 않습니다.</p>
                </div>
                <label htmlFor="audit-filter" className="ac-srhide">작업 종류로 거르기</label>
                <select id="audit-filter" className="ac-select" value={auditFilter} onChange={(e) => setAuditFilter(e.target.value)} style={{ marginLeft: 'auto' }}>
                  <option value="all">모든 작업</option>
                  {actions.map((a) => (
                    <option key={a} value={a}>{AUDIT_ACTION_LABELS[a] || a}</option>
                  ))}
                </select>
                <span style={S.tag}>{shown.length}/{auditEvents.length}건</span>
                <button type="button" style={S.btnGhost} onClick={loadAudit}>새로고침</button>
                <a
                  style={{ ...S.btnGhost, textDecoration: 'none' }}
                  href={`/api/admin/audit?format=csv${adminToken ? `&token=${encodeURIComponent(adminToken)}` : ''}`}
                >
                  CSV 내려받기
                </a>
              </div>
              {auditEvents.length === 0 && phase.audit !== 'done' ? (
                <LoadState phase={phase.audit} busy="변경 이력을 불러오는 중입니다" fail="변경 이력을 불러오지 못했습니다" onRetry={loadAudit} rows={4} />
              ) : auditEvents.length === 0 ? (
                <div className="ac-empty">
                  <EmptyArt kind="kb" />
                  <p style={{ fontSize: 14, fontWeight: 700 }}>기록된 관리 작업이 없습니다</p>
                  <p style={{ fontSize: 13, color: 'var(--mut)', marginTop: 4 }}>지식베이스나 규칙을 수정하면 누가 언제 무엇을 바꿨는지 이곳에 남습니다.</p>
                  <button type="button" style={{ ...S.btnGhost, marginTop: 12 }} onClick={() => setTab('kb')}>지식베이스 열기</button>
                </div>
              ) : shown.length === 0 ? (
                <div className="ac-empty">
                  <p style={{ fontSize: 14, fontWeight: 700 }}>선택한 종류의 작업이 없습니다</p>
                  <button type="button" style={{ ...S.btnGhost, marginTop: 12 }} onClick={() => setAuditFilter('all')}>필터 지우기</button>
                </div>
              ) : (
                <table className="ac-table">
                  <thead>
                    <tr>
                      <th scope="col">시각</th>
                      <th scope="col">작업</th>
                      <th scope="col">대상·내용</th>
                      <th scope="col" className="ac-col-wide">인증</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((e) => (
                      <tr key={e.id}>
                        <td style={{ whiteSpace: 'nowrap', color: 'var(--sub)' }}>{timeLabel(e.at)}</td>
                        <td style={{ whiteSpace: 'nowrap' }}><span className="ac-pill">{AUDIT_ACTION_LABELS[e.action] || e.action}</span></td>
                        <td style={{ minWidth: 160 }}>
                          {e.target && <span style={{ fontWeight: 700 }}>{e.target}</span>}
                          {e.detail && <span className="ac-clamp" style={{ color: 'var(--sub)', display: 'block' }}>{e.detail}</span>}
                          {!e.target && !e.detail && <span style={{ color: 'var(--mut)' }}>—</span>}
                        </td>
                        <td className="ac-col-wide">
                          <span className="ac-pill" style={e.authed ? { background: '#F0FDF4', color: 'var(--success)' } : { background: '#FFFBEB', color: 'var(--warn)' }}>
                            {e.authed ? '로그인됨' : '인증 없이 수행'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section style={S.card} aria-labelledby="storage-h">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <div>
                  <h2 id="storage-h" style={S.h2}>저장소 상태</h2>
                  <p style={{ ...S.tag, marginTop: 2 }}>데이터가 어디에 저장되는지와 최근 저장 결과입니다. 저장이 막혀도 서비스는 계속 동작하며, 사유가 여기에 표시됩니다.</p>
                </div>
                <button style={S.btnGhost} onClick={loadStorage} disabled={storageBusy} aria-busy={storageBusy}>
                  {storageBusy ? '확인 중…' : '새로고침'}
                </button>
              </div>

              <div role="status" aria-live="polite">
                {storageErr && (
                  <p style={{ fontSize: 14, color: 'var(--danger)', marginTop: 10 }}>
                    {storageErr} <button style={{ ...S.btnGhost, marginLeft: 6 }} onClick={loadStorage}>다시 시도</button>
                  </p>
                )}
                {!storageErr && storageBusy && !storage && (
                  <p style={{ fontSize: 14, color: 'var(--sub)', marginTop: 10 }}>저장소 상태를 확인하는 중입니다…</p>
                )}
                {!storageErr && !storageBusy && !storage && (
                  <p style={{ fontSize: 14, color: 'var(--sub)', marginTop: 10 }}>표시할 저장소 정보가 없습니다.</p>
                )}
              </div>

              {storage && (
                <>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
                    <span className="ac-pill">저장 방식 · {storage.driver === 'file' ? '파일' : '메모리'}</span>
                    <span className="ac-pill" style={storage.piiApproved ? { background: '#F0FDF4', color: 'var(--success)' } : { background: '#FFFBEB', color: 'var(--warn)' }}>
                      개인정보 저장 {storage.piiApproved ? '승인됨' : '미승인'}
                    </span>
                  </div>
                  <ul className="ac-nsgrid">
                    {storage.namespaces.map((n) => {
                      const meta = STORAGE_HEALTH[n.health] ?? STORAGE_HEALTH.empty;
                      const tone = n.health === 'ok' ? { background: '#F0FDF4', color: 'var(--success)' }
                        : n.health === 'error' || n.health === 'readonly' ? { background: '#FEF2F2', color: 'var(--danger)' }
                        : n.health === 'empty' ? undefined
                        : { background: '#FFFBEB', color: 'var(--warn)' };
                      return (
                        <li key={n.ns} className="ac-nscard" data-health={n.health}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                            <strong style={{ fontSize: 13.5 }}>{STORAGE_NS_LABELS[n.ns] || n.ns}</strong>
                            <span className="ac-pill" style={tone}>{meta.label}</span>
                          </div>
                          <p style={{ fontSize: 12.5, color: 'var(--sub)', marginTop: 6, lineHeight: 1.5 }}>{meta.hint}</p>
                          {n.lastSavedAt && <p style={{ ...S.tag, marginTop: 4 }}>최근 저장 {timeLabel(n.lastSavedAt)}</p>}
                          {n.lastError && (
                            <p style={{ fontSize: 12, color: 'var(--danger)', marginTop: 4 }}>오류: {n.lastError}</p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </section>
          </>
        );
      })()}

      {tab === 'test' && (
        <div className="ac-split ac-split-test">
          {/* ── 좌: 입력 + 응답 분석 ── */}
          <div style={{ minWidth: 0 }}>
            <section style={S.card} aria-labelledby="ac-test-in">
              <h2 id="ac-test-in" style={{ ...S.h2, marginBottom: 4 }}>고객이 보낼 말</h2>
              <p style={{ ...S.tag, marginBottom: 10 }}>여기서 보낸 대화도 기록에 남습니다. 실제 고객 정보는 넣지 마세요.</p>
              <label htmlFor="ac-test-msg" className="ac-srhide">고객 메시지</label>
              <textarea
                id="ac-test-msg"
                style={{ ...S.input, minHeight: 84, marginBottom: 8 }}
                placeholder="예: 요금이 얼마인가요?"
                value={testInput}
                onChange={(e) => setTestInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    runTest();
                  }
                }}
              />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <button type="button" style={{ ...S.btn, opacity: testBusy ? 0.6 : 1 }} onClick={runTest} disabled={testBusy} aria-busy={testBusy || undefined}>
                  {testBusy ? '답변 기다리는 중…' : '보내기'}
                </button>
                <span style={S.tag}>Enter 로 보내고 Shift+Enter 로 줄을 바꿉니다.</span>
                {testLog.length > 0 && (
                  <button type="button" className="ac-linkbtn" style={{ marginLeft: 'auto' }} onClick={() => setTestLog([])}>기록 지우기</button>
                )}
              </div>
            </section>

            <section style={S.card} aria-labelledby="ac-test-why">
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
                <h2 id="ac-test-why" style={S.h2}>왜 이렇게 답했나</h2>
                <span style={S.tag}>최근 답변부터</span>
              </div>
              {testLog.length === 0 ? (
                <p style={{ fontSize: 13.5, color: 'var(--mut)' }}>메시지를 보내면 어떤 자료·규칙을 근거로 답했는지 여기에 표시됩니다.</p>
              ) : (
                testLog.map((t, i) => (
                  <div key={i} className="ac-why" data-latest={i === 0 ? 'true' : undefined}>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)', marginBottom: 6 }}>“{t.q}”</div>
                    <dl className="ac-dl">
                      <dt>주제</dt><dd>{INTENT_LABELS[t.intent] || t.intent}</dd>
                      <dt>근거</dt><dd>{SOURCE_VIEW_LABELS[t.source] || t.source}{t.citation ? ` · ${t.citation.source}` : ''}</dd>
                      {t.citation && (<><dt>인용</dt><dd style={{ color: 'var(--sub)' }}>“{t.citation.snippet}”</dd></>)}
                      {t.confidence !== undefined && (<><dt>확신도</dt><dd>{Math.round(t.confidence * 100)}% <span style={{ color: 'var(--mut)' }}>(엔진 판정값)</span></dd></>)}
                    </dl>
                  </div>
                ))
              )}
            </section>
          </div>

          {/* ── 우: 고객에게 보이는 화면 미리보기 ── */}
          <div style={{ minWidth: 0 }}>
            <section className="ac-sticky ac-preview" aria-label="상담창 미리보기">
              <div className="ac-preview-head">
                <span className="ac-preview-avatar" aria-hidden="true">G</span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: 'block', fontSize: 14, fontWeight: 800 }}>GOWON Chat</span>
                  <span style={{ display: 'block', fontSize: 10.5, opacity: .88 }}>미리보기 · 실제 상담창과 같은 답변</span>
                </span>
                <span className="ac-preview-ai"><span aria-hidden="true">●</span> AI가 응대합니다</span>
              </div>
              <div className="ac-preview-body" role="log" aria-live="polite" aria-label="미리보기 대화">
                <div className="ac-pv-bot">안녕하세요! 무엇을 도와드릴까요?</div>
                {testLog.slice().reverse().map((t, i) => (
                  <div key={i} className="ac-pv-turn">
                    <div className="ac-pv-user">{t.q}</div>
                    <div className="ac-pv-bot">
                      {t.reply}
                      {t.citation && <span className="ac-pv-cite">근거 · {t.citation.source}</span>}
                    </div>
                  </div>
                ))}
                {testBusy && (
                  <div className="ac-pv-bot" aria-label="답변을 작성하고 있습니다">
                    <span className="gw-dot" /> <span className="gw-dot" /> <span className="gw-dot" />
                  </div>
                )}
                <div ref={testEndRef} />
              </div>
              <div className="ac-preview-foot">고객에게는 이렇게 보입니다. 문구를 바꾸려면 「지식베이스」나 「시나리오 룰」에서 수정하세요.</div>
            </section>
          </div>
        </div>
      )}

      {tab === 'install' && (
        <section style={S.card} aria-label="설치">
          <h2 style={{ fontSize: 16 }}>사이트에 상담창 붙이기</h2>
          <p style={{ fontSize: 13.5, color: 'var(--sub)', lineHeight: 1.7, margin: '8px 0 14px' }}>
            아래 한 줄을 홈페이지 <code>&lt;body&gt;</code> 끝에 넣으면 상담창이 나타납니다. 닫혀 있을 때는 버튼만 차지하므로 기존 페이지 클릭을 방해하지 않습니다.
          </p>
          <pre style={{ background: 'var(--ink)', color: '#E2E8F0', fontSize: 12.5, borderRadius: 'var(--r-sm)', padding: '14px 16px', overflowX: 'auto', margin: 0 }}>
            <code>{installSnippet(origin)}</code>
          </pre>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
            <button
              style={S.btn}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(installSnippet(origin));
                  setCopied('설치 코드를 복사했습니다.');
                } catch {
                  setCopied('복사에 실패했습니다. 코드를 직접 선택해 복사해 주세요.');
                }
              }}
            >
              설치 코드 복사
            </button>
            <a style={{ ...S.btnGhost, display: 'inline-block' }} href="/" target="_blank" rel="noopener noreferrer">동작 화면 보기</a>
          </div>
          {copied && <p role="status" style={{ fontSize: 13, color: 'var(--brand-600)', marginTop: 10 }}>{copied}</p>}

          <h3 style={{ fontSize: 14, fontWeight: 800, margin: '22px 0 8px' }}>선택 옵션</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--sub)' }}>
                <th style={{ padding: '8px 6px', borderBottom: '1px solid var(--line)', width: 150 }}>옵션</th>
                <th style={{ padding: '8px 6px', borderBottom: '1px solid var(--line)' }}>설명</th>
              </tr>
            </thead>
            <tbody>
              {INSTALL_OPTIONS.map(([opt, desc]) => (
                <tr key={opt}>
                  <td style={{ padding: '8px 6px', borderBottom: '1px solid var(--line)' }}><code>{opt}</code></td>
                  <td style={{ padding: '8px 6px', borderBottom: '1px solid var(--line)', color: 'var(--sub)' }}>{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ ...S.tag, marginTop: 14 }}>
            설치 코드는 운영자용 정보라 홈페이지에는 표시하지 않습니다. 이 화면에서만 확인해 주세요.
          </p>
        </section>
      )}
        </main>
      </div>

      {ticketId && (() => {
        const t = tickets.find((x) => x.id === ticketId);
        if (!t) return null;
        return (
          <TicketDrawer
            ticket={t}
            hasConversation={recentTurns.some((r) => r.sessionId === t.sessionId)}
            busy={ticketBusy}
            onClose={closeTicket}
            onStatus={(st) => patchTicket(t.id, st)}
            onOpenConversation={() => {
              const from = ticketReturnRef.current;
              closeTicket();
              openDrawer(t.sessionId, from);
            }}
            closeRef={ticketCloseRef}
          />
        );
      })()}

      {accountId && (() => {
        const a = accounts.find((x) => x.id === accountId);
        if (!a) return null;
        return (
          <AccountDrawer
            account={a}
            partnerName={(id) => (id ? partners.find((p) => p.id === id)?.name ?? '이름 없는 파트너' : '직접 계약')}
            canWrite={canWrite}
            onClose={closeAccount}
            onEdit={() => { closeAccount(); editAccount(a); }}
            closeRef={accountCloseRef}
          />
        );
      })()}

      {drawerSession && (
        <ConversationDrawer
          sessionId={drawerSession}
          turns={recentTurns
            .filter((t) => t.sessionId === drawerSession)
            .slice()
            .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())}
          ticket={tickets.find((tk) => tk.sessionId === drawerSession)}
          onClose={closeDrawer}
          onOpenTicket={() => {
            closeDrawer();
            setTab('esc');
          }}
          closeRef={drawerCloseRef}
        />
      )}

      {/* 되돌릴 수 없는 동작 확인 — 삭제·초기화는 전부 이 대화상자를 거친다(DS 5-4). */}
      {confirmReq && <ConfirmDialog req={confirmReq} />}

      {/* 저장·삭제 결과 알림(토스트) — 화면 어디에 있든 같은 자리에서 알린다. */}
      {notice && (
        <div className="ac-toast" role="status" aria-live="polite">{notice}</div>
      )}
    </div>
  );
}
