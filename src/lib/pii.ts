// 개인정보를 가리는 규칙 — 단일 출처 (DS 39-1·39-2·39-3).
//
// 왜 한 파일인가: 종전에는 마스킹이 **두 벌**이었다.
//  - `handoff.maskPii` — 이관 요약·수집 정보 확인 문구(운영자·상담원이 읽는 자리)
//  - `monitoring.scrub` — 서버 로그·오류 리포트·**외부 LLM 호출 본문**(우리 울타리를 넘는 자리)
//
// 규칙이 두 벌이면 한쪽을 고쳐도 다른 쪽은 그대로다. 실제로 어긋나 있었다 — 하이픈 없는
// 계좌번호(`110212345678`)는 이관 요약에서는 `***-****-****` 로 가려지는데 `scrub` 의 계좌
// 규칙은 하이픈을 필수로 둬서(`\d{2,3}-\d{2,6}-\d{2,6}`) 그대로 통과했다. **안에서는 가리고
// 밖으로는 내보낸 것**이다. 예약 일시 보호(`2026-09-04` 를 계좌로 읽지 않기)도 한쪽에만 있었다.
//
// 「규칙은 한 벌」은 이 파일 안에서 끝나지 않는다 (DS 52-1). 연락처를 **받아 적는 쪽**
// (`chat.extractContact`)이 자기 패턴을 따로 들고 있으면, 받아 적을 수는 있는데 가릴 수는 없는
// 모양이 생긴다 — 점으로 적은 번호(`010.1234.5678`)가 그랬다. 그래서 전화번호 패턴 원문은
// 여기(`PHONE_PATTERN`)에 두고 두 쪽이 **같은 글**을 쓴다.
//
// 가리는 **세기**는 받는 쪽에 따라 다르다 — 규칙은 하나, 치환은 둘이다.
//  - `readable` : 운영자·상담원이 읽는 자리. 끝 네 자리를 남겨 「그 번호가 맞는지」 확인에 쓴다.
//  - `opaque`   : 우리 울타리를 넘는 자리(외부 LLM·오류 리포트·서버 로그). 아무것도 남기지 않는다
//                 — 생년월일(주민번호 앞 6자리)·이메일 도메인도 남기지 않는다.
//
// 이 파일은 아무것도 import 하지 않는다 — 로깅·모니터링·엔진이 모두 여기를 보기 때문에
// 거꾸로 의존하면 순환이 생긴다(`limits.ts`·`kst.ts` 와 같은 자리다).
//
// 규칙 출처: AICC-Core `src/core/policyGuard.ts` §10.3.

/** 가리는 세기 — 받는 쪽이 우리 안인가(읽어야 한다) 밖인가(아무것도 남기지 않는다). */
export type MaskStrength = 'readable' | 'opaque';

/**
 * 마스킹 종류의 화면 표시명. `name` 은 저장·집계용 코드이고(교차 저장소 리포트가 이 어휘를 본다),
 * 운영자 화면에 뜨는 것은 이쪽이다 — 요약 평문이 관리 콘솔 서랍에 그대로 그려지므로
 * 「개인정보 마스킹: email, phone」처럼 영문 코드가 보이면 안 된다(DS 22-x).
 */
export const PII_KIND_LABELS: Record<string, string> = {
  rrn: '주민등록번호',
  card: '카드번호',
  phone: '휴대폰 번호',
  email: '이메일 주소',
  account: '계좌번호',
};

/** 마스킹 종류 코드 → 표시명. 모르는 코드는 그대로 두지 않고 「개인정보」로 뭉갠다. */
export function maskKindLabel(kind: string): string {
  return PII_KIND_LABELS[kind] ?? '개인정보';
}

/** 종류 코드 목록 → 표시명 목록(순서 유지). 화면·CSV 에 그대로 쓸 수 있다. */
export function piiKindLabels(kinds: readonly string[] | undefined): string[] {
  return (kinds ?? []).map(maskKindLabel);
}

