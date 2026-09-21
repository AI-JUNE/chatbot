import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

/**
 * `/robots.txt` — 종전에는 404 였다.
 *
 * 화면마다 `robots: { index: false }` 메타는 이미 붙어 있었지만(DS 4-5), 그것은 **크롤러가
 * 그 화면을 받아 본 뒤**에야 읽히는 표시다. 즉 검색 로봇은 `/admin` 로그인 화면과 `/widget`
 * 임베드 프레임을 매번 **실제로 요청한다**. `/api/*` 에는 메타를 붙일 자리조차 없다 —
 * 상담 API 는 POST 전용이라 크롤링으로 답이 나가지는 않지만, 요청은 요청대로 들어와
 * 호출 상한·로그를 갉아먹는다.
 *
 * 여기서 경로를 미리 잘라 **요청 자체가 오지 않게** 한다. 메타 표시는 그대로 둔다 —
 * robots.txt 는 「가져가지 마라」이고 메타는 「색인하지 마라」라서, 링크를 타고 들어온
 * 크롤러에게는 뒤쪽이 필요하다(둘은 대체재가 아니다).
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // 공개 화면은 랜딩·약관·개인정보 처리방침 셋뿐이다.
        disallow: ['/admin', '/api/', '/widget'],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
