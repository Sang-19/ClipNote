// ClipNote - YouTube navigation hooks.
//
// YouTube is a SPA: it swaps watch pages in place without a full reload and
// signals that with the "yt-navigate-finish" window event. contentScript.js
// watches generic URL changes for both platforms; this module adds the extra
// YouTube-specific signal. The listener is guarded so a popup re-injection can
// never double-register.

(() => {
  'use strict';

  if (!window.__CN || !window.__CN.youtube) return;
  const NS = window.__CN;
  const Y = NS.youtube;
  if (Y.__navigationLoaded) return;

  Y.navigation = {
    // YouTube fires this after it swaps in a new page in place.
    setup: function (handleNavigation) {
      window.addEventListener('yt-navigate-finish', handleNavigation);
    }
  };

  Y.__navigationLoaded = true;
})();