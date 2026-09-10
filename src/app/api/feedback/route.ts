// 답변 평가 접수 API — 위젯의 「도움이 됐나요 👍/👎」가 호출한다.
// 저장은 인메모리(@/lib/feedback). 사용자가 입력한 문장은 받지도 저장하지도 않는다.
// route 파일은 HTTP 메서드·설정 외 export를 두지 않는다(배포 장애 재발 방지).
import { NextRequest } from 'next/server';
import { recordFeedback } from '@/lib/feedback';
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
  // 근거 라벨은 서버가 만들어 위젯에 내려준 값이 그대로 돌아온 것이다(자유 입력 아님).
  const citation = optStr(parsed.data.citation, 'citation', 120);
  if (!citation.ok) {
    rl.end({ status: 400, code: 'invalid_input' });
    return withRequestId(citation.res, rl.requestId);
  }

  const sessionHash = hashId(sid.value || 'anon');
  const res = recordFeedback({
    sessionHash,
    verdict: parsed.data.verdict,
    citation: citation.value,
    channel: 'web',
  });
  if (!res.ok) {
    rl.end({ status: 400, code: 'invalid_input', sessionHash });
    return withRequestId(fail('invalid_input', res.error), rl.requestId);
  }

  rl.end({ status: 201, channel: 'web', sessionHash, code: res.entry.verdict });
  return withRequestId(ok({ recorded: true, id: res.entry.id }, 201), rl.requestId);
}
