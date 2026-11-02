/**
 * 배포 주소의 단일 출처.
 *
 * 링크 미리보기의 절대 주소(layout.tsx 의 metadataBase)·robots.txt 의 sitemap 줄·
 * sitemap.xml 의 각 항목이 **같은 값**을 봐야 한다. 세 곳이 각자 기본값을 들고 있으면
 * 배포 주소가 바뀔 때 한 곳만 남아 미리보기 이미지가 깨지거나 사이트맵이 옛 도메인을 가리킨다.
 * 배포 주소가 바뀌면 NEXT_PUBLIC_SITE_URL 하나만 바꾼다.
 */
const FALLBACK = 'https://chatbot-gowon.vercel.app';

function resolve(): string {
  const raw = (process.env.NEXT_PUBLIC_SITE_URL || '').trim();
  if (!raw) return FALLBACK;
  try {
    const u = new URL(raw);
    // http(s) 가 아닌 값(javascript: 등)은 받지 않는다. 끝의 `/` 는 떼어 이어 붙이기 쉽게 한다.
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return FALLBACK;
    return u.origin;
  } catch {
    return FALLBACK;
  }
}

export const SITE_URL = resolve();

/**
 * 약관·개인정보 처리방침의 시행일. 두 화면의 `updated` 와 sitemap 의 `lastModified` 가
 * **같은 값**을 봐야 한다 — 사이트맵이 배포 시각을 찍으면 검색엔진은 「매일 바뀌는 문서」로
 * 읽고 다시 오지 않고, 화면과 다른 날짜를 찍으면 그 자체가 틀린 정보다.
 * 문안을 고치면 여기 하나만 고친다(확정본 반영은 [승인 필요] — COMMERCIAL_READINESS).
 */
export const LEGAL_UPDATED = '2026-08-12';

/**
 * 도입 문의 창구 — 공개 화면에서 **메일로 가는 길은 이 한 값**에서만 나온다.
 *
 * 종전에는 최종 CTA 의 `href` 안에 주소와 제목이 손으로 인코딩되어 박혀 있었다
 * (`mailto:…?subject=%EB%8F%84%EC%9E%85%20…`). 푸터가 같은 창구를 한 번 더 안내하게 되면
 * 그 사본이 두 벌이 되고, 주소가 바뀔 때 한쪽만 남는다 — DS 6-2·15-2 가 되풀이해 고친 자리다.
 * 주소는 기준 원본 AICC Portal 랜딩 푸터가 공개하는 것과 **같은 값**이다(지어낸 주소가 아니다).
 * 고객사 전용 창구(메일 또는 폼 수신처)로 바꿀 때 고칠 자리는 여기 하나다 — [승인 필요].
 */
export const CONTACT_EMAIL = 'gowonceo@gmail.com';
export const CONTACT_SUBJECT = 'GOWON Chat 도입 문의';
export const CONTACT_MAILTO = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(CONTACT_SUBJECT)}`;
