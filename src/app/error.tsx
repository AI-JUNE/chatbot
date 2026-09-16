'use client';

import { useEffect } from 'react';
import SystemPage from '@/components/SystemPage';

/**
 * 화면 오류 경계 — 흰 화면 대신 브랜드 규격의 안내 + 「다시 시도」.
 * 오류 메시지·스택은 내부 경로가 섞일 수 있어 화면에 싣지 않는다. 참조 번호(digest)만 보인다.
 */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // 서버 측 보고는 모니터링 훅(src/lib/monitoring)이 담당한다. 브라우저에서는 개발자 도구에만 남긴다.
    if (process.env.NODE_ENV !== 'production') console.error(error);
  }, [error]);
  return (
    <SystemPage
      code="오류"
      title="화면을 불러오지 못했습니다"
      body="일시적인 문제일 수 있습니다. 다시 시도해도 같은 화면이 나오면 잠시 후 다시 열어 주세요."
      reference={error.digest}
      actions={[
        { kind: 'button', label: '다시 시도', onClick: reset, primary: true },
        { kind: 'link', label: '홈으로', href: '/' },
      ]}
    />
  );
}
