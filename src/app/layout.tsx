import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '고원 챗봇 — 무인 상담 멀티채널',
  description: '웹·카카오 채널에서 AI가 1차 응대하고, 필요할 때만 상담원으로 연결하는 무인 상담 챗봇.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <head>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.css" />
      </head>
      <body>{children}</body>
    </html>
  );
}
