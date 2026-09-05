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
  'kb.import': '문서 업로드 등록',
  'rule.override': '내장 룰 변경',
  'rule.custom.upsert': '커스텀 룰 등록/수정',
  'rule.custom.delete': '커스텀 룰 삭제',
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
  disabled: { label: '영속화 꺼짐', hint: 'ADMIN_PERSIST=false 로 저장이 꺼져 있습니다(메모리만 사용).' },
  awaiting_approval: { label: '승인 대기', hint: '개인정보 포함 데이터입니다. PERSIST_PII 승인 전까지 저장하지 않습니다.' },
  readonly: { label: '읽기전용 환경', hint: '배포 환경의 파일시스템이 읽기전용입니다. 백업 API로 내보내 주세요.' },
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
interface PartnerForm { id: string; name: string; managerName: string; feeRateBp: string; status: 'active' | 'paused'; memo: string }
const EMPTY_PARTNER_FORM: PartnerForm = { id: '', name: '', managerName: '', feeRateBp: '', status: 'active', memo: '' };
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

const S = {
  page: { maxWidth: 960, margin: '0 auto', padding: '32px 20px 80px' } as const,
  card: { background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--r)', padding: 20, marginBottom: 16 } as const,
  input: { width: '100%', border: '1px solid var(--line-2)', borderRadius: 'var(--r-sm)', padding: '8px 10px', fontSize: 14, marginBottom: 8 } as const,
  btn: { background: 'var(--brand)', color: '#fff', borderRadius: 'var(--r-sm)', padding: '8px 14px', fontSize: 14 } as const,
  btnGhost: { background: 'var(--brand-50)', color: 'var(--brand-600)', borderRadius: 'var(--r-sm)', padding: '8px 14px', fontSize: 14 } as const,
  tag: { fontSize: 12, color: 'var(--mut)' } as const,
};

