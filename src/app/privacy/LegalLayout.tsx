// 약관·방침 공용 레이아웃 — 초안 배지 + 본문 타이포그래피. 정적 컴포넌트(상태·저장 없음).
import Link from 'next/link';

export default function LegalLayout({
  title,
  updated,
  draft = false,
  children,
}: {
  title: string;
  updated: string;
  draft?: boolean;
  children: React.ReactNode;
}) {
  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '60px 24px 100px', lineHeight: 1.7 }}>
      <Link href="/" style={{ fontSize: 13, fontWeight: 700, color: 'var(--brand-600)' }}>← 고원 챗봇 홈</Link>
      <h1 style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-.02em', margin: '18px 0 6px' }}>{title}</h1>
      <p style={{ fontSize: 13, color: 'var(--mut)', margin: 0 }}>
        시행(예정)일: {updated}
        {draft && (
          <span style={{ marginLeft: 8, fontSize: 11.5, fontWeight: 800, color: '#9a3412', background: '#ffedd5', borderRadius: 999, padding: '3px 9px', verticalAlign: 'middle' }}>
            초안 — 법률 검토 전
          </span>
        )}
      </p>
      <div className="legal-body" style={{ marginTop: 26, fontSize: 14.5, color: 'var(--ink)' }}>{children}</div>
      <style>{`
        .legal-body h2 { font-size: 16.5px; font-weight: 800; margin: 26px 0 8px; letter-spacing: -0.01em; }
        .legal-body p { margin: 0 0 10px; color: var(--sub); }
        .legal-body a { color: var(--brand-600); font-weight: 600; }
      `}</style>
    </main>
  );
}
