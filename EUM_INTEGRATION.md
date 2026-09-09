# 이음 2R 연동 과제 — 웹챗 (가이드 §6-3)

GPTs 대체. 이음 참여자 화면 우하단에 붙는 **FAQ·신청 안내 챗**. 2일 작업 크기. 안 되면 뺀다.

## 요건
- 임베드 스니펫(`embed.js`)으로 이음에 삽입 가능해야 함
- 지식: 이음 FAQ 10개(신청 방법·자격·활동 시간·인증 방법·활동확인서·안전 검증·개인정보·문의처·취소·보상) — `data/eum-faq.json`
- 답변 끝에 「신청은 이 버튼」 CTA(이음 URL 설정값)
- 답변 근거(FAQ 번호) 표시. 모르는 질문은 단정하지 않고 담당자 연결 안내
- AI 고지 유지. 로그는 audit 경유

## 과제
- [x] `data/eum-faq.json` 10개 작성 + 룰/KB 매칭에 로드
- [x] 테넌트 프리셋 `eum` — 시스템 프롬프트·CTA·색상(#BE5535)
- [x] 임베드 옵션 `data-tenant="eum"` 지원
- [x] 테스트 — FAQ 10개 각각 매칭 검증

## 사용법 (이음 화면에 삽입)

```html
<script src="https://chatbot-gowon.vercel.app/embed.js" data-tenant="eum" async></script>
```

- `data-tenant` 형식은 `^[a-z0-9][a-z0-9_-]{0,31}$`. 어긋나거나 모르는 값이면 무시하고 기본(고원) 위젯이 뜬다.
- 신청 버튼 주소는 환경변수 `EUM_APPLY_URL`로 바꾼다(미설정 시 `https://eum-app.vercel.app`).
  http(s) 절대 URL만 통과하고, 그 외 값은 기본값으로 되돌린다.

## 구현 구조

| 파일 | 역할 |
| --- | --- |
| `data/eum-faq.json` | FAQ 10건 원본(번호·주제·키워드·답변) |
| `src/lib/tenants.ts` | 프리셋(문구·색·CTA)·FAQ→KB 변환·URL 검증. 의존성 없는 순수 모듈 |
| `src/lib/tenantKB.ts` | FAQ JSON 정적 import + 변환 결과 캐시, 공개 설정 생성 |
| `src/lib/chat.ts` | 테넌트 대화 분기 — 테넌트 FAQ만 참조, 허용 룰만 적용, 모를 때 문구·CTA 부착 |
| `src/app/api/chat/route.ts` | `tenant` 입력 검증 후 엔진 전달, 로그에 테넌트 기록 |
| `src/app/widget/page.tsx` · `src/components/ChatWidget.tsx` | `?tenant=` 해석, 인사말·헤더·색·CTA 버튼·AI 고지 |
| `public/embed.js` (v0.3) | `data-tenant` 옵션 |
| `src/app/api/admin/tenants/route.ts` | 관리 콘솔용 **읽기 전용** 조회(GET만, `requireAdmin`) |
| `scripts/smoke.mjs` (`npm run smoke`) | 배포본에 실제 요청을 보내는 E2E 스모크 |

동작 규칙(품질 기준 반영)

- **근거 표시**: FAQ 항목의 출처 라벨이 `이음 FAQ 5. 활동확인서` 형태로 만들어져 답변 아래 근거 카드에 원문 인용과 함께 뜬다.
- **모르면 단정하지 않음**: 매칭 실패 시 "추측하지 않겠습니다 → 담당 코디네이터 연결" 안내로 넘어간다. 근접 FAQ가 있으면 번호 선택 후보만 함께 제시한다.
- **격리**: 테넌트 대화는 이음 FAQ만 보고, 고원 영업 룰과 관리 콘솔 커스텀 룰은 적용하지 않는다(다른 브랜드 문구 유출 방지). 인사·감사·종료·상담원 전환 룰만 이음 문구로 살려 둔다.
- **AI 고지**: 위젯 하단에 상시 노출(`AI 자동응답 · 등록된 안내 자료 기반 · 정확한 확인은 담당자 연결`).
- **기관마다 다른 값**(자격·활동 시간·보상)은 수치를 쓰지 않고 담당자 확인으로 안내한다 — 테스트가 임의 수치 유입을 막는다.

## 운영 점검 (심사 전 확인)

- **적재 확인**: `GET /api/health` → `dependencies.tenants` 에 `{ id: 'eum', entries: 10, skipped: 0, ctaUrl, ctaFromEnv }`.
  FAQ가 0건이거나 건너뛴 항목이 있으면 서비스 `status` 가 `degraded` 로 떨어진다 — 지식이 비어도 200을 돌려주는 상태를 정상으로 보지 않는다.
- **관리 콘솔 → 테넌트 지식** 탭: 배포본이 근거로 쓰는 FAQ 10건과 근거 라벨·신청 버튼 주소·AI 고지를 눈으로 확인한다.
  편집 기능은 없다(원본은 `data/eum-faq.json` 파일). 신청 주소가 "코드 기본값"으로 표시되면 `EUM_APPLY_URL` 미설정이다.
- **E2E 스모크**: `npm run smoke`(대상 변경은 `SMOKE_BASE_URL`). 라이브에 실제 요청을 보내
  health·embed.js·`/widget?tenant=eum`·이음 FAQ 답변(근거 번호·CTA)·모를 때 단정 금지·잘못된 입력 400 을 확인한다.
  종료코드 0 통과 / 1 검사 실패 / 2 대상 접속 불가(판정보류 — 실패와 구분). `.github/workflows/smoke.yml` 이 매일 07:00 KST 에 돌린다.

## 검증

- `node --test "tests/*.test.mjs"` — 213건 통과(이음 23건: FAQ 계약·매칭 20개 질의·근거 표시·CTA URL 차단·형식 오류 실패 경로·적재 상태·상세 조회·비밀값 미노출·배선 / 스모크 21건).
- `tsc --noEmit` 오류 0. 전 라우트 export 규칙 검사 통과.

## 남은 것

- 이음 실제 신청 URL 확정 시 `EUM_APPLY_URL` 설정 — 배포 환경변수 등록은 **[승인 필요]**.
- 이음 운영 기준(자격·활동 시간·보상)이 확정되면 FAQ 2·3·10 답변을 기관 기준으로 구체화.
- 관리 콘솔에서 테넌트 FAQ **편집**(현재는 조회만. 원본이 파일이라 편집은 저장소 도입 후).
- 스모크의 라이브 실행 기록 — 이 저장소 환경에서는 외부 네트워크가 막혀 판정보류(종료코드 2)로 끝난다.
  실제 라이브 판정은 GitHub Actions(`Smoke (live)`) 또는 사내망에서 `npm run smoke` 로 남긴다.
