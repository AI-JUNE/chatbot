// 답변 평가(👍/👎) 저장소 — 인메모리 링버퍼 + 영속화 어댑터 연결.
// 목적: "이 답변이 도움이 됐는가"를 사용자가 알려줄 수 있게 하고, 운영자가 개선 대상 FAQ를 찾게 한다.
//
// 개인정보 원칙
// - 사용자가 입력한 문장은 저장하지 않는다. 저장하는 것은 (1) 평가값 (2) 서버가 만든 근거 라벨
//   (예: "이음 FAQ 3. 활동 시간") (3) 세션 해시뿐이다.
// - 세션 해시는 라우트에서 만들어 넘긴다(원문 세션ID는 이 모듈에 들어오지 않는다).
// [승인 필요] 외부 분석 파이프라인 전송.
//
// 영속화(DS 32-1): 개인정보가 없으므로 감사 로그와 같은 등급이다(`pii:false`) — 승인 게이트 없이
// 저장한다. 종전에는 이 모듈만 `scheduleSave` 를 부르지 않아 **배포가 한 번 재시작되면 평가가
// 통째로 사라졌고**, 「저장소 상태」 카드에도 뜨지 않아 운영자는 사라진 줄도 몰랐다.

import { loadJson, scheduleSave } from '@/lib/storage';
import { RESTORE_FORMAT_MESSAGE } from '@/lib/refusal';

export type Verdict = 'up' | 'down';

export interface FeedbackEntry {
  id: string;
  /** 세션 식별자의 해시(원문 복원 불가). */
  sessionHash: string;
  verdict: Verdict;
  /** 평가 대상 답변의 근거 라벨. 근거 없이 답한 경우 빈 문자열. */
  citation: string;
  /**
   * **어느 자료에 대한 평가인가** — 안내 자료 id (DS 43-2).
   *
   * 종전에는 `citation`(근거 라벨) 하나뿐이었다. 그 라벨은 **바뀌는 이름**이다
   * (`buildCitation` → `entry.source || entry.question`). 그래서 세 가지가 어긋났다:
   *  ① 문서 하나를 붙여 넣어 만든 항목들은 라벨(문서명·소제목)을 **공유**해 서로 다른 자료의
   *     평가가 한 줄로 뭉쳤다 — 「보완이 필요한 자료」가 어느 항목인지 가리지 못했다.
   *  ② 운영자가 대표 질문·문서명을 고치면 같은 자료의 평가가 **두 줄로 갈라졌다**.
   *  ③ 옛 라벨 줄을 누르면 지식베이스 검색이 0건을 냈다(버튼이 아무 데도 데려가지 않았다).
   *
   * 이제 묶음 열쇠는 id 이고 **이름은 집계할 때 서버가 지금 KB 에서 붙인다**
   * (「이름은 어휘를 아는 쪽이 붙인다」 — DS 36-2·39-2 와 같은 규칙).
   * 옛 기록에는 이 값이 없다 — 그때는 「어느 자료인지 모른다」이므로 라벨로 묶은 채 둔다.
   */
  kbId?: string;
  /** 대화 채널 — 현재 web만 사용. */
  channel: string;
  at: string;
}

/** 「보완이 필요한 자료」 한 줄 (DS 43-2). */
export interface FeedbackTarget {
  /** 묶음 열쇠 — 자료 id 가 있으면 `id:<kbId>`, 없으면 `label:<라벨>`. 화면의 목록 식별자다. */
  key: string;
  /** 지금 이 자료의 이름. id 로 찾았으면 **현재 KB 의 이름**, 못 찾으면 평가 당시의 라벨이다. */
  citation: string;
  /** 자료 id(있으면). 화면이 그 항목으로 데려갈 때 쓴다. */
  kbId?: string;
  /** id 는 있는데 지금 KB 에 없다 — 지워진 자료다. 화면은 검색으로 데려가지 않는다. */
  missing?: boolean;
  down: number;
}

