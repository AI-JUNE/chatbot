// 대화 로그 — 인메모리 링버퍼(최근 500건) + 영속화 어댑터 연결.
// 대화 본문은 **개인정보 포함 데이터**이므로 `PERSIST_PII=true` **[승인 필요]** 전까지 디스크에 쓰지 않는다.
// 코드 경로는 완성되어 있고 스위치만 잠겨 있다(승인 전 동작은 기존과 동일 — 메모리만).
// [승인 필요] 외부 DB 저장·분석 파이프라인 전송.
import type { ReplySource } from '@/lib/chat';
import { loadJson, scheduleSave } from '@/lib/storage';
import { maskPii, mergeKinds, piiKindLabels } from '@/lib/pii';
import { TURN_TEXT_LEN, CLIP_MARK, clip } from '@/lib/limits';
import { KST_CSV_NOTE, kstDate, kstDateTime, readInstant } from '@/lib/kst';
import { CHANNEL_LABELS, SOURCE_CODES, intentLabel, sourceLabel } from '@/lib/intents';
import { compact } from '@/lib/normalize';
import { tenantLabel } from '@/lib/tenants';
import { csvCell, csvRow } from '@/lib/csv';
import { RESTORE_FORMAT_MESSAGE } from '@/lib/refusal';
import { RetentionInfo, retentionNotes } from '@/lib/retention';

export interface ChatTurnLog {
  id: string;
  sessionId: string;
  channel: 'web' | 'kakao' | 'call'; // 멀티채널 대비(현재 web만 사용)
  /**
   * 어느 고객사(테넌트)의 위젯에서 들어온 턴인가. null 이면 기본 구성(고원 자료)이다 (DS 36-1).
   *
   * **필수 필드로 둔다** — 턴을 적는 곳이 늘어날 때 타입 검사에서 막히게 하기 위해서다.
   * 종전에는 이 값이 요청 로그에만 남아, 최근 대화·내려받기·「답하지 못한 질문」·대시보드가
   * 이음 손님의 말과 고원 홈페이지 손님의 말을 구분 없이 한 줄에 섞었다.
   */
  tenant: string | null;
  /** 고객이 한 말 — **개인정보를 가린 뒤** 저장한다 (DS 39-1). 원문은 어디에도 남지 않는다. */
  message: string;
  /** 챗봇이 한 말 — 같은 규칙을 지난다(답변이 고객이 남긴 번호를 되읽는 자리가 있다). */
  reply: string;
  /**
   * 이 턴에서 가린 개인정보의 종류(`@/lib/pii` 코드). 없으면 비어 있다 (DS 39-1).
   *
   * 왜 남기는가: 가린 글만 남기면 운영자는 `***-****-****` 를 보고 **고객이 그렇게 쓴 것인지
   * 우리가 가린 것인지** 모른다(DS 38-x 의 「잘랐으면 잘랐다고 말한다」와 같은 규칙).
   * 옛 스냅샷에는 이 값이 없다 — 그때는 「가린 것이 없다」가 아니라 **모른다**이므로 비워 둔다.
   */
  piiKinds?: string[];
  intent: string;
  /**
   * 무엇으로 답했는가 — 엔진이 내는 값(`ReplySource`)에 **기록 전용 코드**가 더해진다 (DS 54-2).
   *
   * `unknown` 은 복원이 붙이는 값이다: 저장분이 적어 온 코드가 우리 어휘(`SOURCE_CODES`)에
   * 없으면 그 글자를 그대로 들고 오지 않는다. 종전에는 아무 글자나 이 칸에 들어왔고, 화면은
   * `SOURCE_LABELS[code] ?? code` 로 그려 **그 글자를 운영자에게 그대로 보여 줬다**.
   * 멀쩡한 코드로 바꿔 적지도 않는다 — `fallback` 으로 적으면 「답하지 못한 질문」 목록에 없던
   * 줄이 서고, `rule`·`kb` 로 적으면 자동 처리율이 부풀어 오른다(§13 의 「없는 수」다).
   */
  source: ReplySource | 'unknown';
  escalate: boolean;
  /** 엔진 내부 신뢰도(0~1). 자동 전환 판정 근거이며 측정된 정확도 지표가 아니다. */
  confidence?: number;
  /**
   * 서버 처리 시간(ms) — 요청을 받아 답을 만들기까지. 네트워크 왕복은 포함하지 않는다.
   * 기록되지 않은 턴(구버전 로그·측정 실패)은 undefined 로 두고 평균에서 제외한다.
   */
  latencyMs?: number;
  at: string; // ISO
}

