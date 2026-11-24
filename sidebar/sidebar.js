// ClipNote - sidebar logic
// Runs inside the sidebar iframe. Handles notes, captures, and export.

// Import the shared local-folder storage logic.
import * as ls from '../local-storage.js';

// Wrap everything in a function so nothing leaks out.
(() => {
  'use strict';

  // Fixed Google Form opened by the "Feedback" header button.
  const FEEDBACK_URL = "https://forms.gle/tEeSy2en7pbQHri89";

  // Fixed LinkedIn profile opened by the home view's LinkedIn link.
  const LINKEDIN_URL = "https://www.linkedin.com/in/sangbed-pati-966aa2289/";

  // ----------------------- Storage (options + screenshots) -----------------------

  // True while this extension's context is still usable. After the extension
  // is reloaded/updated at chrome://extensions, old pages keep their sidebar
  // iframe but its chrome.* APIs die, so every call here would throw.
  function isAlive() {
    // Accessing chrome.* may itself throw once the context is gone.
    try {
      // A live extension always has a runtime id.
      return !!(self.chrome && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      // The context was invalidated.
      return false;
    }
  }

  // Small wrappers around Chrome's local storage.
  const storage = {
    // Read one key and resolve with its value.
    get(key) {
      // Return a Promise so callers can await the result.
      return new Promise((resolve) => {
        // If the extension context died (e.g. just reloaded), return nothing
        // instead of throwing "Extension context invalidated".
        if (!isAlive()) return resolve(null);
        // Ask Chrome for the stored value.
        chrome.storage.local.get([key], (res) => {
          // Resolve null on error, otherwise the value.
          resolve(chrome.runtime.lastError ? null : res[key]);
        });
      });
    },
    // Save an object into Chrome's storage.
    set(obj) {
      // Return a Promise so callers know when saving finished.
      return new Promise((resolve) => {
        // Skip the write when the context is gone (a fresh one is on its way).
        if (!isAlive()) return resolve();
        // Store the object.
        chrome.storage.local.set(obj, () => resolve());
      });
    }
  };

  // The database name used to store screenshot images.
  const IDB_NAME = 'clipnote_screenshots';
  // The open database connection (null until opened).
  let idb = null;
  // One shared initialization promise so every caller waits on the SAME open
  // request. A failed open resets it so a later call can retry; a successful
  // open is cached in `idb` and short-circuits afterwards. There is no timeout:
  // an open either succeeds or reports onerror/onblocked, so a winning request
  // can never be silently shadowed by a timer that fired first.
  let idbPromise = null;

  // Open the IndexedDB database that holds screenshots.
  function openIdb() {
    // Fast path: the connection is already open.
    if (idb) return Promise.resolve(idb);
    // Reuse the in-flight (or previously failed-and-reset) initialization.
    if (idbPromise) return idbPromise;
    idbPromise = new Promise((resolve) => {
      // Ask the browser to open (or create) the database.
      const req = indexedDB.open(IDB_NAME, 1);
      // This runs the first time the database is created.
      req.onupgradeneeded = () => {
        // If there's no "shots" store yet:
        if (!req.result.objectStoreNames.contains('shots')) {
          // Create a store to keep the images in.
          req.result.createObjectStore('shots');
        }
      };
      // On success, remember the connection.
      req.onsuccess = () => { idb = req.result; resolve(idb); };
      // On error, resolve null so we know it failed.
      req.onerror = () => { idbPromise = null; resolve(null); };
      // If another tab blocks us, resolve null (and allow a later retry).
      req.onblocked = () => { idbPromise = null; resolve(null); };
    });
    return idbPromise;
  }

  // Read a screenshot out of IndexedDB.
  async function idbGet(key) {
    // Guard against errors.
    try {
      // Make sure the database is open.
      const db = await openIdb();
      // If it never opened, return undefined.
      if (!db) return undefined;
      // Wrap the browser's request in a Promise.
      return await new Promise((resolve) => {
        // Start a read-only transaction for the shots store.
        const req = db.transaction('shots', 'readonly').objectStore('shots').get(key);
        // Resolve with the stored image.
        req.onsuccess = () => resolve(req.result);
        // Resolve undefined on error.
        req.onerror = () => resolve(undefined);
      });
    } catch (e) { return undefined; }
  }

  // Save a screenshot into IndexedDB.
  async function idbSet(key, value) {
    // Guard against errors.
    try {
      // Make sure the database is open.
      const db = await openIdb();
      // If it never opened, do nothing.
      if (!db) return;
      // Wrap the write in a Promise.
      await new Promise((resolve) => {
        // Start a read-write transaction.
        const tx = db.transaction('shots', 'readwrite');
        // Save the image under its key.
        tx.objectStore('shots').put(value, key);
        // Resolve when the write completes.
        tx.oncomplete = () => resolve();
        // Resolve on any error or cancel.
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    } catch (e) { /* ignore */ }
  }

  // Delete a screenshot from IndexedDB.
  async function idbDelete(key) {
    // Guard against errors.
    try {
      // Make sure the database is open.
      const db = await openIdb();
      // If it never opened, do nothing.
      if (!db) return;
      // Wrap the delete in a Promise.
      await new Promise((resolve) => {
        // Start a read-write transaction.
        const tx = db.transaction('shots', 'readwrite');
        // Remove the image under its key.
        tx.objectStore('shots').delete(key);
        // Resolve when the delete completes.
        tx.oncomplete = () => resolve();
        // Resolve on any error or cancel.
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    } catch (e) { /* ignore */ }
  }

  // Screenshots are big data URLs, so keep them out of chrome.storage.
  // The key that holds the list of notes.
  const NOTE_KEY = 'clipnote_notes';
  // The key that remembers which note is currently open.
  const ACTIVE_KEY = 'clipnote_active_note_id';
  // The chrome.storage key holding the index of manual webpage screenshots
  // (the image data itself lives in IndexedDB, like moment screenshots).
  const SHOTS_KEY = 'clipnote_manual_shots';
  // One-shot request to seek the lecture this URL is opening (Udemy, whose
  // URLs cannot carry a timestamp). Written here, consumed by the content
  // script on the newly opened lecture page.
  const PENDING_SEEK_KEY = 'clipnote_pending_seek';
  // Legacy key names used before the ClipNote rename.
  const OLD_NOTE_KEY = 'snt_notes';
  const OLD_ACTIVE_KEY = 'snt_active_note_id';
  const OLD_IDB_NAME = 'snt_screenshots';

  // Build a unique key for a screenshot from a note and a moment.
  function shotKey(noteId, momentId) {
    // Join the two ids with a separator.
    return `${noteId}::${momentId}`;
  }

  // Build the IndexedDB key for a manual webpage screenshot.
  function manualShotKey(shotId) {
    // Namespaced so it can never collide with a moment screenshot.
    return `manual-shot::${shotId}`;
  }

  // ----------------------- State -----------------------

  // Shortcut helper for finding elements by CSS selector.
  const $ = (sel) => document.querySelector(sel);

  // The home view container.
  const viewHome = $('#cn-view-home');
  // The note detail view container.
  const viewNote = $('#cn-view-note');
  // The list of note cards on the home view.
  const homeList = $('#cn-home-list');
  // The "no notes yet" message.
  const homeEmpty = $('#cn-home-empty');
  // The "+ New Note" button on the home view.
  const homeNewBtn = $('#cn-home-new');
  // The LinkedIn link on the home view.
  const linkedinLink = $('#cn-linkedin-link');
  // The "Storage" button that opens the local storage settings page.
  const storageBtn = $('#cn-btn-storage');
  // The "Feedback" button that opens the Google Form in a new tab.
  const feedbackBtn = $('#cn-btn-feedback');
  // The back button on the note view.
  const noteBackBtn = $('#cn-note-back');
  // The note title shown in the header.
  const noteTitleDisplay = $('#cn-note-title-display');
  // The small video title shown under the note title.
  const noteVideoInfo = $('#cn-note-video-info');
  // The list of moment cards in the note view.
  const momentsList = $('#cn-moments-list');
  // The "no moments yet" message.
  const noMoments = $('#cn-no-moments');
  // The counter next to "Captured Moments".
  const momentCount = $('#cn-moment-count');
  // The "+ Capture" button.
  const btnCapture = $('#cn-btn-capture');
  // The "Screenshot" button (captures a rectangle of the webpage).
  const btnShot = $('#cn-btn-shot');
  // The "Export" button.
  const btnExport = $('#cn-btn-export');
  // The "New" button on the note view.
  const btnNew = $('#cn-btn-new');
  // The status line at the bottom.
  const statusEl = $('#cn-status');
  // The Screenshots section on the home view.
  const shotsSection = $('#cn-shots-section');
  // The counter next to the Screenshots label.
  const shotCount = $('#cn-shot-count');
  // The list of screenshot cards on the home view.
  const shotList = $('#cn-shot-list');

  // Every note the user has created.
  let allNotes = [];
  // The id of the note currently shown.
  let activeNoteId = null;
  // Every manual webpage screenshot the user has taken.
  let manualShots = [];
  // The active drag-and-drop state (null when not dragging).
  let dragReorder = null;
  // The animation frame id used for auto-scroll while dragging.
  let dragScrollRaf = 0;
  // How many of OUR chrome.storage writes are still in flight. The onChanged
  // reload listener uses this to ignore the sidebar's own writes (which would
  // otherwise re-render everything on every keystroke) while still reacting to
  // EXTERNAL changes (e.g. Rebuild Library on the Storage page).
  let storageWriteInFlight = 0;
  // True from boot until init() finishes its first load, so storage.onChanged
  // events raised by the migration/reload machinery are not double-handled.
  let bootstrapping = true;

  // ----------------------- Deletion safety state -----------------------
  // Notes whose deletion has begun (or finished). Checked SYNCHRONOUSLY before
  // any write so a capture or background save that races the deletion can never
  // resurrect a deleted note or recreate its folder on disk.
  const tombstonedNotes = new Set();
  // Moment ids (as "noteId::momentId") whose deletion has begun/finished.
  const tombstonesMoments = new Set();
  // Every in-flight folder write, keyed "noteId::momentId". Deletion awaits
  // them so the filesystem is only touched after all writes settled.
  const pendingWrites = new Map();

  // Show a short message in the footer.
  function setStatus(text) {
    // Set the text, or clear it if none was given.
    statusEl.textContent = text || '';
  }

  // Create a unique id for a note or moment.
  function uuid() {
    // If the browser offers a real random id, use it.
    if (self.crypto && crypto.randomUUID) return crypto.randomUUID();
    // Otherwise build one from random hex digits.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      // Pick a random hex digit.
      const r = (Math.random() * 16) | 0;
      // The version 4 format needs a fixed bit pattern.
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      // Turn the number into a hex character.
      return v.toString(16);
    });
  }

  // Turn a timestamp into friendly "Xm ago" text.
  function timeAgo(ts) {
    // How many minutes have passed since then.
    const mins = Math.floor((Date.now() - ts) / 60000);
    // Under a minute counts as "just now".
    if (mins < 1) return 'just now';
    // Under an hour is shown in minutes.
    if (mins < 60) return `${mins}m ago`;
    // Convert to hours.
    const hrs = Math.floor(mins / 60);
    // Under a day is shown in hours.
    if (hrs < 24) return `${hrs}h ago`;
    // Anything older is shown in days.
    return `${Math.floor(hrs / 24)}d ago`;
  }

  // ----------------------- Notes CRUD -----------------------

  // Remove the screenshot fields before saving, to keep storage small.
  function stripScreenshots(notes) {
    // Map every note to a copy without the screenshots.
    return notes.map((note) => ({
      // Spread the original note fields.
      ...note,
      // Rebuild its moments without the big image data.
      moments: (note.moments || []).map((m) => {
        // Pull the screenshot field out.
        const { screenshot, ...rest } = m;
        // Keep everything except the screenshot.
        return rest;
      })
    }));
  }

  // Save all notes to Chrome's storage (without the images). Every record is
  // normalized first (schema v4) so the stored library always carries its
  // schemaVersion and canonical moment ids. The in-flight counter lets the
  // storage.onChanged reload listener tell OUR writes apart from external ones.
  async function saveAllNotes() {
    // Preserve the inline screenshot on moments not yet written to the folder
    // while dropping it from the persisted copy.
    storageWriteInFlight++;
    try {
      await storage.set({ [NOTE_KEY]: stripScreenshots(ls.normalizeNotes(allNotes)) });
    } finally {
      storageWriteInFlight = Math.max(0, storageWriteInFlight - 1);
    }
  }

  // Make sure every moment's sortOrder matches its position in the note.
  function refreshSortOrders(note) {
    // Walk the moments and stamp their index as the sort order.
    (note.moments || []).forEach((m, i) => { m.sortOrder = i; });
  }

  // Best-effort download of a remote image (thumbnails, posters, fallback
  // previews) into a data URL, so it can be persisted to the shared folder.
  // Returns null when the fetch is blocked (CORS/offline) or not an image.
  async function fetchRemoteImageDataUrl(remoteUrl) {
    try {
      // A normal CORS fetch is all that is needed for public CDNs.
      const res = await fetch(remoteUrl, { mode: 'cors' });
      // Only success yields a body.
      if (!res.ok) return null;
      // Read it as a blob.
      const blob = await res.blob();
      // Re-encode through an <img> + canvas so the persisted file is always a
      // clean JPEG in our folder (and CORS-purposed blobs are handled safely).
      if (typeof URL.createObjectURL === 'function') {
        const url = URL.createObjectURL(blob);
        try {
          const img = await loadImage(url);
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || 1;
          canvas.height = img.naturalHeight || 1;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const out = canvas.toDataURL('image/jpeg', 0.92);
          // Only accept a real image back.
          if (typeof out === 'string' && out.startsWith('data:image/')) return out;
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      return null;
    } catch (e) {
      // CORS/offline/etc.: nothing to persist, the card labels it for a retry.
      return null;
    }
  }

  // Write one moment's screenshot into the user's chosen folder.
  // If it can't be saved, the moment keeps its data so a retry can fix it.
  // Deletion-safe: tombstoned notes/moments are never written to (that is what
  // stopped a deleted note's folder from being recreated by an in-flight save).
  async function persistMomentScreenshot(note, moment) {
    // Deleted or gone already?
    if (!note || !moment) return;
    if (tombstonedNotes.has(note.id)) return;
    if (tombstonesMoments.has(shotKey(note.id, moment.id))) return;
    if (!findNote(note.id)) return;

    // Serialize writes per moment: an already-running persist is shared, never
    // duplicated, and deletion waits on the same promise.
    const key = shotKey(note.id, moment.id);
    if (pendingWrites.has(key)) {
      await pendingWrites.get(key);
      return;
    }

    const work = (async () => {
      // Re-verify (synchronously) before every stage: a deletion may have
      // begun while we awaited the folder status above.
      if (tombstonedNotes.has(note.id)) return;
      if (tombstonesMoments.has(key)) return;
      if (!findNote(note.id)) return;
      // Already on disk: nothing left to write, and never downgrade the state
      // (a blob preview must not be re-labelled "noimage" by this function).
      if (moment.saveState === 'saved' && moment.relativePath) return;

      // The state we'll report back for this moment.
      let newState = null;
      try {
        // Read the folder entry and its permission state.
        const entry = await ls.getFolderEntry();
        // If there is no folder at all, or access is missing:
        if (!entry.handle || entry.permission !== 'granted') {
          // Mark the moment so the UI can guide the user to Storage.
          moment.saveState = 'unavailable';
          // Clear any old error text.
          moment.saveError = null;
          // Remember the change.
          newState = 'unavailable';
        } else if (moment.screenshot && moment.screenshot.type === 'remote-url' && moment.screenshot.url) {
          // A distant/fallback thumbnail (e.g. a YouTube video preview image).
          // Try to download it and persist the real file to the folder so EVERY
          // install (and a storage wipe) can recover it from disk. Best effort:
          // a CORS-blocked/offline fetch leaves the moment on its remote preview
          // with an explicit "remote-unsaved" state and a Retry button.
          const dataUrl = await fetchRemoteImageDataUrl(moment.screenshot.url);
          if (!dataUrl) {
            // The remote image could not be fetched: keep the preview, but flag
            // that the library cannot yet restore it from the folder.
            moment.saveState = 'remote-unsaved';
            moment.saveError = null;
            newState = 'remote-unsaved';
          } else {
            // A temporary data-url shell is written exactly like a real capture,
            // so the original-quality file lands in the note's own folder.
            if (tombstonedNotes.has(note.id)) return;
            if (tombstonesMoments.has(key)) return;
            if (!findNote(note.id)) return;
            const tmp = { ...moment, screenshot: { type: 'data-url', dataUrl } };
            const relativePath = await ls.saveScreenshotFile({ note, moment: tmp });
            // The note may still have been deleted while the file was written;
            // do not then touch the (recreated) folder or persist metadata.
            if (tombstonedNotes.has(note.id)) return;
            if (!findNote(note.id)) return;
            // Stamp the relative reference on the moment.
            moment.relativePath = relativePath;
            moment.imageFileName = relativePath.split('/').pop();
            moment.saveState = 'saved';
            moment.saveError = null;
            newState = 'saved';
            // The folder now carries the metadata sidecar as well.
            await ls.saveNoteSidecar(note);
            // Swap the remote preview for a blob of the saved file (best effort).
            try {
              const preview = await ls.readBlobUrl(moment.relativePath);
              if (preview) moment.screenshot = { type: 'blob-url', url: preview };
            } catch (e) { /* keep the remote-url preview */ }
          }
        } else if (!moment.screenshot || moment.screenshot.type !== 'data-url' || !moment.screenshot.dataUrl) {
          // No inline image to save and no remote source either: a genuine
          // text-only moment (annotation with no captured image). It stays a
          // valid moment; there is simply nothing to write to the folder.
          moment.saveState = 'noimage';
          newState = 'noimage';
        } else {
          // Final synchronous gate directly before the filesystem write. From
          // here on, deletion can only continue after this write settles (it
          // awaits pendingWrites), so the folder cannot be removed underneath.
          if (tombstonedNotes.has(note.id)) return;
          if (tombstonesMoments.has(key)) return;
          if (!findNote(note.id)) return;
          // Write the original-quality file to the folder.
          const relativePath = await ls.saveScreenshotFile({ note, moment });
          // The note may still have been deleted while the file was written;
          // do not then touch the (recreated) folder or persist metadata for it.
          if (tombstonedNotes.has(note.id)) return;
          if (!findNote(note.id)) return;
          // Stamp the relative reference on the moment.
          moment.relativePath = relativePath;
          // The file name comes from the end of the path.
          moment.imageFileName = relativePath.split('/').pop();
          // Mark it as saved to disk.
          moment.saveState = 'saved';
          // Forget any previous error.
          moment.saveError = null;
          // Remember the change.
          newState = 'saved';
          // Stamp the note's own folder with a metadata sidecar (best effort)
          // so the filesystem alone can restore the title after a reinstall.
          await ls.saveNoteSidecar(note);
          // The original is now on disk. Free the large inline image (and its
          // redundant IndexedDB copy) by swapping the in-memory data-url for a
          // blob preview of the saved file, so memory and storage stop growing
          // by a whole screenshot per capture - the file on disk becomes the
          // single source of truth. Best effort: a hiccup here must never
          // undo a successful save.
          try {
            const preview = await ls.readBlobUrl(moment.relativePath);
            if (preview && moment.screenshot && moment.screenshot.type === 'data-url') {
              await idbDelete(shotKey(note.id, moment.id));
              moment.screenshot = { type: 'blob-url', url: preview };
            }
          } catch (e) { /* keep the data-url fallback: capture is safe */ }
        }
      } catch (e) {
        // The write failed. If the note was deleted mid-flight, stop silently
        // (nothing to keep); otherwise keep everything so "Retry" can fix it.
        if (tombstonedNotes.has(note.id)) return;
        if (!findNote(note.id)) return;
        // Keep the reason for the UI.
        moment.saveState = 'failed';
        moment.saveError = e && e.message ? String(e.message) : 'Folder write failed.';
        // Remember the change.
        newState = 'failed';
      }

      // Only persist when the state actually changed.
      if (newState) {
        // Save the updated metadata.
        await saveAllNotes();
        // The final state (saved / failed / unavailable / noimage) changes what
        // the card shows (retry button, storage hint, none). The folder write
        // runs asynchronously after a capture, so repaint when this note is
        // still the one on screen - otherwise the card keeps looking pending
        // until some later unrelated re-render happens to refresh it.
        const active = getActiveNote();
        if (active && active.id === note.id) renderMoments();
      }
    })();

    pendingWrites.set(key, work);
    try {
      await work;
    } finally {
      pendingWrites.delete(key);
    }
  }

  // Retry saving a failed moment's screenshot.
  async function retrySaveMoment(noteId, momentId) {
    // Look up the note.
    const note = findNote(noteId);
    // Look up the moment inside it.
    const moment = note && (note.moments || []).find((m) => m.id === momentId);
    // If either is missing, there's nothing to retry.
    if (!note || !moment) return;
    // Check whether a folder is granted first.
    const entry = await ls.getFolderEntry();
    // If the folder isn't accessible, guide the user to the Storage page.
    if (!entry.handle || entry.permission !== 'granted') {
      // Point the user at the Storage settings page.
      if (isAlive()) chrome.tabs.create({ url: chrome.runtime.getURL('storage/storage.html') });
      return;
    }
    // Mark it as being retried.
    moment.saveState = 'pending';
    // Repaint so the user sees the attempt.
    renderMoments();
    // Try the write again.
    await persistMomentScreenshot(note, moment);
    // Repaint with the outcome.
    renderMoments();
  }

  // Coerce a raw stored moment into a canonical shape. Delegates to
  // ls.normalizeMoment (schema v4): a moment with a missing/invalid id is now
  // given a DETERMINISTIC id instead of being dropped (data-loss fix).
  function sanitizeMoment(raw, index, note) {
    return ls.normalizeMoment(raw, index, note);
  }

  // Coerce a raw stored note into a canonical shape (schema v4). Delegates to
  // ls.normalizeNote; a missing new field is an OPTIONAL field, never invalid.
  function sanitizeNote(raw, index) {
    return ls.normalizeNote(raw, index);
  }

  // Load all notes, then attach their images (filesystem FIRST, browser caches
  // only as a fallback - the folder is the cross-install source of truth).
  async function loadAllNotes() {
    // Read the stored notes.
    const data = await storage.get(NOTE_KEY);
    // Use the stored list, or an empty list if there's none.
    const rawList = (data && Array.isArray(data)) ? data : [];
    // Normalize every record (idempotent, non-destructive, never drops).
    const normalized = rawList.map(sanitizeNote).filter(Boolean);
    // Was any record still on an older schema? If so, persist the migration
    // once so the stored library and the filesystem sidecars stay in step.
    const needsMigration = rawList.some((r) => r && r.schemaVersion !== 4);
    allNotes = normalized;
    if (needsMigration) {
      await saveAllNotes();
    }

    // Rehydrate screenshots: the FILESYSTEM is authoritative (relative path),
    // IndexedDB only a temporary cache for moments not yet written to disk.
    // Loop over every note.
    for (const note of allNotes) {
      // Loop over every moment in the note.
      for (const moment of (note.moments || [])) {
        // Clean out any leftover fields from older cloud versions.
        delete moment.syncState;
        delete moment.cloudImagePath;
        // Make sure every moment knows its place in the note.
        if (typeof moment.sortOrder !== 'number') moment.sortOrder = note.moments.indexOf(moment);
        // If this moment has no screenshot yet:
        if (!moment.screenshot || moment.screenshot.type === 'none') {
          // A file on disk always wins: read it fresh from the folder.
          if (moment.relativePath) {
            // Build a displayable preview straight from the file.
            const url = await ls.readBlobUrl(moment.relativePath);
            // If we got a preview, use it (never a broken URL: the render pass
            // re-resolves on demand whenever this cache entry is missing).
            if (url) moment.screenshot = { type: 'blob-url', url };
          } else {
            // No file: the browser cache (IndexedDB) may still hold the image.
            const saved = await idbGet(shotKey(note.id, moment.id));
            // If we found it, put it back on the moment.
            if (saved) moment.screenshot = saved;
          }
        }
      }
    }
  }

  // Move any data saved under the old pre-rename keys.
  async function migrateOldData() {
    // Read the legacy notes list.
    const legacyNotes = await storage.get(OLD_NOTE_KEY);
    // If there were notes and the new key is still empty:
    if (legacyNotes && Array.isArray(legacyNotes) && !(await storage.get(NOTE_KEY))) {
      // Move them across to the new key.
      await storage.set({ [NOTE_KEY]: legacyNotes });
      // Clear the old key.
      await storage.set({ [OLD_NOTE_KEY]: null });
    }
    // Read the legacy active-note id.
    const legacyActive = await storage.get(OLD_ACTIVE_KEY);
    // If one existed and the new key is still empty:
    if (legacyActive != null && !(await storage.get(ACTIVE_KEY))) {
      // Move it across to the new key.
      await storage.set({ [ACTIVE_KEY]: legacyActive });
      // Clear the old key.
      await storage.set({ [OLD_ACTIVE_KEY]: null });
    }
    // Copy any screenshots from the legacy database too.
    await migrateScreenshots();
  }

  // Copy screenshots from the legacy IndexedDB into the new one.
  async function migrateScreenshots() {
    // Guard against failures.
    try {
      // Open the legacy database.
      const req = indexedDB.open(OLD_IDB_NAME);
      // Wait for it to open.
      const legacy = await new Promise((resolve) => {
        // Resolve with the database on success.
        req.onsuccess = () => resolve(req.result);
        // Resolve null on any failure.
        req.onerror = () => resolve(null);
      });
      // If the legacy database never opened, nothing to do.
      if (!legacy) return;
      // If it has no "shots" store, close and drop it.
      if (!legacy.objectStoreNames.contains('shots')) {
        legacy.close();
        // Remove the empty database.
        indexedDB.deleteDatabase(OLD_IDB_NAME);
        return;
      }
      // Make sure the new database is open.
      const db = await openIdb();
      // If the new database failed too, stop here.
      if (!db) return;
      // Collect every legacy record with a cursor.
      const records = await new Promise((resolve) => {
        // Open a read-only transaction.
        const tx = legacy.transaction('shots', 'readonly');
        // The image store inside it.
        const store = tx.objectStore('shots');
        // Gather all entries into here.
        const all = [];
        // Walk the store with a cursor.
        store.openCursor().onsuccess = (e) => {
          // The cursor from the event.
          const cursor = e.target.result;
          // If there's a record:
          if (cursor) {
            // Keep the key and the image together.
            all.push([cursor.key, cursor.value]);
            // Advance to the next record.
            cursor.continue();
          } else {
            // Otherwise finish with everything we found.
            resolve(all);
          }
        };
      });
      // Write each record into the new database.
      for (const [key, value] of records) {
        // Save the image under the same key.
        await idbSet(key, value);
      }
      // Close the legacy connection.
      legacy.close();
      // Drop the legacy database now that it's copied.
      indexedDB.deleteDatabase(OLD_IDB_NAME);
    } catch (e) { /* ignore */ }
  }

  // Find a note by its id.
  function findNote(id) {
    // Search the list for a matching id.
    return allNotes.find((n) => n.id === id);
  }

  // Get the note object that is currently open.
  function getActiveNote() {
    // Look it up by the stored active id.
    return findNote(activeNoteId);
  }

  // Reload the library from chrome.storage after an EXTERNAL change (e.g. the
  // Storage page's "Rebuild Library"), preserving the open note when it still
  // exists. Debounced so a rapid burst of notifications collapses to one pass.
  let reloadTimer = null;
  function reloadNotesFromStorage() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      // The reload is fire-and-forget; a failure must surface nowhere and never
      // tear down the sidebar, so the whole pass is guarded.
      try {
        // Preserve the current selection where possible.
        const wasId = activeNoteId;
        // Re-read and normalize (the previous contents can be gone entirely).
        await loadAllNotes();
        // Re-read the manual screenshots as well (both live in browser storage).
        await loadManualShots();
        // Is the previously open note still there after the rebuild?
        if (wasId && findNote(wasId)) {
          activeNoteId = wasId;
          renderMoments();
        } else {
          // The note vanished (or never existed): go back to the home view.
          activeNoteId = null;
          showHomeView();
        }
      } catch (e) { /* keep the UI alive on reload failures */ }
    }, 300);
  }

  // ----------------------- Own-tab targeting -----------------------

  // The id of the tab that actually HOSTS this sidebar iframe (resolved once).
  // The sidebar may live in ANY tab (including a background one), so it must
  // never assume it is the currently active tab: targeting the active tab
  // stole captures/seeks/screenshots from another page whenever a second tab
  // was in front. Resolution is deterministic and never guesses.
  let ownTabId = null;
  let ownTabResolve = null;
  // The unique per-tab token the content script embeds in our iframe URL. Any
  // message from the host page must carry it, so a stale/foreign frame can
  // never claim to own us.
  const ownToken = (new URLSearchParams(location.search).get('frame')) || '';

  // Resolve which tab hosts this sidebar, in order:
  //   1) chrome.runtime.getContexts(): our own chrome-extension:// context is
  //      listed with its documentUrl; its tabId is the tab that hosts us.
  //   2) The host content script postMessage()es its page URL (validated by our
  //      token); match it against the tab list ONLY when unambiguous.
  // There is deliberately NO "use the active tab" fallback.
  function resolveOwnTabId() {
    return (async () => {
      try {
        const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
        const mine = contexts.find((c) => c.documentUrl === location.href);
        if (mine && Number.isInteger(mine.tabId)) return mine.tabId;
      } catch (e) {
        // Chrome older than 116 or non-supporting context: use the host URL.
      }

      const hostUrl = await waitForHostUrl();
      if (!hostUrl) return null;
      try {
        const tabs = await chrome.tabs.query({});
        const matches = tabs.filter((t) => t.url === hostUrl);
        // Only a unique match is safe; several tabs on the same URL stay
        // ambiguous and are never guessed.
        return matches.length === 1 ? matches[0].id : null;
      } catch (e) {
        return null;
      }
    })();
  }

  // Ask the host content script for the page URL over chrome.runtime messaging.
  // This channel is invisible to arbitrary PAGE scripts (unlike the old
  // window.postMessage handshake, which a page could read and spoof once it
  // knew the token), and only the content script holding THIS sidebar's token
  // ever replies. Returns the URL string or ''.
  function whoAmI() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (url) => {
        if (done) return;
        done = true;
        resolve(url || '');
      };
      // Bound the wait: after the extension context dies there is no answer.
      const timer = setTimeout(() => finish(''), 1200);
      try {
        chrome.runtime.sendMessage({ type: 'CN_WHOAMI', frameToken: ownToken }, (res) => {
          clearTimeout(timer);
          if (!chrome.runtime.lastError && res && res.ok === true && typeof res.url === 'string') {
            finish(res.url);
          } else {
            finish('');
          }
        });
      } catch (e) {
        clearTimeout(timer);
        finish('');
      }
    });
  }

  // Wait (bounded) for the host content script to reveal the page URL. Runtime
  // messaging is tried with a few short retries in case the content script was
  // just (re)registered mid-startup.
  function waitForHostUrl() {
    return (async () => {
      const url = await whoAmI();
      if (url) return url;
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 150));
        const again = await whoAmI();
        if (again) return again;
      }
      return null;
    })();
  }

  // Memoized accessor for the own-tab id (null when unresolvable).
  function getOwnTabId() {
    if (ownTabId != null) return Promise.resolve(ownTabId);
    if (!ownTabResolve) {
      ownTabResolve = resolveOwnTabId().then((id) => {
        ownTabId = Number.isInteger(id) ? id : null;
        // A null result can be a temporary startup/permission race. Do not
        // memoize failure: the next Screenshot or Capture action retries.
        if (ownTabId == null) ownTabResolve = null;
        return ownTabId;
      }).catch((error) => {
        ownTabResolve = null;
        throw error;
      });
    }
    return ownTabResolve;
  }

  // ----------------------- Capture via content script -----------------------

  // Send a message to the content script and wait for its answer.
  async function sendToContentScript(message) {
    // Guard against errors.
    try {
      // If the extension context died (e.g. just reloaded), bail out quietly.
      if (!isAlive()) return null;
      // Find the tab that hosts THIS sidebar - never the active tab.
      const tabId = await getOwnTabId();
      // If we could not resolve our host tab, never fire blind.
      if (tabId == null) return null;
      // Wrap the reply in a Promise.
      return await new Promise((resolve) => {
        // Deliver ONLY to the main frame of our own tab (content scripts live
        // there), so the message can never reach a different page or a
        // different frame on the same page.
        chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, (res) => {
          // Return null instead of the reply if something failed.
          resolve(chrome.runtime.lastError || !res ? null : res);
        });
      });
    } catch (e) {
      // Any error just means no reply.
      return null;
    }
  }

  // Turn seconds into "MM:SS" text.
  function formatTimestamp(seconds) {
    // Coerce to a whole number and never go below zero.
    seconds = Math.max(0, Math.floor(seconds || 0));
    // Work out how many whole minutes.
    const m = Math.floor(seconds / 60);
    // Work out the remaining seconds.
    const s = seconds % 60;
    // Return them padded like "05:09".
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // Do notes/moments for this platform refer to a real video? Video platforms
  // (YouTube & Udemy) keep the timestamp/seek/jump UI exactly as before; the
  // video-less platform (ChatGPT) never shows a timestamp, duration, seek
  // control or fake time - its captures simply mean "what is on screen now".
  // The decision is made from the platform, never by branching on YouTube or
  // Udemy specifics.
  function platformHasVideo(platform) {
    const p = platform || 'youtube';
    return p === 'youtube' || p === 'udemy';
  }

  // Escape user-controlled text before it is interpolated into HTML we build.
  // Used by the PDF export so note titles/annotations always render as plain
  // text and can never turn into executable markup.
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // The order moments are displayed and exported in: by their saved sortOrder
  // (a number, from refreshSortOrders()/persisted on rebuild), with moments
  // that have no usable sortOrder sorted LAST in their stored order. A stable
  // sort keeps equal keys in the exact order they were stored in, so an old
  // moment without a sortOrder never jumps around after a rebuild.
  function momentsInDisplayOrder(moments) {
    if (!moments || !Array.isArray(moments)) return [];
    const hasSortOrder = moments.some((m) => Number.isFinite(m.sortOrder));
    if (!hasSortOrder) return moments;
    return moments
      .map((m, index) => ({ m, index, sort: Number.isFinite(m.sortOrder) ? m.sortOrder : Number.MAX_SAFE_INTEGER }))
      .sort((a, b) => (a.sort - b.sort) || (a.index - b.index))
      .map((x) => x.m);
  }

  // Guards a URL before it is trusted as a link target (PDF timestamp links
  // and momentWatchUrl()). Only http(s) URLs pass; anything else (javascript:,
  // data:, blob:, chrome-extension:, malformed or empty strings) yields '', so
  // stored values can never become executable or privileged link targets.
  function isSafeExternalUrl(value) {
    const candidate = String(value == null ? '' : value).trim();
    if (!candidate) return '';
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch (e) {
      return '';
    }
    const proto = parsed.protocol.toLowerCase();
    return (proto === 'http:' || proto === 'https:') ? candidate : '';
  }

  // Ask the content script for the current video's details.
  async function getVideoContext() {
    // Send the context request and return its reply.
    return await sendToContentScript({ type: 'CN_GET_VIDEO_CONTEXT' });
  }

  // Ask the content script where the on-page CONTENT area is, so the ChatGPT
  // "+ Capture" moment can be cropped down to just the host conversation region
  // instead of the whole browser viewport. The platform adapter answers with a
  // CSS-viewport-pixel rectangle of a stable element; video platforms have no
  // such region and return null. Only the ChatGPT "+ Capture" flow uses this
  // today - the shared Screenshot flow keeps the full visible frame.
  async function getScreenshotTarget() {
    const res = await sendToContentScript({ type: 'CN_GET_SCREENSHOT_TARGET' });
    if (!res || !res.ok) return null;
    // The full capture plan: the on-page CONTENT target (ChatGPT conversation
    // region), the ClipNote container's own visible rectangle (the fallback
    // exclusion zone), the page viewport and the platform. All in CSS viewport
    // pixels, computed against the SAME layout the frame will be shot in, so
    // the crop that follows is pixel-accurate.
    return {
      target: (res.target && res.target.width > 1 && res.target.height > 1) ? res.target : null,
      clip: (res.clip && res.clip.width > 1 && res.clip.height > 1) ? res.clip : null,
      viewport: (res.viewport && res.viewport.width > 1 && res.viewport.height > 1) ? res.viewport : null,
      platform: (typeof res.platform === 'string' && res.platform) ? res.platform : ''
    };
  }

  // The rectangle (CSS viewport px, with its viewport snapshot) the ChatGPT
  // "+ Capture" saved image must stay inside. The on-page CONTENT target (the
  // conversation region) is authoritative when the content script provides
  // one; otherwise the ClipNote column is cut out of the viewport on the
  // larger side. Used ONLY by captureChatgptMoment - the shared Screenshot
  // flow keeps the full visible frame and never goes through this function.
  function resolveCaptureRect(plan) {
    if (plan && plan.target) {
      return {
        x: plan.target.x, y: plan.target.y,
        width: plan.target.width, height: plan.target.height,
        // Prefer the plan's viewport; fall back to the one the target carried
        // itself (older content scripts attach it to the target, not the plan).
        viewport: (plan.viewport && plan.viewport.width) ? plan.viewport : plan.target.viewport
      };
    }
    // No on-page content target: cut the ClipNote column itself out of the
    // frame, keeping the larger side of the column.
    if (plan && plan.clip && plan.viewport) {
      const leftArea = plan.clip.x;
      const rightArea = plan.viewport.width - (plan.clip.x + plan.clip.width);
      if (leftArea > rightArea) {
        // Right-hand column: the host content is everything left of it.
        return {
          x: 0, y: 0,
          width: Math.max(1, leftArea),
          height: plan.viewport.height,
          viewport: plan.viewport
        };
      }
      if (rightArea > 1) {
        // Left-hand column: the host content is everything right of it.
        return {
          x: Math.floor(plan.clip.x + plan.clip.width), y: 0,
          width: Math.max(1, rightArea),
          height: plan.viewport.height,
          viewport: plan.viewport
        };
      }
    }
    return null;
  }

  // Ask the content script to capture the current frame.
  async function captureNow() {
    // Send the capture-now message.
    const res = await sendToContentScript({ type: 'CN_CAPTURE_NOW' });
    // Return the capture only if the request succeeded.
    return (res && res.ok && res.capture) ? res.capture : null;
  }

  // Ask the content script to jump the video to a time.
  async function seekTo(seconds) {
    // Send the seek message (we don't use the reply).
    await sendToContentScript({ type: 'CN_SEEK_TO', seconds });
  }

  // The authoritative "watch this Moment" URL.
  //   * New moments carry their own stored videoUrl (snapshotted at capture
  //     time, so it survives navigating to another video).
  //   * Legacy moments without one only ever get a URL generated from a video
  //     id + timestamp that were ALREADY stored on the note/moment - never from
  //     the current page - and only for YouTube (canonical watch URLs) or Udemy
  //     (canonical lecture URL rebuilt from the stored course slug + lecture id;
  //     a numeric course id is never a reliable slug, so those stay '').
  // Returns '' when no trustworthy URL exists.
  function momentWatchUrl(moment, note) {
    // A stored URL is always authoritative - but only when it is a real
    // http(s) link. A corrupt/unsafe stored value (javascript:, data:, ...)
    // must never be offered as a click target, so it falls through to the
    // legacy rebuild instead of being handed to the page.
    const stored = (moment && typeof moment.videoUrl === 'string') ? moment.videoUrl : '';
    const safeStored = isSafeExternalUrl(stored);
    if (safeStored) return safeStored;
    // Legacy fallback: build only from a reliably stored video id.
    const platform = (moment && moment.platform) || (note && note.platform) || '';
    const videoId = (moment && moment.videoId) || (note && note.video && note.video.id) || '';
    if (platform === 'youtube' && videoId) {
      const secs = Math.max(0, Math.floor((moment && moment.timestamp) || 0));
      const base = 'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId);
      return secs > 0 ? base + '&t=' + secs + 's' : base;
    }
    if (platform === 'udemy' && videoId) {
      // Only a real course slug (non-numeric, not the numeric id copy) gives a
      // trustworthy legacy lecture URL; otherwise there is nothing to open.
      const course = (note && note.course) || {};
      const slug = course.slug;
      const id = course.id;
      if (typeof slug === 'string' && slug &&
          (slug !== id || !id)) {
        const safeSlug = encodeURIComponent(slug);
        const safeLecture = encodeURIComponent(String(videoId));
        return 'https://www.udemy.com/course/' + safeSlug + '/learn/lecture/' + safeLecture + '/';
      }
    }
    return '';
  }

  // The video identity a moment refers to (used for same-video detection only;
  // the moment's stored source is always what actually gets opened).
  function momentVideoIdentity(moment, note) {
    return {
      platform: (moment && moment.platform) || (note && note.platform) || '',
      videoId: (moment && moment.videoId) || (note && note.video && note.video.id) || ''
    };
  }

  // ----------------------- Capturing -----------------------

  // True while a capture is already running.
  let capturing = false;

  // Disable the capture buttons and show progress while a capture runs.
  function setCapturing(active, progressText) {
    // Remember whether we're capturing.
    capturing = active;
    // Disable the Capture button while active.
    btnCapture.disabled = active;
    // Disable the Screenshot button while active.
    btnShot.disabled = active;
    // Dim the Capture button.
    btnCapture.style.opacity = active ? '0.6' : '';
    // Dim the Screenshot button.
    btnShot.style.opacity = active ? '0.6' : '';
    // Swap the Capture label between progress and default.
    btnCapture.textContent = active ? (progressText || 'Capturing...') : '+ Capture';
  }

  // Save a new capture as a moment in the target note.
  // `targetNoteId` MUST be captured by the caller BEFORE its first await: the
  // user can switch notes (or delete the note) while a capture/screenshot is
  // still in flight, and the moment must never land in whatever note happens
  // to be active when it returns. Returns false when the target is gone.
  async function addCaptureToNote(cap, targetNoteId) {
    // Resolve the note by the id captured up front - never the current one.
    const note = findNote(targetNoteId);
    // If there's no note or capture, or the note is being/has been deleted,
    // discard the capture instead of resurrecting it somewhere wrong.
    if (!note || !cap) return false;
    if (tombstonedNotes.has(note.id)) return false;
    // Use the capture's id, or make a new one.
    const momentId = cap.id || uuid();
    // Use the capture's screenshot, or a "none" placeholder.
    const screenshotData = cap.screenshot || { type: 'none' };

    // Add the new moment to the note's list.
    note.moments.push({
      // The moment's unique id.
      id: momentId,
      // VIDEO platforms only: when in the video it was captured, plus the same
      // time as friendly text. ChatGPT moments are genuinely timestamp-free and
      // never carry these fields (no video time, no wall-clock capture time) -
      // the platform decision is made from the capture's own platform, never by
      // faking a value here.
      ...((cap.platform || note.platform || 'youtube') === 'chatgpt'
        ? {}
        : {
            timestamp: cap.timestamp || 0,
            humanTime: cap.humanTime || formatTimestamp(cap.timestamp || 0)
          }),
      // The video snapshot THIS moment belongs to. Every moment keeps its own
      // source video (platform/videoId/videoUrl captured at capture time), so
      // moments captured after navigating to another video still point at the
      // video they came from.
      platform: cap.platform || note.platform || 'youtube',
      videoId: cap.videoId || '',
      videoUrl: cap.videoUrl || '',
      // The screenshot data (kept in IndexedDB as the preview cache).
      screenshot: screenshotData,
      // Any annotation that came with it.
      annotation: cap.annotation || '',
      // Where this moment sits in the note.
      sortOrder: note.moments.length,
      // The folder-relative path (filled in after the file is written).
      relativePath: '',
      // The file name inside the folder (filled in after the write).
      imageFileName: '',
      // Where the original is on disk: pending / saved / failed /
      // unavailable (no folder) / noimage (nothing to save).
      saveState: 'pending',
      // Why the last write failed (when it did).
      saveError: null,
      // When it was captured.
      createdAt: Date.now(),
      // When it was last changed.
      updatedAt: Date.now()
    });
    // Refresh the note's "last edited" time.
    note.updatedAt = Date.now();

    // Store the screenshot image in IndexedDB (preview cache only).
    await idbSet(shotKey(note.id, momentId), screenshotData);
    // Write the original screenshot to the user's folder in the background
    // so the UI shows the new moment immediately without freezing. The write
    // itself is deletion-safe (persistMomentScreenshot checks tombstones).
    const moment = note.moments[note.moments.length - 1];
    // Never fire-and-forget a promise that can reject: persistMomentScreenshot
    // may reject AFTER its internal write (e.g. saveAllNotes or renderMoments
    // throw outside its inner try/catch). An uncaught rejection would surface
    // as an unrelated error even though the screenshot was saved fine. Log it
    // explicitly instead.
    void persistMomentScreenshot(note, moment).catch((error) => {
      console.error('persistMomentScreenshot failed after capture', error);
    });
    return true;
  }

  // Scroll the moments list down to the newest card. Only ClipNote's OWN
  // scrollable container is ever scrolled - never scrollIntoView(), which can
  // propagate scrolling up to the host page behind the sidebar.
  async function scrollToLast() {
    // The scrollable moments list container itself.
    const list = momentsList;
    // Only scroll when there is actually a card to reveal.
    if (!list.lastElementChild) return;
    // Scroll the container directly to its bottom, so the newest moment card
    // is fully visible while the page around the sidebar never moves.
    list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  }

  // Handle a single click of the "+ Capture" button.
  async function captureMoment() {
    // Ignore the click if we're already capturing.
    if (capturing) return;
    // Resolve the target note UP FRONT (before any await): while the actual
    // capture runs the user may navigate to another note or delete this one,
    // and the moment must still land here - or not land at all.
    const targetNoteId = activeNoteId;
    // Ignore it if there's no open note.
    if (!targetNoteId || !findNote(targetNoteId)) return;

    // Block the buttons while we work.
    setCapturing(true);
    // True only when the new moment was successfully inserted into its note.
    let added = false;
    // Guard against errors while capturing.
    try {
      // Capture whatever is on screen right now. On a video-less platform
      // (ChatGPT) "Capture" means saving the visible window, which only the
      // extension's own captureVisibleTab can do - the content script has no
      // video to draw and must never fake one.
      let cap = null;
      const ctx = await getVideoContext();
      const platform = (ctx && ctx.platform) || '';
      if (platform === 'chatgpt') {
        cap = await captureChatgptMoment();
      } else {
        cap = await captureNow();
        // A cross-origin <video> (Udemy) taints the canvas, so the content
        // script's drawn frame comes back as no image. Shoot the visible tab and
        // crop it to the video rectangle so the moment still gets its real frame.
        if (cap && (!cap.screenshot || cap.screenshot.type !== 'data-url')) {
          const frame = await captureVisibleVideoFrame();
          if (frame) cap.screenshot = frame;
        }
      }
      // If we got a capture:
      if (cap) {
        // Add it to the note that was open when the user clicked.
        added = await addCaptureToNote(cap, targetNoteId);
        // Save the notes.
        await saveAllNotes();
        if (!added) {
          // The note was deleted while the capture was in flight.
          setStatus('The note was deleted while capturing.');
          setTimeout(() => setStatus(''), 4000);
        }
      } else {
        // Otherwise tell the user why nothing appeared.
        setStatus(platform === 'chatgpt'
          ? 'Couldn\u2019t capture the current page.'
          : 'Couldn\u2019t capture \u2014 no playable video found in this tab.');
        // Clear the message after a few seconds.
        setTimeout(() => setStatus(''), 4000);
      }
    } finally {
      // Always re-enable the buttons.
      setCapturing(false);
    }
    // Redraw the moments list and wait until the cards are actually in the DOM.
    await renderMoments();
    // Bring the new card into view, but ONLY when the note the capture landed
    // in is still the one on screen - the user may have switched notes while
    // the capture was running.
    if (added && activeNoteId === targetNoteId) await scrollToLast();
  }

  // ----------------------- Webpage screenshots -----------------------

  // Remove the heavy image data before saving the index to storage.
  function stripShotData(shots) {
    // Map every shot to a copy without the screenshot field.
    return (shots || []).map((s) => {
      // Pull the screenshot field out.
      const { screenshot, ...rest } = s;
      // Keep everything except the image.
      return rest;
    });
  }

  // Load the index of manual webpage screenshots from storage. Any shots the
  // browser storage knows about are also bridged into the shared filesystem
  // index (best-effort), so the Web Store and local installations can discover
  // the same manual screenshots.
  async function loadManualShots() {
    // Read the stored index.
    const data = await storage.get(SHOTS_KEY);
    // Use the stored list, or an empty list if there's none.
    manualShots = (data && Array.isArray(data)) ? data : [];
    // Bridge any browser-only shots into the shared on-disk index.
    await ls.saveManualShotsIndex(manualShots);
  }

  // Load an image and resolve when its pixels are ready.
  function loadImage(src) {
    // Wrap the image load in a Promise.
    return new Promise((resolve, reject) => {
      // A fresh image element.
      const img = new Image();
      // Resolve once decoded.
      img.onload = () => resolve(img);
      // Reject if decoding failed.
      img.onerror = () => reject(new Error('Could not decode the captured image'));
      // Start loading.
      img.src = src;
    });
  }

  // Crop the captured tab image down to the selected rectangle. The captured
  // image is in device pixels (browser zoom and display DPR are baked into the
  // bitmap), while the rectangle is in CSS viewport pixels. We therefore derive
  // the REAL scale from the image itself - capturedImageWidth / hostViewportCssWidth
  // (and height, separately) - never assume a devicePixelRatio value, so the
  // crop lines up at every zoom level. Everything is clamped to the bitmap.
  async function cropCapturedImage(dataUrl, rect, viewport) {
    // Decode the full captured image.
    const img = await loadImage(dataUrl);
    // How many image pixels cover one CSS pixel on the host page, per axis.
    const scaleX = (viewport && viewport.width) ? img.naturalWidth / viewport.width : 1;
    const scaleY = (viewport && viewport.height) ? img.naturalHeight / viewport.height : 1;
    // Map the rectangle into image coordinates, clamped to the image.
    const x1 = Math.max(0, Math.round(rect.x * scaleX));
    const y1 = Math.max(0, Math.round(rect.y * scaleY));
    const x2 = Math.min(img.naturalWidth, Math.max(x1, Math.round((rect.x + rect.width) * scaleX)));
    const y2 = Math.min(img.naturalHeight, Math.max(y1, Math.round((rect.y + rect.height) * scaleY)));
    const sw = x2 - x1;
    const sh = y2 - y1;
    // A zero-sized crop (shouldn't happen, but guard anyway) is "no image".
    if (sw <= 0 || sh <= 0) return null;

    // Render the selection onto a new canvas.
    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, x1, y1, sw, sh, 0, 0, sw, sh);
    const out = canvas.toDataURL('image/jpeg', 0.92);
    // Only hand back a real image.
    return typeof out === 'string' && out.startsWith('data:image/') ? out : null;
  }

  // Hard cap for image data sent through a message: chrome t.tabs messaging
  // fails with "message length exceeded" around ~64 MB, so we keep well below
  // it and give the user an explicit error instead of a cryptic "cancelled".
  const MAX_MESSAGE_LENGTH = 45 * 1024 * 1024;

  // Downscale + re-encode an image so it can travel in an extension message.
  // The frozen selection layer stretches it over the full viewport regardless
  // of its resolution, so a ~1920px copy is visually identical while being a
  // small fraction of the original size. Returns the original when resizing is
  // impossible (caller re-checks the size limit against it).
  async function resizeDataUrl(dataUrl, maxEdge, quality) {
    try {
      // Decode the original image.
      const img = await loadImage(dataUrl);
      // Shrink only when it exceeds the requested long edge.
      const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
      // The target dimensions (never below 1px).
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      // Render the scaled copy.
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      // Re-encode it as a JPEG.
      const out = canvas.toDataURL('image/jpeg', quality);
      // A real image comes back as a data URL.
      return (typeof out === 'string' && out.startsWith('data:image/')) ? out : dataUrl;
    } catch (e) {
      // Resize is best-effort: fall back to the original.
      return dataUrl;
    }
  }

  // ----------------------- Visible-tab capture shared helpers -----------------------

  // The manifest already declares host_permissions for every supported site
  // (YouTube, Udemy, ChatGPT), which is all chrome.tabs.captureVisibleTab
  // needs. No additional runtime permission request is required.
  async function ensureCapturePermission() {
    return true;
  }

  // The tab that hosts THIS sidebar, brought to the front of its window so a
  // captureVisibleTab shoots OUR page (it only ever captures the ACTIVE tab of
  // a window). Returns { tab } with the active tab, or { tab: null } - with
  // activateFailed:true only when the tab existed but could not be brought
  // forward, so callers can show the precise error message.
  async function bringOwnTabToFront() {
    const tabId = await getOwnTabId();
    if (tabId == null) {
      return {
        tab: null,
        activateFailed: false,
        reason: 'ClipNote could not identify the browser tab hosting its sidebar. Close and reopen the ClipNote sidebar, then try again.'
      };
    }
    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (e) {
      tab = null;
    }
    if (!tab) return { tab: null, activateFailed: false };
    if (!tab.active) {
      try {
        await chrome.tabs.update(tabId, { active: true });
        await new Promise((r) => setTimeout(r, 180));
        tab = await chrome.tabs.get(tabId);
      } catch (e) {
        tab = null;
      }
      if (!tab || !tab.active) return { tab: null, activateFailed: true };
    }
    return { tab, activateFailed: false };
  }

  // Decode a captured frame purely to prove it has REAL pixels. A blank screen
  // composited by the browser still decodes cleanly - only a missing, empty or
  // corrupt bitmap yields zero size, and that is the definitive "the capture
  // actually failed" signal the flows validate against before cropping/saving.
  async function probeCaptureImage(dataUrl) {
    try {
      const img = await loadImage(dataUrl);
      return { width: img.naturalWidth || 0, height: img.naturalHeight || 0 };
    } catch (e) {
      return { width: 0, height: 0 };
    }
  }

  // Capture the visible frame of the given tab. Never throws: reports whether
  // captureVisibleTab itself threw (permission/tab not capturable) versus
  // returning an invalid frame, so callers can explain the failure.
  async function captureVisibleFrame(tab) {
    let dataUrl = null;
    let error = '';
    let timeoutId = null;
    try {
      // Bound the browser API wait so a stalled capture always reaches cleanup.
      dataUrl = await Promise.race([
        chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 92 }),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(
            'Chrome screenshot capture timed out after 8 seconds.')), 8000);
        })
      ]);
    } catch (e) {
      error = (e && e.message) ? e.message : String(e);
    } finally {
      if (timeoutId != null) clearTimeout(timeoutId);
    }
    return {
      threw: !!error,
      error,
      dataUrl: (typeof dataUrl === 'string' && /^data:image\//.test(dataUrl)) ? dataUrl : null
    };
  }

  // Video-less platform (ChatGPT) "+ Capture": save what is currently visible
  // in the ChatGPT window as a moment. The visible tab is captured by the
  // extension (content scripts cannot call chrome.tabs.captureVisibleTab) and
  // the frame is saved EXACTLY as-is - ClipNote sidebar included. Nothing is
  // hidden, removed, cropped or re-laid-out, so the sidebar stays mounted and
  // stable and the saved image is exactly what the user sees. The moment is
  // genuinely TIMESTAMP-FREE: no video position, no duration, no seek, and no
  // captured wall-clock time. ChatGPT content = screenshot + note + conversation
  // info. Returns a capture object in the same shape "+ Capture" produces,
  // or null.
  async function captureChatgptMoment() {
    try {
      // The same one-time <all_urls> grant every page capture needs.
      if (!(await ensureCapturePermission())) {
        setStatus('Screenshot needs one-time permission \u2014 approve it in the prompt, or in the extension\u2019s details page.');
        setTimeout(() => setStatus(''), 5000);
        return null;
      }

      // Shoot OUR tab, brought to the front for captureVisibleTab.
      const ownTab = await bringOwnTabToFront();
      if (!ownTab.tab) {
        setStatus('Couldn\u2019t connect to this page. Please reload it.');
        setTimeout(() => setStatus(''), 4000);
        return null;
      }
      const tab = ownTab.tab;

      // Where does the on-page CONTENT area sit? For ChatGPT the content script
      // answers with the conversation region - an authoritative, stable
      // rectangle - so the saved image is just that region, never the whole
      // viewport and never the ClipNote sidebar. Queried BEFORE the shot,
      // against the SAME layout the frame is taken in, so the crop that follows
      // is pixel-accurate. Video platforms have no such rectangle and return
      // null here; this function is only ever used by the ChatGPT "+ Capture"
      // flow, and takeScreenshot() does NOT go through this code path.
      const shotPlan = await getScreenshotTarget();
      const planRect = resolveCaptureRect(shotPlan);

      const frame = await captureVisibleFrame(tab);
      if (frame.threw) {
        setStatus('Capture failed \u2014 check that this tab is capturable.');
        setTimeout(() => setStatus(''), 4000);
        return null;
      }
      if (!frame.dataUrl) {
        setStatus('Capture failed \u2014 the captured frame was invalid.');
        setTimeout(() => setStatus(''), 4000);
        return null;
      }
      // The bitmap must PROVE it has real pixels before anything is cropped.
      const dataUrl = frame.dataUrl;
      const probe = await probeCaptureImage(dataUrl);
      if (!probe.width || !probe.height) {
        setStatus('Capture failed \u2014 the captured frame was blank.');
        setTimeout(() => setStatus(''), 4000);
        return null;
      }

      // Crop the full viewport frame down to the ChatGPT conversation region
      // (the plan's content target). The ClipNote sidebar never appears in the
      // saved image because the conversation rectangle sits where the sidebar
      // is not. A missing rectangle keeps the full frame (defensive fallback).
      let contentUrl = dataUrl;
      if (planRect) {
        contentUrl = await cropCapturedImage(
          frame.dataUrl,
          planRect,
          planRect.viewport
        );
        if (!contentUrl) contentUrl = dataUrl;
      }

      // Snapshot the page's context at capture time so the moment remembers
      // which conversation it came from. No time is recorded anywhere: a
      // ChatGPT moment carries only the capture, the note and the conversation.
      const ctx = await getVideoContext();
      return {
        id: uuid(),
        screenshot: { type: 'data-url', dataUrl: contentUrl },
        annotation: '',
        platform: (ctx && ctx.platform) || 'chatgpt',
        videoId: (ctx && (ctx.videoId || ctx.conversationId)) || '',
        videoUrl: (ctx && ctx.videoUrl) || ''
      };
    } catch (e) {
      return null;
    }
  }

  // Fallback frame capture for a video platform whose <video> cannot be drawn
  // to a canvas. Udemy streams from a cross-origin CDN, which TAINTS the
  // canvas: drawImage() succeeds but toDataURL() throws SecurityError, so the
  // content script's drawn frame is always lost. The extension instead shoots
  // the VISIBLE tab (which composites the real, currently displayed frame no
  // matter where it came from) and crops the shot down to the video's own
  // rectangle, so the saved image is exactly the lecture frame - never the
  // browser chrome or the ClipNote sidebar. Returns a screenshot object in the
  // same shape the capture pipeline uses, or null to keep the drawn frame /
  // poster fallback.
  async function captureVisibleVideoFrame() {
    try {
      // The video rectangle is authoritative and only video platforms that opt
      // in expose it; without it this fallback stays out of the way entirely.
      const plan = await getScreenshotTarget();
      if (!plan || !plan.target) return null;
      const rect = resolveCaptureRect(plan);
      if (!rect) return null;
      // Same one-time grant every visible-tab capture needs.
      if (!(await ensureCapturePermission())) return null;
      // Shoot OUR tab, brought to the front for captureVisibleTab.
      const ownTab = await bringOwnTabToFront();
      if (!ownTab.tab) return null;
      const frame = await captureVisibleFrame(ownTab.tab);
      if (frame.threw || !frame.dataUrl) return null;
      // The bitmap must PROVE it has real pixels before anything is cropped.
      const probe = await probeCaptureImage(frame.dataUrl);
      if (!probe.width || !probe.height) return null;
      const cropped = await cropCapturedImage(frame.dataUrl, rect, rect.viewport);
      return { type: 'data-url', dataUrl: cropped || frame.dataUrl };
    } catch (e) {
      return null;
    }
  }

  // Capture helpers shared by the three webpage screenshot modes.
  async function waitForCaptureState(hidden) {
    for (let i = 0; i < 30; i++) {
      const state = await sendToContentScript({ type: 'CN_CAPTURE_STATE' });
      if (state && state.ok && state.hidden === hidden) {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
  }

  async function forceRestoreHostSidebar(tab) {
    // Last-resort visual recovery if content-script messaging stops responding.
    if (!tab || !Number.isInteger(tab.id) || !isAlive()) return false;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] },
        func: () => {
          const el = document.querySelector('#cn-sidebar-container');
          if (el) el.classList.remove('cn-capture-hidden');
        }
      });
      return true;
    } catch (e) {
      console.warn('[ClipNote] Could not force-restore the sidebar:', e);
      return false;
    }
  }

  async function setHostCaptureMode(active, tab) {
    await sendToContentScript({ type: 'CN_CAPTURE_MODE', active });
    if (active) {
      const ready = await waitForCaptureState(true);
      if (!ready) throw new Error('The ClipNote sidebar could not be hidden for capture.');
    } else {
      const restored = await waitForCaptureState(false);
      if (!restored) await forceRestoreHostSidebar(tab);
    }
  }

  function getContentCaptureRect(plan) {
    if (plan && plan.target && plan.viewport) {
      return {
        x: Math.max(0, plan.target.x),
        y: Math.max(0, plan.target.y),
        width: Math.max(0, Math.min(plan.viewport.width, plan.target.x + plan.target.width) - Math.max(0, plan.target.x)),
        height: Math.max(0, Math.min(plan.viewport.height, plan.target.y + plan.target.height) - Math.max(0, plan.target.y)),
        viewport: plan.viewport
      };
    }
    const resolved = plan ? resolveCaptureRect(plan) : null;
    if (resolved) return resolved;

    // Some platform layouts (and responsive breakpoints) do not expose a
    // stable content rectangle. The sidebar is hidden before pixels are taken,
    // so a full viewport is the safe, deterministic fallback rather than
    // failing every screenshot on pages without a measurable rail/target.
    if (plan && plan.viewport && plan.viewport.width > 1 && plan.viewport.height > 1) {
      return {
        x: 0,
        y: 0,
        width: plan.viewport.width,
        height: plan.viewport.height,
        viewport: plan.viewport
      };
    }
    return null;
  }

  async function captureContentFrame(tab, plan) {
    if (!plan || !plan.viewport) throw new Error('Could not read the webpage viewport.');
    await setHostCaptureMode(true, tab);
    try {
      const frame = await captureVisibleFrame(tab);
      if (frame.threw || !frame.dataUrl) {
        const detail = frame.error ? ` Chrome reported: ${frame.error}` : '';
        throw new Error(`Could not capture the webpage viewport.${detail}`);
      }
      const probe = await probeCaptureImage(frame.dataUrl);
      if (!probe.width || !probe.height) throw new Error('The webpage screenshot was blank.');
      const rect = getContentCaptureRect(plan);
      if (!rect) throw new Error('Could not determine the webpage area to capture.');
      const image = await cropCapturedImage(frame.dataUrl, rect, rect.viewport);
      if (!image) throw new Error('Could not crop the webpage area.');
      return { dataUrl: image, rect };
    } finally {
      await setHostCaptureMode(false, tab);
    }
  }

  async function saveScreenshotMoment(dataUrl, targetNoteId, platform) {
    const probe = await probeCaptureImage(dataUrl);
    if (!probe.width || !probe.height) throw new Error('The screenshot image was invalid.');
    const cap = {
      id: uuid(),
      screenshot: { type: 'data-url', dataUrl },
      annotation: '',
      platform: platform || 'universal',
      videoId: '',
      videoUrl: location.href
    };
    const added = await addCaptureToNote(cap, targetNoteId);
    if (!added) throw new Error('The note was deleted while the screenshot was being saved.');
    await saveAllNotes();
    return true;
  }

  async function captureVisiblePage(tab, plan, noteId) {
    const frame = await captureContentFrame(tab, plan);
    await saveScreenshotMoment(frame.dataUrl, noteId, plan.platform);
  }

  // Every capture hides the sidebar before taking pixels and restores it in
  // finally; browser chrome is outside captureVisibleTab's webpage viewport.
  async function takeScreenshot() {
    if (capturing) return;
    let screenshotTab = null;
    const targetNoteId = activeNoteId;
    if (!targetNoteId || !findNote(targetNoteId)) return;
    setCapturing(true);
    let added = false;
    try {
      if (!(await ensureCapturePermission())) {
        setStatus('Screenshot permission was not granted.');
        return;
      }
      const ownTab = await bringOwnTabToFront();
      if (!ownTab.tab) {
        throw new Error(ownTab.activateFailed
          ? 'Could not activate the webpage tab. Please try again.'
          : (ownTab.reason || 'Could not connect to this webpage. Reload the page and try again.'));
      }
      const tab = ownTab.tab;
      screenshotTab = tab;
      const plan = await getScreenshotTarget();
      if (!plan || !plan.viewport) {
        throw new Error('Could not read the webpage layout. Reload the page and try again.');
      }
      await captureVisiblePage(tab, plan, targetNoteId);
      added = true;
      if (added) setStatus('Screenshot saved');
    } catch (error) {
      console.error('[ClipNote] Screenshot failed:', error);
      setStatus(error && error.message ? error.message : 'Screenshot failed.');
    } finally {
      // Idempotent even if the full-page loop already restored the capture mode.
      try {
        await setHostCaptureMode(false, screenshotTab);
      } catch (_) {
        await forceRestoreHostSidebar(screenshotTab);
      }
      setCapturing(false);
    }
    if (added) {
      try { await renderMoments(); } catch (_) { /* already saved */ }
      if (activeNoteId === targetNoteId) {
        try { await scrollToLast(); } catch (_) { /* non-critical */ }
      }
    }
    setTimeout(() => setStatus(''), 3500);
  }

  // ----------------------- Views -----------------------

  // Switch to the home (list of notes) view.
  function showHomeView() {
    // Close any open moment preview first.
    closeMomentPreview();
    // Show the home view.
    viewHome.classList.remove('cn-hidden');
    // Hide the note view.
    viewNote.classList.add('cn-hidden');
    // Draw the list of notes.
    renderHome();
  }

  // Switch to the note detail view.
  function showNoteView() {
    // Hide the home view.
    viewHome.classList.add('cn-hidden');
    // Show the note view.
    viewNote.classList.remove('cn-hidden');
    // Draw the open note.
    renderActiveNote();
  }

  // ----------------------- Home view -----------------------

  // Build the list of saved notes on the home screen.
  function renderHome() {
    // Clear whatever cards were there.
    homeList.innerHTML = '';
    // Sort the notes so the newest edited comes first.
    const sorted = [...allNotes].sort((a, b) => b.updatedAt - a.updatedAt);

    // If there are no notes:
    if (sorted.length === 0) {
      // Show the "no notes" empty state.
      homeEmpty.classList.add('visible');
      // Hide the (empty) list.
      homeList.classList.add('cn-hidden');
      // The screenshots section still needs drawing.
      renderShots();
      // Stop here.
      return;
    }

    // Otherwise hide the empty state.
    homeEmpty.classList.remove('visible');
    // And show the list.
    homeList.classList.remove('cn-hidden');

    // Loop over every note to build a card for it.
    for (const note of sorted) {
      // The outer card element.
      const card = document.createElement('div');
      // Give it the card style.
      card.className = 'cn-home-card';

      // The little icon on the left of the card.
      const icon = document.createElement('div');
      // Style it as the card icon.
      icon.className = 'cn-home-card-icon';
      // Put a notebook emoji inside it.
      icon.textContent = '\uD83D\uDCDD';

      // The middle section holding title and meta text.
      const info = document.createElement('div');
      // Style the info section.
      info.className = 'cn-home-card-info';

      // The note's title element.
      const title = document.createElement('div');
      // Style it as the card title.
      title.className = 'cn-home-card-title';
      // Show the note's title, or "Untitled".
      title.textContent = note.title || 'Untitled';

      // The small subtitle element.
      const meta = document.createElement('div');
      // Style it as the card meta text.
      meta.className = 'cn-home-card-meta';
      // How many moments this note holds.
      const count = (note.moments || []).length;
      // Show "3 moments · 2h ago" style text.
      meta.textContent = `${count} moment${count !== 1 ? 's' : ''} \u00B7 ${timeAgo(note.updatedAt)}`;

      // Attach the title and meta to the info section.
      info.appendChild(title);
      info.appendChild(meta);

      // The right-hand side with the action buttons.
      const actions = document.createElement('div');
      // Style it as the actions area.
      actions.className = 'cn-home-card-actions';

      // The rename button.
      const renameBtn = document.createElement('button');
      // Style it as a small action button.
      renameBtn.className = 'cn-home-action';
      // Put a pencil icon in it.
      renameBtn.textContent = '\u270E';
      // Tooltip explaining the button.
      renameBtn.title = 'Rename';
      // When the pencil is clicked:
      renameBtn.addEventListener('click', (e) => {
        // Don't also open the note.
        e.stopPropagation();
        // Start the inline rename flow.
        startRename(card, note, title);
      });

      // The delete button.
      const deleteBtn = document.createElement('button');
      // Style it as a dangerous action button.
      deleteBtn.className = 'cn-home-action cn-danger';
      // Put a trash icon in it.
      deleteBtn.textContent = '\uD83D\uDDD1';
      // Tooltip explaining the button.
      deleteBtn.title = 'Delete note';
      // When the trash is clicked:
      deleteBtn.addEventListener('click', (e) => {
        // Don't also open the note.
        e.stopPropagation();
        // Permanently remove the note.
        deleteEntireNote(note.id);
      });

      // Put the rename and delete buttons in the actions area.
      actions.appendChild(renameBtn);
      actions.appendChild(deleteBtn);

      // Assemble the card: icon, info, actions.
      card.appendChild(icon);
      card.appendChild(info);
      card.appendChild(actions);
      // Clicking anywhere on the card opens the note.
      card.addEventListener('click', () => openNote(note.id));
      // Add the finished card to the list.
      homeList.appendChild(card);
    }
    // Draw the manual screenshots section above the notes.
    renderShots();
  }

  // ----------------------------------------------------------------

  // One in-flight screenshot resolution per manual shot. The thumbnail and the
  // click-through preview share the SAME load, so a double render never decodes
  // the image twice - and the click-through works even before the (async)
  // thumbnail has finished loading (BUG 6).
  const shotLoads = new Map();

  // Resolve a manual shot's image (IndexedDB cache, else the folder file),
  // memoizing the promise per shot so concurrent callers share one load.
  async function ensureShotScreenshot(shot) {
    if (shot && shot.screenshot &&
        (shot.screenshot.type === 'data-url' || shot.screenshot.type === 'blob-url')) {
      return shot.screenshot;
    }
    if (shotLoads.has(shot.id)) return shotLoads.get(shot.id);
    const load = (async () => {
      // The cached image in IndexedDB (fastest path).
      const cached = await idbGet(manualShotKey(shot.id));
      // Its inline data URL, else a displayable file preview.
      const src = (cached && cached.dataUrl) ||
        (shot && shot.relativePath ? await ls.readBlobUrl(shot.relativePath) : '');
      if (!src) return null;
      // Rehydrate the screenshot descriptor on the in-memory shot (it is
      // stripped when the index is saved to storage).
      shot.screenshot = src.startsWith('data:')
        ? { type: 'data-url', dataUrl: src }
        : { type: 'blob-url', url: src };
      return shot.screenshot;
    })();
    shotLoads.set(shot.id, load);
    try {
      return await load;
    } finally {
      shotLoads.delete(shot.id);
    }
  }

  // Open the full-size preview of a manual screenshot, loading its image on
  // demand when the thumbnail has not finished resolving yet.
  async function openShotPreview(shot) {
    // Tell the user we're working while the image decodes.
    setStatus('Loading screenshot...');
    const s = await ensureShotScreenshot(shot);
    if (!s) {
      // No cached copy and no folder file: there is nothing to preview.
      setStatus('Screenshot unavailable \u2014 no image was saved for it.');
      setTimeout(() => setStatus(''), 4000);
      return;
    }
    setStatus('');
    // Pass the SHOT itself (with its relativePath), so the preview resolves the
    // folder file the same way a moment preview does - never a stale blob URL.
    openMomentPreview(shot);
  }

  // ----------------------------------------------------------------

  // Build the list of manual webpage screenshots on the home screen.
  function renderShots() {
    // Hide the whole section when there are no screenshots yet.
    if (!manualShots.length) {
      shotsSection.classList.add('cn-hidden');
      return;
    }
    // Show it and update the count.
    shotsSection.classList.remove('cn-hidden');
    shotCount.textContent = String(manualShots.length);
    // Clear whatever cards were there.
    shotList.innerHTML = '';
    // Sort so the newest screenshot comes first.
    const sorted = [...manualShots].sort((a, b) => b.createdAt - a.createdAt);

    // Loop over every screenshot to build a card for it.
    for (const shot of sorted) {
      // The outer card element.
      const card = document.createElement('div');
      // Give it the card style.
      card.className = 'cn-shot-card';

      // The small thumbnail.
      const thumb = document.createElement('img');
      // Style it as the card thumbnail.
      thumb.className = 'cn-shot-thumb';
      thumb.alt = '';
      // Load the image lazily from IndexedDB, or the folder if it's there.
      (async () => {
        const s = await ensureShotScreenshot(shot);
        // Set it only when we found something.
        if (s) {
          thumb.src = s.type === 'data-url' ? s.dataUrl : s.url;
        } else {
          thumb.classList.add('cn-shot-missing');
        }
      })();

      // The middle section holding the meta text.
      const info = document.createElement('div');
      // Style the info section.
      info.className = 'cn-shot-info';

      // The timestamp line, e.g. "YouTube \u00B7 Sep 17, 2026, 2:31 PM".
      const meta = document.createElement('div');
      // Style it as the card meta text.
      meta.className = 'cn-shot-meta';
      // The platform label.
      let platformLabel = 'YouTube';
      if (shot.platform === 'udemy') platformLabel = 'Udemy';
      else if (shot.platform === 'chatgpt') platformLabel = 'ChatGPT';
      // The capture date, trimmed of seconds. ChatGPT shots are timestamp-free
      // content, so their card shows the DATE only (no time-of-day); video
      // platform shots keep the full wall-clock capture date.
      const when = shot.createdAt
        ? new Date(shot.createdAt).toLocaleString(undefined, shot.platform === 'chatgpt'
          ? { month: 'short', day: 'numeric', year: 'numeric' }
          : { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric' })
        : '';
      // A save-state hint when the folder write didn't happen.
      if (shot.saveState && shot.saveState !== 'saved' && shot.saveState !== 'pending') {
        meta.textContent = `${platformLabel} \u00B7 ${when} \u00B7 \u26A0 unsaved`;
      } else {
        meta.textContent = `${platformLabel} \u00B7 ${when}`;
      }
      info.appendChild(meta);

      // The delete button.
      const deleteBtn = document.createElement('button');
      // Style it as a dangerous action button.
      deleteBtn.className = 'cn-shot-delete';
      // Put a trash icon in it.
      deleteBtn.textContent = '\uD83D\uDDD1';
      // Tooltip explaining the button.
      deleteBtn.title = 'Delete screenshot';
      // When the trash is clicked:
      deleteBtn.addEventListener('click', (e) => {
        // Don't also open the preview.
        e.stopPropagation();
        // Permanently remove the screenshot.
        deleteShot(shot);
      });

      // Assemble the card: thumb, info, delete.
      card.appendChild(thumb);
      card.appendChild(info);
      card.appendChild(deleteBtn);
      // Clicking the card opens the full-size preview (loading the image on demand).
      card.addEventListener('click', () => openShotPreview(shot));
      // Add the finished card to the list.
      shotList.appendChild(card);
    }
    // Keep the manual-shots blob URLs alive for this view: never let the next
    // renderMoments-sweep revoke a thumbnail the home screen still displays.
    markVisibleBlobUrls(sorted.map((s) => s.relativePath || '').filter(Boolean));
  }

  // Remove a manual screenshot: IndexedDB image, folder file, and index.
  async function deleteShot(shot) {
    // Delete the cached image from IndexedDB.
    await idbDelete(manualShotKey(shot.id));
    // Delete the file from the folder too (best effort), releasing any cached
    // preview object URL first so it never leaks (BUG 7).
    let fsError = false;
    if (shot.relativePath) {
      ls.revokeBlobUrl(shot.relativePath);
      const ok = await ls.deleteScreenshotFile(shot.relativePath);
      fsError = !ok;
    }
    // Keep every shot except the one being deleted.
    manualShots = manualShots.filter((s) => s.id !== shot.id);
    // Save the trimmed index.
    await storage.set({ [SHOTS_KEY]: stripShotData(manualShots) });
    // Mirror the trimmed list into the shared on-disk index (best effort) so
    // the other installation stops seeing the deleted shot too.
    await ls.saveManualShotsIndex(manualShots);
    // Redraw the section.
    renderShots();
    // Surface a folder-save failure (BUG 4) instead of hiding it.
    if (fsError) {
      setStatus('Screenshot removed; the file could not be deleted from the folder.');
      setTimeout(() => setStatus(''), 4000);
    }
  }

  // Swap the note title for a text box so the user can rename it.
  function startRename(card, note, titleEl) {
    // Create an input box.
    const input = document.createElement('input');
    // Make the field programmatically addressable: a unique id (one per note,
    // never shared across cards) + a stable name, so any label[for]/form
    // association can point at it and the a11y "id or name" rule is satisfied.
    input.id = 'cn-note-title-' + note.id;
    input.name = 'cn-note-title';
    // Give the field an accessible name WITHOUT adding visible UI: the rename
    // replaces the title text, so a floating label would be redundant chrome.
    // aria-label is the minimal, non-visual way to name it.
    input.setAttribute('aria-label', 'Note title');
    // Style it like an inline rename field.
    input.className = 'cn-rename-input';
    // Pre-fill it with the current title.
    input.value = note.title || '';
    // Show a hint if it's empty.
    input.placeholder = 'Note title...';
    // Replace the title text with this input.
    titleEl.replaceWith(input);
    // Put the cursor inside the input.
    input.focus();
    // Select the whole title so typing replaces it.
    input.select();

    // What happens when the rename is finished:
    const save = async () => {
      // Use the typed text, or "Untitled" if it's blank.
      note.title = input.value.trim() || 'Untitled';
      // Refresh the "last edited" time.
      note.updatedAt = Date.now();
      // Persist the change.
      await saveAllNotes();
      // Stamp the new title into the note's sidecar so a future reinstall
      // recovers the renamed title from the filesystem alone (best effort).
      await ls.saveNoteSidecar(note);
      // Build a fresh title element.
      const newTitleEl = document.createElement('div');
      // Keep the card title style.
      newTitleEl.className = 'cn-home-card-title';
      // Show the new title text.
      newTitleEl.textContent = note.title;
      // Put the title element back in place of the input.
      input.replaceWith(newTitleEl);
    };

    // Saving happens when the input loses focus.
    input.addEventListener('blur', save);
    // Also handle keys while typing:
    input.addEventListener('keydown', (e) => {
      // Enter saves the rename.
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      // Escape cancels and keeps the old title.
      if (e.key === 'Escape') { input.value = note.title || ''; input.blur(); }
    });
  }

  // Remove a note and all of its screenshots permanently.
  async function deleteEntireNote(noteId) {
    // Tombstone FIRST, synchronously: from this instant no capture or in-flight
    // background save may write for this note, and no future render can ever
    // re-create its folder. Only THEN wait for already-running writes to settle
    // so the filesystem deletion below can never race them (BUG 3).
    tombstonedNotes.add(noteId);
    const pending = Array.from(pendingWrites.entries())
      .filter(([k]) => k.startsWith(noteId + '::'))
      .map(([, p]) => p);
    if (pending.length) await Promise.allSettled(pending);

    // Look up the note.
    const note = findNote(noteId);
    // If it exists:
    if (note) {
      // Delete the note's files from the folder (moment files, then the empty
      // per-note folder). Legacy shared folders are never touched.
      let fsReport = { filesDeleted: 0 };
      try {
        fsReport = await ls.deleteNoteFilesystem(note);
      } catch (e) {
        // A folder problem must not stop the note from being removed in-app.
        fsReport = { filesDeleted: 0, errors: [e && e.message ? String(e.message) : 'storage error'] };
      }
      // Go through each of its moments.
      for (const m of (note.moments || [])) {
        // Delete that moment's screenshot from IndexedDB.
        await idbDelete(shotKey(noteId, m.id));
        // Tombstone the moment too (idempotent for any late persist call).
        tombstonesMoments.add(shotKey(noteId, m.id));
      }
      // Surface filesystem trouble to the user without failing the delete. The
      // note is gone in-app either way, but the user MUST be told when its
      // folder could not be fully removed (a folder is only left behind when
      // it still contains files, or the removal itself failed), or when the
      // note folder went but an enclosing Course/Video folder did not.
      if (fsReport.errors && fsReport.errors.length) {
        const noteFolderGone = fsReport.folderDeleted === true;
        const courseFolderGone = fsReport.courseFolderDeleted === true;
        if (!noteFolderGone) {
          setStatus(`Note deleted; ${fsReport.filesDeleted} file(s) removed, but its folder could not be fully removed. Check Storage > Rebuild Library.`);
        } else if (!courseFolderGone) {
          setStatus(`Note deleted; its files and folder removed, but an enclosing folder could not be removed. Check the screenshot folder.`);
        } else {
          setStatus(`Note deleted; ${fsReport.filesDeleted} file(s) removed from the folder.`);
        }
      }
    }
    // Keep every note except the one being deleted.
    allNotes = allNotes.filter((n) => n.id !== noteId);
    // Save the trimmed list.
    await saveAllNotes();
    // If this note was the one open:
    if (activeNoteId === noteId) {
      // Forget the active note.
      activeNoteId = null;
      // Clear the stored active id.
      await storage.set({ [ACTIVE_KEY]: null });
      // Go back to the home screen.
      showHomeView();
    } else {
      // Otherwise just redraw the list.
      renderHome();
    }
  }

  // ----------------------- Note detail view -----------------------

  // Serializes openNote so rapid A→B→C clicks can never interleave. Each call
  // gets a monotonic version; work runs strictly in order and any call that was
  // superseded by a newer one while awaiting aborts, so the final visible note
  // and the stored ACTIVE_KEY are always the LAST one clicked - never a stale
  // note with a mismatched active id.
  let openNoteVersion = 0;
  let openNoteChain = null;

  // Open a specific note and show its moments.
  async function openNote(noteId) {
    openNoteVersion += 1;
    const version = openNoteVersion;
    const run = async () => {
      // A newer openNote() superseded this one while it waited in the chain.
      if (version < openNoteVersion) return;
      // Save the current note first if one is open.
      if (activeNoteId) {
        await saveAllNotes();
        // The save is done, but an even newer click may have arrived meanwhile.
        if (version < openNoteVersion) return;
      }
      // Set the new active note id.
      activeNoteId = noteId;
      // Remember it so it reopens next time.
      await storage.set({ [ACTIVE_KEY]: noteId });
      // Show the note view.
      showNoteView();
    };
    // Chain: each call runs after the previous one settles, never concurrently.
    openNoteChain = Promise.resolve(openNoteChain).then(run, run);
    return openNoteChain;
  }

  // Paint the header and moments for the open note.
  function renderActiveNote() {
    // Get the open note.
    const note = getActiveNote();
    // If it's somehow missing:
    if (!note) {
      // Fall back to the home view.
      showHomeView();
      // Stop here.
      return;
    }
    // Show the note's title in the header.
    noteTitleDisplay.textContent = note.title || 'Untitled';
    // The video title stored with the note.
    let videoTitle = note.video?.title || '';
    // Udemy notes show the course and lecture instead of just one title.
    if (note.platform === 'udemy' && note.course && note.course.title) {
      // Combine e.g. "The Complete Course · Lecture 1".
      videoTitle = note.lecture && note.lecture.title
        ? `${note.course.title} · ${note.lecture.title}`
        : note.course.title;
    }
    // Show the video title under the note title.
    noteVideoInfo.textContent = videoTitle;
    // Hide that line if there is no video title.
    noteVideoInfo.classList.toggle('cn-hidden', !videoTitle);
    // Draw all the moment cards.
    renderMoments();
  }

  // Build the list of moment cards for the open note.
  // Resolve a displayable image for a moment AT RENDER TIME. The filesystem
  // path is the cross-install authority; the in-memory screenshot reference
  // (data/blob/remote) is only consulted when no file is reachable, and a
  // stale blob URL is re-read from the path on demand (Fix: a moment whose
  // object URL was swept or revoked always gets a working replacement, and a
  // rebuilt note without any screenshot reference resolves lazily from disk).
  // Returns { src, blobPath } or null - the caller then renders an explicit
  // placeholder instead of a broken <img>.
  async function resolveMomentScreenshot(moment) {
    // The path into the shared folder, when the moment has one.
    const path = (moment && moment.relativePath) || '';
    // A recorded file always wins: re-read it when no live URL exists yet.
    if (path) {
      // Reuse the current object URL when it is still in the registry.
      let url = (ls.safeGetBlobUrl && ls.safeGetBlobUrl(path)) || null;
      // Otherwise read the file and mint a fresh object URL for it.
      if (!url) url = await ls.readBlobUrl(path);
      if (url) {
        // Keep the moment's cache in step with the working URL.
        moment.screenshot = { type: 'blob-url', url };
        return { src: url, blobPath: path };
      }
      // The file is unreachable: fall through to any cached inline/remote data
      // (the "file missing"/"no folder" warnings explain the gap to the user).
    }
    // The cached screenshot reference (never a broken blob URL: the registry
    // check above already failed).
    const s = moment && moment.screenshot;
    if (s && s.type === 'data-url' && s.dataUrl) return { src: s.dataUrl, blobPath: '' };
    if (s && s.type === 'remote-url' && s.url) return { src: s.url, blobPath: '' };
    // Nothing renderable: an explicit "no image" placeholder is shown instead.
    return null;
  }

  // Tell the blob-URL registry which relative paths are on screen right now,
  // then sweep everything else. This keeps memory bounded WITHOUT ever
  // revoking a URL a live <img> points at (Fix: cache eviction no longer
  // breaks visible screenshots).
  function markVisibleBlobUrls(paths) {
    if (!ls.markBlobUrlsInUse || !ls.sweepBlobUrls) return;
    ls.markBlobUrlsInUse(paths);
    ls.sweepBlobUrls();
  }

  // Bumped on every render pass; a pass that discovers it has been superseded
  // stops before touching the DOM (keeps async resolutions from interleaving).
  let renderGeneration = 0;

  async function renderMoments() {
    // Claim this pass.
    const gen = ++renderGeneration;
    // Get the open note.
    const note = getActiveNote();
    // Clear the list of cards.
    momentsList.innerHTML = '';

    // If there are no moments:
    if (!note || !note.moments || note.moments.length === 0) {
      // Clear the counter.
      momentCount.textContent = '';
      // Show the "no moments" empty state.
      noMoments.classList.add('visible');
      // Hide the empty list.
      momentsList.classList.add('cn-hidden');
      // Nothing is visible: release every cached object URL.
      markVisibleBlobUrls([]);
      // Stop here.
      return;
    }

    // Otherwise hide the empty state.
    noMoments.classList.remove('visible');
    // And show the list.
    momentsList.classList.remove('cn-hidden');
    // Show how many moments there are.
    momentCount.textContent = String(note.moments.length);

    // Render in display order (saved sortOrder, oldest/missing last) so the
    // on-screen order always matches the stored order - after a rebuild or a
    // recovery the array order may not carry the user's chosen ordering.
    const ordered = momentsInDisplayOrder(note.moments);

    // Resolve every visible image in parallel (files are read once, cached by
    // the registry for later passes) BEFORE any DOM work.
    const resolved = await Promise.all(
      ordered.map((m) => resolveMomentScreenshot(m).catch(() => null))
    );
    // A newer render superseded this one: leave the DOM to the winner.
    if (gen !== renderGeneration) return;
    // Resolutions keyed by moment id for the card loop below.
    const resById = new Map(ordered.map((m, i) => [m.id, resolved[i]]));

    // Loop over every moment to build a card.
    for (const moment of ordered) {
      // The outer card element.
      const card = document.createElement('div');
      // Give it the note card style.
      card.className = 'cn-note-card';
      // Remember which moment this card belongs to.
      card.dataset.momentId = moment.id;

      // The drag handle on the left edge of the card.
      const handle = document.createElement('div');
      // Give it the drag handle style.
      handle.className = 'cn-drag-handle';
      // The vertical grip glyph.
      handle.textContent = '⋮⋮';
      // Tooltip explaining the action.
      handle.title = 'Drag to reorder moment';
      // Accessible name for screen readers.
      handle.setAttribute('aria-label', 'Drag to reorder moment');

      // The thumbnail container.
      const thumb = document.createElement('div');
      // Style it as the thumbnail area.
      thumb.className = 'cn-note-thumb';
      // The resolved image for this moment (null when genuinely unavailable).
      const res = resById.get(moment.id);
      if (res && res.src) {
        // A real image: create the element only now, so a src is ALWAYS set
        // (a bare srcless <img> would render as a broken icon).
        const img = document.createElement('img');
        // No alt text (decorative image).
        img.alt = '';
        // The displayable source (inline, remote, or a live object URL).
        img.src = res.src;
        // Put the image in the thumbnail box.
        thumb.appendChild(img);
        // Make the thumbnail look clickable.
        thumb.classList.add('cn-note-thumb-clickable');
        // Tooltip explaining the action.
        thumb.title = 'View full image';
        // When clicked, show the ClipNote preview.
        thumb.addEventListener('click', () => openMomentPreview(moment));
      } else {
        // Explicit no-image state: readable text, never a broken image glyph.
        thumb.classList.add('cn-note-thumb-empty');
        // Explain which case it is: a file that should exist but cannot be read
        // versus a moment that never captured an image.
        thumb.textContent = moment.relativePath ? 'Screenshot unavailable' : 'No image';
        // An accessible label for the placeholder.
        thumb.setAttribute('aria-label', moment.relativePath ? 'Screenshot unavailable' : 'No image');
      }

      // The right-hand content column.
      const content = document.createElement('div');
      // Style it as the card content.
      content.className = 'cn-note-content';

      // The top row holding time and delete button.
      const top = document.createElement('div');
      // Style it as the note top row.
      top.className = 'cn-note-top';

      // VIDEO PLATFORMS only (YouTube & Udemy): the clickable timestamp label.
      // ChatGPT is not a video platform, so it never shows a timestamp, seek
      // control, "Jump to timestamp" link or any fake time - a ChatGPT capture
      // simply means "what is visible on screen right now".
      if (platformHasVideo(note.platform)) {
        // The clickable timestamp label.
        const timeLink = document.createElement('span');
        // Style it as the time link.
        timeLink.className = 'cn-note-time';
        // Show the friendly time, or "Ns" as a fallback.
        timeLink.textContent = moment.humanTime || `${Math.floor(moment.timestamp)}s`;
        // Tooltip explaining the click action.
        timeLink.title = 'Jump to timestamp';
        // When clicked, use the moment's own stored video source as the authority.
        // If that video is the one currently open, preserve the in-page seek;
        // otherwise open the moment's stored URL (never the current page's URL).
        timeLink.addEventListener('click', () => {
          const url = momentWatchUrl(moment, note);
          if (!url) {
            // Legacy moment with no trustworthy URL: keep the old seek behaviour.
            seekTo(moment.timestamp);
            return;
          }
          const mine = momentVideoIdentity(moment, note);
          getVideoContext().then(async (ctx) => {
            const currentPlatform = (ctx && ctx.platform) || '';
            const currentVideoId = (ctx && (ctx.videoId || ctx.lectureId)) || '';
            const sameVideo = !!currentPlatform && !!currentVideoId &&
              currentPlatform === mine.platform && currentVideoId === mine.videoId;
            if (sameVideo) {
              // The moment belongs to the video on screen: seek in place.
              seekTo(moment.timestamp);
            } else {
              // A different (or unknown) video: open the moment's own URL.
              // Udemy URLs cannot carry a timestamp, so hand the newly opened
              // lecture a one-shot seek request the content script consumes
              // once the page's video is available.
              if (mine.platform === 'udemy' && mine.videoId) {
                try {
                  await storage.set({
                    [PENDING_SEEK_KEY]: {
                      platform: 'udemy',
                      lectureId: String(mine.videoId),
                      timestamp: moment.timestamp || 0,
                      createdAt: Date.now()
                    }
                  });
                } catch (e) { /* best effort; the lecture still opens */ }
              }
              window.open(url, '_blank', 'noopener,noreferrer');
            }
          });
        });
        top.appendChild(timeLink);
      }

      // The small delete button.
      const deleteBtn = document.createElement('button');
      // Style it as the delete button.
      deleteBtn.className = 'cn-note-delete';
      // Put a trash icon in it.
      deleteBtn.textContent = '\uD83D\uDDD1';
      // Tooltip explaining the button.
      deleteBtn.title = 'Delete';
      // When clicked, remove this moment.
      deleteBtn.addEventListener('click', () => deleteMoment(moment.id));

      // The save-state warning (added below) is shown under the textarea.
      // Delete button first:
      top.appendChild(deleteBtn);

      // The annotation text box.
      const textarea = document.createElement('textarea');
      // Make the field programmatically addressable: a unique id (one per
      // moment, never shared across cards) + a stable name, so any
      // label[for]/form association can point at it and the a11y "id or name"
      // rule is satisfied.
      textarea.id = 'cn-moment-annotation-' + moment.id;
      textarea.name = 'cn-moment-annotation';
      // Give the field an accessible name WITHOUT adding visible UI: the
      // placeholder already tells the user what the box is for, but a
      // placeholder is NOT a substitute for an accessible name - aria-label is
      // the minimal, non-visual way to name it.
      textarea.setAttribute('aria-label', 'Moment annotation');
      // Style it as the note textarea.
      textarea.className = 'cn-note-textarea';
      // Placeholder text while the box is empty.
      textarea.placeholder = 'Add a note...';
      // Pre-fill it with any saved annotation.
      textarea.value = moment.annotation || '';

      // Timer used to debounce saving.
      let saveTimer = null;
      // When the user types:
      textarea.addEventListener('input', () => {
        // Update the moment's annotation right away.
        moment.annotation = textarea.value;
        // Refresh the moment's "last changed" time.
        moment.updatedAt = Date.now();
        // Cancel any pending save.
        clearTimeout(saveTimer);
        // Save shortly after typing pauses. The write also refreshes the note's
        // filesystem sidecar (v4) so the annotation survives a storage wipe -
        // but never for a note that has since been deleted (its folder must not
        // be recreated on disk by a stale save).
        saveTimer = setTimeout(async () => {
          if (tombstonedNotes.has(note.id)) return;
          if (!allNotes.some((n) => n.id === note.id)) return;
          await saveAllNotes();
          await ls.saveNoteSidecar(note);
        }, 400);
      });

      // The status line for folder-save problems (hidden when all is well).
      const statusRow = document.createElement('div');
      // Style it as the save status line.
      statusRow.className = 'cn-save-status';

      // A failed write shows the reason and a retry button.
      if (moment.saveState === 'failed') {
        // The warning icon and text.
        const warn = document.createElement('span');
        // Style it as the warning.
        warn.className = 'cn-warn';
        // The message text.
        warn.textContent = '\u26A0 Screenshot not saved';
        // The retry button.
        const retry = document.createElement('button');
        // Style it as a small action button.
        retry.className = 'cn-status-btn';
        // Its label.
        retry.textContent = 'Retry Save';
        // Retrying re-attempts the folder write.
        retry.addEventListener('click', () => retrySaveMoment(note.id, moment.id));
        // Add both to the status line.
        statusRow.appendChild(warn);
        statusRow.appendChild(retry);
      } else if (moment.saveState === 'remote-unsaved') {
        // A thumb/remote fallback could not be persisted to the folder (CORS or
        // a missing folder). The moment still shows its remote image, but the
        // library needs the file written to survive a storage wipe.
        const warn = document.createElement('span');
        // Style it as the warning.
        warn.className = 'cn-warn';
        // The message text.
        warn.textContent = '\u26A0 Screenshot not saved to folder';
        // The retry button.
        const retry = document.createElement('button');
        // Style it as a small action button.
        retry.className = 'cn-status-btn';
        // Its label.
        retry.textContent = 'Retry Save';
        // Retrying re-attempts the remote fetch + folder write.
        retry.addEventListener('click', () => retrySaveMoment(note.id, moment.id));
        // Add both to the status line.
        statusRow.appendChild(warn);
        statusRow.appendChild(retry);
      } else if (moment.saveState === 'unavailable') {
        // No usable folder - guide the user to Storage.
        const warn = document.createElement('span');
        // Style it as the warning.
        warn.className = 'cn-warn';
        // Explain the situation.
        warn.textContent = '\u26A0 No screenshot folder connected';
        // A button that opens the Storage page.
        const open = document.createElement('button');
        // Style it as a small action button.
        open.className = 'cn-status-btn';
        // Its label.
        open.textContent = 'Storage';
        // Open the local storage settings.
        open.addEventListener('click', () => {
          if (isAlive()) chrome.tabs.create({ url: chrome.runtime.getURL('storage/storage.html') });
        });
        // Add both to the status line.
        statusRow.appendChild(warn);
        statusRow.appendChild(open);
      }
      // Put the status line (even when empty) after the textarea.
      // Assemble the content column.
      content.appendChild(top);
      content.appendChild(textarea);
      content.appendChild(statusRow);
      // Assemble the card: handle, thumbnail, then content.
      card.appendChild(handle);
      card.appendChild(thumb);
      card.appendChild(content);
      // Add the finished card to the list.
      momentsList.appendChild(card);

      // How long a checked-on-disk result is trusted before re-checking (ms).
      const FILE_CHECK_TTL = 30 * 1000;
      // Add (or remove) the "file missing" warning on a fresh status row.
      function paintMissingWarn(row, moment) {
        // The status line may carry an existing warning: sweep it first.
        row.querySelectorAll('[data-cn-missing]').forEach((w) => w.remove());
        if (moment.fileMissing) {
          // A small warning that the screenshot is gone.
          const missing = document.createElement('span');
          // Style it as the warning and tag it for the sweep above.
          missing.className = 'cn-warn';
          missing.dataset.cnMissing = 'true';
          // The message text.
          missing.textContent = '\u26A0 Screenshot file missing';
          // Add it to the status line.
          row.appendChild(missing);
        }
        return row;
      }
      // Paint the initial disk-missing warning on a freshly built card.
      paintMissingWarn(statusRow, moment);

      // Check the file still exists on disk for moments that point into the
      // folder - but only when the last check is stale (30s TTL). Result is
      // cached on the moment and the live card is patched in place so a file
      // that reappears later (e.g. rescan, re-download) also clears the
      // warning instead of being stuck on "missing" forever (BUG 14).
      if (moment.relativePath &&
          (!moment._fileCheckedAt || Date.now() - moment._fileCheckedAt > FILE_CHECK_TTL)) {
        // Stamp the check time UP FRONT so concurrent renders don't double-check.
        moment._fileCheckedAt = Date.now();
        // Check asynchronously so the list isn't blocked.
        ls.fileExists(moment.relativePath).then((exists) => {
          // Drop the "missing" flag when the file is back, stamp it when gone.
          moment.fileMissing = !exists;
          // Find the card in the *live* list (it may have re-rendered).
          const liveCard = momentsList.querySelector(`.cn-note-card[data-moment-id="${moment.id}"]`);
          // If the card is gone, there's nothing to patch.
          if (!liveCard) return;
          // Find its status line.
          const row = liveCard.querySelector('.cn-save-status');
          // Skip if the status row vanished too.
          if (!row) return;
          // Re-paint the warning to match the fresh result.
          paintMissingWarn(row, moment);
        }).catch(() => { /* ignore */ });
      }
    }

    // Release every object URL that is no longer visible (keeps the cache
    // bounded; live thumbnails are never revoked).
    markVisibleBlobUrls(
      ordered.map((m) => (resById.get(m.id) || {}).blobPath).filter(Boolean)
    );
  }

  // ---------------- Moment image preview ----------------

  // The overlay element currently showing a full-size moment image (null when closed).
  let previewOverlay = null;

  // Open a full-size preview of a moment's screenshot inside the sidebar.
  // This keeps the click inside the ClipNote iframe instead of letting it
  // fall through to the host page. The image is resolved lazily (the folder
  // file wins, exactly like the thumbnail render), so a preview never opens
  // with a stale or revoked object URL.
  function openMomentPreview(moment) {
    if (!moment) return;
    // Close any preview that is already open.
    closeMomentPreview();
    // Resolve the displayable source now (async; may hit the filesystem).
    resolveMomentScreenshot(moment).then((res) => {
      // A preview may have been closed (or re-opened) while resolving.
      if (previewOverlay) return;
      // No source means there is nothing to preview.
      const src = (res && res.src) || '';
      if (!src) return;

      // The dimmed overlay that fills the sidebar iframe.
      previewOverlay = document.createElement('div');
      // Style it as the preview overlay.
      previewOverlay.className = 'cn-preview-overlay';
      // The full-size image.
      const img = document.createElement('img');
      // Style it as the preview image.
      img.className = 'cn-preview-img';
      // Show the source image.
      img.src = src;
      // Decorative image.
      img.alt = '';
      // The close button.
      const close = document.createElement('button');
      // Style it as the close button.
      close.className = 'cn-preview-close';
      // An X glyph.
      close.textContent = '\u2715';
      // Tooltip for the button.
      close.title = 'Close';
      // Attach the image and button to the overlay.
      previewOverlay.appendChild(img);
      previewOverlay.appendChild(close);
      // Clicking the dimmed backdrop (not the image) also closes it.
      previewOverlay.addEventListener('click', (e) => {
        if (e.target === previewOverlay) closeMomentPreview();
      });
      // The X button closes it too.
      close.addEventListener('click', (e) => {
        // Stop the click reaching the backdrop handler.
        e.stopPropagation();
        closeMomentPreview();
      });
      // Closing with the Escape key.
      const onKey = (e) => { if (e.key === 'Escape') closeMomentPreview(); };
      // Remember the listener so we can remove it on close.
      previewOverlay._onKey = onKey;
      // Listen for Escape while the preview is open.
      document.addEventListener('keydown', onKey);
      // Add the overlay to the sidebar body.
      document.body.appendChild(previewOverlay);
      // Put the "focus" behind the overlay so it can't be interacted with.
      document.body.style.overflow = 'hidden';
    }).catch(() => { /* no image to show */ });
  }

  // Remove the preview overlay and its key listener.
  function closeMomentPreview() {
    // Nothing to do when there's no overlay.
    if (!previewOverlay) return;
    // Stop listening for Escape.
    document.removeEventListener('keydown', previewOverlay._onKey);
    // Restore the sidebar's scroll.
    document.body.style.overflow = '';
    // Remove the overlay from the page.
    previewOverlay.remove();
    // Forget the reference.
    previewOverlay = null;
  }

  // ---------------- Drag-and-drop reordering ----------------

  // Begin a card drag when the mouse goes down on a handle.
  function startDragReorder(evt, card) {
    // Get the open note.
    const note = getActiveNote();
    // Without a note, or fewer than two moments, there's nothing to drag.
    if (!note || !note.moments || note.moments.length < 2) return;
    // Find where this card sits in the moments array.
    const idx = note.moments.findIndex((m) => m.id === card.dataset.momentId);
    // Skip if the card is no longer part of the note.
    if (idx === -1) return;
    // Stop the browser from selecting text while dragging.
    evt.preventDefault();
    // Find this card's drag handle.
    const handle = card.querySelector('.cn-drag-handle');
    // Build the drop indicator element (a thin accent line).
    const indicator = document.createElement('div');
    indicator.className = 'cn-drop-indicator';
    // Remember everything the drag needs.
    dragReorder = {
      // The note being edited.
      note,
      // The card being dragged.
      card,
      // Where the moment starts.
      index: idx,
      // Where it will land (unchanged until the pointer moves).
      insertIndex: idx,
      // The pointer's starting Y position.
      startY: evt.clientY,
      // The pointer's current Y position.
      clientY: evt.clientY,
      // The insertion indicator line.
      indicator
    };
    // Show the dragging style on the card.
    card.classList.add('cn-dragging');
    // Add the indicator to the list.
    momentsList.appendChild(indicator);
    // Capture the pointer so moves outside the handle still work.
    try { handle.setPointerCapture(evt.pointerId); } catch (e) { /* ignore */ }
    // Track movement and release on the captured handle.
    handle.addEventListener('pointermove', moveDragReorder);
    handle.addEventListener('pointerup', endDragReorder);
    handle.addEventListener('pointercancel', cancelDragReorder);
    // Paint the first visual pass.
    updateDragReorder();
  }

  // Handle pointer movement during a drag.
  function moveDragReorder(evt) {
    // If the drag ended, do nothing.
    if (!dragReorder) return;
    // Track the pointer's current Y.
    dragReorder.clientY = evt.clientY;
    // Reposition the card and the indicator.
    updateDragReorder();
    // Kick off the auto-scroll check.
    startDragAutoScroll();
  }

  // Reposition the moving card and the insertion line.
  function updateDragReorder() {
    // Bail out if no drag is running.
    if (!dragReorder) return;
    // The vertical distance the pointer has travelled.
    const dy = dragReorder.clientY - dragReorder.startY;
    // Follow the pointer so the card visibly moves.
    dragReorder.card.style.transform = `translateY(${dy}px)`;
    // Recompute the target slot from the pointer position.
    dragReorder.insertIndex = computeInsertIndex();
    // Move the indicator line to that slot.
    placeDropIndicator(dragReorder.insertIndex);
  }

  // Decide where the dragged moment will land.
  function computeInsertIndex() {
    // The total number of moments in the note.
    const total = dragReorder.note.moments.length;
    // The current index of the dragged moment.
    const index = dragReorder.index;
    // Start with "same position".
    let insertIndex = index;
    // Walk every card from top to bottom.
    const cards = momentsList.querySelectorAll('.cn-note-card');
    // Loop over the cards.
    for (const other of cards) {
      // Ignore the card being dragged.
      if (other === dragReorder.card) continue;
      // The vertical center of this card.
      const rect = other.getBoundingClientRect();
      // The array index this card currently holds.
      const arrIndex = dragReorder.note.moments.findIndex((m) => m.id === other.dataset.momentId);
      // Skip cards that are no longer in the array.
      if (arrIndex === -1) continue;
      // This card's slot once the dragged moment is removed.
      const bIdx = arrIndex - (arrIndex > index ? 1 : 0);
      // If the pointer is above this card's middle:
      if (dragReorder.clientY < rect.top + rect.height / 2) {
        // The moment lands just before this card.
        insertIndex = bIdx;
        // The slot is decided.
        break;
      }
      // Otherwise it lands just after this card.
      insertIndex = bIdx + 1;
    }
    // Clamp the slot to a valid range.
    if (insertIndex < 0) insertIndex = 0;
    if (insertIndex > total - 1) insertIndex = total - 1;
    // Return the chosen slot.
    return insertIndex;
  }

  // Put the drop indicator line at the chosen slot.
  function placeDropIndicator(slot) {
    // The card that should follow the line.
    let reference = null;
    // Loop over every card.
    const cards = momentsList.querySelectorAll('.cn-note-card');
    // Walk the cards.
    for (const other of cards) {
      // Skip the dragged card.
      if (other === dragReorder.card) continue;
      // The array index this card currently holds.
      const arrIndex = dragReorder.note.moments.findIndex((m) => m.id === other.dataset.momentId);
      // Ignore missing cards.
      if (arrIndex === -1) continue;
      // This card's slot once the dragged moment is removed.
      const bIdx = arrIndex - (arrIndex > dragReorder.index ? 1 : 0);
      // The line goes before the first card at or past the slot.
      if (bIdx >= slot) {
        reference = other;
        break;
      }
    }
    // If there's a reference card, insert the line before it.
    if (reference) momentsList.insertBefore(dragReorder.indicator, reference);
    // Otherwise pin the line to the end of the list.
    else momentsList.appendChild(dragReorder.indicator);
  }

  // Auto-scroll the list when the pointer nears an edge.
  function startDragAutoScroll() {
    // Cancel any previous scroll tick.
    cancelAnimationFrame(dragScrollRaf);
    // The state may have ended by now.
    if (!dragReorder) return;
    // The scrollable list itself.
    const list = momentsList;
    // The visible bounds of the list.
    const bounds = list.getBoundingClientRect();
    // Direction: -1 up, +1 down, 0 none.
    let step = 0;
    // Near the top edge, scroll upward.
    if (dragReorder.clientY < bounds.top + 40) step = -12;
    // Near the bottom edge, scroll downward.
    else if (dragReorder.clientY > bounds.bottom - 40) step = 12;
    // If we need to scroll:
    if (step !== 0) {
      // Schedule the next scroll frame.
      dragScrollRaf = requestAnimationFrame(() => {
        // If the drag is still running:
        if (dragReorder) {
          // Move the scroll position one step.
          list.scrollTop += step;
          // Reposition the card and indicator for the new scroll.
          updateDragReorder();
          // Keep scrolling on the next frame.
          startDragAutoScroll();
        }
      });
    }
  }

  // Finish the drag and apply the new order.
  function endDragReorder() {
    // Snapshot the drag state before it is cleaned up.
    const state = dragReorder;
    // If nothing is being dragged, do nothing.
    if (!state) return;
    // Remove the dragging visuals.
    cleanupDragReorder();
    // If the position didn't change, keep the array as-is.
    if (state.index === state.insertIndex) return;
    // Take the moment out of the array.
    const [moved] = state.note.moments.splice(state.index, 1);
    // Put it back at its new slot.
    state.note.moments.splice(state.insertIndex, 0, moved);
    // Refresh the "last edited" time.
    state.note.updatedAt = Date.now();
    // Reflect the new positions in the sort orders (the files keep their
    // names - only the metadata order changes).
    refreshSortOrders(state.note);
    // Read every card's position before reordering.
    const cards = Array.from(momentsList.querySelectorAll('.cn-note-card'));
    // Map each card to its starting rect.
    const firstRects = new Map(cards.map((c) => [c, c.getBoundingClientRect()]));
    // Reorder the DOM so cards match the new array order.
    const byId = new Map(cards.map((c) => [c.dataset.momentId, c]));
    for (const mom of state.note.moments) momentsList.appendChild(byId.get(mom.id));
    // Animate each card into its final spot.
    animateCardsIntoPlace(cards, firstRects);
    // Persist the new order (only metadata changes, not the files), and mirror
    // it into the note's filesystem sidecar so a storage wipe + rebuild keeps
    // the reorder (the sidecar records sortOrder).
    saveAllNotes().then(() => ls.saveNoteSidecar(state.note));
  }

  // Smoothly move cards into their final positions after a drop.
  function animateCardsIntoPlace(cards, firstRects) {
    // Stamp the old positions onto each card as a transform.
    for (const c of cards) {
      // How far this card moved.
      const dy = firstRects.get(c).top - c.getBoundingClientRect().top;
      // If it moved at all, hold it visually in place.
      if (dy) c.style.transform = `translateY(${dy}px)`;
    }
    // Wait a frame so the brand-new positions are laid out.
    requestAnimationFrame(() => {
      // Wait a second frame so the hold-transform is visible.
      requestAnimationFrame(() => {
        // Animate every card back to its natural spot.
        for (const c of cards) {
          c.style.transition = 'transform 180ms ease';
          c.style.transform = '';
        }
        // Clear the transition once the animation is done.
        setTimeout(() => {
          for (const c of cards) c.style.transition = '';
        }, 220);
      });
    });
  }

  // Cancel the drag without changing anything.
  function cancelDragReorder() {
    // Just tear down the visuals.
    cleanupDragReorder();
  }

  // Tear down the visual drag state.
  function cleanupDragReorder() {
    // Stop any running auto-scroll.
    cancelAnimationFrame(dragScrollRaf);
    // Reset the scroll frame id.
    dragScrollRaf = 0;
    // If no drag is active, nothing left to clean.
    if (!dragReorder) return;
    // Remove the dragging style from the card.
    dragReorder.card.classList.remove('cn-dragging');
    // Clear the follow-the-pointer transform.
    dragReorder.card.style.transform = '';
    // Remove the drop indicator from the list.
    dragReorder.indicator.remove();
    // Detach the drag listeners from the handle.
    const handle = dragReorder.card.querySelector('.cn-drag-handle');
    handle.removeEventListener('pointermove', moveDragReorder);
    handle.removeEventListener('pointerup', endDragReorder);
    handle.removeEventListener('pointercancel', cancelDragReorder);
    // Forget the drag state.
    dragReorder = null;
  }

  // Remove a single moment from the open note.
  async function deleteMoment(momentId) {
    // Get the open note.
    const note = getActiveNote();
    // If there's no note, do nothing.
    if (!note) return;
    // Tombstone the moment synchronously so a background save can never write
    // it to the folder, then wait for any already-running save to settle.
    const key = shotKey(note.id, momentId);
    tombstonesMoments.add(key);
    const pending = pendingWrites.get(key);
    if (pending) {
      try { await pending; } catch (e) { /* ignore */ }
    }
    pendingWrites.delete(key);

    // Find the moment being deleted.
    const removed = (note.moments || []).find((m) => m.id === momentId);
    // Keep every moment except the deleted one.
    note.moments = note.moments.filter((m) => m.id !== momentId);
    // Refresh the "last edited" time.
    note.updatedAt = Date.now();
    // Reflect the new positions in the sort orders.
    refreshSortOrders(note);
    // Delete the screenshot from IndexedDB.
    await idbDelete(shotKey(note.id, momentId));
    // Remove the file from the folder too (best effort).
    let fsError = false;
    if (removed && removed.relativePath) {
      // Release any cached preview URL for it.
      ls.revokeBlobUrl(removed.relativePath);
      // Delete the file (a failure registers a deleted-file tombstone).
      fsError = !(await ls.deleteScreenshotFile(removed.relativePath));
    }
    // Save the change.
    await saveAllNotes();
    // When the LAST moment is removed, no empty ClipNote note folder may be
    // left on disk: delete the note's remaining owned files (sidecar etc.) and
    // its now-empty folder. The note itself stays - a later capture recreates
    // the folder. Failures bubble into the status message below.
    if (note.moments.length === 0) {
      const pruneReport = await ls.deleteNoteFilesystem(note);
      if (pruneReport.errors && pruneReport.errors.length) fsError = true;
    }
    // Redraw the list.
    renderMoments();
    // Surface a folder-save failure (BUG 4) instead of hiding it.
    if (fsError) {
      setStatus('Moment removed; the screenshot file could not be deleted from the folder.');
      setTimeout(() => setStatus(''), 4000);
    }
  }

  // ----------------------- New note -----------------------

  // True while a new note is being created (blocks double-creation).
  let creatingNote = false;

  // Create a fresh note tied to the current video.
  async function createNewNote() {
    // A rapid double-click must never create two notes.
    if (creatingNote) return;
    creatingNote = true;
    // Disable both triggers and show progress on the note-view one.
    homeNewBtn.disabled = true;
    btnNew.disabled = true;
    btnNew.textContent = 'Creating...';
    try {
      // Save the current note first if one is open.
      if (activeNoteId) await saveAllNotes();

    // Ask the content script for the video's details.
    const ctx = await getVideoContext();
    // Which site we're on (falls back to "youtube").
    const platform = (ctx && ctx.platform) || 'youtube';

    // Work out a sensible default title for the new note.
    let title = 'New Note';
    if (platform === 'youtube') {
      // YouTube: use the video title without the " - YouTube" suffix.
      title = ((ctx && ctx.videoTitle) || '').trim() || 'New Note';
    } else if (platform === 'udemy') {
      // Udemy: use the lecture title, or fall back to the course title.
      title = ((ctx && ctx.lectureTitle) || (ctx && ctx.courseTitle) || '').trim() || 'New Note';
    } else if (platform === 'chatgpt') {
      // ChatGPT: use the conversation title.
      title = ((ctx && ctx.conversationTitle) || (ctx && ctx.videoTitle) || '').trim() || 'New Note';
    }

    // Build the note object.
    const note = {
      // A unique id for it.
      id: uuid(),
      // Its display title.
      title,
      // Which site this note came from.
      platform,
      // Info about the video it belongs to.
      video: {
        // The platform's video/lecture id.
        id: (ctx && (ctx.videoId || ctx.lectureId)) || '',
        // The video/lecture title.
        title: (ctx && (ctx.videoTitle || ctx.lectureTitle)) || title,
        // The video's web address.
        url: (ctx && ctx.videoUrl) || location.href
      },
      // No captured moments yet.
      moments: [],
      // When it was created.
      createdAt: Date.now(),
      // When it was last changed.
      updatedAt: Date.now()
    };

    // Udemy notes also carry the course and lecture identities so moments
    // from different lectures are never mixed up.
    if (platform === 'udemy') {
      // The course this lecture belongs to.
      note.course = {
        // The numeric id when the page provides one, else the slug.
        id: (ctx && ctx.courseId) || '',
        // The course slug from the URL.
        slug: (ctx && ctx.courseSlug) || '',
        // The course title.
        title: (ctx && ctx.courseTitle) || ''
      };
      // The exact lecture.
      note.lecture = {
        // The lecture id from the URL.
        id: (ctx && ctx.lectureId) || '',
        // The lecture title.
        title: (ctx && ctx.lectureTitle) || ''
      };
    }

    // Add it to the notes list.
    allNotes.push(note);
    // Persist the list.
    await saveAllNotes();
    // Make it the active note.
    activeNoteId = note.id;
    // Remember it as active.
    await storage.set({ [ACTIVE_KEY]: note.id });
    // Stamp the new note's folder with a metadata sidecar (best effort) so a
    // later reinstall can restore the title from the filesystem alone.
    await ls.saveNoteSidecar(note);
    // Show the note view.
    showNoteView();
    } finally {
      // Always re-enable the triggers.
      creatingNote = false;
      homeNewBtn.disabled = false;
      btnNew.disabled = false;
      btnNew.textContent = 'New';
    }
  }

  // ----------------------- Export -----------------------

  // Print the open note as a styled PDF document.
  // Resolve once EVERY image in the printable page has loaded or failed, so the
  // print dialog never opens on a half-painted document. A hard timeout caps
  // the whole wait, so one stuck screenshot can never hold the dialog hostage.
  function waitForPrintImages(doc, timeoutMs) {
    const images = Array.from(doc.images);
    if (images.length === 0) return Promise.resolve();
    const overall = new Promise((resolve) => setTimeout(resolve, timeoutMs));
    const perImage = images.map((img) => new Promise((resolve) => {
      const settle = () => resolve();
      // A cached/already-painted image resolves instantly.
      if (img.complete && img.naturalWidth > 0) { resolve(); return; }
      img.addEventListener('load', settle, { once: true });
      img.addEventListener('error', settle, { once: true });
      if (typeof img.decode === 'function') {
        // decode() rejects on invalid data too - either way we may proceed.
        img.decode().then(settle, settle);
      }
      setTimeout(settle, timeoutMs);
    }));
    // Wait for all of them, but never longer than the overall cap.
    return Promise.race([Promise.all(perImage), overall]);
  }

  async function exportPdf() {
    // Get the open note.
    const note = getActiveNote();
    // If there's nothing to export, stop.
    if (!note || !note.moments || note.moments.length === 0) return;

    // Build the HTML for every moment, in the SAME display order the list
    // uses. Blob previews are resolved from the saved file as the blocks are
    // built, so a stored moment's screenshot is never skipped; a moment whose
    // image genuinely can't be resolved still prints its note instead of
    // silently vanishing from the PDF.
    const blocks = [];
    for (const m of momentsInDisplayOrder(note.moments)) {
      // The image HTML for this moment.
      let imgHtml = '';
      // If it has an inline screenshot, embed it.
      if (m.screenshot && m.screenshot.type === 'data-url' && m.screenshot.dataUrl) {
        imgHtml = '<img src="' + m.screenshot.dataUrl + '" />';
      } else if (m.screenshot && m.screenshot.type === 'blob-url' && m.screenshot.url) {
        // A blob preview of the file saved in the user's folder.
        imgHtml = '<img src="' + escapeHtml(m.screenshot.url) + '" />';
      } else if (m.screenshot && m.screenshot.type === 'remote-url' && m.screenshot.url) {
        // Otherwise use the remote image URL.
        imgHtml = '<img src="' + escapeHtml(m.screenshot.url) + '" />';
      } else if (m.relativePath) {
        // A stored moment whose in-memory screenshot was stripped (e.g. just
        // saved to disk): resolve a preview from the file so it still exports.
        try {
          const blobUrl = (typeof ls.readBlobUrl === 'function') ? await ls.readBlobUrl(m.relativePath) : null;
          if (blobUrl) imgHtml = '<img src="' + blobUrl + '" />';
        } catch (e) { /* fall through: the moment still prints its text */ }
      }

      // The PDF prints the annotation TEXT only - the capture timestamp is
      // intentionally NOT included for ANY platform. YouTube/Udemy timestamp
      // links and ChatGPT time are equally omitted, so every exported Moment
      // line is just the note the user wrote. Every user-provided field is
      // escaped so a note/annotation can never inject markup into the PDF.
      const annHtml = (m.annotation && m.annotation.trim())
        ? '<div class="pdf-annotation">' + escapeHtml(m.annotation) + '</div>'
        : '';

      // Combine everything into one moment block.
      blocks.push('<div class="moment">\n      <div class="moment-image">' + imgHtml + '</div>\n      <div class="moment-text">' + annHtml + '</div>\n    </div>');
    }
    const momentsHtml = blocks.join('\n');

    // The title for the document.
    const title = note.title || 'Notes';

    // The complete printable HTML page.
    const html = `<!doctype html>
<html><head><meta charset="utf-8" />
<style>
  @page { margin: 15mm; size: A4 portrait; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; color: #111; }
  .doc-title {
    text-align: center;
    padding: 40px 0 30px;
    font-size: 28px;
    font-weight: 700;
    border-bottom: 1px solid #e0e0e0;
    margin-bottom: 24px;
  }
  .moment {
    display: grid;
    grid-template-columns: 55% 1fr;
    gap: 16px;
    break-inside: avoid;
    margin-bottom: 20px;
    padding-bottom: 20px;
    border-bottom: 1px solid #e0e0e0;
  }
  .moment:last-child { border-bottom: none; }
  .moment-image img { display: block; max-width: 100%; height: auto; border: 1px solid #ddd; border-radius: 6px; }
  .moment-text { display: flex; flex-direction: column; gap: 8px; }
  .pdf-annotation { font-size: 14px; line-height: 1.6; white-space: pre-wrap; }
</style></head>
<body>
  <div class="doc-title">${escapeHtml(title)}</div>
  ${momentsHtml || '<div>No content to export.</div>'}
</body></html>`;

    // A hidden iframe to hold the printable page.
    const iframe = document.createElement('iframe');
    // Position it off-screen.
    iframe.style.position = 'absolute';
    iframe.style.top = '-9999px';
    iframe.style.left = '-9999px';
    // Add it to the document.
    document.body.appendChild(iframe);
    // Cleanup guaranteed on every path after this point.
    const removeIframe = () => {
      try { if (iframe && iframe.parentElement) document.body.removeChild(iframe); } catch (e) { /* ignore */ }
    };
    try {
      // Start writing into its document.
      const doc = iframe.contentDocument;
      if (!doc) {
        removeIframe();
        return;
      }
      doc.open();
      // Write our HTML into it.
      doc.write(html);
      // Finish the write.
      doc.close();
      // WAIT for every embedded image to be ready (data URLs, blob previews,
      // slow screenshots) instead of a blind 100ms that could open the print
      // dialog on an empty or half-painted page - and never print before the
      // URLs to those screenshots are embedded.
      await waitForPrintImages(doc, 5000);
      // Let the browser paint the now-loaded document.
      await new Promise((r) => setTimeout(r, 250));
      // Give the iframe focus.
      iframe.contentWindow.focus();
      // Open the browser's print dialog.
      iframe.contentWindow.print();
      // Removing too fast can abort a print; give the dialog a beat, then
      // always remove the iframe so no stray hidden frame accumulates.
      setTimeout(removeIframe, 1000);
    } catch (e) {
      // Make sure the iframe is cleaned up even when printing failed.
      removeIframe();
    }
  }

  // ----------------------- Events -----------------------

  // Wire up every button on the page.
  function initEvents() {
    // "+ New Note" creates a new note.
    homeNewBtn.addEventListener('click', () => createNewNote());
    // The LinkedIn link opens the profile in a new browser tab.
    linkedinLink.addEventListener('click', (e) => {
      // Never let the anchor navigate the sidebar iframe itself.
      e.preventDefault();
      // Open the profile in a new tab, never inside the sidebar.
      window.open(LINKEDIN_URL, '_blank', 'noopener,noreferrer');
    });
    // The back button saves and goes home.
    noteBackBtn.addEventListener('click', async () => {
      // Save the current note.
      await saveAllNotes();
      // Forget the active note.
      activeNoteId = null;
      // Clear the stored active id.
      await storage.set({ [ACTIVE_KEY]: null });
      // Go back to home.
      showHomeView();
    });
    // "+ Capture" captures the current frame only.
    btnCapture.addEventListener('click', () => captureMoment());
    // "Screenshot" captures a rectangle of the webpage.
    btnShot.addEventListener('click', () => takeScreenshot());
    // "Export" prints the note as a PDF.
    btnExport.addEventListener('click', exportPdf);
    // "New" also creates a new note.
    btnNew.addEventListener('click', () => createNewNote());
    // "Storage" opens the local storage settings page in a new tab.
    storageBtn.addEventListener('click', () => {
      // Open the dedicated settings page.
      if (isAlive()) chrome.tabs.create({ url: chrome.runtime.getURL('storage/storage.html') });
    });
    // "Feedback" opens the fixed Google Form in a new browser tab.
    feedbackBtn.addEventListener('click', () => {
      // Open the form in a new tab, never inside the sidebar iframe.
      window.open(FEEDBACK_URL, '_blank', 'noopener,noreferrer');
    });
    // Dragging: only a drag handle starts a card reorder.
    momentsList.addEventListener('pointerdown', (evt) => {
      // Find the drag handle the pointer landed on.
      const handle = evt.target.closest('.cn-drag-handle');
      // If it's not a handle, ignore the press.
      if (!handle) return;
      // The card that owns the handle.
      const card = handle.closest('.cn-note-card');
      // Begin dragging that card.
      startDragReorder(evt, card);
    });
  }

  // ----------------------- Init -----------------------

  // Startup: load saved data and decide which view to show.
  async function init() {
    // Connect all the buttons.
    initEvents();

    // bfcache-aware lifecycle handling. The sidebar iframe frequently gets
    // BFCACHE-restored (back/forward), and a restore keeps the blob URLs alive:
    // pagehide must NOT revoke them when e.persisted is true, or the restored
    // page renders broken thumbnails. On a genuine pagehide the browsing context
    // is really going away, so every cached object URL is released.
    window.addEventListener('pagehide', (e) => {
      // A bfcache entry is being kept: leave the object URLs for the restore.
      if (e && e.persisted) return;
      // Genuine teardown: release everything.
      if (ls && typeof ls.revokeAllBlobUrls === 'function') ls.revokeAllBlobUrls();
    });
    // Returning from bfcache: our blob URLs are intact (we skipped the revoke),
    // but re-run the current render so any on-disk changes are reflected too.
    window.addEventListener('pageshow', (e) => {
      // Only act when actually restored from the back/forward cache.
      if (!(e && e.persisted)) return;
      // Re-render whatever view is open.
      if (getActiveNote()) renderMoments();
      else showHomeView();
    });

    // React to EXTERNAL library changes (Storage page -> Rebuild Library):
    // reload the notes in place so a running sidebar stays in sync instead of
    // pretending nothing changed until its next manual reload. Our own saves
    // are skipped via the storageWriteInFlight/bootstrapping guards.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes || !changes[NOTE_KEY]) return;
      if (bootstrapping || storageWriteInFlight > 0) return;
      // reloadNotesFromStorage() is SYNCHRONOUS - it only debounces the reload
      // onto a timer and returns undefined. Chaining `.catch()` onto that used
      // to throw a TypeError on every external rebuild (the DevTools error that
      // once landed on this line); a plain guarded call keeps the UI alive.
      try { reloadNotesFromStorage(); } catch (e) { /* keep the UI alive */ }
    });

    // Carry any legacy data into the new keys FIRST, so the migration is part of
    // the data load that follows (a legacy note id can then reopen correctly
    // on first launch instead of being invisible to the fresh-load check).
    await migrateOldData();
    // Load the saved notes and screenshots.
    await loadAllNotes();
    // Load the saved manual webpage screenshots.
    await loadManualShots();
    // Bootstrapping is done: external storage changes may reload from now on.
    bootstrapping = false;

    // Tell the user when no screenshot folder is connected (captures still
    // work - the originals just can't be written out until one is set).
    try {
      // Check the current folder situation.
      const entry = await ls.getFolderEntry();
      // Only show the hint when a folder is missing or unreadable.
      if (!entry.handle || entry.permission !== 'granted') {
        // Guide the user towards the Storage page.
        setStatus('Storage: no screenshot folder connected');
      }
    } catch (e) { /* ignore */ }

    // Read the last open note's id.
    const savedActiveId = await storage.get(ACTIVE_KEY);
    // If it still exists, reopen it.
    if (savedActiveId && findNote(savedActiveId)) {
      // Make it active.
      activeNoteId = savedActiveId;
      // Show the note view.
      showNoteView();
    } else {
      // Otherwise show the home view.
      showHomeView();
    }
  }

  // Run the startup code, logging cleanly if it fails.
  init().catch((e) => console.warn('[SNT] sidebar init:', e && e.message ? e.message : e));
})();