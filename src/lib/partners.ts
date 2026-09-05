// 파트너(채널) · 고객사 계약 귀속 스토어.
//
// 왜 필요한가: 운영 대행 파트너(예: 제이투모로우원)가 유치한 고객사와 직접 계약 고객사를 구분해 두지 않으면
// 나중에 "이 고객사는 누가 데려왔는가"를 증명할 수 없다. 정산 분쟁은 대부분 이 기록의 부재에서 생긴다.
// 그래서 **계약 주체(고원)는 그대로 두고**, 계약에 `partnerId`(nullable)와 유입 근거만 붙인다.
//
// 설계 원칙
// - `partnerId === null` 이면 직접 계약. 파트너 개념을 몰라도 기존 동작이 그대로 성립한다.
// - **귀속 변경은 append-only 이력으로 남긴다**(`attribution` 배열). 값만 바꾸면 근거가 사라진다.
// - 수수료율은 **설정값**이다(파트너별 `feeRateBp`, 미설정 시 `PARTNER_DEFAULT_FEE_RATE_BP`).
//   계약서 확정 전 임의 수치를 코드에 박지 않는다 — 미설정이면 `null`로 두고 화면에 "미설정"으로 표시한다.
// - **개인정보 최소화**: 담당자는 이름(또는 호칭)만 받는다. 전화·이메일 필드를 아예 두지 않아
//   개인정보 포함 네임스페이스가 되지 않게 한다(그래서 승인 없이 저장 가능).
// - 조회는 전부 `queryAccounts()` 한 곳을 지나간다 — 향후 리셀러(2계층)로 갈 때
//   "파트너 담당자는 자기 고객사만" 같은 필터를 이 함수 한 곳에만 끼우면 된다.
//
// [승인 필요] 실제 정산·청구, 파트너 계정 로그인(partner_admin 권한), 화이트라벨.
import { loadJson, scheduleSave } from '@/lib/storage';

export const PARTNERS_NS = 'partners';

export type PartnerStatus = 'active' | 'paused';

export const PARTNER_STATUS_LABELS: Record<PartnerStatus, string> = {
  active: '운영 중',
  paused: '중지',
};

export interface Partner {
  id: string; // PTR-0001
  name: string;
  status: PartnerStatus;
  /** 파트너 측 담당자 — 이름·호칭만(연락처는 저장하지 않는다). */
  managerName?: string;
  /** 수수료율(베이시스포인트, 100bp = 1%). 미설정이면 null — 임의값을 만들지 않는다. */
  feeRateBp: number | null;
  memo?: string;
  createdAt: string;
  updatedAt: string;
}

/** 유입 경로 — 매출 귀속의 1차 근거. */
export type LeadSource = 'direct' | 'partner' | 'referral' | 'inbound' | 'unknown';

export const LEAD_SOURCES: LeadSource[] = ['direct', 'partner', 'referral', 'inbound', 'unknown'];

export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  direct: '직접 영업',
  partner: '파트너 유치',
  referral: '고객 소개',
  inbound: '인바운드 문의',
  unknown: '미확인',
};

export type AccountStatus = 'prospect' | 'contracted' | 'churned';

export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  prospect: '검토 중',
  contracted: '계약',
  churned: '해지',
};

/** 귀속 변경 이력 1건(append-only). 누가·언제·무엇을 바꿨는지가 정산 근거가 된다. */
export interface AttributionEvent {
  at: string;
  /** 변경 전 파트너(없으면 null = 직접) */
  fromPartnerId: string | null;
  toPartnerId: string | null;
  source: LeadSource;
  /** 변경 사유(사람이 읽는 근거). 개인정보를 넣지 않는다. */
  note: string;
  /** 관리자 인증을 거친 요청이었는지(토큰 값은 기록하지 않는다). */
  authed: boolean;
}

export interface Account {
  id: string; // ACC-0001
  name: string; // 고객사명
  /** 유치 파트너. null이면 직접 계약. */
  partnerId: string | null;
  source: LeadSource;
  status: AccountStatus;
  /** 계약일(YYYY-MM-DD). 미확정이면 비운다. */
  contractedAt?: string;
  /** 고원 측 담당자 — 이름·호칭만. */
  ownerName?: string;
  /**
   * 월 이용료(원). **사람이 계약서를 보고 입력한 값만** 들어간다 — 추정·자동 산출을 하지 않는다.
   * 미입력이면 undefined이며, 정산 리포트에서 "미입력"으로 표시되고 합계에서 제외된다.
   */
  monthlyFeeKrw?: number;
  memo?: string;
  /** 귀속 이력(최신이 뒤). 최소 1건(최초 등록)이 항상 존재한다. */
  attribution: AttributionEvent[];
  createdAt: string;
  updatedAt: string;
}