/**
 * **전각으로 적은 것을 같은 글자로 모은다 — 글자 수는 바뀌지 않는다** (DS 70-1).
 *
 * 전각 영숫자·기호(`０`·`＠`·`－`)는 한글(HWP)·PDF·사내 시스템에서 붙여 넣은 글과 전각 입력
 * 상태의 모바일·일본어·중국어 자판에서 그대로 들어온다. 이 파일의 규칙은 전부 `\d`·`\w`
 * (아스키)로 적혀 있어서, 전각으로 적힌 연락처에는 **한 줄도 걸리지 않았다**:
 *  - `０１０－１２３４－５６７８` 은 가려지지 않는다(`hits` 가 비어 있다) — 그 글이 대화 기록·
 *    이관 요약·내려받기 CSV 를 지나 `scrub` 로 **서버 로그·오류 리포트·외부 LLM 호출 본문**까지
 *    원문으로 간다. 이 파일이 막으려고 있는 바로 그 일이다.
 *  - 같은 번호를 `findContact` 도 못 알아본다 — 접수 폼의 연락처 칸에서 「연락처 형식을
 *    알아보지 못했어요」가 돌아오고, 세 번이면 상담원 이관이다(`MAX_SLOT_RETRIES`).
 *  - 섞어 적은 `０１０12345678` 은 더 나쁘다. 전각 세 글자를 건너뛴 뒤쪽만 넓은 계좌 규칙에
 *    걸려 **「계좌번호」로 집계되고**(운영자 화면에 그 이름이 뜬다 · `PII_KIND_LABELS`)
 *    앞 세 자리는 그대로 남는다.
 *
 * 비교용 정규화(`normalize.basicNormalize`)를 쓰지 않는 까닭: 이 파일은 아무것도 import 하지
 * 않고(순환), 그쪽은 소문자로 내려 **보관할 값**(`Hong@Example.com`)을 바꾼다. 여기서 접는 것은
 * **같은 글자의 전각 모양 하나**이고, 한 글자가 한 글자로 바뀌므로 글자 수·자리가 보존된다.
 */
// 표기는 코드포인트로만 적는다 — 글자를 그대로 적으면 이 줄 자체가 전각 글자를 품어,
// 다음 사람이 그 줄을 읽고도 무엇을 모으는 식인지 알 수 없다(`lib/text` 의 규약과 같다).
const FULLWIDTH_ASCII = new RegExp('[\\uff01-\\uff5e]', 'g');

