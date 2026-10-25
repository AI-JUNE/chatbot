// 카카오 i 오픈빌더 스킬 서버 어댑터(순수 함수) — 스텁.
// [승인 필요] 카카오 비즈니스 채널 등록·오픈빌더 스킬 URL 실연동 — 전까지 KAKAO_CHANNEL_LIVE=false 유지.
// 시크릿(KAKAO_SKILL_TOKEN)은 Vercel 환경변수로만 관리(코드 하드코딩 금지).
import { noContactLine, type ChatReply } from '@/lib/chat';
import { MAX_MESSAGE_LEN, cutEnd, ellipsize } from '@/lib/limits';
import { comma } from '@/lib/num';
import { sentenceEndAt } from '@/lib/prose';
import { josa } from '@/lib/refusal';
import { cleanText } from '@/lib/text';
import { dedupeCheck, dedupeRemember, eventKey, safeEqual, verifySignature, type SignatureFailure } from '@/lib/webhookAuth';

export const KAKAO_LIVE = process.env.KAKAO_CHANNEL_LIVE === 'true';

/** 서명 헤더 이름(오픈빌더 커스텀 헤더 설정과 맞춘다). */
export const KAKAO_SIGNATURE_HEADER = 'x-kakao-signature';
export const KAKAO_TIMESTAMP_HEADER = 'x-kakao-timestamp';

// ---- 오픈빌더 v2 요청(사용하는 필드만 정의) ----
export interface KakaoSkillPayload {
  userRequest?: {
    utterance?: string;
    user?: { id?: string };
  };
}

/**
 * 받을 수 있는 발화 길이 — **웹과 같은 값**이다(`@/lib/limits`).
 *
 * 종전에는 이 창구에만 상한이 없었다(DS 38-1). 웹은 2000자를 넘기면 400 으로 거절하고 위젯이
 * 보내기 전에 글자 수로 알리는데(DS 5-5), 카카오는 발화를 그대로 받아 세션 턴 버퍼(12턴)·
 * 이관 요약으로 흘려보냈다 — **같은 말을 창구에 따라 다르게 받는 것** 자체가 어긋남이다.
 */
export const KAKAO_UTTERANCE_LIMIT = MAX_MESSAGE_LEN;

/**
 * 너무 길어 받지 못했을 때의 안내. 잘라서 반쪽 질문에 답하지 않는다 — 고객이 쓴 말을
 * 우리가 임의로 줄이면 **묻지 않은 질문에 답한 것**이 되고, 고객은 그 사실을 모른다.
 * 이 창구에는 글자 수 표시가 없으므로 상한을 문장으로 알린다(DS 29-x — 거절은 화면의 일이다).
 */
export const KAKAO_TOO_LONG_TEXT =
  `보내 주신 말씀이 너무 길어 한 번에 받지 못했어요. ${comma(KAKAO_UTTERANCE_LIMIT)}자 이내로 나눠 보내 주시면 바로 답해 드릴게요.`;
// 천 단위 쉼표를 넣는 자는 `lib/num.comma` 하나다 (DS 60-3) — `toLocaleString` 은 런타임의 ICU
// 설치에 따라 「2000」이 되기도 한다. 종전에는 그 판단을 이 한 줄에서만 내려, 같은 상한을 알리는
// 웹 창구의 문장(`lib/refusal.tooLongMessage`)은 `toLocaleString` 을 그대로 쓰고 있었다.

/**
 * 요청 페이로드에서 발화·사용자 id 추출.
 *
 * 실패 사유를 **값으로** 돌려준다 — null 하나로 뭉개면 「발화를 확인하지 못했어요」와
 * 「너무 길어요」가 같은 말이 되고, 호출하는 쪽이 둘을 구분할 수단이 없다.
 */
export type KakaoParsed =
  | { ok: true; utterance: string; userId: string }
  | { ok: false; reason: 'empty' | 'too_long' };

