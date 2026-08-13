import ChatWidget from '@/components/ChatWidget';

// 임베드 전용 페이지: embed.js가 이 경로를 iframe으로 로드한다.
// 배경을 투명 처리해 고객사 사이트 위에 위젯만 떠 보이게 한다.
export const metadata = { title: '고원 챗봇 위젯' };

export default function WidgetPage() {
  return (
    <main style={{ minHeight: '100vh', background: 'transparent' }}>
      <style>{'html,body{background:transparent!important}'}</style>
      <ChatWidget embedded />
    </main>
  );
}
