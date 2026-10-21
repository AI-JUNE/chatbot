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
 * 전화번호 사이에 들어오는 구분자 (DS 52-1).
 *
 * **받아 적는 쪽과 가리는 쪽이 같은 집합을 본다.** 종전에 가리는 쪽은 하이픈·공백만 알았고
 * (`[-\s]`) 받아 적는 쪽은 점까지 받았다(`[-\s.]`) — 그래서 `010.1234.5678` 은 고객의 연락처로
 * **저장되는데 가려지지 않는** 값이었다.
 */
export const PHONE_SEP = '[-\\s.]';

/**
 * 전화번호 패턴 원문 — 휴대폰(`010…`)과 지역번호(`02…`)를 함께 본다 (DS 52-1).
 *
 * 연락처를 받아 적는 쪽(`chat.extractContact`)이 이 글을 그대로 쓴다. **받아 적을 수 있는
 * 모양은 모두 가릴 수 있어야 한다** — 그 번호는 접수에 저장되고, 답변으로 고객에게 되읽히고
 * (`chat.contactTail`), 그 답변이 대화 기록·이관 요약·내려받기 CSV·백업으로 퍼지고, 같은
 * 규칙을 쓰는 `scrub` 를 지나 **서버 로그·오류 리포트·외부 LLM 호출 본문**까지 간다.
 */
export const PHONE_PATTERN = `0\\d{1,2}${PHONE_SEP}?\\d{3,4}${PHONE_SEP}?\\d{4}`;

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
    re: new RegExp(`\\b${PHONE_PATTERN}\\b(?![\\w.+-]*@)`, 'g'),
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
    re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
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
  let out = input || '';
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

/** 두 글(고객의 말·답변 등)에서 가린 종류를 합친다 — 중복 없이, 규칙 순서대로. */
export function mergeKinds(...lists: (readonly string[] | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const l of lists) for (const k of l ?? []) seen.add(k);
  return MASK_RULES.map((r) => r.name).filter((n) => seen.has(n));
}