export function parseKakaoPayload(body: unknown): KakaoParsed {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'empty' };
  const p = body as KakaoSkillPayload;
  // 웹 창구(`http.optStr`)와 **같은 자**로 턴다 (DS 63-1) — `trim()` 은 제로폭 공백·방향 제어를
  // 글자로 세므로, 아무것도 보이지 않는 발화가 「발화를 확인하지 못했어요」를 지나 엔진까지 갔다.
  // 같은 말을 창구에 따라 다르게 받지 않는다(DS 38-1 이 상한에서 세운 규칙과 같은 까닭이다).
  const utterance = cleanText(p.userRequest?.utterance);
  if (!utterance) return { ok: false, reason: 'empty' };
  if (utterance.length > KAKAO_UTTERANCE_LIMIT) return { ok: false, reason: 'too_long' };
  /**
   * 사용자 id 가 없으면 **비워 둔다** (DS 51-2).
   *
   * 종전에는 `'kakao-anon'` 을 지어냈다 — 그 값은 세션 식별자가 되어(`kakao:kakao-anon`)
   * id 를 보내지 않은 **모든 요청이 한 대화**가 됐다: 최근 12턴·수집한 연락처·진행 중인 접수가
   * 한 바구니이고, 세션당 접수 재사용 규칙에 걸려 서로 모르는 사람의 접수가 한 건으로 합쳐진다.
   * 모르는 것을 지어내지 않고 비워 두면, 창구가 **한 번 쓰는 식별자**를 발급한다(이어지지
   * 않는 것이 사실이다). 중복 전달 판정 키는 이 값(빈 문자열)을 그대로 쓰므로 재전달에도
   * 변하지 않는다 — 그 자리에 난수를 넣으면 재시도마다 접수·대화 기록이 하나씩 더 생긴다.
   */
  const userId = cleanText(p.userRequest?.user?.id).slice(0, 60);
  return { ok: true, utterance, userId };
}

// ---- 오픈빌더 v2 응답 ----
interface KakaoQuickReply {
  label: string;
  action: 'message';
  messageText: string;
}

export interface KakaoSkillResponse {
  version: '2.0';
  template: {
    outputs: Array<{ simpleText: { text: string } }>;
    quickReplies?: KakaoQuickReply[];
  };
}

/** simpleText 말풍선 하나의 글자 상한(오픈빌더 규격). */
export const KAKAO_TEXT_LIMIT = 1000;
/** 한 응답에 담을 수 있는 말풍선 수(오픈빌더 규격). */
export const KAKAO_OUTPUT_LIMIT = 3;
/** 바로가기 버튼(quickReply) 라벨의 글자 수(오픈빌더 권장). */
export const KAKAO_LABEL_LEN = 14;

/** 상한을 넘겨 잘렸을 때 붙이는 고지 — 잘렸다는 사실을 삼키지 않는다(QUALITY_BAR §3). */
const CUT_NOTICE = '\n…(답변이 길어 여기까지만 보내드렸어요. 나머지는 "상담원"이라고 입력해 주시면 상담원이 안내드릴게요.)';

/**
 * 끊을 자리를 찾는다 — 문단(빈 줄) → 줄바꿈 → 문장 끝 → 공백 순. 모두 너무 앞(절반 미만)이면
 * 쓰지 않고 상한에서 자른다(한 말풍선만 짧게 남는 모양을 만들지 않기 위해서다).
 * 한국어는 공백 없이 이어지는 문장이 길어 공백만 보면 거의 항상 실패한다 — 문장 끝을 먼저 본다.
 *
 * 「문장 끝인가」는 **`lib/prose` 가 답한다** (DS 66-3). 종전에는 이 자리에서 마침표 하나를
 * 문장 끝으로 읽었다 — 창 안의 마지막 점이 소수점이면(`초과 사용분은 1.5배로 계산합니다`)
 * 앞 말풍선이 **「… 초과 사용분은 1.」** 로 끝나고 뒤 말풍선이 「5배로 계산합니다」로 시작했다.
 * 카카오 말풍선은 한 줄씩 따로 도착하므로 앞 것만 읽은 고객은 **1배로 읽는다**(§13 — 없는 수).
 * 근거 발췌(`lib/knowledge`)가 같은 판정을 또 한 벌 들고 있었다.
 *
 * 마지막 길(끊을 자리를 찾지 못했을 때)은 **글자를 쪼개지 않는 자리**에서 끊는다 (DS 62-2).
 * 종전에는 `room` 을 그대로 돌려줬다 — 한국어 답변은 공백·마침표 없이 길게 이어지는 일이
 * 흔해서 이 길이 실제로 쓰이는 길이고, 상한이 이모지 가운데 떨어지면 **앞 말풍선 끝과 뒤
 * 말풍선 첫 글자가 둘 다 `�`** 가 됐다(반쪽 글자는 UTF-8 로 적는 순간 바뀐다).
 * 문단·줄바꿈·문장 끝·공백으로 끊는 네 길은 모두 한 칸 글자 뒤라 애초에 안전하다.
 */
