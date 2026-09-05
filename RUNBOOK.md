# 운영 런북 (RUNBOOK) — 챗봇

대상: 고원 챗봇(Next.js 14 / Vercel). 최종 갱신 2026-09-02.
이 문서는 **장애·복구 상황에서 그대로 따라 하는 절차서**다. 추정이나 예시가 아니라 실제 동작하는 명령만 적는다.

---

## 0. 30초 상태 점검

```bash
curl -s https://chatbot-gowon.vercel.app/api/health | jq
```

| 항목 | 정상 | 이상일 때 |
|---|---|---|
| `ok` | `true` | 배포 실패 → §4 롤백 |
| `flags.monitoring` | 운영 `true` | `false`면 `SENTRY_DSN` 미설정 → §3 |
| `flags.adminAuthRequired` | 현재 `false`(승인 전) | 승인 후 `true` 여야 함 |
| `build.commit` | 배포하려던 커밋 앞 7자리 | 다르면 배포 미반영 |
| `status` | `ok` | `degraded`면 저장소 오류 → §1-1 |
| `dependencies.storage.driver` | `file`(단일서버) / `memory` | 예상과 다르면 `STORAGE_DRIVER` 확인 |
| `dependencies.storage.namespaces[].health` | `ok` 또는 `empty` | `error`면 `lastError` 확인, `readonly`면 Vercel 정상(백업 API 사용) |

응답 헤더/로그 상관관계 키는 `x-request-id`. 고객 문의 시 이 값을 받아 로그에서 바로 찾는다.

---

## 1. 무엇을 백업하는가

저장은 `src/lib/storage.ts` 어댑터가 담당한다(드라이버 `memory` | `file`, 네임스페이스별 파일 `<STORAGE_DIR>/<ns>.json`).

| 데이터 | 네임스페이스 | 저장 여부 | 백업 방법 | 개인정보 |
|---|---|---|---|---|
| KB(지식), 룰 오버라이드, 커스텀 룰 | `admin` | 저장(파일 드라이버) | `/api/admin/backup` GET | 없음 |
| 감사 로그 | `audit` | 저장(파일 드라이버) | `/api/admin/audit?format=csv` | 없음 |
| 파트너·고객사 계약 귀속 | `partners` | 저장(파일 드라이버) | `/api/admin/backup` GET(`partners` 키) | 없음(담당자 이름만, 연락처 미저장) |
| 상담 티켓 | `tickets` | **미저장 — `PERSIST_PII=true` [승인 필요]** | 승인 전 없음(메모리) | 있음 |
| 대화 로그 | `convlog` | **미저장 — `PERSIST_PII=true` [승인 필요]** | 승인 전 없음(메모리) | 있음 |

관련 환경변수: `STORAGE_DRIVER`(기본 `file`) · `STORAGE_DIR`(기본 `<cwd>/data`) · `PERSIST_PII`(기본 미설정=차단) ·
`ADMIN_PERSIST=false`(전체 저장 끄기) · `ADMIN_PERSIST_FILE`(admin 경로 지정, 하위 호환).

> Vercel 런타임은 파일시스템이 읽기전용·휘발성이다. 이 경우 저장은 실패하지만 **조용히 넘어가지 않는다** —
> 상태가 `readonly`로 표시되고(`/api/health`, `/admin` → 감사 로그 탭 → 저장소 상태) 서비스는 메모리로 계속 동작한다.
> **Vercel 환경의 유일한 백업 수단은 `/api/admin/backup` 스냅샷이다.**

### 1-1. 저장소가 `error` 상태일 때

1. `/api/health` → `dependencies.storage.namespaces[].lastError` 에서 코드 확인(`ENOTDIR`·`ENOENT` 등).
2. `EROFS`·`EACCES`는 `readonly`로 분류되며 Vercel에서는 정상이다(조치 불필요, 백업 API 사용).
3. 그 외 코드면 `STORAGE_DIR` 경로·권한을 확인한다. 데이터는 메모리에 남아 있으므로 **먼저 `/api/admin/backup`으로 내보낸 뒤** 조치한다.
4. 급하면 `ADMIN_PERSIST=false`로 저장을 끄고(메모리 운영) 백업 API로 콘텐츠를 보존한다.

---

## 2. 백업 (일 1회 · 콘텐츠 변경 직후 필수)

