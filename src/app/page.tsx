import ChatWidget from '@/components/ChatWidget';

export default function Home() {
  return (
    <main style={{ minHeight: '100vh' }}>
      <section style={{ maxWidth: 880, margin: '0 auto', padding: '90px 24px 40px', textAlign: 'center' }}>
        <div style={{ display: 'inline-block', fontSize: 12, fontWeight: 800, letterSpacing: '.08em', color: 'var(--brand-600)', background: 'var(--brand-50)', padding: '6px 13px', borderRadius: 999, textTransform: 'uppercase' }}>Unmanned Contact Center</div>
        <h1 style={{ fontSize: 'clamp(30px,5vw,52px)', fontWeight: 800, letterSpacing: '-.03em', lineHeight: 1.16, margin: '18px 0 14px' }}>
          AI가 먼저 응대하는<br /><span style={{ color: 'var(--brand)' }}>무인 상담 챗봇</span>
        </h1>
        <p style={{ fontSize: 17, color: 'var(--sub)', maxWidth: 520, margin: '0 auto', lineHeight: 1.6 }}>
          웹·카카오 채널에서 24시간 자동 응대하고, 복잡한 문의만 상담원으로 연결합니다. 오른쪽 아래 챗봇으로 바로 체험해 보세요.
        </p>
        <div style={{ marginTop: 26, display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--sub)', background: 'var(--surface)', border: '1px solid var(--line)', padding: '8px 14px', borderRadius: 999 }}>💬 웹·카톡 멀티채널</span>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--sub)', background: 'var(--surface)', border: '1px solid var(--line)', padding: '8px 14px', borderRadius: 999 }}>🙋 상담원 폴백</span>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--sub)', background: 'var(--surface)', border: '1px solid var(--line)', padding: '8px 14px', borderRadius: 999 }}>📞 콜봇 연계</span>
        </div>
      </section>
      <section style={{ maxWidth: 720, margin: '0 auto', padding: '10px 24px 90px' }}>
        <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 16, padding: '22px 24px' }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--brand-600)', marginBottom: 6 }}>내 사이트에 붙이기</div>
          <p style={{ fontSize: 13.5, color: 'var(--sub)', lineHeight: 1.6, margin: '0 0 12px' }}>
            아래 한 줄을 사이트 <code>&lt;body&gt;</code> 끝에 넣으면 이 챗봇이 그대로 나타납니다.
          </p>
          <pre style={{ background: '#2b2220', color: '#f3ede4', fontSize: 12.5, borderRadius: 10, padding: '13px 15px', overflowX: 'auto', margin: 0 }}>
            <code>{'<script src="https://<배포도메인>/embed.js" async></script>'}</code>
          </pre>
        </div>
      </section>
      <ChatWidget />
    </main>
  );
}
