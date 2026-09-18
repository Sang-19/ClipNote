// ClipNote - YouTube platform adapter.
//
// Implements the PlatformAdapter interface with YouTube-specific behaviour:
//   * URL detection for /watch and /embed/ pages
//   * Main-player video preference and thumbnail fallback
//   * Video context (videoId + videoTitle)
//   * Transcript support (the only platform that has it)
//   * Layout = a dedicated slot at the top of YouTube's right rail
//     (see youtube-layout.js); the player and the rail's own panels/related
//     list are never covered. When the rail has no usable space ClipNote is
//     hidden (it never becomes a fixed overlay).
//   * SPA navigation via yt-navigate-finish (see youtube-navigation.js)

(() => {
  'use strict';

  if (!window.__CN) return;
  const NS = window.__CN;
  const Y = NS.youtube;
  if (!Y || !NS.PlatformAdapter || Y.__adapterLoaded) return;

  if (NS.getAdapter('youtube')) return;

  class YouTubeAdapter extends NS.PlatformAdapter {
    constructor() {
      super('youtube');
    }

    isSupportedPage() {
      const host = location.hostname.toLowerCase();
      return host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com';
    }

    isWatchPage() {
      // A watch page is exactly /watch (plus an optional query), or an /embed/
      // page the player binds to. Shorts/live are intentionally NOT watch pages
      // here: they have no rail to host the sidebar (and videoId() still
      // understands their URLs for stable folder identities). /watchlater and
      // similar paths never match.
      return /^\/watch(\/|$)/.test(location.pathname) || /^\/embed\//.test(location.pathname);
    }

    findPreferredVideo() {
      return Y.video.findPreferredVideo();
    }

    getVideoContext() {
      return {
        ok: true,
        platform: 'youtube',
        videoUrl: location.href,
        title: document.title,
        videoId: Y.video.videoId() || '',
        videoTitle: Y.video.videoTitle()
      };
    }

    getScreenshotFallback() {
      return Y.video.screenshotFallback();
    }

    mountSidebar(container) {
      // Put the sidebar into the rail when the rail has usable space; when it
      // does not, applyLayout() returns false and contentScript.js keeps a
      // bounded promotion retry running. There is deliberately NO fixed overlay
      // fallback: if there is no room for ClipNote in the page, ClipNote stays
      // out of the way until there is.
      const inFlow = Y.layout.applyLayout(container);
      this.sidebarMounted = inFlow;
      return inFlow;
    }

    unmountSidebar() {
      Y.layout.restoreLayout();
      this.sidebarMounted = false;
    }

    applyLayout(container) {
      const inFlow = Y.layout.applyLayout(container);
      Y.layout.refresh();
      return inFlow;
    }

    restoreLayout() {
      Y.layout.restoreLayout();
    }

    setupNavigation(handleNavigation) {
      Y.navigation.setup(handleNavigation);
    }

    handleNavigation() {
      // The stale #secondary-inner from the previous video is dead; the next
      // applyLayout() call (issued by contentScript.js) will locate the fresh
      // containers of the new watch page.
      Y.layout.refresh();
    }
  }

  NS.adapters.push(new YouTubeAdapter());
  Y.__adapterLoaded = true;
})();