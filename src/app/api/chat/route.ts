// 웹 챗 대화 API. 표준 오류 포맷·입력 검증은 lib/http, 유량 제한은 lib/ratelimit, 구조화 로깅은 lib/logger.
import { NextRequest } from 'next/server';
import { replyToAsync } from '@/lib/chat';
import { logTurn } from '@/lib/convlog';
import { intentLabel, intentLabelMap } from '@/lib/intents';
import { listCustomRules } from '@/lib/adminStore';
import { resolvedTenantId } from '@/lib/tenants';
import { isSharedSessionKey, newVisitorSessionId } from '@/lib/session';
import { rateGuard } from '@/lib/ratelimit';
import { MAX_MESSAGE_LEN } from '@/lib/limits';
import { REQUEST_KEY_LEN, dedupeCheck, dedupeRelease, dedupeRemember, eventKey } from '@/lib/idem';
import { ok, readJson, optStr, withRequestId } from '@/lib/http';
import { captureError } from '@/lib/monitoring';
import { startRequest, hashId } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// Next.js route 파일은 HTTP 메서드 외 export를 허용하지 않는다(빌드 실패 원인) — 그래서 발화 상한은
// 여기 적지 않고 `@/lib/limits` 에서 가져온다. 라우트에 적혀 있던 동안 카카오 창구는 그 값을
// 가져다 쓸 수 없었고, 같은 말을 상한 없이 받았다(DS 38-1).
// 테넌트 식별자 최대 길이(형식 검증은 lib/tenants 가 담당한다).
const MAX_TENANT_LEN = 32;

