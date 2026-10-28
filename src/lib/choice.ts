/**
 * 우리가 고객이 **「무엇을 골랐는지」 알아듣는 자리** — 단일 출처 (DS 69-1·69-2·69-3).
 *
 * 이 제품이 고객에게 고르라고 내미는 자리는 셋이다.
 *  ① 폴백 뒤의 연관 질문 — 「혹시 아래 질문 중 … 번호(1~3)로 답하셔도 돼요」(`lib/chat`)
 *  ② 접수 폼의 선택지 — 「어느 채널에서 발생했나요? 1) 웹 챗봇 2) 카카오톡 …」(`lib/slots`)
 *  ③ 빠져나가는 말 — 「원치 않으시면 "건너뛰기", 그만두시려면 "취소"」(폼·연락처 수집 턴 양쪽)
 *
 * 세 자리의 판정이 **자리마다 손으로** 적혀 있었고, 같은 말에 서로 다른 답을 냈다:
 *  - 번호를 읽는 식이 두 벌(`chat.parsePick`·`slots.matchChoice`)이고 둘 다 `^([1-9])\s*(번|\.)?$`
 *    였다 — 바로 그 줄에서 「번호로 답하셔도 돼요」라고 안내해 놓고 「2번이요」·「2)」·「②」·
 *    「두 번째」·「3번으로」를 못 알아들었다.
 *  - 말로 고르는 쪽은 **먼저 걸리는 선택지가 이겼다** — 「콜봇이요」가 「웹 챗봇」으로 접수됐다
 *    (동의어 표의 한 글자 `봇` 이 다른 선택지의 말에 들어 있다).
 *  - 「건너뛰기」 판정도 두 벌이고 말 목록까지 달랐다 — 한쪽은 문장 **어디서든** 걸려 「환불
 *    규정 없어요?」를 건너뛰기로 읽었고(고객의 질문이 통째로 사라진다), 다른 쪽은 「아니요」를
 *    못 알아들었다.
 *
 * 이 파일이 지키는 두 가지:
 *  - **고른 것은 하나로 좁힌다.** 여러 선택지에 걸리면 가장 잘 맞는 하나를 고르고, 비기면
 *    고르지 않는다(되묻는다). 틀리게 고르면 고객이 말하지 않은 값으로 접수되고, 못 고르면
 *    고객이 한 번 더 말한다 — 65차가 때를 알아듣는 자리에서 택한 것과 같은 쪽이다.
 *  - **「고른 말」은 그 말만 보냈을 때만 고른 것이다.** 문장 속에 섞여 있는 낱말은 고르기가
 *    아니다(DS 68-3 이 반나절에서 본 것과 같은 자리다).
 *
 * `lib/normalize` 외에는 의존하지 않는다 — 엔진·폼 양쪽이 같은 자를 쓰기 위해서다.
 */
import { MATCH_WEIGHT, basicNormalize, compact, keywordHit, prepare, type PreparedText } from '@/lib/normalize';

// ---- 번호로 고르기 ----

/**
 * 번호 판정의 답 — **세 갈래**다.
 *
 * 「못 알아들었다」(`none`)와 「알아들었는데 그런 번호가 없다」(`out_of_range`)는 다른 사실이라
 * 부르는 쪽이 다른 말을 해야 한다(DS 65-1 이 수를 받는 자리에서 세운 규약과 같다). 종전에는
 * 둘 다 `null` 이어서, 선택지가 넷인데 「5번」이라고 답한 고객이 「알아보지 못했어요」를 들었다.
 */
export type NumberPick =
  | { kind: 'none' }
  | { kind: 'picked'; number: number }
  | { kind: 'out_of_range'; number: number };

const NONE: NumberPick = { kind: 'none' };

/**
 * 번호 뒤에 붙는 조사·종결 — 「3번으로」·「2번이요」·「첫번째요」.
 * 이 꼬리를 떼고 남은 것이 번호뿐일 때만 고르기다(「1시요」는 떼고 나면 「1시」다).
 */
