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
  /**
   * 전송이 실패해 만들어진 안내 말풍선. 값은 **다시 보낼 사용자 문장**이다.
   * 정상 답변과 같은 모양으로 그리면 사용자는 챗봇이 그렇게 "답했다"고 읽는다(QUALITY_BAR §3).
   */
  failed?: string;
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

/**
 * 한 번에 보낼 수 있는 글자 수 — 서버(`api/chat` MAX_MESSAGE_LEN)와 같은 값.
 * 보내고 나서 413 으로 거절하면 사용자는 이유도 모르고 쓴 글도 잃는다 → 보내기 전에 알린다.
 */
export const MAX_INPUT_LEN = 2000;
/** 남은 글자 수를 보여주기 시작하는 지점(평소에는 숨겨 입력창을 어지럽히지 않는다). */
const COUNT_FROM = MAX_INPUT_LEN - 200;

// 보조 동작 칩(빠른 답장·접수 진행 이전/건너뛰기/취소·평가) 공통 모양.
const chipStyle: CSSProperties = {
  fontSize: 12, fontWeight: 600, color: 'var(--brand-600)', background: '#fff',
  border: '1px solid var(--line)', borderRadius: 999, padding: '6px 11px', cursor: 'pointer',
  minHeight: 30,
};

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

/**
 * 진행 중인 칩 — 모양만 잠긴 것처럼 보이게 하고 초점은 그대로 둔다(DS 8-2).
 * `disabled` 를 붙이면 키보드로 누른 그 순간 초점이 위젯 밖으로 떨어져,
 * 답이 도착해도 사용자는 화면 맨 위부터 Tab 을 다시 눌러야 한다.
 */
function chip(busy: boolean, extra: CSSProperties = {}): CSSProperties {
  return { ...chipStyle, ...(busy ? { opacity: 0.5, cursor: 'progress' } : {}), ...extra };
}

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

/**
 * 연락처가 왜 통과하지 못했는지 사람 말로 돌려준다(통과하면 빈 문자열).
 * 버튼을 잠가 두기만 하면 **무엇이 틀렸는지** 알 수 없다 — QUALITY_BAR §1
 * 「잘못된 입력에 어느 항목이 왜 틀렸는지 인라인으로 알려준다」.
 */
export function contactError(v: string): string {
  const t = v.trim();
  if (!t) return '연락 받으실 전화번호나 이메일을 입력해 주세요. 남기지 않으시려면 「연락처 없이 접수」를 눌러 주세요.';
  if (validContact(t)) return '';
  if (t.length > 100) return '연락처가 너무 깁니다. 전화번호나 이메일 주소 하나만 남겨 주세요.';
  if (t.includes('@')) return '이메일 주소 형식이 아닙니다. name@example.com 처럼 입력해 주세요.';
  if (/\d/.test(t)) return '전화번호 자릿수가 맞지 않습니다. 010-0000-0000 처럼 입력해 주세요.';
  return '전화번호(010-0000-0000) 또는 이메일(name@example.com) 형식으로 입력해 주세요.';
}

/**
 * 연락처 칸의 자동 채우기 쓰임새(HTML autofill 토큰). 한 칸이 전화번호와 이메일을 함께 받으므로
 * **적힌 내용**을 보고 고른다 — 글자나 `@` 가 있으면 이메일, 아니면 전화번호다.
 * 빈 칸은 `tel` 로 둔다(안내 문구가 전화번호를 앞에 놓는다). 토큰은 어느 상태에서도 비지 않는다.
 */
