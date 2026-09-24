// ClipNote - interactive webpage screenshot selection.
//
// Shared, platform-independent module. When the user clicks "Screenshot" in
// the sidebar, the sidebar FIRST captures the visible tab AS IT IS - ClipNote
// sidebar included, nothing hidden and nothing cropped. contentScript.js then
// asks this module to cover the whole page with a temporary selection layer.
// The layer shows that captured frame as a STATIC, opaque background, so what
// the user confirms or selects is an immutable copy of the page at the moment
// of capture - the live page (video, animations, UI) may keep running
// underneath but it is never visible and never part of the selection.
//
// By default the ENTIRE visible frame is selected: a plain click (no drag)
// saves the full page EXACTLY as it was on screen, ClipNote and all. Dragging
// crops the saved image to the dragged rectangle. The area outside the
// rectangle is dimmed, the rectangle itself is highlighted with a live size
// readout. The layer is torn down when the drag ends, on Escape, or when the
// window loses focus.
//
// The overlay sits above EVERYTHING on the host page and swallows pointer,
// wheel and key events for its whole lifetime, so the video can never be
// played/paused, seeked, scrolled, or triggered while the selection is open.
// Coordinates returned are plain CSS-pixel viewport coordinates (the drag
// happens on a fixed full-viewport layer), which is exactly what the captured
// tab image maps to.
//
// Nothing here knows about YouTube, Udemy, or any host DOM. There is no
// content-target confinement and no exclusion zone anywhere in this module -
// the frame is never narrowed, only a straight crop of what was visible.

