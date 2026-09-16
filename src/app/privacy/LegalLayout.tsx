// 약관·방침 공용 레이아웃 — 랜딩과 같은 상단바·카드 규격·푸터(DS 4-4). 정적 컴포넌트(상태·저장 없음).
// 색은 globals.css 토큰만 쓴다(하드코딩 hex 0건 — tests/unit.test.mjs 가 고정). 이모지 아이콘은 쓰지 않는다.
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import Link from 'next/link';
import BrandMark from '@/components/BrandMark';

/** 본문의 `<h2>` 를 순서대로 찾아 id 를 붙이고 목차 항목을 만든다(페이지 쪽은 제목만 쓰면 된다). */
function indexSections(children: ReactNode): { nodes: ReactNode; toc: { id: string; label: string }[] } {
  const toc: { id: string; label: string }[] = [];
  const nodes = Children.map(children, (child) => {
    if (!isValidElement(child) || child.type !== 'h2') return child;
    const el = child as ReactElement<{ id?: string; children?: ReactNode }>;
    const label = typeof el.props.children === 'string' ? el.props.children : '';
    if (!label) return child;
    const id = el.props.id ?? `sec-${toc.length + 1}`;
    toc.push({ id, label });
    return cloneElement(el, { id });
  });
  return { nodes, toc };
}

const AlertIcon = () => (
  <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, marginTop: 2 }}>
    <path d="M8 2.6 1.9 13.2h12.2zM8 6.6v3.2M8 11.6v.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

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
  children: ReactNode;
}) {
  const { nodes, toc } = indexSections(children);
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* 상단바 — 랜딩과 같은 규격 */}
      <header className="lg-top">
        <div className="lg-wrap lg-topin">
          <Link href="/" style={{ display: 'inline-flex', alignItems: 'center', gap: 9, fontWeight: 800, fontSize: 16, letterSpacing: '-.02em' }}>
            <BrandMark size={28} />
            GOWON Chat
          </Link>
          <Link href="/" className="lg-home">홈으로</Link>
        </div>
      </header>

      <main className="lg-wrap lg-main">
        {toc.length > 0 && (
          <nav aria-label="목차" className="lg-toc">
            <div className="lg-toc-title">목차</div>
            <ol className="lg-toc-list">
              {toc.map((s) => (
                <li key={s.id}><a href={`#${s.id}`}>{s.label}</a></li>
              ))}
            </ol>
          </nav>
        )}

        <article aria-labelledby="legal-title" className="lg-card">
          <span className="lg-eyebrow">법적 고지</span>
          <h1 id="legal-title" className="lg-title">{title}</h1>
          <div className="lg-meta" role="list">
            <span role="listitem" className="lg-pill">시행(예정)일 {updated}</span>
            {meta && <span role="listitem" className="lg-pill">{meta}</span>}
            {draft && <span role="listitem" className="lg-pill" data-tone="warn">초안 — 법률 검토 전</span>}
          </div>
          {draft && (
            <p className="legal-notice">
              <AlertIcon />
              <span>
                [승인 필요] 본 문서는 상용화 준비용 <strong>검토 초안</strong>입니다. 정식 게시 전 법무 검토가
                필요하며, 본문에 <span className="todo">[미확정]</span>으로 표시된 항목은 실제 운영정책·사업자등록
                정보에 맞춰 확정한 뒤 게시합니다.
              </span>
            </p>
          )}
          <div className="legal-body">{nodes}</div>
        </article>
      </main>

      <footer className="lg-foot">
        <div className="lg-wrap" style={{ padding: '26px 22px 34px', textAlign: 'center', fontSize: 12.5, color: 'var(--mut)' }}>
          <Link href="/terms" style={{ color: 'var(--sub)', fontWeight: 600, marginRight: 16 }}>이용약관</Link>
          <Link href="/privacy" style={{ color: 'var(--sub)', fontWeight: 600 }}>개인정보처리방침</Link>
          <span style={{ display: 'block', marginTop: 10 }}>© GOWON Chat (데모) — 약관·방침은 초안이며 법률 검토 전입니다.</span>
        </div>
      </footer>
    </div>
  );
}
