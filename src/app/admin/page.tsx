'use client';

// 관리 콘솔(MVP): 지식베이스(FAQ) CRUD · 시나리오 룰 편집 · 응답 테스트.
// 저장은 인메모리 스텁 — [승인 필요] DB 영구 저장·관리자 인증(현재 ADMIN_TOKEN 미설정 시 개방).
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';

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

/** 서버와 같은 한계값 — 보내기 전에 이유를 밝히려면 화면도 알고 있어야 한다.
 *  원본은 `src/lib/ingest.ts`(MAX_DOC_CHARS)와 `src/app/api/admin/kb/import/route.ts`(청크 clamp)이며,
 *  콘솔은 lib 을 불러오지 않으므로(클라이언트 번들) 여기에 옮겨 적고 테스트가 두 값을 맞춰 고정한다.
 *  어긋나면 화면은 통과시켰는데 서버가 거절하거나, 서버가 조용히 값을 바꿔 버린다. */
const MAX_DOC_CHARS = 100_000;
const MIN_CHUNK_CHARS = 120;
const MAX_CHUNK_CHARS = 2000;
/** 기본 규칙 답변 덮어쓰기 길이 상한 — 원본은 `src/lib/adminStore.ts`(MAX_RULE_REPLY_LEN). */
const MAX_RULE_REPLY_LEN = 1000;

/**
 * 조사를 받침에 맞춰 붙인다 — 원본은 `src/lib/refusal.ts`(josa).
 * 콘솔은 lib 을 불러오지 않으므로 여기에 옮겨 적고, 테스트가 두 결과를 맞춰 고정한다.
 * 종전에는 「감사 로그을(를) 내려받지 못했습니다」처럼 괄호가 그대로 보였다(DS 29-3).
 */
function josa(word: string, withBatchim: string, withoutBatchim: string): string {
  const last = (word || '').trim().slice(-1);
  const code = last ? last.charCodeAt(0) : 0;
  const hangul = code >= 0xac00 && code <= 0xd7a3;
  return `${word}${hangul && (code - 0xac00) % 28 !== 0 ? withBatchim : withoutBatchim}`;
}

/**
 * 거절한 칸 중 **화면에서 가장 먼저 나오는 칸**의 id (DS 29-1).
 * `order` 는 폼에 그려진 순서다 — 아래쪽 칸으로 데려가면 위에 남은 오류를 지나친다.
 */
function firstErrorId(errs: Record<string, unknown>, order: readonly (readonly [string, string])[]): string | null {
  for (const [key, id] of order) if (errs[key]) return id;
  return null;
}

/**
 * 거절한 칸으로 **데려간다** (DS 29-1).
 * 이유를 칸 아래에 적어 두기만 하면 두 사람이 그것을 못 본다:
 *  ① 스티키 편집 폼은 화면에 들어갈 만큼만 차지하고 넘치는 만큼은 자기 상자 안에서
 *     스크롤하므로(DS 26-3), 「저장」을 누른 사람 눈에 위쪽 칸의 오류가 보이지 않는다.
 *  ② `aria-invalid`·`aria-describedby` 는 **초점이 닿을 때만** 읽힌다 — 초점이 버튼에
 *     남아 있으면 스크린리더는 아무 말도 하지 않는다(거절당한 줄도 모른다).
 * 그래서 거절하는 자리마다 이 문을 지난다. 칸이 없으면 아무 일도 하지 않는다(초점을 잃지 않는다).
 */
function focusErrorField(id: string | null): void {
  if (!id || typeof document === 'undefined') return;
  const el = document.getElementById(id);
  if (!el) return;
  el.focus();
  // 상자 안에 가려진 칸은 끌어온다. `nearest` 라 이미 보이는 칸은 움직이지 않는다(화면이 튀지 않는다).
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
}

/** 성공 안내가 스스로 사라지는 시간. 실패는 사라지지 않는다(DS 29-2). */
const NOTICE_MS = 2500;

/** 폼마다 「칸 → 그 칸의 id」를 **화면에 그려진 순서로** 적어 둔다(DS 29-1). */
const IMP_FIELD_ORDER = [['title', 'kb-imp-title'], ['maxChars', 'kb-imp-chunk'], ['text', 'kb-imp-text']] as const;
const KB_FIELD_ORDER = [['question', 'kb-question'], ['keywords', 'kb-keywords'], ['answer', 'kb-answer']] as const;
const CR_FIELD_ORDER = [['label', 'cr-label'], ['keywords', 'cr-keywords'], ['reply', 'cr-reply']] as const;
const ACCOUNT_FIELD_ORDER = [['name', 'a-name'], ['partnerId', 'a-partner'], ['contractedAt', 'a-date'], ['monthlyFeeKrw', 'a-fee']] as const;
const PARTNER_FIELD_ORDER = [['name', 'p-name'], ['feeRatePct', 'p-fee']] as const;

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
  /** 연락처를 파기한 시각(완료·취소 처리 시 서버가 지운다). 「처음부터 없음」과 구분해 보여준다. */
  contactPurgedAt?: string;
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
    /** `label` 은 서버가 붙인 주제 표시명이다(`@/lib/intents`) — 화면은 코드를 그리지 않는다. */
    topIntents: { intent: string; count: number; label?: string }[];
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
  /**
   * 고객이 누른 답변 평가(DS 32-1). 구버전 응답 대비 optional —
   * 값이 없으면 카드는 「측정 중」이고, 0% 로 단정하지 않는다.
   */
  feedback?: {
    total: number;
    up: number;
    down: number;
    /** 도움됨 비율(%). 평가 0건이면 null. */
    helpfulRate: number | null;
    /** 👎가 많은 근거(=보완 대상) 순 상위 목록. */
    topDown: { citation: string; down: number }[];
  };
}

/** 자료에 없어 기본 안내로 끝난 질문 묶음(DS 32-2). 서버 `unansweredQuestions()` 와 같은 모양. */
interface UnansweredView {
  items: { key: string; question: string; count: number; lastAt: string }[];
  /** 자르기 전의 전체 묶음 수 — 보여 준 수를 찾은 수라고 말하지 않는다(DS 31-3). */
  groups: number;
  /** 그 질문들이 받은 총 횟수. */
  turns: number;
}

