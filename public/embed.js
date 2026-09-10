/* 고원 챗봇 임베드 스니펫 (v0.4)
 * 사용법: <script src="https://<배포도메인>/embed.js" async></script>
 * 옵션(선택): data-position="left" | data-offset="24" | data-z="2147483000"
 *            data-tenant="eum"  ← 테넌트 프리셋(문구·색·FAQ 지식)을 바꿔 끼운다
 *
 * v0.4 변경점
 * - 호스트 뷰포트 폭을 위젯에 알려준다(gowon-chat-host/viewport) → 모바일에서 전체화면 시트로 전환
 * - 위젯이 fullscreen 을 요청하면 iframe을 화면 전체에 붙인다(가장자리 여백·라운드 없음)
 *
 * v0.3 변경점
 * - data-tenant 지원: /widget?tenant=<id> 로 로드. 형식(소문자·숫자·-_ 32자)에 맞지 않으면 무시하고 기본 위젯을 띄운다.
 *
 * v0.2 변경점
 * - 닫힘 상태에서는 버블 크기(104x104)만 차지 → 호스트 페이지 클릭을 가로채지 않음
 * - /widget이 postMessage로 보내는 열림/닫힘 상태에 맞춰 iframe 크기를 조정
 */
(function () {
  if (window.__gowonChatLoaded) return;
  window.__gowonChatLoaded = true;

  var script = document.currentScript || document.querySelector('script[src*="embed.js"]');
  var origin = '';
  try {
    if (script && script.src) origin = new URL(script.src, window.location.href).origin;
  } catch (e) { /* noop */ }

  function attr(name, fallback) {
    var v = script && script.getAttribute ? script.getAttribute(name) : null;
    return v === null || v === '' ? fallback : v;
  }

  var side = attr('data-position', 'right') === 'left' ? 'left' : 'right';
  var offset = parseInt(attr('data-offset', '0'), 10);
  if (!isFinite(offset) || offset < 0) offset = 0;
  var zIndex = attr('data-z', '2147483000');

  // 테넌트 식별자 — 서버도 같은 규칙으로 다시 검증한다(여기 검증은 잘못된 URL 생성 방지용).
  var tenant = String(attr('data-tenant', '')).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(tenant)) tenant = '';

  var CLOSED = { w: 104, h: 104 };
  var OPEN = { w: 400, h: 660 };

  var iframe = document.createElement('iframe');
  iframe.src = origin + '/widget' + (tenant ? '?tenant=' + encodeURIComponent(tenant) : '');
  iframe.title = '상담 챗봇';
  iframe.setAttribute('allowtransparency', 'true');
  iframe.setAttribute('loading', 'lazy');

  function applySize(w, h) {
    iframe.style.width = Math.min(w, window.innerWidth) + 'px';
    iframe.style.height = Math.min(h, window.innerHeight) + 'px';
  }

  iframe.style.cssText = [
    'position:fixed',
    side + ':' + offset + 'px',
    'bottom:' + offset + 'px',
    'border:0',
    'background:transparent',
    'z-index:' + zIndex,
    'color-scheme:normal',
    'transition:width .18s ease,height .18s ease'
  ].join(';');
  applySize(CLOSED.w, CLOSED.h);

  var lastOpen = false;
  var lastFull = false;

  // 전체화면(모바일): 가장자리 여백을 지우고 화면 전체를 덮는다. 아니면 원래 위치로 되돌린다.
  function applyPlacement(full) {
    if (full) {
      iframe.style.top = '0px';
      iframe.style.bottom = '0px';
      iframe.style.left = '0px';
      iframe.style.right = '0px';
    } else {
      iframe.style.top = 'auto';
      iframe.style.bottom = offset + 'px';
      iframe.style.left = side === 'left' ? offset + 'px' : 'auto';
      iframe.style.right = side === 'right' ? offset + 'px' : 'auto';
    }
  }

  // 위젯은 iframe 안에 있어 호스트 화면 크기를 알 수 없다 → 폭을 알려준다.
  function sendViewport() {
    if (!iframe.contentWindow) return;
    iframe.contentWindow.postMessage({
      source: 'gowon-chat-host',
      type: 'viewport',
      width: window.innerWidth,
      height: window.innerHeight
    }, origin || '*');
  }

  iframe.addEventListener('load', sendViewport);

  window.addEventListener('message', function (ev) {
    if (origin && ev.origin !== origin) return;
    var d = ev.data;
    if (!d || d.source !== 'gowon-chat' || d.type !== 'resize') return;
    lastOpen = !!d.open;
    lastFull = !!d.fullscreen;
    applyPlacement(lastFull);
    if (lastFull) {
      applySize(window.innerWidth, window.innerHeight);
      return;
    }
    var w = typeof d.width === 'number' ? d.width : (lastOpen ? OPEN.w : CLOSED.w);
    var h = typeof d.height === 'number' ? d.height : (lastOpen ? OPEN.h : CLOSED.h);
    applySize(w, h);
  });

  window.addEventListener('resize', function () {
    sendViewport();
    if (lastFull) applySize(window.innerWidth, window.innerHeight);
    else applySize(lastOpen ? OPEN.w : CLOSED.w, lastOpen ? OPEN.h : CLOSED.h);
  });

  function mount() { document.body.appendChild(iframe); sendViewport(); }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);

  window.__gowonChat = {
    tenant: tenant || null,
    element: function () { return iframe; },
    remove: function () {
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      window.__gowonChatLoaded = false;
    }
  };
})();
