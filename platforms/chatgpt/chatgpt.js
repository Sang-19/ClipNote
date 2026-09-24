// ClipNote - ChatGPT platform adapter.
//
// Implements the PlatformAdapter interface with ChatGPT-specific behaviour:
//   * URL detection for conversation pages (/c/<conversation-id>)
//   * Conversation identity (id + title) for the shared video-context contract
//   * hasVideo = false: ChatGPT is not a video platform. The shared pipeline
//     therefore never seeks, never shows a timestamp, never fakes a video
//     position, and captures are wall-clock/visible-window events.
//   * Layout = a fixed-width right-hand column beside the chat
//     (see chatgpt-layout.js); nothing inside the conversation page is edited.
//   * SPA navigation via a focused thread-swap observer
//     (see chatgpt-navigation.js); URL changes are handled by contentScript.

(() => {
  'use strict';

  if (!window.__CN) return;
  const NS = window.__CN;
  const C = NS.chatgpt;
  if (!C || !NS.PlatformAdapter || C.__adapterLoaded) return;

  if (NS.getAdapter('chatgpt')) return;

  class ChatGPTAdapter extends NS.PlatformAdapter {
    constructor() {
      super('chatgpt');
      // No <video> anywhere on a ChatGPT conversation page.
      this.hasVideo = false;
    }

    isSupportedPage() {
      const host = location.hostname.toLowerCase();
      return host === 'chatgpt.com' || host === 'www.chatgpt.com' || host === 'chat.openai.com';
    }

    isWatchPage() {
      // A "watch page" here is a concrete conversation: /c/<conversation-id>.
      // The chat list, landing page and /g/ (custom GPT) pages stay untouched.
      return /^\/c\//.test(location.pathname);
    }

    findPreferredVideo() {
      // No video element exists to prefer; the shared findVideo() pipeline is
      // skipped entirely for this platform (hasVideo === false).
      return null;
    }

    getVideoContext() {
      const conversationId = C.chat.conversationId() || '';
      const conversationTitle = C.chat.conversationTitle() || '';
      return {
        ok: true,
        platform: 'chatgpt',
        videoUrl: location.href,
        title: document.title,
        // The project's single "videoId" field carries the conversation id so
        // the shared note/folder pipeline works unchanged; the explicit
        // conversationId fields below make the intent readable at the call site.
        videoId: conversationId,
        videoTitle: conversationTitle,
        conversationId,
        conversationTitle
      };
    }

    getScreenshotFallback() {
      // No video poster exists; every ChatGPT capture is a real visible-window
      // image supplied by the sidebar, never a remote fallback.
      return null;
    }

    mountSidebar(container) {
      // Put the sidebar into the chat flex row as a right-hand column. When
      // the row has no usable space applyLayout() returns false and
      // contentScript.js keeps a bounded promotion retry running.
      const inFlow = C.layout.applyLayout(container);
      this.sidebarMounted = inFlow;
      return inFlow;
    }

    unmountSidebar() {
      C.layout.restoreLayout();
      this.sidebarMounted = false;
    }

    applyLayout(container) {
      const inFlow = C.layout.applyLayout(container);
      C.layout.refresh();
      return inFlow;
    }

    // Freeze ChatGPT's responsive layout while a page capture hides the
    // sidebar. The hide itself is a visibility:hidden class (the container
    // keeps its column, so nothing reflows); this only stops the show/hide
    // logic from toggling the container mid-capture.
    setCapture(on) {
      C.layout.setCapture(!!on);
    }

    // The on-page rectangle of the conversation/content area the user is
    // interested in (CSS viewport pixels, intersected with the visible
    // viewport). The sidebar crops every ChatGPT page screenshot down to this
    // region so the image contains ONLY the conversation - never the browser
    // chrome, the left navigation rail, the composer chrome outside the area,
    // unrelated controls, or ClipNote (which mounts in a DIFFERENT element and
    // is hidden from the frame by the capture-state mechanism).
    // Anchors on the stable DOM contract (OpenAI's own
    // data-conversation-screenshot-content marker -> #thread -> #main) instead
    // of generated class names that change between deploys. getBoundingClientRect() already reflects the target's current
    // scroll offset, and because visibility:hidden keeps the sidebar's layout
    // slot, the rectangle is identical before/during/after the capture hide.
    // The on-page element ChatGPT marks as the conversation capture surface
    // (stable data-* / id chain, never generated class names). Shared by the
    // screenshot target computation and the page-scroll snapshot, so both walk
    // the exact same DOM Truth.
    getContentElement() {
      const c = C.selectors;
      return (c.conversationContent && document.querySelector(c.conversationContent))
        || (c.thread && document.querySelector(c.thread))
        || (c.main && document.querySelector(c.main))
        || null;
    }

    getScreenshotTarget() {
      const el = this.getContentElement();
      if (!el || !el.isConnected) return null;
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const x1 = Math.max(0, r.left);
      const y1 = Math.max(0, r.top);
      const x2 = Math.min(vw, r.right);
      const y2 = Math.min(vh, r.bottom);
      if (x2 - x1 <= 1 || y2 - y1 <= 1) return null;
      return { x: x1, y: y1, width: x2 - x1, height: y2 - y1, viewport: { width: vw, height: vh } };
    }

    restoreLayout() {
      C.layout.restoreLayout();
    }

    setupNavigation(handleNavigation) {
      C.navigation.setup(handleNavigation);
    }

    handleNavigation() {
      // A fresh thread may have been swapped in under the same URL; the next
      // applyLayout() (issued by contentScript.js) moves the sidebar into it.
      C.layout.refresh();
    }

    destroy() {
      C.layout.destroy();
      C.navigation.teardown();
    }
  }

  NS.adapters.push(new ChatGPTAdapter());
  C.__adapterLoaded = true;
})();