/** 처리 시간을 사람이 읽는 단위로 — 1초 미만은 ms, 그 이상은 소수 1자리 초. */
function latencyLabel(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}초`;
}

/** 값이 아직 없는 지표는 0을 지어내지 않고 「측정 중」으로 표시한다(§13). */
const MEASURING = '측정 중';

/**
 * 근거 없이 답한 답변에 달린 평가를 묶는 이름 — 서버 `@/lib/feedback` 의 같은 문자열과 맞춰야 한다
 * (콘솔은 lib 을 불러오지 않으므로 옮겨 적고 **테스트가 두 쪽을 대조한다** — `MAX_DOC_CHARS` 와 같은 방식).
 * 이 줄은 자료가 아니므로 「지식베이스에서 찾기」로 데려가지 않는다.
 */
const NO_CITATION_LABEL = '근거 없음';

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

/** 상태 톤 — 「배경 틴트 + 본문색」 짝. 콘솔의 모든 상태 pill·배너가 여기만 참조한다.
 *  DS 5-4 가 globals.css 에 틴트 토큰(--success-50/--warn-50/--danger-50)을 단일 출처로 세웠지만,
 *  콘솔 화면에는 같은 값이 hex 로 18곳 흩어져 있었다 — 토큰을 바꿔도 따라오지 않는 색들이다.
 *  묶어 두면 「AICC Portal 과 같은 색인가」를 한 곳에서 판단할 수 있다. */
const TONE = {
  ok: { background: 'var(--success-50)', color: 'var(--success)' },
  warn: { background: 'var(--warn-50)', color: 'var(--warn)' },
  danger: { background: 'var(--danger-50)', color: 'var(--danger)' },
  brand: { background: 'var(--brand-50)', color: 'var(--brand-600)' },
  mute: { background: 'var(--bg)', color: 'var(--mut)' },
} as const;

/** 처리 상태 pill 색 — 토큰만 쓴다(성공/경고/기본). */
const TICKET_STATUS_TONE: Record<TicketView['status'], { background: string; color: string }> = {
  open: TONE.warn,
  in_progress: TONE.brand,
  resolved: TONE.ok,
  canceled: TONE.mute,
};

function timeLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * 한국 시간 기준 이번 달 'YYYY-MM' — 정산 기준월의 기본값.
 * 원본은 `src/lib/kst.ts`(kstMonth)이며, 콘솔은 lib 을 불러오지 않으므로(클라이언트 번들 ·
 * MAX_DOC_CHARS 와 같은 이유) 계산식을 여기에 옮겨 적고 **테스트가 두 결과를 맞춰 고정한다**.
 * 어긋나면 화면은 「7월」을 보여주면서 서버는 다른 달을 기본값으로 계산한다.
 * 브라우저 시간대(`toISOString` = UTC, 해외에서 접속한 PC)에 기대지 않는 이유이기도 하다.
 */
function kstMonthNow(at: Date = new Date()): string {
  const d = new Date(at.getTime() + 9 * 60 * 60 * 1000); // KST = UTC+9, 일광절약시간 없음
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
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

/**
 * 뒤 화면 스크롤을 잠근다 — 되돌리는 함수를 돌려준다(DS 26-1).
 *
 * 서랍·대화상자는 화면을 덮지만 **뒤 화면의 스크롤까지 막지는 않는다.** 흐린 배경 위에서 휠을
 * 굴리면 뒤의 표가 흘러가고, 서랍 본문의 끝에서 더 굴리면 그 스크롤이 뒤 화면으로 넘어간다.
 * 닫고 나면 눌렀던 행은 화면 밖이고, 돌려준 초점은 보이지 않는 곳에 있다.
 * 고객사 사이트에서는 이미 이렇게 하고 있었다(`public/embed.js` 의 `lockHost` — 전체화면 상담창이
 * 열린 동안 호스트 페이지를 잠근다). 같은 방식을 우리 콘솔에도 쓴다.
 *
 * 잠글 때의 스크롤 위치와 **원래 인라인 스타일**을 기억해 두었다가 풀 때 그대로 되돌린다 —
 * 덮개가 겹쳐 열려도(서랍 위의 확인 대화상자) 나중에 열린 것부터 풀리므로 값이 어긋나지 않는다.
 * 스크롤바가 사라지면 본문이 그만큼 넓어져 표가 다시 배치되므로(화면이 덜컥 움직인다)
 * 사라진 폭만큼 오른쪽을 메워 둔다.
 */
function lockPageScroll(win: Window, doc: Document): () => void {
  const body = doc.body;
  const y = win.scrollY || 0;
  const prevOverflow = body.style.overflow;
  const prevPad = body.style.paddingRight;
  const raw = win.innerWidth - doc.documentElement.clientWidth;
  const gap = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
  body.style.overflow = 'hidden';
  if (gap > 0) body.style.paddingRight = `${gap}px`;
  return () => {
    body.style.overflow = prevOverflow;
    body.style.paddingRight = prevPad;
    win.scrollTo(0, y);
  };
}

/** 덮개가 열려 있는 동안만 잠근다 — 잠금의 수명이 덮개의 수명과 정확히 같다(DS 26-1). */
function useScrollLock() {
  useEffect(() => {
    try {
      return lockPageScroll(window, document);
    } catch {
      return undefined; // 스크롤을 잠그지 못해도 덮개 자체는 열린다
    }
  }, []);
}

/** 세로로 넘치는가 — 넘치는 상자에만 초점을 준다(DS 26-2). */
function overflowsY(el: { scrollHeight: number; clientHeight: number }) {
  return el.scrollHeight - el.clientHeight > 1;
}

/**
 * 세로로 넘치는 상자는 **키보드로도** 스크롤할 수 있어야 한다 — DS 26-2.
 *
 * DS 9-1 이 가로 넘침(`ScrollX`)에 세운 규칙과 같다: 스크롤 영역 안에 초점 받을 것이 없으면
 * 휠·손가락 없이는 끝까지 읽을 수 없다. 서랍 본문은 말풍선·타임라인뿐이라 Tab 이 닿지 않고,
 * 화살표 키는 초점이 있는 곳(머리의 닫기 버튼) 기준으로 **뒤 화면**을 굴린다 —
 * 뒤 화면을 잠그면(DS 26-1) 그나마 있던 그 길까지 사라지므로 둘은 함께 고쳐야 한다.
 *
 * 넘치는지는 실제로 재서 정한다 — 넘치지 않는데 Tab 이 멈추면 그 자체가 방해다.
 * 내용이 늘어나면(말풍선 추가) 다시 재야 하므로 `signal` 이 바뀔 때마다 측정한다.
 */
function useScrollableY<T extends HTMLElement>(signal: unknown): [RefObject<T>, boolean] {
  const ref = useRef<T | null>(null);
  const [scrollable, setScrollable] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setScrollable(overflowsY(el));
    measure();
    let ro: ResizeObserver | null = null;
    try {
      if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(measure);
        ro.observe(el);
      }
    } catch {
      ro = null; // 관찰을 못 걸어도 창 크기 변화·내용 변화로는 따라간다
    }
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [signal]);
  return [ref as RefObject<T>, scrollable];
}

/**
 * 넘치는 동안에만 붙는 초점 속성 — 넘치지 않는 상자는 Tab 순서에 끼지 않는다(DS 26-2).
 * 이미 이름이 있는 상자(`role="log"` 의 대화 목록)에는 초점만 준다 — 역할을 덮으면
 * 「새 말풍선을 읽어 주는 영역」이라는 뜻이 사라진다. 이름이 없는 상자에는 `ScrollX` 와 같은
 * 방식으로 역할·이름을 함께 준다(초점이 갔을 때 무엇을 스크롤하는지 들려야 한다).
 */
function scrollFocusProps(scrollable: boolean, label?: string) {
  if (!scrollable) return {};
  return label ? { tabIndex: 0, role: 'region', 'aria-label': `${label} — 세로로 스크롤할 수 있습니다` } : { tabIndex: 0 };
}

/**
 * 폼에 **아직 저장하지 않은 내용**이 남아 있는가 (DS 27-2).
 *
 * 기준선(마지막으로 **프로그램이** 채운 값 — 수정 시작·저장 완료·취소)과 값만 비교한다. 사용자가
 * 치는 것은 기준선을 옮기지 않으므로, 둘이 다르면 그 차이가 곧 「적던 내용」이다.
 * 앞뒤 공백만의 차이는 적은 것으로 보지 않는다 — 칸을 눌렀다 지운 것 때문에 확인이 뜨면
 * 그 확인은 금세 읽지 않고 누르는 것이 되고, 정작 삭제 확인(DS 5-4)까지 함께 무뎌진다.
 */
function formDirty<T extends object>(cur: T, base: T): boolean {
  // 같은 모양끼리만 견준다(`T` 하나) — 다른 폼의 기준선과 대조하면 늘 「적던 내용이 있다」가 된다.
  const c = cur as Record<string, unknown>;
  const z = base as Record<string, unknown>;
  const keys = Object.keys(c).concat(Object.keys(z).filter((k) => !(k in c)));
  for (const k of keys) {
    const a = c[k];
    const b = z[k];
    // 체크박스처럼 값이 둘뿐인 칸은 공백을 다듬을 것이 없다 — 그대로 견준다.
    if (typeof a === 'boolean' || typeof b === 'boolean') {
      if (a !== b) return true;
      continue;
    }
    if (String(a ?? '').trim() !== String(b ?? '').trim()) return true;
  }
  return false;
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

  useScrollLock();
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
  useScrollLock();
  // 말풍선뿐인 본문이라 넘치는 동안에는 목록 자체가 초점을 받아야 한다(DS 26-2).
  const [bodyRef, bodyScrolls] = useScrollableY<HTMLDivElement>(turns.length);
  const escalated = turns.some((t) => t.escalate);
  const channel = turns[0]?.channel ?? '';
  const first = turns[0]?.at;
  const last = turns[turns.length - 1]?.at;

  // 초점 순환(Tab/Shift+Tab 이 서랍 밖으로 나가지 않는다). ESC 는 부모가 처리한다.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !panelRef.current) return;
    // `aria-disabled` 버튼은 초점을 받을 수 있으므로 목록에 남긴다 — 진행 중에도 순환이 끊기지 않는다(DS 8-1).
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
          <span className="ac-pill" style={escalated ? TONE.warn : TONE.ok}>
            {escalated ? '상담원 제안됨' : '자동 응대로 완료'}
          </span>
          {ticket && <span className="ac-pill">접수 {TICKET_STATUS_LABELS[ticket.status]}</span>}
        </div>

        <div ref={bodyRef} className="ac-drawer-body" role="log" aria-label="대화 내용" {...scrollFocusProps(bodyScrolls)}>
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
                  <span className="ac-pill">{t.intentLabel || UNNAMED_TOPIC}</span>
                  <span className="ac-pill">{SOURCE_VIEW_LABELS[t.source] || t.source}</span>
                  {t.escalate && <span className="ac-pill" style={TONE.warn}>상담원 제안</span>}
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
  useScrollLock();
  // 이관 요약이 길면 본문이 넘친다 — 「보기」 하나만으로는 그 아래까지 닿지 못한다(DS 26-2).
  const [bodyRef, bodyScrolls] = useScrollableY<HTMLDivElement>(showContact);
  const t = ticket;
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !panelRef.current) return;
    // `aria-disabled` 버튼은 초점을 받을 수 있으므로 목록에 남긴다 — 진행 중에도 순환이 끊기지 않는다(DS 8-1).
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
          {t.contact
            ? <span className="ac-pill">연락처 남김</span>
            : <span className="ac-pill" style={TONE.mute}>{t.contactPurgedAt ? '연락처 파기됨' : '연락처 없음'}</span>}
        </div>

        <div ref={bodyRef} className="ac-drawer-body" {...scrollFocusProps(bodyScrolls, '요청 내용')}>
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
            ) : t.contactPurgedAt ? (
              <span style={{ fontSize: 13, color: 'var(--sub)' }}>
                상담이 끝나 <strong style={{ fontWeight: 700 }}>{timeLabel(t.contactPurgedAt)}</strong> 에 파기했습니다(개인정보처리방침 4조). 되살릴 수 없습니다.
              </span>
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
            <button type="button" {...busyBtn(busy, busy, S.btn)} onClick={() => onStatus('in_progress')}>상담 시작</button>
          )}
          {t.status === 'in_progress' && (
            <button type="button" {...busyBtn(busy, busy, S.btn)} onClick={() => onStatus('resolved')}>완료 처리</button>
          )}
          {(t.status === 'open' || t.status === 'in_progress') && (
            <button type="button" className="ac-linkbtn" data-tone="danger" {...busyBtn(busy, busy, {})} onClick={() => onStatus('canceled')}>취소</button>
          )}
          {(t.status === 'resolved' || t.status === 'canceled') && (
            <button type="button" {...busyBtn(busy, busy)} onClick={() => onStatus('open')}>다시 열기</button>
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
  useScrollLock();
  // 귀속 이력이 쌓이면 타임라인이 길어진다 — 그 안에는 초점 받을 것이 없다(DS 26-2).
  const [bodyRef, bodyScrolls] = useScrollableY<HTMLDivElement>(account.attribution.length);
  const a = account;
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !panelRef.current) return;
    // `aria-disabled` 버튼은 초점을 받을 수 있으므로 목록에 남긴다 — 진행 중에도 순환이 끊기지 않는다(DS 8-1).
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
          <span className="ac-pill" style={typeof a.monthlyFeeKrw === 'number' ? undefined : TONE.mute}>
            월 {wonLabel(a.monthlyFeeKrw)}
          </span>
        </div>

        <div ref={bodyRef} className="ac-drawer-body" {...scrollFocusProps(bodyScrolls, '계약 정보와 귀속 이력')}>
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
                      {h.authed && <span className="ac-pill" style={TONE.ok}>인증됨</span>}
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

/**
 * ── 행이 많아진 뒤의 표 (DS 31-1·31-2) ──
 *
 * 콘솔의 표 8장은 모두 「자료 열 몇 건」을 전제로 그려졌다 — 거른 행을 **등록순으로 전부** 그리고,
 * 끝이 없다. 운영 반년이면 안내 자료 수백 건·접수 수천 건이 한 화면에 쌓이고, 그 안에서
 * 「오래 기다린 접수」·「수수료가 큰 고객사」를 찾는 길이 브라우저 찾기(Ctrl+F)밖에 없다.
 *
 * 기준 원본(`callbot-portal/public/admin.html`)은 같은 문제를 이미 겪고 두 가지를 넣어 두었다 —
 * 헤더 클릭 정렬(B91: 「콘솔 표에는 정렬 기능이 전혀 없어 행이 많아지면 원하는 값을 찾기 어려웠음」,
 * `aria-sort`·Enter/Space·숫자/한국어 비교)과 15행 페이저(`총 N건 · p/pages 페이지`).
 * 색·카드·표 머리 규격만 이식하고 **표를 다루는 기능**은 가져오지 않았던 자리다(DS 25-1 과 같은 종류의 누락).
 */
const TABLE_PAGE_ROWS = 15;
type SortDir = 'asc' | 'desc';
interface SortState { col: string; dir: SortDir }
type Cell = string | number | null | undefined;
type SortCols<T> = Record<string, (r: T) => Cell>;

/**
 * 셀 하나의 비교. 숫자는 숫자로, 글자는 한국어 사전 순으로 본다(`numeric` — 「2건」과 「10건」이
 * 자리수대로 선다). **빈 값은 방향과 무관하게 뒤로 보낸다**: 미입력(「—」)이 위로 몰리면 오름차순
 * 첫 장이 빈 칸으로 가득 차, 정렬한 사람이 보려던 값은 어느 장에도 보이지 않는다.
 */
function compareCell(a: Cell, b: Cell, dir: SortDir): number {
  const empty = (v: Cell) => v === null || v === undefined || v === '';
  if (empty(a) && empty(b)) return 0;
  if (empty(a)) return 1;
  if (empty(b)) return -1;
  const r = typeof a === 'number' && typeof b === 'number'
    ? a - b
    : String(a).localeCompare(String(b), 'ko', { numeric: true });
  return dir === 'asc' ? r : -r;
}

/**
 * 고른 열로 정렬한 **사본**. 고른 열이 없으면 원래 순서를 그대로 돌려준다 —
 * 기본 순서가 뜻을 가진 표가 있다(접수는 최신순, 고객사는 이름순). 같은 값끼리는 원래 순서를
 * 지킨다(`Array.prototype.sort` 는 안정 정렬이다) — 정렬을 걸 때마다 같은 값들이 섞이면
 * 「방금 본 행이 어디로 갔는가」를 매번 다시 찾게 된다.
 */
function sortRows<T>(rows: T[], sort: SortState | undefined, cols: SortCols<T>): T[] {
  const pick = sort ? cols[sort.col] : undefined;
  if (!sort || !pick) return rows;
  return rows.slice().sort((x, y) => compareCell(pick(x), pick(y), sort.dir));
}

/** 「몇 건 중 몇 번째 줄을 보고 있는가」 — 페이저가 말하는 것은 이 숫자뿐이다. */
interface PageInfo { page: number; pages: number; total: number; from: number; to: number }

/**
 * 한 장 잘라낸다. 들어온 `page` 가 범위를 넘으면(거르고 나니 장 수가 줄었다) 마지막 장으로 끌어온다 —
 * 빈 장을 보여 주면 「조건에 맞는 것이 없다」와 구분할 수 없다.
 */
function pageSlice<T>(rows: T[], page: number, size = TABLE_PAGE_ROWS): PageInfo & { rows: T[] } {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const cur = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const from = (cur - 1) * size;
  const slice = rows.slice(from, from + size);
  return { rows: slice, page: cur, pages, total: rows.length, from: rows.length ? from + 1 : 0, to: from + slice.length };
}

/**
 * 정렬되는 머리칸. 글자는 그대로 두고(`th` 의 접근 이름이 「질문 기준으로 정렬」로 길어지면
 * 셀마다 그 문장이 따라 읽힌다) 방향은 `aria-sort` 로 알린다 — 화면에는 ↕/↑/↓ 글리프가 붙는다
 * (색이 아니라 **글자**라서 고대비·흑백 인쇄에서도 남는다).
 */
function SortTh({ label, col, sort, onSort, className, width, align }: {
  label: string;
  col: string;
  sort: SortState | undefined;
  onSort: (col: string) => void;
  className?: string;
  width?: number;
  /** 금액 열처럼 값이 오른쪽에 붙는 열 — 머리칸도 같은 쪽에 선다. */
  align?: 'right';
}) {
  const active = sort?.col === col;
  return (
    <th
      scope="col"
      className={`ac-th-sort${className ? ` ${className}` : ''}`}
      style={width ? { width } : undefined}
      aria-sort={active ? (sort?.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        className={`ac-sortbtn${align === 'right' ? ' ac-sortbtn-right' : ''}`}
        title={`${label} 기준으로 정렬`}
        onClick={() => onSort(col)}
      >
        {label}
      </button>
    </th>
  );
}

/**
 * 표 아래 페이저. 장이 하나면 아무것도 그리지 않는다 — 없는 조작을 보이면 그 자체가 방해다.
 *
 * `disabled` 를 쓰지 않는다(DS 8-1): 키보드로 「다음」을 눌러 마지막 장에 닿는 순간 그 버튼이
 * 비활성이 되면 초점이 본문 밖으로 떨어져 화면 맨 위부터 Tab 을 다시 눌러야 한다.
 * 끝에서는 `aria-disabled` 로 알리고 눌러도 아무 일이 없게 한다.
 */
function Pager({ info, label, unit = '건', onPage }: { info: PageInfo; label: string; unit?: string; onPage: (p: number) => void }) {
  if (info.pages <= 1) return null;
  const first = info.page <= 1;
  const last = info.page >= info.pages;
  // 버튼 규격은 콘솔 공통(S.btnGhost)에서 가져오고 크기만 줄인다 — 표 아래 줄이 툴바처럼 두꺼워지지 않게.
  const btn = { ...S.btnGhost, fontSize: 12.5, padding: '6px 10px', minHeight: 32 } as const;
  return (
    <nav className="ac-pager" aria-label={`${label} 페이지 이동`}>
      <span className="ac-pager-cnt" role="status" aria-live="polite">
        총 {info.total.toLocaleString('ko-KR')}{unit} 중 {info.from}–{info.to}번째 · {info.page}/{info.pages} 페이지
      </span>
      <button
        type="button"
        {...busyBtn(false, first, btn)}
        aria-label={`${label} 이전 페이지`}
        onClick={() => { if (!first) onPage(info.page - 1); }}
      >
        ‹ 이전
      </button>
      <button
        type="button"
        {...busyBtn(false, last, btn)}
        aria-label={`${label} 다음 페이지`}
        onClick={() => { if (!last) onPage(info.page + 1); }}
      >
        다음 ›
      </button>
    </nav>
  );
}

/**
 * 가로로 넘칠 수 있는 영역(표·코드 블록)의 공통 껍데기 — DS 9-1.
 *
 * 좁은 화면에서 표는 칸을 줄일 수 없는 지점이 있다(버튼·배지·날짜는 줄바꿈하면 더 나빠진다).
 * 넘치는 것 자체는 막을 수 없으므로 **넘치는 곳을 화면 밖이 아니라 이 상자 안에서** 넘치게 한다.
 * 넘치는 순간 이 상자는 스크롤 영역이 되고, 스크롤 영역은 키보드로 닿을 수 있어야 한다
 * (안에 초점 받을 것이 없는 칸 — 숫자·날짜 — 만 가려져 있으면 Tab 으로는 영영 볼 수 없다).
 *
 * 초점을 받을지는 실제로 넘치는지를 재서 정한다 — 넘치지 않는데 Tab 이 멈추면 그 자체가 방해다.
 * 서버 렌더·측정 전에는 **닿을 수 있는 쪽**을 기본값으로 둔다(JS 가 죽어도 스크롤은 남는다).
 */
function ScrollX({ label, children, style }: { label: string; children: ReactNode; style?: CSSProperties }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [scrollable, setScrollable] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setScrollable(el.scrollWidth - el.clientWidth > 1);
    measure();
    let ro: ResizeObserver | null = null;
    try {
      if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(measure);
        ro.observe(el);
        if (el.firstElementChild) ro.observe(el.firstElementChild);
      }
    } catch {
      ro = null; // 관찰을 못 걸어도 창 크기 변화로는 따라간다
    }
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  return (
    <div
      ref={ref}
      className="ac-scrollx"
      style={style}
      {...(scrollable ? { role: 'region', tabIndex: 0, 'aria-label': `${label} — 가로로 스크롤할 수 있습니다` } : {})}
    >
      {children}
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

/**
 * 「언제 것인가」 + 「새로고침」 (DS 24-1).
 * 화면이 스스로 다시 확인하게 된 이상, 눈앞의 숫자가 **언제 받은 값인지** 밝히지 않으면
 * 운영자는 그것이 방금 것인지 한 시간 전 것인지 구분할 수 없다. 자동 확인이 돈다는 사실도
 * 함께 적는다 — 적지 않으면 「새로고침을 눌러야 하나」를 매번 다시 생각하게 된다.
 * 30초마다 바뀌는 글이라 읽어 주는 영역(live region)으로 만들지 않는다(쉬지 않고 떠드는 화면이 된다).
 */
function SyncStatus({ at, onRefresh }: { at: number; onRefresh: () => void }) {
  return (
    <>
      <span style={{ ...S.tag, whiteSpace: 'nowrap' }}>
        {at > 0 ? `${new Date(at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} 기준` : '확인 전'}
        {` · ${Math.round(OPS_POLL_MS / 1000)}초마다 자동 확인`}
      </span>
      <button type="button" style={S.btnGhost} onClick={onRefresh}>새로고침</button>
    </>
  );
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
  /** 주제 표시명(서버가 `@/lib/intents` 로 붙인다). 화면은 코드가 아니라 이 값을 쓴다. */
  intentLabel?: string;
  source: string;
  escalate: boolean;
  at: string;
}

/** 응답 근거 표시 — 화면에서는 내부 코드 대신 사람이 읽는 말로 보여준다.
 *  원본은 `src/lib/intents.ts`(SOURCE_LABELS·CHANNEL_LABELS)이며 내려받기 파일도 그 값을 쓴다.
 *  콘솔은 lib 을 불러오지 않으므로(클라이언트 번들) 여기에 옮겨 적고 테스트가 두 사전을 맞춰 고정한다. */
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

/**
 * 대화 주제 표시명은 **서버가 붙여 보낸다**(`src/lib/intents.ts` → `intentLabel` 필드).
 *
 * 종전에는 이 파일이 사전 9개를 따로 들고 있다가 없으면 인텐트 코드를 그대로 그렸다. 사전에는
 * 엔진이 내지 않는 키(`price`·`handoff`·`unknown`·`faq`)가 있었고, 가장 흔한 경로 — 등록 자료로
 * 답한 대화(`kb:환불`)·분류 전(`fallback`)·운영자가 만든 규칙(`cr_…`)·접수 폼 진행
 * (`form:reservation:datetime`) — 에는 이름이 없어 운영자 화면에 영문 코드가 그대로 떴다.
 * 이름을 붙이는 쪽은 어휘를 아는 서버 한 곳이고, 화면은 받은 이름만 그린다.
 */
const UNNAMED_TOPIC = '기타';

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
  /** 작업 표시명(서버가 `@/lib/audit` 로 붙인다). */
  actionLabel?: string;
  target: string;
  detail: string;
  authed: boolean;
}

/**
 * 작업 이름도 **서버가 붙여 보낸다**(`src/lib/audit.ts` 의 작업 표시명 → `actionLabel` 필드).
 * 종전에는 이 파일의 사전 9개로 이름을 붙이고 없으면 코드를 그려, 「사업」 그룹에서 새로 생긴
 * 4종(파트너·고객사 편집, 정산 내려받기)이 `partner.upsert` 처럼 영문 코드로 표·필터에 남았다.
 */
const UNNAMED_AUDIT_ACTION = '관리 작업';

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
  prospect: TONE.warn,
  contracted: TONE.ok,
  churned: TONE.mute,
};
const PARTNER_STATUS_TONE: Record<PartnerView['status'], { background: string; color: string }> = {
  active: TONE.ok,
  paused: TONE.mute,
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

/** 주소(해시)에 쓰는 탭 이름. 메뉴에 없는 값이 오면 대시보드로 되돌린다. */
const TAB_KEYS: readonly TabKey[] = TAB_GROUPS.flatMap((g) => g.tabs.map(([k]) => k));
const isTabKey = (v: string): v is TabKey => (TAB_KEYS as readonly string[]).includes(v);
/** 주소 뒤 `#kb` → 'kb', `#settle?m=2026-08&p=ptr_1` → 탭 + 그 탭이 읽는 조건.
 *  해시는 서버로 가지 않으므로 이 값들은 브라우저 안에서만 산다(서버 렌더는 항상 기본값).
 *  page.tsx 는 Next 가 export 를 검사하므로 내보내지 않는다(라우트 파일 규칙과 같은 이유). */
function viewFromHash(hash: string): { tab: TabKey; params: URLSearchParams } {
  const raw = (hash || '').replace(/^#/, '');
  const q = raw.indexOf('?');
  let name = q === -1 ? raw : raw.slice(0, q);
  try {
    name = decodeURIComponent(name);
  } catch {
    /* 반쯤 잘린 %-표기는 원문 그대로 두고 아래에서 걸러진다 */
  }
  return { tab: isTabKey(name) ? name : 'dash', params: new URLSearchParams(q === -1 ? '' : raw.slice(q + 1)) };
}
function tabFromHash(hash: string): TabKey {
  return viewFromHash(hash).tab;
}

/** 정산 기준월 — 주소에서 받은 값은 믿지 않는다(`?m=2026-13` 이면 지금 달로 되돌린다). */
const MONTH_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/;

/** 정산 조회 조건(기준월·파트너) — 「지금 화면이 원하는 것」과 「응답이 답한 것」을 대조하는 단위. */
interface SettleCond { month: string; partnerId: string }
function sameSettleCond(a: SettleCond, b: SettleCond): boolean {
  return a.month === b.month && a.partnerId === b.partnerId;
}

/**
 * **마지막으로 고른 조건까지 따라가는 조회.**
 *
 * 조회가 도는 동안 조건이 바뀌면 이미 돌고 있던 응답은 화면에 싣지 않고(`stillWanted()` 가
 * 거짓), 새 조건으로 한 번 더 조회한다. 종전에는 중복 실행 방지(`useRunOnce`)가 두 번째
 * 호출을 **조용히 버렸다** — 기준월만 새 달로 바뀌고 표·합계·KPI 는 앞선 달 그대로 남아,
 * 화면이 「7월」이라 말하면서 8월 수수료 합계를 보여줬다(운영자가 그대로 옮겨 적는 금액이다).
 * 아무 표시도 없으니 실패한 줄도 몰랐다(QUALITY_BAR §1·§3).
 *
 * `step` 이 `false` 를 돌려주면(세션 만료 등) 더 따라가지 않고 멈춘다.
 */
async function followLatest<T>(
  want: { current: T },
  same: (a: T, b: T) => boolean,
  step: (cond: T, stillWanted: () => boolean) => Promise<boolean>,
): Promise<void> {
  for (;;) {
    const cond = want.current;
    const go = await step(cond, () => same(want.current, cond));
    if (!go) return;
    if (same(want.current, cond)) return;
  }
}

/** 사이드바 라벨의 단일 출처 — 헤더 제목(h1)·본문 이름(aria-label)·브라우저 제목이 같은 값을 본다. */
const TAB_LABEL = Object.fromEntries(TAB_GROUPS.flatMap((g) => g.tabs)) as Record<TabKey, string>;

/** 브라우저 제목. 탭마다 다르게 둔다 — 주소(`#kb`)는 탭을 가리키는데 제목이 하나면
 *  북마크·방문 기록·탭 목록에 열 줄이 전부 같은 글자로 쌓인다(WCAG 2.4.2 Page Titled). */
function docTitle(tab: TabKey): string {
  return `${TAB_LABEL[tab] ?? '대시보드'} — 관리 콘솔 · GOWON Chat`;
}

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

/** 새 창으로 열리는 링크 — 보는 사람에게는 이 표시가, 듣는 사람에게는 이름 뒤 고지가 그 사실을 알린다.
 *  두 안내가 갈라지지 않게 한 곳에서만 만든다(DS 11-3). */
function ExternalLink({ href, label, className, style, children }: {
  href: string; label: string; className?: string; style?: CSSProperties; children?: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      // 접근 이름은 보이는 글자로 시작한다(음성 입력이 이름으로 누를 수 있어야 한다).
      aria-label={`${label} — 새 창에서 열립니다`}
      {...(className ? { className } : {})}
      {...(style ? { style } : {})}
    >
      {children ?? label}
      <svg aria-hidden="true" focusable="false" width="12" height="12" viewBox="0 0 16 16" fill="none"
        style={{ display: 'inline-block', verticalAlign: '-1px', marginLeft: 4, flexShrink: 0 }}>
        <path d="M6.5 3.5H3.2v9.3h9.3V9.5M9.6 2.8h3.6v3.6M13.2 2.8L7.6 8.4"
          stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </a>
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
/**
 * 종류별 최대 표시 수 — 목록이 화면을 덮지 않게 한다. 전체 상한은 두지 않는다(종전에는 12건이었다):
 * 종류가 일곱이라 목록은 이미 「7종 × (3건 + 모두 보기 1줄)」로 묶여 있고, 전체를 또 자르면
 * **뒤쪽 종류가 통째로 사라지면서** 그 사실을 말할 자리가 없다(DS 31-3).
 */
const SEARCH_PER_KIND = 3;

interface SearchHit {
  key: string;
  kind: SearchKind;
  title: string;
  detail: string;
  /** 「… n건 모두 보기」 줄 — 결과가 아니라 **그 종류의 전체로 가는 길**이다(건수에서 뺀다). */
  more?: boolean;
  /** 선택 시 실행. `from` 은 검색 입력칸 — 서랍을 열면 닫힐 때 초점이 여기로 돌아온다. */
  run: (from: HTMLElement | null) => void;
}

/** 집어 온 목록 + **종류별로 실제 찾은 건수**(보여 준 수와 다를 수 있다). */
interface SearchResult {
  hits: SearchHit[];
  found: Partial<Record<SearchKind, number>>;
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

function GlobalSearch({ search, onFirstOpen }: { search: (term: string, raw: string) => SearchResult; onFirstOpen?: () => void }) {
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
  const result = open && term ? search(term, q) : { hits: [], found: {} };
  const hits = result.hits;
  /** 보여 준 수가 아니라 **찾은 수** — 종류별 상한에 걸려 잘린 것까지 센다(DS 31-3). */
  const foundTotal = Object.values(result.found).reduce((s, n) => s + (n ?? 0), 0);
  const shownTotal = hits.filter((h) => !h.more).length;
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
      <span role="status" aria-live="polite" className="ac-srhide">
        {open && term
          ? foundTotal > shownTotal
            ? `검색 결과 ${foundTotal}건 — 종류별 상위 ${SEARCH_PER_KIND}건을 보여 줍니다. 나머지는 「모두 보기」로 엽니다.`
            : `검색 결과 ${foundTotal}건`
          : ''}
      </span>
      {open && term && (
        <div className="ac-gsearch-pop">
          <ul id={listId} role="listbox" aria-label="검색 결과" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {hits.length === 0 && (
              <li role="presentation" className="ac-gsearch-empty">
                「{clip(q, 30)}」에 맞는 항목이 없습니다. 다른 말로 찾아보세요.
              </li>
            )}
            {grouped.map((g) => {
              // 머리줄은 「무엇을 찾았는가」까지 적는다 — 세 줄만 보이는 종류에 84건이 있다는 사실은
              // 목록 어디에도 없었다(DS 31-3). 그룹 이름(aria-label)에도 같은 수를 담는다.
              const total = result.found[g.kind] ?? 0;
              const shown = g.items.filter(({ h }) => !h.more).length;
              const count = total > shown ? `${total}건 중 ${shown}건` : `${total}건`;
              return (
              <li key={g.kind} role="presentation">
                <div className="ac-gsearch-group" aria-hidden="true">{g.kind} <span className="ac-gsearch-gcnt">{count}</span></div>
                <ul role="group" aria-label={`${g.kind} ${count}`} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {g.items.map(({ h, i }) => (
                    <li
                      key={h.key}
                      id={optId(i)}
                      role="option"
                      aria-selected={i === activeIdx}
                      className="ac-gsearch-opt"
                      data-more={h.more ? 'true' : undefined}
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
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/** 관리 토큰 보관함 — **탭 단위**(sessionStorage)다.
 * `localStorage` 는 브라우저를 닫아도 남는다: 공용 PC·회의실 PC 에서 다음 사람이 /admin 을 열면
 * 이미 로그인된 콘솔이 뜨고, 거기서 대화 기록·연락처·백업까지 내려받을 수 있다.
 * 위젯 대화(DS 7-1)가 같은 이유로 sessionStorage 를 쓴다 — 자격 증명이 대화보다 오래 남을 이유는 없다.
 * 저장소를 못 쓰는 환경(사생활 보호 모드 등)에서도 콘솔은 그대로 동작한다(그 탭에서만 다시 로그인). */
const TOKEN_KEY = 'cb_admin_token';

function tokenStore(): Storage | null {
  try {
    return window.sessionStorage || null;
  } catch {
    return null; // 저장소 접근 차단 — 로그인 화면으로 간다
  }
}

/** 저장된 토큰을 읽는다. 이전 판이 localStorage 에 남긴 값은 한 번 옮기고 **지운다**. */
function readSavedToken(): string {
  const ss = tokenStore();
  try {
    const cur = ss?.getItem(TOKEN_KEY) || '';
    if (cur) return cur;
  } catch {
    /* 읽기 실패는 로그인 전과 같게 다룬다 */
  }
  try {
    const legacy = window.localStorage.getItem(TOKEN_KEY) || '';
    window.localStorage.removeItem(TOKEN_KEY);
    if (legacy) {
      try { ss?.setItem(TOKEN_KEY, legacy); } catch { /* 옮기지 못해도 이번 탭에서는 쓴다 */ }
    }
    return legacy;
  } catch {
    return '';
  }
}

/** 토큰을 저장하거나(값 있음) 지운다(빈 값 = 로그아웃). 옛 저장처도 함께 지운다. */
function writeSavedToken(v: string) {
  const ss = tokenStore();
  try {
    if (v) ss?.setItem(TOKEN_KEY, v);
    else ss?.removeItem(TOKEN_KEY);
  } catch {
    /* 저장하지 못해도 이번 탭에서는 tokenRef 로 동작한다 */
  }
  try { window.localStorage.removeItem(TOKEN_KEY); } catch { /* noop */ }
}

/** 「큰 글씨」 보기 설정(DS 25-1) — 토큰과 달리 **브라우저 단위**(localStorage)다.
 * 토큰은 자격 증명이라 탭을 닫으면 지워야 하지만(위 주석), 글자 크기는 **그 사람의 눈**에 달린 것이라
 * 매일 아침 다시 켜게 만들 이유가 없다. 비밀값이 아니므로 다음 사람이 봐도 새는 것이 없다.
 * 값은 '1'/없음 둘뿐이고, 읽을 때 다른 값은 꺼짐으로 다룬다. */
const VIEW_SCALE_KEY = 'cb_admin_big';

function readBigText(): boolean {
  try {
    return window.localStorage.getItem(VIEW_SCALE_KEY) === '1';
  } catch {
    return false; // 저장소 접근 차단 — 기본(보통 크기)으로 시작한다
  }
}

function writeBigText(on: boolean) {
  try {
    if (on) window.localStorage.setItem(VIEW_SCALE_KEY, '1');
    else window.localStorage.removeItem(VIEW_SCALE_KEY);
  } catch {
    /* 저장하지 못해도 이번 방문에서는 그대로 쓴다 */
  }
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

/**
 * 진행 중인 버튼의 공통 속성(내려받기·복원).
 *
 * `disabled` 를 쓰지 않는다: 키보드로 누른 버튼이 그 순간 비활성이 되면 **초점이 본문 밖으로 떨어져**
 * 사용자가 화면 맨 위부터 Tab 을 다시 눌러야 한다. 초점은 그대로 두고 `aria-disabled` 로 알린 뒤,
 * 실제 중복 실행은 각 처리 함수가 앞단에서 막는다.
 */
function busyBtn(busy: boolean, locked: boolean, base: React.CSSProperties = S.btnGhost) {
  return {
    style: { ...base, ...(locked ? { opacity: 0.55, cursor: busy ? 'progress' : 'not-allowed' } : {}) },
    'aria-busy': busy || undefined,
    'aria-disabled': locked || undefined,
  } as const;
}

/**
 * 중복 실행 차단 — `disabled` 를 쓰지 않는 대신(DS 5-8·8-1) 실행만 앞단에서 막는다.
 * 진행 중 state(`...Busy`)가 아니라 ref 를 쓴다: 같은 틱에 두 번 눌리면 state 는 아직 바뀌지 않았다.
 */
function useRunOnce() {
  const running = useRef<Record<string, boolean>>({});
  const claim = useCallback((key: string) => {
    if (running.current[key]) return false;
    running.current[key] = true;
    return true;
  }, []);
  const release = useCallback((key: string) => { running.current[key] = false; }, []);
  return { claim, release };
}

/**
 * ── 답이 끝내 오지 않을 때 ──
 * 브라우저 `fetch` 에는 **시간 제한이 없다.** 요청을 보낸 뒤 신호가 끊기거나 중간 장비가 연결만
 * 붙잡고 있으면, 그 약속(Promise)은 몇 분이 지나도 지켜지지도 깨지지도 않는다. 콘솔에서는 그 사이
 *  - 불러오기(DS 4-2)의 `phase` 가 `loading` 에 머물러 **스켈레톤이 영구히 반짝이고**, `error` 로
 *    가지 않으므로 「다시 시도」 버튼이 끝내 뜨지 않는다,
 *  - 저장·삭제는 `...Busy` 가 참인 채로 남아 `aria-busy` 가 계속 「저장하는 중」이라 읽히고,
 *  - 중복 실행 잠금(`claim`)이 `release` 를 못 만나 **그 탭에서는 같은 기능을 다시 누를 수조차 없다**
 *    (파트너·정산·저장소·테넌트·인증) — 새로고침 말고는 나오는 길이 없다.
 * 즉 DS 4-2·5-10 이 만든 실패 안내 경로가 **한 번도 실행되지 않는다**(QUALITY_BAR §1·§3).
 *
 * 그래서 콘솔의 모든 요청은 기한을 가진 이 한 곳을 거친다 — 기한이 지나면 끊고 평소의 실패 경로로 보낸다.
 * 위젯도 같은 대비를 가진다(`ChatWidget.tsx` 의 `postJson`). 상수는 테스트가 두 값을 맞춰 고정한다.
 */
const REQUEST_TIMEOUT_MS = 15_000;
/** 「응답 테스트」는 서버가 LLM 을 부를 수 있다(상한 8초 × 재시도 1회 = 약 16초) — 그보다 길게 둔다. */
const CHAT_TEST_TIMEOUT_MS = 25_000;

function afetch(input: string, init: RequestInit = {}, ms: number = REQUEST_TIMEOUT_MS): Promise<Response> {
  if (typeof AbortController === 'undefined') return fetch(input, init);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  // 본문(`res.json()`·`res.blob()`)을 읽는 동안에도 기한이 살아 있어야 한다 — 헤더만 오고 본문이
  // 멈추는 응답이 있다. 그래서 응답이 왔다고 타이머를 지우지 않는다: 이미 다 읽은 요청에 대한
  // `abort()` 는 아무 일도 하지 않고, 아직 읽지 않은 본문은 그때 끊기는 것이 맞다.
  return fetch(input, { ...init, signal: ctl.signal }).catch((e) => {
    clearTimeout(timer);
    throw e;
  });
}

/**
 * ── 아무도 보고 있지 않은 사이에 들어온 일 (DS 24-1) ──
 * 관리 콘솔의 화면은 **연 순간의 사진**이었다. 불러오기는 마운트 때 한 번뿐이고 되풀이가 없다.
 * 그런데 이 화면에서 가장 중요한 데이터(상담원 연결 요청)는 운영자가 아니라 **고객이** 만든다 —
 * 고객은 「상담원이 확인 후 순서대로 연락드릴게요」라는 약속과 접수 순번을 받고 기다리는데,
 * 운영자 쪽 화면은 누군가 「새로고침」을 누르기 전까지 그 접수가 들어온 사실조차 모른다.
 * 콘솔을 띄워 놓고 기다리는 것이 이 탭의 쓰임새라는 점에서, 그 기다림은 영원히 헛돈다.
 *
 * 그래서 **보이는 동안에만** 스스로 다시 확인한다. 숨은 탭·끊긴 연결에서는 쉬고, 다시 보이면
 * 곧바로 한 번 확인한다(돌아온 운영자가 30초를 더 기다리지 않게). 운영자가 쓰는 중이면 건너뛴다.
 */
const OPS_POLL_MS = 30_000;

/**
 * 지금 배경 확인을 돌려도 되는가 (DS 24-1).
 * - 숨은 탭: 아무도 보지 않는 화면을 위해 관리 API를 두드릴 이유가 없다(브라우저도 타이머를 늦춘다).
 * - 끊긴 연결: 실패만 쌓인다. 돌아오면 `online` 이 깨운다.
 * - 운영자가 쓰는 중: 그쪽이 끝나면 스스로 다시 읽는다. 겹쳐 읽어 봐야 순서만 흔든다.
 * 순수 함수로 떼어 둔 이유: 「정말 숨은 탭에서 쉬는가」는 소스를 읽어서는 알 수 없다 — 돌려 봐야 안다.
 */
function shouldPoll(visibility: string, online: boolean, busy: boolean): boolean {
  return visibility !== 'hidden' && online !== false && !busy;
}

/**
 * 늘어난 대기 건수를 알리는 말 (DS 24-1). 알릴 것이 없으면 빈 문자열.
 * 첫 확인(prev === null)은 「새로 들어온 것」이 아니다 — 콘솔을 열자마자 알림이 뜨면 안 된다.
 * 줄어든 경우(운영자가 처리했다)도 알리지 않는다.
 */
function newRequestNotice(prev: number | null, next: number): string {
  if (prev === null || next <= prev) return '';
  return `새 상담원 연결 요청 ${next - prev}건 — 「상담원 요청」에서 확인해 주세요.`;
}

/** 사이드바 배지 글자 — 세 자리를 넘으면 메뉴 이름을 밀어내므로 줄인다(뜻은 .ac-srhide 가 전한다). */
function waitingBadge(n: number): string {
  return n > 99 ? '99+' : String(n);
}

/**
 * 모션 최소화 설정을 존중하는 스크롤 동작(DS 8-3).
 * CSS 의 `@media (prefers-reduced-motion: reduce){html{scroll-behavior:auto}}` 는
 * **JS 가 `behavior:'smooth'` 를 직접 넘기면 무시된다** — 설정은 켜 두었는데 화면만 미끄러진다.
 * 전정 장애가 있는 사용자에게는 이 미끄러짐 자체가 증상을 일으킨다.
 */
function scrollBehavior(): ScrollBehavior {
  try {
    if (typeof window !== 'undefined' && window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 'auto';
  } catch { /* matchMedia 미지원 — 기본값으로 둔다 */ }
  return 'smooth';
}

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
  // 보고 있는 화면이 주소에 남지 않았다 — 새로고침하면 어느 탭에 있었든 대시보드로 돌아갔고,
  // 뒤로가기는 이전 탭이 아니라 콘솔 자체를 벗어났다. 화면 링크를 남에게 보낼 수도 없었다.
  // 주소 뒤에 `#settle` 처럼 남겨 세 가지를 한꺼번에 푼다(QUALITY_BAR §1 「새로고침·뒤로가기」).
  // 해시는 서버로 가지 않으므로 서버 렌더는 항상 'dash' 로 시작하고, 마운트 후 주소에 맞춘다.
  const [tab, setTabState] = useState<TabKey>('dash');
  const tabRef = useRef<TabKey>('dash');
  const setTab = useCallback((next: TabKey) => {
    tabRef.current = next;
    setTabState(next);
  }, []);
  // 탭을 바꾸면 화면 전체가 바뀌는데 초점은 사이드바 버튼에 남아 있었다 — 키보드 사용자는
  // 새 화면에 닿으려고 다시 Tab 을 눌러야 했고, 스크린리더는 바뀐 사실조차 알리지 않았다.
  // 본문으로 초점을 옮기면 aria-label(현재 화면 이름)이 읽힌다. 첫 렌더에서는 옮기지 않는다.
  const mainRef = useRef<HTMLElement | null>(null);
  const tabMounted = useRef(false);
  const skipTabFocus = useRef(false);
  useEffect(() => {
    if (!tabMounted.current) { tabMounted.current = true; return; }
    // 깊은 링크(`/admin#settle`)로 막 들어온 경우까지 초점을 가로채지 않는다 — 사용자가 탭을
    // 바꿔서 화면이 바뀐 것이 아니기 때문이다. 뒤로/앞으로는 사용자의 이동이므로 옮긴다.
    if (skipTabFocus.current) { skipTabFocus.current = false; return; }
    mainRef.current?.focus();
  }, [tab]);
  // 주소 → 화면. 첫 렌더(깊은 링크)와 뒤로/앞으로(hashchange) 둘 다 여기로 들어온다.
  useEffect(() => {
    const sync = (initial: boolean) => {
      const next = tabFromHash(window.location.hash);
      if (next === tabRef.current) return;
      if (initial) skipTabFocus.current = true;
      setTab(next);
    };
    sync(true);
    const onHash = () => sync(false);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [setTab]);
  /** 화면 → 주소. 탭 전환은 모두 이 문을 지난다(pushState 는 hashchange 를 일으키지 않는다). */
  const goTab = useCallback((next: TabKey) => {
    setTab(next);
    try {
      if (tabFromHash(window.location.hash) !== next) window.history.pushState(null, '', `#${next}`);
    } catch {
      /* 주소를 바꾸지 못하는 환경에서도 화면 전환 자체는 막지 않는다 */
    }
  }, [setTab]);
  // 화면 → 브라우저 제목. 탭이 주소에 남는 만큼(DS 6-3) 제목도 같이 따라가야 북마크·방문 기록·
  // 탭 목록에서 열 화면이 구분된다. 스크린리더는 창을 옮길 때마다 이 제목을 읽는다.
  useEffect(() => {
    try { document.title = docTitle(tab); } catch { /* 제목을 못 바꿔도 화면은 그대로 쓴다 */ }
  }, [tab]);
  // 설치 코드에 넣을 배포 주소 — 브라우저가 보고 있는 주소를 그대로 쓴다(하드코딩 금지).
  const [origin, setOrigin] = useState('');
  const [copied, setCopied] = useState('');
  useEffect(() => {
    try { setOrigin(window.location.origin); } catch { setOrigin(''); }
  }, []);
  /**
   * 알림(토스트) — 성공과 실패를 **같은 자리에서 다르게** 말한다(DS 29-2).
   * `seq` 는 같은 문장이 연달아 올 때 다시 읽히게 하려고 둔다(aria-live 는 글자가
   * 그대로면 두 번째를 읽지 않는다 — 두 번 실패한 사람에게 한 번만 말하는 셈이었다).
   */
  const [notice, setNotice] = useState<{ msg: string; kind: 'ok' | 'fail'; seq: number } | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const noticeSeq = useRef(0);

  // ---- 관리 토큰(ADMIN_TOKEN 설정 시 x-admin-token 필수) ----
  // 보관처는 탭 단위 저장소다 — 위 `tokenStore()` 주석 참고(DS 14-3).
  const [adminToken, setAdminToken] = useState('');
  const tokenRef = useRef('');
  useEffect(() => {
    const saved = readSavedToken();
    if (saved) {
      setAdminToken(saved);
      tokenRef.current = saved;
    }
  }, []);
  const applyToken = (v: string) => {
    setAdminToken(v);
    tokenRef.current = v;
    writeSavedToken(v);
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
  // 버튼을 비활성으로 만드는 대신(초점이 본문 밖으로 떨어진다) 실행만 막는다 — DS 8-1.
  const { claim, release } = useRunOnce();
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

  // ---- 「큰 글씨」 보기 설정 (DS 25-1) ----
  // 배율은 CSS 한 곳(globals.css 의 body[data-view-scale="big"])에만 있다 — 여기서는 켜짐/꺼짐만 말한다.
  // 서버 렌더에는 넣지 않는다(저장된 설정을 서버는 모른다 — 넣으면 하이드레이션이 어긋난다).
  const [bigText, setBigText] = useState(false);
  useEffect(() => { setBigText(readBigText()); }, []);
  useEffect(() => {
    const body = typeof document === 'undefined' ? null : document.body;
    if (!body) return;
    if (bigText) body.dataset.viewScale = 'big';
    else delete body.dataset.viewScale;
    // 콘솔을 떠나면(랜딩·약관으로 이동) 표시를 거둔다 — 랜딩은 이 설정의 대상이 아니다.
    return () => { delete body.dataset.viewScale; };
  }, [bigText]);
  const toggleBigText = () => {
    const next = !bigText;
    setBigText(next);
    writeBigText(next);
    // 저장·삭제와 같은 자리에서 알린다 — 눌린 버튼만으로는 무엇이 바뀐 줄 모르는 사람이 있다.
    flash(next ? '큰 글씨를 켰습니다. 다음에 열 때도 그대로입니다.' : '큰 글씨를 껐습니다.');
  };

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

  /**
   * ── 표의 정렬·페이지 (DS 31-1·31-2) ──
   * 표마다 따로 기억한다(같은 화면에 표가 둘인 탭이 있다 — 고객사/파트너, 합계/근거).
   * 페이지는 **무엇을 거른 결과의 몇 장인가**이므로 그때의 조건(`sig`)과 함께 들고 있다가
   * 조건이 바뀌면 1장으로 돌아간다 — 3장을 보던 중 검색어를 고치면 그 조건에는 1장뿐이라
   * 빈 표가 뜨고, 운영자는 「검색 결과가 없다」고 읽는다.
   */
  const [tableSort, setTableSort] = useState<Record<string, SortState>>({});
  const [tablePage, setTablePage] = useState<Record<string, { page: number; sig: string }>>({});
  const toggleSort = useCallback((id: string) => (col: string) => {
    setTableSort((m) => {
      const cur = m[id];
      return { ...m, [id]: { col, dir: cur && cur.col === col && cur.dir === 'asc' ? 'desc' : 'asc' } };
    });
    // 순서가 바뀌면 지금 보던 장의 내용도 전부 바뀐다 — 첫 장에서 다시 본다.
    setTablePage((m) => (m[id] ? { ...m, [id]: { ...m[id], page: 1 } } : m));
  }, []);
  /** 거른 행에 정렬·페이지를 입혀 「그릴 한 장」을 만든다. `sig` 는 지금의 필터 조건이다. */
  const tableView = <T,>(id: string, rows: T[], cols: SortCols<T>, sig: string, size = TABLE_PAGE_ROWS) => {
    const sorted = sortRows(rows, tableSort[id], cols);
    const saved = tablePage[id];
    const view = pageSlice(sorted, saved && saved.sig === sig ? saved.page : 1, size);
    return { ...view, onPage: (p: number) => setTablePage((m) => ({ ...m, [id]: { page: p, sig } })) };
  };
  /** 페이지를 나누지 않는 표(행 수가 계약 수로 묶여 있는 표) — 정렬만 입힌다. */
  const sortedRows = <T,>(id: string, rows: T[], cols: SortCols<T>) => sortRows(rows, tableSort[id], cols);

  /**
   * ── 적던 내용의 기준선 (DS 27-2) ──
   * 편집 폼 5곳의 「마지막으로 저장된 모습」이다. 프로그램이 폼을 채울 때(수정 시작·저장 완료·
   * 취소·삭제 뒤 거두기)만 함께 옮긴다 — 아래 `load*Form` 한 문을 지나게 해 두었다.
   * 기준선과 화면이 다르면 그 차이가 곧 「아직 저장하지 않은 내용」이다(`formDirty`).
   * 상태가 아니라 ref 인 이유: 기준선이 바뀌는 순간은 언제나 폼 값도 함께 바뀌므로 다시 그릴 일이
   * 따로 없고, 상태로 두면 같은 렌더에 두 번 그리게 된다.
   */
  const formBase = useRef({
    kb: EMPTY_FORM as KBForm,
    imp: EMPTY_IMPORT as ImportForm,
    rule: EMPTY_CR_FORM as CustomRuleForm,
    account: EMPTY_ACCOUNT_FORM as AccountForm,
    partner: EMPTY_PARTNER_FORM as PartnerForm,
  });

  // ---- KB ----
  const [entries, setEntries] = useState<KBEntryView[]>([]);
  const [form, setForm] = useState<KBForm>(EMPTY_FORM);
  /** 안내 자료 폼을 프로그램이 채운다 — 기준선도 함께 옮긴다(사용자 입력은 `setForm` 그대로). */
  const loadKbForm = useCallback((next: KBForm) => { formBase.current.kb = next; setForm(next); }, []);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [kbQuery, setKbQuery] = useState('');
  const [kbCat, setKbCat] = useState('');
  const [kbErr, setKbErr] = useState<{ question?: string; keywords?: string; answer?: string }>({});
  const [kbBusy, setKbBusy] = useState(false);
  const kbFormRef = useRef<HTMLDivElement | null>(null);

  const loadKB = useCallback(async () => {
    markPhase('kb', 'loading');
    try {
      const res = await afetch('/api/admin/kb', { headers: authHeaders() });
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
  /** 문서 붙여넣기 폼을 프로그램이 채운다(등록 완료 뒤 비우기) — 기준선도 함께 옮긴다. */
  const loadImpForm = useCallback((next: ImportForm) => { formBase.current.imp = next; setImp(next); }, []);
  const [candidates, setCandidates] = useState<KBCandidateView[] | null>(null);
  // 어느 버튼이 도는지 구분해야 「미리보기 하는 중…」·「등록하는 중…」을 제자리에 쓸 수 있다.
  const [impBusy, setImpBusy] = useState<'' | 'preview' | 'commit'>('');
  const [impErr, setImpErr] = useState<{ title?: string; text?: string; maxChars?: string }>({});
  const clearImpErr = (k: keyof typeof impErr) => setImpErr((p) => (p[k] ? { ...p, [k]: undefined } : p));

  const runImport = async (commit: boolean) => {
    if (impBusy) return; // 버튼을 비활성화하지 않으므로(초점 유지) 중복 실행은 여기서 막는다
    // 어느 항목이 왜 틀렸는지 그 칸 아래에서 밝힌다 — 토스트 한 줄은 어느 칸인지 알려주지 못했다.
    const errs: typeof impErr = {};
    if (!imp.title.trim()) errs.title = '문서명을 입력해 주세요. 답변에 출처로 표시됩니다.';
    if (!imp.text.trim()) errs.text = '문서 본문을 붙여넣어 주세요.';
    else if (imp.text.length > MAX_DOC_CHARS) errs.text = `본문이 ${MAX_DOC_CHARS.toLocaleString('ko-KR')}자를 넘습니다. 장을 나눠 올려주세요.`;
    const chunk = Number(imp.maxChars);
    if (imp.maxChars.trim() === '' || !Number.isFinite(chunk) || chunk < MIN_CHUNK_CHARS || chunk > MAX_CHUNK_CHARS) {
      errs.maxChars = `${MIN_CHUNK_CHARS}~${MAX_CHUNK_CHARS} 사이 숫자로 적어주세요.`;
    }
    setImpErr(errs);
    if (Object.keys(errs).length > 0) {
      // 화면 밖에 있는 칸이 틀렸을 수 있으므로 첫 오류 칸으로 초점을 옮긴다(DS 29-1).
      focusErrorField(firstErrorId(errs, IMP_FIELD_ORDER));
      return;
    }
    setImpBusy(commit ? 'commit' : 'preview');
    try {
      const res = await afetch('/api/admin/kb/import', {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({
          title: imp.title.trim(),
          category: imp.category.trim() || '문서',
          maxChars: chunk,
          text: imp.text,
          commit,
        }),
      });
      if (on401(res)) return;
      const data = await res.json();
      if (!data.ok) {
        failed('문서를 처리하지 못했습니다', data.message || data.error);
        return;
      }
      if (commit) {
        setCandidates(null);
        loadImpForm(EMPTY_IMPORT);
        await loadKB();
        flash(`문서 등록 완료: 신규 ${data.created} · 갱신 ${data.updated}${data.errors?.length ? ` · 실패 ${data.errors.length}` : ''}`);
      } else {
        setCandidates(data.candidates as KBCandidateView[]);
        flash(`미리보기 ${data.count}개 — 확인한 뒤 「등록」을 누르세요.`);
      }
    } catch {
      // catch 가 없어 오프라인·서버 끊김에서 예외가 조용히 사라졌다 — 사용자는 등록된 줄 알고 떠났다.
      notify(commit ? '네트워크 오류로 등록하지 못했습니다. 기존 자료는 그대로입니다.' : '네트워크 오류로 미리보기를 만들지 못했습니다.', 'fail');
    } finally {
      setImpBusy('');
    }
  };

  // ---- Rules ----
  const [rules, setRules] = useState<RuleView[]>([]);
  const [customRules, setCustomRules] = useState<CustomRuleView[]>([]);
  const [crForm, setCrForm] = useState<CustomRuleForm>(EMPTY_CR_FORM);
  /** 규칙 빌더를 프로그램이 채운다 — 기준선도 함께 옮긴다(DS 27-2). */
  const loadRuleForm = useCallback((next: CustomRuleForm) => { formBase.current.rule = next; setCrForm(next); }, []);
  const [crEditing, setCrEditing] = useState<string | null>(null);
  const [crErr, setCrErr] = useState<{ label?: string; keywords?: string; reply?: string }>({});
  const [crBusy, setCrBusy] = useState(false);
  const [ruleProbe, setRuleProbe] = useState('');
  const [ruleQuery, setRuleQuery] = useState('');
  const ruleFormRef = useRef<HTMLDivElement | null>(null);
  const loadRules = useCallback(async () => {
    markPhase('rules', 'loading');
    try {
      const res = await afetch('/api/admin/rules', { headers: authHeaders() });
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
  /** 자료에 없어 답하지 못한 질문(DS 32-2). 아직 받지 못했으면 null — 0건과 구분한다. */
  const [unanswered, setUnanswered] = useState<UnansweredView | null>(null);

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
  /** 운영 데이터를 마지막으로 확인한 시각(ms). 0이면 아직 한 번도 받지 못했다. */
  const [escSyncAt, setEscSyncAt] = useState(0);
  /**
   * 뒤늦게 도착한 옛 응답이 새 응답을 덮지 않게 한다 — 자동 확인이 돌기 시작하면 같은 목록을
   * 부르는 요청이 겹칠 수 있고(배경 확인 ↔ 상태 변경 뒤 다시 읽기), 응답 순서는 보낸 순서와
   * 다를 수 있다. 가장 늦게 **시작한** 요청의 결과만 화면에 올린다(DS 20-2 의 `followLatest`).
   */
  const escSeqRef = useRef(0);
  /**
   * 자동 확인은 운영자가 쓰는 중에는 건너뛴다. 값을 ref 로 두는 이유: 상태를 의존성에 넣으면
   * 타이머가 매번 다시 걸려 간격이 어긋난다.
   */
  const escPauseRef = useRef(false);
  escPauseRef.current = ticketBusy;

  const loadEsc = useCallback(async (quiet = false) => {
    // 배경 확인(quiet)은 화면을 「불러오는 중」으로 되돌리지 않는다 — 30초마다 스켈레톤이
    // 끼어들면 읽던 표가 사라진다. 실패해도 마지막으로 받은 값을 그대로 둔다.
    const seq = ++escSeqRef.current;
    if (!quiet) markPhase('esc', 'loading');
    try {
      const res = await afetch('/api/admin/escalations?logs=true', { headers: authHeaders() });
      if (seq !== escSeqRef.current) return;
      if (on401(res)) return;
      const data = await res.json();
      if (seq !== escSeqRef.current) return;
      if (data.ok) {
        setTickets(data.tickets);
        setStats(data.stats);
        setRecentTurns(data.recentTurns || []);
        setUnanswered(data.unanswered || null);
        setEscSyncAt(Date.now());
      }
      if (data.ok || !quiet) markPhase('esc', data.ok ? 'done' : 'error');
    } catch {
      if (seq === escSeqRef.current && !quiet) markPhase('esc', 'error');
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
  /** 파트너·고객사 폼을 프로그램이 채운다 — 기준선도 함께 옮긴다(DS 27-2). */
  const loadPartnerForm = useCallback((next: PartnerForm) => { formBase.current.partner = next; setPForm(next); }, []);
  const loadAccountForm = useCallback((next: AccountForm) => { formBase.current.account = next; setAForm(next); }, []);
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
    if (!claim('partners')) return;
    setPartnerBusy(true);
    setPartnerErr('');
    try {
      const qs = filter ? `?partnerId=${encodeURIComponent(filter)}` : '';
      const res = await afetch(`/api/admin/partners${qs}`, { headers: authHeaders(), cache: 'no-store' });
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
      release('partners');
    }
  }, [claim, release]);

  /** 폼으로 스크롤(좁은 화면에서는 폼이 목록 아래에 있다). */
  const focusPartnerForm = (kind: 'account' | 'partner') => {
    setPartnerFormKind(kind);
    window.setTimeout(() => partnerFormRef.current?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' }), 0);
  };
  // 적던 내용을 말없이 갈아 끼우지 않는다(DS 27-2) — `confirmDiscard` 는 아래에 있다(이벤트에서만 불린다).
  const editPartner = async (p: PartnerView) => {
    if (!(await confirmDiscard(formDirty(pForm, formBase.current.partner), '파트너 등록 폼'))) return;
    loadPartnerForm({ id: p.id, name: p.name, managerName: p.managerName ?? '', feeRatePct: p.feeRateBp === null ? '' : bpToPct(p.feeRateBp), status: p.status, memo: p.memo ?? '' });
    setPErr({});
    focusPartnerForm('partner');
  };
  const editAccount = async (a: AccountView) => {
    if (!(await confirmDiscard(formDirty(aForm, formBase.current.account), '고객사 등록 폼'))) return;
    loadAccountForm({
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
    if (Object.keys(errs).length > 0) {
      focusErrorField(firstErrorId(errs, PARTNER_FIELD_ORDER));
      return;
    }
    setPartnerErr('');
    setPartnerSaving(true);
    try {
      const res = await afetch('/api/admin/partners', {
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
      loadPartnerForm(EMPTY_PARTNER_FORM);
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
    if (Object.keys(errs).length > 0) {
      focusErrorField(firstErrorId(errs, ACCOUNT_FIELD_ORDER));
      return;
    }
    setPartnerErr('');
    setPartnerSaving(true);
    try {
      const res = await afetch('/api/admin/partners', {
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
      loadAccountForm(EMPTY_ACCOUNT_FORM);
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
      const res = await afetch(`/api/admin/partners?partnerId=${encodeURIComponent(p.id)}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (on401(res)) return;
      const data = await res.json();
      if (!data.ok) {
        setPartnerErr(data.message || data.error || '삭제하지 못했습니다.');
        return;
      }
      if (pForm.id === p.id) loadPartnerForm(EMPTY_PARTNER_FORM);
      await loadPartners(partnerFilter);
      flash('파트너를 삭제했습니다.');
    } catch {
      setPartnerErr('연결이 원활하지 않아 삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    }
  };

  // ---- 정산 리포트 ----
  const [settleMonth, setSettleMonth] = useState(() => kstMonthNow());
  const [settlePartner, setSettlePartner] = useState('');
  const [settleReport, setSettleReport] = useState<SettlementReportView | null>(null);
  const [settleErr, setSettleErr] = useState('');
  const [settleBusy, setSettleBusy] = useState(false);
  // 지금 화면이 보고 있는 조건. 주소를 읽을 때 「이미 같은 조건인가」를 판단하는 기준이다.
  const settleCond = useRef({ month: settleMonth, partnerId: settlePartner });
  // 지금 화면이 **결과로 보고 싶어 하는** 조건(위 settleCond 는 주소와 맞추는 쪽이다).
  // 계산이 도는 중에 기준월·파트너를 다시 골라도 여기만 바뀌고, 돌고 있는 조회가 끝나면
  // 이 조건까지 따라간다(followLatest) — 종전에는 두 번째 호출이 조용히 버려졌다(DS 20-2).
  const settleWant = useRef<SettleCond>({ month: settleMonth, partnerId: settlePartner });

  // DS 6-3 은 탭만 주소에 남겼다 — 그래서 「정산 화면 좀 봐주세요」로 보낸 `#settle` 링크는
  // 받는 사람에게 **언제나 이번 달**로 열렸고, 지난달을 보다 F5 를 누르면 조건이 사라졌다(DS 9-3).
  // 주소 → 조건. 깊은 링크(첫 진입)와 뒤로/앞으로(hashchange) 둘 다 여기로 들어온다.
  useEffect(() => {
    const apply = () => {
      const { tab: t, params } = viewFromHash(window.location.hash);
      if (t !== 'settle') return;
      const m = params.get('m') ?? '';
      const pid = (params.get('p') ?? '').slice(0, 64);
      const asked = MONTH_RE.test(m) ? m : settleCond.current.month;
      // 아직 오지 않은 달은 주소로도 열 수 없다 — 서버가 거절하는 조건을 화면이 먼저 지킨다(DS 30-3).
      const thisMonth = kstMonthNow();
      const month = asked > thisMonth ? thisMonth : asked;
      if (month === settleCond.current.month && pid === settleCond.current.partnerId) return;
      settleCond.current = { month, partnerId: pid };
      // 뒤로/앞으로도 「보고 싶어 하는 조건」의 변경이다 — 도는 계산이 이 조건까지 따라오게 한다.
      settleWant.current = { month, partnerId: pid };
      setSettleMonth(month);
      setSettlePartner(pid);
      // 조건이 달라졌으니 이전 달의 표를 그대로 두지 않는다 — 비우면 탭 진입 로더가 새 조건으로 계산한다.
      setSettleReport(null);
      setSettleErr('');
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, []);

  // 조건 → 주소. 정산 탭을 보고 있는 동안에는 조건이 항상 주소에 남는다(메뉴로 들어와도 마찬가지).
  useEffect(() => {
    if (tab !== 'settle') return;
    settleCond.current = { month: settleMonth, partnerId: settlePartner };
    try {
      const qs = new URLSearchParams({ m: settleMonth });
      if (settlePartner) qs.set('p', settlePartner);
      const next = `#settle?${qs.toString()}`;
      // 기준월을 바꾸는 것은 「이동」이 아니다 — 방문 기록을 쌓지 않아 뒤로가기는 이전 탭으로 간다(DS 6-3).
      if (window.location.hash !== next) window.history.replaceState(null, '', next);
    } catch {
      /* 주소를 바꾸지 못하는 환경에서도 정산 계산 자체는 막지 않는다 */
    }
  }, [tab, settleMonth, settlePartner]);

  const loadSettlement = useCallback(async (month: string, partnerId: string) => {
    settleWant.current = { month, partnerId };
    // 이미 도는 계산이 있으면 그 계산이 위 조건을 이어받는다(중복 요청은 그대로 막는다).
    if (!claim('settlement')) return;
    setSettleBusy(true);
    try {
      await followLatest(settleWant, sameSettleCond, async (cond, stillWanted) => {
        setSettleErr('');
        try {
          const qs = new URLSearchParams({ month: cond.month });
          if (cond.partnerId) qs.set('partnerId', cond.partnerId);
          const res = await afetch(`/api/admin/settlement?${qs.toString()}`, { headers: authHeaders(), cache: 'no-store' });
          if (on401(res)) return false;
          const data = await res.json();
          // 그새 조건이 바뀌었다 — 이 결과는 지금 화면의 답이 아니므로 싣지 않는다.
          if (!stillWanted()) return true;
          if (!res.ok || !data.ok) {
            setSettleReport(null);
            setSettleErr(data?.message || data?.error || '정산 리포트를 불러오지 못했습니다.');
            return true;
          }
          setSettleReport(data.report as SettlementReportView);
        } catch {
          if (!stillWanted()) return true;
          setSettleReport(null);
          setSettleErr('네트워크 오류로 정산 리포트를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
        }
        return true;
      });
    } finally {
      setSettleBusy(false);
      release('settlement');
    }
  }, [claim, release]);

  /**
   * 화면에 그릴 리포트 — **고른 조건이 답한 것**일 때만이다.
   * 금액은 운영자가 화면에서 그대로 옮겨 적는 숫자라, 조건과 결과가 어긋나면 그리지 않는다.
   * 위 `followLatest` 가 어긋나는 경로를 막지만, 그리기 직전에 한 번 더 대조한다(KPI·표·CSV 가
   * 같은 값을 본다). 기준월 칸을 비운 동안에는 서버가 이번 달로 채워 돌려주므로 대조 대상이 아니다.
   */
  const settleView = settleReport && (!MONTH_RE.test(settleMonth) || settleReport.month === settleMonth)
    ? settleReport
    : null;

  const downloadSettlementCsv = () => {
    // 잠긴 버튼도 눌러 볼 수 있다(초점을 잃지 않으려고 `disabled` 를 쓰지 않는다) — 이유를 밝힌다.
    if (!settleView || settleView.rows.length === 0) {
      notify('내려받을 산출 근거가 없습니다. 기준월을 바꾸거나 「다시 계산」을 눌러 주세요.', 'fail');
      return;
    }
    const qs = new URLSearchParams({ month: settleMonth, format: 'csv' });
    if (settlePartner) qs.set('partnerId', settlePartner);
    // downloadFile 은 아래에서 선언되지만, 이 함수는 사용자가 누를 때 실행되므로 그때는 이미 초기화돼 있다.
    downloadFile(`/api/admin/settlement?${qs.toString()}`, '정산 리포트', `settlement-${settleMonth}.csv`);
  };

  // ---- Audit ----
  const [auditEvents, setAuditEvents] = useState<AuditView[]>([]);
  const auditSeqRef = useRef(0);
  const loadAudit = useCallback(async (quiet = false) => {
    const seq = ++auditSeqRef.current;
    if (!quiet) markPhase('audit', 'loading');
    try {
      const res = await afetch('/api/admin/audit?limit=100', { headers: authHeaders() });
      if (seq !== auditSeqRef.current) return;
      if (on401(res)) return;
      const data = await res.json();
      if (seq !== auditSeqRef.current) return;
      if (data.ok) setAuditEvents(data.events || []);
      if (data.ok || !quiet) markPhase('audit', data.ok ? 'done' : 'error');
    } catch {
      if (seq === auditSeqRef.current && !quiet) markPhase('audit', 'error');
    }
  }, []);

  // ---- 저장소 상태(/api/health) ----
  const [storage, setStorage] = useState<StorageView | null>(null);
  const [storageErr, setStorageErr] = useState('');
  const [storageBusy, setStorageBusy] = useState(false);
  const loadStorage = useCallback(async () => {
    if (!claim('storage')) return;
    setStorageBusy(true);
    setStorageErr('');
    try {
      const res = await afetch('/api/health', { cache: 'no-store' });
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
      release('storage');
    }
  }, [claim, release]);

  // ---- 테넌트 지식(읽기 전용) ----
  // 편집 화면이 아니다. "지금 배포본이 무엇을 근거로 답하는가"를 확인하는 창구다.
  const [tenantId, setTenantId] = useState('eum');
  const [tenantIdList, setTenantIdList] = useState<string[]>([]);
  const [tenantView, setTenantView] = useState<TenantDetailView | null>(null);
  const [tenantErr, setTenantErr] = useState('');
  const [tenantBusy, setTenantBusy] = useState(false);
  const loadTenant = useCallback(async (id: string) => {
    if (!claim('tenant')) return;
    setTenantBusy(true);
    setTenantErr('');
    try {
      const list = await afetch('/api/admin/tenants', { headers: authHeaders(), cache: 'no-store' });
      if (on401(list)) return;
      const listData = await list.json();
      if (listData.ok) setTenantIdList(listData.ids || []);

      const res = await afetch(`/api/admin/tenants?id=${encodeURIComponent(id)}`, { headers: authHeaders(), cache: 'no-store' });
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
      release('tenant');
    }
  }, [claim, release]);

  /** 토큰 검증(/api/admin/auth) 후 통과 시 데이터 로드. 실패 시 잠금 화면 + 사유 표시. */
  const verifyAuth = useCallback(async () => {
    if (!claim('auth')) return;
    setAuthBusy(true);
    try {
      const res = await afetch('/api/admin/auth', { headers: authHeaders() });
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
      release('auth');
    }
  }, [loadKB, loadRules, loadEsc, loadAudit, loadStorage, claim, release]);

  useEffect(() => {
    verifyAuth();
  }, [verifyAuth]);

  // 파트너 탭은 열었을 때만 불러온다(불필요한 관리 API 호출을 만들지 않는다).
  useEffect(() => {
    if (tab === 'partner' && !partnerLoaded && !partnerBusy) loadPartners(partnerFilter);
    // 정산 탭은 파트너 목록(필터 선택지)이 필요하므로 함께 채운다.
    if (tab === 'settle') {
      if (!partnerLoaded && !partnerBusy) loadPartners('');
      // 그릴 수 있는 리포트가 없으면(없거나·고른 조건과 어긋나면) 지금 조건으로 계산한다.
      if (!settleView && !settleBusy && !settleErr) loadSettlement(settleMonth, settlePartner);
    }
    // 테넌트 지식도 탭을 열었을 때만 불러온다.
    if (tab === 'tenant' && !tenantView && !tenantBusy && !tenantErr) loadTenant(tenantId);
  }, [tab, partnerLoaded, partnerBusy, loadPartners, partnerFilter, settleView, settleBusy, settleErr, loadSettlement, settleMonth, settlePartner, tenantView, tenantBusy, tenantErr, loadTenant, tenantId]);

  /**
   * 알림을 띄우는 **한 문** (DS 29-2).
   * ① 앞의 안내가 걸어 둔 타이머를 반드시 거둔다 — 거두지 않으면 2.5초 안에 두 번째 일이
   *    일어났을 때 **첫 번째의 타이머가 두 번째 안내를 지운다**(종전에는 두 번째가 0.5초만 떴다).
   * ② 실패는 스스로 사라지지 않는다. 운영자는 저장을 누른 뒤 표·다른 탭을 보므로, 2.5초 뒤
   *    사라지는 안내는 **실패한 줄 모르고 다음 일을 하게** 만든다(QUALITY_BAR §1·§3).
   */
  const notify = (msg: string, kind: 'ok' | 'fail') => {
    if (noticeTimer.current !== null) { window.clearTimeout(noticeTimer.current); noticeTimer.current = null; }
    noticeSeq.current += 1;
    setNotice({ msg, kind, seq: noticeSeq.current });
    if (kind === 'ok') noticeTimer.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
  };
  const dismissNotice = () => {
    if (noticeTimer.current !== null) { window.clearTimeout(noticeTimer.current); noticeTimer.current = null; }
    setNotice(null);
  };
  // 화면을 떠날 때 타이머를 남기지 않는다(없어진 화면에 setState 하지 않는다).
  useEffect(() => () => { if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current); }, []);

  const flash = (msg: string) => notify(msg, 'ok');

  // ── 보이는 동안에만 도는 자동 확인 (DS 24-1) ──
  // 로그인 전에는 돌지 않는다(잠금 화면에서 관리 API를 두드리지 않는다).
  useEffect(() => {
    if (!authInfo?.allowed) return;
    const tick = () => {
      if (!shouldPoll(document.visibilityState, navigator.onLine !== false, escPauseRef.current)) return;
      loadEsc(true);
    };
    const timer = window.setInterval(tick, OPS_POLL_MS);
    // 자리를 비웠다 돌아온 운영자가 30초를 더 기다리지 않게, 화면이 다시 보이면 곧바로 한 번.
    const wake = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
    };
  }, [authInfo?.allowed, loadEsc]);

  // ── 새 요청이 들어온 순간 (DS 24-1) ──
  // 대기 건수는 운영자가 아니라 **고객이** 늘린다. 어느 탭에 있든 사이드바 배지로 남기고,
  // 늘어난 순간에는 토스트(`role="status"`)로 한 번 알린다 — 스크린리더도 같은 글을 읽는다.
  // 콘솔을 연 순간 이미 쌓여 있던 건수는 「새로 들어온 것」이 아니므로 알리지 않는다.
  const openCount = stats?.escalation.open ?? 0;
  const openSeenRef = useRef<number | null>(null);
  useEffect(() => {
    if (escSyncAt === 0) return; // 아직 한 번도 받지 못했다
    const msg = newRequestNotice(openSeenRef.current, openCount);
    openSeenRef.current = openCount;
    if (msg) flash(msg);
    // flash 는 렌더마다 새로 만들어지는 함수라 의존성에 넣지 않는다(넣으면 매 렌더 다시 돈다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openCount, escSyncAt]);

  // ── 변경 이력은 탭을 열 때마다 다시 읽는다 (DS 24-2) ──
  // 이 탭에 쌓이는 것은 **이 콘솔이 방금 한 일**이다. 마운트 때 한 번만 읽으면, 자료를 고치고
  // 규칙을 바꾸고 접수 상태를 바꾼 뒤 열어도 그 기록이 하나도 보이지 않는다.
  useEffect(() => {
    if (tab !== 'audit' || !authInfo?.allowed) return;
    loadAudit(true);
  }, [tab, authInfo?.allowed, loadAudit]);

  // 내려받는 중인 항목 이름(빈 문자열이면 진행 중 아님) — 버튼에 진행 표시를 달고 중복 클릭을 막는다.
  const [dlBusy, setDlBusy] = useState('');
  // 백업 복원 진행 중 — 덮어쓰기는 시간이 걸릴 수 있어 멈춘 것처럼 보이지 않게 한다.
  const [restoreBusy, setRestoreBusy] = useState(false);

  // ---- 확인 대화상자 ----
  // 되돌릴 수 없는 동작은 전부 이 함수를 거친다. `await askConfirm(...)` 가 false 면 아무것도 하지 않는다.
  const [confirmReq, setConfirmReq] = useState<ConfirmReq | null>(null);
  const askConfirm = useCallback((opts: Omit<ConfirmReq, 'resolve'>) => new Promise<boolean>((resolve) => {
    setConfirmReq({ ...opts, resolve: (ok) => { setConfirmReq(null); resolve(ok); } });
  }), []);

  /**
   * 적던 내용을 **덮어쓰기 전에** 묻는다 (DS 27-2).
   *
   * 지금까지 확인을 거치는 것은 삭제·초기화뿐이었다. 그런데 20분 걸려 쓴 답변이 사라지는 더 흔한
   * 길은 표에서 **다른 행의 「수정」을 한 번 누르는 것**이었다 — 폼이 그 행의 값으로 통째로 갈리고,
   * 적던 글은 되돌릴 수단도 알림도 없이 사라진다. 적은 것이 없으면 묻지 않는다: 뜻 없는 확인이
   * 잦아지면 정작 삭제 확인(DS 5-4)까지 읽지 않고 누르게 된다.
   * 위에서 선언한 `askConfirm` 을 쓰므로 여기 두지만, 호출하는 `edit*` 는 위쪽에 있다(이벤트에서만 불린다).
   */
  const confirmDiscard = useCallback(async (dirty: boolean, what: string) => {
    if (!dirty) return true;
    return askConfirm({
      title: '적던 내용을 버릴까요?',
      target: what,
      body: '이 폼에 저장하지 않은 내용이 있습니다. 계속하면 적던 내용은 사라집니다 — 먼저 저장하려면 「취소」를 누르세요.',
      confirmLabel: '버리고 계속',
    });
  }, [askConfirm]);

  /**
   * 적던 내용을 들고 **이 문서를 떠나려 할 때** 브라우저가 되묻게 한다 (DS 27-2).
   *
   * 콘솔 안에서 탭을 옮기는 것은 같은 문서라 폼이 그대로 있으므로 묻지 않는다(DS 6-3 이 탭을 주소에
   * 남긴 뒤에도 탭 전환은 `pushState` 다). 걸리는 것은 새로고침·창 닫기·주소 이동·콘솔 밖으로 나가는
   * 뒤로가기 — 모두 적던 내용이 **되돌릴 수 없이** 사라지는 길이다(QUALITY_BAR §2).
   * 적은 것이 없으면 아예 걸지 않는다 — 걸어 두면 아무것도 쓰지 않은 사람에게도 경고가 뜬다.
   */
  const anyFormDirty = formDirty(form, formBase.current.kb)
    || formDirty(imp, formBase.current.imp)
    || formDirty(crForm, formBase.current.rule)
    || formDirty(aForm, formBase.current.account)
    || formDirty(pForm, formBase.current.partner);
  useEffect(() => {
    if (!anyFormDirty) return;
    const onLeave = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // 문구는 브라우저가 자기 것으로 바꿔 보여준다 — 값이 비어 있으면 묻지 않는 브라우저가 있어 채운다.
      e.returnValue = '저장하지 않은 내용이 있습니다.';
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [anyFormDirty]);

  /**
   * 실패한 동작을 조용히 넘기지 않는다(QUALITY_BAR §3).
   * 네트워크 예외·JSON 파싱 실패까지 잡아 사용자가 읽을 수 있는 문구로 알린다.
   * 실패는 성공과 **다른 통로**로 알린다(DS 29-2) — 머물러 있고, 스크린리더가 먼저 끼어들어 읽는다.
   */
  const failed = (what: string, detail?: unknown) => {
    const hint = typeof detail === 'string' && detail.trim() ? detail.trim() : '';
    notify(hint ? `${what}: ${hint}` : `${what}. 잠시 후 다시 시도해 주세요.`, 'fail');
  };

  const submitKB = async () => {
    const errs: { question?: string; keywords?: string; answer?: string } = {};
    if (!form.question.trim()) errs.question = '대표 질문을 입력해 주세요.';
    if (!form.answer.trim()) errs.answer = '답변을 입력해 주세요.';
    // 새 자료는 키워드가 한 개 이상 있어야 서버가 받는다 — 보내 보고 토스트로 거절당하는 대신
    // 그 칸에서 먼저 말한다(DS 29-1). 수정할 때는 서버도 요구하지 않으므로 묻지 않는다.
    if (!editingId && splitKeywords(form.keywords).length === 0) {
      errs.keywords = '고객이 쓸 표현을 한 개 이상 입력해 주세요(쉼표로 구분).';
    }
    setKbErr(errs);
    if (Object.keys(errs).length > 0) {
      focusErrorField(firstErrorId(errs, KB_FIELD_ORDER));
      return;
    }
    if (kbBusy) return;
    setKbBusy(true);
    const body = {
      id: editingId ?? form.id,
      category: form.category,
      question: form.question,
      keywords: form.keywords,
      answer: form.answer,
    };
    // 세션이 만료된 채로 저장하면 401 이 온다 — 다른 쓰기 경로와 같이 잠금 화면으로 넘긴다
    // (종전에는 「저장하지 못했습니다: 관리자 토큰이 필요합니다」 라는 내부 문구만 토스트로 떴다).
    let data: { ok?: boolean; error?: string } | null;
    try {
      const res = await afetch('/api/admin/kb', {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify(body),
      });
      data = on401(res) ? null : await res.json();
    } catch {
      data = { ok: false, error: '연결이 원활하지 않습니다. 잠시 후 다시 시도해 주세요.' };
    } finally {
      setKbBusy(false);
    }
    if (!data) return;
    if (!data.ok) {
      failed('저장하지 못했습니다', data.error);
      return;
    }
    loadKbForm(EMPTY_FORM);
    setEditingId(null);
    setKbErr({});
    await loadKB();
    flash(editingId ? '수정되었습니다.' : '추가되었습니다.');
  };

  const editKB = async (e: KBEntryView) => {
    // 적던 내용을 말없이 갈아 끼우지 않는다 — 표에서 「수정」을 잘못 누르는 것이 가장 흔한 길이다.
    if (!(await confirmDiscard(formDirty(form, formBase.current.kb), '안내 자료 편집 폼'))) return;
    setEditingId(e.id);
    setKbErr({});
    loadKbForm({ id: e.id, category: e.category, question: e.question, keywords: e.keywords.join(', '), answer: e.answer });
    goTab('kb');
    // 좁은 화면에서는 편집 폼이 표 아래에 있으므로 보이는 곳으로 옮긴다.
    window.setTimeout(() => kbFormRef.current?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' }), 0);
  };

  /**
   * 「이 질문으로 자료 만들기」(DS 32-2) — 답하지 못한 질문을 등록 폼의 질문 칸에 그대로 채운다.
   * 목록에서 질문을 베껴 적게 하면 오타가 생기고, 그 오타가 다음 매칭을 또 놓친다.
   * 편집 중이던 자료가 있으면 그것을 말없이 갈아 끼우지 않는다(DS 27-2) — `editKB` 와 같은 관문이다.
   */
  const draftKbFromQuestion = async (question: string) => {
    if (!(await confirmDiscard(formDirty(form, formBase.current.kb), '안내 자료 편집 폼'))) return;
    setEditingId(null);
    setKbErr({});
    loadKbForm({ ...EMPTY_FORM, question });
    goTab('kb');
    window.setTimeout(() => kbFormRef.current?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' }), 0);
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
      const res = await afetch(`/api/admin/kb?id=${encodeURIComponent(id)}`, { method: 'DELETE', headers: authHeaders() });
      if (on401(res)) return;
      const data = await res.json();
      if (data.ok) {
        // 편집 폼이 방금 지운 자료를 가리키고 있으면 거둔다 (DS 27-3).
        // 남겨 두면 「수정 저장」이 **지운 자료를 다시 만들고**(서버는 없는 식별자를 새로 만든다)
        // 화면은 「수정되었습니다」라고 말한다 — 변경 이력에는 「생성」으로 남아 둘이 어긋난다.
        // 규칙 쪽(`removeCustomRule`)은 처음부터 거두고 있었다. 같은 일을 두 탭이 다르게 하고 있었다.
        if (editingId === id) { setEditingId(null); loadKbForm(EMPTY_FORM); setKbErr({}); }
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
      const res = await afetch('/api/admin/kb', {
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
      // 초기화는 모든 자료를 지운다 — 수정 중이던 자료도 사라졌으므로 폼을 거둔다 (DS 27-3).
      // **새 자료를 적던 중**이면 건드리지 않는다: 그 글은 지워진 것과 아무 상관이 없다.
      if (editingId) { setEditingId(null); loadKbForm(EMPTY_FORM); setKbErr({}); }
      await loadKB();
      flash('기본 지식베이스로 초기화했습니다.');
    } catch {
      failed('초기화하지 못했습니다');
    }
  };

  const patchRule = async (intent: string, patch: { enabled?: boolean; reply?: string | null }) => {
    try {
      const res = await afetch('/api/admin/rules', {
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
    if (Object.keys(errs).length) {
      focusErrorField(firstErrorId(errs, CR_FIELD_ORDER));
      return;
    }
    if (!claim('rule')) return;
    const body = {
      ...(crEditing ? { intent: crEditing } : {}),
      label: crForm.label,
      keywords: crForm.keywords,
      reply: crForm.reply,
      escalate: crForm.escalate,
    };
    setCrBusy(true);
    try {
      const res = await afetch('/api/admin/rules', {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify(body),
      });
      if (on401(res)) return;
      const data = await res.json();
      if (!data.ok) {
        failed('저장하지 못했습니다', data.message || data.error);
        return;
      }
      loadRuleForm(EMPTY_CR_FORM);
      setCrEditing(null);
      await loadRules();
      flash(crEditing ? '규칙을 수정했습니다.' : '규칙을 추가했습니다.');
    } catch {
      notify('네트워크 오류로 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.', 'fail');
    } finally {
      setCrBusy(false);
      release('rule');
    }
  };

  // 규칙 켜기/끄기 스위치. DS 5-4 가 삭제·수정만 손봤던 탓에 여기만 예외 처리가 빠져 있었다 —
  // 오프라인·서버 오류에서 예외가 그대로 사라져, 스위치는 되돌아가는데 **왜 안 됐는지 아무 말이 없었다**(§3).
  const toggleCustomRule = async (r: CustomRuleView) => {
    try {
      const res = await afetch('/api/admin/rules', {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({ intent: r.intent, enabled: !r.enabled }),
      });
      if (on401(res)) return;
      const data = await res.json();
      if (data.ok) {
        await loadRules();
        flash(r.enabled ? `「${r.label}」 규칙을 껐습니다.` : `「${r.label}」 규칙을 켰습니다.`);
      } else {
        failed('변경하지 못했습니다', data.message || data.error);
      }
    } catch {
      failed('변경하지 못했습니다', '연결을 확인한 뒤 다시 시도해 주세요.');
    }
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
      const res = await afetch(`/api/admin/rules?intent=${encodeURIComponent(intent)}`, { method: 'DELETE', headers: authHeaders() });
      if (on401(res)) return;
      const data = await res.json();
      if (data.ok) {
        if (crEditing === intent) {
          setCrEditing(null);
          loadRuleForm(EMPTY_CR_FORM);
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

  // ---- 내려받기 ----
  /**
   * 파일 내려받기 공통 경로.
   *
   * 종전에는 `window.open('...?token=…')` 으로 열었다. 두 가지가 잘못이다.
   *  1) **관리 토큰이 주소창·브라우저 방문 기록·서버 접근 로그에 그대로 남는다.** 콘솔을 잠깐 빌려준
   *     사람도 기록에서 토큰을 그대로 읽을 수 있다(QUALITY_BAR §3 — 자격 증명 노출).
   *  2) 실패하면 **빈 탭이나 JSON 오류 본문**이 뜬다. 사용자는 무엇이 잘못됐는지 알 수 없고,
   *     콘솔에는 아무 안내도 남지 않는다(§1 — 오류 시 사용자가 이해할 수 있는 안내).
   *
   * 헤더로 인증해 받은 뒤 Blob 으로 저장한다 — 주소에는 아무것도 싣지 않는다.
   * 서버의 `?token=` 지원은 그대로 둔다(외부 스크립트 호환 — API 계약 무변경).
   */
  const downloadFile = async (url: string, what: string, fallbackName: string) => {
    if (dlBusy) return;
    setDlBusy(what);
    try {
      const res = await afetch(url, { headers: authHeaders(), cache: 'no-store' });
      if (on401(res)) return;
      if (!res.ok) {
        // 오류 본문은 JSON 이 아닐 수도 있다(프록시 HTML 등) — 파싱 실패로 안내까지 잃지 않게 감싼다.
        let detail = '';
        try {
          const d = await res.json();
          detail = typeof d?.message === 'string' ? d.message : typeof d?.error === 'string' ? d.error : '';
        } catch { /* 본문을 읽지 못해도 아래에서 일반 안내를 보여준다 */ }
        failed(`${josa(what, '을', '를')} 내려받지 못했습니다`, detail);
        return;
      }
      const blob = await res.blob();
      // 서버가 지정한 파일명을 그대로 쓴다(없으면 대체 이름).
      const cd = res.headers.get('content-disposition') || '';
      const m = /filename="?([^";]+)"?/.exec(cd);
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = m?.[1] || fallbackName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
      flash(`${josa(what, '을', '를')} 내려받았습니다.`);
    } catch {
      failed(`${josa(what, '을', '를')} 내려받지 못했습니다`, '연결을 확인한 뒤 다시 시도해 주세요.');
    } finally {
      setDlBusy('');
    }
  };

  const downloadLogsCsv = () => downloadFile('/api/admin/logs/export', '대화 기록', 'chat-logs.csv');

  // ---- 관리 콘텐츠 백업·복원(KB·룰 — 개인정보 없음) ----
  const restoreInputRef = useRef<HTMLInputElement | null>(null);

  const downloadBackup = () => downloadFile('/api/admin/backup', '백업', 'chatbot-admin-backup.json');

  /**
   * 백업 복원 — 지금 등록된 안내 자료·규칙을 파일 내용으로 **덮어쓴다**. 되돌릴 수 없다.
   * 종전에는 파일을 고르는 즉시 덮어썼고(§3 「되돌릴 수 없는 동작에 확인 절차 없음」),
   * 네트워크가 끊기면 예외가 조용히 사라져 **복원된 줄 알고 떠나는** 경로가 있었다(§3).
   */
  const restoreBackup = async (file: File) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      failed('복원하지 못했습니다', '선택한 파일이 백업 파일(JSON) 형식이 아닙니다.');
      return;
    }
    const ok = await askConfirm({
      title: '이 파일로 덮어쓸까요?',
      target: file.name,
      body: '지금 등록된 안내 자료와 규칙이 파일의 내용으로 바뀝니다. 되돌릴 수 없으니, 먼저 「백업 내려받기」로 현재 상태를 받아 두세요.',
      confirmLabel: '덮어쓰기',
    });
    if (!ok) return;
    setRestoreBusy(true);
    try {
      const res = await afetch('/api/admin/backup', {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify(parsed),
      });
      if (on401(res)) return;
      const data = await res.json();
      if (!data.ok) {
        failed('복원하지 못했습니다', data.message || data.error);
        return;
      }
      await Promise.all([loadKB(), loadRules()]);
      flash(`복원 완료: 안내 자료 ${data.kb}건 · 규칙 ${data.customRules}건 · 기본 규칙 답변 수정 ${data.overrides}건`);
    } catch {
      failed('복원하지 못했습니다', '연결을 확인한 뒤 다시 시도해 주세요. 기존 자료는 그대로입니다.');
    } finally {
      setRestoreBusy(false);
    }
  };

  const patchTicket = async (id: string, status: TicketView['status']) => {
    // 완료·취소는 서버에서 연락처를 파기한다(방침 4조) — 되돌릴 수 없으므로 먼저 확인을 받는다.
    // 아직 연락처가 없는 접수에는 묻지 않는다(지울 것이 없는데 경고를 띄우면 다음부터 안 읽는다).
    const target = tickets.find((t) => t.id === id);
    if ((status === 'resolved' || status === 'canceled') && target?.contact) {
      const agreed = await askConfirm({
        title: status === 'resolved' ? '완료로 바꾸면 연락처를 파기합니다' : '취소로 바꾸면 연락처를 파기합니다',
        target: `접수 ${shortTicket(id)} · ${maskContact(target.contact)}`,
        body: '상담이 끝난 연락처는 지체 없이 파기한다고 개인정보처리방침에 약속했습니다. 파기한 연락처는 다시 열어도 되살릴 수 없습니다. 이관 사유·요약·대화 기록은 그대로 남습니다.',
        confirmLabel: '파기하고 바꾸기',
      });
      if (!agreed) return;
    }
    if (!claim('ticket')) return;
    setTicketBusy(true);
    try {
      const res = await afetch('/api/admin/escalations', {
        method: 'PATCH',
        headers: authHeaders(true),
        body: JSON.stringify({ id, status }),
      });
      if (on401(res)) return;
      const data = await res.json();
      if (data.ok) {
        await loadEsc();
        // 파기는 조용히 하지 않는다 — 무엇이 사라졌는지 운영자가 알아야 한다.
        const purged = (status === 'resolved' || status === 'canceled') && Boolean(target?.contact);
        flash(`접수 ${shortTicket(id)} → ${TICKET_STATUS_LABELS[status]}${purged ? ' · 연락처 파기' : ''}`);
      } else {
        failed('상태를 바꾸지 못했습니다', data.message || data.error);
      }
    } catch {
      notify('상태를 바꾸지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.', 'fail');
    } finally {
      setTicketBusy(false);
      release('ticket');
    }
  };

  // ---- Test ----
  const [testInput, setTestInput] = useState('');
  const [testLog, setTestLog] = useState<
    {
      q: string;
      reply: string;
      /** 주제 표시명 — 서버가 붙여 준다(`@/lib/intents`). 코드(`kb:환불`)를 화면에 쓰지 않는다. */
      intentLabel: string;
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
  // 미리보기 대화도 말풍선뿐인 스크롤 상자다 — 넘치면 목록 자체가 초점을 받는다(DS 26-2).
  const [previewRef, previewScrolls] = useScrollableY<HTMLDivElement>(testLog.length);

  const runTest = async () => {
    const q = testInput.trim();
    if (!q || testBusy) return;
    setTestInput('');
    setTestBusy(true);
    let data: Record<string, unknown> = {};
    // 답이 실제로 서버에서 왔는가 — 아래 `catch` 가 만들어 넣는 안내 문구와 구분해야 한다.
    let answered = false;
    try {
      // 이 요청만 기한이 길다 — 서버가 LLM 을 부르면 16초까지 쓸 수 있다(그보다 짧게 끊으면 올 답을 끊는다).
      const res = await afetch(
        '/api/chat',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: q }),
        },
        CHAT_TEST_TIMEOUT_MS,
      );
      data = (await res.json()) as Record<string, unknown>;
      answered = true;
    } catch {
      data = { reply: '연결이 원활하지 않습니다. 잠시 후 다시 시도해 주세요.', intentLabel: '연결 오류', source: 'error' };
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
          intentLabel: typeof data.intentLabel === 'string' && data.intentLabel ? data.intentLabel : UNNAMED_TOPIC,
          source: typeof data.source === 'string' ? data.source : '-',
          confidence: typeof data.confidence === 'number' ? data.confidence : undefined,
          citation: cite,
        },
        ...prev,
      ].slice(0, 20),
    );
    // 「응답 테스트」로 주고받은 말도 그대로 대화 기록이 된다(DS 24-2) — 대시보드의 빈 상태가
    // 「응답 테스트에서 대화하면 여기에 쌓입니다」라고 안내하고 버튼까지 두는데, 종전에는 그대로
    // 따라 해도 돌아온 화면이 똑같이 비어 있었다. 시킨 대로 했으면 결과가 보여야 한다.
    // 전환이 일어났다면 접수도 함께 생기므로 상담원 요청·KPI 도 같이 갱신된다.
    if (answered) loadEsc(true);
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
              <p id="ac-login-help" className="ac-rulehint">토큰은 이 탭에만 보관되고 브라우저를 닫으면 지워집니다. 서버에는 확인할 때만 전송됩니다.</p>
            )}
          </div>
          <button type="submit" {...busyBtn(authBusy, authBusy, { ...S.btn, width: '100%', padding: '11px 14px' })}>
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

  /**
   * 전역 검색 색인 — 화면에 이미 불러온 목록만 뒤진다(추가 API 호출 없음). 연락처·세션 원문은 색인하지 않는다.
   *
   * 종류별로 상위 몇 건만 집어 오는데(목록이 화면을 덮지 않게), **찾은 수는 그와 다르다**(DS 31-3) —
   * 그래서 집어 온 건수와 함께 **실제로 몇 건을 찾았는지**를 돌려주고, 넘치는 종류에는
   * 「모두 보기」 한 줄을 붙여 그 탭의 같은 검색어로 데려간다. 보여 준 수를 찾은 수라고 말하면
   * 운영자는 「세 건뿐」이라고 읽고 나머지를 영영 찾지 않는다.
   */
  const searchAll = (term: string, raw: string): SearchResult => {
    const hits: SearchHit[] = [];
    const found: Partial<Record<SearchKind, number>> = {};
    const word = raw.trim();
    /** @param all 「모두 보기」가 데려갈 곳. 없으면(화면 목록처럼 전부 보이는 종류) 붙이지 않는다. */
    const take = (kind: SearchKind, list: SearchHit[], all?: () => void) => {
      found[kind] = list.length;
      hits.push(...list.slice(0, SEARCH_PER_KIND));
      if (all && list.length > SEARCH_PER_KIND) {
        hits.push({
          key: `more:${kind}`,
          kind,
          more: true,
          title: `${kind} ${list.length}건 모두 보기`,
          detail: `상위 ${SEARCH_PER_KIND}건만 여기에 보입니다`,
          run: all,
        });
      }
    };

    take('화면', TAB_GROUPS.flatMap((g) => g.tabs.map(([key, label]) => ({ key, label, group: g.group })))
      .filter(({ key, label, group }) => searchMatch(term, label, TAB_DESC[key], group))
      .map(({ key, label }) => ({
        key: `tab:${key}`,
        kind: '화면' as const,
        title: label,
        detail: TAB_DESC[key],
        run: () => goTab(key),
      })));

    take('상담원 요청', tickets
      .filter((t) => searchMatch(term, t.message, t.reason, shortTicket(t.id), HANDOFF_REASON_LABELS[t.reasonCode ?? ''], TICKET_STATUS_LABELS[t.status]))
      .map((t) => ({
        key: `ticket:${t.id}`,
        kind: '상담원 요청' as const,
        title: `${shortTicket(t.id)} · ${TICKET_STATUS_LABELS[t.status]}`,
        detail: clip(t.message),
        run: (from: HTMLElement | null) => { goTab('esc'); setEscFilter('all'); setEscQuery(''); openTicket(t.id, from); },
      })), () => { goTab('esc'); setEscFilter('all'); setEscQuery(word); });

    take('최근 대화', recentTurns
      .filter((t) => searchMatch(term, t.message, t.reply, shortSession(t.sessionId)))
      .map((t) => ({
        key: `turn:${t.id}`,
        kind: '최근 대화' as const,
        title: clip(t.message, 48),
        detail: `${timeLabel(t.at)} · 대화 ${shortSession(t.sessionId)} · ${t.escalate ? '상담원 제안' : '자동 응대'}`,
        run: (from: HTMLElement | null) => { goTab('dash'); openDrawer(t.sessionId, from); },
      })), () => goTab('dash'));

    take('지식베이스', entries
      .filter((e) => searchMatch(term, e.question, e.answer, e.category, e.keywords.join(' ')))
      .map((e) => ({
        key: `kb:${e.id}`,
        kind: '지식베이스' as const,
        title: clip(e.question, 48),
        detail: `${e.category || '분류 없음'} · ${clip(e.answer, 56)}`,
        run: () => { goTab('kb'); setKbCat(''); setKbQuery(e.question); },
      })), () => { goTab('kb'); setKbCat(''); setKbQuery(word); });

    take('시나리오 룰', [
      ...customRules
        .filter((r) => searchMatch(term, r.label, r.keywords.join(' '), r.reply))
        .map((r) => ({
          key: `rule:${r.intent}`,
          kind: '시나리오 룰' as const,
          title: r.label,
          detail: `내가 만든 규칙 · ${r.keywords.slice(0, 4).join(', ')}`,
          run: () => { goTab('rules'); setRuleQuery(r.label); },
        })),
      ...rules
        .filter((r) => searchMatch(term, r.label, patternExamples(r.pattern).join(' '), r.effectiveReply))
        .map((r) => ({
          key: `builtin:${r.intent}`,
          kind: '시나리오 룰' as const,
          title: r.label,
          detail: `기본 규칙 · ${patternExamples(r.pattern).slice(0, 4).join(', ')}`,
          run: () => { goTab('rules'); setRuleQuery(r.label); },
        })),
    ], () => { goTab('rules'); setRuleQuery(word); });

    take('고객사', accounts
      .filter((a) => searchMatch(term, a.name, a.ownerName, ACCOUNT_STATUS_LABELS[a.status]))
      .map((a) => ({
        key: `account:${a.id}`,
        kind: '고객사' as const,
        title: a.name,
        detail: `${ACCOUNT_STATUS_LABELS[a.status]} · ${a.partnerId ? `${partners.find((p) => p.id === a.partnerId)?.name ?? '이름 없는 파트너'} 귀속` : '직접 계약'}`,
        run: () => { goTab('partner'); setAccountQuery(a.name); },
      })), () => { goTab('partner'); setAccountQuery(word); });

    take('파트너', partners
      .filter((p) => searchMatch(term, p.name, p.managerName))
      .map((p) => ({
        key: `partner:${p.id}`,
        kind: '파트너' as const,
        title: p.name,
        detail: `파트너 · ${p.status === 'active' ? '운영 중' : '일시 중지'}${p.managerName ? ` · 담당 ${p.managerName}` : ''}`,
        run: () => { goTab('partner'); setAccountQuery(''); setPartnerFormKind('partner'); },
      })), () => { goTab('partner'); setAccountQuery(''); setPartnerFormKind('partner'); });

    return { hits, found };
  };

  const currentLabel = TAB_LABEL[tab] ?? '대시보드';

  // 테넌트 FAQ·감사 로그 표는 탭 본문이 IIFE 가 아니라 여기서 한 장을 만든다(그릴 때 쓰는 값은 같다).
  const tenantFaqView = tableView('tenantFaq', tenantView?.faq ?? [], {
    citation: (f: TenantFAQView) => f.citation,
    question: (f: TenantFAQView) => f.question,
    answer: (f: TenantFAQView) => f.answer,
    keywords: (f: TenantFAQView) => f.keywords.length,
  }, tenantId);

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
                  onClick={() => goTab(key)}
                >
                  <NavIcon tab={key} />
                  <span>{label}</span>
                  {/* 대기 중인 상담원 요청은 다른 탭에서 일하는 동안에도 보여야 한다(DS 24-1).
                      숫자 모양은 눈으로, 뜻은 스크린리더로 — 「99+」를 그대로 읽히지 않는다. */}
                  {key === 'esc' && openCount > 0 && (
                    <>
                      <span className="ac-navcount" aria-hidden="true">{waitingBadge(openCount)}</span>
                      <span className="ac-srhide">{`대기 ${openCount}건`}</span>
                    </>
                  )}
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
            {/* 「큰 글씨」(DS 25-1) — 콘솔의 글자는 전부 px 라 브라우저의 기본 글꼴 크기 설정이 닿지 않는다.
                눌린 상태는 aria-pressed 로 읽히고, 「가」 모양은 장식이라 숨긴다. */}
            <button
              type="button"
              className="ac-viewbtn"
              aria-pressed={bigText}
              onClick={toggleBigText}
              title={bigText ? '보통 크기로 돌아갑니다.' : '화면 전체를 조금 크게 봅니다. 다음에 열 때도 그대로입니다.'}
            >
              <span aria-hidden="true" style={{ fontSize: 15, fontWeight: 800, lineHeight: 1 }}>가</span>
              큰 글씨
            </button>
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
            <SyncStatus at={escSyncAt} onRefresh={() => loadEsc()} />
            <button type="button" {...busyBtn(dlBusy === '대화 기록', dlBusy !== '')} onClick={downloadLogsCsv}>
              {dlBusy === '대화 기록' ? '내려받는 중…' : '대화 기록 내려받기'}
            </button>
            <button type="button" {...busyBtn(dlBusy === '백업', dlBusy !== '')} onClick={downloadBackup}>
              {dlBusy === '백업' ? '내려받는 중…' : '백업 내려받기'}
            </button>
            <button
              type="button"
              {...busyBtn(restoreBusy, restoreBusy)}
              onClick={() => { if (!restoreBusy) restoreInputRef.current?.click(); }}
            >
              {restoreBusy ? '복원하는 중…' : '백업 복원'}
            </button>
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
              <LoadState phase="error" busy="" fail="현황을 불러오지 못했습니다" onRetry={() => loadEsc()} />
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
                      <span style={{ width: 150, fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.label || UNNAMED_TOPIC}>
                        {t.label || UNNAMED_TOPIC}
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

          {/*
            ── 보완 목록 ──
            이 제품의 고리는 「자료 등록 → 근거로 답변 → 못 답한 것·나쁜 평가 → 자료 보완」인데
            돌아오는 쪽 절반이 화면에 없었다(DS 32-1·32-2). 숫자는 보여 주면서 **무엇을 고칠지**는
            말하지 않았고, 평가는 받아 두고도 부르는 곳이 없었다. 두 카드가 그 자리를 메운다.
          */}
          {unanswered && unanswered.items.length > 0 && (
            <section style={S.card}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                <h2 style={S.h2}>자료에 없어 답하지 못한 질문</h2>
                <span style={S.tag} role="status">
                  {unanswered.groups > unanswered.items.length
                    ? `${unanswered.groups.toLocaleString('ko-KR')}가지 중 ${unanswered.items.length}가지 · 모두 ${unanswered.turns.toLocaleString('ko-KR')}번`
                    : `${unanswered.groups.toLocaleString('ko-KR')}가지 · 모두 ${unanswered.turns.toLocaleString('ko-KR')}번`}
                </span>
              </div>
              <p style={{ fontSize: 13, color: 'var(--sub)', marginBottom: 12 }}>
                등록된 자료·규칙에서 답을 찾지 못해 기본 안내로 끝난 질문입니다. 자주 온 질문이 위에 있습니다.
              </p>
              <ul className="ac-rows" aria-label="답하지 못한 질문 목록">
                {unanswered.items.map((u) => (
                  <li key={u.key}>
                    <div className="ac-row" data-static="">
                      <span className="ac-row-main">
                        <span className="ac-row-msg" title={u.question}>{clip(u.question, 90)}</span>
                        <span className="ac-row-reply">마지막 {timeLabel(u.lastAt)}</span>
                      </span>
                      <span className="ac-row-side">
                        <span className="ac-pill" style={TONE.warn}>{u.count}번</span>
                        <button
                          type="button"
                          className="ac-viewbtn"
                          onClick={() => draftKbFromQuestion(u.question)}
                        >
                          이 질문으로 자료 만들기
                        </button>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* ── 답변 평가(고객이 누른 👍/👎) ── */}
          {stats && (
            <section style={S.card}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                <h2 style={S.h2}>답변 평가</h2>
                <span style={S.tag}>상담창에서 고객이 누른 평가</span>
              </div>
              {stats.feedback && stats.feedback.total > 0 ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-.02em', fontVariantNumeric: 'tabular-nums' }}>
                      {stats.feedback.helpfulRate === null ? MEASURING : `${stats.feedback.helpfulRate}%`}
                    </span>
                    <span style={{ fontSize: 13, color: 'var(--sub)' }}>도움이 됐다는 응답</span>
                    <span className="ac-pill" style={TONE.ok}>도움됐어요 {stats.feedback.up.toLocaleString('ko-KR')}건</span>
                    <span className="ac-pill" style={TONE.warn}>아쉬워요 {stats.feedback.down.toLocaleString('ko-KR')}건</span>
                  </div>
                  {stats.feedback.topDown.length > 0 && (
                    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
                      <h3 style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 8 }}>보완이 필요한 자료</h3>
                      <ul className="ac-rows" aria-label="아쉬워요가 많은 자료">
                        {stats.feedback.topDown.map((d) => {
                          const pill = <span className="ac-pill" style={TONE.warn}>아쉬워요 {d.down}건</span>;
                          // 근거 없이 답한 답변은 고칠 자료가 없다 — 데려갈 곳이 없으므로 버튼으로 만들지 않는다.
                          if (d.citation === NO_CITATION_LABEL) {
                            return (
                              <li key={d.citation}>
                                <div className="ac-row" data-static="">
                                  <span className="ac-row-main">
                                    <span className="ac-row-msg">{NO_CITATION_LABEL}</span>
                                    <span className="ac-row-reply">등록된 자료 없이 답한 답변입니다. 위의 「답하지 못한 질문」부터 채워 주세요.</span>
                                  </span>
                                  <span className="ac-row-side">{pill}</span>
                                </div>
                              </li>
                            );
                          }
                          return (
                            <li key={d.citation}>
                              <button
                                type="button"
                                className="ac-row"
                                onClick={() => { goTab('kb'); setKbCat(''); setKbQuery(d.citation); }}
                              >
                                <span className="ac-row-main">
                                  <span className="ac-row-msg" title={d.citation}>{clip(d.citation, 90)}</span>
                                  <span className="ac-row-reply">지식베이스에서 이 자료를 찾습니다</span>
                                </span>
                                <span className="ac-row-side">{pill}</span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                </>
              ) : (
                <p style={{ fontSize: 13.5, color: 'var(--mut)' }}>
                  {MEASURING} — 아직 평가가 없습니다. 상담창의 답변 아래 「도움이 됐나요」를 고객이 누르면 여기에 모입니다.
                </p>
              )}
              <p style={{ ...S.tag, marginTop: 12 }}>
                평가에는 대화 내용이 들어 있지 않습니다. 어떤 자료를 근거로 답했는지와 평가값만 기록합니다.
              </p>
            </section>
          )}

          {/* ── 최근 대화 ── */}
          <section style={S.card}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
              <h2 style={S.h2}>최근 대화</h2>
              <span style={S.tag}>최대 30건</span>
            </div>
            {recentTurns.length === 0 && phase.esc !== 'done' ? (
              <LoadState phase={phase.esc} busy="최근 대화를 불러오는 중입니다" fail="최근 대화를 불러오지 못했습니다" onRetry={() => loadEsc()} rows={5} />
            ) : recentTurns.length === 0 ? (
              <div className="ac-empty">
                <EmptyArt kind="chat" />
                <p style={{ fontSize: 14, fontWeight: 700 }}>아직 기록된 대화가 없습니다</p>
                <p style={{ fontSize: 13, color: 'var(--mut)', marginTop: 4 }}>홈페이지의 상담창이나 「응답 테스트」에서 대화하면 여기에 쌓입니다.</p>
                <button type="button" style={{ ...S.btnGhost, marginTop: 12 }} onClick={() => goTab('test')}>응답 테스트 열기</button>
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
                      <span className="ac-pill">{t.intentLabel || UNNAMED_TOPIC}</span>
                      <span className="ac-pill">{SOURCE_VIEW_LABELS[t.source] || t.source}</span>
                      {t.escalate && <span className="ac-pill" style={TONE.warn}>상담원 제안</span>}
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
        const kbView = tableView('kb', shown, {
          cat: (e: KBEntryView) => e.category || '',
          q: (e: KBEntryView) => e.question,
        }, `${kbQuery}|${kbCat}`);
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
                  <ScrollX label="안내 자료 목록">
                    <table className="ac-table">
                      <caption className="ac-srhide">안내 자료 목록</caption>
                      <thead>
                        <tr>
                          <SortTh label="카테고리" col="cat" width={96} sort={tableSort.kb} onSort={toggleSort('kb')} />
                          <SortTh label="질문 · 답변" col="q" sort={tableSort.kb} onSort={toggleSort('kb')} />
                          <th scope="col" style={{ width: 160 }} className="ac-col-wide">키워드</th>
                          <th scope="col" style={{ width: 116 }}><span className="ac-srhide">작업</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {kbView.rows.map((e) => (
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
                  </ScrollX>
                )}
                <Pager info={kbView} label="안내 자료" onPage={kbView.onPage} />
              </section>

          <section style={S.card} aria-labelledby="ac-kb-import">
            <h2 id="ac-kb-import" style={{ ...S.h2, marginBottom: 6 }}>문서로 안내 자료 만들기</h2>
            <p style={{ fontSize: 12.5, color: 'var(--mut)', marginBottom: 10 }}>
              안내문·약관·매뉴얼 텍스트를 붙여넣으면 제목·문단 단위로 잘라 FAQ 후보를 만듭니다. 미리보기로 확인한 뒤 등록하세요.
              등록된 항목은 답변에 <strong>출처(근거)</strong>가 함께 표시됩니다. 키워드는 자동 추출값이므로 등록 후 보정하는 것을 권장합니다.
            </p>
            <div className="ac-grid3">
              <div className="ac-field">
                <label htmlFor="kb-imp-title">문서명 <span aria-hidden="true" style={{ color: 'var(--danger)' }}>*</span> <span style={{ color: 'var(--mut)', fontWeight: 500 }}>(답변에 출처로 표시)</span></label>
                <input
                  id="kb-imp-title"
                  style={{ ...S.input, ...(impErr.title ? { borderColor: 'var(--danger)' } : {}) }}
                  placeholder="예: 2026 이용안내"
                  value={imp.title}
                  maxLength={120}
                  aria-required="true"
                  aria-invalid={impErr.title ? 'true' : undefined}
                  aria-describedby={impErr.title ? 'kb-imp-title-err' : undefined}
                  onChange={(e) => { setImp({ ...imp, title: e.target.value }); clearImpErr('title'); }}
                />
                {impErr.title && <p id="kb-imp-title-err" className="ac-err">{impErr.title}</p>}
              </div>
              <div className="ac-field">
                <label htmlFor="kb-imp-cat">카테고리</label>
                <input id="kb-imp-cat" style={S.input} placeholder="예: 문서" value={imp.category} maxLength={40} onChange={(e) => setImp({ ...imp, category: e.target.value })} />
              </div>
              <div className="ac-field">
                <label htmlFor="kb-imp-chunk">한 항목 길이 <span style={{ color: 'var(--mut)', fontWeight: 500 }}>({MIN_CHUNK_CHARS}~{MAX_CHUNK_CHARS}자)</span></label>
                <input
                  id="kb-imp-chunk"
                  type="number"
                  inputMode="numeric"
                  min={MIN_CHUNK_CHARS}
                  max={MAX_CHUNK_CHARS}
                  style={{ ...S.input, ...(impErr.maxChars ? { borderColor: 'var(--danger)' } : {}) }}
                  value={imp.maxChars}
                  aria-invalid={impErr.maxChars ? 'true' : undefined}
                  aria-describedby={impErr.maxChars ? 'kb-imp-chunk-err' : undefined}
                  onChange={(e) => { setImp({ ...imp, maxChars: e.target.value }); clearImpErr('maxChars'); }}
                />
                {impErr.maxChars && <p id="kb-imp-chunk-err" className="ac-err">{impErr.maxChars}</p>}
              </div>
            </div>
            <div className="ac-field">
              <label htmlFor="kb-imp-text">문서 본문 <span aria-hidden="true" style={{ color: 'var(--danger)' }}>*</span></label>
              <textarea
                id="kb-imp-text"
                style={{ ...S.input, minHeight: 150, fontFamily: 'inherit', ...(impErr.text ? { borderColor: 'var(--danger)' } : {}) }}
                placeholder={'문서 본문을 붙여넣으세요.\n# 제목, ## 소제목, "1. 항목", "제1조" 형식을 구분 기준으로 인식합니다.'}
                value={imp.text}
                aria-required="true"
                aria-invalid={impErr.text ? 'true' : undefined}
                aria-describedby={`kb-imp-count${impErr.text ? ' kb-imp-text-err' : ''}`}
                onChange={(e) => { setImp({ ...imp, text: e.target.value }); clearImpErr('text'); }}
              />
              {impErr.text && <p id="kb-imp-text-err" className="ac-err">{impErr.text}</p>}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button type="button" {...busyBtn(impBusy === 'preview', impBusy !== '')} onClick={() => runImport(false)}>
                {impBusy === 'preview' ? '미리보기 만드는 중…' : '미리보기'}
              </button>
              <button type="button" {...busyBtn(impBusy === 'commit', impBusy !== '' || !candidates, S.btn)} onClick={() => runImport(true)}>
                {impBusy === 'commit' ? '등록하는 중…' : '등록'}
              </button>
              {candidates && (
                <button type="button" style={S.btnGhost} onClick={() => setCandidates(null)}>미리보기 지우기</button>
              )}
              {!candidates && impBusy === '' && (
                <span style={S.tag}>먼저 「미리보기」로 잘린 결과를 확인하세요.</span>
              )}
              {/* 본문 길이는 서버 한계(MAX_DOC_CHARS)와 같은 값으로 미리 알린다 — 보낸 뒤 거절당하지 않게. */}
              <span
                id="kb-imp-count"
                style={{ ...S.tag, marginLeft: 'auto', ...(imp.text.length > MAX_DOC_CHARS ? { color: 'var(--danger)', fontWeight: 700 } : {}) }}
              >
                {imp.text.length.toLocaleString('ko-KR')} / {MAX_DOC_CHARS.toLocaleString('ko-KR')}자
              </span>
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
                  <label htmlFor="kb-keywords">
                    키워드 <span style={{ color: 'var(--mut)', fontWeight: 500 }}>(쉼표로 구분)</span>
                    {!editingId && <span aria-hidden="true" style={{ color: 'var(--danger)' }}> *</span>}
                  </label>
                  <input
                    id="kb-keywords"
                    style={{ ...S.input, ...(kbErr.keywords ? { borderColor: 'var(--danger)' } : {}) }}
                    placeholder="예: 요금, 가격, 얼마"
                    value={form.keywords}
                    aria-required={!editingId ? 'true' : undefined}
                    aria-invalid={kbErr.keywords ? 'true' : undefined}
                    aria-describedby={kbErr.keywords ? 'kb-keywords-err' : undefined}
                    onChange={(e) => { setForm({ ...form, keywords: e.target.value }); if (kbErr.keywords) setKbErr({ ...kbErr, keywords: undefined }); }}
                  />
                  {kbErr.keywords && <p id="kb-keywords-err" className="ac-err">{kbErr.keywords}</p>}
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
                  <button type="button" {...busyBtn(kbBusy, kbBusy, S.btn)} onClick={submitKB}>
                    {kbBusy ? '저장 중…' : editingId ? '수정 저장' : '추가'}
                  </button>
                  {editingId && (
                    <button
                      type="button"
                      style={S.btnGhost}
                      onClick={() => {
                        setEditingId(null);
                        loadKbForm(EMPTY_FORM);
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
        const onEdit = async (r: CustomRuleView) => {
          // 빌더에 적던 규칙을 말없이 갈아 끼우지 않는다(DS 27-2).
          if (!(await confirmDiscard(formDirty(crForm, formBase.current.rule), '시나리오 룰 빌더'))) return;
          setCrEditing(r.intent);
          loadRuleForm({ label: r.label, keywords: r.keywords.join(', '), reply: r.reply, escalate: r.escalate });
          setCrErr({});
          ruleFormRef.current?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
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
                        {r.escalate && <span className="ac-pill" style={TONE.warn}>상담원 연결</span>}
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
                          {r.escalate && <span className="ac-pill" style={TONE.warn}>상담원 연결</span>}
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
                              /* 서버와 같은 상한 — 넘겨 적고 칸을 벗어난 뒤 토스트로 거절당하지 않게
                                 브라우저가 먼저 막는다(DS 29-1). */
                              maxLength={MAX_RULE_REPLY_LEN}
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
                    <div role="group" className="ac-chips" style={{ marginTop: 6 }} aria-label="입력한 표현">
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
              <div role="group" className="ac-rulepreview" aria-labelledby="ac-rule-pv">
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
                <button type="button" {...busyBtn(crBusy, crBusy, S.btn)} onClick={submitCustomRule}>
                  {crBusy ? '저장 중…' : crEditing ? '수정 저장' : '규칙 추가'}
                </button>
                {crEditing && (
                  <button type="button" style={S.btnGhost} onClick={() => { setCrEditing(null); loadRuleForm(EMPTY_CR_FORM); setCrErr({}); }}>
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
        // 상태는 글자 순(대기·상담 중·완료·취소)이 아니라 **처리 순서**로 센다 — 운영자가 상태로
        // 정렬하는 까닭은 「먼저 손대야 하는 것」을 위로 올리기 위해서다.
        const statusRank: Record<TicketView['status'], number> = { open: 0, in_progress: 1, resolved: 2, canceled: 3 };
        const escView = tableView('esc', filtered, {
          id: (t: TicketView) => t.id,
          status: (t: TicketView) => statusRank[t.status],
          msg: (t: TicketView) => t.message || '',
          reason: (t: TicketView) => (t.reasonCode ? HANDOFF_REASON_LABELS[t.reasonCode] ?? t.reasonCode : t.reason),
          at: (t: TicketView) => t.createdAt,
        }, `${escFilter}|${escQuery}`);
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
                <SyncStatus at={escSyncAt} onRefresh={() => loadEsc()} />
              </div>

              {tickets.length === 0 && phase.esc !== 'done' ? (
                <LoadState phase={phase.esc} busy="상담원 요청을 불러오는 중입니다" fail="상담원 요청을 불러오지 못했습니다" onRetry={() => loadEsc()} rows={4} />
              ) : tickets.length === 0 ? (
                <div className="ac-empty">
                  <EmptyArt kind="chat" />
                  <p style={{ fontSize: 14, fontWeight: 700 }}>접수된 상담원 연결 요청이 없습니다</p>
                  <p style={{ fontSize: 13, color: 'var(--mut)', marginTop: 4 }}>고객이 상담창에서 「상담원 연결하기」를 누르거나 챗봇이 답하지 못하면 여기에 쌓입니다.</p>
                  <button type="button" style={{ ...S.btnGhost, marginTop: 12 }} onClick={() => goTab('test')}>응답 테스트에서 시험해 보기</button>
                </div>
              ) : filtered.length === 0 ? (
                <div className="ac-empty">
                  <p style={{ fontSize: 14, fontWeight: 700 }}>조건에 맞는 요청이 없습니다</p>
                  <button type="button" style={{ ...S.btnGhost, marginTop: 12 }} onClick={() => { setEscFilter('all'); setEscQuery(''); }}>필터 지우기</button>
                </div>
              ) : (
                <ScrollX label="상담원 요청 목록">
                  <table className="ac-table">
                    <caption className="ac-srhide">상담원 요청 목록</caption>
                    <thead>
                      <tr>
                        <SortTh label="접수" col="id" sort={tableSort.esc} onSort={toggleSort('esc')} />
                        <SortTh label="상태" col="status" sort={tableSort.esc} onSort={toggleSort('esc')} />
                        <SortTh label="고객이 마지막으로 한 말" col="msg" sort={tableSort.esc} onSort={toggleSort('esc')} />
                        <SortTh label="사유" col="reason" className="ac-col-wide" sort={tableSort.esc} onSort={toggleSort('esc')} />
                        <SortTh label="접수 시각" col="at" className="ac-col-wide" sort={tableSort.esc} onSort={toggleSort('esc')} />
                        <th scope="col"><span className="ac-srhide">처리</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {escView.rows.map((t) => {
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
                              {t.contact
                                ? <span style={{ ...S.tag, display: 'block', marginTop: 2 }}>연락처 남김</span>
                                : t.contactPurgedAt
                                  ? <span style={{ ...S.tag, display: 'block', marginTop: 2, color: 'var(--mut)' }}>연락처 파기됨</span>
                                  : null}
                            </td>
                            <td className="ac-col-wide" style={{ color: 'var(--sub)' }}>{t.reasonCode ? (HANDOFF_REASON_LABELS[t.reasonCode] ?? t.reasonCode) : t.reason}</td>
                            <td className="ac-col-wide" style={{ color: 'var(--sub)', whiteSpace: 'nowrap' }}>{timeLabel(t.createdAt)}</td>
                            <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                              <button
                                type="button"
                                className="ac-linkbtn"
                                {...busyBtn(ticketBusy, ticketBusy, act.primary ? { background: 'var(--brand)', color: '#fff' } : {})}
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
                </ScrollX>
              )}
              <Pager info={escView} label="상담원 요청" onPage={escView.onPage} />
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
        const accountView = tableView('account', filteredAccounts, {
          name: (a: AccountView) => a.name,
          partner: (a: AccountView) => partnerName(a.partnerId),
          status: (a: AccountView) => ACCOUNT_STATUS_LABELS[a.status],
          source: (a: AccountView) => SOURCE_LABELS[a.source] ?? '',
          date: (a: AccountView) => a.contractedAt || '',
          fee: (a: AccountView) => a.monthlyFeeKrw,
        }, `${partnerFilter}|${accountQuery}`);
        // 파트너 표는 페이지를 나누지 않는다 — 행 수가 계약한 파트너 수(수십 곳)로 묶여 있고,
        // 마지막에 세는 단위가 다른 「직접 계약」 합계 행이 붙는다(장을 나누면 그 행이 중간 장에 떨어진다).
        const partnerRows = sortedRows('partner', partners, {
          name: (p: PartnerView) => p.name,
          status: (p: PartnerView) => (p.status === 'active' ? '운영 중' : '중지'),
          fee: (p: PartnerView) => p.feeRateBp,
          manager: (p: PartnerView) => p.managerName || '',
          accounts: (p: PartnerView) => rollupOf(p.id)?.total ?? 0,
        });
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
                    <button type="button" {...busyBtn(partnerBusy, partnerBusy)} onClick={() => loadPartners(partnerFilter)}>
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
                    <ScrollX label="고객사 목록">
                      <table className="ac-table">
                        <caption className="ac-srhide">고객사 목록</caption>
                        <thead>
                          <tr>
                            <SortTh label="고객사" col="name" sort={tableSort.account} onSort={toggleSort('account')} />
                            <SortTh label="귀속" col="partner" sort={tableSort.account} onSort={toggleSort('account')} />
                            <SortTh label="상태" col="status" sort={tableSort.account} onSort={toggleSort('account')} />
                            <SortTh label="유입 경로" col="source" className="ac-col-wide" sort={tableSort.account} onSort={toggleSort('account')} />
                            <SortTh label="계약일" col="date" className="ac-col-wide" sort={tableSort.account} onSort={toggleSort('account')} />
                            <SortTh label="월 이용료" col="fee" className="ac-col-wide" sort={tableSort.account} onSort={toggleSort('account')} />
                            <th scope="col"><span className="ac-srhide">동작</span></th>
                          </tr>
                        </thead>
                        <tbody>
                          {accountView.rows.map((a) => (
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
                    </ScrollX>
                  )}
                  <Pager info={accountView} label="고객사" unit="곳" onPage={accountView.onPage} />
                </section>

                <section style={{ ...S.card, padding: 0 }} aria-labelledby="partner-list-h">
                  <div className="ac-toolbar">
                    <h2 id="partner-list-h" style={{ ...S.h2, marginRight: 4 }}>파트너</h2>
                    <span style={S.tag}>{partners.length}곳 · 고객사 수는 귀속 기준 건수만 셉니다</span>
                    {canWrite && partners.length > 0 && (
                      <button type="button" style={{ ...S.btnGhost, marginLeft: 'auto' }} onClick={async () => {
                        // 「추가」도 폼을 통째로 비운다 — 수정 중이던 내용을 말없이 버리지 않는다(DS 27-2).
                        if (!(await confirmDiscard(formDirty(pForm, formBase.current.partner), '파트너 등록 폼'))) return;
                        loadPartnerForm(EMPTY_PARTNER_FORM); setPErr({}); focusPartnerForm('partner');
                      }}>파트너 추가</button>
                    )}
                  </div>
                  {partners.length === 0 ? (
                    <div className="ac-empty">
                      <p style={{ fontSize: 14, fontWeight: 700 }}>등록된 파트너가 없습니다</p>
                      <p style={{ fontSize: 13, color: 'var(--mut)', marginTop: 4 }}>파트너를 등록하면 고객사를 그 파트너에 귀속시키고 수수료를 집계할 수 있습니다.</p>
                      {canWrite && <button type="button" style={{ ...S.btnGhost, marginTop: 12 }} onClick={() => focusPartnerForm('partner')}>첫 파트너 등록</button>}
                    </div>
                  ) : (
                    <ScrollX label="파트너 목록">
                      <table className="ac-table">
                        <caption className="ac-srhide">파트너 목록</caption>
                        <thead>
                          <tr>
                            <SortTh label="파트너" col="name" sort={tableSort.partner} onSort={toggleSort('partner')} />
                            <SortTh label="상태" col="status" sort={tableSort.partner} onSort={toggleSort('partner')} />
                            <SortTh label="수수료율" col="fee" sort={tableSort.partner} onSort={toggleSort('partner')} />
                            <SortTh label="담당" col="manager" className="ac-col-wide" sort={tableSort.partner} onSort={toggleSort('partner')} />
                            <SortTh label="고객사" col="accounts" sort={tableSort.partner} onSort={toggleSort('partner')} />
                            <th scope="col"><span className="ac-srhide">동작</span></th>
                          </tr>
                        </thead>
                        <tbody>
                          {partnerRows.map((p) => {
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
                              <td><span className="ac-pill" style={TONE.mute}>고원 직접</span></td>
                              <td style={{ color: 'var(--mut)' }}>—</td>
                              <td className="ac-col-wide" style={{ color: 'var(--mut)' }}>—</td>
                              <td style={{ whiteSpace: 'nowrap' }}>{directRollup.total}곳<span style={{ ...S.tag, marginLeft: 4 }}>계약 {directRollup.contracted}</span></td>
                              <td />
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </ScrollX>
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
                          <button type="submit" {...busyBtn(partnerSaving, partnerSaving, S.btn)}>
                            {partnerSaving ? '저장 중…' : aForm.id ? '수정 저장' : '고객사 등록'}
                          </button>
                          {aForm.id && <button type="button" style={S.btnGhost} onClick={() => { loadAccountForm(EMPTY_ACCOUNT_FORM); setAErr({}); }}>취소</button>}
                        </div>
                      </form>
                    ) : (
                      <form onSubmit={(e) => { e.preventDefault(); submitPartner(); }} noValidate>
                        <h2 id="partner-form-h" style={{ ...S.h2, marginBottom: 12 }}>{pForm.id ? '파트너 수정' : '새 파트너'}</h2>
                        <div className="ac-field">
                          <label htmlFor="p-name">파트너명 <span aria-hidden="true" style={{ color: 'var(--danger)' }}>*</span></label>
                          <input id="p-name" style={inputStyle(pErr.name)} value={pForm.name} placeholder="예: 운영 대행사명" aria-required="true"
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
                          <button type="submit" {...busyBtn(partnerSaving, partnerSaving, S.btn)}>
                            {partnerSaving ? '저장 중…' : pForm.id ? '수정 저장' : '파트너 등록'}
                          </button>
                          {pForm.id && <button type="button" style={S.btnGhost} onClick={() => { loadPartnerForm(EMPTY_PARTNER_FORM); setPErr({}); }}>취소</button>}
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
        const r = settleView;
        const won = (v: number) => `${v.toLocaleString('ko-KR')}원`;
        const feeTotal = !r ? MEASURING : r.rows.length === 0 ? '대상 없음' : r.totals.billable === 0 ? '산출 불가' : won(r.totals.feeAmountKrw);
        const feeEmpty = !r || r.rows.length === 0 || r.totals.billable === 0;
        const monthLabel = r ? `${r.month.slice(0, 4)}년 ${Number(r.month.slice(5, 7))}월` : '';
        const ISSUE_TONE = TONE.warn;
        // 합계 표는 파트너 수만큼이라 페이지가 생길 일이 없다 — 정렬만. 근거 표는 고객사 수만큼 길어진다.
        const sumRows = r ? sortedRows('settleSum', r.partnerTotals, {
          name: (t: SettlementPartnerTotalView) => t.partnerName,
          accounts: (t: SettlementPartnerTotalView) => t.accounts,
          billable: (t: SettlementPartnerTotalView) => t.billable,
          incomplete: (t: SettlementPartnerTotalView) => t.incomplete,
          base: (t: SettlementPartnerTotalView) => t.baseAmountKrw,
          fee: (t: SettlementPartnerTotalView) => t.feeAmountKrw,
        }) : [];
        const rowView = tableView('settleRows', r ? r.rows : [], {
          name: (row: SettlementRowView) => row.accountName,
          partner: (row: SettlementRowView) => row.partnerName,
          date: (row: SettlementRowView) => row.contractedAt,
          base: (row: SettlementRowView) => row.baseAmountKrw,
          rate: (row: SettlementRowView) => row.feeRateBp,
          fee: (row: SettlementRowView) => row.feeAmountKrw,
        }, `${settleMonth}|${settlePartner}`);
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
                  // 달 고르개가 아직 오지 않은 달을 내주지 않는다(DS 30-3). 손으로 적어 넣으면
                  // 서버가 사유와 함께 거절하고 그 문장이 그대로 뜬다 — 두 겹으로 막는다.
                  max={kstMonthNow()}
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
                <button type="button" {...busyBtn(settleBusy, settleBusy)} onClick={() => loadSettlement(settleMonth, settlePartner)}>다시 계산</button>
                <button
                  type="button"
                  {...busyBtn(dlBusy === '정산 리포트', dlBusy !== '' || !r || r.rows.length === 0, S.btn)}
                  onClick={downloadSettlementCsv}
                >
                  {dlBusy === '정산 리포트' ? '내려받는 중…' : 'CSV 내려받기'}
                </button>
              </div>
              <p style={{ ...S.tag, padding: '10px 16px' }}>
                월 이용료(계약서 입력값) × 수수료율로 산출 근거를 만듭니다. 값이 없는 항목은 0으로 채우지 않고 합계에서 빼며 사유를 표시합니다. 실제 청구·지급은 계약서가 확정된 뒤에 진행합니다.
              </p>
            </section>

            {settleErr && (
              <div role="alert" style={{ ...S.card, borderColor: 'var(--danger-200)', background: 'var(--danger-50)', padding: '12px 16px', fontSize: 13, color: 'var(--danger)', fontWeight: 600 }}>
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
              <p role="alert" style={{ ...S.card, borderColor: 'var(--warn-200)', background: 'var(--warn-50)', padding: '12px 16px', fontSize: 13, color: 'var(--warn)', fontWeight: 600 }}>
                근거가 부족한 {r.totals.incomplete}건이 합계에서 빠져 있습니다. 이 합계는 확정 금액이 아닙니다. 「파트너·귀속」에서 월 이용료와 수수료율을 채우면 다시 계산됩니다.
              </p>
            )}

            {r && r.rows.length === 0 && !settleErr && (
              <section style={S.card}>
                <div className="ac-empty">
                  <EmptyArt kind="kb" />
                  <p style={{ fontSize: 14, fontWeight: 700 }}>{monthLabel}에 정산 대상 고객사가 없습니다</p>
                  <p style={{ fontSize: 13, color: 'var(--mut)', marginTop: 4 }}>파트너 귀속 고객사를 「계약」 상태로 두고 계약일을 입력하면 그 달부터 여기에 나타납니다.</p>
                  <button type="button" style={{ ...S.btnGhost, marginTop: 12 }} onClick={() => goTab('partner')}>파트너·귀속 열기</button>
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
                  <ScrollX label="파트너별 합계">
                    <table className="ac-table">
                      <caption className="ac-srhide">파트너별 합계</caption>
                      <thead>
                        <tr>
                          <SortTh label="파트너" col="name" sort={tableSort.settleSum} onSort={toggleSort('settleSum')} />
                          <SortTh label="대상" col="accounts" sort={tableSort.settleSum} onSort={toggleSort('settleSum')} />
                          <SortTh label="산출" col="billable" sort={tableSort.settleSum} onSort={toggleSort('settleSum')} />
                          <SortTh label="미산출" col="incomplete" sort={tableSort.settleSum} onSort={toggleSort('settleSum')} />
                          <SortTh label="기준금액" col="base" className="ac-col-wide" sort={tableSort.settleSum} onSort={toggleSort('settleSum')} />
                          <SortTh label="수수료" col="fee" align="right" sort={tableSort.settleSum} onSort={toggleSort('settleSum')} />
                        </tr>
                      </thead>
                      <tbody>
                        {sumRows.map((t) => (
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
                  </ScrollX>
                </section>

                <section style={{ ...S.card, padding: 0 }} aria-labelledby="settle-rows-h">
                  <div className="ac-toolbar">
                    <h2 id="settle-rows-h" style={S.h2}>고객사별 산출 근거</h2>
                    <span style={S.tag}>{r.rows.length}건</span>
                  </div>
                  <ScrollX label="고객사별 산출 근거">
                    <table className="ac-table">
                      <caption className="ac-srhide">고객사별 산출 근거</caption>
                      <thead>
                        <tr>
                          <SortTh label="고객사" col="name" sort={tableSort.settleRows} onSort={toggleSort('settleRows')} />
                          <SortTh label="파트너" col="partner" sort={tableSort.settleRows} onSort={toggleSort('settleRows')} />
                          <SortTh label="계약일" col="date" className="ac-col-wide" sort={tableSort.settleRows} onSort={toggleSort('settleRows')} />
                          <SortTh label="월 이용료" col="base" className="ac-col-wide" sort={tableSort.settleRows} onSort={toggleSort('settleRows')} />
                          <SortTh label="수수료율" col="rate" className="ac-col-wide" sort={tableSort.settleRows} onSort={toggleSort('settleRows')} />
                          <SortTh label="수수료" col="fee" align="right" sort={tableSort.settleRows} onSort={toggleSort('settleRows')} />
                        </tr>
                      </thead>
                      <tbody>
                        {rowView.rows.map((row) => (
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
                  </ScrollX>
                  <Pager info={rowView} label="고객사별 산출 근거" onPage={rowView.onPage} />
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
                <button type="button" {...busyBtn(tenantBusy, tenantBusy)} onClick={() => loadTenant(tenantId)}>
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
                      {tenantView.status.skipped > 0 && <span className="ac-pill" style={{ marginLeft: 6, ...TONE.danger }}>제외 {tenantView.status.skipped}건</span>}
                    </div>
                  </div>
                  <div className="ac-stat">
                    <div className="ac-statlabel">신청 버튼 주소</div>
                    <div className="ac-statvalue">
                      <ExternalLink href={tenantView.status.ctaUrl} label={tenantView.status.ctaUrl} />
                      <span className="ac-pill" style={{ marginLeft: 6, ...(tenantView.status.ctaFromEnv ? TONE.ok : TONE.warn) }}>
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
                <ScrollX label="테넌트 FAQ 목록">
                  <table className="ac-table">
                    <caption className="ac-srhide">테넌트 FAQ 목록</caption>
                    <thead>
                      <tr>
                        <SortTh label="근거" col="citation" sort={tableSort.tenantFaq} onSort={toggleSort('tenantFaq')} />
                        <SortTh label="질문" col="question" sort={tableSort.tenantFaq} onSort={toggleSort('tenantFaq')} />
                        <SortTh label="답변" col="answer" className="ac-col-wide" sort={tableSort.tenantFaq} onSort={toggleSort('tenantFaq')} />
                        <SortTh label="표현" col="keywords" className="ac-col-wide" sort={tableSort.tenantFaq} onSort={toggleSort('tenantFaq')} />
                      </tr>
                    </thead>
                    <tbody>
                      {tenantFaqView.rows.map((f) => (
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
                </ScrollX>
              )}
              <Pager info={tenantFaqView} label="테넌트 FAQ" onPage={tenantFaqView.onPage} />
            </section>
          )}
        </>
      )}

      {tab === 'audit' && (() => {
        // 필터 선택지도 이름으로 보여준다 — 이름은 이벤트가 들고 온 것을 쓴다(사전을 또 두지 않는다).
        const actionNames = new Map<string, string>();
        for (const e of auditEvents) if (!actionNames.has(e.action)) actionNames.set(e.action, e.actionLabel || UNNAMED_AUDIT_ACTION);
        const actions = Array.from(actionNames.keys());
        const shown = auditEvents.filter((e) => auditFilter === 'all' || e.action === auditFilter);
        const auditView = tableView('audit', shown, {
          at: (e: AuditView) => e.at,
          action: (e: AuditView) => e.actionLabel || UNNAMED_AUDIT_ACTION,
          target: (e: AuditView) => e.target || e.detail || '',
          authed: (e: AuditView) => (e.authed ? '로그인됨' : '인증 없이 수행'),
        }, auditFilter);
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
                    <option key={a} value={a}>{actionNames.get(a) || UNNAMED_AUDIT_ACTION}</option>
                  ))}
                </select>
                <span style={S.tag}>{shown.length}/{auditEvents.length}건</span>
                <button type="button" style={S.btnGhost} onClick={() => loadAudit()}>새로고침</button>
                <button
                  type="button"
                  {...busyBtn(dlBusy === '변경 이력', dlBusy !== '')}
                  onClick={() => downloadFile('/api/admin/audit?format=csv', '변경 이력', 'chatbot-audit.csv')}
                >
                  {dlBusy === '변경 이력' ? '내려받는 중…' : 'CSV 내려받기'}
                </button>
              </div>
              {auditEvents.length === 0 && phase.audit !== 'done' ? (
                <LoadState phase={phase.audit} busy="변경 이력을 불러오는 중입니다" fail="변경 이력을 불러오지 못했습니다" onRetry={() => loadAudit()} rows={4} />
              ) : auditEvents.length === 0 ? (
                <div className="ac-empty">
                  <EmptyArt kind="kb" />
                  <p style={{ fontSize: 14, fontWeight: 700 }}>기록된 관리 작업이 없습니다</p>
                  <p style={{ fontSize: 13, color: 'var(--mut)', marginTop: 4 }}>지식베이스나 규칙을 수정하면 누가 언제 무엇을 바꿨는지 이곳에 남습니다.</p>
                  <button type="button" style={{ ...S.btnGhost, marginTop: 12 }} onClick={() => goTab('kb')}>지식베이스 열기</button>
                </div>
              ) : shown.length === 0 ? (
                <div className="ac-empty">
                  <p style={{ fontSize: 14, fontWeight: 700 }}>선택한 종류의 작업이 없습니다</p>
                  <button type="button" style={{ ...S.btnGhost, marginTop: 12 }} onClick={() => setAuditFilter('all')}>필터 지우기</button>
                </div>
              ) : (
                <ScrollX label="관리 작업 기록">
                  <table className="ac-table">
                    <caption className="ac-srhide">관리 작업 기록</caption>
                    <thead>
                      <tr>
                        <SortTh label="시각" col="at" sort={tableSort.audit} onSort={toggleSort('audit')} />
                        <SortTh label="작업" col="action" sort={tableSort.audit} onSort={toggleSort('audit')} />
                        <SortTh label="대상·내용" col="target" sort={tableSort.audit} onSort={toggleSort('audit')} />
                        <SortTh label="인증" col="authed" className="ac-col-wide" sort={tableSort.audit} onSort={toggleSort('audit')} />
                      </tr>
                    </thead>
                    <tbody>
                      {auditView.rows.map((e) => (
                        <tr key={e.id}>
                          <td style={{ whiteSpace: 'nowrap', color: 'var(--sub)' }}>{timeLabel(e.at)}</td>
                          <td style={{ whiteSpace: 'nowrap' }}><span className="ac-pill">{e.actionLabel || UNNAMED_AUDIT_ACTION}</span></td>
                          <td style={{ minWidth: 160 }}>
                            {e.target && <span style={{ fontWeight: 700 }}>{e.target}</span>}
                            {e.detail && <span className="ac-clamp" style={{ color: 'var(--sub)', display: 'block' }}>{e.detail}</span>}
                            {!e.target && !e.detail && <span style={{ color: 'var(--mut)' }}>—</span>}
                          </td>
                          <td className="ac-col-wide">
                            <span className="ac-pill" style={e.authed ? TONE.ok : TONE.warn}>
                              {e.authed ? '로그인됨' : '인증 없이 수행'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ScrollX>
              )}
              <Pager info={auditView} label="관리 작업 기록" onPage={auditView.onPage} />
            </section>

            <section style={S.card} aria-labelledby="storage-h">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <div>
                  <h2 id="storage-h" style={S.h2}>저장소 상태</h2>
                  <p style={{ ...S.tag, marginTop: 2 }}>데이터가 어디에 저장되는지와 최근 저장 결과입니다. 저장이 막혀도 서비스는 계속 동작하며, 사유가 여기에 표시됩니다.</p>
                </div>
                <button type="button" {...busyBtn(storageBusy, storageBusy)} onClick={loadStorage}>
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
                    <span className="ac-pill" style={storage.piiApproved ? TONE.ok : TONE.warn}>
                      개인정보 저장 {storage.piiApproved ? '승인됨' : '미승인'}
                    </span>
                  </div>
                  <ul className="ac-nsgrid">
                    {storage.namespaces.map((n) => {
                      const meta = STORAGE_HEALTH[n.health] ?? STORAGE_HEALTH.empty;
                      const tone = n.health === 'ok' ? TONE.ok
                        : n.health === 'error' || n.health === 'readonly' ? TONE.danger
                        : n.health === 'empty' ? undefined
                        : TONE.warn;
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
                <button type="button" {...busyBtn(testBusy, testBusy, S.btn)} onClick={runTest}>
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
                      <dt>주제</dt><dd>{t.intentLabel || UNNAMED_TOPIC}</dd>
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
              <div ref={previewRef} className="ac-preview-body" role="log" aria-live="polite" aria-label="미리보기 대화" {...scrollFocusProps(previewScrolls)}>
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
                  <div role="status" className="ac-pv-bot" aria-label="답변을 작성하고 있습니다">
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
          {/* 한 줄짜리 스니펫이라 좁은 화면에서는 반드시 넘친다 — 마우스 휠 없이도 끝까지 볼 수 있어야 한다. */}
          <ScrollX label="설치 코드">
            <pre style={{ background: 'var(--ink)', color: 'var(--line)', fontSize: 12.5, borderRadius: 'var(--r-sm)', padding: '14px 16px', margin: 0, width: 'max-content', minWidth: '100%' }}>
              <code>{installSnippet(origin)}</code>
            </pre>
          </ScrollX>
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
            <ExternalLink href="/" label="동작 화면 보기" style={{ ...S.btnGhost, display: 'inline-flex', alignItems: 'center' }} />
          </div>
          {copied && <p role="status" style={{ fontSize: 13, color: 'var(--brand-600)', marginTop: 10 }}>{copied}</p>}

          <h3 style={{ fontSize: 14, fontWeight: 800, margin: '22px 0 8px' }}>선택 옵션</h3>
          {/* 콘솔의 다른 표와 같은 규격(.ac-table)을 쓴다 — 여기만 테두리·여백을 따로 적어 두면
              표 규격을 손볼 때 이 화면만 어긋난다(DS 6-2 「단일 출처」와 같은 종류, DS 9-2). */}
          <ScrollX label="설치 선택 옵션">
            <table className="ac-table">
              <caption className="ac-srhide">설치 선택 옵션</caption>
              <thead>
                <tr>
                  <th scope="col" style={{ width: 150 }}>옵션</th>
                  <th scope="col">설명</th>
                </tr>
              </thead>
              <tbody>
                {INSTALL_OPTIONS.map(([opt, desc]) => (
                  <tr key={opt}>
                    <td><code style={{ whiteSpace: 'nowrap' }}>{opt}</code></td>
                    <td style={{ color: 'var(--sub)' }}>{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollX>
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
            goTab('esc');
          }}
          closeRef={drawerCloseRef}
        />
      )}

      {/* 되돌릴 수 없는 동작 확인 — 삭제·초기화는 전부 이 대화상자를 거친다(DS 5-4). */}
      {confirmReq && <ConfirmDialog req={confirmReq} />}

      {/* 저장·삭제 결과 알림(토스트) — 화면 어디에 있든 같은 자리에서 알린다.
          실패는 성공과 다르게 말한다(DS 29-2): 머물러 있고, 아이콘·색이 다르고,
          스크린리더가 읽던 것을 끊고 먼저 읽는다(`role="alert"`). `key` 는 같은 문장이
          연달아 올 때 다시 읽히게 하는 장치다. */}
      {notice && (
        <div
          key={notice.seq}
          className={notice.kind === 'fail' ? 'ac-toast ac-toast-fail' : 'ac-toast'}
          role={notice.kind === 'fail' ? 'alert' : 'status'}
          aria-live={notice.kind === 'fail' ? 'assertive' : 'polite'}
        >
          {notice.kind === 'fail' && (
            <svg className="ac-toast-icon" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7.5v5.5M12 16.4v.2" strokeLinecap="round" />
            </svg>
          )}
          <span className="ac-toast-msg">{notice.msg}</span>
          {notice.kind === 'fail' && (
            <button type="button" className="ac-toast-x" onClick={dismissNotice} aria-label="알림 닫기">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
