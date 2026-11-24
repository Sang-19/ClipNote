// Universal adapter for ordinary HTTP(S) pages; dedicated sites are excluded.
(() => {
  'use strict';
  const NS = window.__CN, U = NS && NS.universal;
  if (!NS || !U || !U.layout || !NS.PlatformAdapter || NS.getAdapter('universal')) return;
  const excluded = new Set(['youtube.com','www.youtube.com','m.youtube.com','udemy.com','www.udemy.com','chatgpt.com','www.chatgpt.com','chat.openai.com']);
  class UniversalAdapter extends NS.PlatformAdapter {
    constructor() { super('universal'); this.hasVideo = false; }
    isSupportedPage() { return /^https?:$/.test(location.protocol) && !excluded.has(location.hostname.toLowerCase()); }
    isWatchPage() { return this.isSupportedPage(); }
    findPreferredVideo() { return null; }
    getVideoContext() { return { ok: true, platform: 'universal', videoUrl: location.href, title: document.title || location.hostname, videoId: '' }; }
    getScreenshotFallback() { return null; }
    mountSidebar(container) { return U.layout.apply(container); }
    unmountSidebar() { U.layout.restore(); }
    applyLayout(container) { return U.layout.apply(container); }
    restoreLayout() { U.layout.restore(); }
    handleNavigation() {}
    destroy() { U.layout.destroy(); }
  }
  NS.adapters.push(new UniversalAdapter());
})();