export interface FeedbackSummary {
  total: number;
  up: number;
  down: number;
  /** 도움됨 비율(%). 평가가 0건이면 null — 화면에서 「측정 중」으로 표시한다. */
  helpfulRate: number | null;
  /** 👎가 많은 근거 순 상위 목록(개선 대상). */
  topDown: FeedbackTarget[];
}

const MAX_ENTRIES = 500;
const MAX_CITATION_LEN = 120;
const MAX_KB_ID_LEN = 60;

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
  /** 평가 대상 자료 id — 서버가 근거와 함께 내려보낸 값이 그대로 돌아온 것이다 (DS 43-2). */
  kbId?: unknown;
  channel?: unknown;
}): { ok: true; entry: FeedbackEntry } | { ok: false; error: string } {
  // 고객 화면(위젯 「도움이 됐나요」)까지 올라가는 문장이다 — 코드 어휘를 싣지 않는다(DS 29-3).
  if (!isVerdict(input.verdict)) return { ok: false, error: '평가를 기록하지 못했습니다. 다시 눌러 주세요.' };
  if (typeof input.sessionHash !== 'string' || !input.sessionHash) {
    return { ok: false, error: '평가를 기록하지 못했습니다. 다시 눌러 주세요.' };
  }
  const citation = typeof input.citation === 'string' ? input.citation.slice(0, MAX_CITATION_LEN) : '';
  const kbId = typeof input.kbId === 'string' ? input.kbId.trim().slice(0, MAX_KB_ID_LEN) : '';
  const channel = typeof input.channel === 'string' && input.channel ? input.channel : 'web';
  seq += 1;
  const entry: FeedbackEntry = {
    id: `F-${String(seq).padStart(6, '0')}`,
    sessionHash: input.sessionHash.slice(0, 32),
    verdict: input.verdict,
    citation,
    // 없으면 칸도 두지 않는다 — 「모른다」와 「빈 자료」를 구분한다(DS 39-1 의 `piiKinds` 와 같은 규칙).
    ...(kbId ? { kbId } : {}),
    channel,
    at: new Date().toISOString(),
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  scheduleSave(FEEDBACK_NS, exportFeedback);
  return { ok: true, entry };
}

export function listFeedback(limit = 100): FeedbackEntry[] {
  const n = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), MAX_ENTRIES) : 100;
  return entries.slice(-n).reverse().map((e) => ({ ...e }));
}

/** 근거 없이 답한 답변에 달린 평가를 묶는 이름 — 관리 콘솔의 같은 문자열과 맞춰야 한다. */
export const NO_CITATION_LABEL = '근거 없음';

/**
 * 평가 집계. 「보완이 필요한 자료」는 **자료 id** 로 묶는다 (DS 43-2).
 *
 * @param labels 자료 id → 지금 이름. 부르는 쪽(라우트)이 KB 를 아는 자리에서 만들어 넘긴다 —
 *   이 모듈이 KB 를 import 하면 평가 저장소가 지식 적재에 묶인다. 넘기지 않으면 이름을 바꾸지
 *   않고(평가 당시의 라벨 그대로) 「지워졌다」고 단정하지도 않는다.
 */