const PICK_TAIL = /(?:으로|로|이요|이에요|예요|입니다|이야|야|할게요|할래요|주세요|부탁해요|부탁드려요|요|용)+$/u;

/** 번호 한 개 — 묶음표·마침표·「번」·「번째」까지 같은 뜻이다. `②`·`２` 는 앞 단계(NFKC)가 `2` 로 모은다. */
const PICK_BODY = /^\(?\s*(\d{1,2})\s*(?:\)|\.|:|번째|번|째)?$/u;

/** 우리말 차례 — 「첫 번째」·「두번째」·「셋째」. 한자말 수(일·이·삼)는 쓰지 않는다(「이번」이 「2번」이 된다). */
const ORDINAL_RE = /^(첫|한|하나|둘|두|셋|세|넷|네|다섯|여섯|일곱|여덟|아홉)\s*(?:번째|번|째)$/u;
const ORDINAL: Record<string, number> = {
  첫: 1, 한: 1, 하나: 1, 둘: 2, 두: 2, 셋: 3, 세: 3, 넷: 4, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9,
};

/**
 * 이 말이 **몇 번을 고른 것인가**.
 *
 * 보내온 글이 번호 하나뿐일 때만 고르기로 본다 — 문장에 섞인 수는 고르기가 아니다
 * (「2시 4명이요」를 분으로 읽던 DS 68-2 와 같은 선이다).
 *
 * @param max 내민 선택지 수. 이 수를 넘거나 0 이면 `out_of_range` 다(「못 알아들었다」가 아니다).
 */
export function pickNumber(text: string, max: number): NumberPick {
  // 보이지 않는 글자·전각·동그라미 숫자를 먼저 모은다(`②` → `2`). 문장부호는 아래에서 본다.
  let t = basicNormalize(text).trim().replace(/[!?~\s]+$/u, '');
  if (!t) return NONE;
  t = t.replace(PICK_TAIL, '').trim();
  if (!t) return NONE;

  let n: number | null = null;
  const body = t.match(PICK_BODY);
  if (body) n = Number(body[1]);
  else {
    const ord = t.match(ORDINAL_RE);
    if (ord) n = ORDINAL[ord[1]] ?? null;
  }
  if (n === null || !Number.isFinite(n)) return NONE;
  if (n < 1 || n > max) return { kind: 'out_of_range', number: n };
  return { kind: 'picked', number: n };
}

// ---- 말로 고르기 ----

/**
 * 선택지 하나의 점수 — **일치한 글자가 길수록, 정확할수록 높다.**
 *
 * 무게는 지식베이스 채점과 같은 자를 쓴다(`MATCH_WEIGHT` · `knowledge.keywordScore`). 재는
 * 글자가 **실제로 걸린 표기**(`hit.term`)인 것이 요점이다 — 「콜봇이요」가 「웹 챗봇」에 걸린
 * 까닭은 동의어 표의 `봇` 한 글자였고, 그 한 글자와 「콜봇」 두 글자가 같은 무게였다.
 */
function scoreChoice(pre: PreparedText, choice: string): number {
  let score = 0;
  for (const word of choice.split(/\s+/)) {
    // 한 글자 낱말(「웹」)로는 고르지 않는다 — 오탐이 너무 크다(종전과 같은 기준).
    if (compact(word).length < 2) continue;
    const hit = keywordHit(pre.compact, pre.jamo, word);
    if (hit.kind === 'none') continue;
    score += (hit.term.length >= 2 ? 2 : 1) * MATCH_WEIGHT[hit.kind];
  }
  return score;
}

/** 두 점수가 사실상 같은가(무게가 0.8·0.5 라 소수 오차가 난다). */
const EPS = 1e-9;

/**
 * 이 말이 **어느 선택지를 가리키는가**. 가리는 것이 없거나 **둘을 똑같이 가리키면 null** 이다.
 *
 * 종전에는 선택지를 차례로 훑다 **먼저 걸리는 것**을 돌려줬다. 그래서 목록 앞쪽 선택지가
 * 뒤쪽 선택지의 말을 가로챘다 — 「콜봇이요」·「음성봇」·「보이스봇」·「전화봇이요」가 모두
 * 「웹 챗봇」으로 접수됐다(접수 내용은 고객이 말한 적 없는 채널이고, 운영자는 그 채널을 본다).
 */
