# Bug Fix Report

ClipNote extension bug-hunting session — 14 audited bugs fixed and verified. All fixes preserve the existing MV3 architecture (content scripts, sidebar iframe, `local-storage.js` ES module) and all previously-passing behaviour.

| # | Status | Bug | Root cause | Files changed | Verification |
|---|--------|-----|-----------|---------------|--------------|
| 1 | FIXED | YouTube detection returns empty/null id and false positives on `/watchlater`, `/shorts`, `/live` | `videoId()` read ONLY `?v=` → `null` on `/embed/`; `isWatchPage()` used a broad `/watch/` prefix and treated `/shorts` + `/live` as watch pages | `platforms/youtube/youtube-video.js`, `platforms/youtube/youtube.js` | 25-assertion Node suite (`clipnote-youtube-video.test.mjs`) |
| 2 | FIXED | "Delete note" during an in-flight Capture / Screenshot keeps the screen but silently drops the moment | `addCaptureToNote`/`captureMoment`/`takeScreenshot` resolved the active note AFTER `await`s | `sidebar/sidebar.js` (`captureMoment`, `takeScreenshot`, `addCaptureToNote(cap, targetNoteId)`) | `node --check` + code review; runtime deletion test in checklist |
| 3 | FIXED | Deletion vs. capture/background-save race can resurrect deleted files/folders and resurrect moments | Sidebar deleted files while an earlier save's FS write was still pending; moments could be re-written post-delete | `sidebar/sidebar.js` (`tombstonedNotes`, `tombstonesMoments`, `pendingWrites`, `persistMomentScreenshot`, `deleteMoment`, `deleteEntireNote`) | `node --check` + ordering review |
| 4 | FIXED | A delete that FAILS on disk silently leaves the file; "Rebuild Library" then resurrects it | Delete failures were swallowed, with no marker that the file must stay gone | `local-storage.js` (`_clipnote-deleted.json` registry, `markFileDeletedCarefully`, `deleteScreenshotFile`, `listImagePaths` filtering) | 81-assertion Node suite (`clipnote-local-storage.test.mjs`) + `node --check` |
| 5 | FIXED | Sidecar `_clipnote-note.json` held only title/metadata → rebuild lost annotations, real timestamps and moment ordering | Sidecar had no `moments[]`; merge derived everything from filenames | `local-storage.js` (`saveNoteSidecar` v3 with `moments[]`, merge-time enrichment), `storage/storage.html` footnote, `sidebar/sidebar.js` (debounced annotation → sidecar refresh) | Node tests 16–17 in local-storage suite |
| 6 | FIXED | Reloaded home-screen shot has a thumbnail but a dead click-through | Card click used `shot.screenshot` which is stripped on save; thumbnail async-load raced it | `sidebar/sidebar.js` (`ensureShotScreenshot` shared promise, `openShotPreview`) | `node --check` + code review |
| 7 | FIXED | Object URLs leak every time a screenshot file is removed | `revokeBlobUrl` was missing from the delete paths | `sidebar/sidebar.js` (`deleteShot`, `deleteMoment`, `deleteEntireNote`) | `node --check` + review |
| 8 | FIXED | Sidebar messages/screenshots target the WRONG tab (active tab of the window, not the page the sidebar lives in) | `chrome.tabs.query({ active: true, currentWindow: true })` from inside the iframe; fallback picked the active tab | `sidebar/sidebar.js` (own-tab targeting: `frameToken`, `CN_HOST_URL` handshake, `resolveOwnTabId`/`getOwnTabId`, `sendToContentScript` with owning tab + `{frameId: 0}`, capture-activation), `contentScript.js` (per-iframe token + page-URL postMessage) | `node --check` + code review; live multi-tab test in checklist |
| 9 | FIXED | Host misdetection: `music.youtube.com`, lookalikes and subdomains treated as supported → sidebar on wrong pages + timers burned | Substring host matching | `contentScript.js` `getPlatform()`, `platforms/youtube/youtube.js`, `platforms/udemy/udemy.js`, `popup/popup.js` `isSupportedSite()` | 25-assertion Node suite (host cases) |
| 10 | FIXED | Double-click "New Note" / "+" can create two notes | No in-flight guard | `sidebar/sidebar.js` (`creatingNote` flag, disabled triggers, restored button text) | `node --check` + review |
| 11 | FIXED | Popup shows wrong on/off state and acts on a stale state after rapid toggles | Used the checkbox's own `checked` as source of truth and let toggles interleave | `popup/popup.js` (`currentEnabled` + `toggleLock`, disabled button during apply) | Code review; manual toggle checklist |
| 12 | FIXED | Legacy v1 files with 2+ matching notes were glued onto the first match; re-runs bounced moments between notes | `mergeScannedFiles` picked `matches[0]` | `local-storage.js` (`mergeScannedFiles`: deterministic single-match OR stable "Recovered" bucket; first-scan matched moments never re-absorbed) | Node tests 13–15 in local-storage suite |
| 13 | FIXED | Large screenshots fail transfer with only an obscure "cancelled" error | No size handling before the message to the content script | `sidebar/sidebar.js` (`resizeDataUrl`, `MAX_MESSAGE_LENGTH` cap, explicit error message; original kept for pixel-exact crop) | `node --check` + review |
| 14 | FIXED | Missing-file warning is check-once-per-session and never clears when the file comes back | Permanent `_fileChecked` flag | `sidebar/sidebar.js` (`_fileCheckedAt` 30s TTL, `paintMissingWarn` re-paint, live-card patch) | `node --check` + review |

