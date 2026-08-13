# Chatbot — 무인 콜센터 멀티채널 챗봇 (MVP)

Next.js 14 + TS. 웹 챗 위젯 + 대화 API(룰 + LLM 스텁). Callbot과 지식·시나리오 공유.
개발 규칙: OneDrive는 bash+python 편집, tsc 검증, build now / activate on approval(LLM 실키·개인정보·카톡 실연동은 승인 후).

## 진행 (공통 런치 P0)
- [x] /api/health + 인메모리 rate limit(chat 60/분·escalation 20/분·kakao 120/분, 429+Retry-After) — 2026-08-08, 커밋 5214021. Redis 전역화·Sentry는 [승인 필요]
- [x] 표준 에러 포맷 모듈(src/lib/http.ts)·입력검증 스윕(전 API 라우트) — 2026-08-10. 오류 본문 `{ok:false, code, error, message}`(error는 기존 소비자 호환용 한국어 메시지), JSON 본문 크기 상한(기본 32KB·백업 1MB), 문자열 길이·타입 검증
- [x] 관리 콘솔 인증 게이트 스캐폴딩 — `requireAdmin()` 일원화 + `ADMIN_AUTH_REQUIRED` 플래그(기본 false, /api/health에 상태 노출). true 전환은 [승인 필요]
- [x] 이용약관·개인정보처리방침 초안(/terms·/privacy, 공용 LegalLayout·랜딩 푸터 링크) — 2026-08-12. '초안 — 법률 검토 전' 배지 표기, 실서비스 게시 확정은 [승인 필요]
- [x] 위젯 표준 오류 코드 소비 — ChatWidget errorText(): rate_limited(Retry-After 초 표기)·payload_too_large·invalid_input 등 코드별 사용자 문구, /api/chat·/api/escalation 실패 분기 공통 적용
- [ ] 다음: 관리 콘솔 로그인 UX 개선(토큰 검증 피드백·잠금 화면) → 위젯 임베드 스니펫(embed.js) 실제 제공 → 카카오 어댑터 오류 응답 정합 점검
- 상세 기록: PMS\LAUNCH_BACKLOG.md C-2 섹션
