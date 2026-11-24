// Universal sidebar: place ClipNote in a right-hand in-flow column.
(() => {
  'use strict';
  const NS = (window.__CN = window.__CN || {});
  const U = (NS.universal = NS.universal || {});
  if (U.layout) return;
  let wrapper = null, shell = null, original = null;
  const STYLE_ID = 'cn-universal-layout-style';
  function apply(container) {
    if (!document.body || !container) return false;
    if (!shell || !shell.isConnected) {
      original = { body: document.body, display: document.body.style.display, width: document.body.style.width };
      shell = document.createElement('div');
      shell.id = 'cn-universal-layout-root';
      shell.style.cssText = 'display:flex;align-items:stretch;width:100%;min-height:100vh;box-sizing:border-box;';
      wrapper = document.createElement('div');
      wrapper.id = 'cn-universal-page-content';
      wrapper.style.cssText = 'flex:1 1 auto;min-width:0;box-sizing:border-box;';
      while (document.body.firstChild) wrapper.appendChild(document.body.firstChild);
      shell.appendChild(wrapper);
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = '#cn-universal-layout-root{display:flex!important;width:100%;min-height:100vh}#cn-universal-page-content{flex:1 1 auto;min-width:0}#cn-sidebar-container{display:block!important;position:sticky!important;top:0!important;right:auto!important;flex:0 0 360px!important;width:360px!important;max-width:42vw!important;min-width:300px!important;height:100vh!important;z-index:2147483000!important;box-sizing:border-box!important;background:#1a1210!important;border-left:1px solid rgba(0,0,0,.15)!important}#cn-sidebar-container iframe{width:100%;height:100%;border:0;display:block}';
      document.documentElement.appendChild(style);
      document.body.appendChild(shell);
    }
    if (container.parentElement !== shell) shell.appendChild(container);
    return true;
  }
  function restore() {
    if (!shell || !original) return;
    const sidebar = shell.querySelector('#cn-sidebar-container');
    if (sidebar) sidebar.remove();
    while (wrapper.firstChild) original.body.appendChild(wrapper.firstChild);
    shell.remove();
    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
    original.body.style.display = original.display;
    original.body.style.width = original.width;
    shell = wrapper = original = null;
  }
  U.layout = { apply, restore, destroy: restore };
})();
