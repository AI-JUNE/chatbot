// 한국 시간(KST) 달력 — "며칠인가"를 묻는 모든 곳의 단일 출처.
//
// 왜 따로 두는가: 이 제품의 사용자는 한국에 있고(고객·운영자 모두), 서버는 한국에 없다.
// Vercel 의 Node 런타임은 TZ 를 UTC 로 두고 돌아가므로 `new Date().getDate()` 는
// **KST 자정~오전 9시 사이에 어제** 를 돌려준다. 그 아홉 시간 동안
//  - 고객이 "오늘 3시"라고 말하면 어제로 예약되고,
//  - 운영자가 내려받은 파일 이름에 하루 전 날짜가 붙고,
//  - 정산 기준월 기본값이 지난달로 뜬다.
// 시간대를 적지 않으면 "며칠인가"의 답이 배포 환경에 따라 달라진다 — 그래서 여기서 고정한다.
//
// 구현: 한국은 1988년 이후 일광절약시간(DST)이 없다. 고정 오프셋 +09:00 으로 옮긴 뒤
// UTC 게터로 읽으면 Intl 없이도 정확하다(브라우저·서버·테스트가 같은 값을 낸다).
// 저장하는 **시각**은 그대로 ISO(UTC)를 쓴다 — 바꾸는 것은 **사람에게 보여 줄 때**뿐이다
// (`kstDateTime` · DS 40-1).

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export interface KstYmd {
  y: number;
  /** 1~12 */
  m: number;
  /** 1~31 */
  d: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 한국 시간 기준 연·월·일. */
export function kstYmd(at: Date = new Date()): KstYmd {
  const d = new Date(at.getTime() + KST_OFFSET_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

/** 'YYYY-MM-DD' 로 적는다. */
export function ymdToString(v: KstYmd): string {
  return `${v.y}-${pad2(v.m)}-${pad2(v.d)}`;
}

/**
 * 달력 계산용 정규화 — 달을 넘는 일수를 실제 날짜로 넘긴다(2월 31일 → 3월 3일, +1일 등).
 * 시간대에 걸리지 않게 UTC 달력으로만 계산한다.
 */
export function normalizeYmd(y: number, m: number, d: number): KstYmd {
  const t = new Date(Date.UTC(y, m - 1, d));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** 두 날짜의 앞뒤 비교(음수면 a 가 먼저). */
export function compareYmd(a: KstYmd, b: KstYmd): number {
  return a.y !== b.y ? a.y - b.y : a.m !== b.m ? a.m - b.m : a.d - b.d;
}

/** 한국 시간 기준 오늘 날짜 'YYYY-MM-DD'. */
export function kstDate(at: Date = new Date()): string {
  return ymdToString(kstYmd(at));
}

/**
 * 한국 시간 기준 지금의 시·분. 「이미 지난 때인가」를 재는 자리에서 쓴다 —
 * 날짜만으로는 **오늘의 지난 시각**(오후 3시에 말한 「오늘 오전 9시」)을 가려낼 수 없다.
 */
export function kstHm(at: Date = new Date()): { h: number; mi: number } {
  const d = new Date(at.getTime() + KST_OFFSET_MS);
  return { h: d.getUTCHours(), mi: d.getUTCMinutes() };
}

/** 한국 시간 기준 지금 시각 'HH:MM'. 같은 형식끼리 글자 비교로 앞뒤를 가릴 수 있다. */
export function kstTime(at: Date = new Date()): string {
  const v = kstHm(at);
  return `${pad2(v.h)}:${pad2(v.mi)}`;
}

/** 한국 시간 기준 이번 달 'YYYY-MM'. */
export function kstMonth(at: Date = new Date()): string {
  const v = kstYmd(at);
  return `${v.y}-${pad2(v.m)}`;
}

/** 내려받는 파일 이름에 붙이는 한국 날짜 'YYYYMMDD'. */
export function kstStamp(at: Date = new Date()): string {
  const v = kstYmd(at);
  return `${v.y}${pad2(v.m)}${pad2(v.d)}`;
}

/**
 * **사람이 읽는 시각** 'YYYY-MM-DD HH:MM:SS'(한국 시간) — 내려받는 파일의 시각 칸 (DS 40-1).
 *
 * 왜 필요한가: 기록의 `at` 은 ISO(UTC)다. 운영 화면은 브라우저 시간대로 옮겨 그리고
 * 파일 **이름**도 `kstStamp` 로 한국 날짜를 붙이는데, 정작 파일 **안의 행**만 UTC 원문이었다.
 * 한국 자정~오전 9시의 대화는 엑셀에서 **전날**로 분류되어, 같은 데이터가 화면과 파일에서
 * 다른 날에 속했다(대시보드 「오늘 대화」는 `kstDate` 로 센다).
 *
 * 시간대 표기(`+09:00`)를 붙이지 않는 것은 엑셀이 그 형태를 날짜로 읽지 못하기 때문이다 —
 * 대신 기준이 한국 시간이라는 사실을 파일 꼬리 주석이 말하고, 기계가 보는 원문은
 * 「시각(ISO)」 열에 그대로 남긴다(`주제`·`주제코드` 와 같은 규칙).
 *
 * 읽을 수 없는 값(빈 문자열·깨진 ISO)에는 **지금 시각을 지어내지 않고** 빈 문자열을 돌려준다.
 */
export function kstDateTime(at: Date | string | number): string {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const v = new Date(d.getTime() + KST_OFFSET_MS);
  return (
    `${v.getUTCFullYear()}-${pad2(v.getUTCMonth() + 1)}-${pad2(v.getUTCDate())}` +
    ` ${pad2(v.getUTCHours())}:${pad2(v.getUTCMinutes())}:${pad2(v.getUTCSeconds())}`
  );
}

/**
 * **읽을 수 있는 시각인가** — 복원이 받아 적을 수 있는 값의 경계 (DS 54-3).
 *
 * 왜 필요한가: 저장분을 읽어 들이는 문들은 시각 칸을 「문자열이고 비어 있지 않은가」로만 보았다
 * (`typeof t.at === 'string' && t.at ? t.at : 지금`). 그래서 `"어제"` 한 글자도 그대로 들어와
 * **시각인 척하는 글자**가 기록에 박혔고, 그 글자를 시각으로 믿는 자들이 전부 조용히 어긋났다:
 *  - 보관 경계(`knownFrom`)가 그 글자가 되고, 그 경계로 「기록 없음」을 가리는 대시보드는
 *    **이레 전부를 「기록 있음」**으로 보았다 — 0건이라고 그려 놓고 0건이 아니라고 말하지 않는다
 *    (DS 43-1 이 세운 약속이 복원 한 번으로 뒤집힌다)
 *  - 내려받은 파일의 「시각」 칸이 **빈 칸**이 되고(`kstDateTime` 은 지어내지 않는다), 꼬리 주석은
 *    「 이후의 기록만 담겨 있습니다」로 시작하는 문장이 된다
 *  - 합칠 때 글자 비교로 앞뒤를 가리는 자리(`mergeAudit`)가 그 줄을 아무 데나 세운다
 */
export function isReadableInstant(v: unknown): v is string {
  if (typeof v !== 'string' || !v.trim()) return false;
  return !Number.isNaN(new Date(v).getTime());
}

/**
 * 복원이 받아 적는 시각 — 읽을 수 없으면 **대신할 값**을 쓴다 (DS 54-3).
 *
 * 읽을 수 있으면 ISO(UTC) 한 모양으로 적는다 — 「같은 형식끼리 글자 비교로 앞뒤를 가린다」가
 * 실제로 참이 되게 하기 위해서다(`kstTime` 주석과 같은 규칙). 같은 시각을 다른 글자로 적어 둔
 * 저장분이 들어와도 두 쪽이 같은 모양이 되므로, 내용 전체로 같은 건인지 가리는 자리
 * (`audit.identityOf`)도 복원·합치기를 몇 번 지나든 같은 답을 낸다.
 *
 * 읽을 수 없는 값은 **버리지 않는다** — 기록 한 줄은 「누가 무엇을 했는가」의 증거이고, 시각을
 * 읽지 못한다고 증거를 지우는 쪽이 더 나쁘다. 적을 수 없는 시각을 지어내지 않는다는 뜻으로
 * 부르는 쪽이 「읽어 들인 지금」을 넘긴다(빠진 값에 종전부터 쓰던 그 값이다).
 */
export function readInstant(v: unknown, fallback: string): string {
  return isReadableInstant(v) ? new Date(v).toISOString() : fallback;
}

/**
 * 내려받는 파일의 꼬리에 적는 시각 기준 안내 — 대화 기록·변경 이력이 같은 문장을 쓴다.
 * 파일이 제 시각 기준을 말하지 않으면 받는 사람은 9시간 어긋난 줄 모른 채 그 열로 거른다.
 */
export const KST_CSV_NOTE =
  '시각은 한국 시간(KST, UTC+9) 기준입니다. 「시각(ISO)」 열은 시간대를 포함한 원문(UTC)입니다.';
