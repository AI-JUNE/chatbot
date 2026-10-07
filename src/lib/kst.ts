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
// 저장하는 **시각**은 그대로 ISO(UTC)를 쓴다 — 이 모듈은 "달력 날짜"만 다룬다.

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
