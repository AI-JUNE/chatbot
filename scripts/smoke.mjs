#!/usr/bin/env node
/**
 * E2E 스모크 — 배포된 인스턴스에 실제 요청을 보내 핵심 흐름이 살아 있는지 확인한다.
 * QUALITY_BAR §5 "매일 E2E 스모크 검증이 라이브 서비스에 실제 요청을 보내 동작을 확인" 이행.
 *
 * 사용법
 *   npm run smoke                         # 기본 대상: https://chatbot-gowon.vercel.app
 *   SMOKE_BASE_URL=http://localhost:3000 npm run smoke
 *
 * 종료코드
 *   0 통과 · 1 검사 실패 · 2 판정보류(대상에 접속 자체가 안 됨 — 실패와 구분한다)
 *
 * 원칙
 * - 개인정보를 보내지 않는다(고정 문구 질의 + 임의 세션 id만 사용).
 * - 쓰기·관리 API는 건드리지 않는다. 공개 읽기 경로와 대화 API만 호출한다.
 * - "응답이 200이더라" 로 통과시키지 않는다. 이음 요건(근거 번호·CTA·모를 때 단정 금지)을 본문에서 확인한다.
 */

import { pathToFileURL } from 'node:url';

export const DEFAULT_BASE_URL = 'https://chatbot-gowon.vercel.app';

/** 접속 자체가 안 된 경우 — 검사 실패가 아니라 판정보류로 끝낸다. */
export class SmokeUnreachable extends Error {}

const DEFAULT_TIMEOUT_MS = 15000;

/** 이음 FAQ 10건 어디에도 해당하지 않는 질문(키워드가 겹치지 않아야 한다). */
export const UNKNOWN_QUESTION = '이음 본사 건물에 엘리베이터가 있나요?';

function normalizeBase(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('대상 주소가 비어 있습니다.');
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`대상 주소 형식이 잘못됐습니다: ${value}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`http(s) 주소만 사용할 수 있습니다: ${value}`);
  }
  return u.origin;
}

/** 네트워크 오류와 HTTP 응답을 구분해 돌려준다. 응답이 오면 상태코드가 무엇이든 검사로 넘긴다. */
async function request(fetchImpl, base, path, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const url = base + path;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetchImpl(url, { ...init, ...(controller ? { signal: controller.signal } : {}) });
  } catch (e) {
    throw new SmokeUnreachable(`${path} 요청 실패: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* JSON이 아닌 응답(HTML·JS)은 text로만 본다 */
  }
  return { status: res.status, text, json, headers: res.headers };
}

function chat(fetchImpl, base, body, timeoutMs) {
  return request(
    fetchImpl,
    base,
    '/api/chat',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    timeoutMs,
  );
}

