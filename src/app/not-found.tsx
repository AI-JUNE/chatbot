import type { Metadata } from 'next';
import SystemPage from '@/components/SystemPage';

export const metadata: Metadata = { title: '페이지를 찾을 수 없습니다 — GOWON Chat' };

/** 404 — 기본 Next 화면 대신 브랜드 규격. 운영자 경로(/admin)는 여기서도 안내하지 않는다. */
export default function NotFound() {
  return (
    <SystemPage
      code="404"
      title="페이지를 찾을 수 없습니다"
      body="주소가 바뀌었거나 잘못 입력됐을 수 있습니다. 주소를 다시 확인하거나 홈으로 돌아가 주세요."
      actions={[{ kind: 'link', label: '홈으로', href: '/', primary: true }]}
    />
  );
}