## Additional Bugs Found
- **BUG 12 follow-up (FIXED):** Re-running a merge over an already-recovered legacy bucket DUPLICATED the bucket (stable `recovered-<key>` id existed but wasn't consulted). `mergeScannedFiles` now reuses an existing bucket by its deterministic id, keeping rebuilds idempotent.

## Data Migration
- No schema rewrite. Everything produced by the extension so far remains readable:
  - `_clipnote-note.json` v1/v2 sidecars are still parsed; v3 adds a `moments[]` array (id, timestamp, humanTime, annotation, imageFileName, relativePath, sortOrder, createdAt, updatedAt, saveState — no blobs). Old sidecars degrade gracefully (title/metadata only, as before).
  - Legacy v1 folder layout (`YouTube/<videoId>/...`, `Udemy/<courseId>/<lectureId>/...`) still merges read-only. Ambiguous v1 leftovers now surface as their own "Recovered <label>" notes instead of being glued to an arbitrary note.
  - New `_clipnote-deleted.json` tombstone registry at the root of the chosen folder is opt-in and additive; files registered there are filtered out of scans so deliberate deletes never resurrect.
  - Moments already stored in browser storage are never overwritten by rebuild enrichment (storage is authoritative); only newly recovered files are enriched from their sidecar.

## Tests Performed
- `node --check` on every `.js` file in the project — all pass, including all edited files.
- Node unit suite `clipnote-local-storage.test.mjs` — 81/81 passed (pure-function tests for path parsing, folder layout, moment paths, merge determinism, recovered buckets, sidecar enrichment).
- Node unit suite `clipnote-youtube-video.test.mjs` — 25/25 passed (`videoId()` across watch/embed/shorts/live/home/watchlater, `isSupportedPage()` host cases, `isWatchPage()` edge cases), run with a minimal `window`/`location` shim against the real extension files.
- Grep audit for stale patterns: no remaining `active: true, currentWindow` capture, `CN_TAB_ID`, `_fileChecked`, or single-arg `addCaptureToNote` uses.

## Remaining Risks
- Live-browser verification could not be executed here (no Chrome session). The multi-tab screenshot targeting, popup toggling, and End-to-End capture→delete flows must be smoke-tested manually per the extension's own checklist.
- `resolveOwnTabId` relies on `chrome.runtime.getContexts` TAB entries listing embedded extension iframes; the token-validated host-URL/`tabs.query` unique-match fallback covers the gap, but a multi-tab edge case could theoretically fall back to `null` (sidebar would show "Couldn't connect" rather than act wrongly — a safe failure).
- YouTube can change its DOM/selectors; the URL-level logic is covered by tests, DOM-level code is not.
- `resizeDataUrl` sends a 1920px JPEG copy to the content script; on extreme low-memory pages the re-encode could throw (handled: falls back to the original, which the size gate then reports explicitly).