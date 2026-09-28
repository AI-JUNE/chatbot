import type { Metadata } from 'next';
import ChatWidget from '@/components/ChatWidget';
import { fallbackStarters, tenantConfig } from '@/lib/tenantKB';

// 임베드 전용 페이지: embed.js가 이 경로를 iframe으로 로드한다.
// 배경을 투명 처리해 고객사 사이트 위에 위젯만 떠 보이게 한다.
// `?tenant=eum` — 임베드 스니펫의 data-tenant 옵션이 넘어온다. 알 수 없는 값이면 기본 위젯을 띄운다.
// 임베드 프레임은 검색 결과에 단독으로 노출될 화면이 아니다 — 색인 제외(DS 4-5).
export const metadata: Metadata = { title: 'GOWON Chat 위젯', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default function WidgetPage({ searchParams }: { searchParams?: { tenant?: string } }) {
  const tenant = tenantConfig(searchParams?.tenant);
  // tenant 가 없는 기본 위젯만 일반 지식베이스 상위 질문을 빠른 답장으로 쓴다(DS 19-1) —
  // 이음 등 등록된 테넌트는 자기 프리셋의 starters 만 쓴다(위 주석과 같은 격리 이유).
  return (
    <main style={{ minHeight: '100vh', background: 'transparent' }}>
      <style>{'html,body{background:transparent!important}'}</style>
      <ChatWidget embedded {...(tenant ? { tenant } : { fallbackStarters: fallbackStarters() })} />
    </main>
  );
}
