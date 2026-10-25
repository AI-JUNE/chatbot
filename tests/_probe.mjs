/**
 * 재감사에서 가설을 돌려 보던 **임시 스크립트의 잔재**입니다.
 *
 * 내용은 모두 정식 테스트로 옮겼습니다 — `tests/runtime.test.mjs`(DS 65-1·65-3 — `lib/num` 의
 * `parseNumber`·`envNumber` 와 월 이용료·수수료율·정산 리포트를 실제로 돌린다)·
 * `tests/console.test.mjs`(DS 65-2 — 콘솔의 `parseNum` 사본을 lib 과 값 묶음으로 대조한다)·
 * `tests/unit.test.mjs`(DS 65-1·65-3 — 배선과 「제 식으로 읽는 자리 0건」).
 * 이 파일은 `node --test "tests/*.test.mjs"` 대상이 아닙니다
 * (자동 실행 세션에서 파일 삭제가 허용되지 않아 지우지 못했습니다 — 그냥 지우면 됩니다).
 */
export {};