const MAX_NAME = 80;
const MAX_MEMO = 300;
const MAX_ATTRIBUTION = 50;
/** 월 이용료 상한(원) — 오타로 자릿수가 튄 값을 정산 근거로 받지 않는다. */
const MAX_MONTHLY_FEE = 1_000_000_000;

let partners: Partner[] = [];
let accounts: Account[] = [];
let partnerSeq = 0;
let accountSeq = 0;

function now(): string {
  return new Date().toISOString();
}

function clean(v: unknown, max: number): string {
  return String(v ?? '').trim().slice(0, max);
}

function isLeadSource(v: unknown): v is LeadSource {
  return typeof v === 'string' && (LEAD_SOURCES as string[]).includes(v);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 계약일 검증 — 형식과 실재하는 날짜인지 함께 본다(2026-02-31 거절). */
export function isValidDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 기본 수수료율(설정값). 미설정이면 null — 화면·리포트에서 "미설정"으로 표시한다. */
export function defaultFeeRateBp(): number | null {
  const raw = Number(process.env.PARTNER_DEFAULT_FEE_RATE_BP);
  if (!Number.isFinite(raw) || raw < 0 || raw > 10000) return null;
  return Math.round(raw);
}

/** 실제 적용될 수수료율(파트너 설정 → 기본값 순). 없으면 null. */
export function effectiveFeeRateBp(partner: Pick<Partner, 'feeRateBp'>): number | null {
  return partner.feeRateBp ?? defaultFeeRateBp();
}

// ---- 파트너 ----

export interface PartnerInput {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  managerName?: unknown;
  feeRateBp?: unknown;
  memo?: unknown;
}

export type PartnerResult = { ok: true; partner: Partner; created: boolean } | { ok: false; error: string };

export function upsertPartner(input: PartnerInput): PartnerResult {
  const name = clean(input.name, MAX_NAME);
  if (!name) return { ok: false, error: '파트너명을 입력해 주세요.' };

  let feeRateBp: number | null = null;
  if (input.feeRateBp !== undefined && input.feeRateBp !== null && input.feeRateBp !== '') {
    const n = Number(input.feeRateBp);
    if (!Number.isFinite(n) || n < 0 || n > 10000) {
      return { ok: false, error: '수수료율은 0~10000bp(0~100%) 사이의 숫자여야 합니다.' };
    }
    feeRateBp = Math.round(n);
  }

  const status: PartnerStatus = input.status === 'paused' ? 'paused' : 'active';
  const id = clean(input.id, 40);
  const existing = id ? partners.find((p) => p.id === id) : undefined;
  if (id && !existing) return { ok: false, error: '존재하지 않는 파트너입니다.' };

  if (existing) {
    existing.name = name;
    existing.status = status;
    existing.managerName = clean(input.managerName, MAX_NAME) || undefined;
    existing.feeRateBp = feeRateBp;
    existing.memo = clean(input.memo, MAX_MEMO) || undefined;
    existing.updatedAt = now();
    persist();
    return { ok: true, partner: { ...existing }, created: false };
  }

  partnerSeq += 1;
  const partner: Partner = {
    id: `PTR-${String(partnerSeq).padStart(4, '0')}`,
    name,
    status,
    feeRateBp,
    managerName: clean(input.managerName, MAX_NAME) || undefined,
    memo: clean(input.memo, MAX_MEMO) || undefined,
    createdAt: now(),
    updatedAt: now(),
  };
  partners.push(partner);
  persist();
  return { ok: true, partner: { ...partner }, created: true };
}

export function listPartners(): Partner[] {
  return partners.map((p) => ({ ...p }));
}

export function getPartner(id: string): Partner | null {
  const p = partners.find((x) => x.id === id);
  return p ? { ...p } : null;
}

/**
 * 파트너 삭제는 귀속 이력을 잃는 되돌릴 수 없는 동작이므로,
 * 연결된 고객사가 하나라도 있으면 거절한다(먼저 귀속을 옮기게 한다).
 */
export function deletePartner(id: string): { ok: true } | { ok: false; error: string } {
  const idx = partners.findIndex((p) => p.id === id);
  if (idx < 0) return { ok: false, error: '존재하지 않는 파트너입니다.' };
  const linked = accounts.filter((a) => a.partnerId === id).length;
  if (linked > 0) {
    return { ok: false, error: `이 파트너에 연결된 고객사가 ${linked}곳 있습니다. 귀속을 먼저 변경해 주세요.` };
  }
  partners.splice(idx, 1);
  persist();
  return { ok: true };
}

// ---- 고객사 계약 ----

export interface AccountInput {
  id?: unknown;
  name?: unknown;
  partnerId?: unknown; // '' 또는 null이면 직접 계약
  source?: unknown;
  status?: unknown;
  contractedAt?: unknown;
  ownerName?: unknown;
  monthlyFeeKrw?: unknown;
  memo?: unknown;
  /** 귀속이 바뀔 때 남길 근거 문구 */
  attributionNote?: unknown;
  /** 관리자 인증 요청 여부(이력에 기록) */
  authed?: boolean;
}

export type AccountResult = { ok: true; account: Account; created: boolean } | { ok: false; error: string };

/**
 * 월 이용료 파싱. 빈 값은 "미입력"(undefined)이며 0과 구분한다 —
 * 0원 계약(무상 파일럿)과 "아직 안 적었음"을 섞으면 정산 근거가 흐려진다.
 */
export function parseMonthlyFee(v: unknown): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (v === undefined || v === null || v === '') return { ok: true, value: undefined };
  const n = typeof v === 'string' ? Number(v.replace(/[,\s]/g, '')) : Number(v);
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: '월 이용료는 0 이상의 숫자(원)여야 합니다.' };
  if (n > MAX_MONTHLY_FEE) return { ok: false, error: `월 이용료는 ${MAX_MONTHLY_FEE.toLocaleString('ko-KR')}원 이하여야 합니다.` };
  return { ok: true, value: Math.round(n) };
}

