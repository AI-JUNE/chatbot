import type { Metadata, Viewport } from 'next';
import './globals.css';

const TITLE = 'GOWON Chat — 자료를 근거로 답하는 상담 챗봇';
const DESCRIPTION = '등록한 안내 자료를 근거로 AI가 1차 응대하고, 확인이 필요한 문의만 상담원에게 넘기는 상담 챗봇.';

/** 링크 미리보기(카카오톡·슬랙 등)에 쓰이는 절대 주소의 기준. 배포 주소가 바뀌면 NEXT_PUBLIC_SITE_URL 로 덮어쓴다. */
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://chatbot-gowon.vercel.app';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: 'GOWON Chat',
  // 미리보기 이미지는 app/opengraph-image.png · twitter-image.png(파일 규약)이 자동으로 붙는다(DS 4-5).
  openGraph: { type: 'website', locale: 'ko_KR', siteName: 'GOWON Chat', title: TITLE, description: DESCRIPTION, url: '/' },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // 브랜드 primary — globals.css 의 --brand 와 같은 값(메타 태그는 var() 를 쓸 수 없다).
  themeColor: '#2563EB',
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