export function feedbackSummary(labels?: Record<string, string>): FeedbackSummary {
  let up = 0;
  let down = 0;
  const downBy = new Map<string, { kbId?: string; citation: string; down: number }>();
  for (const e of entries) {
    if (e.verdict === 'up') {
      up += 1;
      continue;
    }
    down += 1;
    // 열쇠는 id 가 먼저다 — 라벨은 바뀌고, 한 문서에서 나온 여러 항목이 같은 라벨을 공유한다.
    const key = e.kbId ? `id:${e.kbId}` : `label:${e.citation || NO_CITATION_LABEL}`;
    const prev = downBy.get(key);
    if (prev) {
      prev.down += 1;
      // 같은 자료의 더 최근 라벨로 갱신한다(이름을 바꾼 뒤 들어온 평가가 뒤에 있다).
      if (e.citation) prev.citation = e.citation;
      continue;
    }
    downBy.set(key, { ...(e.kbId ? { kbId: e.kbId } : {}), citation: e.citation || NO_CITATION_LABEL, down: 1 });
  }
  const total = up + down;
  const topDown: FeedbackTarget[] = [...downBy.entries()]
    .map(([key, v]) => {
      // 이름은 **지금 KB 의 이름**으로 바꿔 적는다. 없으면 지워진 자료다 — 평가 당시의 라벨을
      // 남겨 두고 「지금은 없다」고 말한다(이름을 지어내지도, 줄을 지우지도 않는다).
      const current = v.kbId && labels ? labels[v.kbId] : undefined;
      return {
        key,
        citation: current || v.citation,
        ...(v.kbId ? { kbId: v.kbId } : {}),
        ...(v.kbId && labels && !current ? { missing: true } : {}),
        down: v.down,
      };
    })
    .sort((a, b) => b.down - a.down || a.citation.localeCompare(b.citation) || a.key.localeCompare(b.key))
    .slice(0, 5);
  return { total, up, down, helpfulRate: total === 0 ? null : Math.round((up / total) * 100), topDown };
}

/** 테스트·운영 점검용 초기화. */
export function resetFeedback(): void {
  entries = [];
  seq = 0;
  scheduleSave(FEEDBACK_NS, exportFeedback);
}

// ---- 영속화(DS 32-1) ----

export const FEEDBACK_NS = 'feedback';

export interface FeedbackSnapshot {
  version: 1;
  savedAt: string;
  seq: number;
  entries: FeedbackEntry[];
}

export function exportFeedback(): FeedbackSnapshot {
  return { version: 1, savedAt: new Date().toISOString(), seq, entries: entries.map((e) => ({ ...e })) };
}

/** 스냅샷 복원. 형식이 어긋난 항목은 건너뛴다(평가값이 아닌 것은 집계를 비뚤게 만든다). */
export function importFeedback(input: unknown): { ok: true; count: number } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: RESTORE_FORMAT_MESSAGE };
  const snap = input as Partial<FeedbackSnapshot>;
  if (!Array.isArray(snap.entries)) return { ok: false, error: RESTORE_FORMAT_MESSAGE };
  const restored: FeedbackEntry[] = [];
  for (const raw of snap.entries) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as FeedbackEntry;
    if (typeof e.id !== 'string' || !e.id.trim()) continue;
    if (!isVerdict(e.verdict)) continue;
    if (typeof e.sessionHash !== 'string' || !e.sessionHash) continue;
    // 자료 id 는 있으면 그대로 들고 온다 — 옛 스냅샷에는 없다(그때는 「모른다」 · DS 43-2).
    const kbId = typeof e.kbId === 'string' ? e.kbId.trim().slice(0, MAX_KB_ID_LEN) : '';
    restored.push({
      id: e.id,
      sessionHash: e.sessionHash.slice(0, 32),
      verdict: e.verdict,
      citation: typeof e.citation === 'string' ? e.citation.slice(0, MAX_CITATION_LEN) : '',
      ...(kbId ? { kbId } : {}),
      channel: typeof e.channel === 'string' && e.channel ? e.channel : 'web',
      at: typeof e.at === 'string' && e.at ? e.at : new Date().toISOString(),
    });
  }
  entries = restored.slice(-MAX_ENTRIES);
  const maxSeq = entries.reduce((m, e) => {
    const n = Number(String(e.id).replace(/[^0-9]/g, ''));
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  seq = typeof snap.seq === 'number' && snap.seq > maxSeq ? snap.seq : maxSeq;
  return { ok: true, count: entries.length };
}

// 기동 시 복원(없거나 손상되면 빈 상태로 시작 — 사유는 storageStatus()에 남는다).
(function loadPersisted() {
  const r = loadJson(FEEDBACK_NS);
  if (!r.ok) return;
  importFeedback(r.data);
})();