/** 정상 범위(0 이상, 유한)의 지연만 받아들인다 — 음수·NaN 은 기록하지 않는다. */
function sanitizeLatency(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined;
  return Math.round(v);
}

const MAX_LOGS = 500;
let logs: ChatTurnLog[] = [];
let seq = 0;

/**
 * **언제부터의 기록을 들고 있는가** (DS 43-1).
 *
 * 왜 필요한가: 이 저장소는 최근 500건만 들고 있고(링버퍼) 그마저 재기동하면 비는데,
 * 집계는 「최근 7일」을 축으로 돌려준다. 보관 한도에 밀려 **기록이 없는 날**과 **대화가 없던 날**이
 * 둘 다 `turns: 0` 으로 나와, 대시보드 첫 화면의 막대 그래프는 어제가 비어 있으면
 * 「어제는 문의가 0건」이라고 그렸다(스크린리더는 「0건」이라고 읽었다). 운영자는 그 수로
 * 「요즘 문의가 줄었다」를 읽는다 — 없는 수를 사실처럼 말하지 않는다는 규칙(§13)이 깨지는 자리다.
 *
 * 그래서 「이 시각 이후는 빠진 것이 없다」는 경계를 하나 들고 있는다.
 *  - 기동·초기화 직후: 지금(그 전의 일은 **모른다** — 재기동으로 통째로 비었을 수 있다)
 *  - 한도에 걸려 버린 순간: 남아 있는 가장 오래된 턴의 시각
 *  - 스냅샷 복원 직후: 복원된 가장 오래된 턴의 시각(그 앞은 스냅샷에도 없다)
 */
let knownFrom = new Date().toISOString();
/** 한도에 걸려 **버린 적이 있는가**(복원으로 잘린 것도 포함). 화면이 사유를 달리 적는다. */
let droppedAny = false;

export function logTurn(input: Omit<ChatTurnLog, 'id' | 'at'>): ChatTurnLog {
  seq += 1;
  /**
   * **가린 뒤에 자른다** (DS 39-1).
   *
   * 순서가 중요하다 — 먼저 자르면 상한 경계에 걸친 번호가 반으로 쪼개져 규칙에 걸리지 않고,
   * 꼬리 쪽 개인정보가 통째로 남는다. 가린 뒤에 자르면 길이 계약(DS 38-3)도 그대로 지켜진다.
   *
   * 왜 저장 시점에 가리는가: 이 한 줄을 지나면 대화 기록은 최근 대화 표·상세 서랍·전역 검색·
   * 「답하지 못한 질문」(대시보드 첫 화면)·내려받기 CSV·백업 스냅샷 **여섯 곳**으로 퍼진다.
   * 종전에는 같은 문장이 이관 요약에서는 가려지고 그 옆 화면에서는 원문 그대로였다
   * (QUALITY_BAR §3 — 개인정보가 화면·로그에 그대로 노출).
   */
  const m = maskPii(input.message || '');
  const r = maskPii(input.reply || '');
  const kinds = mergeKinds(m.hits, r.hits);
  const entry: ChatTurnLog = {
    ...input,
    tenant: input.tenant || null,
    /**
     * 상한을 넘기면 **줄였다는 표시를 남긴다** (DS 38-3).
     * 종전에는 `slice` 로 꼬리를 조용히 버려, 운영자는 「환불 수수료가 궁금한데 저번에 주문한」을
     * 보고 **고객이 거기서 멈춘 것인지 우리가 버린 것인지** 알 수 없었다. 이 글은 「답하지 못한
     * 질문」 목록·내려받기 CSV 로 그대로 나가 새 안내 자료의 원문이 된다.
     */
    message: clip(m.text, TURN_TEXT_LEN),
    reply: clip(r.text, TURN_TEXT_LEN),
    latencyMs: sanitizeLatency(input.latencyMs),
    id: `T-${String(seq).padStart(6, '0')}`,
    at: new Date().toISOString(),
  };
  // 가린 종류는 **우리가 센 값**이다 — 호출자가 적어 보낸 값은 쓰지 않는다(없으면 칸도 없다).
  if (kinds.length) entry.piiKinds = kinds;
  else delete entry.piiKinds;
  logs.push(entry);
  if (logs.length > MAX_LOGS) {
    logs = logs.slice(-MAX_LOGS);
    // 버린 순간부터 「그 앞은 모른다」 — 남은 가장 오래된 턴이 경계다 (DS 43-1).
    knownFrom = logs[0]?.at || knownFrom;
    droppedAny = true;
  }
  scheduleSave(CONVLOG_NS, exportTurns);
  return { ...entry };
}

