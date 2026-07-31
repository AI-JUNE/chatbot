// 인텐트 룰(시나리오) 정의. 정규식 패턴은 코드에서만 수정(관리 콘솔은 응답문/활성화만 편집).
export interface Rule {
  intent: string;
  label: string; // 관리 콘솔 표시용
  test: RegExp;
  reply: string;
  escalate?: boolean;
}

export const RULES: Rule[] = [
  { intent: 'greeting', label: '인사', test: /(안녕|하이|hello|반가)/i, reply: '안녕하세요! 고원 상담 챗봇이에요. 무엇을 도와드릴까요?' },
  { intent: 'thanks', label: '감사', test: /(감사|고마워|고맙|thank)/i, reply: '도움이 되었다니 기뻐요! 더 궁금한 점이 있으면 언제든 물어봐 주세요.' },
  { intent: 'bye', label: '종료 인사', test: /(잘 ?가|안녕히|종료|끝낼|바이)/, reply: '이용해 주셔서 감사합니다. 필요하실 때 언제든 다시 찾아 주세요!' },
  { intent: 'hours', label: '운영시간', test: /(영업시간|운영시간|몇 ?시|언제.*(열|여))/, reply: '상담 운영시간은 평일 09:00~18:00입니다. 그 외 시간에도 챗봇이 24시간 안내해 드려요.' },
  { intent: 'pricing', label: '요금 문의', test: /(요금|가격|비용|얼마|견적)/, reply: '요금은 이용 규모에 따라 달라집니다. 원하시는 업무와 통화량을 알려주시면 맞춰 안내드릴게요.' },
  { intent: 'agent', label: '상담원 연결', test: /(상담원|사람|직원|연결)/, reply: '상담원 연결을 도와드릴게요. 잠시만 기다려 주세요.', escalate: true },
  { intent: 'complaint', label: '불만/민원', test: /(불만|항의|화가|짜증|최악|민원)/, reply: '불편을 드려 정말 죄송합니다. 상황을 정확히 확인해 도와드릴 수 있도록 상담원 연결을 도와드릴게요.', escalate: true },
];