/** 대화 세션 id — 개인정보가 아닌 임의값. 검사 간 상태가 섞이지 않게 매번 새로 만든다. */
function smokeSession(tag) {
  return `smoke-${tag}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 검사 목록. 각 항목은 실패 시 "무엇이 왜 실패했는지" 문장을 던진다.
 * 정상 경로뿐 아니라 실패 경로(잘못된 입력·모르는 질문)도 함께 확인한다.
 */
export const CHECKS = [
  {
    name: 'health: 서비스가 응답하고 상태가 ok',
    async run(ctx) {
      const r = await request(ctx.fetchImpl, ctx.base, '/api/health', {}, ctx.timeoutMs);
      if (r.status !== 200) throw new Error(`상태코드 ${r.status}`);
      if (!r.json || r.json.service !== 'chatbot') throw new Error('health 본문이 chatbot 서비스가 아니다');
      if (r.json.status !== 'ok') {
        const ns = (r.json.dependencies?.storage?.namespaces || [])
          .filter((n) => n.health === 'error')
          .map((n) => n.ns)
          .join(', ');
        throw new Error(`status=${r.json.status}${ns ? ` (저장소 오류: ${ns})` : ''}`);
      }
      return `commit=${r.json.build?.commit ?? '?'} env=${r.json.build?.env ?? '?'}`;
    },
  },
  {
    name: 'health: 이음 FAQ 10건이 적재돼 있다',
    async run(ctx) {
      const r = await request(ctx.fetchImpl, ctx.base, '/api/health', {}, ctx.timeoutMs);
      const tenants = r.json?.dependencies?.tenants;
      if (!Array.isArray(tenants)) throw new Error('health에 tenants가 없다(구버전 배포일 수 있다)');
      const eum = tenants.find((t) => t.id === 'eum');
      if (!eum) throw new Error('테넌트 eum이 등록돼 있지 않다');
      if (eum.entries !== 10) throw new Error(`이음 FAQ 적재 ${eum.entries}건(10건이어야 한다)`);
      if (eum.skipped > 0) throw new Error(`형식 오류로 건너뛴 FAQ ${eum.skipped}건`);
      return `eum FAQ ${eum.entries}건 · CTA ${eum.ctaFromEnv ? '환경변수' : '기본값'}`;
    },
  },
  {
    name: 'embed.js: 스니펫이 내려오고 data-tenant를 처리한다',
    async run(ctx) {
      const r = await request(ctx.fetchImpl, ctx.base, '/embed.js', {}, ctx.timeoutMs);
      if (r.status !== 200) throw new Error(`상태코드 ${r.status}`);
      if (!r.text.includes('data-tenant')) throw new Error('embed.js에 data-tenant 처리가 없다');
      if (!r.text.includes('/widget')) throw new Error('embed.js가 /widget을 로드하지 않는다');
      return `${r.text.length}바이트`;
    },
  },
  {
    name: 'widget: ?tenant=eum 페이지가 이음 문구와 AI 고지를 렌더한다',
    async run(ctx) {
      const r = await request(ctx.fetchImpl, ctx.base, '/widget?tenant=eum', {}, ctx.timeoutMs);
      if (r.status !== 200) throw new Error(`상태코드 ${r.status}`);
      if (!r.text.includes('이음')) throw new Error('위젯에 이음 문구가 없다(테넌트가 적용되지 않았다)');
      if (!r.text.includes('AI 자동응답')) throw new Error('AI 고지 문구가 없다');
      return '이음 프리셋 적용됨';
    },
  },
  {
    name: 'chat(이음): FAQ 답변에 근거 번호와 신청 CTA가 붙는다',
    async run(ctx) {
      const r = await chat(
        ctx.fetchImpl,
        ctx.base,
        { message: '신청은 어떻게 하나요?', tenant: 'eum', sessionId: smokeSession('faq') },
        ctx.timeoutMs,
      );
      if (r.status !== 200) throw new Error(`상태코드 ${r.status}`);
      const d = r.json;
      if (!d || typeof d.reply !== 'string' || !d.reply.trim()) throw new Error('빈 응답');
      if (d.source !== 'kb') throw new Error(`FAQ가 매칭되지 않았다(source=${d.source})`);
      const source = d.citation?.source || '';
      if (!/^이음 FAQ \d+\./.test(source)) throw new Error(`근거 번호 표시가 없다(citation.source=${source || '없음'})`);
      const url = d.cta?.url || '';
      if (!/^https?:\/\//.test(url)) throw new Error(`신청 CTA 주소가 없다(${url || '없음'})`);
      return `근거 "${source}" · CTA ${url}`;
    },
  },
  {
    name: 'chat(이음): 모르는 질문에 단정하지 않고 담당자 연결로 안내한다',
    async run(ctx) {
      const r = await chat(
        ctx.fetchImpl,
        ctx.base,
        {
          // 이음 FAQ 어디에도 없는 질문이어야 한다. 2026-10-12 전까지는 「포인트를 항공 마일리지로」를
          // 물었는데, FAQ 10(보상)이 '포인트'·'마일리지'를 키워드로 갖고 있어 라이브가 FAQ 로 정상 응답했고
          // 이 검사가 매일 거짓 실패했다. FAQ 에 키워드를 늘릴 때 이 질문과 겹치지 않는지 확인할 것.
          message: UNKNOWN_QUESTION,
          tenant: 'eum',
          sessionId: smokeSession('unknown'),
        },
        ctx.timeoutMs,
      );
      if (r.status !== 200) throw new Error(`상태코드 ${r.status}`);
      const reply = r.json?.reply || '';
      if (r.json?.source === 'kb') {
        throw new Error(`없는 내용을 FAQ 답변으로 내보냈다(근거=${r.json?.citation?.source || '?'})`);
      }
      if (!/담당|코디네이터|연결/.test(reply)) throw new Error(`담당자 연결 안내가 없다: ${reply.slice(0, 60)}`);
      if (/할 수 있습니다|가능합니다/.test(reply)) throw new Error(`근거 없이 단정했다: ${reply.slice(0, 60)}`);
      return '추측 없이 담당자 연결 안내';
    },
  },
  {
    // 계약(EUM_INTEGRATION.md·/api/chat 주석): 형식이 어긋나거나 모르는 테넌트 값은 **무시하고 기본 동작**으로
    // 되돌아간다. 예전 검사는 400 을 요구했는데 서버는 처음부터 그렇게 만든 적이 없어 매일 거짓 실패했다.
    // 실제로 지켜야 할 것은 "형식이 깨진 값이 이음 설정(FAQ 근거·신청 CTA)을 켜지 못한다"이다.
    // 400 으로 거절하는 것도 안전하므로 통과로 본다. 그 외 상태코드(5xx 등)는 실패다.
    name: 'chat: 형식이 잘못된 테넌트 값은 이음 설정을 켜지 못한다(실패 경로)',
    async run(ctx) {
      const r = await chat(
        ctx.fetchImpl,
        ctx.base,
        { message: '신청은 어떻게 하나요?', tenant: 'eum!!', sessionId: smokeSession('badtenant') },
        ctx.timeoutMs,
      );
      if (r.status === 400) {
        if (!r.json?.code) throw new Error('표준 에러 응답(code)이 아니다');
        return `거절 code=${r.json.code}`;
      }
      if (r.status !== 200) throw new Error(`200(무시) 또는 400(거절)이어야 하는데 ${r.status}`);
      const source = r.json?.citation?.source || '';
      if (/^이음 FAQ/.test(source) || r.json?.cta?.url) {
        throw new Error(`형식이 잘못된 테넌트에 이음 설정이 적용됐다(근거=${source || '없음'}, CTA=${r.json?.cta?.url || '없음'})`);
      }
      return '무시하고 기본 동작';
    },
  },
  {
    name: 'chat: 상한을 넘는 입력은 400으로 거절한다(실패 경로)',
    async run(ctx) {
      const r = await chat(
        ctx.fetchImpl,
        ctx.base,
        { message: '가'.repeat(2500), sessionId: smokeSession('toolong') },
        ctx.timeoutMs,
      );
      if (r.status !== 400) throw new Error(`400이어야 하는데 ${r.status}`);
      return `code=${r.json?.code ?? '?'}`;
    },
  },
];

/**
 * 검사를 순서대로 실행한다. 접속 자체가 안 되면(SmokeUnreachable) 즉시 멈추고 판정보류로 표시한다 —
 * 대상이 죽은 것을 "검사 8건 실패"로 부풀려 보고하지 않기 위해서다.
 */
export async function runSmoke({ baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch를 사용할 수 없습니다(Node 18 이상 필요).');
  const base = normalizeBase(baseUrl);
  const ctx = { base, fetchImpl, timeoutMs };
  const results = [];
  for (const check of CHECKS) {
    try {
      const detail = await check.run(ctx);
      results.push({ name: check.name, ok: true, detail: detail || '' });
    } catch (e) {
      if (e instanceof SmokeUnreachable) {
        results.push({ name: check.name, ok: false, unreachable: true, detail: e.message });
        return { base, results, passed: results.filter((r) => r.ok).length, failed: 0, unreachable: true };
      }
      results.push({ name: check.name, ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  }
  return {
    base,
    results,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    unreachable: false,
  };
}

export function formatReport(report) {
  const lines = [`E2E 스모크 — ${report.base}`];
  for (const r of report.results) {
    lines.push(`${r.ok ? 'PASS' : r.unreachable ? 'SKIP' : 'FAIL'}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  if (report.unreachable) lines.push('판정보류: 대상에 접속하지 못했습니다. 배포 상태·네트워크를 먼저 확인하세요.');
  else lines.push(`통과 ${report.passed} / 실패 ${report.failed} / 총 ${report.results.length}`);
  return lines.join('\n');
}

export function exitCodeFor(report) {
  if (report.unreachable) return 2;
  return report.failed > 0 ? 1 : 0;
}

// 직접 실행할 때만 CLI로 동작한다(테스트가 import 해도 네트워크를 타지 않도록).
// Windows 경로도 안전하게 다루기 위해 pathToFileURL 을 쓴다.
const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const report = await runSmoke({ baseUrl: process.env.SMOKE_BASE_URL || DEFAULT_BASE_URL });
  console.log(formatReport(report));
  process.exit(exitCodeFor(report));
}
