/**
 * 응답 보안 헤더 — 종전에는 한 줄도 없었다(HSTS·nosniff·Referrer-Policy·frame-ancestors 전부 0건).
 *
 * 두 가지가 실제로 열려 있었다.
 * 1) **관리 콘솔이 아무 페이지에나 프레임으로 들어간다.** `/admin` 응답에 X-Frame-Options 도
 *    frame-ancestors 도 없어, 남의 페이지가 로그인된 콘솔을 iframe 으로 띄우고 그 위에 제 버튼을
 *    겹쳐 놓을 수 있다(클릭재킹). 콘솔 안에 있는 것은 대화 기록·상담원 요청의 연락처 원문·백업
 *    전체 내려받기다 — 운영자는 제 화면을 눌렀다고 생각한다.
 * 2) **내려받은 파일이 HTML 로 해석될 수 있다.** nosniff 가 없으면 브라우저가 선언된
 *    Content-Type 을 무시하고 본문을 훑어 타입을 고쳐 잡는다. 백업(JSON)·대화 로그(CSV)에는
 *    방문자가 상담창에 친 글자가 그대로 들어간다.
 *
 * ── frame-ancestors 를 전역으로 걸고 `/widget` 만 연다
 * 위젯은 **고객사 사이트 위에서 프레임으로 도는 것이 존재 이유**라 여기만은 막으면 안 된다.
 * 열어야 할 한 곳을 예외로 두는 편이, 막아야 할 곳을 하나씩 세는 것보다 안전하다 —
 * 나중에 화면이 하나 늘어도 기본이 「막힘」이다. 그래서 전역 규칙의 대상에서 `/widget` 을
 * 정규식으로 빼고(같은 헤더를 두 번 내보내면 브라우저가 **둘 다** 적용해 위젯이 막힌다),
 * X-Frame-Options 는 값에 「아무나 허용」이 없으므로 전역에 걸지 않고 콘솔 경로에만 덧댄다
 * (구형 브라우저용 2차 방어. 현행 브라우저는 frame-ancestors 가 이것을 이긴다).
 *
 * CSP 는 frame-ancestors 만 둔다. script-src 까지 조이려면 Next 의 인라인 스크립트에 nonce 를
 * 붙여야 하고, 그것은 미들웨어가 필요한 별도 작업이다 — 여기서 반쯤 걸면 화면이 죽는다.
 */

/** 모든 응답에 붙는다. 열 이름이 겹치면 뒤 규칙이 아니라 **둘 다** 나가므로 서로 겹치지 않게 나눈다. */
const BASE = [
  // 선언한 Content-Type 을 브라우저가 고쳐 잡지 못하게 한다(백업 JSON·로그 CSV·embed.js).
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // 외부로 나가는 요청에 경로·쿼리를 싣지 않는다. 위젯은 남의 사이트 위에서 돈다.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // 쓰지 않는 권한은 미리 닫는다 — 임베드된 프레임이 고객사 페이지의 권한을 요구하지 않게.
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()' },
  // https 로만 접속. preload 는 등록 신청이 따로 필요하므로 넣지 않는다.
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
];

/** 프레임 금지 — `/widget` 을 제외한 모든 경로. */
const NO_FRAME = [{ key: 'Content-Security-Policy', value: "frame-ancestors 'none'" }];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      { source: '/:path*', headers: BASE },
      // `/widget` 과 `/widget/...` 만 빼고 프레임을 막는다.
      { source: '/((?!widget(?:/|$)).*)', headers: NO_FRAME },
      // 콘솔·관리 API 는 구형 브라우저에도 못을 박는다(위젯과 경로가 겹치지 않아 안전).
      { source: '/admin/:path*', headers: [{ key: 'X-Frame-Options', value: 'DENY' }] },
      { source: '/api/admin/:path*', headers: [{ key: 'X-Frame-Options', value: 'DENY' }] },
    ];
  },
};
module.exports = nextConfig;
