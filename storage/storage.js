// ClipNote - Storage settings page logic
// Lets the user choose (once), reconnect, test, and manage the local
// screenshot folder, and provides scan / rebuild / migration tooling.

import * as ls from '../local-storage.js';

const $ = (id) => document.getElementById(id);

// The key the sidebar uses for its saved notes list.
const NOTE_KEY = 'clipnote_notes';
// The key the sidebar uses for its manual screenshots list.
const SHOTS_KEY = 'clipnote_manual_shots';

// Read the notes list shared with the sidebar (images are stripped there).
async function loadNotes() {
  // Ask Chrome's storage for the saved notes.
  const res = await new Promise((resolve) => {
    // Read the note list.
    chrome.storage.local.get([NOTE_KEY], (r) => resolve(r[NOTE_KEY]));
  });
  // Return the list (or an empty one when nothing is saved).
  return Array.isArray(res) ? res : [];
}

// Save the (possibly rebuilt / migrated) notes back for the sidebar.
async function saveNotes(notes) {
  // Write the list into Chrome's storage.
  return new Promise((resolve) => {
    chrome.storage.local.set({ [NOTE_KEY]: notes }, resolve);
  });
}

// Read the manual screenshots list shared with the sidebar.
async function loadManualShots() {
  const res = await new Promise((resolve) => {
    chrome.storage.local.get([SHOTS_KEY], (r) => resolve(r[SHOTS_KEY]));
  });
  return Array.isArray(res) ? res : [];
}

// Save the manual screenshots list back for the sidebar.
async function saveManualShots(shots) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [SHOTS_KEY]: shots }, resolve);
  });
}

// Small helpers for the inline status messages.
function setMsg(el, text, kind) {
  el.textContent = text || '';
  el.className = 'line-msg ' + (kind || '');
  el.classList.toggle('hidden', !text);
}

// Track the currently loaded folder entry.
let currentEntry = { handle: null, name: '', permission: 'none' };

// Paint which folder card and stats are visible.
async function render() {
  // Read the current folder state.
  currentEntry = await ls.getFolderEntry();
  // The four possible folder states.
  const cards = {
    connected: $('card-connected'),
    empty: $('card-empty'),
    permission: $('card-permission'),
    unavailable: $('card-unavailable')
  };

  // Start with every card hidden.
  for (const c of Object.values(cards)) c.classList.add('hidden');

  // The API itself may be missing.
  if (!ls.isSupported()) {
    // Show the "unavailable" card.
    cards.unavailable.classList.remove('hidden');
  } else if (!currentEntry.handle) {
    // No folder was ever chosen.
    cards.empty.classList.remove('hidden');
  } else if (currentEntry.permission === 'granted') {
    // Everything is usable.
    cards.connected.classList.remove('hidden');
    // Show the folder's display name.
    $('folder-name').textContent = '\uD83D\uDCC1 ' + currentEntry.name;
  } else if (currentEntry.permission === 'prompt') {
    // Permission just needs re-granting.
    cards.permission.classList.remove('hidden');
    // Name the folder we're asking about.
    $('permission-heading').textContent = `Folder Permission Required - ${currentEntry.name}`;
  } else {
    // Denied or otherwise broken.
    cards.unavailable.classList.remove('hidden');
  }

  // Refresh the library stats.
  await renderStats();
}

