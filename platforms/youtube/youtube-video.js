// ClipNote - YouTube video helpers.
//
// Knows how to find the current player, read the video id/title, and build the
// video context. (The transcript/caption pipeline that once lived here was
// removed in the pre-release hardening: the product UI has no transcript
// feature, and the timedtext request was an unnecessary network call.)

(() => {
  'use strict';

  if (!window.__CN || !window.__CN.youtube) return;
  const NS = window.__CN;
  const Y = NS.youtube;
  if (Y.__videoLoaded) return;

  Y.video = {
    // Canonical video-id resolver. Prefers the explicit ?v= parameter, then
    // falls back to known path layouts (/embed/, /shorts/, /live/). The old
    // ?v-only reader returned an EMPTY id on /embed/ pages, which broke folder
    // identities there; every layout now resolves to the same 11-char id.
    videoId: function () {
      try {
        const url = new URL(location.href);
        const explicit = url.searchParams.get('v');
        if (explicit) return explicit;
        const m = url.pathname.match(/^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})/);
        return m ? m[1] : null;
      } catch (e) {
        return null;
      }
    },

    videoTitle: function () {
      return document.title.replace(/ - YouTube$/, '').trim();
    },

    // Preferred element: YouTube's own main player <video>.
    findPreferredVideo: function () {
      const main = document.querySelector(Y.selectors.mainVideo);
      if (main && main.offsetWidth > 0 && main.offsetHeight > 0) return main;
      const mp = document.querySelector(Y.selectors.moviePlayer);
      const inside = mp && mp.querySelector('video');
      if (inside && inside.offsetWidth > 0 && inside.offsetHeight > 0) return inside;
      return null;
    },

    // Fallback screenshot image for videos whose frame cannot be drawn.
    screenshotFallback: function () {
      return Y.video.thumbnailUrl();
    },

    thumbnailUrl: function () {
      const id = Y.video.videoId();
      return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
    }
  };

  Y.__videoLoaded = true;
})();