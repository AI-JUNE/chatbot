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
import { loadJson, saveJson, saveNow, savedInfo, scheduleSave, type SavedInfo } from '@/lib/storage';
import { compact } from '@/lib/normalize';
import { readInstant } from '@/lib/kst';
import { revOf } from '@/lib/rev';
import {
  CHANGED_DELETE_TARGET_MESSAGE,
  CHANGED_TARGET_MESSAGE,
  RESTORE_FORMAT_MESSAGE,
  STALE_TARGET_MESSAGE,
} from '@/lib/refusal';

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

/**
 * 귀속이 가리키는 파트너를 **지금 찾을 수 없을 때** 적는 이름 (DS 53-3).
 *
 * 화면·정산 리포트·파트너별 집계가 같은 말을 쓴다 — 두 곳이 각자 적으면 같은 사실이 화면마다
 * 다른 말로 뜬다(DS 36-2·47-3 이 세운 「이름은 아는 쪽이 한 벌로 붙인다」와 같은 규칙).
 * 「직접 계약」이라고 적지 않는 것이 요점이다: 그것은 **다른 사실**이고, 정산에서 제외되는
 * 까닭도 다르다(대상이 아님 vs 근거가 모자람).
 */
export function missingPartnerName(id: string): string {
  return `(삭제된 파트너 ${id})`;
}

/**
 * 수수료율을 **사람 말로** (DS 2-12 · DS 57-1). 화면은 %로 묻고 받으므로, 사람이 읽는 자리에는
 * 내부 단위(bp)를 적지 않는다. 미설정은 0%가 아니라 「미설정」이다 — 둘을 섞으면 §13 이 금한
 * 「없는 수」가 선다. 콘솔의 `feeLabel` 과 같은 말을 쓴다(그 쪽은 화면 묶음이라 따로 적혀 있다).
 */
