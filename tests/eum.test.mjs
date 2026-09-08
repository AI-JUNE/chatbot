/**
 * 이음(테넌트 'eum') 웹챗 검증.
 * - data/eum-faq.json 원본 계약(10건·번호·주제)
 * - FAQ 10건이 실제 사용자 표현으로 매칭되는가(런타임: tsc 컴파일 후 실행)
 * - 근거(FAQ 번호) 표시·CTA URL 안전성·알 수 없는 테넌트 차단
 * - 대화 엔진/임베드/위젯의 테넌트 배선(정적 검사)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importLib, tscPath } from './_compile.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const doc = JSON.parse(read('data/eum-faq.json'));
const opts = tscPath() ? {} : { skip: 'typescript 미설치(npm ci 필요)' };

/* ══════════ FAQ 원본 계약 ══════════ */

test('이음 FAQ는 10건이고 번호가 1~10으로 유일하다', () => {
  assert.equal(doc.tenant, 'eum');
  assert.equal(doc.faq.length, 10, 'FAQ는 10건이어야 한다');
  assert.deepEqual(
    doc.faq.map((f) => f.no),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  assert.equal(new Set(doc.faq.map((f) => f.id)).size, 10, 'id가 중복됐다');
});

test('요구된 10개 주제를 모두 덮는다', () => {
  const topics = doc.faq.map((f) => f.topic).join(' ');
  for (const t of ['신청 방법', '참여 자격', '활동 시간', '활동 인증', '활동확인서', '안전 검증', '개인정보', '문의처', '취소', '보상']) {
    assert.match(topics, new RegExp(t.replace(/ /g, ' ?')), `주제 누락: ${t}`);
  }
});

test('모든 항목에 질문·답변·키워드가 있고 답변이 충분히 구체적이다', () => {
  for (const f of doc.faq) {
    assert.ok(f.question.trim().length > 5, `${f.no}번 질문이 비었다`);
    assert.ok(f.answer.trim().length >= 60, `${f.no}번 답변이 너무 짧다`);
    assert.ok(Array.isArray(f.keywords) && f.keywords.length >= 3, `${f.no}번 키워드가 부족하다`);
  }
});

test('기관마다 다른 항목(자격·시간·보상)은 수치를 단정하지 않는다', () => {
  for (const no of [2, 3, 10]) {
    const f = doc.faq.find((x) => x.no === no);
    assert.match(f.answer, /(기관|지자체|담당|다릅니다|달라)/, `${no}번은 기관 기준임을 밝혀야 한다`);
    assert.equal(/\d+\s*(원|시간 이상|만원)/.test(f.answer), false, `${no}번에 임의 수치가 있다: ${f.answer}`);
  }
});

/* ══════════ 매칭(런타임) ══════════ */

/** 실제 사용자가 칠 법한 표현 → 기대 FAQ id */
const QUERIES = [
  ['신청은 어떻게 하나요?', 'eum_faq_01'],
  ['이음 활동 참여하려면 뭘 해야 하나요', 'eum_faq_01'],
  ['참여 자격 조건이 어떻게 되나요', 'eum_faq_02'],
  ['학생도 참여할 수 있나요', 'eum_faq_02'],
  ['활동 시간은 얼마나 되나요', 'eum_faq_03'],
  ['주 몇 번 방문하나요', 'eum_faq_03'],
  ['활동 인증은 어떻게 하나요', 'eum_faq_04'],
  ['방문 체크인 기록은 어디서 하나요', 'eum_faq_04'],
  ['활동확인서 발급되나요', 'eum_faq_05'],
  ['봉사시간 인정 받을 수 있나요', 'eum_faq_05'],
  ['안전은 어떻게 확인하나요', 'eum_faq_06'],
  ['활동 중 사고가 걱정돼요', 'eum_faq_06'],
  ['개인정보는 어떻게 보호되나요', 'eum_faq_07'],
  ['제 전화번호 노출되나요', 'eum_faq_07'],
  ['문의처가 어디인가요', 'eum_faq_08'],
  ['코디네이터에게 어떻게 연락하나요', 'eum_faq_08'],
  ['신청 취소하고 싶어요', 'eum_faq_09'],
  ['이번 주는 못 가는데 어떻게 하나요', 'eum_faq_09'],
  ['보상이 있나요', 'eum_faq_10'],
  ['활동하면 수당 나오나요', 'eum_faq_10'],
];

test('FAQ 10건이 사용자 표현으로 각각 매칭된다', opts, async () => {
  const { faqToKB, EUM_TENANT } = await importLib('tenants', ['knowledge', 'normalize']);
  const { matchKnowledge } = await importLib('knowledge', ['normalize', 'tenants']);
  const { entries, skipped } = faqToKB(EUM_TENANT, doc.faq);
  assert.deepEqual(skipped, [], '형식 오류로 건너뛴 항목이 있다');
  assert.equal(entries.length, 10);

  const hitIds = new Set();
  for (const [q, expected] of QUERIES) {
    const m = matchKnowledge(q, 2, entries);
    assert.ok(m, `매칭 실패: "${q}"`);
    assert.equal(m.entry.id, expected, `"${q}" → ${m.entry.id} (기대 ${expected})`);
    hitIds.add(m.entry.id);
  }
  assert.equal(hitIds.size, 10, '10개 항목이 모두 한 번 이상 매칭돼야 한다');
});

test('답변에는 FAQ 번호 근거가 따라붙는다', opts, async () => {
  const { faqToKB, EUM_TENANT, citationLabel } = await importLib('tenants', ['knowledge', 'normalize']);
  const { matchKnowledge, buildCitation } = await importLib('knowledge', ['normalize', 'tenants']);
  const { entries } = faqToKB(EUM_TENANT, doc.faq);
  const m = matchKnowledge('활동확인서 발급되나요', 2, entries);
  const c = buildCitation(m.entry, '활동확인서 발급되나요', m.matched);
  assert.match(c.source, /^이음 FAQ \d+\. /, `근거에 FAQ 번호가 없다: ${c.source}`);
  assert.equal(citationLabel(EUM_TENANT, doc.faq[4]), '이음 FAQ 5. 활동확인서');
  assert.ok(c.snippet.length > 0 && m.entry.answer.includes(c.snippet.replace(/…$/, '')), '근거 문장은 원문 인용이어야 한다');
});

test('실패 경로: 형식이 깨진 FAQ 항목은 조용히 버리지 않고 사유를 남긴다', opts, async () => {
  const { faqToKB, EUM_TENANT } = await importLib('tenants', ['knowledge', 'normalize']);
  const broken = [{ no: 1, id: 'x', question: '질문', answer: '', keywords: [] }, { id: 'y' }, null];
  const { entries, skipped } = faqToKB(EUM_TENANT, broken);
  assert.equal(entries.length, 0);
  assert.equal(skipped.length, 3, '건너뛴 항목마다 사유가 있어야 한다');
  assert.deepEqual(faqToKB(EUM_TENANT, undefined), { entries: [], skipped: [] }, '데이터가 없어도 throw하지 않는다');
});

/* ══════════ 테넌트 해석·CTA ══════════ */

test('알 수 없는/불온한 테넌트 값은 거부한다', opts, async () => {
  const { getTenantPreset, isValidTenantId } = await importLib('tenants', ['knowledge', 'normalize']);
  assert.equal(getTenantPreset('eum')?.id, 'eum');
  for (const bad of ['../secret', 'EUM', 'a'.repeat(40), '', null, 42, 'no-such-tenant']) {
    assert.equal(getTenantPreset(bad), null, `거부되지 않았다: ${String(bad)}`);
  }
  assert.equal(isValidTenantId('eum'), true);
});

test('CTA URL은 환경변수로 바꿀 수 있고 http(s)만 허용한다', opts, async () => {
  const { resolveCTA, EUM_TENANT, EUM_APPLY_URL_DEFAULT } = await importLib('tenants', ['knowledge', 'normalize']);
  const normalized = new URL(EUM_APPLY_URL_DEFAULT).toString();
  assert.equal(resolveCTA(EUM_TENANT, {}).url, normalized);
  assert.equal(resolveCTA(EUM_TENANT, { EUM_APPLY_URL: 'https://eum.example.go.kr/apply' }).url, 'https://eum.example.go.kr/apply');
  // 실패 경로: 스크립트·상대경로는 무시하고 기본값으로 되돌아간다
  for (const bad of ['javascript:alert(1)', 'ftp://x/y', '/apply', '']) {
    assert.equal(resolveCTA(EUM_TENANT, { EUM_APPLY_URL: bad }).url, normalized, `차단 실패: ${bad}`);
  }
  assert.match(resolveCTA(EUM_TENANT, {}).hint, /버튼/, 'CTA 안내 문구가 있어야 한다');
});

test('공개 설정에는 화면에 필요한 값만 담긴다', opts, async () => {
  const { publicTenant, EUM_TENANT } = await importLib('tenants', ['knowledge', 'normalize']);
  const pub = publicTenant(EUM_TENANT, { EUM_APPLY_URL: 'https://eum.example.go.kr/apply', ADMIN_TOKEN: 'secret' });
  assert.equal(JSON.stringify(pub).includes('secret'), false, '비밀값이 위젯으로 새면 안 된다');
  assert.equal(pub.brandColor, '#BE5535');
  assert.match(pub.aiNotice, /AI/, 'AI 고지가 유지돼야 한다');
});

test('모르는 질문에는 단정하지 않고 담당자 연결로 안내한다', opts, async () => {
  const { EUM_TENANT } = await importLib('tenants', ['knowledge', 'normalize']);
  assert.match(EUM_TENANT.unknownReply, /(추측|어렵|없어서)/, '모른다는 사실을 밝혀야 한다');
  assert.match(EUM_TENANT.unknownReply, /(담당|코디네이터)/, '담당자 연결 안내가 있어야 한다');
});

/* ══════════ 배선(정적 검사) ══════════ */

test('대화 엔진이 테넌트 지식만 참조하고 다른 브랜드 룰을 섞지 않는다', () => {
  const s = read('src/lib/chat.ts');
  assert.match(s, /function entriesFor\(tenant/, '테넌트 지식 분기가 있어야 한다');
  assert.match(s, /allowedRuleIntents\.includes\(r\.intent\)/, '테넌트 대화에서 공통 룰을 제한해야 한다');
  assert.match(s, /const cr = tenant \? null : matchCustomRule/, '콘솔 커스텀 룰이 테넌트에 새면 안 된다');
  assert.match(s, /tenant\.preset\.unknownReply/, '모를 때 문구는 테넌트 것을 써야 한다');
});

test('/api/chat 이 tenant 입력을 검증해 엔진에 전달한다', () => {
  const s = read('src/app/api/chat/route.ts');
  assert.match(s, /optStr\(parsed\.data\.tenant/, 'tenant 입력 검증이 있어야 한다');
  assert.match(s, /replyToAsync\(message, sessionId, tenantId/, '엔진에 tenant가 전달돼야 한다');
  // route.ts는 HTTP 메서드·설정 외 export를 두지 않는다(배포 장애 재발 방지)
  const exports = [...s.matchAll(/^export (?:const|function|async function) ([A-Za-z_]+)/gm)].map((m) => m[1]);
  assert.deepEqual(exports.sort(), ['POST', 'dynamic'].sort(), `허용되지 않은 export: ${exports.join(',')}`);
});

test('임베드 스니펫이 data-tenant 를 지원하고 형식을 검증한다', () => {
  const s = read('public/embed.js');
  assert.match(s, /data-tenant/, 'data-tenant 옵션 안내가 있어야 한다');
  assert.match(s, /\/widget' \+ \(tenant \? '\?tenant='/, '위젯 URL에 tenant가 실려야 한다');
  assert.match(s, /\^\[a-z0-9\]\[a-z0-9_-\]\{0,31\}\$/, '임베드에서도 형식 검증을 해야 한다');
});

test('위젯이 테넌트 인사말·CTA 버튼·AI 고지를 렌더한다', () => {
  const w = read('src/components/ChatWidget.tsx');
  assert.match(w, /tenant\?\.greeting/, '테넌트 인사말이 반영돼야 한다');
  assert.match(w, /rel="noopener noreferrer"/, 'CTA 링크는 안전 속성을 가져야 한다');
  assert.match(w, /isCTA\(data\.cta\)/, '서버가 준 CTA만 신뢰해야 한다');
  assert.match(w, /tenant\?\.aiNotice/, 'AI 고지가 상시 노출돼야 한다');
  const page = read('src/app/widget/page.tsx');
  assert.match(page, /tenantConfig\(searchParams\?\.tenant\)/, '위젯 페이지가 tenant 쿼리를 해석해야 한다');
});
