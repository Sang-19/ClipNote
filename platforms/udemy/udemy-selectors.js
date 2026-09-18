// ClipNote - Udemy selectors (single source of truth for Udemy DOM queries).
//
// Every selector is an ordered array: the first element that matches on the
// live page wins. Prefer Udemy's stable data-purpose attributes / ids over
// generated CSS-module class names such as "sidebar--content--ot5Wx", which
// change between Udemy deploys.

(() => {
  'use strict';

  if (!window.__CN) return;
  const NS = window.__CN;
  if (!NS.udemy) NS.udemy = {};
  if (NS.udemy.__selectorsLoaded) return;

  NS.udemy.selectors = {
    // The right-hand sidebar scroll container. The user-supplied Udemy DOM
    // marks it with data-purpose="sidebar-content" and id="ct-sidebar-scroll-container".
    sidebarContent: [
      '[data-purpose="sidebar-content"]',
      '#ct-sidebar-scroll-container'
    ],

    // The host course content INSIDE that scroll container. It must stay
    // intact; ClipNote is inserted before it, never on top of it.
    courseContent: [
      '.ct-sidebar-course-content'
    ],

    // Udemy's Video.js <video> element.
    lectureVideo: ['video.vjs-tech'],

    lectureTitle: ['[data-purpose="lecture-title"]'],
    goToCourse: ['[data-purpose="go-to-course"]'],
    courseTitle: ['[data-purpose="course-title"]', '.course-title', '[data-purpose="curriculum-title"]'],
    courseIdAttr: ['[data-course-id]']
  };

  // Return the first element matching any selector in the ordered list.
  NS.udemy.queryFirst = function (list) {
    for (const sel of list || []) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  };

  NS.udemy.__selectorsLoaded = true;
})();