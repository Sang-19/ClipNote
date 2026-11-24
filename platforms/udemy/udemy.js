// ClipNote - Udemy platform adapter.
//
// Implements the PlatformAdapter interface with Udemy-specific behaviour:
//   * URL detection for /learn/lecture/ pages
//   * Video.js player preference
//   * Lecture/course metadata for the video context
//   * Layout = a real slot at the top of Udemy's own sidebar column
//     (see udemy-layout.js); course content stays intact below it.

(() => {
  'use strict';

  if (!window.__CN) return;
  const NS = window.__CN;
  const U = NS.udemy;
  if (!U || !NS.PlatformAdapter || U.__adapterLoaded) return;

  if (NS.getAdapter('udemy')) return;

  class UdemyAdapter extends NS.PlatformAdapter {
    constructor() {
      super('udemy');
    }

    isSupportedPage() {
      const host = location.hostname.toLowerCase();
      return host === 'udemy.com' || host === 'www.udemy.com';
    }

    isWatchPage() {
      return /\/learn\/lecture\//.test(location.pathname);
    }

    findPreferredVideo() {
      return U.video.findPreferredVideo();
    }

    getVideoContext() {
      const ctx = {
        ok: true,
        platform: 'udemy',
        videoUrl: location.href,
        title: document.title,
        videoId: ''
      };
      return Object.assign(ctx, U.video.meta());
    }

    getScreenshotFallback(videoEl) {
      return U.video.screenshotFallback(videoEl);
    }

    // The lecture video's on-screen rectangle, used as the crop target when the
    // drawn frame cannot be saved (cross-origin canvas taint). Video platforms
    // have no "content region" for page screenshots, so this is only consumed by
    // the "+ Capture" visible-tab fallback, never by the shared Screenshot flow.
    getScreenshotTarget() {
      return U.video.videoRect();
    }

    async mountSidebar(container) {
      const inFlow = await U.layout.mount(container);
      this.sidebarMounted = inFlow;
      return inFlow;
    }

    unmountSidebar() {
      U.layout.restoreLayout();
      this.sidebarMounted = false;
    }

    applyLayout(container) {
      // Re-anchor path used by the bounded promotion retry: try the real slot
      // first, fall back to the temporary overlay only when the anchor is
      // genuinely missing (data-purpose="sidebar-content" not rendered).
      return U.layout.promote(container);
    }

    restoreLayout() {
      U.layout.restoreLayout();
    }

    handleNavigation() {
      // Nothing to do here: the next applyLayout() call (issued by
      // contentScript.js after navigation) locates the freshly rendered
      // sidebar container and moves the sidebar into it.
    }

    // Full teardown when the extension context is invalidated. The Udemy copy
    // registers no global listeners, so this mirrors the layout restore.
    destroy() {
      U.layout.destroy();
    }
  }

  NS.adapters.push(new UdemyAdapter());
  U.__adapterLoaded = true;
})();