/* 고원 챗봇 임베드 스니펫 (v0.2)
 * 사용법: <script src="https://<배포도메인>/embed.js" async></script>
 * 옵션(선택): data-position="left" | data-offset="24" | data-z="2147483000"
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

  var CLOSED = { w: 104, h: 104 };
  var OPEN = { w: 400, h: 660 };

  var iframe = document.createElement('iframe');
  iframe.src = origin + '/widget';
  iframe.title = '고원 상담 챗봇';
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
  window.addEventListener('message', function (ev) {
    if (origin && ev.origin !== origin) return;
    var d = ev.data;
    if (!d || d.source !== 'gowon-chat' || d.type !== 'resize') return;
    lastOpen = !!d.open;
    var w = typeof d.width === 'number' ? d.width : (lastOpen ? OPEN.w : CLOSED.w);
    var h = typeof d.height === 'number' ? d.height : (lastOpen ? OPEN.h : CLOSED.h);
    applySize(w, h);
  });

  window.addEventListener('resize', function () {
    applySize(lastOpen ? OPEN.w : CLOSED.w, lastOpen ? OPEN.h : CLOSED.h);
  });

  function mount() { document.body.appendChild(iframe); }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);

  window.__gowonChat = {
    element: function () { return iframe; },
    remove: function () {
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      window.__gowonChatLoaded = false;
    }
  };
})();
