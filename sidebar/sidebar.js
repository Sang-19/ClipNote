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

  // Save all notes to Chrome's storage (without the images).
  async function saveAllNotes() {
    // Write the notes with screenshots stripped out.
    await storage.set({ [NOTE_KEY]: stripScreenshots(allNotes) });
  }

  // Make sure every moment's sortOrder matches its position in the note.
  function refreshSortOrders(note) {
    // Walk the moments and stamp their index as the sort order.
    (note.moments || []).forEach((m, i) => { m.sortOrder = i; });
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
        } else if (!moment.screenshot || moment.screenshot.type !== 'data-url') {
          // There's no inline image to save (e.g. a remote fallback thumbnail).
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

  // Coerce a raw stored moment into a safe shape (or null when unusable).
  function sanitizeMoment(raw) {
    // A moment must at least look like an object.
    if (!raw || typeof raw !== 'object') return null;
    // Require the fields the UI depends on.
    if (typeof raw.id !== 'string' || !raw.id) return null;
    if (typeof raw.timestamp !== 'number' || !Number.isFinite(raw.timestamp) || raw.timestamp < 0) {
      raw.timestamp = 0;
    }
    if (typeof raw.humanTime !== 'string') raw.humanTime = formatTimestamp(raw.timestamp);
    if (typeof raw.annotation !== 'string') raw.annotation = '';
    return raw;
  }

  // Coerce a raw stored note into a safe shape (or null when unusable).
  function sanitizeNote(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.id !== 'string' || !raw.id) return null;
    if (typeof raw.title !== 'string') raw.title = 'Untitled';
    // Keep only moments that survive sanitization.
    const moments = Array.isArray(raw.moments)
      ? raw.moments.map(sanitizeMoment).filter(Boolean)
      : [];
    raw.moments = moments;
    return raw;
  }

  // Load all notes, then attach their images from IndexedDB.
  async function loadAllNotes() {
    // Read the stored notes.
    const data = await storage.get(NOTE_KEY);
    // Use the stored list, or an empty list if there's none.
    const rawList = (data && Array.isArray(data)) ? data : [];
    // Defensive validation: drop any malformed entries that would otherwise
    // crash the renderers or corrupt the in-memory state.
    allNotes = rawList.map(sanitizeNote).filter(Boolean);

    // Rehydrate screenshots from IndexedDB where they were stripped.
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
          // Try to load its image from IndexedDB.
          const saved = await idbGet(shotKey(note.id, moment.id));
          // If we found it, put it back on the moment.
          if (saved) moment.screenshot = saved;
          // Otherwise, if it points at a file in the folder, show that:
          else if (moment.relativePath) {
            // Build a displayable preview straight from the file.
            const url = await ls.readBlobUrl(moment.relativePath);
            // If we got a preview, use it.
            if (url) moment.screenshot = { type: 'blob-url', url };
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

  // Wait (bounded) for the host content script to feed us the page URL.
  function waitForHostUrl() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (url) => {
        if (done) return;
        done = true;
        window.removeEventListener('message', onMsg);
        resolve(url || null);
      };
      const onMsg = (e) => {
        const m = e && e.data;
        // Only accept the handshake we expect, and only from our own token.
        if (!m || m.type !== 'CN_HOST_URL') return;
        if (ownToken && m.frameToken !== ownToken) return;
        finish(typeof m.url === 'string' ? m.url : '');
      };
      window.addEventListener('message', onMsg);
      // The content script posts as soon as the iframe loads; stay bounded.
      setTimeout(() => finish(null), 1500);
    });
  }

  // Memoized accessor for the own-tab id (null when unresolvable).
  function getOwnTabId() {
    if (ownTabId != null) return Promise.resolve(ownTabId);
    if (!ownTabResolve) {
      ownTabResolve = resolveOwnTabId().then((id) => { ownTabId = id; return id; });
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
      if (!tabId) return null;
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

  // Ask the content script for the current video's details.
  async function getVideoContext() {
    // Send the context request and return its reply.
    return await sendToContentScript({ type: 'CN_GET_VIDEO_CONTEXT' });
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
      // When in the video it was captured.
      timestamp: cap.timestamp || 0,
      // The same time as friendly text.
      humanTime: cap.humanTime || formatTimestamp(cap.timestamp || 0),
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
    persistMomentScreenshot(note, moment);
    return true;
  }

  // Scroll the moments list down to the newest card.
  async function scrollToLast() {
    // The last card in the list.
    const last = momentsList.lastElementChild;
    // If one exists, scroll it smoothly into view.
    if (last) last.scrollIntoView({ behavior: 'smooth', block: 'end' });
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
    // Guard against errors while capturing.
    try {
      // Capture whatever is on screen right now.
      const cap = await captureNow();
      // If we got a capture:
      if (cap) {
        // Add it to the note that was open when the user clicked.
        const added = await addCaptureToNote(cap, targetNoteId);
        // Save the notes.
        await saveAllNotes();
        if (!added) {
          // The note was deleted while the capture was in flight.
          setStatus('The note was deleted while capturing.');
          setTimeout(() => setStatus(''), 4000);
        }
      } else {
        // Otherwise tell the user why nothing appeared.
        setStatus('Couldn\u2019t capture \u2014 no playable video found in this tab.');
        // Clear the message after a few seconds.
        setTimeout(() => setStatus(''), 4000);
      }
    } finally {
      // Always re-enable the buttons.
      setCapturing(false);
    }
    // Redraw the moments list.
    renderMoments();
    // Bring the new card into view.
    await scrollToLast();
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

  // Load the index of manual webpage screenshots from storage.
  async function loadManualShots() {
    // Read the stored index.
    const data = await storage.get(SHOTS_KEY);
    // Use the stored list, or an empty list if there's none.
    manualShots = (data && Array.isArray(data)) ? data : [];
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
  // image is in device pixels (devicePixelRatio x zoom are baked in), while
  // the selection rectangle is in CSS viewport pixels, so the scale factor is
  // capturedImagePixelWidth / hostViewportCssWidth.
  async function cropCapturedImage(dataUrl, rect, viewport) {
    // Decode the full captured image.
    const img = await loadImage(dataUrl);
    // How many image pixels cover one CSS pixel on the host page.
    const scale = (viewport && viewport.width) ? img.naturalWidth / viewport.width : 1;
    // Convert the rectangle into image coordinates, clamped to the image.
    const sx = Math.max(0, Math.round(rect.x * scale));
    const sy = Math.max(0, Math.round(rect.y * scale));
    const sw = Math.min(img.naturalWidth - sx, Math.round(rect.width * scale));
    const sh = Math.min(img.naturalHeight - sy, Math.round(rect.height * scale));
    // A zero-sized crop (shouldn't happen, but guard anyway) is "no image".
    if (sw <= 0 || sh <= 0) return null;

    // Render the selection onto a new canvas.
    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
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

  // Run the full screenshot flow: capture -> select on the frozen frame ->
  // crop -> Moment.
  // ORDER MATTERS: the visible tab is captured FIRST, before any selection
  // overlay exists, so the frozen background and the saved crop both come from
  // the exact frame the user saw when they clicked Screenshot. The selection
  // layer shown afterwards is a static copy of that capture; the live page can
  // keep animating underneath but is never visible and never part of the image.
  async function takeScreenshot() {
    // Ignore the click if a capture or selection is already running.
    if (capturing) return;
    // Resolve the target note UP FRONT (before any await: the user may switch
    // notes while the flow runs; the crop must land in the clicked note).
    const targetNoteId = activeNoteId;
    // Ignore it if there's no open note.
    if (!targetNoteId || !findNote(targetNoteId)) return;

    // Lock the capture buttons for the whole flow (blocks double-trigger).
    setCapturing(true);
    try {
      // 1) Capture the visible frame of OUR OWN tab BEFORE showing any overlay.
      //    This is the single static frame the whole screenshot flow operates
      //    on. captureVisibleTab only captures the ACTIVE tab of a window, so
      //    when this sidebar lives in a background tab it is brought to the
      //    front first - never the wrong (active) tab's page.
      const tabId = await getOwnTabId();
      if (!tabId) {
        setStatus('Couldn\u2019t connect to this page. Please reload it.');
        setTimeout(() => setStatus(''), 4000);
        return;
      }
      let tab = null;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch (e) {
        tab = null;
      }
      if (!tab) {
        setStatus('Couldn\u2019t connect to this page. Please reload it.');
        setTimeout(() => setStatus(''), 4000);
        return;
      }
      if (!tab.active) {
        try {
          // Bring our own tab to the front of its window, then re-read it.
          await chrome.tabs.update(tabId, { active: true });
          await new Promise((r) => setTimeout(r, 180));
          tab = await chrome.tabs.get(tabId);
        } catch (e) {
          tab = null;
        }
        if (!tab || !tab.active) {
          setStatus('Couldn\u2019t bring this page to the front for the screenshot.');
          setTimeout(() => setStatus(''), 4000);
          return;
        }
      }
      let dataUrl = null;
      try {
        dataUrl = await chrome.tabs.captureVisibleTab(
          tab.windowId, { format: 'jpeg', quality: 92 });
      } catch (e) {
        // captureVisibleTab threw (no permission, tab not capturable). Without
        // a real frame we refuse to enter selection mode or fake a screenshot.
        setStatus('Screenshot failed \u2014 check that this tab is capturable.');
        setTimeout(() => setStatus(''), 4000);
        return;
      }
      if (typeof dataUrl !== 'string' || !/^data:image\//.test(dataUrl)) {
        // The captured frame was invalid: abort cleanly, page stays untouched.
        setStatus('Screenshot failed \u2014 the captured frame was invalid.');
        setTimeout(() => setStatus(''), 4000);
        return;
      }

      // Keep the ORIGINAL frame for the final crop, but carry only a resized
      // copy across to the content script for the frozen selection layer so
      // the message never exceeds Chrome's size limit. The selection rectangle
      // is reported in viewport CSS pixels regardless of image resolution, so
      // cropping the original with its natural scale stays pixel-accurate.
      const originalCapture = dataUrl;
      const previewCapture = await resizeDataUrl(dataUrl, 1920, 0.82);
      if (previewCapture.length > MAX_MESSAGE_LENGTH) {
        setStatus('Screenshot too large to transfer. Try zooming out first.');
        setTimeout(() => setStatus(''), 4000);
        return;
      }

      // 2) Ask the content script to show a STATIC, frozen copy of that capture
      //    and let the user drag a rectangle over it. The message stays open
      //    until the drag completes or the user cancels.
      const selRes = await sendToContentScript({ type: 'CN_SCREENSHOT_SELECT', dataUrl: previewCapture });
      // Silent cancel (Esc) or the content script dropped the message.
      if (!selRes) {
        setStatus('Screenshot cancelled');
        setTimeout(() => setStatus(''), 2500);
        return;
      }
      // The content script refused (e.g. video not ready) - show its reason.
      if (!selRes.ok) {
        setStatus(selRes.error || selRes.cancelled ? 'Screenshot cancelled' : 'Screenshot unavailable');
        setTimeout(() => setStatus(''), 4000);
        return;
      }
      // The user cancelled the selection itself.
      if (!selRes.rect) {
        setStatus('Screenshot cancelled');
        setTimeout(() => setStatus(''), 2500);
        return;
      }

      // 3) Crop the ORIGINAL capture (from step 1) to the selected rectangle.
      const cropped = await cropCapturedImage(originalCapture, selRes.rect, selRes.rect.viewport);
      if (!cropped) {
        setStatus('Couldn\u2019t crop the screenshot.');
        setTimeout(() => setStatus(''), 4000);
        return;
      }

      // The timestamp is the video position at selection time. The content
      // script refuses to select without a playable video, so this is a real
      // reported position (never a fake 00:00). The Math.max/Number guard is
      // kept as defensive padding for malformed replies.
      const timestamp = Math.max(0, Math.floor(Number(selRes.timestamp) || 0));

      // 4) Build a capture object in the EXACT shape + Capture produces and push
      //    it through the same addCaptureToNote pipeline, so the selected region
      //    renders as a normal Moment card (thumbnail, timestamp, note field).
      const cap = {
        id: uuid(),
        timestamp,
        humanTime: selRes.humanTime || formatTimestamp(timestamp),
        screenshot: { type: 'data-url', dataUrl: cropped },
        annotation: ''
      };
      await addCaptureToNote(cap, targetNoteId);
      await saveAllNotes();

      // Tell the user it worked.
      setStatus('Screenshot saved');
      setTimeout(() => setStatus(''), 2500);
    } catch (e) {
      // Capture or crop threw (e.g. no permission, invalid rectangle). No
      // moment was created, so nothing partial is left behind.
      setStatus('Screenshot failed \u2014 check that this tab is capturable.');
      setTimeout(() => setStatus(''), 4000);
    } finally {
      // Always re-enable the buttons.
      setCapturing(false);
    }
    // Redraw the moments list so the new card is visible immediately.
    renderMoments();
    await scrollToLast();
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
    openMomentPreview({ screenshot: s });
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
      const platformLabel = shot.platform === 'udemy' ? 'Udemy' : 'YouTube';
      // The capture date, trimmed of seconds.
      const when = shot.createdAt ? new Date(shot.createdAt).toLocaleString(undefined, {
        month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric'
      }) : '';
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

  // Open a specific note and show its moments.
  async function openNote(noteId) {
    // Save the current note first if one is open.
    if (activeNoteId) await saveAllNotes();
    // Set the new active note id.
    activeNoteId = noteId;
    // Remember it so it reopens next time.
    await storage.set({ [ACTIVE_KEY]: noteId });
    // Show the note view.
    showNoteView();
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
  function renderMoments() {
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
      // Stop here.
      return;
    }

    // Otherwise hide the empty state.
    noMoments.classList.remove('visible');
    // And show the list.
    momentsList.classList.remove('cn-hidden');
    // Show how many moments there are.
    momentCount.textContent = String(note.moments.length);

    // Loop over every moment to build a card.
    for (const moment of note.moments) {
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
      // The image element inside it.
      const img = document.createElement('img');
      // No alt text (decorative image).
      img.alt = '';
      // If the moment has a screenshot:
      if (moment.screenshot) {
        // If it's an inline image, use that as the source.
        if (moment.screenshot.type === 'data-url' && moment.screenshot.dataUrl) img.src = moment.screenshot.dataUrl;
        // Otherwise use the remote image URL.
        else if (moment.screenshot.type === 'remote-url' && moment.screenshot.url) img.src = moment.screenshot.url;
        // Recovered moments point at the actual file in the folder.
        else if (moment.screenshot.type === 'blob-url' && moment.screenshot.url) img.src = moment.screenshot.url;
      }
      // Remember whether a real image ended up in the thumbnail.
      const hasImg = !!img.src;
      // Put the image in the thumbnail box.
      thumb.appendChild(img);
      // A click on a real thumbnail opens the full-size preview (a fixed
      // overlay inside the sidebar), so the click never reaches the host
      // page's own viewer/overlay.
      if (hasImg) {
        // Make the thumbnail look clickable.
        thumb.classList.add('cn-note-thumb-clickable');
        // Tooltip explaining the action.
        thumb.title = 'View full image';
        // When clicked, show the ClipNote preview.
        thumb.addEventListener('click', () => openMomentPreview(moment));
      }

      // The right-hand content column.
      const content = document.createElement('div');
      // Style it as the card content.
      content.className = 'cn-note-content';

      // The top row holding time and delete button.
      const top = document.createElement('div');
      // Style it as the note top row.
      top.className = 'cn-note-top';

      // The clickable timestamp label.
      const timeLink = document.createElement('span');
      // Style it as the time link.
      timeLink.className = 'cn-note-time';
      // Show the friendly time, or "Ns" as a fallback.
      timeLink.textContent = moment.humanTime || `${Math.floor(moment.timestamp)}s`;
      // Tooltip explaining the click action.
      timeLink.title = 'Jump to timestamp';
      // When clicked, jump the video to this time.
      timeLink.addEventListener('click', () => seekTo(moment.timestamp));

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

      // Put the time and delete button in the top row.
      top.appendChild(timeLink);

      // The save-state warning (added below) is shown under the textarea.
      // Delete button first:
      top.appendChild(deleteBtn);

      // The annotation text box.
      const textarea = document.createElement('textarea');
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
        // filesystem sidecar (v3) so the annotation survives a storage wipe -
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
  }

  // ---------------- Moment image preview ----------------

  // The overlay element currently showing a full-size moment image (null when closed).
  let previewOverlay = null;

  // Open a full-size preview of a moment's screenshot inside the sidebar.
  // This keeps the click inside the ClipNote iframe instead of letting it
  // fall through to the host page.
  function openMomentPreview(moment) {
    // Close any preview that is already open.
    closeMomentPreview();
    // The screenshot data for this moment.
    const s = moment && moment.screenshot;
    // The image source (data URL, remote URL, or folder blob URL).
    const src = s && ((s.type === 'data-url' && s.dataUrl) || s.url) || '';
    // If there's no image, there is nothing to preview.
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
    // Persist the new order (only metadata changes, not the files).
    saveAllNotes();
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
  function exportPdf() {
    // Get the open note.
    const note = getActiveNote();
    // If there's nothing to export, stop.
    if (!note || !note.moments || note.moments.length === 0) return;

    // Build the HTML for every moment.
    const momentsHtml = note.moments.map((m) => {
      // The image HTML for this moment.
      let imgHtml = '';
      // If it has an inline screenshot, embed it.
      if (m.screenshot && m.screenshot.type === 'data-url' && m.screenshot.dataUrl) {
        imgHtml = `<img src="${m.screenshot.dataUrl}" />`;
      } else if (m.screenshot && m.screenshot.type === 'remote-url' && m.screenshot.url) {
        // Otherwise use the remote image URL.
        imgHtml = `<img src="${escapeHtml(m.screenshot.url)}" />`;
      }
      // If there's no image at all, skip this moment.
      if (!imgHtml) return '';

      // The friendly time text.
      const timeStr = escapeHtml(m.humanTime || `${Math.floor(m.timestamp)}s`);
      // The annotation HTML, with or without text. Every user-provided field is
      // escaped so a note/annotation can never inject markup into the PDF.
      const annHtml = (m.annotation && m.annotation.trim())
        // With a note: show time and the note.
        ? `<div class="pdf-timestamp">${timeStr}</div><div class="pdf-annotation">${escapeHtml(m.annotation)}</div>`
        // Without a note: just the time.
        : `<div class="pdf-timestamp">${timeStr}</div>`;

      // Combine everything into one moment block.
      return `<div class="moment">
      <div class="moment-image">${imgHtml}</div>
      <div class="moment-text">${annHtml}</div>
    </div>`;
    }).join('\n');

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
  .pdf-timestamp { font-size: 13px; font-weight: 700; color: #e07a5f; }
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
    // Start writing into its document.
    iframe.contentDocument.open();
    // Write our HTML into it.
    iframe.contentDocument.write(html);
    // Finish the write.
    iframe.contentDocument.close();
    // Wait a moment for it to render:
    setTimeout(() => {
      // Guard against errors.
      try {
        // Give the iframe focus.
        iframe.contentWindow.focus();
        // Open the browser's print dialog.
        iframe.contentWindow.print();
        // Remove the iframe after printing.
        setTimeout(() => document.body.removeChild(iframe), 1000);
      } catch (e) {
        // Make sure the iframe is cleaned up.
        document.body.removeChild(iframe);
      }
    }, 100);
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
    // When the browsing context that owns these object URLs is torn down,
    // release every cached blob URL so nothing leaks for the tab's lifetime.
    window.addEventListener('pagehide', () => {
      if (ls && typeof ls.revokeAllBlobUrls === 'function') ls.revokeAllBlobUrls();
    }, { once: true });
    // Load the saved notes and screenshots.
    await loadAllNotes();
    // Load the saved manual webpage screenshots.
    await loadManualShots();
    // Carry over any data saved before the ClipNote rename.
    await migrateOldData();

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