function breakAt(text: string, room: number): number {
  const win = text.slice(0, cutEnd(text, room));
  const floor = Math.floor(room / 2);
  const para = win.lastIndexOf('\n\n');
  if (para >= floor) return para + 2;
  const line = win.lastIndexOf('\n');
  if (line >= floor) return line + 1;
  for (let i = win.length - 1; i >= floor; i -= 1) {
    // 문장 끝에 붙은 묶음표·물음표까지 앞 말풍선에 담는다(`sentenceEndAt` 이 그 자리를 돌려준다).
    const at = sentenceEndAt(win, i);
    if (at) return at;
  }
  const space = win.lastIndexOf(' ');
  if (space >= floor) return space + 1;
  return win.length;
}

/**
 * 긴 답변을 말풍선 단위로 나눈다 (DS 37-3).
 *
 * 종전에는 본문을 1000자에서 `slice` 로 자르고 끝이었다 — 상한이 넘는 답변(문서 인제스트로 만든 자료
 * 항목은 문단 하나가 그대로 답이 되므로 길이 제한이 없다)은 **말 중간에서 잘리고** 고객은
 * 잘린 줄도 모른다. 카카오는 한 응답에 말풍선 3개까지 담을 수 있으므로 먼저 나눠 담고,
 * 그래도 넘치면 **잘랐다고 말한다**.
 */
