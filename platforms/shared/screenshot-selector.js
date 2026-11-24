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
// The selection starts EMPTY: nothing is pre-selected when the layer opens. A
// plain click (no drag) cancels the screenshot and restores the page; only an
// intentional drag that passes a small threshold creates the selection
// rectangle. The area outside the rectangle is dimmed, the rectangle itself is
// highlighted with a live size readout. The layer is torn down when the drag
// ends, on Escape, or when the window loses focus.
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

  // How far the pointer must move (per axis, CSS px) before a press becomes a
  // drag. Movement below this is a plain click, which cancels instead of ever
  // creating a selection rectangle.
  const DRAG_THRESHOLD = 6;

  // The live DOM state of the selection layer.
  let overlay = null;
  let box = null;
  let sizeLabel = null;
  let hint = null;

  // Drag bookkeeping.
  let selecting = false;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let curX = 0;
  let curY = 0;

  // The active viewport size (snapshot at open time so the crop in the
  // sidebar matches the layer coordinates exactly).
  let viewportW = 0;
  let viewportH = 0;
  let selectionBounds = { x: 0, y: 0, width: 0, height: 0 };

  // The pending promise resolver (null once solved/cancelled).
  let resolver = null;

  // True while the selection socket is open.
  let open = false;

  // The host document's overflow values before the frozen layer locked them.
  // Restored unconditionally on teardown so the page ends exactly as it
  // started - the lock is strictly scoped to the open selection layer.
  let savedOverflow = null;

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
    const x1 = Math.max(selectionBounds.x, Math.min(startX, curX));
    const y1 = Math.max(selectionBounds.y, Math.min(startY, curY));
    const x2 = Math.min(selectionBounds.x + selectionBounds.width, Math.max(startX, curX));
    const y2 = Math.min(selectionBounds.y + selectionBounds.height, Math.max(startY, curY));
    return {
      x: x1, y: y1, width: x2 - x1, height: y2 - y1,
      viewport: { width: viewportW, height: viewportH }
    };
  }

  // Move the highlight box and its size readout to the current rectangle.
  function paintSelection(rect) {
    box.style.display = 'block';
    sizeLabel.style.display = 'block';
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
    // Unlock the document unconditionally, before the overlay guard - the
    // restore must happen even if the layer was already removed, so the lock
    // can never leak past the selection.
    if (savedOverflow) {
      const scroller = document.documentElement || document.body;
      scroller.style.overflow = savedOverflow.overflow;
      scroller.style.overflowX = savedOverflow.overflowX;
      scroller.style.overflowY = savedOverflow.overflowY;
      savedOverflow = null;
    }
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
    // Any press arms a potential drag anywhere on the frozen frame - the whole
    // visible page is selectable, ClipNote column included. Nothing is painted
    // yet: a selection rectangle only appears once the pointer actually drags
    // far enough to cross the threshold.
    if (e.clientX < selectionBounds.x || e.clientX > selectionBounds.x + selectionBounds.width ||
        e.clientY < selectionBounds.y || e.clientY > selectionBounds.y + selectionBounds.height) return;
    selecting = true;
    dragging = false;
    startX = curX = e.clientX;
    startY = curY = e.clientY;
    try { overlay.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  }

  function onPointerMove(e) {
    if (!selecting) return;
    curX = e.clientX;
    curY = e.clientY;
    // Only an actual drag creates a selection: tiny pointer jitter stays below
    // the threshold and is never painted as a rectangle.
    if (!dragging &&
        (Math.abs(curX - startX) >= DRAG_THRESHOLD ||
         Math.abs(curY - startY) >= DRAG_THRESHOLD)) {
      dragging = true;
    }
    if (dragging) paintSelection(currentRect());
  }

  function onPointerUp() {
    if (!selecting) return;
    selecting = false;
    // A plain click (the pointer never dragged past the threshold) is NOT a
    // selection: cancel and restore the page without saving anything.
    if (!dragging) { cancel(); return; }
    dragging = false;
    const rect = currentRect();
    // A real drag, but a rectangle still too small to count, is a stray drag:
    // cancel rather than save a meaningless sliver.
    if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) {
      cancel();
      return;
    }
    finish(rect);
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
  // the chosen drag rectangle (plus the viewport snapshot), or null when the
  // user cancelled (Escape, window blur, or a plain click that never became a
  // drag). If a selection is already open it is cancelled first.
  //   options.backgroundImage - data URL of the tab captured by the sidebar.
  //   options.target - optional CSS-pixel rectangle restricting selection
  //     to webpage content (for example, the page column beside ClipNote).
  //     When present it is rendered as a full-viewport, opaque background so
  //     the live page is visually frozen for the whole selection. When absent
  //     the layer stays transparent (legacy behaviour). The frame is the whole
  //     visible tab - ClipNote sidebar included - and the full viewport is the
  //     captured SOURCE image only, never an active selection: the user must
  //     drag to choose the region to save.
  function start(options) {
    if (open) cancel();
    open = true;

    // The document's own classic scrollbar is browser chrome - no overlay can
    // ever cover it - so the only DOM-side way to keep it from appearing
    // beside the frozen frame is to lock the document's overflow for the
    // lifetime of the selection layer. The previous values are backed up and
    // restored in teardown(), making this a strictly scoped, self-reversing
    // lock: it never outlives the layer and never touches the page otherwise.
    const scroller = document.documentElement || document.body;
    savedOverflow = {
      overflow: scroller.style.overflow,
      overflowX: scroller.style.overflowX,
      overflowY: scroller.style.overflowY
    };
    scroller.style.overflow = 'hidden';

    // Snapshot the viewport at open time (matches the captured tab image).
    viewportW = window.innerWidth;
    viewportH = window.innerHeight;
    const requested = options && options.target;
    selectionBounds = requested && Number.isFinite(requested.x) &&
      Number.isFinite(requested.y) && Number.isFinite(requested.width) &&
      Number.isFinite(requested.height) && requested.width > 1 && requested.height > 1
      ? {
          x: Math.max(0, requested.x), y: Math.max(0, requested.y),
          width: Math.max(0, Math.min(viewportW, requested.x + requested.width) - Math.max(0, requested.x)),
          height: Math.max(0, Math.min(viewportH, requested.y + requested.height) - Math.max(0, requested.y))
        }
      : { x: 0, y: 0, width: viewportW, height: viewportH };

    overlay = makeEl('div', {
      position: 'fixed',
      left: `${selectionBounds.x}px`,
      top: `${selectionBounds.y}px`,
      width: `${selectionBounds.width}px`,
      height: `${selectionBounds.height}px`,
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
        left: `${selectionBounds.x}px`,
        top: `${selectionBounds.y}px`,
        width: `${selectionBounds.width}px`,
        height: `${selectionBounds.height}px`,
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
      left: `${selectionBounds.x + selectionBounds.width / 2}px`,
      transform: 'translateX(-50%)',
      zIndex: '2',
      background: 'rgba(0,0,0,0.78)',
      color: '#fff',
      fontSize: '12px',
      padding: '6px 12px',
      borderRadius: '6px',
      pointerEvents: 'none',
      whiteSpace: 'nowrap'
    }, 'Drag to select an area \u00B7 click or Esc to cancel');

    // The empty highlight rectangle. The gigantic box-shadow cannot be set
    // inline, so it lives in a tiny stylesheet scoped to a marker attribute.
    box = makeEl('div', {
      position: 'absolute',
      display: 'none',
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
      display: 'none',
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

    // No selection exists yet: the box and the size readout both start hidden and
    // only appear once the user actually drags across the threshold. The frozen
    // captured frame stays visible, full-viewport, exactly as it was on screen.

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