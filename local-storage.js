// ClipNote - local folder storage logic
// Stores screenshots as ORIGINAL files inside a user-selected folder using
// the File System Access API (directory handle). IndexedDB only holds the
// handle, metadata, and thumbnail caches - never the permanent copy of the
// screenshots themselves.

// The IndexedDB database that remembers the chosen folder handle.
const IDB_NAME = 'clipnote_local';
// The key-value store inside it.
const IDB_STORE = 'kw';
// The key under which the directory handle is kept.
const KEY_HANDLE = 'dir_handle';
// The key under which the folder's display name is kept.
const KEY_NAME = 'dir_name';

// The metadata sidecar written into every per-note folder. It lets the
// filesystem stand alone as a recovery source (stable note id + title + video/
// course/lecture ids + full moment metadata) even after the extension's
// browser-local storage is gone.
const SIDECAR_NAME = '_clipnote-note.json';

// Root-level registry of files whose INTENTIONAL deletion failed but which must
// never come back through Rebuild Library. Written when an intentional delete
// could not actually remove an existing file (permission/transient error), so a
// later rebuild cannot resurrect deleted content from the leftovers.
const TOMBSTONE_NAME = '_clipnote-deleted.json';

// Root-level index of independent manual webpage screenshots. Like the note
// sidecars, it lives on the SHARED filesystem so the Web Store and local
// installations can both discover the same manual screenshots even though
// `clipnote_manual_shots` is per-extension browser storage.
const MANUAL_INDEX_NAME = '_clipnote-manual.json';

// The schema version stamped onto every note record saved to chrome.storage
// and on the filesystem sidecars. Any missing/newer fields are optional by
// contract: NEW FEATURE MISSING === OPTIONAL FIELD, never an invalid record.
export const NOTE_SCHEMA_VERSION = 4;
// The version written into _clipnote-note.json files.
export const SIDECAR_VERSION = 5;

// The internal database connection (null until opened).
let idb = null;
// One shared initialization promise so every folder call waits on the SAME
// open request (no competing/duplicate opens, no timeout that can shadow a
// request which then succeeds). A failed open resets this so a later call can
// retry; a successful open is cached in `idb`.
let idbPromise = null;