```bash
# ADMIN_TOKEN 이 설정된 환경
curl -s -H "x-admin-token: $ADMIN_TOKEN" \
  https://chatbot-gowon.vercel.app/api/admin/backup \
  -o "backup-$(date +%Y%m%d-%H%M).json"

# 무결성 확인 — kb 건수가 0이면 저장하지 말 것
jq '{version, savedAt, kb: (.kb|length), rules: (.customRules|length)}' backup-*.json
```

브라우저에서는 `/admin` → 백업 내려받기 (또는 `?token=` 쿼리) 로도 같은 파일을 받는다.
보관: 최근 14개 + 월말본 12개월. 스냅샷에는 개인정보가 없으므로 일반 사내 스토리지에 보관 가능.

---

## 3. 복구 절차

### 3-1. 콘텐츠 유실(KB·룰이 기본값으로 돌아감)

원인: 인스턴스 재시작 또는 잘못된 복원. 소요 1~2분.

```bash
# 1) 복원 전 현재 상태를 먼저 뜬다(되돌릴 여지 확보)
curl -s -H "x-admin-token: $ADMIN_TOKEN" .../api/admin/backup -o pre-restore.json

# 2) 복원 — 전체 교체(무효 항목은 건너뛴다)
curl -s -X POST -H "x-admin-token: $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  --data @backup-YYYYMMDD-HHMM.json .../api/admin/backup

# 3) 응답의 kb/overrides/customRules(및 partners/accounts) 건수가 백업본과 같은지 확인
jq '{kb:(.kb|length), rules:(.customRules|length), partners:(.partners.partners|length), accounts:(.partners.accounts|length)}' backup-YYYYMMDD-HHMM.json
```

- 복원은 **되돌릴 수 없는 전체 교체**다. 1단계(pre-restore)를 건너뛰지 않는다.
- 본문 상한 1MB(`MAX_IMPORT_BYTES`). 초과 시 `payload_too_large` 로 거부된다.
- 복원 이력은 감사 로그(`backup.restore`)에 남는다 → `/api/admin/audit`.
- `partners` 키가 없는 예전 백업도 그대로 복원되며, 이때 기존 파트너·귀속 데이터는 **지워지지 않는다**.
  파트너 스냅샷만 형식이 어긋난 경우 응답의 `partnersError`에 사유가 담긴다(조용히 넘어가지 않는다).

### 3-2. 모니터링이 꺼져 있음 (`flags.monitoring:false`)

Vercel 프로젝트 환경변수에 `SENTRY_DSN` 추가 → 재배포. DSN 미설정 상태에서도 서비스는 정상 동작한다(no-op).

### 3-3. 대화 API 오류가 급증

1. 로그에서 `"event":"request"` 중 `status>=500` 또는 `code:"engine_error"` 를 집계한다.
2. `x-request-id` 로 개별 요청을 추적한다(로그에는 대화 본문·연락처가 없다. 재현은 고객 동의 후 별도 수집).
3. 대화 엔진 오류는 고객에게 **상담원 연결 안내로 폴백**되며 오류를 삼키지 않는다(모니터링 전송 + 로그 기록).
4. 원인이 배포라면 §4.

### 3-4. 전체 장애

Vercel 대시보드 → Deployments → 직전 정상 배포 **Promote to Production**. 콘텐츠는 §3-1로 복원.

---

## 4. 롤백

```bash
git revert <commit> && git push   # 코드 되돌리기(자동 배포)
```
또는 Vercel에서 직전 배포 Promote(수초 내 반영, 코드 변경 없음). **먼저 Promote로 서비스를 세우고, 원인 수정은 그다음.**

---

## 5. 복구 리허설 기록

복구 절차가 문서에만 있고 실제로는 동작하지 않는 사고를 막기 위해, 스냅샷 export → 유실 → import 복구를
**자동화 테스트로 매 실행 검증**한다(`tests/runtime.test.mjs`, TS를 실제 컴파일해 실행).

```bash
node --test "tests/*.test.mjs"
```

| 일시 | 방식 | 시나리오 | 결과 |
|---|---|---|---|
| 2026-09-02 | 자동(runtime 테스트) | KB 항목·룰 오버라이드 생성 → 전체 유실 → 백업본 복원 | 성공 · 건수·항목·오버라이드 일치 |
| 2026-09-02 | 자동(runtime 테스트) | 손상 스냅샷 6종(null·문자열·필드 누락 등) 복원 시도 | 전부 거부 · 기존 데이터 보존 |
| 2026-09-02 | 자동(runtime 테스트) | 무효 항목 섞인 스냅샷 복원 | 유효 1건만 반영 · 나머지 건너뜀 |