export const CONVLOG_NS = 'convlog';

export interface ConvLogSnapshot {
  version: 1;
  savedAt: string;
  seq: number;
  turns: ChatTurnLog[];
}

export function exportTurns(): ConvLogSnapshot {
  return { version: 1, savedAt: new Date().toISOString(), seq, turns: listAllTurns() };
}

const CHANNELS = new Set(['web', 'kakao', 'call']);

/** 스냅샷 복원. 형식 위반 항목은 건너뛴다. */
export function importTurns(input: unknown): { ok: true; count: number } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: RESTORE_FORMAT_MESSAGE };
  const snap = input as Partial<ConvLogSnapshot>;
  if (!Array.isArray(snap.turns)) return { ok: false, error: RESTORE_FORMAT_MESSAGE };
  const restored: ChatTurnLog[] = [];
  for (const raw of snap.turns) {
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as ChatTurnLog;
    if (typeof t.id !== 'string' || !t.id.trim()) continue;
    if (typeof t.sessionId !== 'string' || !t.sessionId) continue;
    if (!CHANNELS.has(t.channel)) continue;
    // 복원 경로도 같은 관문을 지난다 (DS 39-1) — **마스킹 이전에 뜬 스냅샷**에는 원문이 들어
    // 있어서, 되돌리면 가려 둔 개인정보가 그대로 되살아나던 자리다(DS 38-3 의 복원 경로와 같다).
    const mm = maskPii(String(t.message ?? ''));
    const rr = maskPii(String(t.reply ?? ''));
    // 옛 스냅샷에 적혀 있던 종류도 합친다 — 이미 가려져 있으면 이번 통과에서 걸리지 않는다.
    const kinds = mergeKinds(Array.isArray(t.piiKinds) ? t.piiKinds : [], mm.hits, rr.hits);
    const entry: ChatTurnLog = {
      ...t,
      // 옛 스냅샷에는 고객사가 없다 — 없는 값을 지어내지 않고 기본 구성(null)으로 둔다.
      tenant: typeof t.tenant === 'string' && t.tenant ? t.tenant : null,
      message: clip(mm.text, TURN_TEXT_LEN),
      reply: clip(rr.text, TURN_TEXT_LEN),
      intent: String(t.intent ?? ''),
      // 근거 코드도 **우리 어휘만** 들고 온다 (DS 54-2) — 채널(`CHANNELS`)·작업 코드
      // (`audit.ACTIONS`)와 같은 관문이다. 모르는 코드는 「알 수 없음」 한 자리로 모은다.
      source: SOURCE_CODES.has(String(t.source)) ? t.source : 'unknown',
      escalate: t.escalate === true,
      latencyMs: sanitizeLatency(t.latencyMs),
      // 시각 칸은 **읽을 수 있을 때만** 들고 온다 (DS 54-3) — 이 값이 보관 경계가 되고,
      // 그 경계가 「그 날 0건」과 「그 날 기록 없음」을 가린다(DS 43-1).
      at: readInstant(t.at, new Date().toISOString()),
    };
    if (kinds.length) entry.piiKinds = kinds;
    else delete entry.piiKinds;
    restored.push(entry);
  }
  logs = restored.slice(-MAX_LOGS);
  // 복원된 가장 오래된 턴이 경계다 — 그 앞은 스냅샷에도 없다(빈 스냅샷이면 지금부터) (DS 43-1).
  knownFrom = logs[0]?.at || new Date().toISOString();
  // 복원은 보관 중인 것을 통째로 갈아 끼운다 — 「버린 적이 있는가」도 이 스냅샷 기준으로 다시 센다.
  droppedAny = restored.length > MAX_LOGS;
  const maxSeq = logs.reduce((m, l) => {
    const n = Number(String(l.id).replace(/[^0-9]/g, ''));
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  seq = typeof snap.seq === 'number' && snap.seq > maxSeq ? snap.seq : maxSeq;
  return { ok: true, count: logs.length };
}

export function listTurns(limit = 50): ChatTurnLog[] {
  return logs.slice(-limit).reverse().map((l) => ({ ...l }));
}

/** 전체 로그(시간순, 메모리 보존분 최대 500건) — CSV 내보내기용. */
export function listAllTurns(): ChatTurnLog[] {
  return logs.map((l) => ({ ...l }));
}

/** 보관 한도 — 화면·내려받기 파일이 「무엇까지 담겼는가」를 말할 때 쓰는 수다. */
export const TURN_RETENTION = MAX_LOGS;

/** 보관 중인 턴 수. 「몇 건을 꺼내 갔는가」를 감사 로그에 적는 자리가 쓴다(DS 40-3). */
export function turnCount(): number {
  return logs.length;
}

/**
 * 「언제부터의 기록인가」 (DS 43-1) — 화면·파일이 모수를 밝힐 때 쓰는 단일 출처.
 * 집계(`convStats().retention`)와 같은 값이고, 변경 이력(`auditRetention`)과 같은 모양이다.
 */
export function turnRetention(): RetentionInfo {
  return { limit: MAX_LOGS, kept: logs.length, knownFrom, dropped: droppedAny };
}

/**
 * 내려받는 대화 기록 CSV — **단일 출처** (DS 40-1·40-2).
 *
 * 왜 라우트가 아니라 여기인가: 종전에는 이 표를 만드는 코드가 `route.ts` 안에 있었다.
 * 라우트는 HTTP 메서드·설정 외 export 가 금지되어(★ 안전 원칙) **돌려 볼 수 없는 자리**이고,
 * 실제로 런타임 테스트가 0건이었다 — 열 이름만 소스 텍스트로 대조하고 **값은 아무도 보지 않았다**.
 * 38차가 웹 발화 상한에서 본 것과 같은 자리다(「라우트에 적혀 있던 동안에는 가져다 쓸 수 없었다」).
 *
 * 받는 사람은 한국의 운영자이고 여는 곳은 엑셀이다. 그래서
 *  - 「시각」은 **한국 시간**으로 적는다(`kstDateTime`) — 화면·파일 이름과 같은 날짜가 되도록.
 *    기계가 보는 원문은 「시각(ISO)」 열에 그대로 남긴다(`주제`·`주제코드` 와 같은 규칙).
 *  - 「개인정보 가림」 열을 둔다 — 본문은 저장될 때 가려지는데(DS 39-1) 파일에는 그 사실이
 *    없어서, 받는 사람은 `***-****-5678` 을 보고 **고객이 그렇게 쓴 줄** 알았다.
 *  - 꼬리에 **이 파일이 무엇인지**를 적는다(정산 CSV 가 이미 그렇게 한다) — 화면은 「최근 분량만
 *    보관합니다」라고 말하는데 파일은 말하지 않아, 받는 사람은 전체 이력으로 읽었다.
 *
 * @param intentLabels 운영자가 만든 규칙(`cr_*`)의 이름 — 런타임에만 알 수 있어 부르는 쪽이 넘긴다.
 */
export function turnsToCsv(intentLabels?: Record<string, string>): string {
  // 「고객사」는 채널 바로 옆에 둔다 — 받는 사람이 가장 먼저 거르는 열이다(DS 36-1).
  // 「개인정보 가림」은 그 열이 설명하는 본문 **앞**에 둔다. 기계가 쓰는 코드·원문은 뒤로 모은다.
  const header = [
    '번호', '시각', '채널', '고객사', '대화', '주제', '근거', '상담원 제안',
    '개인정보 가림', '고객 메시지', '챗봇 답변', '주제코드', '시각(ISO)',
  ];
  const turns = listAllTurns();
  const rows = turns.map((l) =>
    csvRow([
      l.id,
      kstDateTime(l.at),
      CHANNEL_LABELS[l.channel] ?? l.channel,
      tenantLabel(l.tenant ?? null),
      l.sessionId,
      intentLabel(l.intent, intentLabels),
      // 이름을 댈 수 없는 코드도 **코드로 내보내지 않는다** (DS 54-2 · `intentLabel` 과 같은 규칙).
      sourceLabel(l.source),
      l.escalate ? '예' : '아니오',
      // 가린 것이 없으면 **빈 칸**이다 — 옛 기록에는 이 값이 없고, 그때는 「없다」가 아니라
      // 「모른다」이므로 아무 말도 하지 않는다(화면이 그 줄을 그리지 않는 것과 같다 · DS 39-1).
      piiKindLabels(l.piiKinds).join(', '),
      l.message,
      l.reply,
      l.intent,
      l.at,
    ]),
  );
  // 꼬리 주석 — 정산 CSV 와 같은 모양(`# …`). 빈 줄로 표와 떼어 둔다.
  const notes = [
    KST_CSV_NOTE,
    // 「몇 건」만으로는 **어디까지 믿을 수 있는지**를 알 수 없다 — 날짜로 거르는 사람에게는
    // 「그 날이 0건」과 「그 날 기록이 없음」이 전혀 다른 사실이다 (DS 43-1).
    // 이 두 문장은 변경 이력 CSV 와 **한 벌**이다(`@/lib/retention` · DS 48-1) — 두 파일을
    // 나란히 받은 사람이 어느 쪽 기준을 믿어야 하는지 헷갈리지 않게.
    ...retentionNotes('대화', turnRetention()),
    '「고객 메시지」·「챗봇 답변」은 저장할 때 개인정보를 가린 글입니다. 가린 종류는 「개인정보 가림」 열에 적습니다.',
    `길어서 줄인 글의 끝에는 「${CLIP_MARK}」 표시가 붙어 있습니다.`,
  ];
  return [csvRow(header), ...rows, '', ...notes.map((n) => csvCell(`# ${n}`))].join('\r\n');
}

/** 등록 자료·규칙에서 답을 찾지 못해 기본 안내로 끝난 질문(DS 32-2). */
export interface UnansweredQuestion {
  /** 같은 질문을 묶는 열쇠(고객사 + 공백·대소문자 무시한 질문). 목록의 식별자로도 쓴다. */
  key: string;
  /** 화면에 보일 질문 — 같은 묶음 중 **가장 최근에 받은** 표기를 쓴다. */
  question: string;
  /**
   * 이 질문이 들어온 고객사(테넌트). null 이면 기본 구성(고원 자료)이다 (DS 36-1).
   * 고칠 자료가 있는 곳이 고객사마다 다르므로 **묶음을 고객사별로 가른다** — 섞어 세면
   * 운영자가 이음 손님이 못 받은 답을 고원 안내 자료에 적어 넣고도 고쳐지지 않는다.
   */
  tenant: string | null;
  /** 같은 질문이 몇 번 왔는가. */
  count: number;
  /** 마지막으로 받은 시각(ISO). */
  lastAt: string;
}

/**
 * 묶음 열쇠 — 「환불 되나요?」와 「환불되나요」는 운영자에게 같은 질문이다.
 *
 * **엔진이 쓰는 자를 그대로 쓴다**(`@/lib/normalize` 의 `compact`). 종전에는 여기에
 * `trim().toLowerCase().replace(/\s+/g,'')` 를 따로 적어 두었는데, 그 자는 엔진보다 약해서
 * 문장부호(`?`·`!`)와 유니코드 분해형 한글을 **다른 글자**로 봤다. 엔진은 같은 질문으로 보고
 * 똑같이 답하지 못했는데 목록은 그것을 여러 줄로 세었다 — 대시보드 첫 화면의 상위 8개에
 * 같은 질문이 몇 줄씩 차지하고, 정작 가장 많이 온 질문은 아래로 밀려 보이지 않았다.
 * 그 목록이 **새 안내 자료의 원문**이라 순서가 곧 운영자가 다음에 할 일이다(DS 32-2).
 *
 * 글자가 모두 지워지는 말(「???」 처럼 기호뿐인 질문)은 빈 열쇠로 한데 묶이므로
 * 그때만 원문으로 되돌아간다 — 서로 다른 질문을 한 줄로 합치지 않기 위해서다.
 */
function questionKey(message: string): string {
  const key = compact(message);
  return key || message.trim().toLowerCase();
}

/** 고객사가 다르면 **고칠 자료가 다른 곳에 있다** — 같은 문장이어도 다른 묶음이다. */
function groupKey(tenant: string | null, message: string): string {
  return `${tenant ?? ''}\u0000${questionKey(message)}`;
}

/**
 * 「자료에 없어 답하지 못한 질문」 목록. 대시보드가 보여 주던 「기본 안내 n건」은 **수뿐**이어서
 * 그 수를 줄이려면 어떤 자료를 더 써야 하는지 알 길이 없었다(DS 32-2).
 *
 * - 보존된 로그 전체(최대 500건)에서 세고, 자주 온 질문을 앞에 둔다 — 같은 횟수면 최근 것이 먼저다.
 * - 빈 메시지(`source: 'empty'`)·연결 오류는 자료의 문제가 아니므로 세지 않는다.
 * @returns 묶은 질문 목록과 **자르기 전의 전체 묶음 수**(DS 31-3 — 보여 준 수를 찾은 수라 말하지 않는다)
 */
export function unansweredQuestions(limit = 8): { items: UnansweredQuestion[]; groups: number; turns: number } {
  const byKey = new Map<string, UnansweredQuestion>();
  let turns = 0;
  for (const l of logs) {
    if (l.source !== 'fallback') continue;
    const message = (l.message || '').trim();
    if (!message) continue;
    turns += 1;
    const tenant = l.tenant ?? null;
    const key = groupKey(tenant, message);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { key, question: message, tenant, count: 1, lastAt: l.at });
      continue;
    }
    prev.count += 1;
    // 로그는 시간순이라 뒤에 오는 것이 더 최근이다 — 표기와 시각을 최신으로 갱신한다.
    prev.question = message;
    prev.lastAt = l.at;
  }
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 8;
  const items = [...byKey.values()]
    .sort((a, b) => b.count - a.count || (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0))
    .slice(0, n);
  return { items, groups: byKey.size, turns };
}

