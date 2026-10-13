(function() {
  'use strict';
  console.clear();
  console.log('%c=== ClipNote ChatGPT Diagnostic ===', 'color: #4CAF50; font-size: 16px; font-weight: bold;');
  console.log('Timestamp:', new Date().toISOString());
  console.log('URL:', location.href);
  console.log('Hostname:', location.hostname);
  console.log('Pathname:', location.pathname);
  console.log('');
  var results = {
    platform: 'chatgpt',
    urlValid: false,
    selectors: {},
    elements: {},
    cnLoaded: false,
    adapterLoaded: false,
    errors: []
  };
  var isChatGPT = ['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com'].indexOf(location.hostname) !== -1;
  var isConversation = /^\/c\//.test(location.pathname);
  results.urlValid = isChatGPT && isConversation;
  console.log('%c1. URL Detection', 'color: #2196F3; font-weight: bold;');
  console.log('  Is ChatGPT domain:', isChatGPT);
  console.log('  Is conversation page (/c/*):', isConversation);
  console.log('  Valid:', results.urlValid ? 'YES' : 'NO');
  if (!results.urlValid) {
    console.warn('  !! Not on a ChatGPT conversation page');
  }
  console.log('');
  console.log('%c2. ClipNote Namespace', 'color: #2196F3; font-weight: bold;');
  results.cnLoaded = !!window.__CN;
  console.log('  window.__CN exists:', results.cnLoaded ? 'YES' : 'NO');
  if (results.cnLoaded) {
    var CN = window.__CN;
    results.adapterLoaded = !!(CN.adapters && CN.adapters.length > 0);
    console.log('  Adapters registered:', CN.adapters ? CN.adapters.length : 0);
    console.log('  ChatGPT namespace:', !!CN.chatgpt ? 'YES' : 'NO');
  }
  console.log('');
  // The selectors the shipped adapter falls back through, in preference order.
  // The first match wins; all entries are stable ids / data-* attributes, never
  // generated Tailwind/CSS-module class names.
  var chains = {
    main: ['#main', 'main', '[role="main"]'],
    thread: ['#thread', '[data-scroll-root]', '[data-testid="thread"]'],
    conversationContent: [
      '[data-conversation-screenshot-content]',
      '[data-testid="conversation-screenshot-content"]'
    ],
    conversationTurn: [
      'article[data-testid^="conversation-turn-"]',
      'section[data-testid^="conversation-turn-"]',
      'div[data-testid^="conversation-turn-"]',
      '[data-testid^="conversation-turn-"]',
      '[data-turn]'
    ]
  };
  console.log('%c3. DOM Selectors (ordered fallback chains)', 'color: #2196F3; font-weight: bold;');
  for (var key in chains) {
    if (!chains.hasOwnProperty(key)) continue;
    var chain = chains[key];
    var winner = null;
    for (var i = 0; i < chain.length; i++) {
      var el = document.querySelector(chain[i]);
      if (el) { winner = { sel: chain[i], el: el }; break; }
    }
    console.log('  ' + key + ': ' + (winner ? 'FOUND' : 'NOT FOUND') +
      (winner ? '  <- ' + winner.sel : '') +
      (winner ? ' (' + winner.el.tagName.toLowerCase() + ')' : ''));
  }
  console.log('');
  // The turn-derived conversation surface: the lowest common ancestor of every
  // rendered turn. This is the primary capture target when OpenAI's dedicated
  // screenshot marker is missing.
  console.log('%c4. Conversation Surface (turn common ancestor)', 'color: #2196F3; font-weight: bold;');
  var logged = [];
  for (var i2 = 0; i2 < chains.conversationTurn.length; i2++) {
    document.querySelectorAll(chains.conversationTurn[i2]).forEach(function(el) {
      if (logged.indexOf(el) === -1) logged.push(el);
    });
  }
  console.log('  Turns rendered:', logged.length);
  var surface = null;
  if (logged.length) {
    surface = logged[0].parentElement;
    for (var j = 1; j < logged.length && surface; j++) {
      while (surface && !surface.contains(logged[j])) surface = surface.parentElement;
    }
    while (surface && logged.indexOf(surface) !== -1) surface = surface.parentElement;
    if (surface === document.body || surface === document.documentElement) surface = null;
  }
  if (surface) {
    var r = surface.getBoundingClientRect();
    console.log('  Surface:', surface.tagName.toLowerCase() +
      (surface.id ? '#' + surface.id : ''));
    console.log('  Rect: ' + Math.round(r.width) + ' x ' + Math.round(r.height));
  } else {
    console.log('  Surface: NONE (no conversation turns rendered)');
  }
  console.log('');
  var sidebar = document.querySelector('#cn-sidebar-container');
  console.log('%c5. UI Elements', 'color: #2196F3; font-weight: bold;');
  console.log('  Sidebar:', sidebar ? 'FOUND' : 'NOT FOUND');
  console.log('');
  console.log('%c=== End Diagnostic ===', 'color: #4CAF50;');
})();