// Update the screenshot / moment / pending counters (plus the detailed
// library diagnostics classifying every file and moment).
async function renderStats() {
  // The notes shared with the sidebar.
  const notes = await loadNotes();
  // Total captured moments across every note.
  const moments = notes.reduce((n, note) => n + (note.moments || []).length, 0);
  // Moments with an inline screenshot not yet written to the folder.
  const pending = ls.countPendingToFolder(notes);
  // A detailed classification of the library against the files on disk.
  const diag = await ls.analyzeLibrary(notes);

  // Paint the three stat cards.
  $('stat-screenshots').textContent = String(diag.files.total);
  $('stat-moments').textContent = String(moments);
  $('stat-pending').textContent = String(pending);

  // The diagnostics detail (a plain preformatted block, shown when there is
  // anything worth looking at). Explains exactly where each file/moment sits.
  const diagEl = $('diag-detail');
  if (diagEl) {
    const parts = [
      `Screenshot files: ${diag.files.total} total`,
      `  ${diag.files.matched} matched to a moment`,
      `  ${diag.files.recoverable} recoverable (on disk, no matching moment)`,
      `  ${diag.files.manual} manual screenshots`,
      `  ${diag.files.duplicate} duplicates`,
      `  ${diag.files.invalid} unparseable`,
      `Moments: ${diag.moments.total} total`,
      `  ${diag.moments.withFile} screenshot on disk`,
      `  ${diag.moments.pending} screenshot only in browser (not written to the folder)`,
      `  ${diag.moments.failed} failed folder writes`,
      `  ${diag.moments.missingFile} recorded file missing on disk`,
      `  ${diag.moments.textOnly} text-only (no screenshot)`
    ];
    diagEl.textContent = parts.join('\n');
    diagEl.classList.toggle('hidden', notes.length === 0 && diag.files.total === 0);
  }

  // Offer the migration action whenever there's something to write out.
  const migrateBtn = $('btn-migrate');
  migrateBtn.classList.toggle('hidden', !(pending > 0 && currentEntry.permission === 'granted'));
  if (pending > 0 && currentEntry.permission === 'granted') {
    // Explain what the button will do.
    migrateBtn.textContent = `Move ${pending} Screenshot${pending !== 1 ? 's' : ''} to Folder`;
  }

  // When the database is empty but files exist, highlight the rebuild path.
  $('rebuild-banner').classList.toggle('hidden', !(notes.length === 0 && diag.files.total > 0));
}

// Run the folder picker (or re-request permission) then repaint.
async function chooseFolder() {
  // A "Choose / Change Folder" click is a fresh picker.
  const entry = await ls.pickFolder();
  // Remember the new state.
  currentEntry = entry;
  // Repaint everything.
  await render();
  // Tell the user it worked.
  setMsg($('test-msg'), 'Folder connected. Captures are now saved here.', 'ok');
}

// Re-establish permission on the already-stored folder.
async function reconnect() {
  // Ask the browser to re-grant access.
  const permission = await ls.reconnectFolder();
  // Repaint with the new state.
  await render();
  // Confirm the result.
  if (permission === 'granted') {
    setMsg($('test-msg'), 'Access restored. Captures are being saved here again.', 'ok');
  } else {
    setMsg($('test-msg'), 'Access was not granted.', 'err');
  }
}

// Write and clean up a probe file to prove the folder is writable.
async function testFolder() {
  // Disable the button while it runs.
  const btn = $('btn-test');
  btn.disabled = true;
  // Run the probe.
  const result = await ls.testFolder();
  // Re-enable the button.
  btn.disabled = false;
  // Show the outcome.
  setMsg($('test-msg'), result.ok ? 'Folder is working correctly.' : (result.error || 'Folder test failed.'), result.ok ? 'ok' : 'err');
}

// List the image files found inside the folder.
async function scanFolder() {
  // Tell the user we're scanning.
  setMsg($('library-msg'), 'Scanning folder...', 'info');
  // Pull every image path out of the folder.
  const paths = await ls.listImagePaths();
  // The list container.
  const list = $('scan-list');
  // Clear any previous listing.
  list.innerHTML = '';
  // Build a row per file.
  for (const p of paths) {
    // One row per file.
    const row = document.createElement('div');
    // Show its relative location.
    row.textContent = p;
    // Add it to the list.
    list.appendChild(row);
  }
  // Show or hide the list box.
  list.classList.toggle('hidden', paths.length === 0);
  // Report the tally.
  setMsg($('library-msg'), paths.length > 0
    ? `Found ${paths.length} screenshot file${paths.length !== 1 ? 's' : ''}.`
    : 'No screenshots found in the folder.', paths.length > 0 ? 'ok' : 'err');
}

