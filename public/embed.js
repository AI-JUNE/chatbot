/* GOWON Chat 임베드 스니펫 (v0.5)
 * 사용법: <script src="https://<배포도메인>/embed.js" async></script>
 * 옵션(선택): data-position="left" | data-offset="24" | data-z="2147483000"
 *            data-tenant="eum"  ← 테넌트 프리셋(문구·색·FAQ 지식)을 바꿔 끼운다
 *
 * v0.5 변경점
 * - 첫 로드 깜빡임 제거: iframe을 투명하게 붙였다가 위젯이 "준비됨"을 알릴 때 부드럽게 나타낸다.
 *   신호가 오지 않아도(차단·오류) 폴백 타이머로 반드시 보이게 한다 — 위젯이 사라지는 일은 없다.
 * - 모션 최소화 설정(prefers-reduced-motion)에서는 전환 효과를 쓰지 않는다.
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

  // 모션 최소화 설정을 존중한다(전정 장애 등) — 이 경우 전환 없이 바로 보인다.
  var calm = false;
  try {
    calm = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (e) { /* noop */ }

  iframe.style.cssText = [
    'position:fixed',
    side + ':' + offset + 'px',
    'bottom:' + offset + 'px',
    'border:0',
    'background:transparent',
    'z-index:' + zIndex,
    'color-scheme:normal',
    // 붙는 순간에는 투명 — 위젯이 그려지기 전의 빈 사각형이 깜빡이지 않게 한다.
    'opacity:0',
    calm ? 'transition:none' : 'transition:opacity .22s ease,width .18s ease,height .18s ease'
  ].join(';');
  applySize(CLOSED.w, CLOSED.h);

  // 위젯이 "준비됨"을 알리면 나타낸다. 신호가 없어도 폴백 타이머로 반드시 보이게 한다.
  var revealed = false;
  var revealTimer = null;
  function reveal() {
    if (revealed) return;
    revealed = true;
    if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
    iframe.style.opacity = '1';
  }
  revealTimer = setTimeout(reveal, 2500);

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

  iframe.addEventListener('load', function () {
    sendViewport();
    // 문서는 떴지만 위젯 신호가 늦는 경우의 2차 안전망.
    setTimeout(reveal, 400);
  });

  window.addEventListener('message', function (ev) {
    if (origin && ev.origin !== origin) return;
    var d = ev.data;
    if (!d || d.source !== 'gowon-chat') return;
    if (d.type === 'ready') { reveal(); sendViewport(); return; }
    if (d.type !== 'resize') return;
    reveal();
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
