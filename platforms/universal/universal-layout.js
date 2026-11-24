// ClipNote Universal layout adapter.
// Uses a fixed-width, right-docked sidebar and reserves space without moving
// or re-parenting arbitrary host-page nodes. A CSS body margin creates the
// page reflow while preserving the site's DOM structure and scroll containers.
(() => {
  'use strict';
  const NS = (window.__CN = window.__CN || {});
  if (NS.__universalLayoutLoaded) return;
  NS.__universalLayoutLoaded = true;

  const STYLE_ID = 'cn-universal-layout-style';
  const SIDEBAR_WIDTH = 360;

  class UniversalLayout {
    constructor() {
      this.platform = 'universal';
      this.hasVideo = false;
      this.sidebarMounted = false;
      this.container = null;
      this.onNavigate = null;
      this.original = null;
      this.navObserver = null;
      this.lastUrl = location.href;
      this.captureFrozen = false;
    }
    isSupportedPage() {
      const host = location.hostname.toLowerCase();
      if (!/^https?:$/.test(location.protocol)) return false;
      if (host === 'youtube.com' || host.endsWith('.youtube.com')) return false;
      if (host === 'udemy.com' || host.endsWith('.udemy.com')) return false;
      if (host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'chat.openai.com') return false;
      return true;
    }
    isWatchPage() { return this.isSupportedPage(); }
    getVideoContext() {
      return { ok: true, platform: 'universal', videoUrl: location.href, title: document.title, videoId: '' };
    }
    getContentElement() {
      return document.querySelector('main,[role="main"],article') || document.body;
    }
    getScreenshotTarget() {
      const el = this.getContentElement();
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const left = Math.max(0, r.left);
      const top = Math.max(0, r.top);
      const right = Math.min(window.innerWidth - SIDEBAR_WIDTH, r.right);
      const bottom = Math.min(window.innerHeight, r.bottom);
      if (right <= left || bottom <= top) return null;
      return { x: left, y: top, width: right - left, height: bottom - top };
    }
    mountSidebar(container) {
      if (!document.documentElement || !document.body || !container) return false;
      if (!this.isSupportedPage()) return false;
      if (this.sidebarMounted && this.container === container && container.isConnected) return true;
      this.container = container;
      if (!this.original) {
        this.original = {
          bodyMarginRight: document.body.style.marginRight,
          bodyTransition: document.body.style.transition,
          htmlOverflowX: document.documentElement.style.overflowX
        };
      }
      let style = document.getElementById(STYLE_ID);
      if (!style) {
        style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
          html.cn-universal-active { overflow-x: clip !important; }
          body.cn-universal-active {
            box-sizing: border-box !important;
            margin-right: ${SIDEBAR_WIDTH}px !important;
            transition: margin-right 120ms ease-out;
          }
          #cn-sidebar-container.cn-universal-docked {
            display: block !important;
            position: fixed !important;
            top: 0 !important;
            right: 0 !important;
            bottom: 0 !important;
            left: auto !important;
            width: ${SIDEBAR_WIDTH}px !important;
            height: 100vh !important;
            min-height: 100vh !important;
            max-height: 100vh !important;
            flex: none !important;
            z-index: 2147483000 !important;
            border: 0 !important;
            border-left: 1px solid rgba(0,0,0,.18) !important;
            background: #1a1210 !important;
            box-sizing: border-box !important;
          }
          #cn-sidebar-container.cn-universal-docked iframe {
            display: block !important;
            width: 100% !important;
            height: 100% !important;
            border: 0 !important;
          }
        `;
        (document.head || document.documentElement).appendChild(style);
      }
      document.documentElement.classList.add('cn-universal-active');
      document.body.classList.add('cn-universal-active');
      container.classList.add('cn-universal-docked');
      this.sidebarMounted = true;
      return true;
    }
    unmountSidebar(container) {
      const el = container || this.container;
      if (el) el.classList.remove('cn-universal-docked');
      document.documentElement?.classList.remove('cn-universal-active');
      document.body?.classList.remove('cn-universal-active');
      const style = document.getElementById(STYLE_ID);
      if (style) style.remove();
      if (this.original && document.body) {
        document.body.style.marginRight = this.original.bodyMarginRight;
        document.body.style.transition = this.original.bodyTransition;
      }
      if (this.original && document.documentElement) {
        document.documentElement.style.overflowX = this.original.htmlOverflowX;
      }
      this.container = null;
      this.original = null;
      this.sidebarMounted = false;
    }
    applyLayout(container) {
      if (!this.isSupportedPage()) return false;
      if (!this.sidebarMounted || !container?.isConnected) return this.mountSidebar(container);
      if (container && container !== this.container) {
        this.container?.classList.remove('cn-universal-docked');
        this.container = container;
        container.classList.add('cn-universal-docked');
      }
      return true;
    }
    setCapture(active) { this.captureFrozen = !!active; }
    setupNavigation(callback) {
      this.onNavigate = callback;
      if (this.navObserver) this.navObserver.disconnect();
      this.navObserver = new MutationObserver(() => {
        if (this.captureFrozen) return;
        if (location.href !== this.lastUrl) {
          this.lastUrl = location.href;
          this.onNavigate?.();
        }
      });
      this.navObserver.observe(document.documentElement, { childList: true, subtree: true });
      const onPop = () => {
        if (this.captureFrozen) return;
        if (location.href !== this.lastUrl) {
          this.lastUrl = location.href;
          this.onNavigate?.();
        }
      };
      window.addEventListener('popstate', onPop);
      this._onPop = onPop;
    }
    handleNavigation() {}
    destroy() {
      this.navObserver?.disconnect();
      this.navObserver = null;
      if (this._onPop) window.removeEventListener('popstate', this._onPop);
      this._onPop = null;
      this.unmountSidebar(this.container);
    }
    restoreLayout() { this.unmountSidebar(this.container); }
  }

  const adapter = new UniversalLayout();
  if (NS.adapters && !NS.adapters.some(a => a.platform === 'universal')) NS.adapters.push(adapter);
})();