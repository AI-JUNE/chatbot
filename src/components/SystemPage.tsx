// 시스템 화면(404·오류) 공용 레이아웃 — 랜딩·콘솔과 같은 카드 규격. 상태·저장 없음.
// 내부 오류 문구(스택·메시지·경로)는 절대 싣지 않는다 — 참조 번호만 보인다.
import Link from 'next/link';
import BrandMark from './BrandMark';

export type SystemAction =
  | { kind: 'link'; label: string; href: string; primary?: boolean }
  | { kind: 'button'; label: string; onClick: () => void; primary?: boolean };

const BTN = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: 42, padding: '0 18px', borderRadius: 'var(--r-sm, 10px)', fontSize: 14, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer', border: '1px solid transparent' } as const;
const PRIMARY = { ...BTN, background: 'var(--brand, #2563EB)', color: '#fff' } as const;
const GHOST = { ...BTN, background: 'var(--brand-50, #EFF6FF)', color: 'var(--brand-600, #1D4ED8)' } as const;

export default function SystemPage({
  code,
  title,
  body,
  actions,
  reference,
}: {
  /** 화면 상단 작은 라벨(예: 404). 장식이 아니라 스크린리더에도 읽힌다. */
  code: string;
  title: string;
  body: string;
  actions: SystemAction[];
  /** 문의 시 알려줄 참조 번호(선택). 오류 내용 자체는 싣지 않는다. */
  reference?: string;
}) {
  return (
    <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 20px', background: 'var(--bg, #F8FAFC)', fontFamily: 'var(--font, Pretendard, sans-serif)', color: 'var(--ink, #0F172A)' }}>
      <section
        aria-labelledby="sys-title"
        style={{ width: '100%', maxWidth: 440, background: 'var(--surface, #fff)', border: '1px solid var(--line, #E2E8F0)', borderRadius: 'var(--r-lg, 18px)', padding: '34px 28px 28px', boxShadow: 'var(--shadow-card, 0 1px 2px rgba(15,23,42,.04))', textAlign: 'center' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 18 }}>
          <BrandMark size={30} />
          <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: '-.01em' }}>GOWON Chat</span>
        </div>
        <p style={{ display: 'inline-block', fontSize: 11.5, fontWeight: 800, letterSpacing: '.08em', color: 'var(--mut, #94A3B8)', border: '1px solid var(--line, #E2E8F0)', borderRadius: 999, padding: '3px 10px' }}>{code}</p>
        <h1 id="sys-title" style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-.02em', margin: '12px 0 8px', lineHeight: 1.3 }}>{title}</h1>
        <p style={{ fontSize: 14, color: 'var(--sub, #475569)', lineHeight: 1.65 }}>{body}</p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap', marginTop: 22 }}>
          {actions.map((a) =>
            a.kind === 'link' ? (
              <Link key={a.label} href={a.href} style={a.primary ? PRIMARY : GHOST}>{a.label}</Link>
            ) : (
              <button key={a.label} type="button" onClick={a.onClick} style={a.primary ? PRIMARY : GHOST}>{a.label}</button>
            ),
          )}
        </div>
        {reference && (
          <p style={{ fontSize: 12, color: 'var(--mut, #94A3B8)', marginTop: 18 }}>
            문의하실 때 참조 번호 <code style={{ fontFamily: 'inherit', fontWeight: 700, color: 'var(--sub, #475569)' }}>{reference}</code> 를 함께 알려 주세요.
          </p>
        )}
      </section>
    </main>
  );
}
