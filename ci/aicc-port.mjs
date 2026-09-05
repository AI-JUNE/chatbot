// CI 전용 — AICC-Core 채널 계약 적합성 검사에 넘기는 챗봇 포트.
//
// 이 파일은 **드라이런 전용**이다. 전송기(sink)를 주입하지 않으므로 매체로 아무것도 나가지 않는다.
// 실전송(카카오·웹 위젯)은 런타임 진입점에서 sink 를 주입할 때만 일어나며 **[승인 필요]** 다.
//
// 검사 실행: npm run conformance:aicc
// 종료코드 0=통과 · 1=실패 · 2=판정보류 (판정보류를 통과로 넘기지 않는다)
import { createChannelPort } from 'aicc-core/channels/basePort';
import { profileFor } from 'aicc-core/channels/profiles';

// 능력은 Core 프로파일을 그대로 쓴다. 저장소가 손으로 적으면 같은 채널인데 값이 갈라진다.
export const port = createChannelPort({
  id: 'chatbot',
  capabilities: profileFor('chatbot'),
});
