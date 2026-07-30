/* 고원 챗봇 임베드 스니펫 (v0.1)
 * 사용법: <script src="https://<배포도메인>/embed.js" async></script>
 * 페이지 우하단에 챗봇 iframe을 삽입한다. 중복 삽입은 무시.
 */
(function () {
  if (window.__gowonChatLoaded) return;
  window.__gowonChatLoaded = true;

  var origin = '';
  try {
    var s = document.currentScript || document.querySelector('script[src*="embed.js"]');
    if (s && s.src) origin = new URL(s.src).origin;
  } catch (e) { /* noop */ }

  var iframe = document.createElement('iframe');
  iframe.src = origin + '/widget';
  iframe.title = '고원 상담 챗봇';
  iframe.setAttribute('allowtransparency', 'true');
  iframe.style.cssText = [
    'position:fixed', 'right:0', 'bottom:0', 'width:400px', 'height:640px',
    'max-width:100vw', 'max-height:100vh', 'border:0', 'background:transparent',
    'z-index:2147483000', 'color-scheme:normal'
  ].join(';');

  function mount() { document.body.appendChild(iframe); }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
