// 시스템 화면(404·오류) 공용 레이아웃 — 랜딩·콘솔과 같은 카드 규격. 상태·저장 없음.
// 내부 오류 문구(스택·메시지·경로)는 절대 싣지 않는다 — 참조 번호만 보인다.
import type { CSSProperties } from 'react';
import Link from 'next/link';
import BrandMark from './BrandMark';

/**
 * 이 화면이 쓰는 토큰 값의 **사본 한 벌**.
 *
 * 왜 사본이 필요한가: `global-error.tsx` 는 루트 레이아웃까지 실패했을 때의 화면이라
 * `globals.css` 가 실리지 않는다. 즉 `var(--mut)` 이 비고, 글자는 브라우저 기본 검정으로 떨어진다.
 * 그래서 그 화면만은 값을 직접 들고 있어야 한다.
 *
 * 사본이 둘이 되지 않게 한다: 종전에는 `global-error.tsx` 가 제 토큰표를, `SystemPage` 가
 * `var(--mut, #94A3B8)` 꼴의 기본값을 따로 들고 있었다 — DS 10-1 이 `--mut` 를 #5F6E85 로 내린 뒤에도
 * 두 사본은 옛 값에 머물러, **최후 화면에서만** 보조 문구가 AA 미달(2.56:1)로 되돌아갔다.
 * 이제 사본은 여기 한 벌뿐이고, 화면은 기본값 없는 `var(--x)` 로만 참조한다.
 * 테스트가 `globals.css` 의 `:root` 를 실제로 파싱해 이 표와 대조한다(값이 갈라지면 실패).
 */
export const SYSTEM_TOKENS = {
  '--bg': '#F8FAFC',
  '--surface': '#FFFFFF',
  '--line': '#E2E8F0',
  '--ink': '#0F172A',
  '--sub': '#475569',
  '--mut': '#5F6E85',
  '--brand': '#2563EB',
  '--brand-600': '#1D4ED8',
  '--brand-50': '#EFF6FF',
  '--r-sm': '10px',
  '--r-lg': '18px',
  '--shadow-card': '0 1px 2px rgba(15,23,42,.04), 0 12px 30px -18px rgba(15,23,42,.18)',
  '--font': "'Pretendard Variable',Pretendard,-apple-system,system-ui,'Malgun Gothic',sans-serif",
} as CSSProperties;

export type SystemAction =
  | { kind: 'link'; label: string; href: string; primary?: boolean }
  | { kind: 'button'; label: string; onClick: () => void; primary?: boolean };

const BTN = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: 42, padding: '0 18px', borderRadius: 'var(--r-sm)', fontSize: 14, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer', border: '1px solid transparent' } as const;
const PRIMARY = { ...BTN, background: 'var(--brand)', color: '#fff' } as const;
const GHOST = { ...BTN, background: 'var(--brand-50)', color: 'var(--brand-600)' } as const;

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
    <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 20px', background: 'var(--bg)', fontFamily: 'var(--font)', color: 'var(--ink)' }}>
      <section
        aria-labelledby="sys-title"
        style={{ width: '100%', maxWidth: 440, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--r-lg)', padding: '34px 28px 28px', boxShadow: 'var(--shadow-card)', textAlign: 'center' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 18 }}>
          <BrandMark size={30} />
          <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: '-.01em' }}>GOWON Chat</span>
        </div>
        <p style={{ display: 'inline-block', fontSize: 11.5, fontWeight: 800, letterSpacing: '.08em', color: 'var(--mut)', border: '1px solid var(--line)', borderRadius: 999, padding: '3px 10px' }}>{code}</p>
        <h1 id="sys-title" style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-.02em', margin: '12px 0 8px', lineHeight: 1.3 }}>{title}</h1>
        <p style={{ fontSize: 14, color: 'var(--sub)', lineHeight: 1.65 }}>{body}</p>
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
          <p style={{ fontSize: 12, color: 'var(--mut)', marginTop: 18 }}>
            문의하실 때 참조 번호 <code style={{ fontFamily: 'inherit', fontWeight: 700, color: 'var(--sub)' }}>{reference}</code> 를 함께 알려 주세요.
          </p>
        )}
      </section>
    </main>
  );
}
