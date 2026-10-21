// 답변 평가 접수 API — 위젯의 「도움이 됐나요 👍/👎」가 호출한다.
// 저장은 인메모리(@/lib/feedback). 사용자가 입력한 문장은 받지도 저장하지도 않는다.
// route 파일은 HTTP 메서드·설정 외 export를 두지 않는다(배포 장애 재발 방지).
import { NextRequest } from 'next/server';
import { recordFeedback, resolveKb } from '@/lib/feedback';
import { kbLabelMap } from '@/lib/tenantKB';
import { rateGuard } from '@/lib/ratelimit';
import { ok, fail, readJson, optStr, withRequestId } from '@/lib/http';
import { startRequest, hashId } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const rl = startRequest('/api/feedback', 'POST', req.headers.get('x-request-id'));

  const limited = rateGuard('feedback', req.headers, 60);
  if (limited) {
    rl.end({ status: 429, code: 'rate_limited' });
    return withRequestId(limited, rl.requestId);
  }

  const parsed = await readJson<Record<string, unknown>>(req);
  if (!parsed.ok) {
    rl.end({ status: parsed.res.status, code: 'invalid_json' });
    return withRequestId(parsed.res, rl.requestId);
  }

  const sid = optStr(parsed.data.sessionId, 'sessionId', 60, 'anon');
  if (!sid.ok) {
    rl.end({ status: 400, code: 'invalid_input' });
    return withRequestId(sid.res, rl.requestId);
  }
  /**
   * 근거 라벨은 **저장하지 않는다** (DS 53-2). 길이만 종전대로 거절한다(응답 계약 유지).
   *
   * 「서버가 만들어 내려준 값이 그대로 돌아온 것이다(자유 입력 아님)」라고 적어 두었지만,
   * 그것을 확인하는 자가 없었다. 이 창구는 인증이 없어 아무나 부를 수 있고, 저장된 글은
   * 관리 콘솔 「보완이 필요한 자료」 줄에 **그대로** 그려진다(마스킹 관문도 지나지 않는다).
   */
  const citation = optStr(parsed.data.citation, 'citation', 120);
  if (!citation.ok) {
    rl.end({ status: 400, code: 'invalid_input' });
    return withRequestId(citation.res, rl.requestId);
  }
  // **어느 자료에 대한 평가인가** (DS 43-2) — 근거와 함께 내려보낸 자료 id 가 돌아온 것이다.
  const kbId = optStr(parsed.data.kbId, 'kbId', 60);
  if (!kbId.ok) {
    rl.end({ status: 400, code: 'invalid_input' });
    return withRequestId(kbId.res, rl.requestId);
  }

  const sessionHash = hashId(sid.value || 'anon');
  /**
   * 이름은 **서버가 지금 KB 에서 찾는다** (DS 53-2) — 가리는 판정은 `resolveKb` 한 벌이다.
   * 지금 KB 에 없는 id 는 적지 않는다: 지어낸 id 하나하나가 「지워진 자료」 한 줄이 되어
   * 운영자가 고쳐야 할 자료 목록을 밖에서 채울 수 있었다. 평가 접수가 지식 적재를 거치지만
   * (`kbLabelMap` 은 메모리 사전이다) 밖에서 쓰는 운영 화면을 지키는 값이 그 사전이다.
   */
  const kb = resolveKb(kbId.value, kbLabelMap());
  const res = recordFeedback({
    sessionHash,
    verdict: parsed.data.verdict,
    ...(kb ?? {}),
    channel: 'web',
  });
  if (!res.ok) {
    rl.end({ status: 400, code: 'invalid_input', sessionHash });
    return withRequestId(fail('invalid_input', res.error), rl.requestId);
  }

  rl.end({ status: 201, channel: 'web', sessionHash, code: res.entry.verdict });
  return withRequestId(ok({ recorded: true, id: res.entry.id }, 201), rl.requestId);
}
