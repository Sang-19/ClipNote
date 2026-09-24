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

  // The exact listener this module registered, so teardown() can remove the
  // very same function reference when the extension context is invalidated.
  let navHandler = null;

  Y.navigation = {
    // YouTube fires this after it swaps in a new page in place.
    setup: function (handleNavigation) {
      // Remember the precise listener we add: a fresh copy taking over after
      // an extension reload must be able to remove ours and add its own.
      navHandler = handleNavigation;
      window.addEventListener('yt-navigate-finish', navHandler);
    },
    // Unhook the navigation listener. Called on shutdown of an invalidated
    // context; idempotent (nothing registered means nothing to remove).
    teardown: function () {
      if (navHandler) {
        window.removeEventListener('yt-navigate-finish', navHandler);
        navHandler = null;
      }
    }
  };

  Y.__navigationLoaded = true;
})();