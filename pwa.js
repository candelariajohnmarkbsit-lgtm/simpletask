/* Registers the service worker and powers the "Install app" button */
(function () {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (err) {
        console.warn('Service worker registration failed:', err);
      });
    });
  }

  var deferredPrompt = null;
  function button() { return document.getElementById('installBtn'); }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    if (button()) button().classList.remove('hidden');
  });

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    if (button()) button().classList.add('hidden');
  });

  document.addEventListener('DOMContentLoaded', function () {
    var b = button();
    if (!b) return;
    if (deferredPrompt) b.classList.remove('hidden');
    b.addEventListener('click', async function () {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      b.classList.add('hidden');
    });
  });
})();