export function splitKakaoText(
  text: string,
  limit = KAKAO_TEXT_LIMIT,
  maxParts = KAKAO_OUTPUT_LIMIT,
): { parts: string[]; cut: boolean } {
  let rest = String(text ?? '').trim();
  const cap = Math.max(1, maxParts);
  const parts: string[] = [];
  while (rest && parts.length < cap) {
    if (rest.length <= limit) {
      parts.push(rest);
      rest = '';
      break;
    }
    const last = parts.length === cap - 1;
    // 마지막 말풍선에는 잘림 고지가 들어갈 자리를 미리 비워 둔다.
    const room = last ? Math.max(1, limit - CUT_NOTICE.length) : limit;
    const at = breakAt(rest, room);
    parts.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (!parts.length) return { parts: [], cut: false };
  if (rest) parts[parts.length - 1] += CUT_NOTICE;
  return { parts, cut: Boolean(rest) };
}

/**
 * 이 대화가 들고 있는 접수의 **지금 모습** (DS 51-3).
 *
 * 종전에는 접수번호 한 글자만 받았다(`filedTicket?: string`). 그 값은 세션에 적혀 **끝까지
 * 남는** 번호라, 운영자가 그 접수를 완료·취소한 뒤에도 카카오는 「이미 접수번호 ESC-0007로
 * 접수돼 있어요. 다시 접수하지 않으셔도 상담원이 순서대로 연락드릴게요」라고 **현재형으로**
 * 말했고(완료·취소 시 연락처는 그 자리에서 파기된다 — 방침 4조), 같은 판정으로 「상담원 연결」
 * 버튼까지 감췄다. 웹에서는 47차에 고친 자리다(DS 50-1·45-1) — 같은 사실을 창구 하나만 고쳤다.
 * 그래서 「번호」가 아니라 **번호와 지금 상태**를 받는다. 쓰는 쪽은 상태 코드를 해석하지 않는다
 * (`lib/escalation.isClosedStatus` 가 어느 코드가 끝인가를 정한다).
 */
export interface KakaoFiledTicket {
  id: string;
  /** 끝난 접수(완료·취소)인가 — 더 진행되지 않고 연락처도 남아 있지 않다. */
  closed: boolean;
  /** 회신할 곳이 남아 있는가(`Boolean(ticket.contact)`). */
  contactOnFile: boolean;
}

export interface KakaoRenderOptions {
  /**
   * 이 대화에 **이미 접수돼 있고 아직 진행 중인** 접수 (DS 37-2·51-3).
   * 이번 턴에 생긴 접수가 아니라 「이 사람은 이미 접수했는가」다 — 카카오에는 버튼을 숨기는
   * 위젯 화면이 없으므로, 이 값이 있으면 접수를 다시 권하지 않고 접수번호를 글자로 알린다.
   */
  filedTicket?: KakaoFiledTicket | null;
}

/** 대화엔진 결과를 오픈빌더 v2 simpleText 응답으로 변환.
 *  연관 FAQ 제안(suggestions)은 quickReplies로, escalate 시 상담원 연결 quickReply 추가(최대 10개).
 *  KB 답변이면 출처(근거) 한 줄을 덧붙인다 — 카카오는 말풍선 서식이 없어 텍스트로만 표기. */
export function toKakaoResponse(result: ChatReply, opts: KakaoRenderOptions = {}): KakaoSkillResponse {
  /**
   * **끝난 접수는 들고 있지 않다** (DS 51-3) — 위젯이 같은 자리에서 하는 판정과 같은 식이다
   * (`ChatWidget`: `handoff?.ticket && !ticketClosed(...) ? handoff.ticket : null`).
   * 끝난 접수를 그대로 들고 있으면 ① 「상담원이 순서대로 연락드릴게요」가 지킬 길 없는 약속이
   * 되고 ② 그 접수 하나가 이 대화에서 상담원을 다시 부를 유일한 버튼을 가린다.
   */
  const filed = opts.filedTicket && !opts.filedTicket.closed ? opts.filedTicket : null;
  /**
   * 접수한 뒤에는 접수를 다시 권하지 않는다 (DS 37-2 — 위젯이 DS 35-2 로 고친 것과 같은 판정).
   * 열린 접수는 세션당 재사용되므로 중복 접수가 생기지는 않지만, 버튼을 그대로 두면 고객은
   * 자기 접수가 접수된 줄 모른 채 같은 요청을 되풀이하고 서버는 연락처를 다시 묻는다.
   * 이번 턴에 접수된 경우(`result.ticketId`)는 답변 본문이 이미 접수번호를 말한다.
   */
  const already = Boolean(filed) && result.escalate && !result.ticketId;
  const notice = already
    // 조사는 **번호를 읽는 소리**에 맞춘다 (DS 61-2) — 「ESC-0009로」·「ESC-0010으로」.
    ? `\n\n이미 접수번호 ${josa(filed!.id, '으로', '로')} 접수돼 있어요.` +
      (filed!.contactOnFile
        ? ' 다시 접수하지 않으셔도 상담원이 순서대로 연락드릴게요.'
        // 연락처가 없는 접수에 회신을 약속하지 않는다 (DS 45-1) — 문장은 엔진과 **한 벌**이다.
        : noContactLine())
    : '';
  const cite = result.citation ? `\n\n근거: ${result.citation.source}` : '';
  const body = `${result.reply}${notice}`;

  // 한 말풍선에 들어가면 종전 모습 그대로(본문 + 근거 한 줄). 넘칠 때만 나눠 담는다.
  const outputs: Array<{ simpleText: { text: string } }> = [];
  if (`${body}${cite}`.length <= KAKAO_TEXT_LIMIT) {
    outputs.push({ simpleText: { text: `${body}${cite}` } });
  } else {
    // 근거는 **마지막 한 칸을 비워 두고** 따로 보낸다 — 본문 끝에 붙여 한 번에 자르면 가장 먼저
    // 사라지는 것이 「무엇을 근거로 답했는가」다(§13 — 근거 없는 답을 내보내지 않는다).
    const { parts } = splitKakaoText(body, KAKAO_TEXT_LIMIT, KAKAO_OUTPUT_LIMIT - (cite ? 1 : 0));
    for (const p of parts) outputs.push({ simpleText: { text: p } });
    if (cite) outputs.push({ simpleText: { text: ellipsize(cite.trim(), KAKAO_TEXT_LIMIT) } });
  }

  const res: KakaoSkillResponse = { version: '2.0', template: { outputs } };
  const quickReplies: KakaoQuickReply[] = [];
  for (const s of result.suggestions ?? []) {
    // 카카오 quickReply label은 14자 이하 권장 — 초과 시 말줄임표 처리.
    // 자르는 자는 한 곳이다(`lib/limits.ellipsize` · DS 62-2) — 이 자리는 운영자가 적은
    // 자료 질문이 그대로 들어오므로 이모지·분해형 한글이 상한 가운데 떨어질 수 있다.
    const label = ellipsize(s.question, KAKAO_LABEL_LEN);
    quickReplies.push({ label, action: 'message', messageText: s.question });
  }
  // 이번 턴에서 접수됐거나(ticketId) 이미 접수해 둔 대화면(filed) 중복 접수 유도 방지
  if (result.escalate && !result.ticketId && !filed) {
    quickReplies.push({ label: '상담원 연결', action: 'message', messageText: '상담원' });
  }
  if (quickReplies.length) res.template.quickReplies = quickReplies.slice(0, 10);
  return res;
}

/** 에러 상황용 안전 응답(카카오는 200 + 정상 스키마를 기대). */
export function kakaoErrorResponse(text = '요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.'): KakaoSkillResponse {
  return { version: '2.0', template: { outputs: [{ simpleText: { text } }] } };
}


// ---- 웹훅 인증 · 재시도 처리 ----

export type KakaoAuthFailure = 'bad_token' | SignatureFailure;

export type KakaoAuthResult = { ok: true } | { ok: false; reason: KakaoAuthFailure };

/**
 * 스킬 요청 인증 — 토큰(있으면) + HMAC 서명(설정 시).
 *
 * 정책
 * - `KAKAO_SKILL_TOKEN` 설정 시 `x-skill-token` 일치 필수(상수 시간 비교).
 * - `KAKAO_WEBHOOK_SECRET` 설정 시 서명 검증 필수.
 * - `KAKAO_SIGNATURE_REQUIRED=true` 인데 시크릿이 없으면 **전면 차단**한다
 *   (설정 누락을 조용한 무방비 상태로 두지 않는다 — ADMIN_AUTH_REQUIRED와 같은 원칙).
 * - 실패 사유는 서버 로그용이며 응답 본문에 담지 않는다.
 */
export function authenticateKakao(
  headers: Headers,
  rawBody: string,
  env: Record<string, string | undefined> = process.env,
  nowMs?: number,
): KakaoAuthResult {
  const token = env.KAKAO_SKILL_TOKEN;
  if (token && !safeEqual(headers.get('x-skill-token') ?? '', token)) {
    return { ok: false, reason: 'bad_token' };
  }

  const secret = env.KAKAO_WEBHOOK_SECRET;
  const required = env.KAKAO_SIGNATURE_REQUIRED === 'true';
  if (!secret) return required ? { ok: false, reason: 'no_secret' } : { ok: true };

  const v = verifySignature({
    secret,
    signature: headers.get(KAKAO_SIGNATURE_HEADER),
    timestamp: headers.get(KAKAO_TIMESTAMP_HEADER),
    rawBody,
    ...(nowMs === undefined ? {} : { nowMs }),
  });
  return v.ok ? { ok: true } : { ok: false, reason: v.reason };
}

/**
 * 재시도(중복 전달) 판정 키.
 * 플랫폼이 이벤트 id를 주면 그것을, 없으면 사용자·발화·타임스탬프 조합을 해시해 쓴다.
 * 원문(발화·사용자 id)은 키에 평문으로 남지 않는다.
 */
export function kakaoEventKey(headers: Headers, userId: string, utterance: string): string {
  const explicit = headers.get('x-kakao-event-id') || headers.get('x-request-id');
  if (explicit) return eventKey(['evt', explicit]);
  return eventKey(['utt', userId, utterance, headers.get(KAKAO_TIMESTAMP_HEADER)]);
}

/** 같은 이벤트가 다시 들어왔는지 확인한다. 처음이면 자리를 예약한다. */
export function kakaoDedupe(key: string, nowMs?: number): { duplicate: boolean; response?: KakaoSkillResponse } {
  const r = dedupeCheck(key, nowMs === undefined ? {} : { now: nowMs });
  return r.response === undefined
    ? { duplicate: r.duplicate }
    : { duplicate: r.duplicate, response: r.response as KakaoSkillResponse };
}

/** 처리 결과를 기록해 재전달 시 동일 응답을 돌려준다(티켓·로그 중복 생성 방지). */
export function rememberKakaoResponse(key: string, response: KakaoSkillResponse, nowMs?: number): void {
  dedupeRemember(key, response, nowMs === undefined ? {} : { now: nowMs });
}