export default function AdminPage() {
  const [tab, setTab] = useState<'dash' | 'kb' | 'rules' | 'esc' | 'partner' | 'settle' | 'test' | 'audit'>('dash');
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

  /** 데이터 API가 401을 돌려주면 잠금 화면으로 전환한다. true = 401 처리됨. */
  const on401 = (res: Response): boolean => {
    if (res.status !== 401) return false;
    setAuthInfo((p) => (p ? { ...p, allowed: false, authed: false } : { authRequired: true, tokenConfigured: true, allowed: false, authed: false }));
    setAuthMsg('인증이 만료되었거나 토큰이 올바르지 않습니다.');
    return true;
  };

  // ---- KB ----
  const [entries, setEntries] = useState<KBEntryView[]>([]);
  const [form, setForm] = useState<KBForm>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);

  const loadKB = useCallback(async () => {
    const res = await fetch('/api/admin/kb', { headers: authHeaders() });
    if (on401(res)) return;
    const data = await res.json();
    if (data.ok) setEntries(data.entries);
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
  const loadRules = useCallback(async () => {
    const res = await fetch('/api/admin/rules', { headers: authHeaders() });
    if (on401(res)) return;
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
    if (on401(res)) return;
    const data = await res.json();
    if (data.ok) {
      setTickets(data.tickets);
      setStats(data.stats);
      setRecentTurns(data.recentTurns || []);
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
  // 파트너 담당자 계정은 읽기 전용이다 — 서버가 403으로 막지만, 화면에서도 쓰기 UI를 감춘다.
  const [canWrite, setCanWrite] = useState(true);

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

  const submitPartner = async () => {
    setPartnerErr('');
    const res = await fetch('/api/admin/partners', {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ kind: 'partner', ...pForm, feeRateBp: pForm.feeRateBp === '' ? null : pForm.feeRateBp }),
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
  };

  const submitAccount = async () => {
    setPartnerErr('');
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
  };

  const removePartner = async (p: PartnerView) => {
    // 되돌릴 수 없는 동작 — 확인 절차를 거친다(연결 고객사가 있으면 서버가 거절한다).
    if (!window.confirm(`파트너 "${p.name}"을(를) 삭제할까요? 되돌릴 수 없습니다.`)) return;
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
    await loadPartners(partnerFilter);
    flash('파트너를 삭제했습니다.');
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
    const res = await fetch('/api/admin/audit?limit=100', { headers: authHeaders() });
    if (on401(res)) return;
    const data = await res.json();
    if (data.ok) setAuditEvents(data.events || []);
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
  }, [tab, partnerLoaded, partnerBusy, loadPartners, partnerFilter, settleReport, settleBusy, settleErr, loadSettlement, settleMonth, settlePartner]);

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
    const cite = data.citation && typeof data.citation.source === 'string' && typeof data.citation.snippet === 'string'
      ? { source: data.citation.source as string, snippet: data.citation.snippet as string }
      : undefined;
    setTestLog((prev) =>
      [
        {
          q,
          reply: data.reply ?? '(오류)',
          intent: data.intent ?? '-',
          source: data.source ?? '-',
          confidence: typeof data.confidence === 'number' ? data.confidence : undefined,
          citation: cite,
        },
        ...prev,
      ].slice(0, 20),
    );
  };

  // ---- 잠금 화면: 인증 게이트에 막힌 경우 콘솔 대신 토큰 입력 화면을 보여준다 ----
  if (authInfo && !authInfo.allowed) {
    return (
      <main style={S.page}>
        <h1 style={{ fontSize: 24, marginBottom: 4 }}>관리 콘솔</h1>
        <section style={{ ...S.card, maxWidth: 420, margin: '48px auto 0' }} aria-label="관리 콘솔 잠금">
          <h2 style={{ fontSize: 17, marginBottom: 6 }}>🔒 잠금 상태</h2>
          <p style={{ fontSize: 14, color: 'var(--sub)', marginBottom: 12 }}>관리 토큰을 입력하면 콘솔이 열립니다.</p>
          <input
            style={S.input}
            type="password"
            placeholder="관리 토큰"
            aria-label="관리 토큰"
            autoFocus
            value={adminToken}
            onChange={(e) => applyToken(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !authBusy) verifyAuth();
            }}
          />
          <button style={{ ...S.btn, width: '100%', opacity: authBusy ? 0.6 : 1 }} onClick={() => verifyAuth()} disabled={authBusy}>
            {authBusy ? '확인 중…' : '확인'}
          </button>
          {authMsg && (
            <p role="alert" style={{ fontSize: 13, color: '#c0392b', marginTop: 10 }}>{authMsg}</p>
          )}
          <p style={{ ...S.tag, marginTop: 12 }}>토큰은 이 브라우저(localStorage)에만 저장되며 서버로는 요청 헤더로만 전송됩니다.</p>
        </section>
      </main>
    );
  }

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
            ['partner', '파트너·귀속'],
            ['settle', '정산 리포트'],
            ['test', '응답 테스트'],
            ['audit', '감사 로그'],
          ] as const
        ).map(([key, label]) => (
          <button key={key} style={tab === key ? S.btn : S.btnGhost} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
        {notice && <span style={{ alignSelf: 'center', fontSize: 13, color: 'var(--brand-600)' }}>{notice}</span>}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {authInfo && (
            <span
              style={{ fontSize: 12, color: authInfo.authed ? 'var(--brand-600)' : 'var(--mut)' }}
              title={authInfo.authed ? '관리 토큰 인증됨' : authInfo.tokenConfigured ? '토큰 미인증' : '토큰 미설정(개방 모드)'}
            >
              {authInfo.authed ? '🔒 인증됨' : authInfo.tokenConfigured ? '미인증' : '개방 모드'}
            </span>
          )}
          <input
            style={{ border: '1px solid var(--line-2)', borderRadius: 'var(--r-sm)', padding: '6px 10px', fontSize: 13, width: 170 }}
            type="password"
            placeholder="관리 토큰(설정 시)"
            aria-label="관리 토큰"
            value={adminToken}
            onChange={(e) => applyToken(e.target.value)}
            onBlur={() => verifyAuth()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !authBusy) verifyAuth();
            }}
          />
        </span>
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
          <section style={S.card}>
            <h2 style={{ fontSize: 16, marginBottom: 6 }}>문서로 FAQ 만들기</h2>
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
                  {e.source && <div style={S.tag}>출처: {e.source}</div>}
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
                {stats.escalation.byReason && (
                  <span style={S.tag}>
                    이관 사유:{' '}
                    {Object.entries(stats.escalation.byReason)
                      .filter(([, n]) => n > 0)
                      .map(([code, n]) => `${HANDOFF_REASON_LABELS[code] ?? code} ${n}`)
                      .join(' · ') || '없음'}
                  </span>
                )}
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
                    {TICKET_STATUS_LABELS[t.status]} · 세션 {t.sessionId} · 사유{' '}
                    {t.reasonCode ? `${HANDOFF_REASON_LABELS[t.reasonCode] ?? t.reasonCode} (${t.reason})` : t.reason}
                  </span>
                  {t.message && <p style={{ fontSize: 14, color: 'var(--sub)', margin: '6px 0' }}>마지막 메시지: {t.message}</p>}
                  {t.summary && (
                    <details style={{ marginTop: 6 }}>
                      <summary style={{ ...S.tag, cursor: 'pointer', fontWeight: 700 }}>이관 요약 보기(개인정보 마스킹 적용)</summary>
                      <pre
                        style={{
                          whiteSpace: 'pre-wrap',
                          fontSize: 12.5,
                          lineHeight: 1.55,
                          background: '#faf7f3',
                          border: '1px solid var(--line)',
                          borderRadius: 'var(--r-sm)',
                          padding: 10,
                          marginTop: 6,
                          fontFamily: 'inherit',
                        }}
                      >
                        {t.summary}
                      </pre>
                    </details>
                  )}
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

      {tab === 'partner' && (
        <>
          <section style={S.card} aria-labelledby="partner-h">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <h2 id="partner-h" style={{ fontSize: 16 }}>파트너·매출 귀속</h2>
              <button style={S.btnGhost} onClick={() => loadPartners(partnerFilter)} disabled={partnerBusy}>
                {partnerBusy ? '불러오는 중…' : '새로고침'}
              </button>
            </div>
            <p style={{ ...S.tag, marginTop: 6 }}>
              계약 주체는 고원이며, 파트너는 유치·운영을 담당합니다. 여기서는 <b>어느 고객사를 누가 데려왔는지</b>만 기록합니다.
              담당자는 이름만 저장하고 연락처는 저장하지 않습니다. 실제 정산·청구는 계약서 확정 후 <b>[승인 필요]</b>.
            </p>
            {partnerErr && (
              <p role="alert" style={{ fontSize: 13, color: '#c0392b', marginTop: 10 }}>{partnerErr}</p>
            )}
          </section>

          <section style={S.card} aria-labelledby="rollup-h">
            <h3 id="rollup-h" style={{ fontSize: 15, marginBottom: 8 }}>귀속 집계</h3>
            {rollup.length === 0 ? (
              <p style={S.tag}>{partnerBusy ? '불러오는 중…' : '집계할 계약이 아직 없습니다.'}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <caption style={{ ...S.tag, textAlign: 'left', marginBottom: 6 }}>
                    건수만 집계합니다(금액·성과 수치는 실적 연동 후 표시).
                  </caption>
                  <thead>
                    <tr style={{ textAlign: 'left', color: 'var(--mut)' }}>
                      <th scope="col" style={{ padding: '6px 8px' }}>귀속</th>
                      <th scope="col" style={{ padding: '6px 8px' }}>수수료율</th>
                      <th scope="col" style={{ padding: '6px 8px' }}>전체</th>
                      <th scope="col" style={{ padding: '6px 8px' }}>계약</th>
                      <th scope="col" style={{ padding: '6px 8px' }}>검토 중</th>
                      <th scope="col" style={{ padding: '6px 8px' }}>해지</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rollup.map((r) => (
                      <tr key={r.partnerId ?? 'direct'} style={{ borderTop: '1px solid var(--line)' }}>
                        <th scope="row" style={{ padding: '6px 8px', fontWeight: 600, textAlign: 'left' }}>{r.partnerName}</th>
                        <td style={{ padding: '6px 8px' }}>{r.partnerId ? feeLabel(r.feeRateBp) : '—'}</td>
                        <td style={{ padding: '6px 8px' }}>{r.total}</td>
                        <td style={{ padding: '6px 8px' }}>{r.contracted}</td>
                        <td style={{ padding: '6px 8px' }}>{r.prospect}</td>
                        <td style={{ padding: '6px 8px' }}>{r.churned}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {!canWrite && (
            <section style={S.card} role="note">
              <p style={{ fontSize: 13 }}>
                <b>조회 전용 계정</b>입니다. 파트너 담당자 계정은 자기 파트너에 귀속된 고객사만 볼 수 있고,
                등록·수정은 할 수 없습니다. 변경이 필요하면 고원 관리자에게 요청해 주세요.
              </p>
            </section>
          )}
          {canWrite && (
          <section style={S.card} aria-labelledby="partner-form-h">
            <h3 id="partner-form-h" style={{ fontSize: 15, marginBottom: 8 }}>{pForm.id ? '파트너 수정' : '파트너 등록'}</h3>
            <label htmlFor="p-name" style={S.tag}>파트너명</label>
            <input id="p-name" style={S.input} value={pForm.name} onChange={(e) => setPForm({ ...pForm, name: e.target.value })} placeholder="예: 제이투모로우원" />
            <label htmlFor="p-manager" style={S.tag}>담당자 이름(연락처는 저장하지 않습니다)</label>
            <input id="p-manager" style={S.input} value={pForm.managerName} onChange={(e) => setPForm({ ...pForm, managerName: e.target.value })} placeholder="예: 김담당" />
            <label htmlFor="p-fee" style={S.tag}>수수료율(bp · 100bp = 1%, 비우면 미설정)</label>
            <input id="p-fee" style={S.input} inputMode="numeric" value={pForm.feeRateBp} onChange={(e) => setPForm({ ...pForm, feeRateBp: e.target.value })} placeholder="예: 1500 (=15%)" />
            <label htmlFor="p-status" style={S.tag}>상태</label>
            <select id="p-status" style={S.input} value={pForm.status} onChange={(e) => setPForm({ ...pForm, status: e.target.value as PartnerForm['status'] })}>
              <option value="active">운영 중</option>
              <option value="paused">중지</option>
            </select>
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={S.btn} onClick={submitPartner}>{pForm.id ? '수정 저장' : '등록'}</button>
              {pForm.id && <button style={S.btnGhost} onClick={() => setPForm(EMPTY_PARTNER_FORM)}>취소</button>}
            </div>
          </section>

          )}

          <section style={S.card} aria-labelledby="partner-list-h">
            <h3 id="partner-list-h" style={{ fontSize: 15, marginBottom: 8 }}>파트너 ({partners.length})</h3>
            {partners.length === 0 ? (
              <p style={S.tag}>
                {partnerBusy ? '불러오는 중…' : '등록된 파트너가 없습니다. 위 양식에서 첫 파트너를 등록하면 고객사 귀속을 지정할 수 있습니다.'}
              </p>
            ) : (
              partners.map((p) => (
                <div key={p.id} style={{ borderTop: '1px solid var(--line)', padding: '10px 0', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  <b style={{ fontSize: 14 }}>{p.name}</b>
                  <span style={S.tag}>{p.id} · {p.status === 'active' ? '운영 중' : '중지'} · 수수료 {feeLabel(p.feeRateBp)}{p.managerName ? ` · 담당 ${p.managerName}` : ''}</span>
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                    {canWrite && <button style={S.btnGhost} onClick={() => setPForm({ id: p.id, name: p.name, managerName: p.managerName ?? '', feeRateBp: p.feeRateBp === null ? '' : String(p.feeRateBp), status: p.status, memo: p.memo ?? '' })}>수정</button>}
                    {canWrite && <button style={S.btnGhost} onClick={() => removePartner(p)}>삭제</button>}
                  </span>
                </div>
              ))
            )}
          </section>

          {canWrite && (
          <section style={S.card} aria-labelledby="account-form-h">
            <h3 id="account-form-h" style={{ fontSize: 15, marginBottom: 8 }}>{aForm.id ? '고객사 수정' : '고객사 등록'}</h3>
            <label htmlFor="a-name" style={S.tag}>고객사명</label>
            <input id="a-name" style={S.input} value={aForm.name} onChange={(e) => setAForm({ ...aForm, name: e.target.value })} placeholder="예: OO의원" />
            <label htmlFor="a-partner" style={S.tag}>귀속 파트너(비우면 직접 계약)</label>
            <select id="a-partner" style={S.input} value={aForm.partnerId} onChange={(e) => setAForm({ ...aForm, partnerId: e.target.value })}>
              <option value="">직접 계약</option>
              {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <label htmlFor="a-source" style={S.tag}>유입 경로</label>
            <select id="a-source" style={S.input} value={aForm.source} onChange={(e) => setAForm({ ...aForm, source: e.target.value })}>
              {Object.entries(SOURCE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <label htmlFor="a-status" style={S.tag}>계약 상태</label>
            <select id="a-status" style={S.input} value={aForm.status} onChange={(e) => setAForm({ ...aForm, status: e.target.value as AccountView['status'] })}>
              {Object.entries(ACCOUNT_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <label htmlFor="a-date" style={S.tag}>계약일(YYYY-MM-DD · 계약 상태면 필수)</label>
            <input id="a-date" style={S.input} value={aForm.contractedAt} onChange={(e) => setAForm({ ...aForm, contractedAt: e.target.value })} placeholder="2026-09-01" />
            <label htmlFor="a-fee" style={S.tag}>월 이용료(원 · 계약서 금액. 비우면 미입력 — 정산 합계에서 제외됩니다)</label>
            <input id="a-fee" style={S.input} inputMode="numeric" value={aForm.monthlyFeeKrw} onChange={(e) => setAForm({ ...aForm, monthlyFeeKrw: e.target.value })} placeholder="예: 300000" />
            <label htmlFor="a-owner" style={S.tag}>고원 담당자 이름</label>
            <input id="a-owner" style={S.input} value={aForm.ownerName} onChange={(e) => setAForm({ ...aForm, ownerName: e.target.value })} placeholder="예: 이담당" />
            <label htmlFor="a-note" style={S.tag}>귀속 근거(변경 시 이력에 남습니다)</label>
            <input id="a-note" style={S.input} value={aForm.attributionNote} onChange={(e) => setAForm({ ...aForm, attributionNote: e.target.value })} placeholder="예: 파트너 소개로 최초 미팅(2026-08-20)" />
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={S.btn} onClick={submitAccount}>{aForm.id ? '수정 저장' : '등록'}</button>
              {aForm.id && <button style={S.btnGhost} onClick={() => setAForm(EMPTY_ACCOUNT_FORM)}>취소</button>}
            </div>
          </section>

          )}

          <section style={S.card} aria-labelledby="account-list-h">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <h3 id="account-list-h" style={{ fontSize: 15 }}>고객사 ({accounts.length})</h3>
              <span>
                <label htmlFor="a-filter" style={{ ...S.tag, marginRight: 6 }}>귀속 필터</label>
                <select
                  id="a-filter"
                  style={{ border: '1px solid var(--line-2)', borderRadius: 'var(--r-sm)', padding: '6px 10px', fontSize: 13 }}
                  value={partnerFilter}
                  onChange={(e) => { setPartnerFilter(e.target.value); loadPartners(e.target.value); }}
                >
                  <option value="">전체</option>
                  <option value="direct">직접 계약</option>
                  {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </span>
            </div>
            {accounts.length === 0 ? (
              <p style={{ ...S.tag, marginTop: 10 }}>
                {partnerBusy
                  ? '불러오는 중…'
                  : partnerFilter
                    ? '이 조건에 해당하는 고객사가 없습니다. 필터를 "전체"로 바꿔 보세요.'
                    : '등록된 고객사가 없습니다. 위 양식에서 첫 고객사를 등록하면 유입 경로와 귀속 이력이 함께 기록됩니다.'}
              </p>
            ) : (
              accounts.map((a) => {
                const last = a.attribution[a.attribution.length - 1];
                const partnerName = a.partnerId ? partners.find((p) => p.id === a.partnerId)?.name ?? a.partnerId : '직접 계약';
                return (
                  <div key={a.id} style={{ borderTop: '1px solid var(--line)', padding: '10px 0' }}>
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                      <b style={{ fontSize: 14 }}>{a.name}</b>
                      <span style={S.tag}>
                        {a.id} · {partnerName} · {SOURCE_LABELS[a.source] ?? a.source} · {ACCOUNT_STATUS_LABELS[a.status]}
                        {a.contractedAt ? ` · 계약일 ${a.contractedAt}` : ''}
                        {a.ownerName ? ` · 담당 ${a.ownerName}` : ''}
                        {` · 월 ${wonLabel(a.monthlyFeeKrw)}`}
                      </span>
                      <span style={{ marginLeft: 'auto' }}>
                        {canWrite && <button
                          style={S.btnGhost}
                          onClick={() => setAForm({
                            id: a.id, name: a.name, partnerId: a.partnerId ?? '', source: a.source,
                            status: a.status, contractedAt: a.contractedAt ?? '', ownerName: a.ownerName ?? '',
                            monthlyFeeKrw: typeof a.monthlyFeeKrw === 'number' ? String(a.monthlyFeeKrw) : '', attributionNote: '',
                          })}
                        >수정</button>}
                      </span>
                    </div>
                    <details style={{ marginTop: 6 }}>
                      <summary style={{ ...S.tag, cursor: 'pointer' }}>귀속 이력 {a.attribution.length}건{last ? ` · 최근: ${last.note}` : ''}</summary>
                      <ul style={{ margin: '6px 0 0 16px', padding: 0, fontSize: 12.5, color: 'var(--sub)' }}>
                        {a.attribution.map((h, idx) => (
                          <li key={idx} style={{ marginBottom: 3 }}>
                            {h.at.slice(0, 10)} · {h.fromPartnerId ?? '직접'} → {h.toPartnerId ?? '직접'} · {SOURCE_LABELS[h.source] ?? h.source} · {h.note}
                            {h.authed ? ' · 인증됨' : ''}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </div>
                );
              })
            )}
          </section>
        </>
      )}

      {tab === 'settle' && (
        <>
          <section style={S.card} aria-labelledby="settle-h">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <h2 id="settle-h" style={{ fontSize: 16 }}>파트너 정산 리포트</h2>
              <div style={{ display: 'flex', gap: 8 }}>
                <button style={S.btnGhost} onClick={() => loadSettlement(settleMonth, settlePartner)} disabled={settleBusy}>
                  {settleBusy ? '불러오는 중…' : '다시 계산'}
                </button>
                <button style={S.btnGhost} onClick={downloadSettlementCsv} disabled={!settleReport || settleReport.rows.length === 0}>
                  CSV 내려받기
                </button>
              </div>
            </div>
            <p style={{ ...S.tag, marginTop: 6 }}>
              월 이용료(계약서 입력값) × 수수료율로 <b>산출 근거</b>를 만듭니다. 값이 없는 항목은 0으로 채우지 않고 <b>합계에서 제외</b>하고 사유를 표시합니다.
              실제 청구·지급은 계약서 확정 후 <b>[승인 필요]</b>.
            </p>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 12 }}>
              <span>
                <label htmlFor="s-month" style={{ ...S.tag, display: 'block' }}>기준월</label>
                <input
                  id="s-month"
                  type="month"
                  style={{ border: '1px solid var(--line-2)', borderRadius: 'var(--r-sm)', padding: '6px 10px', fontSize: 13 }}
                  value={settleMonth}
                  onChange={(e) => { setSettleMonth(e.target.value); loadSettlement(e.target.value, settlePartner); }}
                />
              </span>
              <span>
                <label htmlFor="s-partner" style={{ ...S.tag, display: 'block' }}>파트너</label>
                <select
                  id="s-partner"
                  style={{ border: '1px solid var(--line-2)', borderRadius: 'var(--r-sm)', padding: '6px 10px', fontSize: 13 }}
                  value={settlePartner}
                  onChange={(e) => { setSettlePartner(e.target.value); loadSettlement(settleMonth, e.target.value); }}
                >
                  <option value="">전체 파트너</option>
                  {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </span>
            </div>
            {settleErr && <p role="alert" style={{ fontSize: 13, color: '#c0392b', marginTop: 10 }}>{settleErr}</p>}
            <p role="status" aria-live="polite" style={{ ...S.tag, marginTop: 8 }}>
              {settleBusy ? '정산 리포트를 계산하는 중입니다…' : ''}
            </p>
          </section>

          {!settleErr && settleReport && (
            <>
              <section style={S.card} aria-labelledby="settle-sum-h">
                <h3 id="settle-sum-h" style={{ fontSize: 15, marginBottom: 8 }}>
                  {settleReport.month} 요약 ({settleReport.periodStart} ~ {settleReport.periodEnd})
                </h3>
                {settleReport.partnerTotals.length === 0 ? (
                  <p style={S.tag}>
                    이 기간에 정산 대상 고객사가 없습니다. 파트너 귀속 고객사를 <b>계약</b> 상태로 두고 계약일을 입력하면 여기에 나타납니다.
                  </p>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <caption style={{ ...S.tag, textAlign: 'left', marginBottom: 6 }}>파트너별 합계(근거가 갖춰진 건만 합산)</caption>
                      <thead>
                        <tr style={{ textAlign: 'left', color: 'var(--mut)' }}>
                          <th scope="col" style={{ padding: '6px 8px' }}>파트너</th>
                          <th scope="col" style={{ padding: '6px 8px' }}>대상</th>
                          <th scope="col" style={{ padding: '6px 8px' }}>산출</th>
                          <th scope="col" style={{ padding: '6px 8px' }}>미산출</th>
                          <th scope="col" style={{ padding: '6px 8px' }}>기준금액</th>
                          <th scope="col" style={{ padding: '6px 8px' }}>수수료</th>
                        </tr>
                      </thead>
                      <tbody>
                        {settleReport.partnerTotals.map((t) => (
                          <tr key={t.partnerId} style={{ borderTop: '1px solid var(--line)' }}>
                            <th scope="row" style={{ padding: '6px 8px', fontWeight: 600, textAlign: 'left' }}>{t.partnerName}</th>
                            <td style={{ padding: '6px 8px' }}>{t.accounts}</td>
                            <td style={{ padding: '6px 8px' }}>{t.billable}</td>
                            <td style={{ padding: '6px 8px' }}>{t.incomplete}</td>
                            <td style={{ padding: '6px 8px' }}>{t.baseAmountKrw.toLocaleString('ko-KR')}원</td>
                            <td style={{ padding: '6px 8px' }}>{t.feeAmountKrw.toLocaleString('ko-KR')}원</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {settleReport.totals.partial && (
                  <p role="alert" style={{ fontSize: 13, color: '#b26a00', marginTop: 10 }}>
                    근거가 부족한 {settleReport.totals.incomplete}건이 합계에서 빠져 있습니다. 이 합계는 <b>확정 금액이 아닙니다</b>.
                  </p>
                )}
              </section>

              <section style={S.card} aria-labelledby="settle-rows-h">
                <h3 id="settle-rows-h" style={{ fontSize: 15, marginBottom: 8 }}>고객사별 산출 근거 ({settleReport.rows.length})</h3>
                {settleReport.rows.length === 0 ? (
                  <p style={S.tag}>표시할 항목이 없습니다.</p>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <thead>
                        <tr style={{ textAlign: 'left', color: 'var(--mut)' }}>
                          <th scope="col" style={{ padding: '6px 8px' }}>고객사</th>
                          <th scope="col" style={{ padding: '6px 8px' }}>파트너</th>
                          <th scope="col" style={{ padding: '6px 8px' }}>계약일</th>
                          <th scope="col" style={{ padding: '6px 8px' }}>월 이용료</th>
                          <th scope="col" style={{ padding: '6px 8px' }}>수수료율</th>
                          <th scope="col" style={{ padding: '6px 8px' }}>수수료</th>
                          <th scope="col" style={{ padding: '6px 8px' }}>비고</th>
                        </tr>
                      </thead>
                      <tbody>
                        {settleReport.rows.map((r) => (
                          <tr key={r.accountId} style={{ borderTop: '1px solid var(--line)' }}>
                            <th scope="row" style={{ padding: '6px 8px', fontWeight: 600, textAlign: 'left' }}>{r.accountName}</th>
                            <td style={{ padding: '6px 8px' }}>{r.partnerName}</td>
                            <td style={{ padding: '6px 8px' }}>{r.contractedAt}</td>
                            <td style={{ padding: '6px 8px' }}>{wonLabel(r.baseAmountKrw)}</td>
                            <td style={{ padding: '6px 8px' }}>{feeLabel(r.feeRateBp)}</td>
                            <td style={{ padding: '6px 8px' }}>{r.feeAmountKrw === null ? '산출 불가' : `${r.feeAmountKrw.toLocaleString('ko-KR')}원`}</td>
                            <td style={{ padding: '6px 8px', color: 'var(--mut)' }}>{ISSUE_LABELS[r.issue]}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <details style={{ marginTop: 12 }}>
                  <summary style={{ ...S.tag, cursor: 'pointer' }}>산출 기준·한계 {settleReport.notes.length}건</summary>
                  <ul style={{ margin: '6px 0 0 16px', padding: 0, fontSize: 12.5, color: 'var(--sub)' }}>
                    {settleReport.notes.map((n, i) => <li key={i} style={{ marginBottom: 3 }}>{n}</li>)}
                  </ul>
                </details>
              </section>
            </>
          )}
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
              KB·룰 편집, 티켓 상태 변경, 백업 복원 이력(최근 500건)입니다. 토큰 값은 기록하지 않습니다.
            </p>
          </section>

          <section style={S.card} aria-labelledby="storage-h">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <h2 id="storage-h" style={{ fontSize: 16 }}>저장소 상태</h2>
              <button style={S.btnGhost} onClick={loadStorage} disabled={storageBusy} aria-busy={storageBusy}>
                {storageBusy ? '확인 중…' : '새로고침'}
              </button>
            </div>
            <p style={{ ...S.tag, marginTop: 8 }}>
              데이터가 어디에 저장되는지와 최근 저장 결과입니다. 저장이 막히면 서비스는 메모리로 계속 동작하며, 그 사유가 여기에 표시됩니다.
            </p>

            <div role="status" aria-live="polite">
              {storageErr && (
                <p style={{ fontSize: 14, color: 'var(--danger, #c0392b)', marginTop: 10 }}>
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
                <p style={{ ...S.tag, marginTop: 10 }}>
                  드라이버: <strong>{storage.driver === 'file' ? '파일(file)' : '메모리(memory)'}</strong>
                  {' · '}개인정보 저장 승인: <strong>{storage.piiApproved ? '승인됨' : '미승인 [승인 필요]'}</strong>
                </p>
                <ul style={{ listStyle: 'none', marginTop: 10, display: 'grid', gap: 8 }}>
                  {storage.namespaces.map((n) => {
                    const meta = STORAGE_HEALTH[n.health] ?? STORAGE_HEALTH.empty;
                    return (
                      <li key={n.ns} style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', padding: '10px 12px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
                          <strong style={{ fontSize: 14 }}>{STORAGE_NS_LABELS[n.ns] || n.ns}</strong>
                          <span style={S.tag}>
                            {meta.label}
                            {n.lastSavedAt ? ` · 최근 저장 ${new Date(n.lastSavedAt).toLocaleString()}` : ''}
                          </span>
                        </div>
                        <p style={{ ...S.tag, marginTop: 4 }}>{meta.hint}</p>
                        {n.lastError && (
                          <p style={{ fontSize: 12, color: 'var(--danger, #c0392b)', marginTop: 4 }}>오류: {n.lastError}</p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
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
              {t.citation && (
                <div style={{ ...S.tag, marginTop: 4 }}>
                  근거: {t.citation.source} — “{t.citation.snippet}”
                </div>
              )}
              <div style={S.tag}>
                intent: {t.intent} · source: {t.source}
                {t.confidence !== undefined && ` · 신뢰도(엔진 내부 판정값) ${t.confidence}`}
              </div>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
