/* GOWON Chat 임베드 스니펫 (v0.9)
 * 사용법: <script src="https://<배포도메인>/embed.js" async></script>
 * 옵션(선택): data-position="left" | data-offset="24" | data-z="2147483000"
 *            data-tenant="eum"  ← 테넌트 프리셋(문구·색·FAQ 지식)을 바꿔 끼운다
 *
 * v0.9 변경점
 * - 상담창 프레임에 이름을 준다(id="gowon-chat-frame" · data-gowon-chat="frame"). 종전에는
 *   스크립트가 붙인 이 프레임을 **고객사 CSS 로 고를 이름이 없었다.**
 * - 고객사 페이지를 인쇄하면 상담창이 종이에 찍히던 것을 멈춘다 — 화면 위에 떠 있는 조작 화면은
 *   종이에 남을 것이 아니다. 인쇄 전용 규칙 한 줄을 함께 붙이고, 걷어낼 때 같이 거둔다.
 * - 설치할 때 적는 값을 **버리거나 그대로 싣지 않는다**: 형식에 맞지 않으면 기본값으로 띄우되
 *   그 사실과 이유를 브라우저 콘솔에 한국어로 적는다(설치하는 사람이 보는 유일한 자리다).
 *   종전에는 `data-z` 가 검사 없이 style 에 들어가 쌓임 순서가 통째로 사라지거나(`z-index:999px`)
 *   우리 배치 선언이 덮였고(`data-z="1;position:static"`), 형식이 틀린 `data-tenant` 는 말없이
 *   버려져 **고객사 안내 자료가 아닌 기본 상담창**이 떴다.
 * - 요청한 고객사가 실제로 걸렸는지 위젯이 알려 주고(ready 신호의 tenant), 다르면 역시 적는다.
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
  /**
   * 설치한 사람에게 말하는 유일한 자리.
   *
   * 이 스크립트를 붙이는 사람은 고객사 개발자이고, 그가 보는 화면은 브라우저 개발자 도구다.
   * 방문자 화면에는 한 글자도 적지 않는다 — 상담창은 그대로 뜬다(설정이 틀렸다고 상담창이
   * 사라지면 설치 사고가 곧 서비스 중단이 된다).
   */
  var warnings = [];
  function warn(msg) {
    warnings.push(msg);
    try {
      if (window.console && window.console.warn) window.console.warn('[GOWON 상담창] ' + msg);
    } catch (e) { /* noop */ }
  }

  if (window.__gowonChatLoaded) {
    // 두 번째 스니펫은 대개 옵션이 붙은 쪽이다(테마에 기본 한 줄이 있는데 담당자가 고객사
    // 설정을 붙여 한 줄 더 넣는다) — 그 옵션이 통째로 무시된다는 사실을 말해 준다.
    warn('설치 코드가 이 페이지에 두 번 들어 있습니다 — 먼저 읽은 한 줄만 적용하고, 이 줄에 적은 옵션은 무시합니다.');
    return;
  }
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

  /* ── 설치할 때 적는 값 네 가지 ──────────────────────────────────────────────
   * 네 값 모두 **같은 규약**으로 읽는다: 규격에 맞지 않으면 기본값으로 띄우되, 무엇을 버리고
   * 무엇으로 대신했는지 적는다. 종전에는 셋은 조용히 버리고 하나(`data-z`)는 검사 없이 style
   * 문자열에 이어 붙였다 — 단위가 붙은 값은 쌓임 순서 선언을 통째로 날리고(다른 요소에 가린다),
   * 세미콜론이 든 값은 우리 배치 선언을 덮었다.
   */
  var Z_DEFAULT = '2147483000';
  var OFFSET_MAX = 200;

  var sideRaw = String(attr('data-position', 'right')).trim().toLowerCase();
  var side = sideRaw === 'left' ? 'left' : 'right';
  if (sideRaw !== 'left' && sideRaw !== 'right') {
    warn('data-position="' + sideRaw + '" 은 쓸 수 없는 값입니다(left 또는 right). 오른쪽 아래에 띄웁니다.');
  }

  var offsetRaw = String(attr('data-offset', '0')).trim();
  var offset = parseInt(offsetRaw, 10);
  if (!isFinite(offset) || offset < 0) {
    if (offsetRaw !== '0') warn('data-offset="' + offsetRaw + '" 은 0 이상의 숫자가 아닙니다. 여백 없이(0px) 띄웁니다.');
    offset = 0;
  } else if (offset > OFFSET_MAX) {
    warn('data-offset="' + offsetRaw + '" 은 너무 커서 상담창이 화면 밖으로 나갑니다. 최대값 ' + OFFSET_MAX + 'px 로 띄웁니다.');
    offset = OFFSET_MAX;
  }

  var zRaw = String(attr('data-z', Z_DEFAULT)).trim();
  var zIndex = /^[0-9]{1,10}$/.test(zRaw) ? zRaw : Z_DEFAULT;
  if (zIndex !== zRaw) {
    warn('data-z="' + zRaw + '" 은 정수가 아닙니다 — 이대로 두면 쌓임 순서가 지정되지 않아 상담창이 다른 요소에 가립니다. 기본값 ' + Z_DEFAULT + ' 으로 띄웁니다.');
  }

  // 테넌트 식별자 — 서버도 같은 규칙으로 다시 검증한다(여기 검증은 잘못된 URL 생성 방지용).
  var tenantRaw = String(attr('data-tenant', '')).trim();
  var tenant = tenantRaw.toLowerCase();
  if (tenant && !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(tenant)) {
    // 이 한 줄이 틀리면 상담창은 멀쩡히 뜨는데 **고객사 안내 자료가 아닌 기본 구성**으로 답한다.
    // 방문자도 운영자도 그 차이를 화면에서 알 수 없다 — 설치한 사람에게 지금 말해야 한다.
    warn('data-tenant="' + tenantRaw + '" 은 고객사 식별자 형식이 아닙니다(영문 소문자·숫자·-·_ 로 32자까지). 고객사 설정 없이 기본 상담창으로 띄웁니다 — 고객사 안내 자료로 답하지 않습니다.');
    tenant = '';
  }

  var CLOSED = { w: 104, h: 104 };
  var OPEN = { w: 400, h: 660 };

  var iframe = document.createElement('iframe');
  iframe.src = origin + '/widget' + (tenant ? '?tenant=' + encodeURIComponent(tenant) : '');
  iframe.title = '상담 챗봇';
  iframe.setAttribute('allowtransparency', 'true');
  iframe.setAttribute('loading', 'lazy');
  // 이름(공개 계약) — 고객사 페이지가 자기 CSS 로도 이 프레임을 고를 수 있어야 한다.
  // 인쇄 규칙은 id 가 아니라 data 속성으로 건다(같은 id 를 쓰는 페이지와 겹치지 않는다).
  iframe.id = 'gowon-chat-frame';
  iframe.setAttribute('data-gowon-chat', 'frame');

  /**
   * 고객사 페이지를 종이로 남길 때 상담창은 거기 없어야 한다.
   *
   * 상담창은 화면 위에 떠 있는 **조작 화면**이지 그 페이지의 내용이 아니다. 종전에는 인쇄하면
   * 닫힌 런처가 본문 위에 찍히고, 열어 둔 채였다면 400×660 패널이 첫 장을 가렸다(전체화면이면
   * 첫 장이 통째로 상담창이다). 우리 콘솔에는 인쇄 규칙을 세워 두었으면서(globals.css) 정작
   * **고객사 페이지에는 아무 규칙도 보내지 않았다** — 그 페이지에서 우리를 숨기려 해도 프레임에
   * 이름이 없어 고객사가 직접 적을 수도 없었다.
   */
  var printStyle = null;
  try {
    var styleHost = document.head || document.documentElement;
    if (styleHost) {
      printStyle = document.createElement('style');
      printStyle.setAttribute('media', 'print');
      printStyle.appendChild(document.createTextNode('[data-gowon-chat="frame"]{display:none !important}'));
      styleHost.appendChild(printStyle);
    }
  } catch (e) {
    printStyle = null; // 규칙을 붙이지 못해도 상담창 자체는 뜬다
  }

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

  /**
   * 요청한 고객사가 **실제로 걸렸는가**.
   *
   * 형식이 맞아도 등록되지 않은 식별자면 서버는 기본 구성으로 띄운다 — 화면만 보고는 알 수 없다
   * (상담창은 멀쩡히 뜨고 답도 한다. 다만 고객사 안내 자료가 아닌 것으로 답한다).
   * 위젯이 「무엇으로 떴는지」를 준비 신호에 실어 보내므로, 요청과 다르면 여기서 말한다.
   * 옛 위젯은 이 칸이 없다 — 그때는 아무 말도 하지 않는다(알 수 없는 것을 단정하지 않는다).
   */
  var tenantChecked = false;
  function checkTenant(applied) {
    if (tenantChecked || !tenant) return;
    if (typeof applied === 'undefined') return;
    tenantChecked = true;
    if (applied === tenant) return;
    warn('data-tenant="' + tenant + '" 로 요청했지만 등록되지 않은 고객사라 기본 상담창으로 떴습니다 — 고객사 안내 자료로 답하지 않습니다. 관리 콘솔 「설치」 화면에서 식별자를 확인해 주세요.');
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
    if (d.type === 'ready') { reveal(); sendViewport(); checkTenant(d.tenant); return; }
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
    // 실제로 적용된 값 — 설치한 사람이 개발자 도구에서 바로 맞춰 볼 수 있는 자리다
    // (적어 준 값이 버려졌다면 `warnings` 에 그 이유가 한국어로 들어 있다).
    options: { tenant: tenant || null, position: side, offset: offset, zIndex: zIndex },
    warnings: warnings,
    element: function () { return iframe; },
    remove: function () {
      lockHost(false);
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      if (printStyle && printStyle.parentNode) printStyle.parentNode.removeChild(printStyle);
      window.__gowonChatLoaded = false;
    }
  };
})();
