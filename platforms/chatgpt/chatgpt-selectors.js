// ClipNote - ChatGPT selectors (single source of truth for ChatGPT DOM queries).
//
// ChatGPT has no stable generated-class contract (its Tailwind/CSS-module class
// names like "qMYqUG_..." and "ViewerContent-Cg8AgN" change between deploys), so
// these selectors anchor on the stable structural ids/attributes the page keeps:
// #main, #thread, the data-testid="conversation-turn-*" markers and the
// data-message-author-role attributes. The code that uses them re-verifies
// connection / visibility at runtime because ChatGPT re-renders its DOM while
// streaming.
//
// Every entry below is an ORDERED fallback chain: the first match wins. Only
// ids and data-* attributes are used - never a generated class name.

(() => {
  'use strict';

  if (!window.__CN) return;
  const NS = window.__CN;
  if (!NS.chatgpt) NS.chatgpt = {};
  if (NS.chatgpt.__selectorsLoaded) return;

  NS.chatgpt.selectors = {
    // The main chat column that holds the thread.
    main: ['#main', 'main', '[role="main"]'],

    // The message thread (all conversation turns) inside #main.
    thread: ['#thread', '[data-scroll-root]', '[data-testid="thread"]'],

    // The element ChatGPT marks as the full conversation capture surface.
    // OpenAI has shipped this under more than one name; keep every known form.
    conversationContent: [
      '[data-conversation-screenshot-content]',
      '[data-testid="conversation-screenshot-content"]'
    ],

    // Title surfaces, in preference order. Generated class names are avoided;
    // data-testid / semantic elements come first, the document title last.
    conversationTitle: [
      '[data-testid="conversation-title"]',
      '[data-testid="chat-title"]',
      'h1',
      'h2'
    ],

    // A single user/assistant turn block. ChatGPT has rendered these as
    // <article> / <section> / <div> over time; all carry the stable
    // data-testid="conversation-turn-<n>" (or the data-turn) marker.
    conversationTurn: [
      'article[data-testid^="conversation-turn-"]',
      'section[data-testid^="conversation-turn-"]',
      'div[data-testid^="conversation-turn-"]',
      '[data-testid^="conversation-turn-"]',
      '[data-turn]'
    ]
  };

  // Return the first element matching any selector in the ordered list.
  NS.chatgpt.queryFirst = function (list) {
    for (const sel of list || []) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  };

  // Return every element matching ANY selector in the list (deduplicated).
  NS.chatgpt.queryAll = function (list) {
    const out = [];
    for (const sel of list || []) {
      document.querySelectorAll(sel).forEach((el) => {
        if (!out.includes(el)) out.push(el);
      });
    }
    return out;
  };

  // The element that physically wraps every rendered conversation turn. Its
  // LOWEST COMMON ANCESTOR is, by construction, the conversation region: the
  // composer, header and navigation rail all live OUTSIDE it. This is the
  // resilient replacement for the single [data-conversation-screenshot-content]
  // hook that OpenAI can drop or rename, because it is derived from the stable
  // conversation-turn markers instead. Never reads a generated class name.
  // Returns null when no turn is rendered (there is nothing to scope to).
  NS.chatgpt.conversationSurface = function () {
    const turns = NS.chatgpt.queryAll(NS.chatgpt.selectors.conversationTurn)
      .filter((t) => t.isConnected);
    if (!turns.length) return null;
    // Start from the first turn's parent and climb until the candidate contains
    // EVERY turn. With a single turn, its parent (one level above the turn
    // itself) is the surface - never the message body of that one turn.
    let common = turns[0].parentElement;
    for (let i = 1; i < turns.length && common; i++) {
      while (common && !common.contains(turns[i])) common = common.parentElement;
    }
    // Never hand back a bare turn, the body or the document root.
    while (common && turns.includes(common)) common = common.parentElement;
    if (!common || common === document.body || common === document.documentElement) return null;
    return common;
  };

  NS.chatgpt.__selectorsLoaded = true;
})();
