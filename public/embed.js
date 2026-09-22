/* GOWON Chat 임베드 스니펫 (v0.8)
 * 사용법: <script src="https://<배포도메인>/embed.js" async></script>
 * 옵션(선택): data-position="left" | data-offset="24" | data-z="2147483000"
 *            data-tenant="eum"  ← 테넌트 프리셋(문구·색·FAQ 지식)을 바꿔 끼운다
 *
 * v0.8 변경점
 * - 상담창 프레임이 밝은 화면 한 벌임을 선언한다(color-scheme:light). 종전의 `normal` 은
 *   「정하지 않음」이라 호스트 페이지의 배색·브라우저 자동 다크 테마에 색이 끌려갔다.
 *
 * v0.7 변경점
 * - 위젯 메시지의 출처를 창 단위로 확인한다(ev.source === iframe.contentWindow). 종전에는
 *   `{source:'gowon-chat'}` 이라는 자칭 이름만 보고 받아들였고, 스크립트 주소를 읽지 못하면
 *   출처 검사 자체를 건너뛰었다 — 호스트 페이지의 다른 스크립트·광고 프레임이 전체화면 신호를
 *   흉내 내 상담창으로 페이지를 덮을 수 있었다.
 * - 호스트 뷰포트 크기를 `'*'` 로 뿌리지 않고 위젯 프레임의 출처로만 보낸다.
 *
 * v0.6 변경점
 * - 전체화면(모바일)으로 열린 동안 호스트 페이지 스크롤을 잠근다 — 위젯 뒤에서 페이지가 밀리면
 *   닫았을 때 읽던 자리가 아니다. 닫으면 원래 스타일과 스크롤 위치를 그대로 되돌린다.
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

  // 위젯 프레임의 실제 출처 — 주고받는 메시지를 이 출처로 한정한다.
  // script.src 를 읽지 못해 origin 이 비어도(상대 경로 /widget → 호스트와 같은 출처)
  // 여기서 제대로 풀린다. http(s) 가 아니면(file: 등) 지정할 출처가 없으므로 '*' 로 둔다.
  var frameOrigin = '*';
  try {
    var resolved = new URL(iframe.src, window.location.href).origin;
    if (/^https?:\/\//.test(resolved)) frameOrigin = resolved;
  } catch (e) { /* noop */ }

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
    // 상담창은 밝은 화면 한 벌이다(globals.css `:root{color-scheme:light}` 와 같은 선언).
    // `normal` 은 「정하지 않음」이라 호스트 페이지의 배색·자동 다크 테마에 끌려간다.
    'color-scheme:light',
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

  // 전체화면(모바일)으로 열린 동안 호스트 페이지가 위젯 뒤에서 스크롤되지 않게 잠근다.
  // 잠글 때의 스크롤 위치와 원래 스타일을 기억해 두었다가 풀 때 그대로 되돌린다
  // (호스트 페이지가 자기 스타일로 overflow 를 쓰고 있을 수 있다).
  var locked = false;
  var lockY = 0;
  var prevOverflow = '';
  function lockHost(on) {
    if (on === locked || !document.body) return;
    try {
      if (on) {
        lockY = window.scrollY || window.pageYOffset || 0;
        prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
      } else {
        document.body.style.overflow = prevOverflow;
        window.scrollTo(0, lockY);
      }
      locked = on;
    } catch (e) { /* noop */ }
  }

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
    }, frameOrigin);
  }

  iframe.addEventListener('load', function () {
    sendViewport();
    // 문서는 떴지만 위젯 신호가 늦는 경우의 2차 안전망.
    setTimeout(reveal, 400);
  });

  window.addEventListener('message', function (ev) {
    // 자칭 이름(`d.source`)은 누구나 적을 수 있다 — **보낸 창**이 우리 iframe 인지를 먼저 본다.
    // 이 검사는 위조할 수 없다. 출처 문자열 비교는 그 위에 덧대는 2차 확인이다.
    if (ev.source !== iframe.contentWindow) return;
    if (frameOrigin !== '*' && ev.origin !== frameOrigin) return;
    var d = ev.data;
    if (!d || d.source !== 'gowon-chat') return;
    if (d.type === 'ready') { reveal(); sendViewport(); return; }
    if (d.type !== 'resize') return;
    reveal();
    lastOpen = !!d.open;
    lastFull = !!d.fullscreen;
    applyPlacement(lastFull);
    lockHost(lastFull);
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
      lockHost(false);
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      window.__gowonChatLoaded = false;
    }
  };
})();