(() => {
  'use strict';

  const NS = (window.__CN = window.__CN || {});
  if (NS.__screenshotSelectorLoaded) return;

  // The smallest drag (in CSS px) that counts as a real selection.
  const MIN_SIZE = 8;

  // The live DOM state of the selection layer.
  let overlay = null;
  let box = null;
  let sizeLabel = null;
  let hint = null;

  // Drag bookkeeping.
  let selecting = false;
  let startX = 0;
  let startY = 0;
  let curX = 0;
  let curY = 0;

  // The active viewport size (snapshot at open time so the crop in the
  // sidebar matches the layer coordinates exactly).
  let viewportW = 0;
  let viewportH = 0;

  // The pending promise resolver (null once solved/cancelled).
  let resolver = null;

  // True while the selection socket is open.
  let open = false;

  // ----------------------- Helpers -----------------------

  // Build an absolutely-positioned element with the given styles.
  function makeEl(tag, styles, text) {
    const el = document.createElement(tag);
    Object.assign(el.style, styles);
    if (text != null) el.textContent = text;
    return el;
  }

  // The rectangle currently being dragged, clamped to the viewport. The full
  // visible frame stays selectable everywhere, so the user can still pick a
  // region that overlaps the ClipNote column if they want it in the screenshot.
  function currentRect() {
    const x1 = Math.max(0, Math.min(startX, curX));
    const y1 = Math.max(0, Math.min(startY, curY));
    const x2 = Math.min(viewportW, Math.max(startX, curX));
    const y2 = Math.min(viewportH, Math.max(startY, curY));
    return {
      x: x1,
      y: y1,
      width: x2 - x1,
      height: y2 - y1,
      viewport: { width: viewportW, height: viewportH }
    };
  }

  // The ENTIRE visible frame: the default selection. A plain click (no drag)
  // confirms this - the whole page exactly as it was on screen, ClipNote and
  // all - so the saved screenshot is never narrowed unless the user drags.
  function fullRect() {
    return {
      x: 0,
      y: 0,
      width: viewportW,
      height: viewportH,
      viewport: { width: viewportW, height: viewportH }
    };
  }

  // Move the highlight box and its size readout to the current rectangle.
  function paintSelection(rect) {
    box.style.left = `${rect.x}px`;
    box.style.top = `${rect.y}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    box.classList.toggle('cn-shot-valid', rect.width >= MIN_SIZE && rect.height >= MIN_SIZE);

    // The readout hugs the bottom-right of the box.
    const labelW = 60;
    const labelH = 20;
    const lx = Math.min(rect.x + rect.width - labelW, viewportW - labelW);
    const ly = Math.min(rect.y + rect.height + 4, viewportH - labelH);
    sizeLabel.style.left = `${Math.max(0, lx)}px`;
    sizeLabel.style.top = `${Math.max(0, ly)}px`;
    sizeLabel.textContent = `${Math.round(rect.width)} \u00D7 ${Math.round(rect.height)}`;
  }

  // ----------------------- Open / close -----------------------

  // Remove the selection layer and every listener.
  function teardown() {
    if (!overlay) return;
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('blur', onWindowBlur);
    overlay.remove();
    overlay = null;
    box = null;
    sizeLabel = null;
    hint = null;
  }

  // Cancel the in-flight selection (resolves the pending promise with null).
  function cancel() {
    if (!open) return;
    open = false;
    teardown();
    const done = resolver;
    resolver = null;
    if (done) done(null);
  }

  // Close a completed selection with the chosen rectangle.
  function finish(rect) {
    if (!open) return;
    open = false;
    teardown();
    const done = resolver;
    resolver = null;
    if (done) done(rect);
  }

  // ----------------------- Events -----------------------

  function onPointerDown(e) {
    if (e.button !== 0 || selecting) return;
    // Any press starts a drag anywhere on the frozen frame - the whole visible
    // page is selectable, ClipNote column included.
    selecting = true;
    startX = curX = e.clientX;
    startY = curY = e.clientY;
    try { overlay.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    paintSelection(currentRect());
  }

  function onPointerMove(e) {
    if (!selecting) return;
    curX = e.clientX;
    curY = e.clientY;
    paintSelection(currentRect());
  }

  function onPointerUp() {
    if (!selecting) return;
    selecting = false;
    const rect = currentRect();
    // A click without a real drag confirms the WHOLE frame: the screenshot is
    // the entire visible tab exactly as it appeared on screen, ClipNote and
    // all. Only a genuine drag narrows the saved image to that region.
    if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) {
      finish(fullRect());
    } else {
      finish(rect);
    }
  }

  // Block keys that would otherwise drive the host video/scroll while the
  // selection layer is up (space/arrows/k/j/f/m/enter, etc).
  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
      return;
    }
    const blocked = [' ', 'k', 'j', 'l', 'f', 'm', ',', '.', 'Enter', 'ArrowUp',
      'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (blocked.includes(e.key)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function onWindowBlur() {
    // Leaving the tab/window while selecting is the same as cancelling.
    cancel();
  }

  // Block live scrolling while the frozen layer is up. The page itself must
  // not move underneath an already-captured frame, and any scroll gesture must
  // belong to the selection layer (which ignores it).
  function onWheelBlock(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  // Same for touch scrolling / pinch on touch devices.
  function onTouchBlock(e) {
    e.preventDefault();
  }

  // ----------------------- Public API -----------------------

  // Open the selection layer over an IMMUTABLE captured frame. Resolves with
  // the chosen rectangle (plus the viewport snapshot), or null when the user
  // cancelled. If a selection is already open it is cancelled first.
  //   options.backgroundImage - data URL of the tab captured by the sidebar.
  //     When present it is rendered as a full-viewport, opaque background so
  //     the live page is visually frozen for the whole selection. When absent
  //     the layer stays transparent (legacy behaviour). The frame is the WHOLE
  //     visible tab - ClipNote sidebar included - so the default (a plain
  //     click) saves exactly what the user saw.
  function start(options) {
    if (open) cancel();
    open = true;

    // Snapshot the viewport at open time (matches the captured tab image).
    viewportW = window.innerWidth;
    viewportH = window.innerHeight;

    overlay = makeEl('div', {
      position: 'fixed',
      inset: '0',
      width: '100%',
      height: '100%',
      zIndex: '2147483647',
      background: 'transparent',
      cursor: 'crosshair',
      touchAction: 'none',
      userSelect: 'none'
    });

    // The frozen frame: the captured screenshot stretched over the exact
    // viewport. Opaque, fixed, and pointer-transparent - it only covers the
    // live page, it never intercepts the drag itself.
    const backgroundImage = (options && options.backgroundImage) || null;
    if (backgroundImage) {
      // Full-viewport frozen frame - a straight copy of the visible tab,
      // never narrowed to a content target, never re-composed.
      const bg = makeEl('div', {
        position: 'absolute',
        inset: '0',
        width: '100%',
        height: '100%',
        backgroundImage: `url("${backgroundImage}")`,
        backgroundSize: '100% 100%',
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'center',
        pointerEvents: 'none',
        zIndex: '0'
      });
      bg.setAttribute('data-cn-shotbg', '');
      overlay.appendChild(bg);
    }

    hint = makeEl('div', {
      position: 'fixed',
      top: '14px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: '2',
      background: 'rgba(0,0,0,0.78)',
      color: '#fff',
      fontSize: '12px',
      padding: '6px 12px',
      borderRadius: '6px',
      pointerEvents: 'none',
      whiteSpace: 'nowrap'
    }, 'Click to save the whole page \u00B7 or drag to select an area \u00B7 Esc to cancel');

    // The empty highlight rectangle. The gigantic box-shadow cannot be set
    // inline, so it lives in a tiny stylesheet scoped to a marker attribute.
    box = makeEl('div', {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '0',
      height: '0',
      zIndex: '3',
      border: '2px solid #e07a5f',
      background: 'rgba(224, 122, 95, 0.08)',
      pointerEvents: 'none'
    });
    box.setAttribute('data-cn-shotbox', '');

    sizeLabel = makeEl('div', {
      position: 'absolute',
      zIndex: '4',
      background: 'rgba(0,0,0,0.78)',
      color: '#fff',
      fontSize: '11px',
      fontWeight: '700',
      lineHeight: '1',
      padding: '4px 6px',
      borderRadius: '4px',
      pointerEvents: 'none'
    });

    overlay.appendChild(hint);
    overlay.appendChild(box);
    overlay.appendChild(sizeLabel);
    (document.documentElement || document.body).appendChild(overlay);

    // The whole visible frame is selected by default: a plain click keeps it,
    // a drag narrows it. The highlight starts over the full page so the user
    // can see exactly what a click will save - ClipNote and all.
    paintSelection(fullRect());

    // The pairing CSS rule for the dim-outside effect.
    const style = document.createElement('style');
    style.textContent = '[data-cn-shotbox]{box-shadow:0 0 0 9999px rgba(0,0,0,0.55);}' +
      '[data-cn-shotbox].cn-shot-valid{border-color:#f4a261;}' +
      '[data-cn-shotbox].cn-shot-valid:after{content:"\u2713";position:absolute;top:-2px;right:-2px;' +
      'background:#f4a261;color:#1a1210;font-size:10px;font-weight:800;width:16px;height:16px;' +
      'line-height:16px;text-align:center;border-radius:50%;}';
    overlay.appendChild(style);

    // Pointer flow on the layer itself (it is on top, so the host page and
    // the video below never see any of this).
    overlay.addEventListener('pointerdown', onPointerDown);
    overlay.addEventListener('pointermove', onPointerMove);
    overlay.addEventListener('pointerup', onPointerUp);
    overlay.addEventListener('pointercancel', onPointerUp);

    // The live page must not scroll while the frozen frame is on screen.
    overlay.addEventListener('wheel', onWheelBlock, { passive: false });
    overlay.addEventListener('touchmove', onTouchBlock, { passive: false });

    // Keyboard shortcuts are captured at the window level so even document
    // listeners on the host page cannot start the video underneath.
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onWindowBlur);

    return new Promise((resolve) => { resolver = resolve; });
  }

  // Abort any open selection (used by contentScript.js on unmount/teardown).
  function cancelActive() {
    cancel();
  }

  NS.ScreenshotSelector = { start, cancel: cancelActive };
  NS.__screenshotSelectorLoaded = true;
})();