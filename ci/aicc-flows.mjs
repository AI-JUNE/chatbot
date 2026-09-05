// CI 전용 — 적합성 검사에 넘기는 챗봇 시나리오(§5.3).
//
// 실고객 자료가 아니며 개인정보를 담지 않는다(§10.3). 운영 시나리오가 확정되면 그 사본을 여기에 둔다.
// 이 시나리오는 "챗 채널에서 렌더 가능한 노드만 쓰는가"를 검사기가 판정하는 입력이다 —
// 예를 들어 음성 전용 표현이 섞이면 여기서 걸린다.
export const flows = [
  {
    id: 'f_chatbot_ci',
    version: 1,
    startNodeId: 'n_greet',
    nodes: {
      n_greet: { id: 'n_greet', kind: 'Say', text: '안녕하세요. 무엇을 도와드릴까요?', next: 'n_menu' },
      n_menu: {
        id: 'n_menu',
        kind: 'Choice',
        prompt: '원하시는 항목을 선택해 주세요.',
        options: [
          { label: '이용 안내', value: 'guide', next: 'n_guide' },
          { label: '상담사 연결', value: 'agent', next: 'n_transfer' },
        ],
      },
      n_guide: { id: 'n_guide', kind: 'Say', text: '이용 안내를 보내 드리겠습니다.', next: 'n_ask' },
      n_ask: { id: 'n_ask', kind: 'Collect', slot: 'purpose', prompt: '문의 내용을 입력해 주세요.', next: 'n_transfer' },
      n_transfer: { id: 'n_transfer', kind: 'Transfer', queue: 'q_chat_default', reason: '상담사 연결' },
    },
  },
];
