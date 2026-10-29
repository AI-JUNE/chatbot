/**
 * **이미 받은 것을 또 받았을 때** — 같은 요청을 두 번 처리하지 않게 가리는 자 (DS 72-1).
 *
 * 왜 한곳에 모았는가: 이 제품은 「요청이 닿았는지 모를 때 다시 보내는 길」을 여러 번 열어 왔다 —
 * 위젯 전송 실패의 「다시 보내기」(DS 5-5), 기한이 지난 요청(DS 23-1), 평가 전송 실패의
 * 「다시 시도」(DS 33-1), 콘솔 저장 실패의 「다시 시도」(DS 5-10). 그런데 **받는 쪽**에서 「이미
 * 받았다」를 가리는 자는 카카오 창구 하나에만 있었다(`lib/kakao` → 아래 `dedupeCheck`). 그래서
 * 웹에서는 같은 말이 두 번 처리됐다: 대화 기록이 두 줄이 되고(오늘 대화 수·자동완결률·평균 응답
 * 시간이 한 사람의 한 마디를 두 번 센다), 세션 턴 수가 두 칸 올라 이관 요약의 「주고받은
 * 메시지」가 늘고, **접수 폼은 두 칸 나아가 앞 항목의 답이 다음 항목의 답으로 들어갔다.**
 *
 * 그 판정이 `webhookAuth.ts` 안에 있었던 것은 우연이다 — 서명 검증과 한 파일에 있었을 뿐,
 * 서명과 아무 상관이 없는 일이다(발화 상한이 `route.ts` 에 있어 카카오가 가져다 쓸 수 없었던
 * 것과 같은 모양 · DS 38-1). 이름이 맞는 자리로 내리고, `webhookAuth` 는 그 이름을 그대로
 * 다시 내보낸다(부르던 쪽은 한 줄도 바뀌지 않는다).
 *
 * 한계: 저장은 **인스턴스 메모리**다. 서버리스에서 두 인스턴스로 갈린 재전달은 가리지 못한다 —
 * 공유 저장소를 쓰는 전역 멱등은 [승인 필요]. 그래도 같은 인스턴스로 오는 흔한 재전달(같은
 * 손님의 「다시 보내기」는 대개 같은 연결을 쓴다)은 여기서 멈춘다.
 */
import { createHmac, randomBytes } from 'node:crypto';

/** 열쇠를 해시할 때 쓰는 프로세스 전용 키 — 발화·사용자 id 원문을 키에 남기지 않는다. */
const KEY_SALT = randomBytes(32);

/**
 * 창구가 받아들이는 **한 번 쓰는 열쇠**의 최대 길이.
 * 이름 없는 수를 라우트마다 박아 두지 않는다 (DS 71-3) — 받는 쪽이 한 곳이면 상한도 한 곳이다.
 */
export const REQUEST_KEY_LEN = 64;

export interface DedupeRecord {
  at: number;
  response?: unknown;
}

/** 인스턴스 단위 캐시. 서버리스는 인스턴스별이므로 완전한 전역 멱등은 [승인 필요](공유 저장소 도입 후). */
const seen = new Map<string, DedupeRecord>();
const MAX_KEYS = 2000;
export const DEFAULT_DEDUPE_TTL_MS = 60_000;

/** 이벤트 식별 키 — 원문(발화·사용자 id)을 그대로 남기지 않도록 해시한다. */
export function eventKey(parts: Array<string | undefined | null>): string {
  return createHmac('sha256', KEY_SALT).update(parts.map((p) => p ?? '').join('|')).digest('hex').slice(0, 32);
}

function sweep(store: Map<string, DedupeRecord>, now: number, ttlMs: number): void {
  for (const [k, v] of store) if (now - v.at > ttlMs) store.delete(k);
  while (store.size >= MAX_KEYS) {
    const first = store.keys().next().value;
    if (first === undefined) break;
    store.delete(first);
  }
}

/**
 * 중복 전달 검사 — 처음 보는 이벤트면 자리를 예약(duplicate:false)하고,
 * TTL 내 재전달이면 duplicate:true 와 (있다면) 이전 응답을 돌려준다.
 */
export function dedupeCheck(
  key: string,
  opts: { now?: number; ttlMs?: number; store?: Map<string, DedupeRecord> } = {},
): { duplicate: boolean; response?: unknown } {
  const store = opts.store ?? seen;
  const now = opts.now ?? Date.now();
  const ttl = opts.ttlMs ?? DEFAULT_DEDUPE_TTL_MS;
  sweep(store, now, ttl);

  const hit = store.get(key);
  if (hit && now - hit.at <= ttl) {
    return hit.response === undefined ? { duplicate: true } : { duplicate: true, response: hit.response };
  }
  store.set(key, { at: now });
  return { duplicate: false };
}

/** 처리 결과를 기록해 재전달 시 같은 응답을 돌려줄 수 있게 한다. */
export function dedupeRemember(
  key: string,
  response: unknown,
  opts: { now?: number; store?: Map<string, DedupeRecord> } = {},
): void {
  const store = opts.store ?? seen;
  store.set(key, { at: opts.now ?? Date.now(), response });
}

/**
 * 예약을 **거둔다** — 답을 만들지 못했으면 그 요청은 처리된 적이 없다 (DS 72-1).
 *
 * 예약만 남겨 두면 고객의 「다시 보내기」가 「앞서 보내신 말씀을 처리하고 있어요」에 걸려
 * **영원히 답을 못 받는다**(기한 안에 한 번 더 보내는 것이 그 버튼의 유일한 쓸모다).
 * 자리를 비우면 다음 요청은 처음 온 요청이 된다.
 */
export function dedupeRelease(key: string, opts: { store?: Map<string, DedupeRecord> } = {}): void {
  (opts.store ?? seen).delete(key);
}

/** 테스트·재기동용 초기화. */
export function resetDedupe(): void {
  seen.clear();
}
