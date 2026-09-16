'use client';

import type { CSSProperties } from 'react';
import SystemPage from '@/components/SystemPage';

/**
 * 루트 레이아웃까지 실패했을 때의 최후 화면 — 이때는 globals.css 가 없으므로 토큰을 인라인으로 준다.
 * 오류 내용은 싣지 않는다(참조 번호만).
 */
const TOKENS = {
  '--bg': '#F8FAFC', '--surface': '#FFFFFF', '--line': '#E2E8F0', '--ink': '#0F172A', '--sub': '#475569', '--mut': '#94A3B8',
  '--brand': '#2563EB', '--brand-600': '#1D4ED8', '--brand-50': '#EFF6FF', '--r-sm': '10px', '--r-lg': '18px',
  '--font': "'Pretendard Variable',Pretendard,-apple-system,system-ui,'Malgun Gothic',sans-serif",
  margin: 0,
} as CSSProperties;

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="ko">
      <body style={TOKENS}>
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