export function contactPurpose(v: string): 'tel' | 'email' {
  return /[@a-zA-Z]/.test(v) ? 'email' : 'tel';
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

/** 새 대화 세션 식별자 — 서버 세션(`lib/session.ts`) 키가 된다. */
function newSessionId(): string {
  return `web_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * ── 대화 이어가기 ──
 * 임베드 위젯은 호스트 페이지가 이동할 때마다(목록 → 상세 → 장바구니) iframe 이 통째로 다시 로드된다.
 * 저장해 두지 않으면 **한 번 클릭할 때마다 대화가 처음부터**이고, 멀티턴 접수(예약·장애 신고)를
 * 절반 진행한 사람은 서버 세션이 멀쩡히 살아 있는데도 같은 질문을 처음부터 다시 받는다.
 *
 * `localStorage` 가 아니라 **`sessionStorage`** 를 쓴다 — 탭을 닫으면 사라지므로 공용 PC 에
 * 다음 사람이 읽을 대화가 남지 않는다. 저장 범위도 위젯 출처(iframe) 안이라 호스트 페이지는 읽지 못한다.
 */
const THREAD_KEY = 'gowon-chat-thread';
const THREAD_VER = 1;
/**
 * 이 시간이 지난 대화는 복원하지 않는다 — 서버 세션 TTL(`lib/session.ts` TTL_MS)과 **같은 값**.
 * 서버 문맥이 이미 지워졌는데 화면만 이어 보이면 「아까 말한 그거요」가 통하지 않는다.
 */
export const THREAD_TTL_MS = 30 * 60 * 1000;
/** 복원할 최대 말풍선 수 — 저장 용량과 첫 렌더 비용의 상한. */
const THREAD_MAX_MSGS = 40;
/** 저장 상한(직렬화 길이). 넘으면 저장을 건너뛴다 — 저장소를 가득 채워 호스트 페이지를 망가뜨리지 않는다. */
const THREAD_MAX_BYTES = 100_000;

export interface SavedThread { v: number; id: string; at: number; msgs: Msg[] }

/**
 * 저장소 접근 **자체가 예외를 던질 수 있다** — 서드파티 쿠키를 막은 브라우저의 iframe,
 * 사생활 보호 모드가 그렇다. 임베드 위젯에서는 드문 일이 아니므로 없으면 없는 대로 동작한다.
 */
function threadStore(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.sessionStorage || null;
  } catch {
    return null;
  }
}

function threadKey(tenantId: string): string { return `${THREAD_KEY}:${tenantId}`; }

/** 저장된 대화를 읽는다. 없거나·형식이 다르거나·서버 세션이 만료됐으면 `null`(새 대화로 시작). */
export function loadThread(tenantId: string, now: number = Date.now()): SavedThread | null {
  const st = threadStore();
  if (!st) return null;
  try {
    const raw = st.getItem(threadKey(tenantId));
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<SavedThread>;
    if (d?.v !== THREAD_VER || typeof d.id !== 'string' || !d.id || typeof d.at !== 'number') return null;
    if (!Array.isArray(d.msgs) || d.msgs.length === 0) return null;
    // 서버 문맥이 이미 사라진 대화는 이어 보이면 안 된다.
    if (now - d.at > THREAD_TTL_MS) { clearThread(tenantId); return null; }
    const msgs = d.msgs.filter(
      (m): m is Msg => !!m && (m.role === 'bot' || m.role === 'user') && typeof m.text === 'string',
    );
    if (msgs.length === 0) return null;
    return { v: THREAD_VER, id: d.id, at: d.at, msgs };
  } catch {
    // 남의 데이터·깨진 JSON — 새 대화로 시작한다(사용자에게 알릴 실패가 아니다).
    return null;
  }
}

/** 대화를 저장한다. 실패(용량 초과·차단)해도 대화 자체는 계속된다. */
export function saveThread(tenantId: string, id: string, msgs: Msg[], now: number = Date.now()): void {
  const st = threadStore();
  if (!st) return;
  try {
    // 전송 실패 안내는 **그때의 상황**이다 — 다시 열었을 때 남아 있으면 지나간 오류를 현재로 읽는다.
    const keep = msgs.filter((m) => m.failed === undefined).slice(-THREAD_MAX_MSGS);
    // 인사말 하나뿐이면 이어갈 대화가 없다.
    if (keep.length <= 1) { st.removeItem(threadKey(tenantId)); return; }
    const raw = JSON.stringify({ v: THREAD_VER, id, at: now, msgs: keep } satisfies SavedThread);
    if (raw.length > THREAD_MAX_BYTES) return;
    st.setItem(threadKey(tenantId), raw);
  } catch {
    /* 저장 공간 초과·저장소 차단 — 이어가기만 못 할 뿐 대화는 계속된다 */
  }
}

/** 저장된 대화를 지운다(「닫고 처음으로」·만료). */
export function clearThread(tenantId: string): void {
  const st = threadStore();
  if (!st) return;
  try { st.removeItem(threadKey(tenantId)); } catch { /* noop */ }
}

/**
 * 위젯 아이콘 — 16px 뷰박스 선 아이콘(stroke 1.4).
 * 랜딩(`app/page.tsx`)·관리 콘솔과 같은 규약을 쓴다. 이모지를 쓰지 않는다:
 * 이모지는 기기·OS마다 모양이 달라 브랜드가 화면마다 어긋나고, 색을 따라오지 않는다.
 */
const W_ICONS = {
  chat: 'M2.5 3.5h11v7.2H7.6l-3.3 2.7v-2.7H2.5z',
  close: 'M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8',
  minimize: 'M4 8h8',
  send: 'M8 13.2V3.4M8 3.4 4.3 7.1M8 3.4l3.7 3.7',
  clock: 'M8 3.2a4.8 4.8 0 1 0 0 9.6 4.8 4.8 0 0 0 0-9.6M8 5.5v2.8l1.9 1.1',
  check: 'M3.4 8.3l2.9 2.9 6.3-6.6',
  external: 'M5.4 10.6 11 5M6.5 5H11v4.5',
  // 전송 실패 말풍선 — 정상 답변과 한눈에 구분되게 한다.
  alert: 'M8 2.6 1.9 13.2h12.2zM8 6.6v3.2M8 11.6v.4',
  // 다시 보내기 — 원형 화살표.
  retry: 'M13 8a5 5 0 1 1-1.6-3.7M13.2 2.6v2.9h-2.9',
  // 연결 끊김 — 끊어진 신호.
  offline: 'M2 2l12 12M5.6 10.4a3.3 3.3 0 0 1 4.6 0M3.3 7.9a6.6 6.6 0 0 1 2.6-1.6M8 5.2a9.2 9.2 0 0 1 6.5 2.7M8 13.1v.3',
  // 엄지 — 아래 평가는 같은 도형을 180° 돌려 쓴다(모양이 어긋나지 않게).
  thumb: 'M5.5 13.8V7.2l2.9-4.7a1.6 1.6 0 0 1 1.5 1.6v2.2h3a1.2 1.2 0 0 1 1.2 1.5l-.9 4.2a1.3 1.3 0 0 1-1.3 1.1zM5.5 7.4H2.8v6.4h2.7',
} as const;

function WIcon({ name, size = 16, flip = false }: { name: keyof typeof W_ICONS; size?: number; flip?: boolean }) {
  return (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
      <path
        d={W_ICONS[name]}
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        {...(flip ? { transform: 'rotate(180 8 8)' } : {})}
      />
    </svg>
  );
}

export default function ChatWidget({
  embedded = false,
  tenant,
  // 처음에 대화창을 펼친 채로 둘지. 호스트 화면(랜딩)은 `false` 를 넘겨 런처만 보이게 한다 —
  // 모바일에서 열린 위젯은 전체화면이라, 자동으로 열면 호스트 화면을 첫 로드부터 덮어 버린다(DS 5-1).
  defaultOpen = !embedded,
}: { embedded?: boolean; tenant?: WidgetTenant; defaultOpen?: boolean }) {
  const greeting = tenant?.greeting || '안녕하세요! 저는 인공지능(AI) 상담 챗봇입니다. 무엇을 도와드릴까요?';
  const [open, setOpen] = useState(defaultOpen);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [mobile, setMobile] = useState(false);
  // 연결이 끊겼는지 — 서버 렌더에서는 알 수 없으므로 false 로 시작한다(콘솔 DS 4-3 과 같은 방식).
  const [offline, setOffline] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([{ key: nextKey(), role: 'bot', text: greeting, at: 0 }]);
  // 답변 평가 상태 — 메시지 key → 보낸 평가('up'|'down') 또는 'error'(재시도 안내).
  const [rated, setRated] = useState<Record<number, 'up' | 'down' | 'error'>>({});
  // 상담원 전환 — 한 번에 한 건만 진행한다(중복 접수 방지).
  const [handoff, setHandoff] = useState<HandoffState | null>(null);
  const [sessionId, setSessionId] = useState(newSessionId);
  // 저장된 대화를 되살렸는지 — 되살렸다면 왜 지난 말풍선이 있는지 화면에 밝힌다.
  const [resumed, setResumed] = useState(false);
  const lastUserRef = useRef('');
  const endRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  // 접수 연락처 칸 — 형식이 틀리면 이 칸으로 초점을 돌려준다(화면 밖일 수 있다).
  const contactRef = useRef<HTMLInputElement>(null);

  // 대화를 저장·복원할 때 쓰는 열쇠 — 테넌트마다 따로 둔다(다른 안내 챗봇의 대화가 섞이지 않게).
  const threadId = tenant?.id || 'default';

  // 시각 표기는 마운트 이후에만 — 서버 렌더 결과와 어긋나지 않게 한다.
  // 같은 방문에서 이어가던 대화가 있으면 여기서 되살린다(서버 렌더에는 저장소가 없다).
  useEffect(() => {
    setMounted(true);
    const saved = loadThread(threadId);
    if (saved) {
      setSessionId(saved.id);
      // 화면 안 일련번호는 이 렌더에서 다시 매긴다(저장된 번호와 겹치지 않게).
      setMsgs(saved.msgs.map((m) => ({ ...m, key: nextKey() })));
      setResumed(true);
      return;
    }
    setMsgs((m) => m.map((x) => (x.at === 0 ? { ...x, at: Date.now() } : x)));
  }, [threadId]);

  // 대화가 바뀔 때마다 저장한다. 복원 전(서버 렌더 직후)에는 쓰지 않는다 —
  // 인사말만 있는 상태로 덮어써 이어갈 대화를 지워 버리면 안 된다.
  useEffect(() => {
    if (!mounted) return;
    saveThread(threadId, sessionId, msgs);
  }, [mounted, threadId, sessionId, msgs]);

  // 전체화면 전환 판단.
  // - 일반 페이지: 실제 뷰포트 폭으로 판단한다.
  // - 임베드(iframe): iframe 폭은 위젯 크기라 뷰포트가 아니다 → 호스트(embed.js)가 알려준 폭을 쓴다.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (embedded) {
      const onHost = (ev: MessageEvent) => {
        // 이 값 하나가 전체화면 전환을 결정한다 — 화면을 통째로 덮는 상태다.
        // `d.source` 는 보내는 쪽이 스스로 적는 이름이라 누구나 흉내 낼 수 있으므로,
        // **보낸 창이 우리를 띄운 부모인지**를 먼저 본다(위조할 수 없는 검사).
        // 호스트 출처는 고객사마다 달라 위젯이 미리 알 수 없다 — 창 검사가 여기서는 유일한 경계다.
        if (ev.source !== window.parent) return;
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

  // 새 말풍선으로 따라 내려간다. 모션 최소화 설정에서는 미끄러지지 않고 곧장 옮긴다(DS 8-3) —
  // 대화는 말할 때마다 움직이므로 제품에서 가장 잦은 모션이다.
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: scrollBehavior() }); }, [msgs, busy, open]);

  // 연결 상태 — 끊긴 채로 보내면 요청은 무조건 실패한다. 보내기 전에 알린다.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
    const sync = () => setOffline(!navigator.onLine);
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);

  // 열리면 입력창으로 초점을 옮긴다(키보드 사용자가 바로 입력할 수 있게).
  // 단, 처음부터 펼쳐진 채로 그려진 경우는 건너뛴다 — 사용자가 열지 않았는데 초점을 빼앗지 않는다
  // (모바일에서는 화면 키보드가 저절로 올라온다).
  // 처음부터 펼쳐진 채면 true 로 시작해 그 한 번만 건너뛴다. 닫았다 다시 열면 정상적으로 초점이 간다.
  const skipAutoFocus = useRef(defaultOpen);
  useEffect(() => {
    if (!open) return;
    if (skipAutoFocus.current) { skipAutoFocus.current = false; return; }
    const t = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [open]);

  // 호스트 화면의 「상담창 열기」 단추 — `data-gowon-open` 이 붙은 요소를 누르면 위젯이 열린다.
  // 위임 방식이라 호스트(랜딩)는 서버 컴포넌트 그대로 두고 속성만 붙이면 된다. 단추가 `<a href="#demo">`
  // 인 경우 기본 이동은 막지 않는다 — 스크립트가 죽어도 섹션으로는 가야 한다.
  // 이미 열려 있으면 다시 열지 않고 입력창으로 초점만 옮긴다(누른 사람이 기대하는 자리다).
  useEffect(() => {
    if (embedded || typeof document === 'undefined') return;
    const onClick = (ev: MouseEvent) => {
      const el = ev.target instanceof Element ? ev.target.closest('[data-gowon-open]') : null;
      if (!el) return;
      setOpen((o) => {
        if (o) setTimeout(() => inputRef.current?.focus(), 0);
        return true;
      });
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [embedded]);

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

  // 전체화면(모바일)일 때 뒤 페이지가 따라 움직이지 않게 잠근다 — 대화 목록 끝에서 스크롤을 이어가면
  // 뒤 화면이 밀려, 위젯을 닫았을 때 읽던 자리가 아니다. 닫으면 원래 값을 그대로 되돌린다.
  // 임베드 모드는 호스트 문서가 따로 있어 `embed.js` 가 같은 일을 한다.
  useEffect(() => {
    if (embedded || typeof document === 'undefined') return;
    if (!(open && mobile)) return;
    const body = document.body;
    const prev = body.style.overflow;
    body.style.overflow = 'hidden';
    return () => { body.style.overflow = prev; };
  }, [embedded, open, mobile]);

  const closePanel = useCallback((reset: boolean) => {
    setOpen(false);
    if (reset) {
      setMsgs([{ key: nextKey(), role: 'bot', text: greeting, at: Date.now() }]);
      setRated({});
      setHandoff(null);
      setInput('');
      lastUserRef.current = '';
      // 사용자가 명시적으로 지운 대화다 — 저장분도 지우고, 서버 문맥으로도 이어지지 않게 새 세션으로 간다.
      clearThread(threadId);
      setSessionId(newSessionId());
      setResumed(false);
    }
    setTimeout(() => launcherRef.current?.focus(), 0);
  }, [greeting, threadId]);

  // ESC로 닫고, Tab은 위젯 안에서 순환시킨다(뒤 페이지로 초점이 새지 않게).
  function onPanelKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closePanel(false);
      return;
    }
    if (e.key !== 'Tab') return;
    // 초점을 가두는 것은 **모달일 때만**(전체화면 = `aria-modal`).
    // 데스크톱에서는 위젯을 열어 둔 채 페이지를 계속 읽는 것이 정상 사용인데, 여기서 가두면
    // 키보드 사용자는 위젯 밖으로 나가지 못한다. `aria-modal` 을 붙이지 않은 화면에서 초점만 가두면
    // 스크린리더에 알린 것(배경도 쓸 수 있다)과 실제 동작이 어긋난다.
    if (!(open && mobile)) return;
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

  /**
   * 메시지 전송(입력창·빠른 답장 칩·「다시 보내기」 공용).
   * @param retryOf 다시 보내기인 경우 지울 안내 말풍선의 key — 사용자 말풍선은 이미 위에 있으므로 다시 그리지 않는다.
   */
  async function sendText(raw: string, retryOf?: number) {
    const text = raw.trim();
    if (!text || busy) return;
    if (text.length > MAX_INPUT_LEN) return;
    if (retryOf !== undefined) {
      setMsgs((m) => m.filter((x) => x.key !== retryOf));
    } else {
      setInput('');
      setMsgs((m) => [...m, { key: nextKey(), role: 'user', text, at: Date.now() }]);
    }
    lastUserRef.current = text;
    // 연결이 끊긴 상태: 요청을 보내 봐야 실패한다 — 원인을 밝히고 바로 다시 보낼 수단을 준다.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      pushBot({ text: '인터넷 연결이 끊겨 메시지를 보내지 못했습니다. 연결이 돌아오면 다시 보내 주세요.', failed: text });
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, sessionId, ...(tenant ? { tenant: tenant.id } : {}) }),
      });
      const data = await r.json();
      if (!r.ok || data?.ok === false || typeof data?.reply !== 'string') {
        pushBot({ text: errorText(data, r), failed: text });
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
      pushBot({ text: '연결이 원활하지 않아 메시지를 보내지 못했습니다. 잠시 후 다시 보내 주세요.', failed: text });
    } finally {
      setBusy(false);
    }
  }

  const tooLong = input.length > MAX_INPUT_LEN;
  function send() { if (!tooLong) sendText(input); }

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

  // 접수 요청. 연락처는 비워도 접수되지만(`skipContact`), 그때는 대화창으로만 안내가 돌아간다.
  async function submitHandoff(contact: string, skipContact = false) {
    if (!handoff || handoff.stage === 'sending') return;
    const trimmed = contact.trim();
    // 버튼을 잠그는 대신(초점이 떨어진다) 여기서 막고, 무엇이 틀렸는지 칸 아래에 밝힌다.
    if (!skipContact) {
      const why = contactError(trimmed);
      if (why) {
        setHandoff({ ...handoff, contact, stage: 'form', error: why });
        setTimeout(() => contactRef.current?.focus(), 0);
        return;
      }
    }
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
  const title = tenant?.headerTitle || 'GOWON Chat';
  const avatarChar = tenant?.badge || 'G';
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
            <button onClick={() => closePanel(false)} aria-label="대화 최소화 (대화 내용 유지)" title="최소화" style={headerBtn}><WIcon name="minimize" /></button>
            <button onClick={() => closePanel(true)} aria-label="대화 닫고 처음으로" title="닫기" style={headerBtn}><WIcon name="close" /></button>
          </header>

          {/* ── 대화 목록 ── */}
          <div
            role="log"
            aria-live="polite"
            aria-relevant="additions text"
            aria-label="대화 내용"
            // overscrollBehavior: 목록 끝에서 스크롤이 뒤 페이지로 넘어가지 않게 한다.
            style={{ flex: 1, overflowY: 'auto', overscrollBehavior: 'contain', padding: '16px 14px', background: 'var(--bg)', display: 'flex', flexDirection: 'column', gap: 12 }}
          >
            {/* 이어가기 표시 — 지난 말풍선이 왜 남아 있는지 밝힌다(설명 없이 대화가 이어져 있으면 혼란스럽다). */}
            {resumed && (
              <p style={{ textAlign: 'center', fontSize: 10.5, fontWeight: 600, color: 'var(--mut)', margin: 0 }}>
                이전 대화를 이어서 보고 있습니다
              </p>
            )}
            {msgs.map((m) => {
              const mine = m.role === 'user';
              // 전송 실패 안내는 답변이 아니다 — 아바타 없이 경고 톤 카드로 그리고 곧바로 다시 보낼 수 있게 한다.
              if (m.failed !== undefined) {
                const failedText = m.failed;
                return (
                  <div
                    key={m.key}
                    className="gw-rise"
                    role="alert"
                    style={{
                      background: 'var(--danger-50)', border: '1px solid var(--danger)', borderRadius: 12,
                      padding: '11px 13px', display: 'flex', gap: 9, alignItems: 'flex-start',
                    }}
                  >
                    <span style={{ color: 'var(--danger)', display: 'flex', marginTop: 1 }}><WIcon name="alert" size={15} /></span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--ink)' }}>{m.text}</div>
                      <button
                        onClick={() => sendText(failedText, m.key)}
                        aria-disabled={busy || undefined}
                        // 복구 동작이라 보조 칩(30px)보다 큰 손가락 목표를 준다(375px 기준).
                        style={chip(busy, { marginTop: 8, minHeight: 34, padding: '7px 12px', display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--danger)', borderColor: 'var(--danger)' })}
                      >
                        <WIcon name="retry" size={13} /> 다시 보내기
                      </button>
                    </div>
                  </div>
                );
              }
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
                              <button onClick={() => sendText('이전')} aria-disabled={busy || undefined} aria-label="이전 항목으로 돌아가기" style={chip(busy)}>이전</button>
                            )}
                            {m.form.canSkip && (
                              <button onClick={() => sendText('건너뛰기')} aria-disabled={busy || undefined} aria-label="이 항목 건너뛰기" style={chip(busy)}>건너뛰기</button>
                            )}
                            <button onClick={() => sendText('취소')} aria-disabled={busy || undefined} aria-label={`${m.form.title} 중단하기`} style={chip(busy)}>취소</button>
                          </div>
                        )}
                      </div>
                    )}

                    {m.queue && (
                      <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--brand-600)', background: 'var(--brand-50)', borderRadius: 10, padding: '7px 11px', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <WIcon name="clock" size={13} />
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
                        // 위젯은 고객사 사이트 위 iframe 안이라 새 탭이 열려도 창 테두리로는 알 수 없다.
                        // 보는 사람에게는 아래 external 표시가, 듣는 사람에게는 이름 뒤 고지가 알린다(DS 11-3).
                        aria-label={`${m.cta.label} — 새 창에서 열립니다`}
                        style={{ display: 'inline-block', marginTop: 8, fontSize: 12.5, fontWeight: 700, color: '#fff', background: 'var(--brand)', borderRadius: 10, padding: '9px 14px', textDecoration: 'none' }}
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                          {m.cta.label}
                          <WIcon name="external" size={13} />
                        </span>
                      </a>
                    )}

                    {m.suggestions && m.suggestions.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                        {m.suggestions.map((s) => (
                          <button key={s.id} onClick={() => sendText(s.question)} aria-disabled={busy || undefined} style={chip(busy)}>{s.question}</button>
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
                              ref={contactRef}
                              id="gw-handoff-contact"
                              value={handoff.contact}
                              onChange={(e) => setHandoff({ ...handoff, contact: e.target.value, error: '' })}
                              onKeyDown={(e) => {
                                // 형식이 틀려도 Enter 를 삼키지 않는다 — 눌러야 이유를 알려줄 수 있다.
                                if (e.key === 'Enter' && !e.nativeEvent.isComposing) submitHandoff(handoff.contact);
                              }}
                              // 보내는 중에는 `disabled` 가 아니라 `readOnly` — 비활성이 되면 초점이 위젯 밖으로 떨어진다.
                              readOnly={handoff.stage === 'sending'}
                              // 고객 **자신의** 전화번호·이메일을 받는 칸이다 — 쓰임새를 프로그램이 알 수 있어야 하고
                              // (WCAG 1.3.5), 자동 채우기를 막을 이유가 없다. `off` 는 둘 다 어겼다.
                              // 키보드는 `email` 하나로 둔다 — 글자·숫자·`@`·`.` 가 모두 있는 유일한 자판이라
                              // 전화번호와 이메일을 **둘 다** 칠 수 있다(`tel` 로 두면 이메일을 칠 수 없다).
                              inputMode="email"
                              autoComplete={contactPurpose(handoff.contact)}
                              // iOS 는 첫 글자를 대문자로 바꾼다 — `name@…` 이 `Name@…` 이 되어 다시 지우게 된다.
                              autoCapitalize="off"
                              autoCorrect="off"
                              spellCheck={false}
                              aria-invalid={handoff.error ? 'true' : undefined}
                              aria-describedby={handoff.error ? 'gw-handoff-err gw-handoff-hint' : 'gw-handoff-hint'}
                              placeholder="010-0000-0000 또는 name@example.com"
                              style={{
                                width: '100%', border: `1px solid ${handoff.error ? 'var(--danger)' : 'var(--line-2)'}`, borderRadius: 10,
                                padding: '9px 11px', fontSize: 13, color: 'var(--ink)', background: 'var(--bg)', outline: 'none',
                              }}
                            />
                            <p id="gw-handoff-hint" style={{ fontSize: 10.5, lineHeight: 1.5, color: 'var(--mut)', marginTop: 5 }}>
                              회신 목적으로만 사용하고, 상담이 끝나면 파기합니다.
                            </p>
                            {handoff.error && (
                              <p id="gw-handoff-err" role="alert" style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--danger)', marginTop: 6 }}>{handoff.error}</p>
                            )}
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 9 }}>
                              <button
                                onClick={() => submitHandoff(handoff.contact)}
                                aria-busy={handoff.stage === 'sending' || undefined}
                                aria-disabled={handoff.stage === 'sending' || undefined}
                                style={{
                                  fontSize: 12.5, fontWeight: 700, color: '#fff', background: 'var(--brand)',
                                  borderRadius: 10, padding: '9px 14px', minHeight: 36,
                                  opacity: handoff.stage === 'sending' ? 0.5 : 1,
                                }}
                              >
                                {handoff.stage === 'sending' ? '접수 중…' : handoff.stage === 'error' ? '다시 시도' : '접수하기'}
                              </button>
                              <button
                                onClick={() => submitHandoff('', true)}
                                aria-disabled={handoff.stage === 'sending' || undefined}
                                style={chip(handoff.stage === 'sending')}
                              >
                                연락처 없이 접수
                              </button>
                              <button
                                onClick={() => { if (handoff.stage !== 'sending') setHandoff(null); }}
                                aria-disabled={handoff.stage === 'sending' || undefined}
                                style={chip(handoff.stage === 'sending', { color: 'var(--mut)' })}
                              >
                                취소
                              </button>
                            </div>
                          </>
                        )}

                        {handoff.stage === 'done' && handoff.ticket && (
                          <div role="status" aria-live="polite">
                            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--brand-600)', display: 'flex', alignItems: 'center', gap: 5 }}>
                              <WIcon name="check" size={13} />
                              <span>{handoff.ticket.created ? '상담원 연결이 접수됐어요' : '이미 접수된 요청이 있어요'}</span>
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
                            <button onClick={() => rate(m, 'up')} aria-label="이 답변이 도움이 됐어요" style={{ ...chipStyle, padding: '4px 9px', minHeight: 26 }}><WIcon name="thumb" size={14} /></button>
                            <button onClick={() => rate(m, 'down')} aria-label="이 답변이 도움이 되지 않았어요" style={{ ...chipStyle, padding: '4px 9px', minHeight: 26 }}><WIcon name="thumb" size={14} flip /></button>
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
                  <button key={q} onClick={() => sendText(q)} aria-disabled={busy || undefined} style={chip(busy)}>{q}</button>
                ))}
              </div>
            </div>
          )}

          {/* ── 연결 끊김 안내 — 보내기 전에 알린다(보내고 실패하면 쓴 글을 잃는다) ── */}
          {offline && (
            <div
              role="status"
              aria-live="polite"
              style={{
                display: 'flex', gap: 7, alignItems: 'center', background: 'var(--warn-50)',
                borderTop: '1px solid var(--line)', color: 'var(--warn)', padding: '9px 14px',
                fontSize: 11.5, fontWeight: 600, lineHeight: 1.45,
              }}
            >
              <WIcon name="offline" size={14} />
              <span style={{ color: 'var(--ink)', fontWeight: 500 }}>인터넷 연결이 끊겼습니다. 연결이 돌아오면 다시 보내 주세요.</span>
            </div>
          )}

          {/* ── 입력 ── */}
          <div style={{ display: 'flex', gap: 8, padding: '12px 14px 8px', background: 'var(--surface)', borderTop: showStarters || offline ? 'none' : '1px solid var(--line)' }}>
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) send(); }}
              placeholder="메시지를 입력하세요"
              aria-label="메시지 입력"
              aria-invalid={tooLong || undefined}
              aria-describedby={input.length > COUNT_FROM ? 'gw-count' : undefined}
              style={{ flex: 1, minWidth: 0, border: `1px solid ${tooLong ? 'var(--danger)' : 'var(--line-2)'}`, borderRadius: 999, padding: '11px 15px', fontSize: 13.5, color: 'var(--ink)', background: 'var(--bg)', outline: 'none' }}
            />
            <button
              onClick={send}
              aria-busy={busy || undefined}
              aria-disabled={busy || tooLong || !input.trim() || undefined}
              aria-label="메시지 전송"
              style={{ width: 42, height: 42, flexShrink: 0, borderRadius: '50%', background: 'var(--brand)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: busy || tooLong || !input.trim() ? .5 : 1 }}
            >
              <WIcon name="send" size={18} />
            </button>
          </div>
          {/* 글자 수 — 한계에 가까워질 때만 나타난다. 넘으면 이유를 밝히고 전송을 막는다(서버 413 대신). */}
          {input.length > COUNT_FROM && (
            <div
              id="gw-count"
              role={tooLong ? 'alert' : undefined}
              style={{ padding: '0 16px 2px', background: 'var(--surface)', fontSize: 11, fontWeight: 600, textAlign: 'right', color: tooLong ? 'var(--danger)' : 'var(--mut)' }}
            >
              {tooLong
                ? `한 번에 ${MAX_INPUT_LEN}자까지 보낼 수 있습니다 (현재 ${input.length}자)`
                : `${input.length} / ${MAX_INPUT_LEN}자`}
            </div>
          )}
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
            boxShadow: 'var(--shadow-pop)', marginLeft: 'auto', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
          }}
        >
          <WIcon name={open ? 'close' : 'chat'} size={24} />
        </button>
      )}
    </div>
  );
}
