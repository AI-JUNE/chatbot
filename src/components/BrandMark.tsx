/** 브랜드 마크 — 말풍선 + 이니셜. 원본은 `src/app/icon.svg`(파비콘)이며 경로 데이터를 같이 쓴다(tests/unit.test.mjs 가 고정). */
const MARK_BODY = 'M7 2.5h18A5.5 5.5 0 0 1 30.5 8v11a5.5 5.5 0 0 1-5.5 5.5H13l-5 5v-5H7A5.5 5.5 0 0 1 1.5 19V8A5.5 5.5 0 0 1 7 2.5Z';
const MARK_G = 'M20.9 9.9A6 6 0 1 0 22 13.5h-5.2';

export default function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 32 32" style={{ flexShrink: 0 }}>
      <path d={MARK_BODY} fill="var(--brand, #2563EB)" />
      <path d={MARK_G} fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
