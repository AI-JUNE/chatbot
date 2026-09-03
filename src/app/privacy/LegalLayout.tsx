// 약관·방침 공용 레이아웃 — 초안 배지 + 본문 타이포그래피. 정적 컴포넌트(상태·저장 없음).
import Link from 'next/link';

export default function LegalLayout({
  title,
  updated,
  draft = false,
  meta,
  children,
}: {
  title: string;
  updated: string;
  draft?: boolean;
  /** 서비스·운영주체 등 상단 표기(선택). */
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '60px 24px 100px', lineHeight: 1.7 }}>
      <Link href="/" style={{ fontSize: 13, fontWeight: 700, color: 'var(--brand-600)' }}>← 고원 챗봇 홈</Link>
      <h1 style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-.02em', margin: '18px 0 6px' }}>{title}</h1>
      {meta && <p style={{ fontSize: 13, color: 'var(--mut)', margin: '0 0 2px' }}>{meta}</p>}
      <p style={{ fontSize: 13, color: 'var(--mut)', margin: 0 }}>
        시행(예정)일: {updated}
        {draft && (
          <span style={{ marginLeft: 8, fontSize: 11.5, fontWeight: 800, color: '#9a3412', background: '#ffedd5', borderRadius: 999, padding: '3px 9px', verticalAlign: 'middle' }}>
            초안 — 법률 검토 전
          </span>
        )}
      </p>
      {draft && (
        <p className="legal-notice">
          ⚠️ [승인 필요] 본 문서는 상용화 준비용 <strong>검토 초안</strong>입니다. 정식 게시 전 법무 검토가
          필요하며, 본문에 <span className="todo">[미확정]</span>으로 표시된 항목은 실제 운영정책·사업자등록
          정보에 맞춰 확정한 뒤 게시합니다.
        </p>
      )}
      <div className="legal-body" style={{ marginTop: 26, fontSize: 14.5, color: 'var(--ink)' }}>{children}</div>
      <style>{`
        .legal-notice { margin: 18px 0 0; padding: 13px 15px; border-radius: 10px; font-size: 13.5px;
          background: #fff7ed; border: 1px solid #fdba74; color: #9a3412; line-height: 1.65; }
        .legal-body h2 { font-size: 16.5px; font-weight: 800; margin: 26px 0 8px; letter-spacing: -0.01em; }
        .legal-body p { margin: 0 0 10px; color: var(--sub); }
        .legal-body a { color: var(--brand-600); font-weight: 600; }
        .legal-body ul { margin: 0 0 10px; padding-left: 18px; color: var(--sub); }
        .legal-body li { margin: 0 0 4px; }
        .todo { font-weight: 800; color: #9a3412; background: #ffedd5; border-radius: 5px;
          padding: 1px 5px; font-size: .93em; white-space: nowrap; }
      `}</style>
    </main>
  );
}