- **미실시:** 운영 환경 실기동 리허설(실제 Vercel 인스턴스 대상). 콘텐츠 전체 교체를 동반하므로 **[승인 필요]**.
- 다음 리허설: 관리자 인증(`ADMIN_AUTH_REQUIRED=true`) 전환 시점에 운영 대상 1회.

---

## 6. 연락·에스컬레이션

| 상황 | 조치 |
|---|---|
| 서비스 다운 | Vercel 직전 배포 Promote → 원인 분석 |
| 콘텐츠 유실 | §3-1 |
| 개인정보 유출 의심 | 즉시 서비스 담당자 보고. 로그·모니터링에는 마스킹된 값만 남으나, 원본 유입 경로(입력 폼·상담 이관)를 우선 점검 |
| 고객 문의(특정 대화) | `x-request-id` 확보 → 로그 조회. 대화 본문은 로그에 없으므로 고객 동의 후 별도 확인 |

> 담당자·연락처·근무시간은 계약 확정 후 사람이 채운다(임의 기재 금지).

---

## 승인 대기 스위치 (build now, activate on approval)

코드는 완성되어 있고 **환경변수만 켜면 동작**한다. 켜기 전 확인 사항을 함께 적는다.
모든 값은 Vercel 환경변수로만 설정한다(코드·저장소에 시크릿을 두지 않는다).

### 1. LLM 생성 답변 — `CHAT_LLM_LIVE`

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `CHAT_LLM_LIVE` | `false` | **[승인 필요]** `true` 여야 생성 모델을 호출한다. `false`면 네트워크 호출 자체가 없다 |
| `CHAT_LLM_PROVIDER` | `anthropic` | `anthropic` 또는 `openai`(OpenAI 호환 엔드포인트 포함) |
| `CHAT_LLM_MODEL` | 프로바이더 기본값 | 모델 식별자 |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | 없음 | 없으면 호출 없이 `not_configured` 로 실패 → 결정적 폴백 |
| `CHAT_LLM_BASE_URL` | 프로바이더 기본값 | 사설 게이트웨이 사용 시 |
| `CHAT_LLM_MAX_INPUT_CHARS` | `6000` | 초과분은 **오래된 턴부터** 버린다(마지막 질문은 보존) |
| `CHAT_LLM_MAX_OUTPUT_TOKENS` | `400` | 생성 상한 |
| `CHAT_LLM_TIMEOUT_MS` | `8000` | 초과 시 `timeout` 처리 |
| `CHAT_LLM_RETRIES` | `1` | 429·5xx·네트워크 오류에만 재시도(4xx는 재시도 안 함) |
| `CHAT_LLM_MAX_CALLS_PER_MINUTE` | `60` | 인스턴스당 비용 안전장치 |

동작 보장:

- 근거 자료(연관 FAQ)가 없으면 **생성하지 않는다**(환각 방지). 룰·KB 답변은 LLM을 거치지 않는다.
- 실패하면 LLM이 꺼져 있을 때와 **동일한 결정적 폴백 답변**이 나가고, 사유는 구조화 로그에 `llm_<사유>` 로 남는다.
- 성공한 답변에는 AI 생성 고지가 붙는다.
- 연속 실패가 쌓이면 30초간 호출을 차단한다(서킷). `/api/health` 로 상태 확인.

켜기 전 점검: ① 키가 환경변수에만 있는가 ② 월 비용 상한을 프로바이더 콘솔에서 걸었는가
③ `CHAT_LLM_MAX_CALLS_PER_MINUTE` 가 예상 트래픽에 맞는가 ④ 개인정보 마스킹 동작을 스테이징에서 눈으로 확인했는가.

### 2. 카카오 채널 웹훅 — `KAKAO_CHANNEL_LIVE` · 서명

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `KAKAO_CHANNEL_LIVE` | `false` | **[승인 필요]** 채널 실연동 표시 |
| `KAKAO_SKILL_TOKEN` | 없음 | 설정 시 `x-skill-token` 일치 필수(상수 시간 비교) |
| `KAKAO_WEBHOOK_SECRET` | 없음 | 설정 시 HMAC 서명 검증 필수 |
| `KAKAO_SIGNATURE_REQUIRED` | `false` | `true` + 시크릿 없음 → **전면 차단**(설정 누락을 조용한 무방비로 두지 않는다) |

서명 규격: `HMAC-SHA256(secret, "v1:" + timestamp + ":" + 원문본문)` 의 hex.
헤더는 `x-kakao-signature`(`v1=` 접두 허용) · `x-kakao-timestamp`(초 또는 밀리초). 허용 시간창 ±5분.