export function foldWidth(input: string): string {
  return String(input ?? '').replace(FULLWIDTH_ASCII, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/**
 * 전화번호 사이에 들어오는 구분자 (DS 52-1 · DS 70-1).
 *
 * **받아 적는 쪽과 가리는 쪽이 같은 집합을 본다.** 종전에 가리는 쪽은 하이픈·공백만 알았고
 * (`[-\s]`) 받아 적는 쪽은 점까지 받았다(`[-\s.]`) — 그래서 `010.1234.5678` 은 고객의 연락처로
 * **저장되는데 가려지지 않는** 값이었다.
 *
 * 하이픈 자리에 오는 글자는 아스키 `-` 만이 아니다 — PDF·한글(HWP)에서 뽑은 글은 붙임표를
 * U+2010·U+2011 로 적고, 메모장·메일에서 붙여 넣은 글에는 U+2013(엔 대시)·U+2212(빼기표)가
 * 섞여 온다. 전각 `－` 는 위 `foldWidth` 가 아스키 `-` 로 모은다.
 */
export const PHONE_SEP = '[-\\s.\\u2010\\u2011\\u2013\\u2212]';

/**
 * 전화번호 패턴 원문 — 휴대폰(`010…`)·지역번호(`02…`)·네 자리 국번(`0507…`)을 함께 본다
 * (DS 52-1 · DS 70-2).
 *
 * 연락처를 받아 적는 쪽(`chat.extractContact`)이 이 글을 그대로 쓴다. **받아 적을 수 있는
 * 모양은 모두 가릴 수 있어야 한다** — 그 번호는 접수에 저장되고, 답변으로 고객에게 되읽히고
 * (`chat.contactTail`), 그 답변이 대화 기록·이관 요약·내려받기 CSV·백업으로 퍼지고, 같은
 * 규칙을 쓰는 `scrub` 를 지나 **서버 로그·오류 리포트·외부 LLM 호출 본문**까지 간다.
 *
 * 앞가지가 네 자리인 갈래(`050\d`·`0303`)를 따로 적는 까닭: 안심번호(`0507-1234-5678`)와
 * 인터넷전화(`0303-…`)는 **열두 자리**라 세 묶음 식(`0\d{1,2}`)으로는 한 글자도 걸리지 않았다.
 * 그 번호는 넓은 계좌 규칙에 걸려 **「계좌번호」로** 가려졌고(운영자 화면에 그 이름이 뜬다),
 * 연락처로는 받아 적히지 않았다. 네 자리 앞가지를 **이 둘로만** 열어 둔다 — `0\d{3}` 로 넓히면
 * `0` 으로 시작하는 계좌번호가 전화번호로 분류되어 끝 네 자리가 남는다(가리는 세기가 약해진다).
 */
export const PHONE_PATTERN =
  `(?:(?:050\\d|0303)${PHONE_SEP}?\\d{3,4}${PHONE_SEP}?\\d{4}|0\\d{1,2}${PHONE_SEP}?\\d{3,4}${PHONE_SEP}?\\d{4})`;

/**
 * **글 안에서 전화번호 한 건을 찾을 때**의 규칙 원문 — 경계와 관문까지 (DS 53-1).
 *
 * 49차(DS 52-1)는 패턴 **속**(`PHONE_PATTERN`)만 한 벌로 만들었다. 가리는 쪽이 실제로 쓰는
 * 식에는 그 속을 감싸는 두 가지가 더 있었고, 그 둘은 가리는 쪽에만 남았다:
 *  - `\b…\b` **경계** — 번호 모양이 더 긴 숫자에 묻혀 있으면 번호로 읽지 않는다
 *  - `(?![\w.+-]*@)` **관문** — 뒤에 `@` 가 붙은 숫자 덩이는 전화번호가 아니라 메일 주소다
 *
 * 그래서 두 쪽은 **같은 글을 다르게 읽었다**: `0212345678@example.com` 을 받아 적는 쪽은
 * 「전화번호 0212345678」로, 가리는 쪽은 「이메일」로 읽었고, `01012345678901` 은 받아 적는
 * 쪽이 세 자리를 버려 「01012345678」로, 가리는 쪽은 「계좌번호」로 읽었다.
 */
export const PHONE_MATCH_PATTERN = `\\b${PHONE_PATTERN}\\b(?![\\w.+-]*@)`;

/** 이메일 규칙 원문 — 받아 적는 쪽(엔진의 연락처 수집·접수 폼)이 같은 글을 쓴다 (DS 53-1). */
export const EMAIL_PATTERN = '[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+';

// 규칙 순서 = 우선순위. 좁은 패턴(주민·카드·전화)을 먼저, 가장 넓은 계좌 패턴을 마지막에 둔다.
// 순서를 바꾸면 전화번호가 계좌로 분류되어 마스킹 종류 통계가 틀어진다.
interface MaskRule {
  name: string;
  re: RegExp;
  /** 운영자·상담원이 읽는 자리 — 끝 네 자리를 남긴다. */
  readable: (m: string) => string;
  /** 울타리를 넘는 자리 — 자리 수만 남긴다. */
  opaque: (m: string) => string;
}

const MASK_RULES: MaskRule[] = [
  {
    name: 'rrn',
    re: /\b(\d{6})[-\s]?([1-4]\d{6})\b/g,
    readable: (m) => `${m.slice(0, 6)}-*******`,
    // 앞 6자리는 생년월일이다 — 밖으로 나가는 자리에서는 그것도 남기지 않는다.
    opaque: () => '******-*******',
  },
  {
    name: 'card',
    re: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
    readable: (m) => `${m.slice(0, 4)}-****-****-${m.slice(-4)}`,
    opaque: () => '****-****-****-****',
  },
  {
    name: 'phone',
    // 숫자로 시작하는 메일 주소는 **이메일 규칙에 넘긴다** — 뒤에 `@` 가 붙어 있으면 잡지 않는다
    // (`0212345678@example.com` 의 앞부분만 가리면 주소가 반쪽만 남는다).
    re: new RegExp(PHONE_MATCH_PATTERN, 'g'),
    readable: (m) => {
      // 구분자가 무엇이든(하이픈·공백·점·없음) **같은 모양**으로 적는다 — 운영자 화면·CSV·
      // 이관 요약이 한 가지 모양만 읽게 한다.
      const d = m.replace(/\D/g, '');
      // 앞자리(이동통신 식별번호·지역번호)와 끝 네 자리를 남긴다 — 「그 번호가 맞는지」 확인용.
      return `${d.startsWith('02') ? d.slice(0, 2) : d.slice(0, 3)}-****-${d.slice(-4)}`;
    },
    opaque: (m) => (m.replace(/\D/g, '').startsWith('01') ? '01*-****-****' : '0**-****-****'),
  },
  {
    name: 'email',
    re: new RegExp(EMAIL_PATTERN, 'g'),
    readable: (m) => {
      const at = m.lastIndexOf('@');
      const local = m.slice(0, at);
      /**
       * 앞 두 글자는 「그 주소가 맞는지」 확인용이다. 그보다 짧으면 **남길 글자가 없다**
       * (DS 52-2) — 종전에는 `m.slice(0, 2)` 가 `@` 까지 삼켜 `a@b.co` 를 `a@***@b.co` 로
       * 적었고(`@` 가 두 번 찍힌 글), 아이디가 두 글자인 주소는 **한 글자도 가려지지 않았다**.
       */
      const keep = local.length > 2 ? 2 : local.length > 1 ? 1 : 0;
      return `${local.slice(0, keep)}***@${m.slice(at + 1)}`;
    },
    opaque: () => '***@***',
  },
  {
    name: 'account',
    /**
     * 묶음이 넷인 계좌(농협 `352-0123-4567-89`)까지 **한 번에** 잡는다 (DS 52-2).
     *
     * 종전에는 앞 세 묶음만 보아 끝 두 자리가 그대로 남았고, 첫 묶음이 네 자리인 계좌
     * (신한 `1002-123-456789`)는 두 조각으로 갈려 자리표시자가 **두 벌** 찍혔다
     * (`***-****-****-***-****-****` — 운영자는 계좌가 둘 적혀 있던 것으로 읽는다).
     */
    re: /\b\d{2,4}-?\d{2,6}-?\d{2,6}(?:-?\d{2,6})?\b/g,
    readable: () => '***-****-****',
    opaque: () => '***-****-****',
  },
];

/** 이미 마스킹된 구간을 뒤 규칙이 다시 잡지 않도록 자리표시자로 보호한다.
 *  숫자를 g~p 문자로 바꾸고 U+0001로 감싸 본문 글자와 겹치지 않게 한다(Core policyGuard와 동일 기법). */
const PLACEHOLDER = (i: number) => `\u0001${String(i).replace(/\d/g, (d) => String.fromCharCode(103 + Number(d)))}\u0001`;

export interface MaskResult {
  text: string;
  masked: boolean;
  hits: string[];
}

/**
 * 마스킹 전에 보호할 패턴 — 개인정보가 아닌데 넓은 규칙(계좌)에 걸리는 표기.
 * 예: '2026-09-04'는 계좌번호 패턴(`\b\d{2,4}-?\d{2,6}-?\d{2,6}(?:-?\d{2,6})?\b`)과 겹친다.
 * 예약 일시가 '***-****-****'로 뭉개지면 상담원이 언제 방문인지 알 수 없다.
 */
const PROTECT_RULES: RegExp[] = [/\b20\d{2}[-./]\d{1,2}[-./]\d{1,2}\b/g];

/**
 * 개인정보를 가린 글과 **무엇을 가렸는지**를 함께 돌려준다.
 *
 * `hits` 가 필요한 이유: 가렸다는 사실을 화면이 말할 수 있어야 한다. 가린 글만 돌려주면
 * 운영자는 `***-****-****` 를 보고 **고객이 그렇게 쓴 것인지 우리가 가린 것인지** 모른다
 * (DS 38-x 의 「잘랐으면 잘랐다고 말한다」와 같은 규칙).
 */
export function maskPii(input: string, strength: MaskStrength = 'readable'): MaskResult {
  // 전각으로 적힌 것을 먼저 모은다 — 가릴 수 없는 글자로 적혀 있으면 가려지지 않는다 (DS 70-1).
  // 돌려주는 글도 모은 쪽이다(글자 수는 같다): 같은 번호가 창구마다 다른 모양으로 남으면
  // 운영자 화면·CSV·로그가 한 가지 모양을 읽을 수 없다.
  let out = foldWidth(input);
  const hits: string[] = [];
  const vault: string[] = [];
  // 보호 구간을 먼저 자리표시자로 빼둔다(원문 그대로 되돌아온다 — 마스킹 종류에도 집계하지 않는다).
  for (const re of PROTECT_RULES) {
    out = out.replace(new RegExp(re.source, 'g'), (m) => {
      vault.push(m);
      return PLACEHOLDER(vault.length - 1);
    });
  }
  for (const rule of MASK_RULES) {
    const re = new RegExp(rule.re.source, 'g');
    let hit = false;
    out = out.replace(re, (m) => {
      hit = true;
      vault.push(strength === 'opaque' ? rule.opaque(m) : rule.readable(m));
      return PLACEHOLDER(vault.length - 1);
    });
    if (hit) hits.push(rule.name);
  }
  out = out.replace(/\u0001([g-p]+)\u0001/g, (_m, k: string) => {
    const idx = Number(String(k).replace(/[g-p]/g, (c) => String(c.charCodeAt(0) - 103)));
    return vault[idx] ?? '';
  });
  return { text: out, masked: hits.length > 0, hits };
}

/** 받아 적은 연락처 한 건 — 무엇으로 읽었는지를 함께 돌려준다. */
export interface ContactMatch {
  kind: 'phone' | 'email';
  value: string;
}

const PHONE_FIND = new RegExp(PHONE_MATCH_PATTERN);
const EMAIL_FIND = new RegExp(EMAIL_PATTERN);

/**
 * 이 글에서 **연락처로 받아 적을 수 있는 것**을 하나 고른다 — 받아 적는 자리가 모두 이 함수
 * 하나를 쓴다 (DS 53-1).
 *
 * 왜 가리는 쪽에 두는가: 받아 적은 값은 접수에 저장되고(`createTicket`), 답변으로 고객에게
 * 되읽히고(`chat.contactTail`), 그 답변이 대화 기록·이관 요약·CSV·백업으로 퍼지고, 같은
 * 규칙을 쓰는 `scrub` 를 지나 서버 로그·오류 리포트·외부 LLM 호출 본문까지 간다. 받아 적는
 * 쪽이 가리는 쪽보다 넓으면 **저장되는데 가려지지 않는 값**이 생기고(DS 52-1), 좁으면 그 반대로
 * **가릴 줄은 아는데 받지 못하는 값**이 생긴다. 한 함수로 두면 두 폭이 어긋날 자리가 없다.
 *
 * 전화번호를 먼저 본다(종전 차례 그대로 — 둘을 함께 보낸 사람에게 전화번호를 고르던 동작을
 * 바꾸지 않는다). 다만 `@` 가 붙은 숫자 덩이는 전화번호로 읽지 않고(관문), 번호 모양이 더 긴
 * 숫자에 묻혀 있으면 **잘라 적지 않는다**(경계) — 못 알아듣는 쪽이 틀리게 받아 적는 쪽보다 낫다.
 */
export function findContact(text: string): ContactMatch | null {
  // 전각으로 적힌 번호·주소도 받아 적는다 — 가리는 쪽과 같은 자리에서 모은다 (DS 70-1).
  const t = foldWidth(text);
  const phone = t.match(PHONE_FIND)?.[0];
  // 공백 구분자는 지운다 — 저장·되읽기·가리기가 한 모양을 본다(`010 1234 5678` → `01012345678`).
  if (phone) return { kind: 'phone', value: phone.replace(/\s+/g, '') };
  const email = t.match(EMAIL_FIND)?.[0];
  return email ? { kind: 'email', value: email } : null;
}

// ---- 받아 적을 수 있는 번호인가 (DS 70-2) ----

/**
 * 국내 전화번호의 **앞가지와 자리 수** — 번호 계획(KCC 번호자원 고시)에서 쓰이는 것만 적는다.
 *
 * 왜 자리 수를 세는가: 모양만 보던 종전 식은 `010-123-4567`(열 자리)·`0101234567`·`0123456789`
 * 를 **그대로 받아 적었다**. 010 번호는 언제나 열한 자리이므로 앞의 둘은 자리 하나가 빠진
 * 오타이고, `012` 는 **배정된 적이 없는 앞가지**다. 그 값은 접수의 연락처 칸에 들어가 운영자
 * 화면에 뜨고, 상담원은 그 번호로 전화를 건다 — 결번이거나 남의 번호다. 고객 쪽에서는 더
 * 조용하다: 되읽어 주는 문구가 가운데를 가리므로(`010-****-4567`) **빠진 자리를 볼 수 없고**,
 * 「상담원이 순서대로 연락드릴게요」까지 들은 채로 오지 않는 전화를 기다린다(DS 45-1 과 같은
 * 자리다 — 하지 못하는 일을 할 수 있다고 말하지 않는다).
 *
 * 받지 않는 쪽의 손해는 고객이 번호를 한 번 더 적는 것이고, 받아 적는 쪽의 손해는 **닿을 수
 * 없는 접수**다. 29차의 규약대로 거절은 무엇이 틀렸는지 밝힌다 — 그래서 「모르는 앞가지」와
 * 「자리 수가 맞지 않는다」를 다른 사실로 돌려준다(DS 65-1·69-1 이 수·번호에서 세운 쪽과 같다).
 *
 * **가리는 규칙은 이 표를 보지 않는다.** 가리는 쪽은 넓어야 한다 — 앞가지를 모르는 숫자 덩이도
 * 전화번호 모양이면 가려야 한다(못 가리면 그대로 밖으로 나간다). 자리 수는 **받아 적을 때만** 센다.
 */
const PHONE_PLANS: readonly (readonly [RegExp, readonly number[]])[] = [
  [/^010/, [11]],
  // 011·016~019 는 010 으로 통합되기 전 번호다. 아직 그렇게 적는 사람이 있어 열·열한 자리를 받는다.
  [/^01[16789]/, [10, 11]],
  [/^02/, [9, 10]],
  // 지역번호 세 자리 — 031~033·041~044·051~055·061~064.
  [/^0(?:3[1-3]|4[1-4]|5[1-5]|6[1-4])/, [10, 11]],
  [/^070/, [11]],
  // 안심번호·평생번호(0503~0508)·인터넷전화(0303) — 열한·열두 자리.
  [/^(?:050\d|0303)/, [11, 12]],
  // 수신자부담(080) — 고객의 연락처로는 드물지만 **있는 번호**라 거절하지 않는다.
  [/^080/, [9, 10, 11]],
];

/** 번호를 받지 못한 까닭 — 둘은 다른 사실이라 부르는 쪽이 다른 말을 한다. */
export type PhoneIssue = 'prefix' | 'digits';

export interface PhoneCheck {
  /** 구분자를 뗀 숫자 */
  digits: string;
  /** 앞가지(「010」·「02」·「0507」) — 모르는 앞가지면 앞 세 자리를 그대로 적는다. */
  head: string;
  /** 그 앞가지가 쓰는 자리 수. 모르는 앞가지면 null */
  plan: readonly number[] | null;
  issue: PhoneIssue | null;
}

/** 이 번호가 **닿을 수 있는 모양인가** (DS 70-2). */
export function checkPhone(value: string): PhoneCheck {
  const digits = foldWidth(value).replace(/\D/g, '');
  const found = PHONE_PLANS.find(([re]) => re.test(digits));
  if (!found) return { digits, head: digits.slice(0, 3), plan: null, issue: 'prefix' };
  const [re, plan] = found;
  const head = re.exec(digits)?.[0] ?? digits.slice(0, 3);
  return { digits, head, plan, issue: plan.includes(digits.length) ? null : 'digits' };
}

/**
 * 받아 적기의 답 — **세 갈래**다(DS 69-1 이 번호 고르기에서 세운 규약과 같다).
 *  - `ok`              : 그 값을 접수에 적을 수 있다
 *  - `ok:false, phone` : 번호인 것은 알아들었는데 **닿을 수 없는 모양**이다(까닭까지 안다)
 *  - `ok:false, null`  : 연락처를 못 찾았다
 */
export type ContactTake =
  | { ok: true; kind: 'phone' | 'email'; value: string }
  /** `plan` 은 그 앞가지가 쓰는 자리 수 — 모르는 앞가지면 빈 배열이다. */
  | { ok: false; kind: 'phone'; issue: PhoneIssue; head: string; plan: readonly number[]; length: number }
  | { ok: false; kind: null };

const NOT_FOUND: ContactTake = { ok: false, kind: null };

function take(found: ContactMatch | null): ContactTake {
  if (!found) return NOT_FOUND;
  if (found.kind === 'email') return { ok: true, kind: 'email', value: found.value };
  const c = checkPhone(found.value);
  if (c.issue) return { ok: false, kind: 'phone', issue: c.issue, head: c.head, plan: c.plan ?? [], length: c.digits.length };
  return { ok: true, kind: 'phone', value: found.value };
}

/**
 * 이 글에서 연락처를 하나 **받아 적는다** — 받아 적는 자리가 모두 이 함수를 지난다 (DS 70-2).
 *
 * `findContact` 가 「이 글에 연락처 모양이 있는가」를 답하고(가리는 쪽과 같은 폭이어야 한다),
 * 이 함수가 「그것을 접수에 적어도 되는가」를 답한다. 둘을 가른 까닭은 위 `PHONE_PLANS` 주석에
 * 적어 두었다 — 가리는 폭과 받아 적는 폭은 **같을 수 없다**.
 */
export function takeContact(text: string): ContactTake {
  return take(findContact(text));
}

/**
 * 연락처 뒤에 붙는 조사·종결·문장부호 (DS 70-3).
 *
 * 「전화번호나 이메일**만** 보내 주세요」라고 안내한 자리에서 고객이 보내는 것은 번호 하나가
 * 아니라 「010-1234-5678이요」·「010-1234-5678.」·「hong@example.com 입니다」다. 종전 판정은
 * 보낸 글이 **연락처와 한 글자도 다르지 않을 때만** 연락처로 보았으므로 그 세 가지가 모두
 * 떨어졌고, 그 글은 지식베이스 질문이 되어 **폴백**이 돌아왔다(바로 그 줄에서 하라고 한 일을
 * 한 고객에게 「잘 모르겠어요」가 간다 · DS 69-x 가 번호 고르기에서 본 것과 같은 자리).
 *
 * 꼬리만 받고 **앞에 붙은 글은 받지 않는다** — 「매장 번호 02-123-4567로 전화했는데 안 받아요」가
 * 고객의 연락처로 저장되던 자리(DS 35-3)를 다시 열지 않는다.
 */
const CONTACT_TAIL =
  /^\s*(?:이에요|이예요|예요|입니다|이요|이야|이고요|이구요|요|으로|로|로요|으로요|부탁해요|부탁드려요|입니당)?\s*[.!?~]*$/u;

/**
 * 보낸 글이 **연락처 하나뿐**일 때만 받아 적는다 (DS 37-1 · DS 70-3).
 *
 * 서버가 먼저 묻지 않았는데 연락처를 받아 적는 자리가 이 조건을 쓴다 — 「문장에 번호가 섞여
 * 있다」가 아니라 「보낸 것이 번호뿐이다」여야 한다. 조금이라도 다른 말이 섞이면 받지 않는다:
 * 틀리게 받아 적는 것보다 못 알아듣는 쪽이 낫다(못 알아들으면 고객이 다시 말하지만, 틀리게
 * 적으면 아무도 모른 채 다른 사람에게 전화한다).
 */
export function takeContactOnly(text: string): ContactTake {
  const t = foldWidth(text).trim();
  if (!t) return NOT_FOUND;
  for (const [kind, pattern] of [['phone', PHONE_MATCH_PATTERN], ['email', EMAIL_PATTERN]] as const) {
    const m = new RegExp(`^(?:${pattern})`).exec(t);
    if (!m) continue;
    if (!CONTACT_TAIL.test(t.slice(m[0].length))) continue;
    return take({ kind, value: kind === 'phone' ? m[0].replace(/\s+/g, '') : m[0] });
  }
  return NOT_FOUND;
}

/** 두 글(고객의 말·답변 등)에서 가린 종류를 합친다 — 중복 없이, 규칙 순서대로. */
export function mergeKinds(...lists: (readonly string[] | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const l of lists) for (const k of l ?? []) seen.add(k);
  return MASK_RULES.map((r) => r.name).filter((n) => seen.has(n));
}