// Open (or create) the local storage IndexedDB database.
function openIdb() {
  // Fast path: the connection is already open.
  if (idb) return Promise.resolve(idb);
  // Share the in-flight initialization.
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve) => {
    // Ask the browser to open (or create) the database.
    const req = indexedDB.open(IDB_NAME, 1);
    // This runs the first time the database is created.
    req.onupgradeneeded = () => {
      // If there's no key-value store yet:
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        // Create one.
        req.result.createObjectStore(IDB_STORE);
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

// Read one value out of the local storage database.
async function dbGet(key) {
  // Guard against errors.
  try {
    // Make sure the database is open.
    const db = await openIdb();
    // If it never opened, return undefined.
    if (!db) return undefined;
    // Wrap the browser's request in a Promise.
    return await new Promise((resolve) => {
      // Start a read-only transaction.
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
      // Resolve with the stored value.
      req.onsuccess = () => resolve(req.result);
      // Resolve undefined on error.
      req.onerror = () => resolve(undefined);
    });
  } catch (e) { return undefined; }
}

// Save one value into the local storage database.
async function dbSet(key, value) {
  // Guard against errors.
  try {
    // Make sure the database is open.
    const db = await openIdb();
    // If it never opened, do nothing.
    if (!db) return;
    // Wrap the write in a Promise.
    await new Promise((resolve) => {
      // Start a read-write transaction.
      const tx = db.transaction(IDB_STORE, 'readwrite');
      // Save the value under its key.
      tx.objectStore(IDB_STORE).put(value, key);
      // Resolve when the write completes.
      tx.oncomplete = () => resolve();
      // Resolve on any error or cancel.
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch (e) { /* ignore */ }
}

// Remove a value from the local storage database.
async function dbDelete(key) {
  // Guard against errors.
  try {
    // Make sure the database is open.
    const db = await openIdb();
    // If it never opened, do nothing.
    if (!db) return;
    // Wrap the delete in a Promise.
    await new Promise((resolve) => {
      // Start a read-write transaction.
      const tx = db.transaction(IDB_STORE, 'readwrite');
      // Remove the value.
      tx.objectStore(IDB_STORE).delete(key);
      // Resolve when the delete completes.
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch (e) { /* ignore */ }
}

// ----------------------- Support checks -----------------------

// Return true when the File System Access API is available.
export function isSupported() {
  // Chrome's extensions support the native directory picker.
  return typeof window.showDirectoryPicker === 'function' &&
    typeof FileSystemDirectoryHandle !== 'undefined';
}

// ----------------------- Folder handle -----------------------

// Read the stored directory handle (and permission state) for later use.
export async function getFolderEntry() {
  // If the API is unavailable, there can be no folder.
  if (!isSupported()) return { handle: null, name: '', permission: 'none' };
  // Load the saved handle.
  const handle = await dbGet(KEY_HANDLE);
  // If there is no remembered folder:
  if (!handle) return { handle: null, name: '', permission: 'none' };
  // Load the saved display name.
  const name = (await dbGet(KEY_NAME)) || handle.name || 'Folder';
  // Ask the browser what the current permission for this folder is.
  let permission = 'none';
  // Guard against errors.
  try {
    // The current access the extension has to the folder.
    permission = await handle.queryPermission({ mode: 'readwrite' });
  } catch (e) { permission = 'none'; }
  // Return everything the UI needs.
  return { handle, name, permission };
}

// Ask the user to pick a screenshot folder (must be called from a click).
// When "keep" is true, the existing handle is kept if the user cancels.
export async function pickFolder() {
  // The folder picker is only available in a real user gesture.
  if (!isSupported()) throw new Error('This browser does not support the File System Access API.');
  // Open the native directory picker.
  const handle = await window.showDirectoryPicker({ id: 'clipnote', mode: 'readwrite' });
  // Remember the handle so every future capture reuses it.
  await dbSet(KEY_HANDLE, handle);
  // Remember the display name too (the API hides the full path).
  await dbSet(KEY_NAME, handle.name || 'ClipNote');
  // Hand the freshly chosen folder back.
  return { handle, name: handle.name || 'ClipNote', permission: 'granted' };
}

// Re-request permission for a previously stored folder (user gesture needed).
export async function reconnectFolder() {
  // Load the saved handle.
  const entry = await getFolderEntry();
  // If there is no handle, nothing to reconnect to.
  if (!entry.handle) return 'none';
  // Ask the browser to re-grant access (runs from a click handler).
  const permission = await entry.handle.requestPermission({ mode: 'readwrite' });
  // Tell the caller what the new state is.
  return permission;
}

// Forget the chosen folder entirely.
export async function clearFolder() {
  // Delete the handle and the display name.
  await dbDelete(KEY_HANDLE);
  await dbDelete(KEY_NAME);
}

// ----------------------- Path helpers -----------------------

// Keep only safe filename characters in a folder/name segment.
function safeSegment(value, fallback) {
  // Sanitize: keep letters, digits, dashes, underscores and dots.
  const cleaned = String(value || '').replace(/[^\w.-]+/g, '_').replace(/^[_\-.]*|[_\-.]*$/g, '');
  // Use the cleaned value, or a fallback when it ends up empty.
  return cleaned.slice(0, 80) || fallback || 'untitled';
}

// Turn seconds into an "MM-SS" filename-friendly time.
function tsToName(seconds) {
  // Never go below zero and keep it whole.
  seconds = Math.max(0, Math.floor(seconds || 0));
  // The whole minutes.
  const m = Math.floor(seconds / 60);
  // The remaining seconds.
  const s = seconds % 60;
  // Like "11-36".
  return `${String(m).padStart(2, '0')}-${String(s).padStart(2, '0')}`;
}

// The relative directory (no trailing file) that owns a note's screenshots.
// Deterministic: built exclusively from STABLE ids - never from the note title,
// a timestamp, or any freshly generated random value. The last folder segment
// is ALWAYS the note's own id, so two notes about the same video/lecture (and
// two notes with different ids) can never share a folder, and a rename can
// never move the note's screenshots.
//   YouTube:  YouTube/<videoId>/<noteId>
//   Udemy:    Udemy/<courseId>/<lectureId>/<noteId>
//   ChatGPT:  ChatGPT/<conversationId>/<noteId>
export function noteFolderRelativePath(note) {
  // The platform this note came from.
  let platform = 'YouTube';
  if (note && note.platform === 'udemy') platform = 'Udemy';
  else if (note && note.platform === 'chatgpt') platform = 'ChatGPT';
  // The stable note identity (uuid) that owns the folder.
  const noteId = safeSegment(note && note.id, 'note');

  // Udemy notes nest the course and lecture folders.
  if (platform === 'Udemy') {
    // The course id (numeric id, else slug, else the video id).
    const course = safeSegment(
      (note.course && (note.course.id || note.course.slug)) || (note.video && note.video.id),
      'course');
    // The lecture id.
    const lecture = safeSegment((note.lecture && note.lecture.id) || (note.video && note.video.id), 'lecture');
    // e.g. Udemy/123456/789101/<noteId>
    return `Udemy/${course}/${lecture}/${noteId}`;
  }

  // ChatGPT notes nest one level under the conversation id, exactly like the
  // video-level nesting below.
  if (platform === 'ChatGPT') {
    const conversationId = safeSegment(
      (note.video && note.video.id) || (note.conversation && note.conversation.id),
      'conversation');
    // e.g. ChatGPT/1ab2cd3e-<conversationId>/<noteId>
    return `${platform}/${conversationId}/${noteId}`;
  }

  // YouTube notes nest one level under the video id. The video id is the only
  // video-level identity allowed here; the note title is never promoted to a
  // folder name, so a missing video id degrades to a stable placeholder, not a
  // title-based random-looking segment.
  const videoId = safeSegment(note && note.video && note.video.id, 'video');
  // e.g. YouTube/9bZkp7q19f0/<noteId>
  return `${platform}/${videoId}/${noteId}`;
}

// Compute the relative save path for one moment's screenshot.
// Structure: YouTube/<videoId>/<noteId>/MM-SS_<momentId>.jpg   or
//           Udemy/<courseId>/<lectureId>/<noteId>/MM-SS_<momentId>.jpg
export function relativePathForMoment(note, moment) {
  // The folder that owns this note's screenshots.
  const folder = noteFolderRelativePath(note);
  // The human time turned into a filename-safe "MM-SS".
  const ts = moment.humanTime ? moment.humanTime.replace(':', '-') : tsToName(moment.timestamp);
  // The image name (moment ids carry a uuid, so names are always unique).
  const name = `${ts}_${safeSegment(moment.id, Math.random().toString(36).slice(2))}.jpg`;
  // e.g. YouTube/9bZkp7q19f0/<noteId>/11-36_abc.jpg
  return `${folder}/${name}`;
}

// ----------------------- File writing -----------------------

// Turn a data URL into a Blob without recompressing the image.
function dataUrlToBlob(dataUrl) {
  // Split the header (data:image/jpeg;base64,) from the payload.
  const comma = dataUrl.indexOf(',');
  // The mime type from the header, defaulting to JPEG.
  const mime = (dataUrl.slice(5, comma).match(/^[^;]+/) || ['image/jpeg'])[0];
  // The base64 payload.
  const b64 = dataUrl.slice(comma + 1);
  // Decode it into raw bytes.
  const bin = atob(b64);
  // A byte array the size of the payload.
  const bytes = new Uint8Array(bin.length);
  // Copy every byte across.
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // Wrap the original image bytes in a Blob.
  return new Blob([bytes], { type: mime });
}

// Walk/create the folder a relative path lives in and return the file handle.
async function getFileHandleByPath(root, relativePath) {
  // Split the relative path into its segments.
  const parts = relativePath.split('/');
  // The file name is the last segment.
  const fileName = parts.pop();
  // Walk every folder segment, creating them as needed.
  let dir = root;
  // Loop over the folder segments.
  for (const part of parts) {
    // Open (creating if needed) each subfolder.
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  // Open (creating if needed) the file inside the deepest folder.
  return dir.getFileHandle(fileName, { create: true });
}

// Write a moment's screenshot into the user's folder.
// Returns the relative path when the write succeeded; throws otherwise.
export async function saveScreenshotFile({ note, moment }) {
  // We can only save real inline captures.
  if (!moment.screenshot || moment.screenshot.type !== 'data-url' || !moment.screenshot.dataUrl) {
    // Nothing to write to the folder.
    throw new Error('No inline screenshot to save.');
  }
  // Make sure we have a usable folder with write access.
  const entry = await getFolderEntry();
  // Fail fast if there is no granted folder.
  if (!entry.handle || entry.permission !== 'granted') {
    throw new Error('No screenshot folder connected.');
  }
  // The relative location this screenshot should go to.
  const relativePath = relativePathForMoment(note, moment);
  // Get (or create) the file handle for that location.
  const fileHandle = await getFileHandleByPath(entry.handle, relativePath);
  // Open a writeable stream.
  const writable = await fileHandle.createWritable();
  // Convert the original data URL to a Blob (no recompression).
  const blob = dataUrlToBlob(moment.screenshot.dataUrl);
  // Write the original-quality image bytes.
  await writable.write(blob);
  // Close the stream so the file is flushed to disk.
  await writable.close();
  // Tell the caller where the file landed.
  return relativePath;
}

// Write a manual webpage screenshot into the user's folder.
// Structure: Screenshots/<Platform>/yyyy-MM-dd_HH-mm-ss_<id>.jpg
// Returns the relative path when the write succeeded; throws otherwise.
export async function saveManualScreenshotFile({ shot }) {
  // We can only save real inline captures.
  if (!shot.screenshot || shot.screenshot.type !== 'data-url' || !shot.screenshot.dataUrl) {
    // Nothing to write to the folder.
    throw new Error('No inline screenshot to save.');
  }
  // Make sure we have a usable folder with write access.
  const entry = await getFolderEntry();
  // Fail fast if there is no granted folder.
  if (!entry.handle || entry.permission !== 'granted') {
    throw new Error('No screenshot folder connected.');
  }
  // The platform from the top-level folder name.
  const platform = shot.platform === 'udemy' ? 'Udemy' : 'YouTube';
  // A timestamp-based file name ("yyyy-MM-dd_HH-mm-ss_<id>.jpg").
  const d = new Date(shot.createdAt || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  // The relative location this screenshot should go to.
  const relativePath = `Screenshots/${platform}/${stamp}_${safeSegment(shot.id, Math.random().toString(36).slice(2))}.jpg`;
  // Get (or create) the file handle for that location.
  const fileHandle = await getFileHandleByPath(entry.handle, relativePath);
  // Open a writeable stream.
  const writable = await fileHandle.createWritable();
  // Convert the original data URL to a Blob (no recompression).
  const blob = dataUrlToBlob(shot.screenshot.dataUrl);
  // Write the original-quality image bytes.
  await writable.write(blob);
  // Close the stream so the file is flushed to disk.
  await writable.close();
  // Tell the caller where the file landed.
  return relativePath;
}

// Check whether a stored relative path still exists on disk.
export async function fileExists(relativePath) {
  // Guard against errors.
  try {
    // Make sure we have a folder.
    const entry = await getFolderEntry();
    // Without a handle there is nothing to check.
    if (!entry.handle) return false;
    // Navigate the relative path down to the file.
    let dir = entry.handle;
    // Split the path into segments.
    const parts = relativePath.split('/');
    // The file name is the last segment.
    const fileName = parts.pop();
    // Walk every folder segment (without creating them).
    for (const part of parts) {
      // Ask for the subfolder; it throws if it doesn't exist.
      dir = await dir.getDirectoryHandle(part, { create: false });
    }
    // If the file exists, we're done.
    await dir.getFileHandle(fileName, { create: false });
    // It's there.
    return true;
  } catch (e) {
    // Any failure means the file is missing.
    return false;
  }
}

// ----------------------- Folder testing -----------------------

// Write a tiny probe file, read it back, then remove it.
export async function testFolder() {
  // Guard against errors.
  try {
    // Make sure we have a usable folder.
    const entry = await getFolderEntry();
    // Fail fast if there is no folder or access.
    if (!entry.handle) throw new Error('No screenshot folder connected.');
    if (entry.permission !== 'granted') throw new Error('Folder permission is missing.');
    // The probe file's handle.
    const fileHandle = await entry.handle.getFileHandle('_clipnote_test.txt', { create: true });
    // Write a small marker into it.
    const writable = await fileHandle.createWritable();
    // The exact text we expect to read back.
    await writable.write('clipnote-ok');
    // Flush it to disk.
    await writable.close();
    // Read it back to confirm the round trip.
    const file = await fileHandle.getFile();
    // The text that was actually stored.
    const text = (await file.text()).trim();
    // Remove the probe file.
    await entry.handle.removeEntry('_clipnote_test.txt');
    // Report success if the written text came back intact.
    if (text === 'clipnote-ok') return { ok: true };
    // Otherwise the bytes were mangled somehow.
    throw new Error('Written file could not be read back correctly.');
  } catch (e) {
    // Return the reason so the UI can show it.
    return { ok: false, error: e && e.message ? String(e.message) : 'Folder test failed.' };
  }
}
// ----------------------- Deleted-file registry -----------------------

// Read the root-level tombstone registry. Returns a Map<relativePath, meta>.
async function readTombstones() {
  // Guard against errors.
  try {
    // Make sure we have a folder.
    const entry = await getFolderEntry();
    // Without a handle there is nothing to read.
    if (!entry.handle) return new Map();
    // The registry file must already exist (opening with create:false).
    const fileHandle = await entry.handle.getFileHandle(TOMBSTONE_NAME, { create: false });
    // The File object for it.
    const file = await fileHandle.getFile();
    // Its JSON text.
    const data = JSON.parse(await file.text());
    // Only trust the shape we write.
    if (data && data.version && data.files && typeof data.files === 'object') {
      // Hand back the map.
      return new Map(Object.entries(data.files));
    }
    // Anything else is treated as empty.
    return new Map();
  } catch (e) {
    // Missing registry (the common case) or unreadable - treat as empty.
    return new Map();
  }
}

// Persist the tombstone registry to the root of the chosen folder.
async function writeTombstones(map) {
  // Guard against errors.
  try {
    // Make sure we have a folder.
    const entry = await getFolderEntry();
    // Without a handle there is nowhere to write.
    if (!entry.handle) return false;
    // Get (or create) the registry file.
    const fileHandle = await entry.handle.getFileHandle(TOMBSTONE_NAME, { create: true });
    // Open a writeable stream.
    const writable = await fileHandle.createWritable();
    // Write the versioned map.
    await writable.write(JSON.stringify({
      format: 'clipnote-deleted',
      version: 1,
      files: Object.fromEntries(map.entries())
    }));
    // Flush it to disk.
    await writable.close();
    // It worked.
    return true;
  } catch (e) {
    // Best effort: a failed registry write must never take the delete down.
    return false;
  }
}

// Record that an intentionally-deleted file is still on disk so a later
// Rebuild/scan never resurrects it. Best effort.
export async function markFileDeletedCarefully(relativePath, context) {
  // Nothing to register without a path.
  if (!relativePath) return;
  // Load the current registry.
  const map = await readTombstones();
  // Stamp the entry (when was it deleted + which note owned it, when known).
  map.set(relativePath, {
    noteId: (context && context.noteId) || '',
    deletedAt: Date.now()
  });
  // Persist the updated registry.
  await writeTombstones(map);
}

// Delete a screenshot file from the folder (best effort).
// Returns true when the file was actually removed, false otherwise (missing
// folder, missing file, or the removal itself failed).
export async function deleteScreenshotFile(relativePath, context) {
  // Guard against errors.
  try {
    // Make sure we have a folder.
    const entry = await getFolderEntry();
    // Without a handle there is nothing to delete.
    if (!entry.handle) return false;
    // Navigate to the file's folder.
    let dir = entry.handle;
    // Split the relative path into its segments.
    const parts = relativePath.split('/');
    // The file name is the last segment.
    const fileName = parts.pop();
    // Walk every folder segment (without creating them).
    for (const part of parts) {
      // Ask for the subfolder; it throws if it doesn't exist.
      dir = await dir.getDirectoryHandle(part, { create: false });
    }
    // Remove the file.
    await dir.removeEntry(fileName);
    // It was removed.
    return true;
  } catch (e) {
    // The removal failed. If the file STILL exists on disk (permission drop,
    // transient error), register a tombstone so Rebuild Library can never
    // bring a deliberately-deleted file back. An already-missing file needs no
    // registry entry (it cannot be scanned anyway).
    if (await fileExists(relativePath)) {
      await markFileDeletedCarefully(relativePath, context);
    }
    // Report the failure so callers can surface it.
    return false;
  }
}

// Resolve a stored relative path down to the directory it lives in.
// Returns { dir, fileName } or null when the path cannot be reached.
async function resolveDirHandle(relativePath) {
  // Make sure we have a folder.
  const entry = await getFolderEntry();
  // Without a handle there is nothing to resolve.
  if (!entry.handle) return null;
  // Navigate to the file's folder.
  let dir = entry.handle;
  // Split the relative path into its segments.
  const parts = relativePath.split('/');
  // The file name is the last segment.
  const fileName = parts.pop();
  // Walk every folder segment (without creating them).
  for (const part of parts) {
    // Ask for the subfolder; it throws if it doesn't exist.
    dir = await dir.getDirectoryHandle(part, { create: false });
  }
  // Hand the deepest directory plus the file name back.
  return { dir, fileName };
}

// True for the file names ClipNote owns inside a per-note folder: the screenshots
// it writes (images with our extensions), its metadata sidecar, and any other
// ClipNote-prefixed file. Anything else is treated as foreign and never removed.
export function isClipNoteOwnedName(name) {
  // Our screenshot images, the note sidecar, and ClipNote-prefixed files.
  return isImageName(name) || name === SIDECAR_NAME || String(name || '').indexOf('_clipnote') === 0;
}

// Walk a directory and confirm that EVERYTHING it contains belongs to this note:
// only our own images/sidecar files, and further subdirectories whose own entire
// subtree is likewise ClipNote-owned. An empty directory is trivially exclusive.
// This is the "folder is confirmed to belong exclusively to this Note" gate that
// makes a recursive removal safe - the note's folder is keyed by the note's own
// stable id, and no entry here belongs to any other note.
export async function isNoteFolderExclusive(dirHandle) {
  // Iterate every entry in the directory.
  for await (const [name, entry] of dirHandle.entries()) {
    // Subdirectories only pass if their whole subtree is ClipNote-owned.
    if (entry.kind === 'directory') {
      // Recurse into the subdirectory.
      if (!(await isNoteFolderExclusive(entry))) return false;
    } else if (!isClipNoteOwnedName(name)) {
      // A foreign file means the folder is shared with something else.
      return false;
    }
  }
  // Everything (or nothing) inside belongs to ClipNote.
  return true;
}

// True when a directory contains no entries at all (completely empty).
export async function isEmptyDir(dirHandle) {
  // Any entry at all means the directory is not empty.
  for await (const _ of dirHandle.entries()) {
    return false;
  }
  return true;
}

// After a note's own folder has been removed, walk UP its directory chain and
// remove every ancestor that is now COMPLETELY empty. Stops as soon as a parent
// is non-empty (its ancestors are guaranteed to still contain data). The
// platform root (YouTube/ or Udemy/) is never touched regardless of emptiness.
//   Udemy:   <noteId> removed → <lecture> → <course>
//   YouTube: <noteId> removed → <videoId>
// Returns true when the top platform parent (course or video folder) was removed.
async function pruneEmptyAncestorFolders(noteFolderRelPath, report) {
  const parts = noteFolderRelPath.split('/');
  // Defensive: a degenerate path with fewer than three parts has no platform
  // parent to prune; bail immediately.
  if (parts.length < 3) return false;
  let courseDeleted = false;
  // Walk from the note's immediate parent upward toward the platform root.
  // parts[0] is the root and is never touched.
  for (let i = parts.length - 2; i >= 1; i--) {
    const parentName = parts[i];
    const parentPath = parts.slice(0, i + 1).join('/');
    let resolved = null;
    try {
      resolved = await resolveDirHandle(parentPath);
    } catch (e) {
      // The parent chain is already gone (concurrent deletion / no data).
      break;
    }
    if (!resolved) break;
    let parentDir = null;
    try {
      parentDir = await resolved.dir.getDirectoryHandle(parentName, { create: false });
    } catch (e) {
      // Already gone.
      break;
    }
    // Any entry at all (another note, user files) keeps the folder alive.
    if (!(await isEmptyDir(parentDir))) break;
    try {
      // Strict single-entry removal: removeEntry throws on a non-empty
      // directory, so this is a safe no-op if a concurrent write snuck in.
      await resolved.dir.removeEntry(parentName, { recursive: false });
      // The deepest platform parent (course/video) is marked for reporting.
      if (i === 1) courseDeleted = true;
    } catch (e) {
      // A concurrent deletion may have removed the directory first; only report
      // a real failure if the directory still exists.
      let stillThere = false;
      try {
        await resolved.dir.getDirectoryHandle(parentName, { create: false });
        stillThere = true;
      } catch (e2) { /* gone */ }
      if (stillThere) report.errors.push(`folder:${parentName}`);
      break;
    }
  }
  return courseDeleted;
}

// Delete ALL of a note's files from the folder AND its note folder itself.
//  1. Enumerates the note's own folder (never the parent platform folder) and
//     removes every ClipNote-owned file it finds - moment screenshots, the note
//     sidecar, any ClipNote-prefixed metadata. Enumerating instead of trusting
//     the in-memory moment list means a screenshot whose BYTES were written by
//     a racing capture/deletion but whose metadata was never stamped cannot
//     survive and block the folder deletion (BUG 3 follow-up: an empty folder
//     used to be left behind).
//  2. Removes the note folder itself (recursive ONLY when confirmed to contain
//     nothing but ClipNote-owned content). Foreign files inside are never
//     deleted; the folder is kept and reported as folder-not-empty.
// Legacy shared folders (v1 layout) are untouched except for the exact files the
// note references - they may still hold another note's data.
// Returns a detailed report; never throws.
export async function deleteNoteFilesystem(note) {
  // The report we return.
  const report = { filesDeleted: 0, folderDeleted: false, sidecarDeleted: false, courseFolderDeleted: false, errors: [] };
  // A note is required.
  if (!note || !note.id) {
    // Nothing to do.
    report.errors.push('no-note');
    return report;
  }
  // The note's own folder path (e.g. YouTube/<videoId>/<noteId>).
  const noteFolderRelPath = noteFolderRelativePath(note);

  // The note's own folder, resolved through its parent (a legacy v1 note has
  // no such folder - its files share the video/course folder - and falls
  // through to the per-moment cleanup below).
  let resolved = null;
  try {
    resolved = await resolveDirHandle(noteFolderRelPath);
  } catch (e) {
    // The whole folder chain is missing (the note never wrote to disk, or a
    // previous deletion already removed it). An unreachable chain holds nothing
    // for this note, so this is a clean no-op - never an error.
    return report;
  }
  let noteDir = null;
  if (resolved) {
    try {
      // Open the note's own folder (never creating it: if it is gone the
      // delete is a no-op on disk).
      noteDir = await resolved.dir.getDirectoryHandle(resolved.fileName, { create: false });
    } catch (e) {
      // The note folder does not exist (or is unreachable) - handle below.
      noteDir = null;
    }
  }

  // The note-folder layout (v2/v3): enumerate and clean the whole folder.
  if (noteDir) {
    // 1) Snapshot the folder's contents first (the iterator must not be asked
    //    to keep going while we remove entries from the same directory).
    const names = [];
    for await (const [name] of noteDir.entries()) names.push(name);

    // 2) Delete every entry that belongs to this note; never foreign files.
    for (const name of names) {
      // The full relative location of this entry inside the note folder.
      const relPath = `${noteFolderRelPath}/${name}`;
      // Release any cached preview before its file disappears.
      revokeBlobUrl(relPath);
      // The note's metadata sidecar.
      if (name === SIDECAR_NAME) {
        // Remove it (a failure registers a tombstone so Rebuild can never
        // resurrect the whole note from a leftover sidecar).
        if (await deleteScreenshotFile(relPath, { noteId: note.id })) report.sidecarDeleted = true;
        else report.errors.push('sidecar');
        continue;
      }
      // Only ClipNote-owned files are erased. Anything else is foreign data we
      // must never delete - it is reported instead.
      if (!isClipNoteOwnedName(name)) {
        report.errors.push(`foreign:${name}`);
        continue;
      }
      // Remove the screenshot/metadata file (failures register a deleted-file
      // tombstone so a later Rebuild cannot resurrect it).
      if (await deleteScreenshotFile(relPath, { noteId: note.id })) report.filesDeleted++;
      else report.errors.push(`file:${name}`);
    }

    // 3) Verify the folder belongs exclusively to this note before removing it.
    if (await isNoteFolderExclusive(noteDir)) {
      // Everything left is ClipNote-owned: safe to remove the folder wholesale.
      // Only the note's own entry is removed here - parents are handled in step
      // 4 below.
      try {
        await resolved.dir.removeEntry(resolved.fileName, { recursive: true });
        report.folderDeleted = true;
      } catch (e) {
        report.errors.push('folder');
      }
    } else {
      // Unrelated content lives inside this note's folder: its owned files are
      // already gone, but the folder itself must stay. The user is told.
      report.errors.push('folder-not-empty');
    }

    // 4) The note's own folder is gone - now prune every ancestor that was left
    //    completely empty, so no empty Lecture/Course folders are left behind
    //    (Udemy: lecture then course; YouTube: video). The platform root at the
    //    top of the chain is never touched, and each parent is removed ONLY
    //    while it holds no entries at all - a sibling note's folder, a leftover
    //    screenshot or an unrelated user file keeps it alive.
    if (report.folderDeleted === true) {
      report.courseFolderDeleted = await pruneEmptyAncestorFolders(noteFolderRelPath, report);
    }

    // Hand the detailed report back.
    return report;
  }

  // Legacy v1 layout (files share the video/course folder) or an unreachable
  // note folder: delete exactly the files the note references. The shared
  // platform folder is never removed - only these files.
  for (const moment of note.moments || []) {
    // Bail when the moment has no filesystem file.
    if (!moment.relativePath) continue;
    // Release any cached object URL first.
    revokeBlobUrl(moment.relativePath);
    // Try to remove the file (a failure registers a deleted-file tombstone so
    // a later Rebuild can never resurrect it).
    const ok = await deleteScreenshotFile(moment.relativePath, { noteId: note.id });
    // Count the success.
    if (ok) report.filesDeleted++;
    else report.errors.push(`missing:${moment.relativePath}`);
  }

  // Hand the detailed report back.
  return report;
}

// ----------------------- Preview reading -----------------------

// Object URL registry keyed by relative path. Entries are ONLY revoked when
// the path stops being referenced by the live UI (sweepBlobUrls) or on a real
// teardown (revokeAllBlobUrls) - never opportunistically while an image still
// points at the URL. A stale URL (from an earlier sesson, a different note, or
// a re-render) is simply regenerated on demand, so every file that exists on
// disk always has a working preview. The same promise drives fallback: the
// renderer re-reads from the path whenever the in-memory URL is missing.
const blobUrlCache = new Map();
// Paths currently referenced by live <img>/preview elements. sweepBlobUrls()
// only revokes URLs whose path is NOT in this set, so a visible screenshot
// can never be torn out from under its element.
const blobUrlInUse = new Set();
// Hard safety ceiling for the registry. In normal use the sweep keeps the
// registry near the number of VISIBLE thumbnails; this is only a last-resort
// cap in case a referencing bug ever marks far too many paths "in use".
const MAX_BLOB_URL_LIVE = 400;

// True when the given path has a live object URL right now.
export function hasBlobUrl(relativePath) {
  return blobUrlCache.has(relativePath);
}

// Return the current cached URL without creating one (null when absent).
export function safeGetBlobUrl(relativePath) {
  return blobUrlCache.get(relativePath) || null;
}

// Mark the set of relative paths that the UI currently renders. The calling
// page calls this immediately before every render pass, then sweepBlobUrls().
export function markBlobUrlsInUse(relativePaths) {
  blobUrlInUse.clear();
  for (const p of relativePaths || []) {
    if (p) blobUrlInUse.add(p);
  }
}

// Revoke every cached object URL whose path is no longer rendered, so memory
// stays bounded while every visible screenshot keeps working.
export function sweepBlobUrls() {
  for (const [path, url] of blobUrlCache) {
    // Skip paths that are still on screen.
    if (blobUrlInUse.has(path)) continue;
    blobUrlCache.delete(path);
    try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
  }
  // Last-resort ceiling: if a bug keeps too many paths "in use", drop the
  // oldest NOT-visible entries first (visible ones always survive).
  if (blobUrlCache.size > MAX_BLOB_URL_LIVE) {
    for (const [path, url] of blobUrlCache) {
      if (blobUrlCache.size <= MAX_BLOB_URL_LIVE) break;
      // Never touch a URL a live element may be pointing at.
      if (blobUrlInUse.has(path)) continue;
      blobUrlCache.delete(path);
      try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
    }
  }
}

// Release every cached object URL. Called ONLY on a genuine teardown of the
// consuming context (the sidebar iframe usually lives for the whole tab, so
// this is the guaranteed-cleanup point). bfcache restores must NOT call this -
// the pagehide handler checks e.persisted before reaching it.
export function revokeAllBlobUrls() {
  for (const url of blobUrlCache.values()) {
    try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
  }
  blobUrlCache.clear();
  blobUrlInUse.clear();
}

// Drop the cached object URL for one path (used when the file is going away).
export function revokeBlobUrl(relativePath) {
  blobUrlInUse.delete(relativePath);
  const url = blobUrlCache.get(relativePath);
  if (!url) return;
  blobUrlCache.delete(relativePath);
  try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
}

// Test-only hook: seed the preview registry without a filesystem, so the Node
// suite can exercise the sweep/revoke invariants in isolation.
export function debugSeedBlobUrl(relativePath, url) {
  blobUrlCache.set(relativePath, url);
}

// Return a displayable object URL for a stored screenshot file (or null).
// Note: this never revokes anything. Stale/generated-on-demand URLs are cheap;
// revocation only happens through sweepBlobUrls/revokeAllBlobUrls/revokeBlobUrl.
export async function readBlobUrl(relativePath) {
  // Return the cached URL when we already made one this session.
  if (blobUrlCache.has(relativePath)) {
    return blobUrlCache.get(relativePath);
  }
  // Guard against errors.
  try {
    // Make sure we have a folder.
    const entry = await getFolderEntry();
    // Without a handle every read fails.
    if (!entry.handle) return null;
    // Navigate to the file's folder.
    let dir = entry.handle;
    // Split the relative path into its segments.
    const parts = relativePath.split('/');
    // The file name is the last segment.
    const fileName = parts.pop();
    // Walk every folder segment (without creating them).
    for (const part of parts) {
      // Ask for the subfolder; it throws if it doesn't exist.
      dir = await dir.getDirectoryHandle(part, { create: false });
    }
    // Grab the file handle.
    const fileHandle = await dir.getFileHandle(fileName, { create: false });
    // Read the actual File object.
    const file = await fileHandle.getFile();
    // Turn it into a displayable object URL.
    const url = URL.createObjectURL(file);
    // Remember it for the rest of this session.
    blobUrlCache.set(relativePath, url);
    return url;
  } catch (e) {
    // Any failure means no preview is available.
    return null;
  }
}

// ----------------------- Scanning / rebuilding -----------------------

// True for image file names ClipNote produces or understands.
function isImageName(name) {
  // Matches .jpg, .jpeg, .png and .webp (case-insensitive).
  return /\.(jpe?g|png|webp|avif)$/i.test(name);
}

// Recursively collect every image file under a directory handle.
async function walkImages(dirHandle, relativePrefix, out) {
  // Iterate every entry in this directory.
  for await (const [name, entry] of dirHandle.entries()) {
    // Folder entries are walked into.
    if (entry.kind === 'directory') {
      // Recurse with the extended prefix.
      await walkImages(entry, relativePrefix ? `${relativePrefix}/${name}` : name, out);
    } else if (isImageName(name)) {
      // Remember the image's relative location.
      out.push(relativePrefix ? `${relativePrefix}/${name}` : name);
    }
  }
}

// List every image file inside the chosen folder (relative paths).
export async function listImagePaths() {
  // Guard against errors.
  try {
    // Make sure we have a folder.
    const entry = await getFolderEntry();
    // Without a handle there are no files.
    if (!entry.handle) return [];
    // Collect the relative paths here.
    const paths = [];
    // Walk the whole tree.
    await walkImages(entry.handle, '', paths);
    // Drop every path the deleted-file registry tombstoned: files whose
    // intentional deletion failed are never shown, counted, or rebuilt.
    const tombstoned = await readTombstones();
    const live = paths.filter((p) => !tombstoned.has(p));
    // Return them sorted for a stable list.
    return live.sort();
  } catch (e) {
    // A scan must never crash the UI.
    return [];
  }
}

// Count the image files in the folder.
export async function countImageFiles() {
  // Reuse the full listing and just count it.
  return (await listImagePaths()).length;
}

// Capture the scan: relative paths plus each file's last-modified time in ms.
// Rebuild uses these mt instead of Date.now() so the recovered timestamps are
// deterministic across installs and reruns.
export async function listImageStats() {
  // Guard against errors.
  try {
    // Make sure we have a folder.
    const entry = await getFolderEntry();
    // Without a handle there are no files.
    if (!entry.handle) return [];
    // Collect { relativePath, lastModified } records.
    const out = [];
    const walk = async (dirHandle, prefix) => {
      for await (const [name, child] of dirHandle.entries()) {
        if (child.kind === 'directory') {
          // Recurse with the extended prefix.
          await walk(child, prefix ? `${prefix}/${name}` : name);
        } else if (isImageName(name)) {
          // The relative path of this image.
          const rel = prefix ? `${prefix}/${name}` : name;
          // Best-effort mtime (a missing read falls back to 0).
          let lastModified = 0;
          try {
            const file = await child.getFile();
            lastModified = file.lastModified || 0;
          } catch (e) { /* keep 0 */ }
          out.push({ relativePath: rel, lastModified });
        }
      }
    };
    await walk(entry.handle, '');
    // Drop tombstoned paths, then sort for a stable list.
    const tombstoned = await readTombstones();
    return out.filter((s) => s && !tombstoned.has(s.relativePath)).sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
  } catch (e) {
    // A scan must never crash the UI.
    return [];
  }
}

// Reverse a relative path + filename back into structured metadata.
// Understands BOTH the legacy (v1) and current (v2) layouts:
//   v1 YouTube: YouTube/<videoId>/MM-SS_<momentId>.jpg
//   v2 YouTube: YouTube/<videoId>/<noteId>/MM-SS_<momentId>.jpg
//   v1 Udemy:   Udemy/<courseId>/<lectureId>/MM-SS_<momentId>.jpg
//   v2 Udemy:   Udemy/<courseId>/<lectureId>/<noteId>/MM-SS_<momentId>.jpg
//   manual:     Screenshots/<Platform>/yyyy-MM-dd_HH-mm-ss_<id>.jpg
//   ChatGPT:    ChatGPT/<conversationId>/<noteId>/H-MM_<momentId>.jpg  (clock time)

// The platform the top-level folder segment stands for: YouTube, Udemy or
// ChatGPT. Unknown folders fall back to "youtube" (the legacy default).
function topLevelPlatform(segment) {
  const s = (segment || '').toLowerCase();
  if (s === 'udemy') return 'udemy';
  if (s === 'chatgpt') return 'chatgpt';
  return 'youtube';
}

export function parseRelativePath(relativePath) {
  // Split the relative path into its segments.
  const parts = relativePath.split('/');
  // The file name is the last segment.
  const file = parts.pop() || '';
  // The base name without the extension.
  const base = file.replace(/\.[^.]+$/, '');
  // A base looks like "MM-SS_<momentId>".
  const match = base.match(/^(\d+)-(\d{2})_(.+)$/);
  // Everything derived from the filename.
  const derived = {
    // The full relative path.
    relativePath,
    // The file name itself.
    fileName: file,
    // The platform from the top-level folder.
    platform: topLevelPlatform(parts[0]),
    // The moment id when the filename follows our pattern.
    momentId: (match && match[3]) || '',
    // The timestamp in seconds when we can read it. ChatGPT file names use the
    // WALL CLOCK ("14-31_<momentId>.jpg"), never a video position, so a real
    // video timestamp is NEVER derived for it - it stays 0, exactly like the
    // moment it was saved from.
    timestamp: (topLevelPlatform(parts[0]) !== 'chatgpt' && match)
      ? (parseInt(match[1], 10) * 60 + parseInt(match[2], 10))
      : 0,
    // The seconds count in filename form (a clock time for ChatGPT).
    humanTime: match ? `${match[1]}:${match[2]}` : '',
    // The owning note id when this is a v2 per-note folder.
    noteId: '',
    // True for independent manual page screenshots (never note moments).
    manualShot: false
  };

  // Manual webpage screenshots live under their own top-level folder.
  if ((parts[0] || '').toLowerCase() === 'screenshots') {
    // The platform from the second segment.
    derived.manualShot = true;
    derived.platform = topLevelPlatform(parts[1]);
    derived.videoId = '';
    derived.courseId = '';
    derived.lectureId = '';
    return derived;
  }

  // Udemy keeps two id folders (course + lecture) and, in v2, one note folder.
  if (derived.platform === 'udemy') {
    // Ugly edge case: keep the original segment casing for ids.
    derived.courseId = parts[1] || '';
    derived.lectureId = parts[2] || '';
    derived.videoId = parts[1] || '';
    // The v2 layout has a fourth segment: the note id.
    if (parts.length >= 4) {
      derived.noteId = parts[3] || '';
    }
  } else if (derived.platform === 'chatgpt') {
    // ChatGPT keeps one conversation-id folder and one note folder.
    derived.videoId = parts[1] || '';
    if (parts.length >= 3) {
      derived.noteId = parts[2] || '';
    }
    derived.courseId = '';
    derived.lectureId = '';
  } else {
    // YouTube keeps one video id folder and, in v2, one note folder.
    derived.videoId = parts[1] || '';
    if (parts.length >= 3) {
      derived.noteId = parts[2] || '';
    }
    derived.courseId = '';
    derived.lectureId = '';
  }
  // Hand back the parsed structure.
  return derived;
}

// Guess whether two notes/files describe the same video/lecture.
// The right side may be a note object (with course/lecture) or a scanned
// file (with flat courseId/lectureId fields), so both shapes are handled.
function noteVideoId(n) {
  // The course id from either a nested object or a flat field.
  const course = (n && (n.courseId || (n.course && (n.course.id || n.course.slug)))) || '';
  // The lecture id from either shape.
  const lecture = (n && (n.lectureId || (n.lecture && n.lecture.id))) || '';
  // The YouTube video id (notes carry it under video).
  const video = (n && n.videoId) || (n && n.video && n.video.id) || '';
  // Return all ids the matcher could need.
  return { course, lecture, video };
}

// Compare two note/file descriptors for the same video.
function sameVideo(a, b) {
  // Read the ids from both shapes.
  const ia = noteVideoId(a);
  const ib = noteVideoId(b);
  // Both must be on the same platform.
  if ((a.platform || 'youtube') !== (b.platform || 'youtube')) return false;
  // Compare by the platform's stable id.
  if ((a.platform || 'youtube') === 'udemy') {
    // A match requires both course and lecture ids to agree.
    return !!ia.course && !!ib.course && !!ia.lecture && !!ib.lecture &&
      ia.course === ib.course && ia.lecture === ib.lecture;
  }
  // YouTube matches on the video id.
  // Only a real id counts as a match.
  return !!ia.video && !!ib.video && ia.video === ib.video;
}

// ----------------------- Normalization / schema -----------------------
//
// Every note carries `schemaVersion`. Interpreting fields:
//   - A field ABSENT from an older record is an OPTIONAL field (documented
//     default), never an invalid record (backward compatibility contract).
//   - NORMALIZE is additive and idempotent: it fills defaults but never deletes
//     or reorders anything, and running it twice is a no-op.
//   - Moment identity is DETERMINISTIC before it ever falls back to a uuid: the
//     filename's embedded moment id, else the filename base, else noteId+index.
//     No moment is ever dropped for lacking a string id.
//   - ChatGPT moments keep timestamp 0 and their wall-clock humanTime; a fake
//     video timestamp is never invented for them.

// Turn seconds into an "MM:SS" clock label (display only - filenames use "-").
function formatSeconds(seconds) {
  seconds = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Determine a moment's identity deterministically (Fix: a missing/invalid `id`
// can no longer cause the moment to be dropped).
function deriveMomentId(raw, note, index) {
  // The stored id wins when it is a usable string.
  if (raw && typeof raw.id === 'string' && raw.id) return raw.id;
  // A filename-derived id (MM-SS_<id>: the id after the underscore).
  const rel = (raw && raw.relativePath) || (raw && raw.imageFileName) || '';
  if (rel) {
    const base = rel.split('/').pop().replace(/\.[^.]+$/, '');
    const m = base.match(/^(\d+)-(\d{2})_(.+)$/) || base.match(/^H-(\d+)-(\d{2})_(.+)$/);
    if (m && m[3]) return m[3];
    if (base) return base;
  }
  // noteId + position is stable for the stored array.
  if (note && note.id) return `${note.id}::moment-${Math.max(0, index || 0)}`;
  // Absolute last resort (a fresh moment): a uuid keeps it unique.
  return `moment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Normalize a single moment into the canonical shape. Never drops the moment.
// The screenshot field (data/blob/remote URLs) is passed through untouched -
// normalization only fills the METADATA the renderer and checker depend on.
export function normalizeMoment(raw, index, note) {
  // Non-object garbage is dropped.
  if (!raw || typeof raw !== 'object') return null;
  const chat = !!note && note.platform === 'chatgpt';
  // ChatGPT moments have NO video position: 0, never invented.
  const ts = (typeof raw.timestamp === 'number' && Number.isFinite(raw.timestamp) && raw.timestamp >= 0)
    ? raw.timestamp
    : 0;
  const id = deriveMomentId(raw, note, index);
  // Wall-clock for ChatGPT, derived video time otherwise.
  const humanTime = (typeof raw.humanTime === 'string' && raw.humanTime)
    ? raw.humanTime
    : (chat ? '' : formatSeconds(ts));
  const rel = (typeof raw.relativePath === 'string') ? raw.relativePath : '';
  const createdAt = (typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)) ? raw.createdAt : Date.now();
  const updatedAt = (typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)) ? raw.updatedAt : createdAt;
  return {
    ...raw,
    // Canonical metadata (stable defaults, never destructive).
    id,
    timestamp: ts,
    humanTime,
    annotation: (typeof raw.annotation === 'string') ? raw.annotation : '',
    platform: (typeof raw.platform === 'string') ? raw.platform : (note ? note.platform || '' : ''),
    videoId: (typeof raw.videoId === 'string') ? raw.videoId : '',
    videoUrl: (typeof raw.videoUrl === 'string') ? raw.videoUrl : '',
    relativePath: rel,
    imageFileName: (typeof raw.imageFileName === 'string') ? raw.imageFileName : '',
    sortOrder: (typeof raw.sortOrder === 'number' && Number.isFinite(raw.sortOrder)) ? raw.sortOrder : (index || 0),
    saveState: (typeof raw.saveState === 'string') ? raw.saveState : '',
    createdAt,
    updatedAt,
    // Keep whatever screenshot reference the record carried (optional by contract).
    screenshot: raw.screenshot || undefined
  };
}

// Normalize a note into the canonical shape. Fill-in only:
// missing fields get documented defaults, present fields are never altered, and
// no moment or note is ever removed because a field is absent or malformed.
export function normalizeNote(raw, index) {
  // Non-object garbage is dropped.
  if (!raw || typeof raw !== 'object') return null;
  // A newer schema must never be downgraded by this app's normalization.
  if (typeof raw.schemaVersion === 'number' && raw.schemaVersion > NOTE_SCHEMA_VERSION) return raw;
  const id = (typeof raw.id === 'string' && raw.id) ? raw.id : `note-${Math.max(0, index || 0)}-${(raw.video && raw.video.id) || raw.courseId || 'x'}`;
  const platform = ['youtube', 'udemy', 'chatgpt'].includes(raw.platform)
    ? raw.platform
    : (raw.course ? 'udemy' : 'youtube');
  const moments = (Array.isArray(raw.moments) ? raw.moments : [])
    .map((m, i) => normalizeMoment(m, i, { ...raw, id, platform }))
    .filter(Boolean);
  const createdAt = (typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)) ? raw.createdAt : Date.now();
  const updatedAt = (typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)) ? raw.updatedAt : createdAt;
  const textBlocks = (Array.isArray(raw.textBlocks) ? raw.textBlocks : [])
    .filter((block) => block && typeof block === 'object')
    .map((block, i) => ({
      ...block,
      id: (typeof block.id === 'string' && block.id) ? block.id : `${id}::text-${i}`,
      text: (typeof block.text === 'string') ? block.text : '',
      createdAt: (typeof block.createdAt === 'number' && Number.isFinite(block.createdAt)) ? block.createdAt : createdAt,
      updatedAt: (typeof block.updatedAt === 'number' && Number.isFinite(block.updatedAt)) ? block.updatedAt : updatedAt
    }));
  const validMomentIds = new Set(moments.map((moment) => String(moment.id)));
  const validTextIds = new Set(textBlocks.map((block) => String(block.id)));
  const contentOrder = Array.isArray(raw.contentOrder)
    ? raw.contentOrder.filter((entry) => entry && ['moment', 'text'].includes(entry.type) && typeof entry.id === 'string')
        .map((entry) => ({ type: entry.type, id: entry.id }))
    : [
        ...moments.map((moment, index) => ({
          type: 'moment', id: String(moment.id),
          createdAt: Number.isFinite(moment.createdAt) ? moment.createdAt : createdAt,
          fallback: index
        })),
        ...textBlocks.map((block, index) => ({
          type: 'text', id: String(block.id),
          createdAt: Number.isFinite(block.createdAt) ? block.createdAt : createdAt,
          fallback: moments.length + index
        }))
      ].sort((a, b) => (a.createdAt - b.createdAt) || (a.fallback - b.fallback))
        .map(({ type, id }) => ({ type, id }));
  const seenContent = new Set();
  const normalizedContentOrder = contentOrder.filter((entry) => {
    const valid = entry.type === 'moment' ? validMomentIds.has(entry.id) : validTextIds.has(entry.id);
    const key = entry.type + ':' + entry.id;
    if (!valid || seenContent.has(key)) return false;
    seenContent.add(key);
    return true;
  });
  for (const moment of moments) {
    const key = 'moment:' + String(moment.id);
    if (!seenContent.has(key)) { normalizedContentOrder.push({ type: 'moment', id: String(moment.id) }); seenContent.add(key); }
  }
  for (const block of textBlocks) {
    const key = 'text:' + String(block.id);
    if (!seenContent.has(key)) { normalizedContentOrder.push({ type: 'text', id: String(block.id) }); seenContent.add(key); }
  }
  return {
    ...raw,
    schemaVersion: NOTE_SCHEMA_VERSION,
    id,
    title: (typeof raw.title === 'string' && raw.title.trim()) ? raw.title : 'Untitled',
    platform,
    moments,
    textBlocks,
    contentOrder: normalizedContentOrder,
    createdAt,
    updatedAt,
    video: raw.video && typeof raw.video === 'object'
      ? { id: raw.video.id || raw.videoId || '', title: raw.video.title || '', url: raw.video.url || raw.videoUrl || '' }
      : { id: raw.videoId || '', title: '', url: raw.videoUrl || '' }
  };
}

// Normalize an array of notes (idempotent, non-destructive).
export function normalizeNotes(notes) {
  return (Array.isArray(notes) ? notes : [])
    .map((n, i) => normalizeNote(n, i))
    .filter(Boolean);
}

// Rebuild a note object from a scanned file (plus optional folder sidecar).
// `mtimes` (when given) is the group's { min, max } file modified times in ms,
// used INSTEAD OF Date.now() so a rebuilt note's timestamps are deterministic
// (Fix: a Rebuild on two installs produces identical createdAt/updatedAt).
function buildPlaceholderNote(first, sidecar, key, mtimes) {
  // The video-level label used only when the title is genuinely unavailable.
  let label = first.videoId || 'video';
  if (first.platform === 'udemy') label = first.courseId || 'course';
  else if (first.platform === 'chatgpt') label = first.videoId || 'conversation';
  // Keep the SAME note id the file already carries (v2). Only legacy v1 files
  // have no note id, so they get a deterministic "recovered-<key>" id instead.
  const id = first.noteId || `recovered-${key.replace(/[^a-zA-Z0-9]/g, '-')}`;
  // Prefer the real title from the filesystem sidecar; otherwise fall back.
  let title = (sidecar && typeof sidecar.title === 'string' && sidecar.title.trim())
    ? sidecar.title.trim()
    : (first.noteId ? '' : `Recovered ${label}`);
  if (!title) {
    // v2 without a sidecar: the note id is known but no title survived.
    title = `Recovered ${first.noteId}`;
  }
  // Deterministic creation/last-change: the sidecar values win (they were
  // persisted metadata), otherwise the earliest/latest file mtime in the note's
  // folder. NO Date.now() anywhere on this path.
  const createdAt = (sidecar && sidecar.createdAt) || (mtimes && mtimes.min) || first.createdAt || 0;
  const updatedAt = (sidecar && sidecar.updatedAt) || (mtimes && mtimes.max) || createdAt || first.updatedAt || 0;
  // The recovered note.
  const note = {
    // The canonical schema version (format/schema contract).
    schemaVersion: NOTE_SCHEMA_VERSION,
    // The stable note id restored from the path (or the deterministic legacy id).
    id,
    // Its display title.
    title,
    // Which site it came from.
    platform: first.platform,
    // Info about the video.
    video: {
      // The video/lecture id.
      id: first.videoId,
      // The title (only known when a sidecar survived).
      title: (sidecar && sidecar.video && typeof sidecar.video.title === 'string') ? sidecar.video.title : '',
      // The url (only known when a sidecar survived).
      url: (sidecar && sidecar.video && typeof sidecar.video.url === 'string') ? sidecar.video.url : ''
    },
    // The top-level platform identity for ChatGPT recovery.
    conversationId: first.videoId || (sidecar && sidecar.conversationId) || '',
    // No moments yet (we add them below).
    moments: [],
    // Restore text blocks and their mixed ordering from the local sidecar.
    textBlocks: Array.isArray(sidecar && sidecar.textBlocks) ? sidecar.textBlocks.map((block) => ({ ...block })) : [],
    contentOrder: Array.isArray(sidecar && sidecar.contentOrder) ? sidecar.contentOrder.map((entry) => ({ ...entry })) : [],
    // When it was created.
    createdAt,
    // When it was last changed.
    updatedAt
  };
  // Udemy placeholders also carry course and lecture ids (from the path and,
  // where available, the sidecar) so future recovery and matching keep working.
  if (first.platform === 'udemy') {
    // The course identity.
    note.course = {
      id: first.courseId,
      slug: (sidecar && sidecar.course && sidecar.course.slug) || first.courseId,
      title: (sidecar && sidecar.course && typeof sidecar.course.title === 'string') ? sidecar.course.title : ''
    };
    // The lecture identity.
    note.lecture = {
      id: first.lectureId,
      title: (sidecar && sidecar.lecture && typeof sidecar.lecture.title === 'string') ? sidecar.lecture.title : ''
    };
  }
  // Hand back the reconstructed note.
  return note;
}

// Merge parsed files (and optional sidecar metadata) into a notes library.
// Pure function: it never touches chrome.storage, IndexedDB, or the filesystem,
// so its rules stay deterministic and it can be exercised in isolation.
// `mtimes` (optional) maps a relative path to its file modification time; every
// recovered moment/note derives createdAt/updatedAt from it instead of Date.now().
export function mergeScannedFiles(parsedFiles, sidecars, existingNotes, mtimes) {
  // The list of notes we end up with.
  const notes = Array.isArray(existingNotes) ? existingNotes.map((n) => ({ ...n, moments: [...(n.moments || [])], textBlocks: [...(n.textBlocks || [])] })) : [];
  // How many moments were freshly recovered.
  let added = 0;
  // How many placeholder notes were created.
  let createdNotes = 0;
  // Lookup so existing notes are found by their stable id immediately.
  const byId = new Map(notes.map((n) => [n.id, n]));

  // Group the parsed paths so each note gets its moments together.
  const groups = new Map();
  for (const f of parsedFiles || []) {
    // Skip manual page screenshots and anything we can't link to a moment.
    if (f.manualShot || !f.momentId) continue;
    // The grouping key: a PER-NOTE key when the v2 layout carries a note id,
    // otherwise the legacy video-level key for v1 layout.
    const key = f.noteId
      ? (f.platform === 'udemy'
        ? `udemy|${f.courseId}|${f.lectureId}|${f.noteId}`
        : `${f.platform}|${f.videoId}|${f.noteId}`)
      : (f.platform === 'udemy'
        ? `udemy|${f.courseId}|${f.lectureId}`
        : `${f.platform}|${f.videoId}`);
    // Append to the group.
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }

  // Walk each group and stitch its files back into a note.
  for (const [key, group] of groups) {
    // The first file tells us the note/video identity.
    const first = group[0];
    // The deterministic time range of the note's files on disk (used instead of
    // Date.now() for recovered notes and moments).
    let minM = Infinity;
    let maxM = 0;
    if (mtimes) {
      for (const f of group) {
        const t = mtimes.get(f.relativePath) || 0;
        if (t) {
          if (t < minM) minM = t;
          if (t > maxM) maxM = t;
        }
      }
    }
    const noteRange = { min: minM === Infinity ? 0 : minM, max: maxM || 0 };

    // Find the note this group belongs to. v2 groups carry an exact note id in
    // the path, so they match ONLY that id (never a same-video fallback: two
    // notes about the same video must always stay separate). Legacy v1 files
    // have no note id; they are attributed to the SINGLE existing note that
    // covers the same video, and never guessed when two or more notes match.
    let note = null;
    if (first.noteId) {
      note = byId.get(first.noteId);
    } else {
      // Legacy v1 file: how many current notes cover this video?
      const matches = notes.filter((n) => sameVideo(n, first));
      if (matches.length === 1) {
        // Exactly one owner: attach deterministically.
        note = matches[0];
      } else if (matches.length > 1) {
        // AMBIGUOUS: never glue v1 leftovers onto an arbitrary note. Future
        // v2 rebuilds could bounce them around; instead they get their own
        // explicit "Recovered" bucket with a stable key, reported to the user.
        const candidate = buildPlaceholderNote(first, null, key, noteRange);
        // The bucket id is deterministic from the grouping key, so a bucket
        // created by an EARLIER scan is reused rather than re-created (a rerun
        // of merge/rebuild must stay idempotent).
        const existingBucket = byId.get(candidate.id);
        if (existingBucket) {
          note = existingBucket;
        } else {
          note = candidate;
          notes.push(note);
          byId.set(note.id, note);
          createdNotes++;
        }
      }
      // matches.length === 0 -> a placeholder is built below.
    }

    // If no note exists yet, build a minimal placeholder.
    if (!note) {
      // The sidecar metadata for this note id (when it exists on disk).
      const sidecar = (sidecars && sidecars.get(first.noteId)) || null;
      // Reconstruct the note (v2 keeps its id; only legacy gets a placeholder).
      note = buildPlaceholderNote(first, sidecar, key, noteRange);
      // Count it as a created note.
      notes.push(note);
      byId.set(note.id, note);
      createdNotes++;
    }

    // Recover every scanned file into the note.
    for (const f of group) {
      // Skip a moment we already have.
      if (note.moments.some((m) => m.id === f.momentId)) continue;
      // The note's sidecar (when it exists) may carry richer metadata for this
      // exact moment - annotation, real timestamp, ordering, capture times -
      // which a filename alone cannot hold. Prefer it over derived values.
      const sidecar = (sidecars && sidecars.get(f.noteId)) || (first.noteId && sidecars && sidecars.get(first.noteId)) || null;
      const meta = (sidecar && Array.isArray(sidecar.moments))
        ? sidecar.moments.find((m) => m && m.id === f.momentId)
        : null;
      // The file's own modified time (deterministic recovery timestamps).
      const fileMtime = (mtimes && mtimes.get(f.relativePath)) || noteRange.max || 0;
      // When it was captured (deterministic: sidecar, else the file's mtime).
      const createdAt = (meta && meta.createdAt) || fileMtime || 0;
      // When it was last changed.
      const updatedAt = (meta && meta.updatedAt) || fileMtime || createdAt;
      // Rebuild the moment from the file metadata.
      note.moments.push({
        // The moment's unique id (from the file name).
        id: f.momentId,
        // The timestamp (sidecar value when known).
        timestamp: (meta && Number.isFinite(meta.timestamp)) ? meta.timestamp : (f.timestamp || 0),
        // The friendly time text.
        humanTime: (meta && meta.humanTime) || f.humanTime || '',
        // The moment's own video snapshot (recovered from the sidecar when it
        // was stored there; absent for moments created before this feature).
        platform: (meta && typeof meta.platform === 'string') ? meta.platform : '',
        videoId: (meta && typeof meta.videoId === 'string') ? meta.videoId : '',
        videoUrl: (meta && typeof meta.videoUrl === 'string') ? meta.videoUrl : '',
        // Restore the annotation that existed before the rebuild.
        annotation: (meta && meta.annotation) || '',
        // The file this screenshot lives at.
        imageFileName: f.fileName,
        // The relative path into the chosen folder.
        relativePath: f.relativePath,
        // Where the moment sits in the note (sidecar order when known, so a
        // saved reorder survives a rebuild). Filename-only recoveries leave
        // the field UNSET: the sorting pass below (and the sidebar renderer)
        // treat a missing sortOrder as "goes last", keeping v1 leftovers
        // after any reordered v2 moments instead of letting filename order
        // shuffle them ahead.
        sortOrder: (meta && Number.isFinite(meta.sortOrder)) ? meta.sortOrder : undefined,
        // When it was captured.
        createdAt,
        // When it was last changed.
        updatedAt,
        // Whether the screenshot is genuinely on disk.
        saveState: 'saved'
      });
      // Count the recovery.
      added++;
    }
  }

  // Restore the user's saved ordering after a rebuild/recovery: sort every
  // note's moments by their persisted sortOrder (moments without a usable
  // sortOrder sort LAST, stable so equal keys keep their stored order). The
  // sidecars record those sortOrders, so a dragged reorder now survives a
  // storage wipe + rebuild instead of snapping back to filename order. Notes
  // built purely from v1 filenames carry no sortOrder at all and keep their
  // scan order.
  for (const note of notes) {
    const moments = note.moments || [];
    if (moments.length < 2 || !moments.some((m) => m && Number.isFinite(m.sortOrder))) continue;
    note.moments = moments
      .map((m, index) => ({ m, index, sort: m && Number.isFinite(m.sortOrder) ? m.sortOrder : Number.MAX_SAFE_INTEGER }))
      .sort((a, b) => (a.sort - b.sort) || (a.index - b.index))
      .map((x) => x.m);
  }

  // Sidecars are also a recovery source for text-only notes with no screenshot
  // files to create a group above.
  for (const [noteId, sidecar] of (sidecars || new Map())) {
    if (!noteId || !sidecar) continue;
    const blocks = Array.isArray(sidecar.textBlocks) ? sidecar.textBlocks.map((block) => ({ ...block })) : [];
    let note = byId.get(noteId);
    if (note) {
      // The selected local folder is the authoritative rebuild source.
      if (Array.isArray(sidecar.textBlocks)) note.textBlocks = blocks;
      if (Array.isArray(sidecar.contentOrder)) note.contentOrder = sidecar.contentOrder.map((entry) => ({ ...entry }));
      continue;
    }
    if (blocks.length === 0) continue;
    const platform = ['youtube', 'udemy', 'chatgpt'].includes(sidecar.platform)
      ? sidecar.platform
      : (sidecar.course ? 'udemy' : 'youtube');
    const first = {
      noteId,
      platform,
      videoId: (sidecar.video && sidecar.video.id) || sidecar.conversationId || (sidecar.course && sidecar.course.id) || '',
      courseId: (sidecar.course && sidecar.course.id) || '',
      lectureId: (sidecar.lecture && sidecar.lecture.id) || ''
    };
    note = buildPlaceholderNote(first, sidecar, `sidecar|${noteId}`, {
      min: sidecar.createdAt || 0,
      max: sidecar.updatedAt || 0
    });
    note.textBlocks = blocks;
    notes.push(note);
    byId.set(noteId, note);
    createdNotes++;
  }

  // Hand everything back to the caller.
  return { notes, added, createdNotes };
}

// Match scanned files back to notes, building placeholder notes for orphans.
// Never deletes anything - it only adds missing moments/notes. Understands the
// v2 per-note folders, the legacy v1 shared folders, and the manual page
// screenshot folder. Reads the `_clipnote-note.json` sidecars so titles, video
// ids and course/lecture metadata can be restored from the filesystem alone.
// Also recovers independent manual screenshots (root `_clipnote-manual.json`
// index + any Screenshots/ files) so BOTH installs share the same library.
export async function rebuildLibrary(existingNotes) {
  // Pull every image path + its modified time (deterministic recovered dates).
  const stats = await listImageStats();
  const paths = stats.map((s) => s.relativePath);
  const mtimes = new Map(stats.map((s) => [s.relativePath, s.lastModified]));
  // Parse each path into structured metadata.
  const files = paths.map(parseRelativePath);
  // Any note metadata sidecars found on disk.
  const sidecars = await listNoteSidecars();
  // Run the pure merge (existing notes win on title/id/time), then stamp the
  // canonical schema version on the result (normalization is idempotent).
  const merged = mergeScannedFiles(files, sidecars, existingNotes, mtimes);
  const notes = normalizeNotes(merged.notes);
  // Recover manual webpage screenshots too (legacy browser storage + on-disk
  // index + any files the index lost).
  const manualShots = await recoverManualShots();
  return { notes, added: merged.added, createdNotes: merged.createdNotes, manualShots };
}

// Persist a small metadata file (sidecar) into the note's own folder so the
// filesystem can stand alone as a recovery source. Best-effort: a failure here
// must never block a capture, an annotation save, or a rename.
//
// v5 adds standalone text blocks to the local-folder sidecar, allowing text-only
// notes to be recovered after browser storage is cleared. Earlier sidecars remain
// readable.
export async function saveNoteSidecar(note) {
  // A note id is required for the mapping to be deterministic.
  if (!note || !note.id) return false;
  // Make sure we have a usable folder with write access.
  const entry = await getFolderEntry();
  // Nothing to write when the folder is missing or unreachable.
  if (!entry.handle || entry.permission !== 'granted') return false;
  // The stable identity + human metadata to preserve on disk.
  const data = {
    format: 'clipnote-note',
    version: SIDECAR_VERSION,
    // The canonical schema version (the in-browser note records share it).
    schemaVersion: NOTE_SCHEMA_VERSION,
    noteId: note.id,
    title: typeof note.title === 'string' ? note.title : '',
    platform: note.platform || (note.course ? 'udemy' : 'youtube'),
    createdAt: note.createdAt || Date.now(),
    updatedAt: note.updatedAt || Date.now(),
    video: note.video ? { id: note.video.id || '', title: note.video.title || '', url: note.video.url || '' } : null,
    course: note.course ? { id: note.course.id || '', slug: note.course.slug || '', title: note.course.title || '' } : null,
    lecture: note.lecture ? { id: note.lecture.id || '', title: note.lecture.title || '' } : null,
    // Standalone text blocks are plain local text (no screenshot/blob data).
    textBlocks: (note.textBlocks || []).map((block, index) => ({
      id: (block && typeof block.id === 'string') ? block.id : `${note.id}::text-${index}`,
      text: (block && typeof block.text === 'string') ? block.text : '',
      createdAt: (block && Number.isFinite(block.createdAt)) ? block.createdAt : 0,
      updatedAt: (block && Number.isFinite(block.updatedAt)) ? block.updatedAt : 0
    })),
    // The mixed timeline stores only item ids; screenshot bytes remain in files.
    contentOrder: (Array.isArray(note.contentOrder) ? note.contentOrder : [
      ...(note.moments || []).map((moment) => ({ type: 'moment', id: String(moment.id) })),
      ...(note.textBlocks || []).map((block) => ({ type: 'text', id: String(block.id) }))
    ]).map((entry) => ({ type: entry.type, id: String(entry.id) })),
    // Every moment, minus its screenshot blob, mapped back to its file version.
    moments: (note.moments || []).map((m) => ({
      id: (m && m.id) || '',
      timestamp: (m && Number.isFinite(m.timestamp) && m.timestamp >= 0) ? m.timestamp : 0,
      humanTime: (m && typeof m.humanTime === 'string') ? m.humanTime : '',
      // The moment's own video snapshot (per-moment source video).
      platform: (m && typeof m.platform === 'string') ? m.platform : '',
      videoId: (m && typeof m.videoId === 'string') ? m.videoId : '',
      videoUrl: (m && typeof m.videoUrl === 'string') ? m.videoUrl : '',
      annotation: (m && typeof m.annotation === 'string') ? m.annotation : '',
      imageFileName: (m && typeof m.imageFileName === 'string') ? m.imageFileName : '',
      relativePath: (m && typeof m.relativePath === 'string') ? m.relativePath : '',
      sortOrder: (m && Number.isFinite(m.sortOrder)) ? m.sortOrder : 0,
      createdAt: (m && Number.isFinite(m.createdAt)) ? m.createdAt : 0,
      updatedAt: (m && Number.isFinite(m.updatedAt)) ? m.updatedAt : 0,
      saveState: (m && typeof m.saveState === 'string') ? m.saveState : ''
    }))
  };
  // Guard against any filesystem failure (permission drop, stuck handle, etc.).
  try {
    // The sidecar lives at the root of the note's own folder.
    const fileHandle = await getFileHandleByPath(entry.handle, `${noteFolderRelativePath(note)}/${SIDECAR_NAME}`);
    // Open a writeable stream.
    const writable = await fileHandle.createWritable();
    // Write the compact JSON metadata.
    await writable.write(JSON.stringify(data));
    // Flush it to disk.
    await writable.close();
    // It worked.
    return true;
  } catch (e) {
    // Never let a metadata write take the capture/rename down with it.
    return false;
  }
}

// Walk the whole tree collecting sidecar metadata files.
async function walkSidecars(dirHandle, relativePrefix, out) {
  // Iterate every entry in this directory.
  for await (const [name, entry] of dirHandle.entries()) {
    // Folder entries are walked into.
    if (entry.kind === 'directory') {
      // Recurse with the extended prefix.
      await walkSidecars(entry, relativePrefix ? `${relativePrefix}/${name}` : name, out);
    } else if (name === SIDECAR_NAME) {
      // Remember the sidecar's location.
      out.push(relativePrefix ? `${relativePrefix}/${name}` : name);
    }
  }
}

// Read every note sidecar in the chosen folder as a Map<noteId, sidecarData>.
export async function listNoteSidecars() {
  // Guard against errors.
  try {
    // Make sure we have a folder.
    const entry = await getFolderEntry();
    // Without a handle there is nothing to read.
    if (!entry.handle) return new Map();
    // Collect every sidecar path.
    const found = [];
    // Walk the whole tree.
    await walkSidecars(entry.handle, '', found);
    // The lookup table we return.
    const map = new Map();
    // Parse each file.
    for (const relPath of found) {
      try {
        // The sidecar's file handle.
        const fileHandle = await getFileHandleByPath(entry.handle, relPath);
        // The File object for it.
        const file = await fileHandle.getFile();
        // Its JSON text (compact).
        const data = JSON.parse(await file.text());
        // Only keep valid note sidecars.
        if (data && typeof data.noteId === 'string' && data.noteId) {
          // The first copy wins when duplicates somehow exist.
          if (!map.has(data.noteId)) map.set(data.noteId, { ...data, sidecarPath: relPath });
        }
      } catch (e) { /* skip unreadable sidecars */ }
    }
    // Hand the map over.
    return map;
  } catch (e) {
    // A scan must never crash the UI.
    return new Map();
  }
}

// ----------------------- Manual screenshot index -----------------------
//
// Independent manual webpage screenshots live under `Screenshots/<Platform>/…`
// on the SHARED filesystem. Because `clipnote_manual_shots` is per-extension
// browser storage, the Web Store and local installations would otherwise never
// discover each other's metadata. The root-level `_clipnote-manual.json` index
// is that shared bridge: it is written whenever the shots change and read
// during storage rebuilds so both installs recover the same manual library.

// Write the root manual-shots index (best-effort; never blocks the UI).
export async function saveManualShotsIndex(shots) {
  // Make sure we have a usable folder with write access.
  const entry = await getFolderEntry();
  // Nothing to write when the folder is missing or unreachable.
  if (!entry.handle || entry.permission !== 'granted') return false;
  // The index data: every shot minus its inline screenshot blob.
  const data = {
    format: 'clipnote-manual',
    version: 1,
    shots: (Array.isArray(shots) ? shots : [])
      .filter((s) => s && s.id)
      .map((s) => {
        const { screenshot, ...rest } = s;
        return rest;
      })
  };
  // Guard against filesystem failures.
  try {
    // The index file lives at the root of the chosen folder.
    const fileHandle = await getFileHandleByPath(entry.handle, MANUAL_INDEX_NAME);
    // Open a writeable stream.
    const writable = await fileHandle.createWritable();
    // Write the compact JSON.
    await writable.write(JSON.stringify(data));
    // Flush it to disk.
    await writable.close();
    // It worked.
    return true;
  } catch (e) {
    // Never let the index write take a shot action down with it.
    return false;
  }
}

// Read the root manual-shots index (array of shot metadata, or []).
export async function readManualShotsIndex() {
  // Guard against errors.
  try {
    // Make sure we have a folder.
    const entry = await getFolderEntry();
    // Without a handle there is nothing to read.
    if (!entry.handle) return [];
    // The index file at the root of the chosen folder.
    const fileHandle = await getFileHandleByPath(entry.handle, MANUAL_INDEX_NAME);
    // The File object for it.
    const file = await fileHandle.getFile();
    // Its JSON text.
    const data = JSON.parse(await file.text());
    // Only keep valid entries.
    if (!data || !Array.isArray(data.shots)) return [];
    return data.shots.filter((s) => s && typeof s.id === 'string' && s.id);
  } catch (e) {
    // A missing/unreadable index just means "nothing indexed yet".
    return [];
  }
}

// Recover the manual screenshot library from the filesystem: the on-disk index
// first (richest metadata), then any Screenshots/ files the index lost (e.g.
// written by an older version or an import). Always returns a flat array of
// shot metadata keyed by id (latest wins per id).
export async function recoverManualShots() {
  // Start from the on-disk index (the cross-install source of truth).
  const indexed = await readManualShotsIndex();
  const byId = new Map(indexed.map((s) => [s.id, s]));
  // Scan the Screenshots/ folder for files not represented in the index yet.
  const paths = await listImagePaths();
  for (const p of paths) {
    // Only the manual top-level folder interests us here.
    if ((p.split('/')[0] || '').toLowerCase() !== 'screenshots') continue;
    // Parse the manual file layout.
    const f = parseRelativePath(p);
    if (!f.manualShot) continue;
    // A manual file has no stable moment id: derive one from the file name.
    const parsedId = f.momentId || p.split('/').pop().replace(/\.[^.]+$/, '');
    // Preserve an existing index entry (metadata wins); otherwise build one.
    if (byId.has(parsedId)) continue;
    // Build a minimal recovery entry from the filename/time.
    const m = p.split('/').pop().match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})_/);
    let createdAt = 0;
    if (m) createdAt = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    byId.set(parsedId, {
      id: parsedId,
      platform: f.platform || 'youtube',
      title: '',
      description: '',
      url: '',
      createdAt: createdAt || (f.createTime || 0),
      imageFileName: f.fileName,
      relativePath: f.relativePath,
      saveState: 'saved',
      recovered: true
    });
  }
  // Deterministic order (newest first), as a plain array.
  return Array.from(byId.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// ----------------------- Library diagnostics -----------------------

// Classify every scanned path and every moment into actionable categories.
// Pure function: `paths` is the parsed file list and `notes` any notes library.
// It lets the Storage page (and tests) explain exactly where a screenshot file
// lives, is missing, or was never saved.
export function classifyLibrary(parsedFiles, notes) {
  // ---- Files ----
  const files = { total: 0, matched: 0, recoverable: 0, orphan: 0, duplicate: 0, invalid: 0, manual: 0 };
  // ---- Moments ----
  const moments = { total: 0, withFile: 0, textOnly: 0, missingFile: 0, pending: 0, failed: 0, recoverable: 0, noScreenshot: 0 };
  // Every moment id known to the library.
  const momentIds = new Set();
  for (const note of notes || []) {
    for (const m of note.moments || []) {
      if (m && m.id) momentIds.add(m.id);
    }
  }
  // Failures are counted once per unique moment/file set.
  const fileByMoment = new Map();
  for (const f of parsedFiles || []) {
    files.total++;
    if (f.manualShot) {
      // Independent webpage screenshots (never note moments).
      files.manual++;
      continue;
    }
    if (!f.momentId) {
      // A file we own but cannot attribute to any moment.
      files.invalid++;
      continue;
    }
    if (fileByMoment.has(f.momentId)) {
      // Two files claim the same moment: only one can be authoritative.
      files.duplicate++;
    } else {
      // The first occurrence is the authoritative file.
      fileByMoment.set(f.momentId, f.relativePath);
    }
    if (momentIds.has(f.momentId)) {
      // A real moment in the library references this exact file.
      files.matched++;
    } else {
      // A file on disk whose moment is not (yet) in the library.
      files.recoverable++;
    }
  }
  // ---- Moments ----
  for (const note of notes || []) {
    for (const m of note.moments || []) {
      if (!m || typeof m !== 'object') continue;
      moments.total++;
      const hasFile = !!(m.relativePath && fileByMoment.get(m.id) === m.relativePath);
      if (hasFile) {
        moments.withFile++;
      } else if (m.relativePath) {
        // A recorded path that is NOT among the scanned files: missing on disk.
        moments.missingFile++;
      } else if (m.screenshot && m.screenshot.type === 'data-url' && m.screenshot.dataUrl && !m.imageFileName) {
        // Inline in browser storage, never written to the folder.
        moments.pending++;
      } else if (m.saveState === 'failed') {
        // A write genuinely failed (user sees Retry).
        moments.failed++;
      } else if (m.screenshot) {
        // A remote/blob URL that may or may not resolve - not a real file yet.
        moments.pending++;
      } else {
        // No screenshot reference at all: a pure-text (annotation-only) moment.
        moments.textOnly++;
        if (!m.annotation) moments.noScreenshot++;
      }
    }
  }
  // Return the two breakdowns.
  return { files, moments };
}

// Analyze the current library against an image scan. Async convenience wrapper
// over classifyLibrary (which stays a pure function for tests).
export async function analyzeLibrary(notes) {
  // Pull every image path in the folder.
  const paths = await listImagePaths();
  // Parse each path into structured metadata.
  const files = paths.map(parseRelativePath);
  // Classify and hand it back.
  return classifyLibrary(files, notes);
}

// ----------------------- Migration helpers -----------------------

// Return how many moments still have an inline screenshot that has not been
// written to the folder yet.
export function countPendingToFolder(notes) {
  // Walk every moment and count the ones waiting for a file write.
  let count = 0;
  // Loop over the notes.
  for (const note of notes || []) {
    // Loop over the moments.
    for (const m of (note.moments || [])) {
      // Count inline screenshots that never reached the folder.
      if (m.screenshot && m.screenshot.type === 'data-url' && !m.imageFileName) count++;
    }
  }
  // Return the tally.
  return count;
}

// Write every pending inline screenshot into the folder (controlled migration).
// The IndexedDB copy is kept until each file has been verified on disk.
export async function migratePendingToFolder(notes) {
  // How many files were written successfully.
  let written = 0;
  // How many failed.
  let failed = 0;
  // Loop over the notes.
  for (const note of notes || []) {
    // Loop over the moments.
    for (const m of (note.moments || [])) {
      // Skip anything that already has a file or no inline screenshot.
      if (m.imageFileName || !m.screenshot || m.screenshot.type !== 'data-url') continue;
      // Try to write the original file.
      try {
        // Write it to the folder at its original quality.
        const relativePath = await saveScreenshotFile({ note, moment: m });
        // Stamp the file reference on the moment only after success.
        m.relativePath = relativePath;
        // The file name comes from the end of the relative path.
        m.imageFileName = relativePath.split('/').pop();
        // Mark the moment as saved.
        m.saveState = 'saved';
        // Forget any previous save error.
        m.saveError = null;
        // Count it.
        written++;
      } catch (e) {
        // Leave the moment as it is so a retry can fix it later.
        m.saveState = 'failed';
        // Remember why it failed.
        m.saveError = e && e.message ? String(e.message) : 'Folder write failed.';
        // Count it.
        failed++;
      }
    }
    // Once the note's folder exists on disk, stamp it with its metadata so the
    // filesystem stands alone as a recovery source.
    if (note.id) await saveNoteSidecar(note);
  }
  // Report how the migration went.
  return { written, failed };
}