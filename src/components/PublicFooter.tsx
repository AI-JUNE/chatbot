/**
 * 공개 화면(랜딩·이용약관·개인정보 처리방침)의 푸터 — **한 벌**.
 *
 * 종전에는 두 화면이 각자 푸터 마크업을 들고 있었고(`page.tsx` · `LegalLayout.tsx`),
 * 그 내용은 가운데 정렬 12.5px 한 줄 + 링크 두 개였다 — 기준 원본 AICC Portal 랜딩의
 * `.foot`(1.4fr 1fr 1fr 1fr 4단 + `.foot-bot` 마무리 줄)과 다른 물건이었다. 그래서
 * ① 도입을 결정한 방문자가 **문의 창구를 찾을 곳이 마지막 CTA 하나**였고
 * ② 섹션·약관으로 가는 길이 상단바(좁은 화면에서는 가로 스크롤 칩)에만 있었고
 * ③ 두 화면의 푸터가 **사본 대조**로만 같았다(한쪽을 고치면 갈라진다 — DS 6-2·15-2).
 *
 * 규격(폭·글자·4단·누를 면 44px)은 `globals.css` 의 `.lp-foot*` 한 벌에서 온다 —
 * 여기에 인라인으로 적으면 좁은 화면 규칙도 인쇄 규칙도 이기지 못한다(DS 13-2·81-1).
 *
 * 운영자용 정보(관리 콘솔 주소·설치 스니펫)는 넣지 않는다 — 공개 화면의 원칙(§13)이고,
 * 약관·방침 화면에 `/admin` 이 0건이어야 한다는 불변식도 함께 지킨다.
 * 사업자등록번호·대표 연락처는 **확정 전이라 적지 않고 그 사실을 적는다**(지어낸 값 금지 §13).
 */
import Link from 'next/link';
import BrandMark from './BrandMark';
import { CONTACT_EMAIL, CONTACT_MAILTO } from '@/lib/site';

/** 섹션으로 가는 길 — 약관·방침에서도 눌릴 수 있게 **루트 기준**(`/#…`)으로 적는다. */
const PRODUCT = [
  ['/#trust', '동작 방식'],
  ['/#features', '기능'],
  ['/#channels', '채널'],
  ['/#steps', '도입 절차'],
] as const;

const SUPPORT = [
  ['/#faq', '자주 묻는 질문'],
  ['/#demo', '상담창 체험'],
] as const;

const LEGAL = [
  ['/terms', '이용약관'],
  ['/privacy', '개인정보처리방침'],
] as const;

export default function PublicFooter() {
  return (
    <footer className="lp-foot">
      <div className="lp-wrap lp-footin">
        <div className="lp-footgrid">
          <div>
            <Link href="/" className="lp-footbrand">
              <BrandMark size={28} />
              GOWON Chat
            </Link>
            <p className="lp-footabout">
              등록한 안내 자료를 근거로 AI가 1차 응대하고, 확인이 필요한 문의만 상담원에게 넘기는 상담 챗봇.
              <br />
              운영 주식회사 고원(GOWON) · 문의{' '}
              <a href={CONTACT_MAILTO} className="lp-footmail">{CONTACT_EMAIL}</a>
            </p>
          </div>

          {/* 묶음 제목이 곧 랜드마크 이름이다(`aria-labelledby`) — 이름을 따로 적으면 스크린리더가
            * 같은 말을 두 번 읽는다(들어갈 때 이름으로, 읽어 내려가며 글로). */}
          <nav aria-labelledby="foot-product" className="lp-footcol">
            <p className="lp-foottitle" id="foot-product">제품</p>
            {PRODUCT.map(([href, label]) => (
              <a key={href} href={href} className="lp-footlink">{label}</a>
            ))}
          </nav>

          <nav aria-labelledby="foot-support" className="lp-footcol">
            <p className="lp-foottitle" id="foot-support">도입·지원</p>
            {SUPPORT.map(([href, label]) => (
              <a key={href} href={href} className="lp-footlink">{label}</a>
            ))}
            <a href={CONTACT_MAILTO} className="lp-footlink">도입 문의 보내기</a>
          </nav>

          <nav aria-labelledby="foot-legal" className="lp-footcol">
            <p className="lp-foottitle" id="foot-legal">약관 및 정책</p>
            {LEGAL.map(([href, label]) => (
              <Link key={href} href={href} className="lp-footlink">{label}</Link>
            ))}
          </nav>
        </div>

        <div className="lp-footbot">
          <span className="lp-footnote">© GOWON Chat (데모) — 약관·방침은 초안이며 법률 검토 전입니다.</span>
          <span className="lp-footnote">사업자 등록 정보·대표 연락처는 확정 후 이 자리에 표기합니다.</span>
        </div>
      </div>
    </footer>
  );
}
