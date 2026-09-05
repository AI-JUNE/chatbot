// 파트너 정산 리포트 — "이 달에 누구에게 얼마를, 왜 주는가"의 근거를 만든다.
//
// 신뢰 원칙(이 파일에서 절대 어기지 않는 것)
// - **없는 숫자를 만들지 않는다.** 월 이용료는 사람이 계약서를 보고 입력한 값만 쓰고,
//   수수료율은 파트너 설정 또는 환경변수(PARTNER_DEFAULT_FEE_RATE_BP)에서만 온다.
//   둘 중 하나라도 없으면 그 행은 `incomplete`로 표시하고 **합계에서 뺀다**(0으로 치지 않는다).
// - 합계가 일부만 반영됐으면 `partial: true` 와 사유를 함께 돌려준다.
//   화면·CSV는 이 값을 그대로 보여 준다 — "그럴듯한 총액"이 실제 총액인 척하지 않게.
// - 이 리포트는 **청구서가 아니다**. 실제 청구·지급은 계약서 확정 후 [승인 필요].
import {
  getPartner,
  isValidDate,
  queryAccounts,
  effectiveFeeRateBp,
  defaultFeeRateBp,
  type Account,
  type AccountQuery,
} from '@/lib/partners';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isValidMonth(v: string): boolean {
  return MONTH_RE.test(v);
}

