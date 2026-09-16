// 관리 콘솔 메타데이터 — page.tsx 는 클라이언트 컴포넌트라 metadata 를 내보낼 수 없어 레이아웃에 둔다.
// 운영자 화면은 검색 색인에서 제외한다(DS 4-5). 인증 강제(ADMIN_AUTH_REQUIRED)는 별도 [승인 필요].
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '관리 콘솔 — GOWON Chat',
  robots: { index: false, follow: false, nocache: true },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return children;
}
