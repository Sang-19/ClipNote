// ClipNote - YouTube selectors (single source of truth for YouTube DOM queries).
//
// These anchor on YouTube's stable, long-lived ids/structural elements
// (#secondary, #secondary-inner, #panels, ytd-watch-flexy, #movie_player),
// NOT on generated class names such as style-scope hashes. The code that uses
// them re-verifies visibility/connection at runtime because YouTube reshuffles
// its watch-page DOM.

(() => {
  'use strict';

  if (!window.__CN) return;
  const NS = window.__CN;
  if (!NS.youtube) NS.youtube = {};
  if (NS.youtube.__selectorsLoaded) return;

  NS.youtube.selectors = {
    // Root of the watch page layout.
    watchFlexy: 'ytd-watch-flexy',

    // The right rail column. Displayed beside the player on wide windows,
    // below it on narrower ones (YouTube handles the responsive breakpoints).
    secondary: '#secondary',

    // In-flow wrapper inside #secondary that holds #panels and #related.
    secondaryInner: '#secondary-inner',

    // Engagement/transcript panels at the top of the rail.
    panels: '#panels',

    // The main player and its <video> element.
    moviePlayer: '#movie_player',
    mainVideo: '.html5-main-video'
  };

  NS.youtube.__selectorsLoaded = true;
})();