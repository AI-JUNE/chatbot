// 답변 평가(👍/👎) 저장소 — 인메모리 링버퍼.
// 목적: "이 답변이 도움이 됐는가"를 사용자가 알려줄 수 있게 하고, 운영자가 개선 대상 FAQ를 찾게 한다.
//
// 개인정보 원칙
// - 사용자가 입력한 문장은 저장하지 않는다. 저장하는 것은 (1) 평가값 (2) 서버가 만든 근거 라벨
//   (예: "이음 FAQ 3. 활동 시간") (3) 세션 해시뿐이다.
// - 세션 해시는 라우트에서 만들어 넘긴다(원문 세션ID는 이 모듈에 들어오지 않는다).
// [승인 필요] 영구 저장·외부 분석 파이프라인 전송.

export type Verdict = 'up' | 'down';

export interface FeedbackEntry {
  id: string;
  /** 세션 식별자의 해시(원문 복원 불가). */
  sessionHash: string;
  verdict: Verdict;
  /** 평가 대상 답변의 근거 라벨. 근거 없이 답한 경우 빈 문자열. */
  citation: string;
  /** 대화 채널 — 현재 web만 사용. */
  channel: string;
  at: string;
}

export interface FeedbackSummary {
  total: number;
  up: number;
  down: number;
  /** 도움됨 비율(%). 평가가 0건이면 null — 화면에서 「측정 중」으로 표시한다. */
  helpfulRate: number | null;
  /** 👎가 많은 근거 순 상위 목록(개선 대상). */
  topDown: { citation: string; down: number }[];
}

const MAX_ENTRIES = 500;
const MAX_CITATION_LEN = 120;

let entries: FeedbackEntry[] = [];
let seq = 0;

export function isVerdict(v: unknown): v is Verdict {
  return v === 'up' || v === 'down';
}

/** 잘못된 입력은 조용히 버리지 않고 사유를 돌려준다(라우트가 400으로 바꾼다). */
export function recordFeedback(input: {
  sessionHash: unknown;
  verdict: unknown;
  citation?: unknown;
  channel?: unknown;
}): { ok: true; entry: FeedbackEntry } | { ok: false; error: string } {
  if (!isVerdict(input.verdict)) return { ok: false, error: 'verdict는 up 또는 down이어야 합니다.' };
  if (typeof input.sessionHash !== 'string' || !input.sessionHash) {
    return { ok: false, error: 'sessionHash가 필요합니다.' };
  }
  const citation = typeof input.citation === 'string' ? input.citation.slice(0, MAX_CITATION_LEN) : '';
  const channel = typeof input.channel === 'string' && input.channel ? input.channel : 'web';
  seq += 1;
  const entry: FeedbackEntry = {
    id: `F-${String(seq).padStart(6, '0')}`,
    sessionHash: input.sessionHash.slice(0, 32),
    verdict: input.verdict,
    citation,
    channel,
    at: new Date().toISOString(),
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  return { ok: true, entry };
}

export function listFeedback(limit = 100): FeedbackEntry[] {
  const n = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), MAX_ENTRIES) : 100;
  return entries.slice(-n).reverse().map((e) => ({ ...e }));
}

export function feedbackSummary(): FeedbackSummary {
  let up = 0;
  let down = 0;
  const downBy = new Map<string, number>();
  for (const e of entries) {
    if (e.verdict === 'up') up += 1;
    else {
      down += 1;
      const key = e.citation || '근거 없음';
      downBy.set(key, (downBy.get(key) ?? 0) + 1);
    }
  }
  const total = up + down;
  const topDown = [...downBy.entries()]
    .map(([citation, d]) => ({ citation, down: d }))
    .sort((a, b) => b.down - a.down || a.citation.localeCompare(b.citation))
    .slice(0, 5);
  return { total, up, down, helpfulRate: total === 0 ? null : Math.round((up / total) * 100), topDown };
}

/** 테스트·운영 점검용 초기화. */
export function resetFeedback(): void {
  entries = [];
  seq = 0;
}
