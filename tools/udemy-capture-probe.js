// ClipNote - Udemy capture probe.
//
// Paste this whole file into the DevTools console on a Udemy /learn/lecture/
// page to see exactly why the extension's frame capture is or is not working.
// It mirrors what contentScript.js -> captureFrameDataUrl() does (draw the
// <video> onto a canvas, then toDataURL) and reports every candidate element.
(function () {
  'use strict';
  var report = {
    url: location.href,
    cnLoaded: !!window.__CN,
    udemyLoaded: !!(window.__CN && window.__CN.udemy),
    adapterLoaded: !!(window.__CN && window.__CN.adapters && window.__CN.getAdapter && window.__CN.getAdapter('udemy')),
    selectors: (window.__CN && window.__CN.udemy && window.__CN.udemy.selectors) || null
  };

  // The extension's own preferred pick, exactly as findPreferredVideo() resolves it.
  var U = window.__CN && window.__CN.udemy;
  var preferred = null;
  try { preferred = U && U.video && U.video.findPreferredVideo(); } catch (e) { report.preferredError = String(e); }
  report.preferredFound = !!preferred;
  report.preferred = preferred ? describe(preferred) : null;

  function describe(v) {
    return {
      tag: v.tagName.toLowerCase(),
      id: v.id || '',
      cls: (v.className && v.className.toString ? v.className.toString() : '').slice(0, 90),
      offsetW: v.offsetWidth,
      offsetH: v.offsetHeight,
      videoW: v.videoWidth,
      videoH: v.videoHeight,
      readyState: v.readyState,
      networkState: v.networkState,
      paused: v.paused,
      currentTime: v.currentTime,
      duration: v.duration,
      crossOrigin: v.crossOrigin,
      currentSrc: (v.currentSrc || v.src || '').slice(0, 100)
    };
  }

  // Every <video> on the page, with the same canvas draw + encode the extension does.
  var all = Array.prototype.slice.call(document.querySelectorAll('video'));
  report.videoCount = all.length;
  report.videos = all.map(function (v, i) {
    var row = describe(v);
    row.i = i;
    row.isPreferred = v === preferred;
    try {
      var c = document.createElement('canvas');
      c.width = v.videoWidth || 1;
      c.height = v.videoHeight || 1;
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      var url = c.toDataURL('image/jpeg', 0.9);
      row.capture = (typeof url === 'string' && url.indexOf('data:image/') === 0)
        ? 'OK (' + url.length + ' chars)'
        : 'BAD OUTPUT';
      row.tainted = false;
    } catch (e) {
      row.capture = 'FAILED';
      row.tainted = e && e.name === 'SecurityError';
      row.captureError = (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e));
    }
    return row;
  });

  console.log('%c=== ClipNote Udemy Capture Probe ===', 'color:#4CAF50;font-weight:bold;font-size:14px;');
  console.log(report);
  if (!report.videoCount) {
    console.warn('No <video> elements found in the light DOM. The player may be inside an iframe or shadow root.');
  } else if (report.videos.some(function (r) { return r.tainted; })) {
    console.warn('A video frame is CANVAS-TAINTED (cross-origin/DRM): toDataURL throws, so a drawn frame cannot be saved. Falling back to a visible-tab crop is required.');
  } else if (report.videos.some(function (r) { return r.offsetW === 0 || r.offsetH === 0; })) {
    console.warn('A <video> has ZERO layout size (offsetWidth/Height = 0): findPreferredVideo()/findGenericVideo() reject it.');
  }
  return report;
})();
