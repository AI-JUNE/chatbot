import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'GOWON Chat — 자료를 근거로 답하는 상담 챗봇',
  description: '등록한 안내 자료를 근거로 AI가 1차 응대하고, 확인이 필요한 문의만 상담원에게 넘기는 상담 챗봇.',
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