재시도(중복 전달): 같은 이벤트가 다시 오면 대화 엔진을 **다시 돌리지 않고** 이전 응답을 그대로 반환한다
(티켓 중복 접수·대화 로그 중복 방지). 판정 캐시는 인스턴스 단위 60초 — 전역 멱등은 공유 저장소 도입 후 **[승인 필요]**.

상태 확인: `GET /api/kakao/webhook` → `live`, `signature.configured`, `signature.required` (시크릿 값은 노출하지 않는다).

### 3. 관리자 인증 — `ADMIN_AUTH_REQUIRED`

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `ADMIN_AUTH_REQUIRED` | `false` | **[승인 필요]** `true` 면 모든 관리 API에 토큰 요구. `ADMIN_TOKEN` 미설정 시 전면 차단 |
| `ADMIN_TOKEN` | 없음 | 관리 토큰. 비교는 상수 시간 |
| `ADMIN_LOCK_THRESHOLD` | `5` | 연속 실패 이 횟수에서 잠금 |
| `ADMIN_LOCK_MINUTES` | `10` | 잠금 지속 시간(분) |

잠금은 **토큰을 실제로 제시한 실패**만 센다. 성공하면 즉시 해제되고, 잠긴 동안 추가 실패는 잠금을 연장하지 않는다.
잠금 범위는 인스턴스 단위(IP 기준) — 전역 공유는 공유 저장소 도입 후 **[승인 필요]**.

운영자가 잠금에 걸렸을 때: 잠금 시간이 지나면 자동 해제된다. 즉시 해제가 필요하면 재배포(인스턴스 교체)로 초기화된다.

### 4. 파트너 담당자 로그인(partner_admin) — `PARTNER_PORTAL_ENABLED`

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PARTNER_PORTAL_ENABLED` | `false` | **[승인 필요]** `true` 여야 파트너 토큰을 조회한다. `false`면 파트너 토큰은 존재해도 무시된다 |
| `PARTNER_TOKENS` | 없음 | `PTR-0001:토큰,PTR-0002:토큰2` 형식. 토큰은 **16자 이상**이어야 하며 짧거나 형식이 틀리면 조용히 버려진다 |
| `PARTNER_DEFAULT_FEE_RATE_BP` | 없음 | 파트너별 수수료율이 없을 때의 기본값(bp). 미설정이면 `null` = "미설정"으로 표시하고 정산 금액을 산출하지 않는다 |

권한 범위:

- 파트너 담당자는 **읽기 전용**이다(등록·수정·삭제는 403). 귀속·계약 정보를 파트너가 직접 고치면 정산 근거의 신뢰가 무너진다.
- 조회 범위는 요청 파라미터와 무관하게 자기 파트너로 **강제 고정**된다(`lib/rbac.scopeAccountFilter` 한 관문).
- 관리 콘솔은 조회 전용 계정에서 쓰기 UI를 감추고 안내 문구를 띄운다(서버는 별도로 403으로 막는다).

켜기 전 점검: ① 토큰을 파트너별로 다르게 발급했는가 ② `ADMIN_TOKEN` 과 다른 값인가
③ `/api/health` 의 `flags.partnerPortal.credentials` 수가 예상과 맞는가(값은 노출되지 않는다) ④ 파트너 계정으로 로그인해 **다른 파트너 고객사가 보이지 않음**을 확인했는가.

### 5. 정산 리포트

`GET /api/admin/settlement?month=YYYY-MM[&partnerId=PTR-0001][&format=csv]`

산출 규칙(모두 **입력된 값만** 사용한다):

- 대상 = 계약 상태(`contracted`) + 계약일이 기간 말일 이전인 파트너 귀속 고객사.
- 수수료 = 월 이용료(`monthlyFeeKrw`, 사람이 계약서 보고 입력) × 수수료율(bp) ÷ 10000, **원 단위 절사**.
- 월 이용료나 수수료율이 없으면 **0원으로 계산하지 않고** 미산출로 남기고 합계에서 제외한다. 합계는 `partial: true` 로 표시된다.
- 해지일을 기록하지 않으므로 기간 중 해지분은 현재 상태 기준으로 제외된다(리포트 주석에 명시).
- CSV 내보내기는 감사 로그(`settlement.export`)에 남는다.

**이 리포트는 산출 근거 자료이며 청구서가 아니다.** 실제 청구·지급은 계약서 확정 후 **[승인 필요]**.
