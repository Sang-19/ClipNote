// ClipNote Universal layout adapter.
// Keeps the host page in normal document flow and reserves a right-hand column.
(() => {
  'use strict';
  const NS = (window.__CN = window.__CN || {});
  if (NS.__universalLayoutLoaded) return;
  NS.__universalLayoutLoaded = true;

  class UniversalLayout {
    constructor() {
      this.platform = 'universal';
      this.hasVideo = false;
      this.sidebarMounted = false;
      this.shell = null;
      this.content = null;
      this.container = null;
      this.originalBodyStyle = null;
      this.originalHtmlStyle = null;
    }
    isSupportedPage() { return /^https?:$/.test(location.protocol); }
    isWatchPage() { return this.isSupportedPage(); }
    getVideoContext() {
      return { ok: true, platform: 'universal', videoUrl: location.href, title: document.title, videoId: '' };
    }
    getContentElement() { return this.content || document.querySelector('main') || document.body; }
    getScreenshotTarget() {
      const node = this.content;
      if (!node) return null;
      const r = node.getBoundingClientRect();
      const x = Math.max(0, r.left);
      const y = Math.max(0, r.top);
      const right = Math.min(window.innerWidth, r.right);
      const bottom = Math.min(window.innerHeight, r.bottom);
      if (right <= x || bottom <= y) return null;
      return { x, y, width: right - x, height: bottom - y };
    }
    mountSidebar(container) {
      if (!document.body || !container) return false;
      if (this.sidebarMounted) return true;
      this.container = container;
      this.originalBodyStyle = document.body.getAttribute('style');
      this.originalHtmlStyle = document.documentElement.getAttribute('style');

      const shell = document.createElement('div');
      shell.id = 'cn-universal-shell';
      Object.assign(shell.style, {
        display: 'flex', alignItems: 'stretch', width: '100%', minHeight: '100vh',
        position: 'relative', isolation: 'isolate'
      });
      const content = document.createElement('div');
      content.id = 'cn-universal-content';
      Object.assign(content.style, {
        flex: '1 1 auto', minWidth: '0', minHeight: '100vh',
        overflow: 'auto', position: 'relative'
      });
      const parent = document.body;
      const originalChildren = Array.from(parent.childNodes).filter(n => n !== container);
      parent.insertBefore(shell, parent.firstChild);
      shell.appendChild(content);
      originalChildren.forEach(n => content.appendChild(n));
      shell.appendChild(container);
      Object.assign(parent.style, { margin: '0', padding: '0', width: '100%', minHeight: '100vh' });
      Object.assign(container.style, {
        display: 'block', position: 'relative', inset: 'auto', flex: '0 0 360px',
        width: '360px', height: '100vh', minHeight: '100vh', zIndex: '2147483000',
        border: '0', borderLeft: '1px solid rgba(0,0,0,.18)', background: '#1a1210'
      });
      const frame = container.querySelector('iframe');
      if (frame) Object.assign(frame.style, { display: 'block', width: '100%', height: '100%', border: '0' });
      this.shell = shell;
      this.content = content;
      this.sidebarMounted = true;
      return true;
    }
    unmountSidebar(container) {
      const shell = this.shell;
      const content = this.content;
      if (shell && shell.isConnected && content) {
        while (content.firstChild) shell.parentNode.insertBefore(content.firstChild, shell);
        shell.remove();
      } else if (container && container.isConnected) {
        container.remove();
      }
      if (document.body && this.originalBodyStyle === null) document.body.removeAttribute('style');
      else if (document.body && this.originalBodyStyle !== null) document.body.setAttribute('style', this.originalBodyStyle);
      if (document.documentElement && this.originalHtmlStyle === null) document.documentElement.removeAttribute('style');
      else if (document.documentElement && this.originalHtmlStyle !== null) document.documentElement.setAttribute('style', this.originalHtmlStyle);
      this.shell = null; this.content = null; this.container = null; this.sidebarMounted = false;
    }
    applyLayout(container) {
      if (!this.sidebarMounted || !this.shell || !this.shell.isConnected) return this.mountSidebar(container);
      if (container && container.parentNode !== this.shell) this.shell.appendChild(container);
      return true;
    }
    restoreLayout() { this.unmountSidebar(this.container); }
    destroy() { this.unmountSidebar(this.container); }
  }

  const adapter = new UniversalLayout();
  if (NS.adapters && !NS.adapters.some(a => a.platform === 'universal')) NS.adapters.push(adapter);
})();