/** 'YYYY-MM' → 그 달의 마지막 날짜 'YYYY-MM-DD'. */
export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, '0')}`;
}

/** 현재 달(UTC 기준 'YYYY-MM'). 화면 기본값으로만 쓴다. */
export function currentMonth(at: Date = new Date()): string {
  return at.toISOString().slice(0, 7);
}

export type SettlementIssue = 'none' | 'no_fee_rate' | 'no_base_amount' | 'no_fee_rate_and_base';

export const SETTLEMENT_ISSUE_LABELS: Record<SettlementIssue, string> = {
  none: '',
  no_fee_rate: '수수료율 미설정',
  no_base_amount: '월 이용료 미입력',
  no_fee_rate_and_base: '월 이용료·수수료율 미설정',
};

export interface SettlementRow {
  partnerId: string;
  partnerName: string;
  accountId: string;
  accountName: string;
  contractedAt: string;
  /** 산정 기준 금액(월 이용료, 원). 미입력이면 null. */
  baseAmountKrw: number | null;
  feeRateBp: number | null;
  /** 수수료(원, 원 단위 절사). 근거가 부족하면 null. */
  feeAmountKrw: number | null;
  issue: SettlementIssue;
}

export interface SettlementPartnerTotal {
  partnerId: string;
  partnerName: string;
  accounts: number;
  /** 금액 산출이 가능한(=근거가 갖춰진) 고객사 수 */
  billable: number;
  baseAmountKrw: number;
  feeAmountKrw: number;
  /** 근거가 부족해 합계에서 빠진 고객사 수 */
  incomplete: number;
}

export interface SettlementReport {
  month: string;
  periodStart: string;
  periodEnd: string;
  rows: SettlementRow[];
  partnerTotals: SettlementPartnerTotal[];
  totals: {
    accounts: number;
    billable: number;
    incomplete: number;
    baseAmountKrw: number;
    feeAmountKrw: number;
    /** 근거가 부족한 행이 있어 합계가 일부만 반영됐는가 */
    partial: boolean;
  };
  /** 산출 근거·한계를 사람이 읽는 문장으로. 화면과 CSV에 그대로 싣는다. */
  notes: string[];
  defaultFeeRateBp: number | null;
}

export interface SettlementInput {
  month: string;
  /** 조회 범위 필터. RBAC 스코프가 이미 씌워진 값을 받는다. */
  filter?: AccountQuery;
  /** 테스트·재현용 주입(미지정 시 저장소에서 읽는다). */
  accounts?: Account[];
}

/**
 * 기간 내 정산 대상 판정.
 * 대상 = 계약 상태(`contracted`) + 계약일이 있고 기간 말일 이전.
 * 해지(`churned`)는 제외한다 — 다만 **해지일을 기록하지 않으므로** 기간 중 해지분은
 * 현재 상태 기준으로 빠진다. 이 한계를 notes에 명시한다(숨기지 않는다).
 */
function eligible(a: Account, periodEnd: string): boolean {
  if (a.status !== 'contracted') return false;
  if (!a.contractedAt || !isValidDate(a.contractedAt)) return false;
  return a.contractedAt <= periodEnd;
}

export type SettlementResult = { ok: true; report: SettlementReport } | { ok: false; error: string };

export function buildSettlement(input: SettlementInput): SettlementResult {
  const month = String(input.month ?? '').trim();
  if (!isValidMonth(month)) {
    return { ok: false, error: '정산 기준월은 YYYY-MM 형식이어야 합니다. (예: 2026-09)' };
  }
  const periodStart = `${month}-01`;
  const periodEnd = monthEnd(month);

  const all = input.accounts ?? queryAccounts(input.filter ?? {});
  const rows: SettlementRow[] = [];
  const totalsByPartner = new Map<string, SettlementPartnerTotal>();

  let directExcluded = 0;
  let notYetContracted = 0;

  for (const a of all) {
    if (a.partnerId === null) {
      if (eligible(a, periodEnd)) directExcluded += 1;
      continue;
    }
    if (!eligible(a, periodEnd)) {
      notYetContracted += 1;
      continue;
    }

    const partner = getPartner(a.partnerId);
    const partnerName = partner ? partner.name : `(삭제된 파트너 ${a.partnerId})`;
    const feeRateBp = partner ? effectiveFeeRateBp(partner) : null;
    const baseAmountKrw = typeof a.monthlyFeeKrw === 'number' ? a.monthlyFeeKrw : null;

    const missingBase = baseAmountKrw === null;
    const missingRate = feeRateBp === null;
    const issue: SettlementIssue = missingBase && missingRate
      ? 'no_fee_rate_and_base'
      : missingBase
        ? 'no_base_amount'
        : missingRate
          ? 'no_fee_rate'
          : 'none';

    // 원 단위 절사 — 반올림으로 파트너에게 유리하게 부풀리지 않는다.
    const feeAmountKrw = issue === 'none' ? Math.floor((baseAmountKrw as number) * (feeRateBp as number) / 10000) : null;

    rows.push({
      partnerId: a.partnerId,
      partnerName,
      accountId: a.id,
      accountName: a.name,
      contractedAt: a.contractedAt as string,
      baseAmountKrw,
      feeRateBp,
      feeAmountKrw,
      issue,
    });

    const t = totalsByPartner.get(a.partnerId) ?? {
      partnerId: a.partnerId,
      partnerName,
      accounts: 0,
      billable: 0,
      baseAmountKrw: 0,
      feeAmountKrw: 0,
      incomplete: 0,
    };
    t.accounts += 1;
    if (issue === 'none') {
      t.billable += 1;
      t.baseAmountKrw += baseAmountKrw as number;
      t.feeAmountKrw += feeAmountKrw as number;
    } else {
      t.incomplete += 1;
    }
    totalsByPartner.set(a.partnerId, t);
  }

  rows.sort((x, y) =>
    x.partnerName === y.partnerName ? x.accountId.localeCompare(y.accountId) : x.partnerName.localeCompare(y.partnerName, 'ko'),
  );
  const partnerTotals = [...totalsByPartner.values()].sort((x, y) => x.partnerName.localeCompare(y.partnerName, 'ko'));

  const billable = partnerTotals.reduce((s, t) => s + t.billable, 0);
  const incomplete = partnerTotals.reduce((s, t) => s + t.incomplete, 0);

  const notes: string[] = [
    `대상 판정: 계약 상태이고 계약일이 ${periodEnd} 이전인 고객사.`,
    '수수료 = 월 이용료 × 수수료율(bp) ÷ 10000, 원 단위 절사.',
    '해지일을 별도로 기록하지 않으므로, 기간 중 해지된 고객사는 현재 상태 기준으로 제외됩니다.',
  ];
  if (incomplete > 0) {
    notes.push(`${incomplete}개 고객사는 월 이용료 또는 수수료율이 없어 합계에서 제외했습니다(0원으로 계산하지 않았습니다).`);
  }
  if (directExcluded > 0) {
    notes.push(`직접 계약 ${directExcluded}건은 파트너 정산 대상이 아니라 제외했습니다.`);
  }
  if (notYetContracted > 0) {
    notes.push(`파트너 귀속이지만 아직 계약 상태가 아니거나 계약일이 기간 이후인 ${notYetContracted}건은 제외했습니다.`);
  }
  notes.push('이 리포트는 산출 근거 자료이며 청구서가 아닙니다. 실제 청구·지급은 계약서 확정 후 승인이 필요합니다.');

  return {
    ok: true,
    report: {
      month,
      periodStart,
      periodEnd,
      rows,
      partnerTotals,
      totals: {
        accounts: rows.length,
        billable,
        incomplete,
        baseAmountKrw: partnerTotals.reduce((s, t) => s + t.baseAmountKrw, 0),
        feeAmountKrw: partnerTotals.reduce((s, t) => s + t.feeAmountKrw, 0),
        partial: incomplete > 0,
      },
      notes,
      defaultFeeRateBp: defaultFeeRateBp(),
    },
  };
}

function csvCell(v: string | number | null): string {
  if (v === null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 정산 CSV. 미확정 값은 **빈 칸**으로 두고 사유 열을 함께 낸다 — 0으로 채우면
 * 받는 쪽에서 "0원 청구"로 읽힌다. 엑셀 호환 BOM은 라우트에서 붙인다.
 */
export function settlementToCsv(report: SettlementReport): string {
  const header = ['기준월', '파트너ID', '파트너명', '고객사ID', '고객사명', '계약일', '월이용료(원)', '수수료율(bp)', '수수료(원)', '비고'];
  const lines = [header.map(csvCell).join(',')];
  for (const r of report.rows) {
    lines.push(
      [
        report.month,
        r.partnerId,
        r.partnerName,
        r.accountId,
        r.accountName,
        r.contractedAt,
        r.baseAmountKrw,
        r.feeRateBp,
        r.feeAmountKrw,
        SETTLEMENT_ISSUE_LABELS[r.issue],
      ]
        .map(csvCell)
        .join(','),
    );
  }
  lines.push('');
  lines.push(['합계', '', '', '', `대상 ${report.totals.accounts}건 / 산출 ${report.totals.billable}건`, '', report.totals.baseAmountKrw, '', report.totals.feeAmountKrw, report.totals.partial ? '일부 미산출 — 아래 주석 참고' : ''].map(csvCell).join(','));
  lines.push('');
  for (const n of report.notes) lines.push(csvCell(`# ${n}`));
  return lines.join('\r\n');
}
