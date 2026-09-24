// ClipNote - ChatGPT layout controller.
//
// Goal: make ClipNote behave like a real part of the ChatGPT conversation
// page, not a floating overlay. ChatGPT lays its app out as a flex row: the
// left navigation rail and the main chat column (#main -> #thread). There is
// no right rail to borrow, so ClipNote becomes a NEW full-height right-hand
// column seated inside that same flex row, directly after the element that
// contains the chat. The chat column (with its centered thread) simply gets
// a fixed-width slice taken off its right side - nothing inside #main is
// touched, no ChatGPT style is edited.
//
//   <app shell; display:flex; flex-direction:row>
//     <nav>      left navigation rail             (untouched)
//     <chat col> the element holding #main        (ChatGPT keeps full control)
//     #cn-sidebar-container                       <-- ClipNote (our element)
//
// Responsive rule: the panel is shown ONLY when the chat column still has real
// room to work beside it. When the window gets too narrow the panel hides
// completely (zero layout space, state preserved inside the iframe) so the
// page returns 100% to ChatGPT; when space returns (resize) it is promoted back
// into the flow.
//
// Restoration is trivial because we only ever add/remove OUR elements: the
// container and one owned <style> tag.

(() => {
  'use strict';

  if (!window.__CN || !window.__CN.chatgpt) return;
  const NS = window.__CN;
  const C = NS.chatgpt;
  if (C.__layoutLoaded) return;

  const STYLE_ID = 'cn-chatgpt-layout-style';
  const CONTAINER_ID = 'cn-sidebar-container';

  // Fixed width of the ClipNote column. Matches the extension's designed
  // sidebar width everywhere else.
  const COLUMN_WIDTH = 380;

  // The narrowest chat column ClipNote will sit beside. Anything narrower
  // means ChatGPT's own chat is too cramped and the panel hides instead.
  const MIN_CHAT_WIDTH = 360;

  // The narrowest host (app shell) that can ever host ClipNote.
  const MIN_HOST_WIDTH = COLUMN_WIDTH + MIN_CHAT_WIDTH;

  // mode: 'flow' (real in-flow right column) | 'hidden' (kept alive but zero
  // layout space so the chat reclaims the full window). `enabled` records the
  // adapter's mount state; the visible/hidden toggle only ever changes space.
  let state = null;
  // One pending frame callback id at a time (all events share the same rAF).
  let rafId = null;
  // True while a page capture/screenshot is in flight. captureActive FREEZES
  // the responsive show/hide decision: a resize, refresh or navigation that
  // happens mid-capture must not toggle the container's visibility (the actual
  // capture hide is a visibility:hidden class applied by the content script,
  // which keeps the column's layout space, so nothing needs to reflow). The
  // sidebar/content script pair sets this via C.layout.setCapture().
  let captureActive = false;

  const isVisible = (host) => {
    if (!host || !host.isConnected) return false;
    const rect = host.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const injectStyle = () => {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${CONTAINER_ID}.cn-host-chatgpt {
        flex: 0 0 auto;
        align-self: stretch;
        width: ${COLUMN_WIDTH}px;
        box-sizing: border-box;
        overflow: hidden;
        background: #1a1210;
        border-left: 1px solid rgba(0, 0, 0, 0.18);
      }
      #${CONTAINER_ID}.cn-host-chatgpt.cn-layout-hidden {
        display: none;
      }
      #${CONTAINER_ID}.cn-host-chatgpt iframe {
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

  // Hide the container completely (zero layout space, iframe state preserved).
  const hide = () => {
    if (!state) return;
    state.visible = false;
    if (state.container) state.container.classList.add('cn-layout-hidden');
  };

  // Show the container as an in-flow right column again.
  const show = () => {
    if (!state) return;
    state.visible = true;
    if (state.container) {
      state.container.classList.remove('cn-layout-hidden');
      state.container.removeAttribute('style');
    }
  };

  // Does the chat column still have room beside a full-width ClipNote column?
  const chatHasRoom = (host) => {
    return !!host && host.clientWidth >= MIN_HOST_WIDTH;
  };

  // Find the flex row that owns the chat column, so ClipNote can be seated as
  // a real sibling (right-hand column) WITHOUT touching anything inside #main.
  // Walks up from #main and takes the FIRST row-flex ancestor: on the live
  // page that is the app shell (or an equally stable chat-area row) that the
  // conversation column lives in. Returns { host, ref } = the row container and
  // the direct child of it that holds the chat, or null.
  const findHost = () => {
    const el = document.querySelector(C.selectors.main);
    if (!el || !el.isConnected) return null;
    let node = el;
    let parent = node.parentElement;
    let ref = node;
    while (parent && parent !== document.body && parent !== document.documentElement) {
      let style;
      try {
        style = window.getComputedStyle(parent);
      } catch (e) {
        return null;
      }
      if (style.display === 'flex' && (style.flexDirection === 'row' || style.flexDirection === 'row-reverse')) {
        return { host: parent, ref };
      }
      ref = parent;
      parent = parent.parentElement;
    }
    return null;
  };

  const recomputeVisibility = () => {
    if (!state || !state.host) return;
    // Capture freeze: a capture/screenshot is hiding the container right now.
    // Keep the CURRENT visibility untouched so a resize/refresh/navigation
    // during the capture can never toggle the panel or hand the page a layout
    // jump. Normal responsive behaviour resumes as soon as capture exits.
    if (captureActive) return;
    if (!state.host.isConnected || !isVisible(state.host)) {
      hide();
      return;
    }
    if (chatHasRoom(state.host)) {
      show();
    } else {
      hide();
    }
  };

  // Re-run on window resize, host box changes, SPA navigation and explicit
  // refresh() calls. Guarded so it can never fight itself.
  const refresh = () => {
    rafId = null;
    if (!state || !state.container) return;

    // Capture freeze: a capture/screenshot is in flight and the content script
    // is hiding the container (visibility class, layout slot preserved). Skip
    // ALL re-anchoring so a mid-capture re-render can never relocate the
    // sidebar; C.layout.setCapture(false) re-runs this once capture exits.
    if (captureActive) return;

    const found = findHost();
    if (state.mode === 'flow') {
      if (!found || state.host !== found.host) {
        C.layout.applyLayout(state.container);
        return;
      }
      recomputeVisibility();
      return;
    }

    // Hidden/pending mode: promote back into the flow as soon as a host row
    // exists and the chat has room.
    if (found && chatHasRoom(found.host)) {
      C.layout.applyLayout(state.container);
    }
  };

  const schedule = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(refresh);
  };

  const attachObserver = (host) => {
    if (state && state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    if (!host) return;
    const observer = new ResizeObserver(() => schedule());
    observer.observe(host);
    if (state) state.observer = observer;
  };

  C.layout = {
    // Find the host flex row + the chat ref, when they exist.
    findHost: function () {
      return findHost();
    },

    applyLayout: function (container) {
      const found = findHost();
      if (!found) return false;

      if (state && state.observer) {
        state.observer.disconnect();
        state.observer = null;
      }

      state = { container, host: found.host, ref: found.ref, observer: null, mode: 'flow', visible: true };

      // Clear any leftover inline styles from a previous state (including any
      // visibility fixes) so the sidebar is a plain in-flow block again.
      container.removeAttribute('style');
      container.classList.add('cn-host-chatgpt');
      injectStyle();

      // Seat the shared container as the right-hand sibling of the element
      // that holds the chat, inside the row that owns it.
      const refNext = found.ref.nextElementSibling;
      if (container.parentElement !== found.host || container.previousElementSibling !== found.ref) {
        found.host.insertBefore(container, refNext);
      }

      attachObserver(found.host);
      recomputeVisibility();
      requestAnimationFrame(() => recomputeVisibility());

      // Only claim success when the panel is really connected and visible.
      return container.isConnected && container.getBoundingClientRect().width > 0;
    },

    restoreLayout: function () {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (state && state.observer) {
        state.observer.disconnect();
        state.observer = null;
      }
      if (state && state.container && state.container.parentElement) {
        state.container.remove();
      }
      removeStyle();
      state = null;
    },

    // Called by the adapter whenever the page might have changed layout
    // (resize, SPA navigation, thread re-render), so the column re-anchors.
    refresh: function () {
      schedule();
    },

    // Freeze/unfreeze the responsive show/hide logic for the duration of a
    // page capture. Entered by the content script (CN_CAPTURE_MODE) when the
    // sidebar hides itself from a screenshot; exits on the matching restore
    // (or the hard safety timer). Does NOT add or remove any observer - it
    // only gates what the existing refresh pipeline may change.
    setCapture: function (on) {
      captureActive = !!on;
      // Leaving capture: the capture hide and the layout freeze are gone, so
      // hand the page back to the normal pipeline - re-verify visibility and,
      // if the page changed while we were frozen, re-anchor into it now.
      if (!on) schedule();
    },

    // Full teardown for when the extension context is invalidated: drop the
    // global resize watcher and the observer so a takeover copy never inherits
    // this copy's events, then restore the page to clean.
    destroy: function () {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      window.removeEventListener('resize', onResize);
      C.layout.restoreLayout();
    }
  };

  // One global listener per tab: kept alive by the guarded module flag, so a
  // popup re-injection can never register it twice. Bound to a named function
  // so destroy() can remove exactly this registration on shutdown.
  const onResize = () => schedule();
  window.addEventListener('resize', onResize);

  C.__layoutLoaded = true;
})();