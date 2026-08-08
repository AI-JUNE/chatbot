# Chatbot — 무인 콜센터 멀티채널 챗봇 (MVP)

Next.js 14 + TS. 웹 챗 위젯 + 대화 API(룰 + LLM 스텁). Callbot과 지식·시나리오 공유.
개발 규칙: OneDrive는 bash+python 편집, tsc 검증, build now / activate on approval(LLM 실키·개인정보·카톡 실연동은 승인 후).

## 진행 (공통 런치 P0)
- [x] /api/health + 인메모리 rate limit(chat 60/분·escalation 20/분·kakao 120/분, 429+Retry-After) — 2026-08-08, 커밋 5214021. Redis 전역화·Sentry는 [승인 필요]
- [ ] 다음: 표준 에러 포맷 모듈화(lib/http)·입력검증 스윕 → 이용약관/방침 초안 → 관리 콘솔 인증 게이트(플래그 OFF)
- 상세 기록: PMS\LAUNCH_BACKLOG.md C-2 섹션
