/**
 * ClipNote real-browser verification harness.
 * Usage: on YouTube/Udemy/ChatGPT with ClipNote started, open DevTools Console,
 * paste this whole file, press Enter. Then copy the console from
 * "=== HARNESS BOOT" to "=== HARNESS END" and paste it back.
 * This is read-only: it clicks the real buttons and reads page state.
 */
(() => {
  'use strict';

  const PLATFORM = window.__CN_PLATFORM__ || 'SET_ME';
  const SHOT = '#cn-btn-shot';
  const CANCEL = '#cn-btn-cancel';
  const STATUS = '#cn-status';
  const OVERLAY = '[data-cn="selector"], .cn-selector-overlay';
  const GRACE = 5000;
  const SHOTEL = '[id^="cn-shot-"], .cn-shot-item, .cn-note-shot';

  const $ = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  const mark = (m) => console.log('=== HARNESS ' + m + ' ===');

  const status = () => ($(STATUS) ? $(STATUS).textContent.trim() : '(no status)');
  const overlay = () => ($(OVERLAY) !== null);
  const count = () => document.querySelectorAll(SHOTEL).length;
  const img = () => !!document.querySelector(SHOTEL + ' img, ' + SHOTEL + ' canvas');

  const escKey = () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
  };

  async function test(name, expect, act) {
    mark('TEST ' + name + ' START');
    const before = count();
    console.log('[harness] before: status="' + status() + '" shots=' + before + ' overlay=' + overlay());
    try { await act(); } catch (e) { console.error('[harness] action error: ' + e); }
    const t0 = Date.now();
    let result = 'timeout';
    while (Date.now() - t0 < GRACE) {
      await sleep(200);
      const s = status();
      const ov = overlay();
      const n = count();
      if (expect === 'capture') {
        if (!ov && n > before && img()) { result = 'capture-complete'; break; }
      } else if (expect === 'cancel') {
        if (!ov && /cancel/i.test(s)) { result = 'cancelled'; break; }
      } else if (expect === 'single') {
        if (!ov && n - before >= 1) { result = (n - before === 1 ? 'single-save' : 'multi-save-' + (n - before)); break; }
      }
    }
    const pass = (expect === 'capture' && result === 'capture-complete') ||
                 (expect === 'cancel' && result === 'cancelled') ||
                 (expect === 'single' && result === 'single-save');
    results.push({ name, expect, result, pass, status: status() });
    mark('TEST ' + name + ' END -> ' + result + ' ' + (pass ? 'PASS' : 'FAIL'));
  }

  (async () => {
    mark('BOOT platform=' + PLATFORM + ' host=' + location.hostname);
    const btn = $(SHOT);
    console.log('[harness] ' + SHOT + ' present=' + (btn !== null));
    if (!btn) {
      console.error('[harness] BLOCKED: ' + SHOT + ' not found. Start ClipNote on this page, then re-run.');
      mark('END');
      return;
    }
    console.log('[harness] NOTE: [CN-CAP] logs come from the extension context. Copy this console block verbatim and paste it back.');

    await test('1-FirstCapture', 'capture', async () => { btn.click(); await sleep(400); });
    await test('2-EscapeCancel', 'cancel', async () => { btn.click(); await sleep(400); escKey(); });
    await test('3-ClickCancel', 'cancel', async () => { btn.click(); await sleep(400); if ($(CANCEL)) $(CANCEL).click(); else escKey(); });
    await test('4-DoubleClick', 'single', async () => { btn.click(); btn.click(); await sleep(600); });
    await test('5-SecondCapture', 'capture', async () => { btn.click(); await sleep(400); });

    console.log('');
    console.log('| Platform | Test | Expected | Actual | Status text | PASS/FAIL |');
    console.log('|---|---|---|---|---|---|');
    for (const r of results) {
      console.log('| ' + PLATFORM + ' | ' + r.name + ' | ' + r.expect + ' | ' + r.result + ' | ' + r.status + ' | ' + (r.pass ? 'PASS' : 'FAIL') + ' |');
    }
    console.log('');
    const failed = results.filter((r) => !r.pass).map((r) => r.name);
    console.log('[harness] svg note: ClipNote JS contains no "svg" literal. Any "svg" lines in this console are host page / async frame noise, not ClipNote output. To confirm: clear console, disable the extension, reload, and check whether "svg" still appears.');
    console.log('[harness] failing tests: ' + (failed.length ? failed.join(', ') : 'none'));
    mark('END');
  })().catch((e) => {
    console.error('[harness] FATAL: ' + (e && e.stack || e));
    mark('END');
  });
})();
