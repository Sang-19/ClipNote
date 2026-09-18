// ClipNote - Udemy layout controller.
//
// Rules this module follows (nothing may violate them):
//   * The ClipNote sidebar lives INSIDE Udemy's own sidebar scroll container
//     ([data-purpose="sidebar-content"]), not floating over the page.
//   * The course content (.ct-sidebar-course-content) is the host content and
//     must remain intact: it stays BELOW ClipNote, directly visible.
//   * #cn-sidebar-container and .ct-sidebar-course-content are SIBLINGS under
//     [data-purpose="sidebar-content"]. ClipNote is NEVER inserted inside the
//     course-content list.
//   * We never edit Udemy's own styles. We only insert OUR element and ONE
//     <style> tag we own, so restoring the layout is "remove + remove".
//   * There is NO fixed/absolute overlay. ClipNote occupies real layout space
//     inside the sidebar, or it is not shown at all.

(() => {
  'use strict';

  if (!window.__CN || !window.__CN.udemy) return;
  const NS = window.__CN;
  const U = NS.udemy;
  if (U.__layoutLoaded) return;

  const STYLE_ID = 'cn-udemy-layout-style';
  const CONTAINER_ID = 'cn-sidebar-container';

  // How tall the ClipNote panel may be relative to the sidebar scroll area,
  // so the course content below always keeps most of the space. Sized so at
  // least three screenshot cards stay visible without burying the course list.
  const HEIGHT_RATIO = 0.55;
  const HEIGHT_MIN = 280;
  const HEIGHT_MAX = 680;

  // Holds the last mounted state so restoreLayout() / refresh know where to
  // undo. Never touches Udemy's own styles.
  let state = null;

  const injectStyle = () => {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${CONTAINER_ID}.cn-host-udemy {
        position: relative;
        display: block;
        width: 100%;
        box-sizing: border-box;
        flex: 0 0 auto;
        flex-shrink: 0;
        overflow: hidden;
        background: #1a1210;
        margin-bottom: 12px;
        border-radius: 6px;
        border-bottom: 1px solid rgba(0, 0, 0, 0.18);
      }
      #${CONTAINER_ID}.cn-host-udemy iframe {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
        background: #1a1210;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  };

  const removeStyle = () => {
    const s = document.getElementById(STYLE_ID);
    if (s) s.remove();
  };

  // Bounded wait constants: how long to look for the Udemy sidebar anchor once
  // a lecture page is detected, and how often to re-poll while waiting.
  const BOUNDED_WAIT_MS = 4000;
  const BOUNDED_POLL_MS = 200;

  // Pick a bounded height for the ClipNote slot. The number is derived from
  // the anchor's real on-screen height and re-measured on resize.
  const recomputeHeight = () => {
    if (!state || !state.container || !state.anchor) return;
    if (!state.anchor.isConnected) return;
    const anchorH = state.anchor.clientHeight || 0;
    const target = anchorH
      ? Math.min(HEIGHT_MAX, Math.max(HEIGHT_MIN, Math.round(anchorH * HEIGHT_RATIO)))
      : Math.min(HEIGHT_MAX, Math.max(HEIGHT_MIN, Math.round(window.innerHeight * HEIGHT_RATIO)));
    if (state.container.style.height !== `${target}px`) {
      state.container.style.height = `${target}px`;
    }
  };

  // Find the host course-content element INSIDE the sidebar scroll container.
  // Returns the element (the direct child that must stay BELOW ClipNote) or
  // null when the sidebar has not rendered the course list yet.
  const findCourseContent = (anchor) => {
    if (!anchor) return null;
    for (const sel of U.selectors.courseContent || []) {
      const el = anchor.querySelector(sel);
      if (el) return el;
    }
    return null;
  };

  // The sidebar scroll container counts as "ready to host ClipNote" only when
  // BOTH the anchor and its course content exist, so the container can be
  // seated as a proper sibling BEFORE the course list.
  const isHostReady = (anchor) => {
    const course = anchor && findCourseContent(anchor);
    return !!course && course.parentElement === anchor;
  };

  U.layout = {
    // The Udemy sidebar scroll container that hosts both ClipNote and the
    // course content. Returns the element or null.
    findAnchor: function () {
      return U.queryFirst(U.selectors.sidebarContent);
    },

    // Reserve a real slot for the sidebar inside Udemy's sidebar column. The
    // container is seated as a SIBLING of the course content, immediately
    // BEFORE it. Refuses to mount (returns false; callers wait/retry) whenever
    // the sidebar scroll container or its course list are not rendered yet, so
    // ClipNote can never end up inside or on top of the course content.
    applyLayout: function (container) {
      if (state && state.observer) {
        state.observer.disconnect();
        state.observer = null;
      }

      const anchor = U.layout.findAnchor();
      if (!anchor) return false;

      // The course list must exist as a direct child of the sidebar colum.
      // Without it we cannot guarantee the sibling relationship, so do not
      // mount at all - keep the slot real layout space, never an overlay.
      const course = findCourseContent(anchor);
      if (!course || course.parentElement !== anchor) return false;

      state = { container, anchor, observer: null };

      // Clear any leftover inline styles from a previous page so the card is
      // a plain in-flow block again.
      container.removeAttribute('style');
      container.classList.add('cn-host-udemy');
      injectStyle();

      // Re-seat the shared container only when it is not already in the exact
      // target position (sibling of the course list, right before it).
      if (container.parentElement !== anchor || container.nextElementSibling !== course) {
        anchor.insertBefore(container, course);
      }

      recomputeHeight();
      requestAnimationFrame(recomputeHeight);

      // Keep the slot sized correctly when the window or sidebar resizes.
      // Observes only our Udemy anchor; the height change never re-triggers
      // this observer (clientHeight of the column is unaffected by content).
      state.observer = new ResizeObserver(() => recomputeHeight());
      state.observer.observe(anchor);

      // Verify the ClipNote host actually landed inside the live document and
      // occupies horizontal space (insertion can only be reported as success
      // when the page can really show it).
      return container.isConnected && container.getBoundingClientRect().width > 0;
    },

    // Bounded wait for the Udemy sidebar to become ready to host ClipNote. The
    // lecture sidebar can lag document_idle (SPA render), so mounting waits a
    // short capped time for BOTH the anchor and its course list instead of
    // flashing a fixed overlay immediately. Never blocks forever.
    waitForAnchor: function (timeoutMs, pollMs) {
      const deadline = Date.now() + timeoutMs;
      return new Promise((resolve) => {
        const tick = () => {
          const anchor = U.layout.findAnchor();
          if (isHostReady(anchor) || Date.now() >= deadline) return resolve(anchor || null);
          setTimeout(tick, pollMs);
        };
        tick();
      });
    },

    // Preferred entry point for Udemy. Tries to mount in-flow immediately,
    // otherwise waits a bounded time for the sidebar DOM. Returns true when the
    // sidebar occupies real layout space directly above the course content,
    // false when the host was not ready (callers re-try with a bounded loop).
    mount: async function (container) {
      if (U.layout.applyLayout(container)) return true;
      const anchor = await U.layout.waitForAnchor(BOUNDED_WAIT_MS, BOUNDED_POLL_MS);
      return anchor && U.layout.applyLayout(container);
    },

    // Re-anchor the container during the bounded promotion retry used by
    // contentScript.js (SPA navigation, late-rendered sidebar).
    promote: function (container) {
      if (!isHostReady(U.layout.findAnchor())) return false;
      return U.layout.applyLayout(container);
    },

    restoreLayout: function () {
      if (state && state.observer) {
        state.observer.disconnect();
        state.observer = null;
      }
      if (state && state.container && state.container.parentElement) {
        state.container.remove();
      }
      removeStyle();
      state = null;
    }
  };

  U.__layoutLoaded = true;
})();