export interface ConvStats {
  totalTurns: number;
  sessions: number;
  bySource: Record<string, number>;
  byChannel: Record<string, number>;
  /**
   * 고객사(테넌트)별 집계 — 대화 많은 쪽이 앞이다 (DS 36-1).
   * 종전에는 모든 고객사를 하나로 합쳐 세어, 이음에 줄 수 있는 수치가 한 줄도 없었다.
   */
  byTenant: TenantBucket[];
  topIntents: { intent: string; count: number }[]; // 상위 10개
  autoHandled: number; // rule/kb로 즉시 응답한 턴
  autoRate: number; // 자동처리율(0~1, 소수 3자리)
  escalatedTurns: number;
  /** 최근 7일(오늘 포함) 일자별 집계. 보존된 로그 범위 안에서만 센다 — 없는 날은 0이 아니라 '기록 없음'이다. */
  daily: DailyBucket[];
  /** 오늘(한국 시간) 집계. `coverage` 는 이 수가 그날 전부인지를 말한다 (DS 43-1). */
  today: { turns: number; sessions: number; escalated: number; coverage: DayCoverage };
  /** 「언제부터 무엇까지 들고 있는가」 — 수의 모수를 밝히는 값 (DS 43-1). */
  retention: {
    /** 보관 한도(건). */
    limit: number;
    /** 지금 보관 중인 턴 수. */
    kept: number;
    /** 이 시각 이후는 빠진 것이 없다(ISO). 그 앞은 「0건」이 아니라 **모른다**. */
    knownFrom: string;
    /** 한도에 걸려 이미 버린 기록이 있는가. */
    dropped: boolean;
  };
  /**
   * 평균 서버 처리 시간(ms). 지연이 기록된 턴이 하나도 없으면 null — 0 으로 단정하지 않는다.
   * 네트워크 왕복을 뺀 값이므로 화면에서는 「서버 처리 기준」임을 밝힌다.
   */
  avgLatencyMs: number | null;
  /** 평균에 들어간 턴 수(표본 크기). */
  latencySamples: number;
}