export function pickChoice(choices: readonly string[], text: string): string | null {
  const pre = prepare(text);
  if (!pre.compact) return null;
  // ① 선택지와 글자가 같으면 그것이다(띄어쓰기·문장부호 차이는 `compact` 가 흡수한다).
  for (const c of choices) if (compact(c) === pre.compact) return c;
  // ② 아니면 **가장 잘 맞는** 하나다. 비기면 고르지 않는다.
  let best: string | null = null;
  let bestScore = 0;
  let tied = false;
  for (const c of choices) {
    const s = scoreChoice(pre, c);
    if (s <= 0) continue;
    if (s > bestScore + EPS) {
      best = c;
      bestScore = s;
      tied = false;
    } else if (Math.abs(s - bestScore) <= EPS) {
      tied = true;
    }
  }
  return tied ? null : best;
}

// ---- 빠져나가는 말(취소·이전·건너뛰기) ----

export type Control = 'cancel' | 'back' | 'skip' | 'value';

/**
 * 빠져나가는 말도 **선택지 하나를 고르는 일**이다 — 그래서 여기 있다.
 *
 * 세 가지 모두 **보내온 글이 그 말뿐일 때만** 고른 것으로 본다. 종전에 연락처 수집 턴의
 * 건너뛰기 판정(`chat.SKIP_RE`)은 문장 **어디서든** 걸렸다 — 「환불 규정 없어요?」·「괜찮은
 * 요금제 있나요?」·「배송 안내 없습니다만?」이 전부 건너뛰기로 읽혔고, 고객의 질문은 답을
 * 받지 못한 채 「네, 알겠습니다. 접수는 그대로 남아 있어요」로 끝났다.
 *
 * 말 목록도 두 벌이 **서로 달랐다** — 폼 쪽은 「아니요」·「나중에」를, 연락처 수집 턴 쪽은
 * 「생략」을 몰랐다. 같은 제품이 같은 질문(「원치 않으시면 "건너뛰기"」)을 두 자리에서 하면서
 * 받아 주는 말이 달랐다. 한 벌로 모으고 **두 쪽이 알던 말은 모두 남긴다**(줄이지 않는다).
 */
const TAIL = '(?:요|용)?\\s*[.!?~]*';
const CANCEL_RE = new RegExp(`^(?:취소|그만|그만할래|그만할게|중단|안\\s?할래|안\\s?할게|처음으로|처음부터|나가기|종료|cancel|stop)${TAIL}$`, 'u');
const BACK_RE = new RegExp(`^(?:이전|뒤로|back|다시|잘못\\s?입력|잘못\\s?눌렀어|잘못\\s?눌렀)${TAIL}$`, 'u');
const SKIP_RE = new RegExp(
  `^(?:건너뛰기|건너뛰|건너뛸게|건너뛸래|건너뜁니다|스킵|skip|생략|없어|없습니다|없음|아니|아니오|아뇨|괜찮아|괜찮습니다|괜찮|됐어|됐습니다|필요\\s?없어|필요\\s?없습니다|나중에|안\\s?남길게|안\\s?남길래)${TAIL}$`,
  'u',
);

export function interpretControl(text: string): Control {
  // 보이지 않는 글자·전각을 먼저 모은다 — 붙여 넣은 글에서 온다(DS 63-2·64-1).
  const t = basicNormalize(text).trim();
  if (!t) return 'value';
  if (CANCEL_RE.test(t)) return 'cancel';
  if (BACK_RE.test(t)) return 'back';
  if (SKIP_RE.test(t)) return 'skip';
  return 'value';
}

/** 이 말이 「건너뛰기」인가 — 연락처 수집 턴이 묻는 한 가지. */
export function isSkip(text: string): boolean {
  return interpretControl(text) === 'skip';
}
