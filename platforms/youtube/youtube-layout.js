// ClipNote - YouTube layout controller.
//
// Goal: make ClipNote behave like a real part of the YouTube watch page, not
// a floating overlay. YouTube's watch page already has a right rail
// (#secondary > #secondary-inner) holding the engagement panels (#panels) and
// the related list (#related). The dedicated slot for ClipNote is the TOP of
// that rail: the player keeps its full width/track, and the rail's own content
// (panels + related) is pushed DOWN, never covered.
//
//   ytd-watch-flexy
//     ├─ #primary            (player / description / comments)  stays untouched
//     └─ #secondary
//         └─ #secondary-inner
//             ├─ #cn-sidebar-container   <-- ClipNote (our element)
//             ├─ #panels                 <-- pushed down intact
//             └─ #related                <-- pushed down intact
//
// Responsive rule: ClipNote is shown ONLY when the rail actually has enough
// real layout space to host it. Wide windows: the rail sits beside the player
// and ClipNote is the user-visible right column. Narrow windows: YouTube moves
// the rail below the player or collapses/hides it entirely; when the rail is
// not usable we HIDE ClipNote (no fixed overlay, no reserved column) so the
// page returns 100% to YouTube. When the rail becomes usable again (resize /
// theater toggle / SPA navigation) ClipNote is promoted back into the flow.
//
// Restoration is trivial because we only ever add/remove OUR elements: the
// container and one owned <style> tag. No YouTube styles are edited.

(() => {
  'use strict';

  if (!window.__CN || !window.__CN.youtube) return;
  const NS = window.__CN;
  const Y = NS.youtube;
  if (Y.__layoutLoaded) return;

  const STYLE_ID = 'cn-youtube-layout-style';
  const CONTAINER_ID = 'cn-sidebar-container';

  // Panel height relative to the viewport when parked in the rail. Sized so at
  // least three screenshot cards stay visible without burying the related list.
  const HEIGHT_RATIO = 0.65;
  const HEIGHT_MIN = 360;
  const HEIGHT_MAX = 760;

  // The narrowest rail ClipNote will sit in. Reuses ClipNote's own designed
  // column width (the former fixed panel was 360px; YouTube's related rail is
  // ~402px), rather than inventing an arbitrary number. Anything slimmer than
  // this means there is genuinely not enough space for the sidebar's UI.
  const MIN_RAIL_WIDTH = 360;

  // mode: 'rail' (in-flow inside #secondary-inner) | 'hidden' (no usable space;
  // the container is kept alive but takes up NO layout space anywhere).
  let state = null;
  // One pending frame callback id at a time (all events share the same rAF).
  let rafId = null;

  const isDisplayed = (el) => {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const injectStyle = () => {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${CONTAINER_ID}.cn-host-youtube {
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
      }
      #${CONTAINER_ID}.cn-host-youtube iframe {
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

  const recomputeHeight = () => {
    if (!state || !state.container) return;
    if (state.mode !== 'rail') return;
    const target = Math.min(
      HEIGHT_MAX,
      Math.max(HEIGHT_MIN, Math.round(window.innerHeight * HEIGHT_RATIO))
    );
    if (state.container.style.height !== `${target}px`) {
      state.container.style.height = `${target}px`;
    }
  };

  // Make the sidebar take up nothing at all. The container (and its iframe)
  // stay alive and mounted inside the page, so every bit of sidebar state is
  // preserved; only its layout box disappears. YouTube reclaims the space.
  const hide = () => {
    if (state && state.container) state.container.style.display = 'none';
  };

  // Insert the container at the top of the rail, before #panels when possible.
  const insertIntoRail = (container, rail) => {
    const panels = rail.querySelector(Y.selectors.panels);
    const target = panels && panels.parentElement === rail ? panels : rail.firstChild;
    rail.insertBefore(container, target);
  };

  // True when the rail is a real, displayed, wide-enough host for ClipNote.
  // This is the ONLY space decision ClipNote makes: it is based on the actual
  // measured layout (what YouTube is really showing), never on window width.
  const isUsableRail = (rail) => {
    return !!rail && rail.isConnected && isDisplayed(rail) && rail.clientWidth >= MIN_RAIL_WIDTH;
  };

  // Watch the anchor's box so a later size/visibility change (resize, below-
  // player stack, theater collapse, SPA swap) re-runs the layout decision.
  // Exactly one observer exists at a time; re-attached whenever the anchor
  // changes identity and released on restore.
  const attachObserver = (rail) => {
    if (state && state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    if (!rail) return;
    const observer = new ResizeObserver(() => schedule());
    observer.observe(rail);
    if (state) state.observer = observer;
  };

  // Re-run on window resize, anchor box changes, SPA navigation and explicit
  // refresh() calls. Guarded so it can never fight itself.
  const refresh = () => {
    rafId = null;
    if (!state || !state.container) return;

    const rail = Y.layout.findRail();

    if (state.mode === 'rail') {
      if (!isUsableRail(rail)) {
        // The rail collapsed, was hidden, or became too narrow: hide ClipNote
        // completely (zero layout space) instead of pinning it on top of the
        // page. The iframe stays alive so all sidebar state is preserved.
        hide();
        state.mode = 'hidden';
        return;
      }
      if (state.anchor !== rail) {
        // The rail element itself was swapped (e.g. after SPA navigation) but
        // is still usable; re-parent into the fresh one and re-watch it.
        state.anchor = rail;
        attachObserver(rail);
        state.container.removeAttribute('style');
        insertIntoRail(state.container, rail);
        recomputeHeight();
        return;
      }
      recomputeHeight();
      return;
    }

    // Hidden mode: promote back into the flow as soon as a usable rail exists.
    if (rail && isUsableRail(rail)) {
      Y.layout.applyLayout(state.container);
    }
  };

  const schedule = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(refresh);
  };

  Y.layout = {
    // Find the watch-page right rail wherever it currently sits, but only when
    // it is genuinely usable (displayed and wide enough). Returns the
    // #secondary-inner element (or #secondary) or null.
    findRail: function () {
      const inner = document.querySelector(Y.selectors.secondaryInner);
      if (isUsableRail(inner)) return inner;
      const secondary = document.querySelector(Y.selectors.secondary);
      if (isUsableRail(secondary)) return secondary;
      return null;
    },

    applyLayout: function (container) {
      const rail = Y.layout.findRail();
      if (!rail) return false;

      // Clear any leftover inline styles from a previous state (including a
      // previous display:none) so the sidebar is a plain in-flow block again.
      container.removeAttribute('style');
      container.classList.add('cn-host-youtube');
      injectStyle();

      insertIntoRail(container, rail);
      state = { container, anchor: rail, mode: 'rail', observer: null };

      attachObserver(rail);
      recomputeHeight();
      requestAnimationFrame(recomputeHeight);
      return true;
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
    // (breakpoint changes, SPA navigation), so the container re-anchors.
    refresh: function () {
      schedule();
    },

    // Full teardown for when the extension context is invalidated: drop the
    // global resize watcher and the observer so a takeover copy never inherits
    // this copy's events, then restore the page to byte-for-byte clean.
    destroy: function () {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      window.removeEventListener('resize', onResize);
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

  // One global listener per tab: kept alive by the guarded module flag, so a
  // popup re-injection can never register it twice. Bound to a named function
  // so destroy() can remove exactly this registration on shutdown.
  const onResize = () => schedule();
  window.addEventListener('resize', onResize);

  Y.__layoutLoaded = true;
})();