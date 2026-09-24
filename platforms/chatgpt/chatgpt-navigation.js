// ClipNote - ChatGPT navigation hooks.
//
// ChatGPT is a SPA. contentScript.js already watches generic URL changes
// (back/forward, pushState/replaceState), which covers navigating between
// conversations (each has its own /c/<id> URL). This module adds the one case
// URL changes cannot see: the page silently swaps its #thread/#main subtree in
// place (e.g. re-render after a rename) without changing the URL. A DEBOUNCED,
// focused observer watches ONLY for the thread/main containers being swapped -
// never for per-stream token appends - so an animated assistant response never
// spams navigation work. The listener is guarded so a popup re-injection can
// never double-register.

(() => {
  'use strict';

  if (!window.__CN || !window.__CN.chatgpt) return;
  const NS = window.__CN;
  const C = NS.chatgpt;
  if (C.__navigationLoaded) return;

  let observer = null;
  let debounce = null;

  // The exact callback contentScript registered, remembered so teardown() can
  // clear it for a takeover copy.
  let callback = null;

  const DEBOUNCE_MS = 600;

  const notifyNavigation = () => {
    debounce = null;
    if (callback) callback();
  };

  const mightBeThreadSwap = (node) => {
    if (!node || node.nodeType !== 1) return false;
    if (node.id === 'thread' || node.id === 'main') return true;
    return false;
  };

  const onMutations = (mutations) => {
    let relevant = false;
    for (const m of mutations) {
      if (!m.addedNodes || m.addedNodes.length === 0) continue;
      for (const n of m.addedNodes) {
        if (mightBeThreadSwap(n)) {
          relevant = true;
          break;
        }
      }
      if (relevant) break;
    }
    if (!relevant) return;
    clearTimeout(debounce);
    debounce = setTimeout(notifyNavigation, DEBOUNCE_MS);
  };

  C.navigation = {
    setup: function (handleNavigation) {
      // Remember the callback we just received.
      callback = handleNavigation;
      const root = document.body || document.documentElement;
      if (!root || observer) return;
      observer = new MutationObserver(onMutations);
      observer.observe(root, { childList: true, subtree: true });
    },

    // Unhook the observer and any pending debounce. Called on shutdown of an
    // invalidated context; idempotent.
    teardown: function () {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      if (debounce) {
        clearTimeout(debounce);
        debounce = null;
      }
      callback = null;
    }
  };

  C.__navigationLoaded = true;
})();