export function upsertAccount(input: AccountInput): AccountResult {
  const name = clean(input.name, MAX_NAME);
  if (!name) return { ok: false, error: '고객사명을 입력해 주세요.' };

  const rawPartner = clean(input.partnerId, 40);
  const partnerId = rawPartner ? rawPartner : null;
  if (partnerId && !partners.some((p) => p.id === partnerId)) {
    return { ok: false, error: '존재하지 않는 파트너입니다. 파트너를 먼저 등록해 주세요.' };
  }

  const source: LeadSource = isLeadSource(input.source) ? input.source : partnerId ? 'partner' : 'unknown';
  if (source === 'partner' && !partnerId) {
    return { ok: false, error: '유입 경로가 "파트너 유치"이면 파트너를 지정해야 합니다.' };
  }

  const contractedAt = clean(input.contractedAt, 10);
  if (contractedAt && !isValidDate(contractedAt)) {
    return { ok: false, error: '계약일은 YYYY-MM-DD 형식의 실제 날짜여야 합니다. (예: 2026-09-01)' };
  }

  const fee = parseMonthlyFee(input.monthlyFeeKrw);
  if (!fee.ok) return { ok: false, error: fee.error };

  const status: AccountStatus =
    input.status === 'contracted' || input.status === 'churned' ? input.status : 'prospect';
  if (status === 'contracted' && !contractedAt) {
    return { ok: false, error: '계약 상태로 두려면 계약일이 필요합니다(정산 귀속의 기준일).' };
  }

  const id = clean(input.id, 40);
  const existing = id ? accounts.find((a) => a.id === id) : undefined;
  if (id && !existing) return { ok: false, error: '존재하지 않는 고객사입니다.' };

  const note = clean(input.attributionNote, MAX_MEMO);
  const authed = input.authed === true;

  if (existing) {
    const changed = existing.partnerId !== partnerId || existing.source !== source;
    if (changed) {
      // 귀속 변경은 값만 바꾸지 않는다 — 이전 값과 사유를 이력으로 남긴다.
      existing.attribution.push({
        at: now(),
        fromPartnerId: existing.partnerId,
        toPartnerId: partnerId,
        source,
        note: note || '귀속 변경(사유 미기재)',
        authed,
      });
      if (existing.attribution.length > MAX_ATTRIBUTION) {
        existing.attribution = existing.attribution.slice(-MAX_ATTRIBUTION);
      }
    }
    existing.name = name;
    existing.partnerId = partnerId;
    existing.source = source;
    existing.status = status;
    existing.contractedAt = contractedAt || undefined;
    existing.ownerName = clean(input.ownerName, MAX_NAME) || undefined;
    existing.monthlyFeeKrw = fee.value;
    existing.memo = clean(input.memo, MAX_MEMO) || undefined;
    existing.updatedAt = now();
    persist();
    return { ok: true, account: cloneAccount(existing), created: false };
  }

  accountSeq += 1;
  const account: Account = {
    id: `ACC-${String(accountSeq).padStart(4, '0')}`,
    name,
    partnerId,
    source,
    status,
    contractedAt: contractedAt || undefined,
    ownerName: clean(input.ownerName, MAX_NAME) || undefined,
    monthlyFeeKrw: fee.value,
    memo: clean(input.memo, MAX_MEMO) || undefined,
    attribution: [
      {
        at: now(),
        fromPartnerId: null,
        toPartnerId: partnerId,
        source,
        note: note || '최초 등록',
        authed,
      },
    ],
    createdAt: now(),
    updatedAt: now(),
  };
  accounts.push(account);
  persist();
  return { ok: true, account: cloneAccount(account), created: true };
}

