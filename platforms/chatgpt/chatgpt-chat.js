// ClipNote - ChatGPT conversation identity.
//
// A ChatGPT "note" is tied to ONE conversation (the equivalent of a YouTube
// video / Udemy lecture). This module reads the conversation's stable identity
// straight from the URL path (/c/<conversation-id>) and derives a display title
// from the page's own title surfaces. It never fabricates an id and never reads
// generated class names.

(() => {
  'use strict';

  if (!window.__CN || !window.__CN.chatgpt) return;
  const NS = window.__CN;
  const C = NS.chatgpt;
  if (C.__chatLoaded) return;

  // ChatGPT conversation URLs are https://chatgpt.com/c/<uuid> (and the legacy
  // https://chat.openai.com/c/<uuid> form). A conversation id is a UUID kept in
  // the FIRST path segment after "/c/".
  const CONVERSATION_RE = /^\/c\/([0-9a-fA-F-]+)([\/?#]|$)/;

  // Strip ChatGPT's app-suffix chrome from a document title.
  const cleanPageTitle = (title) => (title || '')
    .replace(/\s+[-|]\s+ChatGPT\s*$/i, '')
    .replace(/^ChatGPT\s+[-|]\s+/i, '')
    .trim();

  C.chat = {
    // The stable conversation id, or null when not on a /c/<uuid> page.
    conversationId: function () {
      const m = location.pathname.match(CONVERSATION_RE);
      return m ? m[1] : null;
    },

    // A display title for the conversation. Prefers the page's own title
    // element, then falls back to the cleaned <title> text. Never returns a
    // generated class name or an id-shaped string.
    conversationTitle: function () {
      const el = C.queryFirst(C.selectors.conversationTitle);
      if (el) {
        const title = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (title) return cleanPageTitle(title);
      }
      return cleanPageTitle(document.title);
    },

    // The element ChatGPT marks as the full capture surface, when rendered.
    conversationContent: function () {
      return C.queryFirst(C.selectors.conversationContent);
    }
  };

  C.__chatLoaded = true;
})();