import type { MetadataRoute } from 'next';
import { SITE_URL, LEGAL_UPDATED } from '@/lib/site';

/**
 * `/sitemap.xml` — 종전에는 404 였다(robots.txt 와 같은 자리).
 *
 * 공개 화면은 셋뿐이다: 랜딩·이용약관·개인정보 처리방침. 약관과 방침은 랜딩 푸터에서만
 * 링크되는데, 도입을 검토하는 쪽이 **가장 먼저 찾아 읽는** 두 장이다 — 검색으로 바로 닿게 한다.
 * 관리 콘솔·위젯 프레임·API 는 여기에도, robots.txt 에도 넣지 않는다.
 *
 * 날짜는 배포 시각이 아니라 **문서가 실제로 바뀐 날**을 적는다. 배포마다 오늘 날짜를 찍으면
 * 검색엔진이 「매일 바뀌는 문서」로 읽고 다시 오지 않는다 — 지어낸 수치를 화면에 싣지 않는
 * 것과 같은 이유다(§13). 문안을 고치면 이 값을 함께 고친다.
 */

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE_URL}/`, changeFrequency: 'weekly', priority: 1 },
    { url: `${SITE_URL}/terms`, lastModified: LEGAL_UPDATED, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${SITE_URL}/privacy`, lastModified: LEGAL_UPDATED, changeFrequency: 'yearly', priority: 0.3 },
  ];
}
