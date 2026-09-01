# Chatbot — 무인 콜센터 멀티채널 챗봇 (MVP)

Next.js 14 + TS. 웹 챗 위젯 + 대화 API(룰 + LLM 스텁). Callbot과 지식·시나리오 공유.
개발 규칙: OneDrive는 bash+python 편집, tsc 검증, build now / activate on approval(LLM 실키·개인정보·카톡 실연동은 승인 후).

## 진행 (공통 런치 P0)
- [x] /api/health + 인메모리 rate limit(chat 60/분·escalation 20/분·kakao 120/분, 429+Retry-After) — 2026-08-08, 커밋 5214021. Redis 전역화·Sentry는 [승인 필요]
- [x] 표준 에러 포맷 모듈(src/lib/http.ts)·입력검증 스윕(전 API 라우트) — 2026-08-10. 오류 본문 `{ok:false, code, error, message}`(error는 기존 소비자 호환용 한국어 메시지), JSON 본문 크기 상한(기본 32KB·백업 1MB), 문자열 길이·타입 검증
- [x] 관리 콘솔 인증 게이트 스캐폴딩 — `requireAdmin()` 일원화 + `ADMIN_AUTH_REQUIRED` 플래그(기본 false, /api/health에 상태 노출). true 전환은 [승인 필요]
- [x] 이용약관·개인정보처리방침 초안(/terms·/privacy, 공용 LegalLayout·랜딩 푸터 링크) — 2026-08-12. '초안 — 법률 검토 전' 배지 표기, 실서비스 게시 확정은 [승인 필요]
- [x] 위젯 표준 오류 코드 소비 — ChatWidget errorText(): rate_limited(Retry-After 초 표기)·payload_too_large·invalid_input 등 코드별 사용자 문구, /api/chat·/api/escalation 실패 분기 공통 적용
- [x] 임베드 스니펫 v0.2(public/embed.js) — 닫힘 시 버블 크기(104px)만 차지해 호스트 페이지 클릭 방해 없음, /widget → 부모 postMessage(`gowon-chat/resize`)로 열림/닫힘 크기 동기화, origin 검증, `data-position/offset/z` 옵션, 뷰포트 초과 방지, `window.__gowonChat.remove()` — 2026-08-13
- [x] ChatWidget `embedded` prop(임베드 시 버블부터 시작) + 토글 버튼 aria-label/aria-expanded 상태 반영
- [x] 관리 콘솔 로그인 UX — /api/admin/auth 토큰 검증 엔드포인트(200+상태 플래그·사유, IP당 30회/분), 잠금 화면(토큰 입력·Enter/확인·피드백), 헤더 인증 상태 칩(인증됨/미인증/개방 모드), 데이터 API 401 시 자동 잠금 전환 — 2026-08-13. `ADMIN_AUTH_REQUIRED=true` 실전환은 [승인 필요]
- [x] 카카오 어댑터 오류 응답 정합 — rate limit 초과 시 429 대신 200 + 안내 말풍선(카카오는 4xx를 스킬 오류로 처리, 처리 스킵으로 부하 차단은 동일). 스킬 토큰 불일치는 401 유지(연동 설정 오류는 크게 드러나야 함) — 2026-08-13
- [x] 대화 품질 — 동의어·오타 보정 모듈(src/lib/normalize.ts): 자모(초·중·종성) 분해 + 근사 부분문자열 매칭(Sellers)으로 "삼담원→상담원" 같은 오타를 흡수, 동의어 그룹 17종(카톡/카카오톡, 요금/가격/견적 등)을 키워드 확장 방식으로 적용(원문 치환 없음). KB 매칭·커스텀 룰 매칭에 공통 반영, 정확 일치 > 동의어 > 오타 순 가중치 — 2026-09-01
- [x] 인텐트 룰 확장 7종 → 18종 — 환불·해지·영수증·예약/변경·배송·위치·연락처·설치연동·개인정보·긴급 추가. 구체 인텐트를 앞, 광범위 인텐트(상담원/불만)를 뒤로 재배치하고 `deny` 패턴으로 오탐 차단(예: "환불 얼마"가 요금 인텐트로 새지 않음). 룰은 원문·압축형(공백 제거) 양쪽에 매칭
- [x] 근거 문장 인용 — KB 답변에 출처 항목과 원문 문장을 함께 표시(`ChatReply.citation`). 답변 문장 중 질의와 가장 관련 높은 문장을 **원문 그대로** 인용(LLM 생성 요약 아님). 웹 위젯·카카오 응답·관리 콘솔 응답 테스트에 모두 노출
- [x] 지식 문서 업로드·청킹(src/lib/ingest.ts + `/api/admin/kb/import`) — 마크다운 제목(`#`)·번호 제목(`1.`, `제1조`)·문단 경계로 청킹, 조사·어미 제거 기반 키워드 자동 추출, 제목 경로를 출처 라벨로 부여. **기본은 미리보기(dry-run)이고 `commit:true`일 때만 등록**, 관리 콘솔 KB 탭에 붙여넣기·미리보기·등록 UI. 임베딩 기반 시맨틱 검색·파일 스토리지는 [승인 필요]
- [ ] 다음: 신뢰도 임계 기반 상담원 자동 전환(연속 폴백 감지·대화 요약 전달) → 대화 로그 보존기간 정책(스텁) → AICC-Core Flow 노드·채널 렌더러 스키마 정합 → 위젯 접근성(키보드 포커스 트랩)
- 상세 기록: PMS\LAUNCH_BACKLOG.md C-2 섹션
