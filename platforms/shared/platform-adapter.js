// ClipNote - shared platform adapter base class and registry.
//
// Every platform module (platforms/youtube, platforms/udemy) plugs an adapter
// into this registry. contentScript.js asks the registry for the adapter that
// matches the current host page and delegates ALL platform-specific work to it
// (which video to bind, where the sidebar belongs, how to reserve layout space
// and how to hand it back). The ClipNote sidebar itself stays fully shared.

(() => {
  'use strict';

  // Guard: the popup re-injects these files on demand ("ON" click), even on
  // pages where the manifest already loaded them at document_idle. Each file
  // keeps a flag so a second copy cannot redefine anything twice.
  const NS = (window.__CN = window.__CN || {});
  if (NS.__sharedLoaded) return;

  const ADAPTERS = (NS.adapters = NS.adapters || []);

  // Ask the registry for the adapter of a given platform ("youtube"/"udemy").
  NS.getAdapter = function (platform) {
    return ADAPTERS.find((a) => a.platform === platform) || null;
  };

  // Base class every platform adapter extends. The shared sidebar lifecycle
  // in contentScript.js only ever talks to this interface.
  NS.PlatformAdapter = class PlatformAdapter {
    constructor(platform) {
      this.platform = platform;
      // True while our sidebar container lives inside the host layout.
      this.sidebarMounted = false;
      // Does this platform play a real video? Video platforms keep the
      // timestamp/seek pipeline; video-less platforms (ChatGPT) set this to
      // false so the shared code skips video-bound capture and never shows or
      // fakes a video timestamp.
      this.hasVideo = true;
    }

    // URL-level checks.
    isSupportedPage() { return false; }
    isWatchPage() { return false; }

    // Preferred host video element for this platform (fast path), or null so
    // the shared findVideo() loop falls back to generic detection.
    findPreferredVideo() { return null; }

    // Build the "video context" object the sidebar stores on notes. Shape is
    // the same contract as before the refactor (see getVideoContext messages).
    getVideoContext() { return null; }

    // Optional screenshot fallback when no frame could be captured.
    getScreenshotFallback(videoEl) { return null; }

    // Put the shared sidebar container into the host layout. Must reserve real
    // layout space (never a floating overlay) whenever the platform allows it,
    // and fall back to the overlay only as a last resort. Returns true when
    // the sidebar is placed in-flow, false when the overlay was used.
    // Implementations may be async (e.g. Udemy waits a bounded time for its
    // sidebar anchor instead of flashing an overlay while the DOM renders);
    // contentScript.js awaits mountSidebar() either way.
    mountSidebar(container) { return false; }

    // Remove the sidebar and restore the original host layout.
    unmountSidebar(container) {}

    // Re-apply the layout (SPA navigation, DOM replacement, breakpoint change).
    applyLayout(container) { return false; }

    // Reverse everything applyLayout() did to the host page.
    restoreLayout() {}

    // Platform-specific navigation hooks (e.g. YouTube's yt-navigate-finish).
    setupNavigation(handleNavigation) {}

    // Notification that the page just navigated; refresh platform state.
    handleNavigation() {}

    // Enter/exit capture mode. During a page screenshot the container is
    // hidden with a visibility:hidden class (its layout slot stays put, so the
    // page never reflows); adapters that run responsive hide/show logic
    // (ChatGPT) freeze it here so that logic can never fight the capture hide.
    // Optional - implementations can ignore it.
    setCapture(on) {}

    // The on-page content area a "page screenshot" should be cropped to, in
    // CSS viewport pixels, intersected with the visible viewport (null when
    // the capture should stay full-viewport). The sidebar pre-crops the
    // captured frame to this rectangle and clamps the interactive selection to
    // it, so the final image contains ONLY the host content (e.g. the ChatGPT
    // conversation area) - never the browser chrome, unrelated host controls,
    // or ClipNote itself. This is deliberately a SEPARATE concept from where
    // the sidebar is mounted. Video platforms have no on-page content region
    // and simply inherit the null default (full-viewport captures unchanged).
    // Optional - implementations can ignore it.
    getScreenshotTarget() { return null; }

    // Full teardown, run when the extension context is invalidated (reload /
    // update) so a takeover copy never inherits this copy's listeners,
    // ResizeObservers or timers. Optional - implementations can ignore it.
    destroy() {}
  };

  NS.__sharedLoaded = true;
})();