export function feeRateWords(bp: number | null | undefined): string {
  if (typeof bp !== 'number') return '미설정';
  return `${(bp / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

/**
 * 「내가 고치기 시작할 때 본 모습」 한 줄 (DS 46-1 · DS 56-3).
 *
 * 왜 이 저장소에도 필요한가: DS 46-1 이 안내 자료·규칙·접수에 세운 관문의 전제가
 * 「이 제품의 쓰기 경로는 전부 덮어쓰기다 — 콘솔의 편집 폼은 칸의 값을 통째로 보내고
 * 서버는 받은 대로 갈아 끼운다」인데, **파트너·고객사는 그 적용 목록에 없었다**. 그래서
 * 두 운영자가 같은 고객사를 열어 두면 나중에 저장한 쪽이 이기고, 먼저 고친 값은 아무
 * 말 없이 사라진다 — 하필 그 칸이 **월 이용료**이고, 사라진 값이 정산 수수료의 기준이다.
 *
 * 재는 자는 **한 벌**이다(DS 42-2): 목록 응답에 싣는 쪽(라우트)과 저장 직전에 견주는
 * 쪽(아래 `conflictOf`)이 같은 식을 쓴다. 시각(`createdAt`·`updatedAt`)과 귀속 이력은
 * 빼 둔다 — 그 둘은 저장이 **스스로** 바꾸는 값이라 넣으면 영영 어긋난다.
 */
export function accountRev(a: Account): string {
  return revOf({
    id: a.id,
    name: a.name,
    partnerId: a.partnerId,
    source: a.source,
    status: a.status,
    contractedAt: a.contractedAt ?? '',
    ownerName: a.ownerName ?? '',
    monthlyFeeKrw: a.monthlyFeeKrw ?? null,
    memo: a.memo ?? '',
  });
}

/** 파트너 한 건의 모습 — `accountRev` 와 같은 규칙이다(수수료율이 그 안에 있다). */
export function partnerRev(p: Partner): string {
  return revOf({
    id: p.id,
    name: p.name,
    status: p.status,
    managerName: p.managerName ?? '',
    feeRateBp: p.feeRateBp,
    memo: p.memo ?? '',
  });
}

/**
 * 저장 직전 관문 — 내가 보던 것이 그 사이 지워졌거나 바뀌었으면 거절한다 (DS 46-1).
 * `adminStore` 의 같은 이름 함수와 같은 규칙이다: `baseRev` 를 보내지 않으면 종전처럼
 * 그대로 갈아 끼운다(복원·일괄 처리처럼 겨룰 상대가 없는 자리).
 */
function conflictOf<T>(baseRev: unknown, existing: T | undefined, revOfItem: (v: T) => string): 'gone' | 'changed' | null {
  const base = String(baseRev ?? '').trim();
  if (!base) return null;
  if (!existing) return 'gone';
  return revOfItem(existing) === base ? null : 'changed';
}

// ---- 파트너 ----

export interface PartnerInput {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  managerName?: unknown;
  feeRateBp?: unknown;
  memo?: unknown;
  /**
   * 편집을 **시작할 때 본** 모습 (DS 46-1 · DS 56-3). 보내면 그 사이 바뀐 파트너를 덮어쓰지 않는다.
   * 보내지 않으면 종전과 같이 그대로 갈아 끼운다.
   */
  baseRev?: unknown;
}

export type PartnerResult =
  | { ok: true; partner: Partner; created: boolean }
  /** `conflict` 는 **입력이 틀린 것이 아니라** 그 사이 다른 화면에서 바뀐 것이다 (DS 46-1). */
  | { ok: false; error: string; conflict?: 'gone' | 'changed'; current?: Partner };

export function upsertPartner(input: PartnerInput): PartnerResult {
  // 내가 보던 모습을 들고 왔으면 **그 모습일 때만** 갈아 끼운다 (DS 46-1 · DS 56-3).
  // 칸 검사보다 먼저 본다 — 보던 것이 이미 사라졌으면 어느 칸이 틀렸는지는 다음 문제다
  // (`upsertKB` 가 세운 순서와 같다).
  const baseId = clean(input.id, 40);
  const baseTarget = baseId ? partners.find((p) => p.id === baseId) : undefined;
  const pConflict = conflictOf(input.baseRev, baseTarget, partnerRev);
  if (pConflict === 'gone') return { ok: false, error: STALE_TARGET_MESSAGE, conflict: pConflict };
  if (pConflict === 'changed') {
    return { ok: false, error: CHANGED_TARGET_MESSAGE, conflict: pConflict, current: { ...(baseTarget as Partner) } };
  }

  const name = clean(input.name, MAX_NAME);
  if (!name) return { ok: false, error: '파트너명을 입력해 주세요.' };

  let feeRateBp: number | null = null;
  if (input.feeRateBp !== undefined && input.feeRateBp !== null && input.feeRateBp !== '') {
    const n = Number(input.feeRateBp);
    if (!Number.isFinite(n) || n < 0 || n > 10000) {
      // 화면은 %로 묻고 받는다(DS 2-12) — 거절 문장에도 내부 단위(bp)를 적지 않는다(DS 29-3).
      return { ok: false, error: '수수료율은 0~100% 사이의 숫자로 적어주세요.' };
    }
    feeRateBp = Math.round(n);
  }

  const status: PartnerStatus = input.status === 'paused' ? 'paused' : 'active';
  const id = baseId;
  const existing = baseTarget;
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

export type PartnerDeleteResult =
  /** 지운 **그 파트너**를 돌려준다 — 부르는 쪽이 「무엇을 지웠는지」를 기록에 적을 수 있게 (DS 57-1). */
  | { ok: true; partner: Partner }
  | { ok: false; error: string; conflict?: 'gone' | 'changed'; current?: Partner };

/**
 * 파트너 삭제는 귀속 이력을 잃는 되돌릴 수 없는 동작이므로,
 * 연결된 고객사가 하나라도 있으면 거절한다(먼저 귀속을 옮기게 한다).
 *
 * **지우는 자리에도 동시 편집 관문을 세운다** (DS 46-1 · DS 57-1). 종전에는 식별자만 받았다 —
 * 그래서 A 가 옛 목록에서 「제이투모로우원 / 수수료율 10%」를 지울 때, B 가 그 사이 이름을
 * 「제이투모로우원(신규계약)」으로 고치고 수수료율을 15%로 올려 두었더라도 **거절 없이** 지워졌다.
 * A 가 확인 대화상자에서 읽고 승인한 이름조차 지워진 것과 달랐다(옛 목록의 이름이다).
 * 고객사가 붙은 파트너는 서버가 막지만, 「그 사이 수수료율이 바뀐 파트너」는 그대로 지나갔다.
 *
 * `baseRev` 를 보내지 않으면 종전처럼 그대로 지운다 — `upsertPartner`·`upsertKB` 가 세운 규약과
 * 같다(복원·일괄 처리처럼 겨룰 상대가 없는 자리를 막지 않는다).
 */
export function deletePartner(id: string, input: { baseRev?: unknown } = {}): PartnerDeleteResult {
  const target = partners.find((p) => p.id === id);
  const conflict = conflictOf(input.baseRev, target, partnerRev);
  if (conflict === 'gone') return { ok: false, error: STALE_TARGET_MESSAGE, conflict };
  if (conflict === 'changed') {
    return { ok: false, error: CHANGED_DELETE_TARGET_MESSAGE, conflict, current: { ...(target as Partner) } };
  }
  const idx = partners.findIndex((p) => p.id === id);
  if (idx < 0) return { ok: false, error: '존재하지 않는 파트너입니다.' };
  const linked = accounts.filter((a) => a.partnerId === id).length;
  if (linked > 0) {
    return { ok: false, error: `이 파트너에 연결된 고객사가 ${linked}곳 있습니다. 귀속을 먼저 변경해 주세요.` };
  }
  const [removed] = partners.splice(idx, 1);
  persist();
  return { ok: true, partner: { ...removed } };
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
  /** 편집을 **시작할 때 본** 모습 (DS 46-1 · DS 56-3) — `PartnerInput.baseRev` 와 같은 규칙이다. */
  baseRev?: unknown;
}

export type AccountResult =
  | { ok: true; account: Account; created: boolean }
  | { ok: false; error: string; conflict?: 'gone' | 'changed'; current?: Account };

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
  // 「누구를 고치는가」를 먼저 잡는다 — 아래 두 관문(동시 편집·귀속 확인)이 모두 지금
  // 저장된 그 고객사를 봐야 한다. 거절 문장의 순서는 종전 그대로다(칸 → 귀속 → … → 식별자).
  const id = clean(input.id, 40);
  const existing = id ? accounts.find((a) => a.id === id) : undefined;

  // 내가 보던 모습을 들고 왔으면 **그 모습일 때만** 갈아 끼운다 (DS 46-1 · DS 56-3).
  const aConflict = conflictOf(input.baseRev, existing, accountRev);
  if (aConflict === 'gone') return { ok: false, error: STALE_TARGET_MESSAGE, conflict: aConflict };
  if (aConflict === 'changed') {
    return { ok: false, error: CHANGED_TARGET_MESSAGE, conflict: aConflict, current: cloneAccount(existing as Account) };
  }

  const name = clean(input.name, MAX_NAME);
  if (!name) return { ok: false, error: '고객사명을 입력해 주세요.' };

  const rawPartner = clean(input.partnerId, 40);
  const partnerId = rawPartner ? rawPartner : null;
  /**
   * 귀속은 **바꿀 때만** 파트너의 존재를 확인한다 (DS 56-1).
   *
   * 종전에는 들어온 `partnerId` 가 등록 목록에 없으면 요청 전체를 거절했다. 그래서 가리키는
   * 파트너를 지금 찾을 수 없는 고객사(복원으로 들어오는 길이 있다 · `orphans`)는 **이름 한 자도
   * 고칠 수 없었다** — 월 이용료·계약일·담당자까지 전부 막혔고, 돌아오는 말은 「파트너를 먼저
   * 등록해 주세요」였다(어느 파트너인지도 적지 않는다). 운영자에게 열린 길은 하나뿐이었다:
   * 귀속을 다른 곳으로 옮기거나 직접 계약으로 돌리는 것 — 즉 **고치려면 귀속을 버려야** 했다.
   * 이 파일의 첫 원칙(「귀속 근거를 지울 수 있는 길을 열지 않는다」 · DS 53-3)과 정반대다.
   *
   * 지금 가지고 있는 귀속을 **그대로 들고 오면** 통과시킨다(바뀌는 것이 없으므로 이력도
   * 늘지 않는다). 다른 파트너로 **옮기려** 할 때만 그 파트너가 있는지 본다 — 없는 곳으로
   * 옮기는 길은 종전처럼 막는다.
   */
  const keepingAttribution = Boolean(existing && partnerId && existing.partnerId === partnerId);
  if (partnerId && !keepingAttribution && !partners.some((p) => p.id === partnerId)) {
    return { ok: false, error: '존재하지 않는 파트너입니다. 파트너를 먼저 등록해 주세요.' };
  }

  const source: LeadSource = isLeadSource(input.source) ? input.source : partnerId ? 'partner' : 'unknown';
  if (source === 'partner' && !partnerId) {
    return { ok: false, error: '유입 경로가 "파트너 유치"이면 파트너를 지정해야 합니다.' };
  }

  const contractedAt = clean(input.contractedAt, 10);
  if (contractedAt && !isValidDate(contractedAt)) {
    return { ok: false, error: '계약일은 2026-09-01 처럼 연-월-일로 적어주세요.' };
  }

  const fee = parseMonthlyFee(input.monthlyFeeKrw);
  if (!fee.ok) return { ok: false, error: fee.error };

  const status: AccountStatus =
    input.status === 'contracted' || input.status === 'churned' ? input.status : 'prospect';
  if (status === 'contracted' && !contractedAt) {
    return { ok: false, error: '계약 상태로 두려면 계약일이 필요합니다(정산 귀속의 기준일).' };
  }

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
  /** 이름 부분 일치(대소문자·공백·문장부호·유니코드 표기 차이 무시 — `@/lib/normalize` 의 `compact`) */
  q?: string;
}

export function queryAccounts(filter: AccountQuery = {}): Account[] {
  // 「같은 말인가」는 저장소에 자가 하나다(DS 42-1) — 여기에 따로 적어 두었던 자는
  // 문장부호와 분해형 한글을 다른 글자로 봐서 「(주)고원」을 「주고원」으로 찾지 못했다.
  const q = compact(filter.q ?? '');
  return accounts
    .filter((a) => {
      if (filter.partnerId === 'direct' && a.partnerId !== null) return false;
      if (filter.partnerId && filter.partnerId !== 'direct' && a.partnerId !== filter.partnerId) return false;
      if (filter.status && a.status !== filter.status) return false;
      if (filter.source && a.source !== filter.source) return false;
      if (q && !compact(a.name).includes(q)) return false;
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
    let row = rows.find((r) => r.partnerId === a.partnerId);
    if (!row) {
      /**
       * 가리키는 파트너를 찾을 수 없는 고객사 — **떨어뜨리지 않는다** (DS 53-3).
       *
       * 종전에는 `continue` 로 넘겼다. 그래서 그 고객사는 어느 줄에도 들어가지 않고, 파트너별
       * 집계의 합이 고객사 수와 **조용히 어긋났다**(화면은 어긋난 줄 모른다). `deletePartner`
       * 가 연결된 고객사가 있는 파트너의 삭제를 막으므로 평소에는 생기지 않지만, 저장분을
       * 되돌리는 길로는 들어온다 — 그 길에서 귀속을 지우지 않게 되었으므로(`importPartners`)
       * 여기도 그 사실을 **보여 주는 쪽**으로 둔다.
       */
      row = {
        partnerId: a.partnerId,
        partnerName: a.partnerId ? missingPartnerName(a.partnerId) : '직접 계약',
        feeRateBp: null,
        total: 0,
        contracted: 0,
        prospect: 0,
        churned: 0,
      };
      rows.push(row);
    }
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

/**
 * 방금 한 변경이 **서버에 보관되었는가** (DS 47-1) — 「등록했습니다」라고 답하기 전에 지난다.
 */
export function savePartnersNow(): SavedInfo {
  return savedInfo(saveNow(PARTNERS_NS));
}

export type PartnerImportResult =
  /** `saved` 는 **쓰기를 시도한 복원**에만 있다(기동 때의 읽어 들이기에는 없다). */
  | {
      ok: true;
      partners: number;
      accounts: number;
      /**
       * 귀속이 가리키는 파트너를 이 저장분에서 찾을 수 없는 고객사 수 (DS 53-3).
       * 0 이 아니면 **복원 결과를 그대로 믿을 수 없다**는 뜻이므로 부르는 쪽이 말해야 한다 —
       * 종전에는 그 건들을 직접 계약으로 바꿔 두고 아무 말도 하지 않았다.
       */
      orphans: number;
      /**
       * 같은 id 가 두 번 이상 적혀 **건너뛴** 항목 수(파트너 + 고객사) (DS 55-3).
       * 0 이 아니면 들어온 파일이 성한 스냅샷이 아니라는 뜻이다 — `orphans` 와 같은 이유로 말한다.
       */
      duplicates: number;
      saved?: SavedInfo;
    }
  | { ok: false; error: string };

/**
 * 스냅샷 복원. 형식이 어긋난 항목은 건너뛰고 개수를 돌려준다.
 *
 * **복원한 것을 디스크에 적는다** (DS 47-1). 종전에는 메모리만 갈아 끼우고 쓰기를 한 번도
 * 부르지 않았다 — 관리 콘텐츠 쪽(`importSnapshot`)은 적는데 이쪽만 빠져 있었다. 그래서 복원
 * 직후 서비스가 다시 뜨면 **파트너·고객사만 복원 전으로 돌아갔다**(안내 자료·규칙은 그대로다).
 * 화면은 「복원 완료: … 파트너 n · 고객사 n」이라고 수까지 세어 말한 뒤였다.
 *
 * 기동 때의 읽어 들이기는 `persist: false` 로 부른다 — 방금 읽은 것을 되쓰지 않는다.
 */
export function importPartners(input: unknown, opts: { persist?: boolean } = {}): PartnerImportResult {
  if (!input || typeof input !== 'object') return { ok: false, error: RESTORE_FORMAT_MESSAGE };
  const snap = input as Partial<PartnerSnapshot>;
  if (!Array.isArray(snap.partners) || !Array.isArray(snap.accounts)) {
    return { ok: false, error: RESTORE_FORMAT_MESSAGE };
  }

  /**
   * 같은 id 가 두 번 적힌 저장분에서 **먼저 나온 것만** 쓴다 (DS 55-3).
   *
   * 왜 세는가: `id` 는 이 저장소에서 그 항목이 **누구인가**다. 둘을 다 들이면 고치는 자
   * (`upsertAccount`)는 앞의 것만 고치고 지우는 자는 앞의 것만 지운다 — 뒤의 것은 손이
   * 닿지 않는 자리에 남아 집계에만 실린다. 돌려서 확인했다: 같은 고객사가 두 번 적힌
   * 파일을 되돌리면 정산 리포트가 **수수료를 두 배로** 적고(15만 원 → 30만 원)
   * 「일부 미산출」 경고도 붙지 않는다(`partial: false`) — 근거가 다 갖춰진 행 둘이기
   * 때문이다. §13 이 금한 「없는 수」가 하필 돈 칸에 선다.
   * 먼저 나온 것을 남기는 것은 `parsePartnerTokens` 와 같은 규칙이다(설정 실수가 범위를
   * 넓히지 않게). 건너뛴 수는 **돌려준다** — 말하지 않으면 「복원 완료」가 거짓이 된다.
   */
  let duplicates = 0;
  const nextPartners: Partner[] = [];
  const ids = new Set<string>();
  for (const p of snap.partners) {
    if (!p || typeof p !== 'object') continue;
    const { id, name } = p as Partner;
    if (typeof id !== 'string' || !id.trim() || typeof name !== 'string' || !name.trim()) continue;
    const pid = id.trim();
    if (ids.has(pid)) { duplicates += 1; continue; }
    ids.add(pid);
    const fee = (p as Partner).feeRateBp;
    nextPartners.push({
      id: pid,
      name: name.trim().slice(0, MAX_NAME),
      status: (p as Partner).status === 'paused' ? 'paused' : 'active',
      feeRateBp: typeof fee === 'number' && Number.isFinite(fee) && fee >= 0 && fee <= 10000 ? Math.round(fee) : null,
      managerName: clean((p as Partner).managerName, MAX_NAME) || undefined,
      memo: clean((p as Partner).memo, MAX_MEMO) || undefined,
      // 시각은 「읽을 수 있는가」를 한 곳에서 가린 뒤 ISO 한 모양으로 적는다 (DS 54-3·55-3).
      // 종전 식(`typeof x === 'string'`)은 `"어제"` 는 물론 **빈 문자열**까지 통과시켰다.
      createdAt: readInstant((p as Partner).createdAt, now()),
      updatedAt: readInstant((p as Partner).updatedAt, now()),
    });
  }

  const nextAccounts: Account[] = [];
  const accountIds = new Set<string>();
  /** 귀속이 가리키는 파트너를 이 저장분에서 찾을 수 없는 고객사 수 — 조용히 넘기지 않는다 (DS 53-3). */
  let orphans = 0;
  for (const a of snap.accounts) {
    if (!a || typeof a !== 'object') continue;
    const { id, name } = a as Account;
    if (typeof id !== 'string' || !id.trim() || typeof name !== 'string' || !name.trim()) continue;
    const aid = id.trim();
    if (accountIds.has(aid)) { duplicates += 1; continue; }
    accountIds.add(aid);
    const rawPid = (a as Account).partnerId;
    /**
     * **귀속은 지우지 않는다** (DS 53-3). 가리키는 파트너가 이 저장분에 없더라도 그대로 들고 온다.
     *
     * 종전에는 「고아 귀속 방지」라며 `null`(직접 계약)로 되돌렸다. 그런데 이 파일의 첫 원칙이
     * 「귀속 변경은 append-only 이력으로 남긴다 — 값만 바꾸면 근거가 사라진다」이고, 그 되돌림은
     * 이력을 한 줄도 남기지 않았다. 돌려서 확인했다: 파트너 한 건의 이름이 빈 저장분(그 한 건은
     * 건너뛴다)을 되돌리면 그 파트너의 고객사가 **직접 계약**이 되고, 정작 그 고객사의
     * `attribution` 은 여전히 `toPartnerId: 'PTR-0001'` 이라고 적고 있다 — 값과 근거가 서로
     * 다른 말을 하는 기록이다. 그리고 그 결과는 디스크에 그대로 적힌다(`saveJson`).
     *
     * 더 나쁜 것은 **정산 리포트가 그 거짓을 완전한 수로 말한다**는 것이다: 「직접 계약 1건은
     * 파트너 정산 대상이 아니라 제외했습니다」 + `partial: false`. 파트너의 수수료가 아무 경고
     * 없이 사라지고, 그 자리에는 사실이 아닌 문장이 남는다(§13 · 정산 분쟁이 생기는 바로 그 칸).
     *
     * 귀속을 그대로 두면 아래쪽이 이미 그 사실을 말할 수 있게 적혀 있다 — 리포트는
     * `(삭제된 파트너 PTR-0001)` 줄을 세우고 「수수료율 미설정」으로 합계에서 빼며 `partial: true`
     * 를 켠다(운영자가 어느 고객사인지·왜 빠졌는지 본다). `deletePartner` 가 연결된 고객사가
     * 있는 파트너의 삭제를 막는 것과 같은 판단이다: 근거를 지울 수 있는 길을 열지 않는다.
     */
    const partnerId = typeof rawPid === 'string' && rawPid.trim() ? rawPid.trim().slice(0, 40) : null;
    if (partnerId && !ids.has(partnerId)) orphans += 1;
    const src = (a as Account).source;
    const st = (a as Account).status;
    const ca = (a as Account).contractedAt;
    const history = Array.isArray((a as Account).attribution) ? (a as Account).attribution : [];
    nextAccounts.push({
      id: aid,
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
      /**
       * 귀속 근거는 **시각을 읽지 못했다고 버리지 않는다** (DS 54-3·55-3).
       *
       * 종전 거르개(`typeof e.at === 'string'`)는 두 쪽으로 틀렸다: 시각이 글자가 아닌 줄
       * (`at: 12345`)은 **통째로 사라졌고** — 이 파일의 첫 원칙이 「귀속 변경은 append-only
       * 이력으로 남긴다, 값만 바꾸면 근거가 사라진다」인데 복원이 그 근거를 지웠다 —
       * 빈 문자열은 그대로 통과해 화면의 날짜 칸을 빈 칸으로 만들고 정렬을 흔들었다.
       * 지금은 줄을 그대로 들고 오고, 읽을 수 없는 시각에만 「읽어 들인 지금」을 적는다
       * (적을 수 없는 시각을 지어내지 않는다는 뜻이다 · DS 54-3 과 같은 판단).
       */
      attribution: history
        .filter((e) => e && typeof e === 'object')
        .slice(-MAX_ATTRIBUTION)
        .map((e) => ({
          at: readInstant(e.at, now()),
          fromPartnerId: typeof e.fromPartnerId === 'string' ? e.fromPartnerId : null,
          toPartnerId: typeof e.toPartnerId === 'string' ? e.toPartnerId : null,
          source: isLeadSource(e.source) ? e.source : 'unknown',
          note: clean(e.note, MAX_MEMO),
          authed: e.authed === true,
        })),
      createdAt: readInstant((a as Account).createdAt, now()),
      updatedAt: readInstant((a as Account).updatedAt, now()),
    });
  }

  // 일련번호는 **건너뛴 항목의 id까지** 포함해 계산한다.
  // 무효라서 복원되지 않은 id를 재사용하면, 원본 시스템의 다른 기록과 id가 충돌한다.
  const rawId = (v: unknown): string => (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' ? (v as { id: string }).id : '');
  partners = nextPartners;
  accounts = nextAccounts;
  partnerSeq = Math.max(numTail(snap.partners.map(rawId)), Number(snap.partnerSeq) || 0);
  accountSeq = Math.max(numTail(snap.accounts.map(rawId)), Number(snap.accountSeq) || 0);
  const saved = opts.persist === false ? undefined : savedInfo(saveJson(PARTNERS_NS, exportPartners()));
  return { ok: true, partners: partners.length, accounts: accounts.length, orphans, duplicates, ...(saved ? { saved } : {}) };
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
  // 방금 읽은 것을 되쓰지 않는다 — 기동마다 같은 내용으로 디스크를 건드리면 안 된다.
  importPartners(r.data, { persist: false });
})();