function cloneAccount(a: Account): Account {
  return { ...a, attribution: a.attribution.map((e) => ({ ...e })) };
}

/**
 * 고객사 조회 단일 진입점.
 * 지금은 필터가 단순하지만, 2계층(리셀러) 전환 시 "파트너 담당자는 자기 고객사만" 같은
 * 권한 필터를 **이 함수 한 곳에만** 끼우면 되도록 모든 조회를 여기로 모은다.
 */
export interface AccountQuery {
  /** 특정 파트너 소속만. 'direct'면 직접 계약(partnerId=null)만. */
  partnerId?: string | 'direct' | null;
  status?: AccountStatus;
  source?: LeadSource;
  /** 이름 부분 일치(대소문자·공백 무시) */
  q?: string;
}

export function queryAccounts(filter: AccountQuery = {}): Account[] {
  const q = (filter.q ?? '').trim().toLowerCase().replace(/\s+/g, '');
  return accounts
    .filter((a) => {
      if (filter.partnerId === 'direct' && a.partnerId !== null) return false;
      if (filter.partnerId && filter.partnerId !== 'direct' && a.partnerId !== filter.partnerId) return false;
      if (filter.status && a.status !== filter.status) return false;
      if (filter.source && a.source !== filter.source) return false;
      if (q && !a.name.toLowerCase().replace(/\s+/g, '').includes(q)) return false;
      return true;
    })
    .map(cloneAccount);
}

export function getAccount(id: string): Account | null {
  const a = accounts.find((x) => x.id === id);
  return a ? cloneAccount(a) : null;
}

/** 파트너별 귀속 집계 — 계약 건수만 센다(금액·성과 수치는 실적 데이터 연동 후 [승인 필요]). */
export interface PartnerRollup {
  partnerId: string | null;
  partnerName: string;
  feeRateBp: number | null;
  total: number;
  contracted: number;
  prospect: number;
  churned: number;
}

export function rollupByPartner(): PartnerRollup[] {
  const rows: PartnerRollup[] = partners.map((p) => ({
    partnerId: p.id,
    partnerName: p.name,
    feeRateBp: effectiveFeeRateBp(p),
    total: 0,
    contracted: 0,
    prospect: 0,
    churned: 0,
  }));
  rows.push({ partnerId: null, partnerName: '직접 계약', feeRateBp: null, total: 0, contracted: 0, prospect: 0, churned: 0 });

  for (const a of accounts) {
    const row = rows.find((r) => r.partnerId === a.partnerId);
    if (!row) continue; // 파트너가 삭제된 경우 — deletePartner가 막지만 복원 데이터 방어
    row.total += 1;
    if (a.status === 'contracted') row.contracted += 1;
    else if (a.status === 'churned') row.churned += 1;
    else row.prospect += 1;
  }
  return rows;
}

// ---- 영속화 ----

export interface PartnerSnapshot {
  version: 1;
  savedAt: string;
  partnerSeq: number;
  accountSeq: number;
  partners: Partner[];
  accounts: Account[];
}

export function exportPartners(): PartnerSnapshot {
  return {
    version: 1,
    savedAt: now(),
    partnerSeq,
    accountSeq,
    partners: listPartners(),
    accounts: accounts.map(cloneAccount),
  };
}

function persist(): void {
  scheduleSave(PARTNERS_NS, exportPartners);
}

