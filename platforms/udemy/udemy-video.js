// ClipNote - Udemy video helpers.
//
// Knows how to locate the current lecture player and how to build the lecture
// / course metadata (the "video context") the sidebar stores with every note.
// The context contract is identical to the pre-refactor getVideoContext():
// platform="udemy" objects carry lectureId, courseSlug, courseId, courseTitle,
// lectureTitle on top of the shared base fields.

(() => {
  'use strict';

  if (!window.__CN || !window.__CN.udemy) return;
  const NS = window.__CN;
  const U = NS.udemy;
  if (U.__videoLoaded) return;

  const cleanPageTitle = (title) => (title || '')
    .replace(/\s+[-|]\s+Udemy$/i, '')
    .replace(/^Udemy\s+[-|]\s+/i, '')
    .replace(/- Udemy$/, '')
    .trim();

  // Collapse text of the first matching element, or read a meta attribute.
  const elText = (list, metaAttr) => {
    const el = U.queryFirst(list);
    if (!el) return '';
    if (metaAttr) return (el.getAttribute(metaAttr) || '').trim();
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  };

  U.video = {
    lectureId: function () {
      const m = location.pathname.match(/\/lecture\/(\d+)/);
      return m ? m[1] : null;
    },

    courseSlug: function () {
      const m = location.pathname.match(/\/course\/([^/?]+)/);
      return m ? m[1] : null;
    },

    // Udemy's lecture <video> element, when it is actually laid out. Every
    // candidate from the selector chain is collected, and the LARGEST visible
    // one wins - so when the player no longer exposes the Video.js "vjs-tech"
    // class (the live element may have no stable class/id at all) the real
    // lecture video is still found, and a hidden/ad/preview <video> can never
    // shadow it. Returns null when nothing is laid out (the shared findVideo()
    // loop then keeps polling / falls back to its own generic detection).
    findPreferredVideo: function () {
      const seen = [];
      for (const sel of U.selectors.lectureVideo || []) {
        document.querySelectorAll(sel).forEach((v) => {
          if (!seen.includes(v)) seen.push(v);
        });
      }
      const visible = seen
        .filter((v) => v.offsetWidth > 0 && v.offsetHeight > 0)
        .sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight));
      return visible[0] || null;
    },

    // Fallback screenshot image when the frame cannot be drawn.
    screenshotFallback: function (videoEl) {
      return (videoEl && videoEl.poster) || null;
    },

    // Build the full lecture + course metadata object.
    meta: function () {
      const lectureId = U.video.lectureId() || '';
      const courseSlug = U.video.courseSlug() || '';

      let lectureTitle = elText(U.selectors.lectureTitle);
      if (!lectureTitle) lectureTitle = elText(['meta[property="og:title"]'], 'content');
      if (!lectureTitle) lectureTitle = cleanPageTitle(document.title).split(' | ')[0] || '';

      let courseTitle = elText(U.selectors.goToCourse);
      if (!courseTitle) courseTitle = elText(U.selectors.courseTitle);
      if (!courseTitle && courseSlug) {
        const link = document.querySelector(`a[href*="/course/${courseSlug}"]`);
        if (link) courseTitle = (link.textContent || '').replace(/\s+/g, ' ').trim();
      }
      if (!courseTitle && lectureTitle) {
        const rest = cleanPageTitle(document.title)
          .replace(lectureTitle, '')
          .replace(/^\s*[-|]\s*/, '')
          .replace(/\s*\|\s*Udemy$/i, '')
          .trim();
        courseTitle = rest;
      }

      let courseId = elText(U.selectors.courseIdAttr, 'data-course-id');
      if (!courseId) courseId = courseSlug;

      return {
        lectureId,
        courseSlug,
        courseId,
        courseTitle: courseTitle || '',
        lectureTitle: lectureTitle || ''
      };
    }
  };

  U.__videoLoaded = true;
})();