export async function POST(req: NextRequest) {
  // 요청 로그: 대화 본문·연락처는 기록하지 않는다(세션은 해시로만 남긴다).
  const rl = startRequest('/api/chat', 'POST', req.headers.get('x-request-id'));

  const limited = rateGuard('chat', req.headers, 60);
  if (limited) {
    rl.end({ status: 429, code: 'rate_limited' });
    return withRequestId(limited, rl.requestId);
  }

  const parsed = await readJson<{ message?: unknown; sessionId?: unknown; tenant?: unknown; msgId?: unknown }>(req);
  if (!parsed.ok) {
    rl.end({ status: parsed.res.status, code: 'invalid_json' });
    return withRequestId(parsed.res, rl.requestId);
  }

  const msg = optStr(parsed.data.message, 'message', MAX_MESSAGE_LEN);
  if (!msg.ok) {
    rl.end({ status: 400, code: 'invalid_input' });
    return withRequestId(msg.res, rl.requestId);
  }
  const sid = optStr(parsed.data.sessionId, 'sessionId', 60, '');
  if (!sid.ok) {
    rl.end({ status: 400, code: 'invalid_input' });
    return withRequestId(sid.res, rl.requestId);
  }

  // 테넌트(예: 'eum') — 임베드 옵션에서 넘어온다. 알 수 없는 값이면 기본 동작으로 되돌아간다.
  const ten = optStr(parsed.data.tenant, 'tenant', MAX_TENANT_LEN, '');
  if (!ten.ok) {
    rl.end({ status: 400, code: 'invalid_input' });
    return withRequestId(ten.res, rl.requestId);
  }
  /**
   * **이 말풍선이 보내는 요청의 한 번 쓰는 열쇠** (DS 72-1).
   *
   * 위젯은 보낸 말마다 열쇠를 하나 만들고, 기한이 지나 「다시 보내기」를 누르면 **같은 열쇠**로
   * 다시 보낸다 — 그것이 「처음 보내는 말」과 「닿았는지 모르는 말」을 가르는 유일한 단서다.
   * 종전에는 그 단서가 없어 서버가 같은 말을 두 번 처리했다: 대화 기록이 두 줄, 세션 턴이 두
   * 칸, 그리고 접수 폼은 **두 칸 나아가 앞 항목의 답이 다음 항목의 답으로 들어갔다**.
   * 열쇠를 보내지 않는 호출자(기존 계약)는 종전 그대로 동작한다.
   */
  const mid = optStr(parsed.data.msgId, 'msgId', REQUEST_KEY_LEN, '');
  if (!mid.ok) {
    rl.end({ status: 400, code: 'invalid_input' });
    return withRequestId(mid.res, rl.requestId);
  }

  const message = msg.value;
  const tenantId = ten.value || null;
  /**
   * 세션을 들고 오지 않은 요청에는 **한 번 쓰는 식별자**를 발급한다 (DS 51-2).
   *
   * 종전 기본값은 `'anon'` 이었다 — 세션을 보내지 않은 모든 요청이 그 한 칸을 함께 썼으므로
   * 서로 모르는 두 손님이 **같은 사람**이 됐다(최근 12턴·수집한 연락처·진행 중인 접수가
   * 한 바구니다). 관리 콘솔 「응답 테스트」도 세션 없이 이 창구를 불렀고, 그래서 운영자의
   * 시험 대화와 밖에서 온 요청이 섞였다. 게다가 그 값은 코드에 적혀 있는 글자라, 접수 주인
   * 확인(DS 49-1)이 `sessionId=anon` 한 줄로 열렸다.
   * 발급한 값은 응답에 그대로 실려 나가므로, 이어서 쓰려는 호출자는 받아서 다시 보내면 된다.
   */
  const sessionId = isSharedSessionKey(sid.value) ? newVisitorSessionId('web') : sid.value;
  const sessionHash = hashId(sessionId);

  /**
   * 같은 말을 또 받았는가 — 판정·저장은 `@/lib/idem` 한 곳이다 (DS 72-1).
   * 열쇠는 **세션과 함께** 묶는다: 열쇠만으로 묶으면 남의 말풍선 열쇠를 적어 보낸 요청이
   * 남의 답을 받아 간다(세션 식별자는 이 대화의 유일한 열쇠다 · DS 49-3·51-2).
   */
  const dupKey = mid.value ? eventKey(['chat', sessionId, mid.value]) : '';
  if (dupKey) {
    const dup = dedupeCheck(dupKey);
    if (dup.duplicate) {
      // 답을 이미 만들어 두었으면 **그 답을 그대로** 돌려준다 — 기록·세션 턴을 다시 올리지 않는다.
      // 적어 둔 것은 이 라우트가 만든 응답 본문 하나뿐이다(아래 `dedupeRemember(dupKey, payload)`).
      if (dup.response && typeof dup.response === 'object') {
        rl.end({ status: 200, code: 'duplicate_delivery', sessionHash, channel: 'web' });
        return withRequestId(ok(dup.response as Record<string, unknown>), rl.requestId);
      }
      /**
       * 아직 처리 중이다 — **없는 답을 지어내지 않고** 사실을 말한다.
       * 「잠시 뒤 다시 보내 주세요」는 지킬 수 있는 길이다(같은 열쇠로 다시 오면 그때는 답이
       * 기다리고 있다). 이 턴은 대화 기록에 적지 않는다 — 고객이 한 말이 아니라 전달 사고다.
       */
      rl.end({ status: 200, code: 'duplicate_pending', sessionHash, channel: 'web' });
      return withRequestId(
        ok({
          sessionId,
          reply: '앞서 보내 주신 말씀을 아직 처리하고 있어요. 잠시 뒤 다시 보내 주시면 그 답을 보여드릴게요.',
          intent: 'duplicate',
          intentLabel: intentLabel('duplicate'),
          escalate: false,
          source: 'context' as const,
          confidence: 1,
        }),
        rl.requestId,
      );
    }
  }

  // 응답 시간 측정 — 답을 만드는 데 걸린 서버 처리 시간만 잰다(네트워크 왕복 제외).
  const startedAt = Date.now();
  let result;
  try {
    result = await replyToAsync(message, sessionId, tenantId ? { tenantId } : {});
  } catch (e) {
    // 대화 엔진 오류는 모니터링·로그에 남기되, 고객에게는 안전한 안내로 응답한다(오류를 삼키지 않는다).
    // 답을 만들지 못했으므로 **예약한 자리를 거둔다** (DS 72-1) — 그러지 않으면 「다시 보내기」가
    // 「아직 처리하고 있어요」에 걸려, 한 번의 오류가 그 말풍선의 길을 1분 동안 막는다.
    if (dupKey) dedupeRelease(dupKey);
    await captureError(e, { route: '/api/chat', method: 'POST', requestId: rl.requestId });
    rl.end({
      status: 200,
      code: 'engine_error',
      sessionHash,
      source: 'fallback',
      error: e instanceof Error ? e.message : String(e),
    });
    return withRequestId(
      ok({
        sessionId,
        reply: '일시적인 오류가 발생했어요. 잠시 후 다시 시도해 주시거나 "상담원"이라고 입력해 주세요.',
        intent: 'error',
        intentLabel: intentLabel('error'),
        escalate: true,
        source: 'fallback' as const,
        requestId: rl.requestId,
      }),
      rl.requestId,
    );
  }

  // 대화 로그(인메모리 스텁) — 영구 저장은 [승인 필요]
  if (result.source !== 'empty') {
    logTurn({
      sessionId,
      channel: 'web',
      message,
      reply: result.reply,
      intent: result.intent,
      source: result.source,
      escalate: result.escalate,
      confidence: result.confidence,
      latencyMs: Date.now() - startedAt,
      /**
       * 어느 고객사(테넌트)의 위젯에서 온 턴인가 (DS 36-1).
       * **등록된 테넌트로 해석된 값만** 적는다 — 요청에 실려 온 문자열을 그대로 적으면,
       * 등록되지 않은 `data-tenant` 로 들어와 기본(고원) 자료로 답한 턴을 운영 화면이
       * 「그 고객사 자료로 답했다」고 말한다(기록이 답한 근거와 어긋난다).
       */
      tenant: resolvedTenantId(tenantId),
    });
  }

  rl.end({
    status: 200,
    sessionHash,
    channel: 'web',
    ...(tenantId ? { tenant: tenantId } : {}),
    intent: result.intent,
    source: result.source,
    escalate: result.escalate,
    confidence: result.confidence,
    // LLM 경로가 실패해 결정적 폴백으로 되돌아갔으면 사유를 남긴다(오류를 삼키지 않는다).
    ...(result.llmFailure ? { code: `llm_${result.llmFailure}` } : {}),
  });
  // `intentLabel` 은 **운영자 화면용 표시명**이다(관리 콘솔 「응답 테스트 → 왜 이렇게 답했나」).
  // 위젯은 이 값을 쓰지 않는다 — 고객 화면에 주제를 드러내지 않는다(기존 계약 그대로, 필드만 추가).
  const payload = { sessionId, ...result, intentLabel: intentLabel(result.intent, intentLabelMap(listCustomRules())) };
  // 같은 열쇠로 다시 오면 **이 답을 그대로** 돌려준다 (DS 72-1) — 재전달이 두 번째 사실을
  // 만들지 않는다(카카오 창구가 이미 그렇게 한다 · `rememberKakaoResponse`).
  if (dupKey) dedupeRemember(dupKey, payload);
  return withRequestId(ok(payload), rl.requestId);
}
