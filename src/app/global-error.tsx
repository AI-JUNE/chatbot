'use client';

import type { CSSProperties } from 'react';
import SystemPage, { SYSTEM_TOKENS } from '@/components/SystemPage';

/**
 * 루트 레이아웃까지 실패했을 때의 최후 화면 — 이때는 `globals.css` 가 실리지 않는다.
 * 그래서 토큰을 `<body>` 에 직접 얹는다. 값은 `SystemPage` 의 `SYSTEM_TOKENS` **한 벌**을 그대로 쓴다
 * (종전에는 이 파일이 제 사본을 들고 있어 DS 10-1 이 내린 `--mut` 가 여기서만 옛 값으로 남았다).
 * 오류 내용은 싣지 않는다(참조 번호만).
 */
const BODY = { ...SYSTEM_TOKENS, margin: 0 } as CSSProperties;

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="ko">
      <body style={BODY}>
        <SystemPage
          code="오류"
          title="서비스를 불러오지 못했습니다"
          body="잠시 후 다시 시도해 주세요. 계속 반복되면 참조 번호와 함께 알려 주시면 확인하겠습니다."
          reference={error.digest}
          actions={[
            { kind: 'button', label: '다시 시도', onClick: reset, primary: true },
            { kind: 'link', label: '홈으로', href: '/' },
          ]}
        />
      </body>
    </html>
  );
}