export interface TenantBucket {
  /** 고객사 식별자. null 이면 기본 구성(고원 자료)이다. */
  tenant: string | null;
  turns: number;
  sessions: number;
  escalated: number;
}

/**
 * 그 날의 수를 **얼마나 믿을 수 있는가** (DS 43-1).
 *  - `full`    그 날의 기록을 전부 들고 있다 — 0건이면 정말 대화가 없었다.
 *  - `partial` 보관 경계에 걸친 날 — 하루의 일부만 남아 있다(그 날 진짜 수는 이보다 많다).
 *  - `none`    경계보다 앞선 날 — **기록이 없다**. 0건이 아니라 모른다.
 */
export type DayCoverage = 'full' | 'partial' | 'none';

export interface DailyBucket {
  /** YYYY-MM-DD (한국 시간 기준) */
  date: string;
  turns: number;
  escalated: number;
  /** 이 수가 그 날 전부인가 (DS 43-1). 화면은 `none` 을 0건으로 그리지 않는다. */
  coverage: DayCoverage;
}

/**
 * 한국 시간 기준 날짜 문자열. 서버 시간대(UTC)와 무관하게 같은 날로 묶기 위한 것.
 * 계산은 `@/lib/kst` 하나에 맡긴다 — 「며칠인가」의 답이 화면마다 갈라지지 않게.
 * (종전에는 Intl 이 없는 환경으로 떨어지면 UTC 날짜를 돌려줘, 조용히 하루가 어긋났다.)
 */
