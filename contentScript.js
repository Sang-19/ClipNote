// ClipNote - content script orchestrator.
//
// This file is deliberately platform-agnostic. It owns the pieces every
// platform shares (video capture pipeline, toasts, the message protocol, the
// generic URL-change watchers, the sidebar lifecycle) and asks the active
// platform adapter (platforms/) for everything platform-specific:
//
//   * which video element to bind to            -> adapter.findPreferredVideo()
//   * the current video context metadata       -> adapter.getVideoContext()
//   * where the shared sidebar belongs         -> adapter.mountSidebar()
//   * how to reserve layout space / restore it -> adapter.applyLayout() /
//                                                 adapter.restoreLayout()
//   * host-specific navigation events          -> adapter.setupNavigation()
//
// YouTube and Udemy have DIFFERENT host DOMs, handled by their own layout
// controller (platforms/youtube/youtube-layout.js and
// platforms/udemy/udemy-layout.js). Nothing here manipulates host-page CSS.

(() => {
  'use strict';

  // The popup injects this file on demand even though the manifest already
  // declares it, so guard against a SECOND copy running. Without this, every
  // capture/seek message is handled twice (duplicate toasts, double seeks,
  // and "message port closed" warnings) which looks like inconsistent UX.
  //
  // The guard is LIFECYCLE-AWARE. A content script can outlive its extension
  // context (the extension is reloaded/updated/reinstalled from
  // chrome://extensions, or its service worker dies). Its JS keeps executing
  // inside the page but EVERY chrome.* call starts throwing
  // "Extension context invalidated". A stale copy must therefore never block a
  // fresh, valid copy from initializing in the same tab: instead of honouring
  // a bare "running" flag, the new copy asks the running one whether it is
  // still contextually alive and tears it down when it is not.
  if (window.__cnContentScriptRunning) {
    const running = window.__cnLifecycle;
    // A copy that is still contextually alive keeps deduping as before.
    if (running && typeof running.isContextValid === 'function' && running.isContextValid()) {
      return;
    }
    // Stale copy (invalidated context, or an older build without lifecycle
    // support): shut it down and take over. Best effort only - the shutdown
    // routine strictly avoids any extension API.
    if (running && typeof running.shutdown === 'function') {
      try { running.shutdown(); } catch (e) { /* best effort */ }
    } else {
      // Older build left only the flag: remove its visible leftovers.
      document.querySelectorAll('#cn-sidebar-container').forEach((el) => el.remove());
    }
  }
  // Mark this tab so later copies of the script skip straight out.
  window.__cnContentScriptRunning = true;

  // Global namespace exposed by platforms/shared/platform-adapter.js.
  const CN = window.__CN;

  // ------------------- Extension-context lifecycle -------------------

  // True once THIS copy has shut itself down. Once set, every chrome.* call
  // is blocked and the copy never reacts again - even after the extension is
  // reloaded and chrome.runtime.id reappears. An invalidated context never
  // turns valid again, and this flag is what makes the old copy stay inert.
  let contextInvalidated = false;

  // Is THIS copy's extension context still usable? A content script's context
  // is alive exactly while its extension id is set. After the extension is
  // reloaded/updated/reinstalled, chrome.runtime.id becomes undefined - which
  // is the reliable, documented way to detect invalidation BEFORE calling any
  // chrome.* API (those would throw).
  function isContextValid() {
    if (contextInvalidated) return false;
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  // Match the exact error Chrome throws once an extension context dies. Only
  // THIS error is ever swallowed by the lifecycle; every other error is still
  // reported normally.
  function isExtensionContextInvalidated(error) {
    if (!error) return false;
    const text = String((error && error.message) || error);
    return text.indexOf('Extension context invalidated') !== -1;
  }

  // Navigation-watcher handles so a dead copy can unhook every listener and
  // every history wrapper it installed (a fresh copy must never inherit a
  // stale copy's wrappers).
  let navCheckFn = null;
  let originalPushState = null;
  let originalReplaceState = null;
  let wrappedPushState = null;
  let wrappedReplaceState = null;

  // Tear this content script down after its extension context died. Idempotent.
  // Uses DOM/window APIs ONLY - chrome.* must never be touched here. It is
  // called (a) when this copy detects the invalidation itself and (b) by a
  // fresh copy that takes over the page after a reload/update.
  function shutdownInvalidatedContext() {
    if (contextInvalidated) return;
    contextInvalidated = true;
    // Stop the bounded sidebar promotion retry.
    clearPromotionRetry();
    // Disconnect the sidebar health-check observer.
    stopSidebarHealthCheck();
    // Cancel any open screenshot selection overlay (pure DOM, safe).
    cancelScreenOverlay();
    // Invalidate any mount that is still waiting for the host DOM.
    mountGeneration++;
    // Remove the sidebar without touching any extension API.
    if (adapter && adapter.unmountSidebar) {
      try { adapter.unmountSidebar(sidebarContainer); } catch (e) { /* best effort */ }
    } else if (sidebarContainer && sidebarContainer.isConnected) {
      try { sidebarContainer.remove(); } catch (e) { /* best effort */ }
    }
    document.querySelectorAll('#cn-sidebar-container').forEach((el) => el.remove());
    sidebarContainer = null;
    // Drop the video binding and the navigation wiring it installed.
    videoEl = null;
    stopNavigationWatchers();
    // Release the page-level guard so a fresh, valid copy can initialize in
    // this tab once the extension is back.
    try { delete window.__cnContentScriptRunning; } catch (e) { /* best effort */ }
    try { delete window.__cnLifecycle; } catch (e) { /* best effort */ }
  }

  // The public lifecycle contract a re-injected copy consults BEFORE honouring
  // the "running" flag (see the guard at the top of this file). Function
  // declarations above are hoisted, so exposing them here is safe.
  window.__cnLifecycle = {
    // Ask whether this (possibly stale) copy's context is still alive.
    isContextValid: () => isContextValid(),
    // Ask it to stop everything and release the page-level guard.
    shutdown: () => shutdownInvalidatedContext()
  };

  // Keep track of a fixed number of milliseconds.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // True once the user has turned the extension on.
  let cnEnabled = false;
  // The video element currently playing on the page.
  let videoEl = null;
  // A hidden canvas used to draw the video frame.
  let captureCanvas = null;
  // The drawing context of that canvas.
  let captureCtx = null;
  // The shared sidebar container (created once, hosted by the platform layout).
  let sidebarContainer = null;
  // Bounded timer that promotes the sidebar from the temporary overlay into the
  // real host layout once the platform's anchor appears (never runs forever).
  let promoteRetryTimer = null;
  // In-flight mount promise + generation token: lets concurrent injectSidebar()
  // calls share one mount, and lets an unmount invalidate a mount that is still
  // waiting for the host DOM (never restart a container after navigation-off).
  let pendingMount = null;
  let mountGeneration = 0;
  // Heartbeat of the current page: incremented whenever the URL/video context
  // changes so long-running operations (capture, screenshot selection) can
  // detect that the page changed underneath them and refuse to commit stale
  // results into a brand-new video.
  let navigationGeneration = 0;
  // The one and only sidebar health-check observer for this page.
  let sidebarHealthObserver = null;

  // ----------------------- Platform -----------------------

  // Return the site we're running on ("youtube", "udemy", or null).
  // Uses an EXPLICIT allowlist so lookalike/subdomain hosts (music.youtube.com,
  // m.youtube.com is the mobile watch host and IS allowed, studio.youtube.com,
  // subdomains of udemy.com, etc.) are never misdetected. Anything not on the
  // list gets a null adapter, so those pages never start a sidebar, mount a
  // container, or burn promotion-retry timers.
  function getPlatform() {
    const host = location.hostname.toLowerCase();
    if (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com') return 'youtube';
    if (host === 'udemy.com' || host === 'www.udemy.com') return 'udemy';
    return null;
  }

  // The adapter registered by the matching platforms/* module for this host.
  const adapter = (CN && CN.getAdapter) ? CN.getAdapter(getPlatform()) : null;

  // Does the current URL hold a playable video page?
  function isWatchPage() {
    return !!adapter && adapter.isWatchPage();
  }

  // Build the full "video context" object for the current page. The shape is
  // unchanged from before the refactor (the sidebar relies on it).
  function getVideoContext() {
    if (adapter && adapter.getVideoContext) return adapter.getVideoContext();
    return {
      ok: true,
      platform: getPlatform(),
      videoUrl: location.href,
      title: document.title,
      videoId: ''
    };
  }

  // ----------------------- Helpers -----------------------

  // Turn a number of seconds into "MM:SS" text.
  function formatTimestamp(seconds) {
    seconds = Math.max(0, Math.floor(seconds || 0));
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // Create a unique id for each note or screenshot.
  function uuid() {
    if (self.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // The current video time in whole seconds, or null when no video is usable
  // right now (not bound, detached, or reporting a non-finite/negative time).
  // Capture/Screenshot/Seek all validate against this before committing.
  function currentVideoTime() {
    if (!videoEl || !videoEl.isConnected) return null;
    const t = videoEl.currentTime;
    return (Number.isFinite(t) && t >= 0) ? Math.floor(t) : null;
  }

  // ----------------------- Video -----------------------

  // Generic video discovery: biggest visible <video>, else most-ready <video>.
  function findGenericVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    const visible = videos
      .filter((v) => v.offsetWidth > 0 && v.offsetHeight > 0)
      .sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight));
    if (visible.length) return visible[0];
    const ready = videos
      .filter((v) => v.readyState >= 1 || v.poster || v.currentSrc)
      .sort((a, b) => ((b.videoWidth || 0) * (b.videoHeight || 0)) - ((a.videoWidth || 0) * (a.videoHeight || 0)));
    if (ready.length) return ready[0];
    return null;
  }

  // Loop until we find a real video element on the page. Each platform's
  // adapter gets first pick (YouTube's .html5-main-video, Udemy's video.js);
  // the generic fallback keeps the pipeline alive when neither matches.
  async function findVideo(timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // The extension may be reloaded while we poll: stop cleanly instead of
      // burning a chrome.* call against a dead context.
      if (!isContextValid()) {
        shutdownInvalidatedContext();
        return null;
      }
      if (adapter && adapter.findPreferredVideo) {
        const preferred = adapter.findPreferredVideo();
        if (preferred) return preferred;
      }
      const generic = findGenericVideo();
      if (generic) return generic;
      await sleep(300);
    }
    return null;
  }

  // Make sure we know which video is playing, then return it.
  async function ensureVideo() {
    videoEl = await findVideo(3000);
    return videoEl;
  }

  // Wait until the video finishes moving to a new position.
  function waitForSeek() {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        videoEl.removeEventListener('seeked', finish);
        resolve();
      };
      videoEl.addEventListener('seeked', finish);
      setTimeout(finish, 1500);
    });
  }

  // ----------------------- Capture -----------------------

  // Draw the current video frame onto a canvas and return it as an image.
  async function captureFrameDataUrl() {
    if (!videoEl) return null;
    // Streaming players can expose the <video> element long before any frame
    // decodes. Drawing an undecoded video yields a blank image, so wait a
    // moment for real pixel dimensions to appear.
    const giveUpAt = Date.now() + 3000;
    while (Date.now() < giveUpAt) {
      // If our video got detached mid-capture, tell the caller to re-bind to
      // the newest instance and try again.
      if (!videoEl.isConnected) return 'STALE';
      if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) break;
      await sleep(100);
    }
    if (!videoEl.videoWidth || !videoEl.videoHeight) return null;

    const srcW = videoEl.videoWidth;
    const srcH = videoEl.videoHeight;
    const outW = srcW;
    const outH = srcH;
    if (!captureCanvas) {
      captureCanvas = document.createElement('canvas');
      captureCtx = captureCanvas.getContext('2d');
    }
    if (captureCanvas.width !== outW || captureCanvas.height !== outH) {
      captureCanvas.width = outW;
      captureCanvas.height = outH;
    }
    try {
      captureCtx.drawImage(videoEl, 0, 0, outW, outH);
      const dataUrl = captureCanvas.toDataURL('image/jpeg', 0.9);
      return typeof dataUrl === 'string' && dataUrl.startsWith('data:image/') ? dataUrl : null;
    } catch (e) {
      return null;
    }
  }

  // Build a full "capture" object for a moment in the video. The timestamp is
  // read AFTER the frame settles so it always matches the video that actually
  // produced the image (a STALE retry may rebind to a fresher element).
  async function captureFrame() {
    let dataUrl = await captureFrameDataUrl();
    for (let attempt = 0; attempt < 3 && dataUrl === 'STALE'; attempt++) {
      await ensureVideo();
      dataUrl = await captureFrameDataUrl();
    }
    if (dataUrl === 'STALE') dataUrl = null;

    const timestamp = currentVideoTime();
    const cap = {
      id: uuid(),
      timestamp: timestamp == null ? 0 : timestamp,
      humanTime: formatTimestamp(timestamp == null ? 0 : timestamp),
      screenshot: { type: 'none' },
      annotation: ''
    };

    if (dataUrl) {
      cap.screenshot = { type: 'data-url', dataUrl };
    } else if (adapter && adapter.getScreenshotFallback) {
      // Platform-specific fallback (YouTube thumbnail / Udemy poster).
      const url = adapter.getScreenshotFallback(videoEl);
      if (url) cap.screenshot = { type: 'remote-url', url };
    } else {
      const poster = videoEl && videoEl.poster;
      if (poster) cap.screenshot = { type: 'remote-url', url: poster };
    }
    return cap;
  }

  // ----------------------- Toast -----------------------

  // Show a small popup message near the bottom of the page.
  function showToast(message) {
    const toast = document.createElement('div');
    toast.textContent = message;
    Object.assign(toast.style, {
      position: 'fixed',
      zIndex: '2147483647',
      bottom: '64px',
      right: '24px',
      background: 'rgba(0,0,0,0.85)',
      color: '#fff',
      padding: '8px 12px',
      borderRadius: '6px',
      fontSize: '12px',
      maxWidth: '280px'
    });
    document.documentElement.appendChild(toast);
    setTimeout(() => toast.remove(), 1800);
  }

  // ----------------------- Sidebar -----------------------

  // Create the shared sidebar container + iframe. WHERE it goes on the page is
  // decided by the active platform adapter, never here.
  function createSidebarContainer() {
    // If the extension context died (reload/update/reinstall), building a
    // sidebar is pointless AND chrome.runtime.getURL below would throw
    // "Extension context invalidated" (the exact reported crash). Tear the
    // page down cleanly instead of attempting the API call.
    if (!isContextValid()) {
      shutdownInvalidatedContext();
      return null;
    }
    const container = document.createElement('div');
    container.id = 'cn-sidebar-container';
    container.style.background = '#1a1210';

    // A per-tab token embedded in the iframe URL. The sidebar compares it
    // against its own location so it can prove which content script/page it
    // belongs to, and this content script echoes it back when feeding the
    // sidebar the host-page URL. Together they guarantee the sidebar can never
    // target the ACTIVE tab that happens to be a different page or window.
    const frameToken = uuid();
    container.dataset.cnFrameToken = frameToken;

    // chrome.runtime.getURL is the very first extension API this path touches,
    // so it is the one that must not throw on a dead context.
    let sidebarUrl = null;
    try {
      sidebarUrl = chrome.runtime.getURL('sidebar/sidebar.html');
    } catch (e) {
      // Only the invalidation error is swallowed; anything else is real.
      if (isExtensionContextInvalidated(e)) {
        shutdownInvalidatedContext();
        return null;
      }
      throw e;
    }

    const iframe = document.createElement('iframe');
    iframe.src = sidebarUrl + '?frame=' + encodeURIComponent(frameToken);
    // Once the sidebar is live, feed it the URL of the page hosting US so it
    // can resolve the id of the tab that owns it - even when its primary
    // chrome.runtime.getContexts() path is unavailable. The token keeps the
    // handshake from being confused by any other listener.
    iframe.addEventListener('load', () => {
      try {
        iframe.contentWindow.postMessage({ type: 'CN_HOST_URL', url: location.href, frameToken }, '*');
      } catch (e) { /* ignore */ }
    }, { once: true });
    container.appendChild(iframe);
    return container;
  }

  // Runtime state for the "global on/off" vs "active on THIS page" model:
  //   * cnEnabled       - user turned ClipNote on (storage-backed, popup)
  //   * activeVideoPage - we are on a watch/lecture page AND injected
  // The two are orthogonal: enabled-but-inactive keeps pages clean, and a
  // detached page (SPA navigation) can be re-initialized without a toggle.
  // NOTE: "injected" here means the container was created (cnEnabled) on a
  // watch page; it may still be awaiting real layout space until the host
  // DOM renders, so connectedness is intentionally not part of this check.

  // Add the sidebar. Delegates its placement + layout to the platform adapter.
  // Guarantees there is EXACTLY one sidebar host on the page: stale containers
  // left behind by earlier navigations are removed first. Resolves after the
  // platform had a chance to mount (the bounded Udemy mount can wait for its
  // anchor), and never rejects.
  async function injectSidebar() {
    // A dead extension context must never rebuild a sidebar.
    if (!isContextValid()) {
      shutdownInvalidatedContext();
      return;
    }
    if (sidebarContainer && sidebarContainer.isConnected) return;
    // Reuse an already-running mount instead of building a second container.
    if (pendingMount) return pendingMount;
    pendingMount = (async () => {
      // Capture this attempt's identity so an unmount happening while we wait
      // for the host DOM can cancel us before anything is inserted.
      const generation = ++mountGeneration;
      // Everything mounts inside a try so a dead/changed context can never
      // reject out of this IIFE (the health-check observer calls it without a
      // rejection handler, and an unhandled rejection here was the original
      // "Extension context invalidated" console crash after a reload).
      try {
        document.querySelectorAll('#cn-sidebar-container').forEach((el) => {
          if (el !== sidebarContainer) el.remove();
        });
        const container = createSidebarContainer();
        // Invalidation mid-flight: shutdown already tore everything down.
        if (!container) return;
        sidebarContainer = container;
        // The health check should be live from the moment the container exists,
        // even while the platform is still waiting for its host layout.
        startSidebarHealthCheck();
        let inFlow = false;
        try {
          if (adapter && adapter.mountSidebar) {
            inFlow = await adapter.mountSidebar(container);
          } else {
            // Unknown platform: keep the old behaviour (right-edge overlay).
            Object.assign(container.style, {
              position: 'fixed', top: '0', right: '0',
              width: '360px', height: '100vh',
              zIndex: '2147483647',
              borderLeft: '1px solid rgba(0,0,0,0.15)'
            });
            document.documentElement.appendChild(container);
          }
        } catch (e) {
          console.error('[SNT] mount error', e);
          inFlow = false;
        }
        // A newer toggle/navigation invalidated this attempt mid-wait: undo
        // whatever the platform just mounted so no orphan container survives.
        if (generation !== mountGeneration) {
          container.remove();
          if (adapter && adapter.unmountSidebar) adapter.unmountSidebar(container);
          return;
        }
        // Not mounted in-flow yet - line up the bounded promotion retry.
        if (!inFlow) startPromotionRetry();
      } catch (e) {
        // Only the invalidation case is silently absorbed; everything else is
        // a real error and must stay visible.
        if (!isExtensionContextInvalidated(e)) console.error('[SNT] mount error', e);
      }
    })();
    try {
      await pendingMount;
    } finally {
      pendingMount = null;
    }
  }

  // Remove the sidebar and restore the original host layout. Cancels any
  // in-flight screenshot selection and promotion retry so nothing leaks into
  // the next page, and stops the health-check observer.
  function removeSidebar() {
    stopSidebarHealthCheck();
    clearPromotionRetry();
    cancelScreenOverlay();
    // Invalidate any mount still waiting for the host DOM.
    mountGeneration++;
    if (adapter && adapter.unmountSidebar) {
      adapter.unmountSidebar(sidebarContainer);
    } else if (sidebarContainer && sidebarContainer.parentElement) {
      sidebarContainer.remove();
    }
    sidebarContainer = null;
  }

  // Cancel any screenshot selection overlay that may be open right now.
  function cancelScreenOverlay() {
    if (CN && CN.ScreenshotSelector && CN.ScreenshotSelector.cancel) {
      CN.ScreenshotSelector.cancel();
    }
  }

  // Stop the bounded promotion retry timer.
  function clearPromotionRetry() {
    if (promoteRetryTimer) {
      clearInterval(promoteRetryTimer);
      promoteRetryTimer = null;
    }
  }

  // Keep trying to seat the sidebar in the real host layout. Bounded: once the
  // anchor becomes available applyLayout() returns true and we stop; otherwise
  // we give up after a fixed number of attempts so a rail-less page never
  // loops forever. Stopped on unmount or when leaving the watch page.
  function startPromotionRetry() {
    clearPromotionRetry();
    let tries = 0;
    promoteRetryTimer = setInterval(() => {
      // The extension context may have died while we waited for the anchor;
      // a dead copy must stop retrying the sidebar host entirely.
      if (!isContextValid()) {
        shutdownInvalidatedContext();
        return;
      }
      tries++;
      // Keep promoting while the user is enabled AND on a watch page. The
      // container may not be connected yet while it waits for real layout
      // space (Udemy mounts in-flow only when its sidebar DOM exists), so
      // connectedness is not required here; unmounting sets sidebarContainer
      // to null and this check stops the timer immediately.
      if (!cnEnabled || !sidebarContainer || !isWatchPage()) {
        clearPromotionRetry();
        return;
      }
      if ((adapter && adapter.applyLayout && adapter.applyLayout(sidebarContainer)) || tries >= 20) {
        clearPromotionRetry();
      }
    }, 800);
  }

  // ----------------------- Messaging -----------------------

  // Listen for messages from the popup and the sidebar.
  function setupMessageHandlers() {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !msg.type) return;

      // The popup sent the on/off toggle.
      if (msg.type === 'CN_TOGGLE') {
        (async () => {
          try {
            cnEnabled = !!msg.enabled;
            if (cnEnabled) {
              // Only mount on a real watch/lecture page. Search, results, home
              // and course pages must stay ClipNote-free (global enabled, but
              // this page is not an active video page yet).
              if (isWatchPage()) {
                await injectSidebar();
                // Re-armed here too: after OFF -> ON the observer was stopped
                // by removeSidebar() even if the container itself survived.
                startSidebarHealthCheck();
                ensureVideo();
              } else {
                removeSidebar();
              }
            } else {
              removeSidebar();
            }
            sendResponse({ ok: true });
          } catch (e) {
            console.error('[SNT] toggle error', e);
            sendResponse({ ok: false, error: e.message || String(e) });
          }
        })();
        return true;
      }

      // The sidebar already captured the visible tab and asks us to display it as a
      // FROZEN, selectable layer. The rectangle response waits until the drag
      // completes or the user cancels. The frozen background is the captured
      // frame sent in `msg.dataUrl` - the live page is never visible while
      // selecting, so playing video, animations, overlays or DOM changes cannot
      // sway the selection. The timestamp is validated BEFORE the layer opens:
      // a screenshot Moment must never be stamped with a fake 00:00 because the
      // video happened to be missing.
      if (msg.type === 'CN_SCREENSHOT_SELECT') {
        (async () => {
          const gen = navigationGeneration;
          // Only resume the video we ourselves froze; `wasPlaying` stays false
          // when the user already had it paused (nothing to restore).
          let wasPlaying = false;
          const restoreVideo = () => {
            if (!wasPlaying) return;
            // Never resume a video that now belongs to a different page: after
            // navigation the paused element may be a brand-new video.
            if (gen !== navigationGeneration) return;
            if (videoEl && videoEl.isConnected && videoEl.paused) {
              videoEl.play().catch(() => {});
            }
          };
          try {
            if (!CN || !CN.ScreenshotSelector || !CN.ScreenshotSelector.start) {
              sendResponse({ ok: false, error: 'Screenshot selector is not available.' });
              return;
            }
            // The frozen layer needs a real captured frame (the sidebar is the
            // only context allowed to call chrome.tabs.captureVisibleTab).
            if (typeof msg.dataUrl !== 'string' || !msg.dataUrl.startsWith('data:image/')) {
              sendResponse({ ok: false, error: 'Screenshot data is not available. Please try again.' });
              return;
            }

            // Confirm we can report a real timestamp before asking the user to
            // drag anything. Try to recover a missing/stale video first.
            let ts = currentVideoTime();
            if (ts == null) {
              videoEl = await findVideo(2000);
              ts = currentVideoTime();
            }
            if (ts == null) {
              sendResponse({ ok: false, error: 'Video is not ready. Please try again.' });
              return;
            }

            // Freeze the live player while the frozen frame is shown. The frame
            // itself is the authoritative static surface (opaque, immovable);
            // pausing the video just stops the soundtrack and any player
            // animation progressing behind it. Restored on finish/cancel below.
            if (videoEl && videoEl.isConnected && !videoEl.paused) {
              wasPlaying = true;
              videoEl.pause();
            }

            const rect = await CN.ScreenshotSelector.start({ backgroundImage: msg.dataUrl });
            // The 3-second window of the overlay is enough for navigation: if
            // the page moved on, never create a Moment against the new video.
            if (gen !== navigationGeneration) {
              if (CN.ScreenshotSelector.cancel) CN.ScreenshotSelector.cancel();
              restoreVideo();
              sendResponse({ ok: false, cancelled: true });
              return;
            }
            if (!rect) {
              restoreVideo();
              sendResponse({ ok: false, cancelled: true });
              return;
            }

            // The video may have been replaced while the user dragged; refresh
            // the timestamp from the current binding, or abort.
            if (currentVideoTime() == null) {
              videoEl = await findVideo(2000);
            }
            ts = currentVideoTime();
            if (ts == null) {
              restoreVideo();
              sendResponse({ ok: false, error: 'Video is not ready. Please try again.' });
              return;
            }
            restoreVideo();
            showToast('Screenshot selected');
            sendResponse({ ok: true, rect, timestamp: ts, humanTime: formatTimestamp(ts) });
          } catch (e) {
            if (CN && CN.ScreenshotSelector && CN.ScreenshotSelector.cancel) {
              CN.ScreenshotSelector.cancel();
            }
            restoreVideo();
            sendResponse({ ok: false, error: e.message || String(e) });
          }
        })();
        return true;
      }

      // The sidebar asked for the current video details.
      if (msg.type === 'CN_GET_VIDEO_CONTEXT') {
        sendResponse(getVideoContext());
        return;
      }

      // The sidebar asked the video to jump to a time.
      if (msg.type === 'CN_SEEK_TO') {
        (async () => {
          try {
            // Validate the requested time before touching the player:
            // undefined/null/NaN/Infinity collapse to 0, negatives to 0, and
            // absurdly large values clamp to the end of the video.
            let seconds = Number(msg.seconds);
            if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;

            if (videoEl && !videoEl.isConnected) videoEl = null;
            videoEl = videoEl || (await findVideo(2000));
            if (!videoEl || !videoEl.isConnected) { sendResponse({ ok: false, error: 'Video is not ready.' }); return; }
            const duration = videoEl.duration;
            if (Number.isFinite(duration) && duration > 0 && seconds > duration) {
              seconds = duration;
            }
            videoEl.currentTime = seconds;
            videoEl.play().catch(() => {});
            sendResponse({ ok: true });
          } catch (e) {
            sendResponse({ ok: false, error: e.message || String(e) });
          }
        })();
        return true;
      }

      // The sidebar asked to capture the current frame.
      if (msg.type === 'CN_CAPTURE_NOW') {
        (async () => {
          const gen = navigationGeneration;
          try {
            if (!(await ensureVideo())) throw new Error('No video element found');
            // A capture must never produce a 00:00 Moment from a stale, dead,
            // or broken video handle.
            if (currentVideoTime() == null) throw new Error('Video is not ready. Please try again.');
            const cap = await captureFrame();
            if (gen !== navigationGeneration) throw new Error('The page changed during capture. Please try again.');
            showToast(`Captured at ${cap.humanTime}`);
            sendResponse({ ok: true, capture: cap });
          } catch (e) {
            sendResponse({ ok: false, error: e.message || String(e) });
          }
        })();
        return true;
      }

      // The sidebar asked to capture the video at a specific time.
      if (msg.type === 'CN_CAPTURE_AT') {
        (async () => {
          const gen = navigationGeneration;
          try {
            if (!(await ensureVideo())) throw new Error('No video element found');
            if (!videoEl.isConnected || currentVideoTime() == null) {
              throw new Error('Video is not ready. Please try again.');
            }
            let target = Number(msg.seekTo);
            if (!Number.isFinite(target) || target < 0) target = 0;
            const duration = videoEl.duration;
            if (Number.isFinite(duration) && duration > 0 && target > duration) {
              target = duration;
            }
            const wasPaused = videoEl.paused;
            videoEl.currentTime = target;
            await waitForSeek();
            await sleep(150);
            const cap = await captureFrame();
            cap.timestamp = Math.floor(target);
            cap.humanTime = formatTimestamp(target);
            // Restore pause state when the user was watching paused.
            if (wasPaused && !videoEl.paused) videoEl.pause();
            if (gen !== navigationGeneration) throw new Error('The page changed during capture. Please try again.');
            showToast(`Captured at ${cap.humanTime}`);
            sendResponse({ ok: true, capture: cap });
          } catch (e) {
            sendResponse({ ok: false, error: e.message || String(e) });
          }
        })();
        return true;
      }

      });
  }

  // ----------------------- Navigation -----------------------

  // Called whenever the user moves to another page (SPA or full reload).
  // Lifecycle-aware: detect the watch page, mount; on any other page stay
  // dormant and clean up. Never throws so the URL-change listeners stay alive.
  async function handleNavigation() {
    // The extension context can die between two SPA navigations (a reload at
    // chrome://extensions while the tab keeps running). Never touch chrome.*
    // from a dead copy - just drop everything.
    if (!isContextValid()) {
      shutdownInvalidatedContext();
      return;
    }
    try {
      if (!cnEnabled) return;
      // The URL changed: invalidate any in-flight capture/screenshot that was
      // working against the previous video so it can never commit stale data.
      navigationGeneration++;
      // Forget the old video so we go find the new one.
      videoEl = null;

      // Leaving a watch page (search / results / course listing) means ClipNote
      // has no place here: drop the sidebar, overlay, timers and video binding.
      if (!isWatchPage()) {
        removeSidebar();
        return;
      }

      // Still on a watch page: confirm exactly one sidebar and let the platform
      // re-anchor the same container into the freshly rendered layout.
      if (adapter && adapter.handleNavigation) adapter.handleNavigation();
      if (sidebarContainer && sidebarContainer.isConnected) {
        if (adapter && adapter.applyLayout) {
          const ok = adapter.applyLayout(sidebarContainer);
          if (!ok) startPromotionRetry();
        }
      } else {
        await injectSidebar();
      }
      ensureVideo();
    } catch (e) {
      console.error('[SNT] navigation error', e);
    }
  }

  // Listen for generic URL changes (back/forward, hash, pushState/replaceState).
  // These are browser-level and shared by both platforms.
  function setupNavigationWatchers() {
    let lastUrl = location.href;
    let timer = null;
    const checkUrl = () => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        handleNavigation();
      }
    };
    // Remember the exact listener so a shutdown can remove it (a fresh copy
    // must never inherit a stale copy's listeners).
    navCheckFn = checkUrl;
    window.addEventListener('popstate', checkUrl);
    window.addEventListener('hashchange', checkUrl);

    // Wrap the history functions so we notice when SPA pages "navigate".
    // The pristine implementations are remembered so a shutdown can restore
    // them - a takeover must never stack wrappers on top of wrappers.
    const rawPush = history.pushState;
    const rawReplace = history.replaceState;
    const makeWrap = (original) => function (...args) {
      const result = original.apply(this, args);
      clearTimeout(timer);
      timer = setTimeout(checkUrl, 150);
      return result;
    };
    wrappedPushState = makeWrap(rawPush);
    wrappedReplaceState = makeWrap(rawReplace);
    history.pushState = wrappedPushState;
    history.replaceState = wrappedReplaceState;
    originalPushState = rawPush;
    originalReplaceState = rawReplace;
  }

  // Remove the navigation listeners/wrappers installed above (idempotent).
  // Part of the invalidation shutdown: a stale copy leaves the page exactly as
  // it found it so the fresh copy starts from a clean slate.
  function stopNavigationWatchers() {
    if (navCheckFn) {
      window.removeEventListener('popstate', navCheckFn);
      window.removeEventListener('hashchange', navCheckFn);
      navCheckFn = null;
    }
    // Restore the pristine history implementation, but ONLY while the current
    // implementation is still our own wrapper (a newer copy may have wrapped
    // us already - restoring the raw function then would break it).
    if (wrappedPushState && history.pushState === wrappedPushState && originalPushState) {
      history.pushState = originalPushState;
    }
    if (wrappedReplaceState && history.replaceState === wrappedReplaceState && originalReplaceState) {
      history.replaceState = originalReplaceState;
    }
    wrappedPushState = null;
    wrappedReplaceState = null;
    originalPushState = null;
    originalReplaceState = null;
  }

  // Stop the sidebar health-check observer. Safe to call when none is active.
  function stopSidebarHealthCheck() {
    if (sidebarHealthObserver) {
      sidebarHealthObserver.disconnect();
      sidebarHealthObserver = null;
    }
  }

  // Watch the page for deletion of the sidebar host DOM. Some platforms
  // (especially YouTube) garbage-collect DOM subtrees during navigation; when
  // the host removes the element holding our sidebar we re-create and re-host
  // it without toggling the enabled state - but only while still on a watch
  // page. Lifecycle rules:
  //   * exactly one observer per page (never a second one)
  //   * started when a sidebar container is (re)created
  //   * stopped when the sidebar is removed (toggle-off / leaving a watch page)
  // Disconnecting an existing observer first makes start/stop idempotent, so
  // toggle ON -> OFF -> ON and SPA navigation can never stack observers.
  function startSidebarHealthCheck() {
    stopSidebarHealthCheck();
    const root = document.body || document.documentElement;
    if (!root) return;
    const observer = new MutationObserver((muts) => {
      // The extension context may have died while the host DOM was mutating
      // (exactly what triggers the reported crash). Re-mounting must stop.
      if (!isContextValid()) {
        shutdownInvalidatedContext();
        return;
      }
      if (!cnEnabled || !sidebarContainer || !sidebarHealthObserver) return;
      for (const m of muts) {
        if (m.removedNodes && Array.from(m.removedNodes).some((n) =>
          n === sidebarContainer || (n.contains && n.contains(sidebarContainer)))) {
          // injectSidebar() never rejects, but keep a handler anyway so a
          // future regression can never surface as an uncaught promise error.
          if (isWatchPage()) injectSidebar().then(() => {}, (e) => console.error('[SNT] re-mount failed', e));
          else removeSidebar();
          return;
        }
      }
    });
    sidebarHealthObserver = observer;
    observer.observe(root, { childList: true, subtree: true });
  }

  // ----------------------- Init -----------------------

  // Read a setting from Chrome's storage.
  function getSetting(key) {
    return new Promise((resolve) => {
      // If the context died before/while we read, resolve null silently - the
      // shutdown already stopped everything else.
      if (!isContextValid()) {
        shutdownInvalidatedContext();
        return resolve(null);
      }
      chrome.storage.local.get([key], (res) => {
        resolve(chrome.runtime.lastError ? null : res[key]);
      });
    });
  }

  // Startup code: gets everything ready once the page loads.
  async function init() {
    // Register the message handler FIRST. If we awaited storage first, a
    // CN_TOGGLE sent in that gap would find no listener, and with the
    // duplicate-run guard the fallback injection would skip registering too.
    setupMessageHandlers();
    setupNavigationWatchers();
    if (adapter && adapter.setupNavigation) adapter.setupNavigation(handleNavigation);

    // Read the flag from the new key, falling back to the pre-rename key.
    let stored = await getSetting('clipnote_enabled');
    if (stored == null) {
      stored = await getSetting('vke_enabled');
      if (stored != null) {
        // Migration is best effort: if the context dies mid-write the fresh
        // copy that takes over re-runs init and migrates again.
        try {
          chrome.storage.local.set({ clipnote_enabled: stored }, () => {
            if (!chrome.runtime.lastError) chrome.storage.local.remove('vke_enabled');
          });
        } catch (e) {
          if (!isExtensionContextInvalidated(e)) console.error('[SNT] migrate error', e);
        }
      }
    }
    // The context may have been invalidated while init awaited storage: stop.
    if (!isContextValid()) {
      shutdownInvalidatedContext();
      return;
    }
    cnEnabled = !!stored;

    // Only bring up ClipNote on a real watch/lecture page. Search pages,
    // results, course listings and the YouTube home feed stay untouched: no
    // sidebar, no video polling, no capture pipeline.
    if (cnEnabled && isWatchPage()) {
      await injectSidebar();
      videoEl = await findVideo();
    }
  }

  // Run init, and log it if anything goes wrong.
  init().catch((e) => console.error('[SNT] init error', e));
})();