// ClipNote - ChatGPT selectors (single source of truth for ChatGPT DOM queries).
//
// ChatGPT has no stable generated-class contract (its Tailwind/CSS-module class
// names like "qMYqUG_..." change between deploys), so these selectors anchor on
// the stable structural ids/attributes the page keeps: #main, #thread and the
// data-* conversation markers. The code that uses them re-verifies connection /
// visibility at runtime because ChatGPT re-renders its DOM while streaming.

(() => {
  'use strict';

  if (!window.__CN) return;
  const NS = window.__CN;
  if (!NS.chatgpt) NS.chatgpt = {};
  if (NS.chatgpt.__selectorsLoaded) return;

  NS.chatgpt.selectors = {
    // The main chat column that holds the thread.
    main: '#main',

    // The message thread (all conversation turns) inside #main.
    thread: '#thread',

    // The element ChatGPT marks as the full conversation capture surface.
    conversationContent: '[data-conversation-screenshot-content]',

    // Title surfaces, in preference order. Generated class names are avoided;
    // data-testid / semantic elements come first, the document title last.
    conversationTitle: [
      '[data-testid="conversation-title"]',
      '[data-testid="chat-title"]',
      'h1',
      'h2'
    ],

    // A single user/assistant turn block.
    conversationTurn: '[data-testid^="conversation-turn-"]'
  };

  // Return the first element matching any selector in the ordered list.
  NS.chatgpt.queryFirst = function (list) {
    for (const sel of list || []) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  };

  NS.chatgpt.__selectorsLoaded = true;
})();