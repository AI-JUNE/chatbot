import type { Metadata, Viewport } from 'next';
import './globals.css';
/** 링크 미리보기(카카오톡·슬랙 등)에 쓰이는 절대 주소의 기준 — robots.txt·sitemap.xml 과 같은 출처. */
import { SITE_URL } from '@/lib/site';

const TITLE = 'GOWON Chat — 자료를 근거로 답하는 상담 챗봇';
const DESCRIPTION = '등록한 안내 자료를 근거로 AI가 1차 응대하고, 확인이 필요한 문의만 상담원에게 넘기는 상담 챗봇.';

/**
 * 글꼴 — **동적 서브셋**(unicode-range) 판을 쓴다.
 *
 * 종전에는 `static/pretendard.css`(서브셋 없는 통짜 9종)를 불러, 화면이 실제로 쓰는 굵기
 * 4종(400·600·700·800)만으로도 **첫 방문에 3.0MB**를 받았다(라이브 실측 748+767+773+775KB).
 * 이 비용은 랜딩만의 것이 아니다 — 같은 루트 레이아웃을 쓰는 `/widget` 이 **고객사 사이트의
 * 상담창**이라, 위젯을 심은 페이지의 방문자가 그 3.0MB 를 대신 치른다.
 *
 * 동적 서브셋 판은 글자 영역(unicode-range)별로 파일을 쪼개 **화면에 실제로 나온 글자의
 * 조각만** 받는다. 게다가 이 판은 가변 글꼴이라 굵기 4종이 한 벌을 나눠 쓴다 — 굵기가
 * 늘어도 내려받는 양이 늘지 않는다.
 *
 * 제공하는 family 이름은 `Pretendard Variable` 로, `globals.css` 의 `--font` 첫 이름과 같다.
 * 종전 판이 싣던 이름은 `Pretendard` 뿐이어서 **첫 이름은 한 번도 로드된 적이 없었다**(죽은 자리).
 * 두 값이 어긋나면 테스트가 실패한다.
 */
const FONT_ORIGIN = 'https://cdn.jsdelivr.net';
const FONT_CSS = `${FONT_ORIGIN}/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.css`;

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
        {/* 글꼴 CDN 은 **다른 출처**다 — 이 연결이 열리기 전에는 글자가 한 자도 그려지지 않는다.
          * 미리 손잡아 두면 DNS·TLS 왕복이 첫 화면 앞에서 빠진다(글꼴은 crossOrigin 요청이라 익명으로 연다). */}
        {/* 밝은 화면 한 벌임을 **CSS 가 오기 전에** 알린다 — globals.css 의 `:root{color-scheme}`
          * 와 같은 뜻이고, 자동 다크 테마 판정은 문서를 받는 그 순간에 난다. */}
        <meta name="color-scheme" content="light" />
        <link rel="preconnect" href={FONT_ORIGIN} crossOrigin="anonymous" />
        <link rel="stylesheet" href={FONT_CSS} />
      </head>
      <body>{children}</body>
    </html>
  );
}