/** 스냅샷 복원. 형식이 어긋난 항목은 건너뛰고 개수를 돌려준다. */
export function importPartners(input: unknown): { ok: true; partners: number; accounts: number } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: '유효한 JSON 객체가 아닙니다.' };
  const snap = input as Partial<PartnerSnapshot>;
  if (!Array.isArray(snap.partners) || !Array.isArray(snap.accounts)) {
    return { ok: false, error: 'partners·accounts 배열이 필요합니다.' };
  }

  const nextPartners: Partner[] = [];
  for (const p of snap.partners) {
    if (!p || typeof p !== 'object') continue;
    const { id, name } = p as Partner;
    if (typeof id !== 'string' || !id.trim() || typeof name !== 'string' || !name.trim()) continue;
    const fee = (p as Partner).feeRateBp;
    nextPartners.push({
      id: id.trim(),
      name: name.trim().slice(0, MAX_NAME),
      status: (p as Partner).status === 'paused' ? 'paused' : 'active',
      feeRateBp: typeof fee === 'number' && Number.isFinite(fee) && fee >= 0 && fee <= 10000 ? Math.round(fee) : null,
      managerName: clean((p as Partner).managerName, MAX_NAME) || undefined,
      memo: clean((p as Partner).memo, MAX_MEMO) || undefined,
      createdAt: typeof (p as Partner).createdAt === 'string' ? (p as Partner).createdAt : now(),
      updatedAt: typeof (p as Partner).updatedAt === 'string' ? (p as Partner).updatedAt : now(),
    });
  }

  const ids = new Set(nextPartners.map((p) => p.id));
  const nextAccounts: Account[] = [];
  for (const a of snap.accounts) {
    if (!a || typeof a !== 'object') continue;
    const { id, name } = a as Account;
    if (typeof id !== 'string' || !id.trim() || typeof name !== 'string' || !name.trim()) continue;
    const rawPid = (a as Account).partnerId;
    // 존재하지 않는 파트너를 가리키면 직접 계약으로 되돌린다(고아 귀속 방지).
    const partnerId = typeof rawPid === 'string' && ids.has(rawPid) ? rawPid : null;
    const src = (a as Account).source;
    const st = (a as Account).status;
    const ca = (a as Account).contractedAt;
    const history = Array.isArray((a as Account).attribution) ? (a as Account).attribution : [];
    nextAccounts.push({
      id: id.trim(),
      name: name.trim().slice(0, MAX_NAME),
      partnerId,
      source: isLeadSource(src) ? src : partnerId ? 'partner' : 'unknown',
      status: st === 'contracted' || st === 'churned' ? st : 'prospect',
      contractedAt: typeof ca === 'string' && isValidDate(ca) ? ca : undefined,
      ownerName: clean((a as Account).ownerName, MAX_NAME) || undefined,
      // 예전 백업에는 없는 필드 — 없으면 "미입력"으로 남긴다(임의값을 만들지 않는다).
      monthlyFeeKrw: (() => {
        const f = parseMonthlyFee((a as Account).monthlyFeeKrw);
        return f.ok ? f.value : undefined;
      })(),
      memo: clean((a as Account).memo, MAX_MEMO) || undefined,
      attribution: history
        .filter((e) => e && typeof e === 'object' && typeof e.at === 'string')
        .slice(-MAX_ATTRIBUTION)
        .map((e) => ({
          at: e.at,
          fromPartnerId: typeof e.fromPartnerId === 'string' ? e.fromPartnerId : null,
          toPartnerId: typeof e.toPartnerId === 'string' ? e.toPartnerId : null,
          source: isLeadSource(e.source) ? e.source : 'unknown',
          note: clean(e.note, MAX_MEMO),
          authed: e.authed === true,
        })),
      createdAt: typeof (a as Account).createdAt === 'string' ? (a as Account).createdAt : now(),
      updatedAt: typeof (a as Account).updatedAt === 'string' ? (a as Account).updatedAt : now(),
    });
  }

  // 일련번호는 **건너뛴 항목의 id까지** 포함해 계산한다.
  // 무효라서 복원되지 않은 id를 재사용하면, 원본 시스템의 다른 기록과 id가 충돌한다.
  const rawId = (v: unknown): string => (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' ? (v as { id: string }).id : '');
  partners = nextPartners;
  accounts = nextAccounts;
  partnerSeq = Math.max(numTail(snap.partners.map(rawId)), Number(snap.partnerSeq) || 0);
  accountSeq = Math.max(numTail(snap.accounts.map(rawId)), Number(snap.accountSeq) || 0);
  return { ok: true, partners: partners.length, accounts: accounts.length };
}

/** 'PTR-0007' 같은 id에서 가장 큰 일련번호를 뽑는다(복원 후 id 충돌 방지). */
function numTail(ids: string[]): number {
  let max = 0;
  for (const id of ids) {
    const n = Number(id.split('-').pop());
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

export function resetPartners(): void {
  partners = [];
  accounts = [];
  partnerSeq = 0;
  accountSeq = 0;
}

// 기동 시 복원 — 저장이 비활성·손상이면 빈 상태로 시작하고 사유는 storageStatus()에 남는다.
(function loadPersisted() {
  const r = loadJson(PARTNERS_NS);
  if (!r.ok) return;
  importPartners(r.data);
})();
