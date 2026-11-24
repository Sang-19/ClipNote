// ClipNote Universal adapter entry point. Kept separate from dedicated platforms.
(() => {
  'use strict';
  const NS = (window.__CN = window.__CN || {});
  if (NS.__universalLoaded) return;
  NS.__universalLoaded = true;
  // The layout module registers the adapter. This file is intentionally a
  // small, isolated entry point so Universal never loads YouTube/Udemy/ChatGPT
  // adapters or their page-specific selectors.
})();