// Stitch the files on disk back into the notes library (and recover manual
// screenshots from the shared on-disk index).
async function rebuild() {
  // Start with the notes we already know about.
  const notes = await loadNotes();
  // Match the scanned files back to them.
  const result = await ls.rebuildLibrary(notes);
  // Persist the recovered library.
  await saveNotes(result.notes);
  // Merge the recovered manual screenshots with the stored list: per-install
  // browser storage may keep shots the on-disk index lost (or vice versa), so
  // union by id is the non-destructive cross-install merge.
  const existingShots = await loadManualShots();
  const mergedShots = [];
  const seen = new Set();
  for (const s of result.manualShots || []) {
    if (!s || !s.id || seen.has(s.id)) continue;
    seen.add(s.id);
    mergedShots.push(s);
  }
  for (const s of existingShots || []) {
    if (!s || !s.id || seen.has(s.id)) continue;
    seen.add(s.id);
    mergedShots.push(s);
  }
  // Persist the merged manual library back into browser storage AND mirror it
  // into the shared filesystem index so both installs converge.
  await saveManualShots(mergedShots);
  await ls.saveManualShotsIndex(mergedShots);
  // Tell the user what happened.
  const parts = [];
  if (result.added > 0) parts.push(`${result.added} moment${result.added !== 1 ? 's' : ''} recovered`);
  if (result.createdNotes > 0) parts.push(`${result.createdNotes} note${result.createdNotes !== 1 ? 's' : ''} created`);
  const manual = (result.manualShots || []).length;
  if (manual > 0) parts.push(`${manual} manual screenshot${manual !== 1 ? 's' : ''} indexed`);
  // If nothing changed, explain that clearly.
  const summary = parts.length > 0 ? parts.join(', ') + '.' : 'Nothing new found. The library already matches the folder.';
  // Show the summary.
  setMsg($('library-msg'), summary, result.added > 0 || result.createdNotes > 0 || manual > 0 ? 'ok' : 'err');
  // Refresh all the counters.
  await render();
}

// Write pending inline screenshots into the chosen folder.
async function migrate() {
  // Load the notes.
  const notes = await loadNotes();
  // Write out whatever is waiting in IndexedDB.
  const result = await ls.migratePendingToFolder(notes);
  // Persist the updated metadata.
  await saveNotes(notes);
  // Report the outcome.
  const ok = result.written > 0;
  setMsg($('library-msg'),
    ok ? `Moved ${result.written} screenshot${result.written !== 1 ? 's' : ''} to the folder.`
       : (result.failed > 0 ? `Could not write ${result.failed} screenshot(s).` : 'Nothing to move.'),
    ok ? 'ok' : 'err');
  // Refresh the counters.
  await render();
}

// Wire up every button.
function initEvents() {
  // "Back" closes this page and returns to the video.
  $('btn-back').addEventListener('click', () => window.close());

  // Choose / Change uses the native folder picker.
  $('btn-choose').addEventListener('click', () => chooseFolder().catch((e) => {
    setMsg($('test-msg'), e && e.message ? e.message : 'Folder selection cancelled or failed.', 'err');
  }));
  $('btn-choose2').addEventListener('click', () => chooseFolder().catch((e) => {
    setMsg($('test-msg'), e && e.message ? e.message : 'Folder selection cancelled or failed.', 'err');
  }));
  $('btn-change').addEventListener('click', () => chooseFolder().catch((e) => {
    setMsg($('test-msg'), e && e.message ? e.message : 'Folder selection cancelled or failed.', 'err');
  }));

  // Re-request permission on the stored folder.
  $('btn-reconnect').addEventListener('click', () => reconnect());

  // Prove the folder is writable.
  $('btn-test').addEventListener('click', () => testFolder());

  // Scan, rebuild, and migrate.
  $('btn-scan').addEventListener('click', () => scanFolder());
  $('btn-rebuild').addEventListener('click', () => rebuild());
  $('btn-rebuild-banner').addEventListener('click', () => rebuild());
  $('btn-migrate').addEventListener('click', () => migrate());
}

// Boot the page.
initEvents();
render();