function dayKey(iso: string | number | Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return kstDate(d);
}

/** 최근 7일 축(오늘 포함, 과거→오늘 순). */
function recentDays(count = 7): string[] {
  const out: string[] = [];
  const now = Date.now();
  for (let i = count - 1; i >= 0; i -= 1) out.push(dayKey(now - i * 86400000));
  return out;
}

export function convStats(): ConvStats {
  const bySource: Record<string, number> = {};
  const byChannel: Record<string, number> = {};
  const byIntent: Record<string, number> = {};
  const sessions = new Set<string>();
  // 고객사별 집계 — 세션은 고객사 안에서 센다(한 세션이 두 고객사에 걸치는 일은 없다).
  const byTenantMap = new Map<string, { tenant: string | null; turns: number; sessions: Set<string>; escalated: number }>();
  let autoHandled = 0;
  let escalatedTurns = 0;
  let latencySum = 0;
  let latencySamples = 0;
  for (const l of logs) {
    if (typeof l.latencyMs === 'number') {
      latencySum += l.latencyMs;
      latencySamples += 1;
    }
    bySource[l.source] = (bySource[l.source] || 0) + 1;
    byChannel[l.channel] = (byChannel[l.channel] || 0) + 1;
    byIntent[l.intent] = (byIntent[l.intent] || 0) + 1;
    sessions.add(l.sessionId);
    const tenant = l.tenant ?? null;
    const tk = tenant ?? '';
    let bucket = byTenantMap.get(tk);
    if (!bucket) {
      bucket = { tenant, turns: 0, sessions: new Set<string>(), escalated: 0 };
      byTenantMap.set(tk, bucket);
    }
    bucket.turns += 1;
    bucket.sessions.add(l.sessionId);
    if (l.escalate) bucket.escalated += 1;
    if (l.source === 'rule' || l.source === 'kb') autoHandled += 1;
    if (l.escalate) escalatedTurns += 1;
  }
  // 일자별 집계 — 로그의 실제 타임스탬프만 쓴다. 보관 경계보다 앞선 날은 **0건이 아니라 '기록 없음'**이다.
  const axis = recentDays(7);
  const boundaryDay = dayKey(knownFrom);
  const coverageOf = (d: string): DayCoverage => (d < boundaryDay ? 'none' : d === boundaryDay ? 'partial' : 'full');
  const byDay = new Map<string, DailyBucket>(
    axis.map((d) => [d, { date: d, turns: 0, escalated: 0, coverage: coverageOf(d) }]),
  );
  const todayKey = axis[axis.length - 1];
  const todaySessions = new Set<string>();
  let todayTurns = 0;
  let todayEscalated = 0;
  for (const l of logs) {
    const k = dayKey(l.at);
    const bucket = byDay.get(k);
    if (bucket) {
      bucket.turns += 1;
      if (l.escalate) bucket.escalated += 1;
    }
    if (k === todayKey) {
      todayTurns += 1;
      todaySessions.add(l.sessionId);
      if (l.escalate) todayEscalated += 1;
    }
  }

  const topIntents = Object.entries(byIntent)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([intent, count]) => ({ intent, count }));
  const totalTurns = logs.length;
  return {
    totalTurns,
    sessions: sessions.size,
    bySource,
    byChannel,
    byTenant: [...byTenantMap.values()]
      .map((b) => ({ tenant: b.tenant, turns: b.turns, sessions: b.sessions.size, escalated: b.escalated }))
      // 대화 많은 쪽이 앞. 같으면 기본 구성을 먼저 둔다(순서가 실행마다 흔들리지 않게).
      .sort((a, b) => b.turns - a.turns || (a.tenant ?? '').localeCompare(b.tenant ?? '')),
    topIntents,
    autoHandled,
    autoRate: totalTurns ? Math.round((autoHandled / totalTurns) * 1000) / 1000 : 0,
    escalatedTurns,
    daily: axis.map((d) => byDay.get(d) as DailyBucket),
    today: {
      turns: todayTurns,
      sessions: todaySessions.size,
      escalated: todayEscalated,
      coverage: coverageOf(todayKey),
    },
    retention: turnRetention(),
    avgLatencyMs: latencySamples ? Math.round(latencySum / latencySamples) : null,
    latencySamples,
  };
}

export function resetLogs(): void {
  logs = [];
  seq = 0;
  knownFrom = new Date().toISOString();
  droppedAny = false;
  scheduleSave(CONVLOG_NS, exportTurns);
}

// 기동 시 복원 — 승인 전(PERSIST_PII 미설정)에는 storage가 차단하므로 아무 일도 일어나지 않는다.
(function loadPersisted() {
  const r = loadJson(CONVLOG_NS);
  if (!r.ok) return;
  importTurns(r.data);
})();
