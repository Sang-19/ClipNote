// ClipNote audit-fix verification suite.
// Exercises the PURE helpers of local-storage.js that were changed by the
// 14-finding audit fixes: schema normalization (v4), deterministic moment ids,
// non-destructive migration, ChatGPT wall-clock preservation, deterministic
// rebuild timestamps, manual-shot recovery classification, and the blob-URL
// sweep/revoke invariants (in-use URLs are never revoked).
//
// Run: node tests/clipnote-audit-fixes.test.mjs

import assert from 'node:assert/strict';
import {
  NOTE_SCHEMA_VERSION,
  noteFolderRelativePath,
  relativePathForMoment,
  parseRelativePath,
  normalizeNote,
  normalizeNotes,
  normalizeMoment,
  mergeScannedFiles,
  classifyLibrary,
  countPendingToFolder,
  hasBlobUrl,
  safeGetBlobUrl,
  markBlobUrlsInUse,
  sweepBlobUrls,
  revokeBlobUrl,
  revokeAllBlobUrls,
  debugSeedBlobUrl,
} from '../local-storage.js';

// ---------------------------------------------------------------- helpers

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push(`${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`);
  }
}

// A URL stub so blob functions (which call global URL) run inside Node.
function withUrlStub(fn) {
  const revoked = [];
  const created = [];
  globalThis.URL = {
    createObjectURL: (b) => {
      const u = `blob:clipnote-test-${created.length}`;
      created.push(u);
      return u;
    },
    revokeObjectURL: (u) => revoked.push(u),
  };
  fn(revoked, created);
  return { revoked, created };
}

const YT_NOTE = (over = {}) => ({
  schemaVersion: 4,
  id: 'note-yt-1',
  title: 'My Tube Note',
  platform: 'youtube',
  createdAt: 1000,
  updatedAt: 2000,
  video: { id: '9bZkp7q19f0', title: 'A Video', url: 'https://www.youtube.com/watch?v=9bZkp7q19f0' },
  moments: [{
    id: 'mom-a',
    timestamp: 61,
    humanTime: '01:01',
    annotation: '',
    relativePath: 'YouTube/9bZkp7q19f0/note-yt-1/01-01_mom-a.jpg',
    imageFileName: '01-01_mom-a.jpg',
    sortOrder: 0,
    createdAt: 1500,
    updatedAt: 1500,
    saveState: 'saved',
  }],
  ...over,
});

// ---------------------------------------------------------------- Fix 6/7/13

test('normalizeNote stamps schemaVersion 4 and is idempotent', () => {
  const raw = { id: 'x', title: 'T', platform: 'youtube', moments: [] };
  const once = normalizeNote(raw, 0);
  assert.equal(once.schemaVersion, NOTE_SCHEMA_VERSION);
  const twice = normalizeNote(once, 0);
  assert.deepEqual(twice, once);
});

test('normalizeNote never drops a moment missing its id (deterministic id from filename)', () => {
  const raw = {
    id: 'n1', title: 'T', platform: 'youtube', video: { id: 'v1' },
    moments: [{
      // NO id at all - previously silently dropped by sanitizeMoment.
      timestamp: 90,
      relativePath: 'YouTube/v1/n1/01-30_saved-moment.jpg',
      imageFileName: '01-30_saved-moment.jpg',
    }],
  };
  const note = normalizeNote(raw, 0);
  assert.equal(note.moments.length, 1, 'moment must survive normalization');
  assert.equal(note.moments[0].id, 'saved-moment', 'id derived deterministically from the filename');
});

test('normalizeNote gives a missing-id moment a noteId+index id when no filename exists', () => {
  const raw = {
    id: 'n9', title: 'T', platform: 'youtube', video: { id: 'v9' },
    moments: [{ timestamp: 5, humanTime: '0:05' }],
  };
  const note = normalizeNote(raw, 0);
  assert.equal(note.moments.length, 1);
  assert.equal(note.moments[0].id, 'n9::moment-0');
});

test('moments never dropped for missing optional fields (annotation, platform, videoId)', () => {
  const raw = {
    id: 'n2', title: 'T', platform: 'udemy',
    course: { id: 'c1' }, lecture: { id: 'l1' },
    moments: [{ id: 'm1', timestamp: 10 }],
  };
  const note = normalizeNote(raw, 0);
  assert.equal(note.moments.length, 1);
  const m = note.moments[0];
  assert.equal(m.annotation, '');
  assert.equal(m.humanTime, '00:10');
  assert.equal(typeof m.videoId, 'string');
  assert.equal(note.createdAt > 0, true);
});

test('ChatGPT timestamp stays 0 and wall-clock humanTime is preserved (no fake time invented)', () => {
  const raw = {
    id: 'chat-1', title: 'GPT', platform: 'chatgpt',
    video: { id: 'conv-abc' },
    moments: [{ id: 'cm1', timestamp: 0, humanTime: '14:31' }],
  };
  const note = normalizeNote(raw, 0);
  const m = note.moments[0];
  assert.equal(m.timestamp, 0);
  assert.equal(m.humanTime, '14:31');
});

test('normalizes a missing humanTime on a video platform (derived, deterministic)', () => {
  const raw = { id: 'n3', title: 'T', platform: 'youtube', video: { id: 'v3' }, moments: [{ id: 'm1', timestamp: 125 }] };
  const note = normalizeNote(raw, 0);
  assert.equal(note.moments[0].humanTime, '02:05', 'matches the sidebar formatTimestamp style (MM:SS)');
});

test('a newer schema is never downgraded by normalization', () => {
  const raw = { id: 'future', schemaVersion: 99, title: 'F', platform: 'youtube', moments: [] };
  const note = normalizeNote(raw, 0);
  assert.equal(note.schemaVersion, 99);
});

test('normalizeNotes(normalizeNotes(x)) is identical to normalizeNotes(x)', () => {
  const lib = [YT_NOTE(), { id: 'empty', title: '', platform: 'youtube', moments: [] }];
  const a = normalizeNotes(lib);
  const b = normalizeNotes(a);
  assert.deepEqual(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(a)));
});

// ---------------------------------------------------------------- Fix 10

test('rebuild timestamps derive from file mtimes, not Date.now() (deterministic across runs)', () => {
  const files = [
    { relativePath: 'YouTube/v1/n1/00-10_mA.jpg', lastModified: 1100 },
    { relativePath: 'YouTube/v1/n1/01-20_mB.jpg', lastModified: 2200 },
  ].map((f) => ({ ...parseRelativePath(f.relativePath), ...f }));
  // Ensure these are v2 (note id present) so they group into note n1.
  const mtimes = new Map(files.map((f) => [f.relativePath, f.lastModified]));
  const r1 = mergeScannedFiles(files, new Map(), [], mtimes);
  const r2 = mergeScannedFiles(files, new Map(), [], mtimes);
  assert.equal(r1.added, 2);
  assert.equal(r1.createdNotes, 1);
  const n1 = r1.notes[0];
  assert.equal(n1.createdAt, 1100, 'createdAt = earliest mtime');
  assert.equal(n1.updatedAt, 2200, 'updatedAt = latest mtime');
  assert.equal(n1.schemaVersion, 4);
  const moments = n1.moments.map((m) => ({ id: m.id, created: m.createdAt, updated: m.updatedAt }));
  const r2n = JSON.parse(JSON.stringify(r2.notes[0].moments.map((m) => ({ id: m.id, created: m.createdAt, updated: m.updatedAt }))));
  assert.deepEqual(r2n, JSON.parse(JSON.stringify(moments)), 'identical output on a second rebuild run');
  assert.equal(n1.createdAt > 0 && n1.updatedAt > 0, true);
});

test('rebuild is idempotent (rerun adds nothing, buckets reused)', () => {
  const files = [
    'YouTube/v1/n1/00-10_mA.jpg',
    'Udemy/c1/l1/n2/01-00_mB.jpg',
  ].map((p) => parseRelativePath(p));
  const r1 = mergeScannedFiles(files, new Map(), []);
  const r2 = mergeScannedFiles(files, new Map(), r1.notes);
  assert.equal(r2.added, 0);
  assert.equal(r2.createdNotes, 0);
  assert.equal(r2.notes.length, r1.notes.length);
});

test('ambiguous v1 leftovers land in a stable Recovered bucket, never glued arbitrarily', () => {
  const files = [
    { ...parseRelativePath('YouTube/v1/00-10_mA.jpg'), },
  ];
  const notes = [
    { ...YT_NOTE(), id: 'note-a', video: { id: 'v1' } },
    { ...YT_NOTE(), id: 'note-b', video: { id: 'v1' } },
  ];
  const r = mergeScannedFiles(files, new Map(), notes);
  assert.equal(r.createdNotes, 1);
  assert.ok(r.notes.some((n) => String(n.id).startsWith('recovered-')));
});

test('sidecar annotation/timestamp/order enrich a recovered moment', () => {
  const files = [parseRelativePath('YouTube/v1/n1/01-30_mom-a.jpg')];
  const sidecars = new Map([[ 'n1', {
    noteId: 'n1', title: 'Nice Title', createdAt: 500, updatedAt: 600,
    video: { id: 'v1', title: 'AV', url: 'u' },
    moments: [{ id: 'mom-a', timestamp: 90, humanTime: '1:30', annotation: 'kept annotation', sortOrder: 3, createdAt: 700, updatedAt: 800 }],
  }]]);
  const r = mergeScannedFiles(files, sidecars, []);
  const n = r.notes[0];
  assert.equal(n.title, 'Nice Title');
  assert.equal(n.createdAt, 500);
  const m = n.moments[0];
  assert.equal(m.annotation, 'kept annotation');
  assert.equal(m.timestamp, 90);
  assert.equal(m.sortOrder, 3);
  assert.equal(m.saveState, 'saved');
});

// ---------------------------------------------------------------- Fix 11

test('parseRelativePath classifies manual screenshots correctly', () => {
  const p = parseRelativePath('Screenshots/YouTube/2026-09-17_14-31-00_cafebabe.jpg');
  assert.equal(p.manualShot, true);
  assert.equal(p.platform, 'youtube');
  assert.equal(p.momentId, '');
  assert.equal(p.videoId, '');
  assert.equal(p.courseId, '');
  assert.equal(p.lectureId, '');
});

test('parseRelativePath keeps ChatGPT clock-time (never a video timestamp)', () => {
  const p = parseRelativePath('ChatGPT/conv-abc/note-x/14-31_cm1.jpg');
  assert.equal(p.platform, 'chatgpt');
  assert.equal(p.timestamp, 0);
  assert.equal(p.humanTime, '14:31');
});

test('parseRelativePath parses v1 and v2 YouTube layouts', () => {
  const v1 = parseRelativePath('YouTube/video9/11-36_abc.jpg');
  assert.equal(v1.noteId, '');
  assert.equal(v1.videoId, 'video9');
  assert.equal(v1.momentId, 'abc');
  assert.equal(v1.timestamp, 696);
  const v2 = parseRelativePath('YouTube/video9/n-id/11-36_abc.jpg');
  assert.equal(v2.noteId, 'n-id');
});

test('noteFolderRelativePath/relativePathForMoment stay deterministic (no title/date in path)', () => {
  const folder = noteFolderRelativePath(YT_NOTE());
  assert.equal(folder, 'YouTube/9bZkp7q19f0/note-yt-1');
  const p = relativePathForMoment(YT_NOTE(), YT_NOTE().moments[0]);
  assert.equal(p, 'YouTube/9bZkp7q19f0/note-yt-1/01-01_mom-a.jpg');
});

// ---------------------------------------------------------------- Fix 12

test('classifyLibrary counts files and moments correctly', () => {
  const notes = [
    {
      id: 'n1', title: 'T', platform: 'youtube', moments: [
        { id: 'mx', relativePath: 'YouTube/v1/n1/01-01_mx.jpg', saveState: 'saved' },
        { id: 'my', relativePath: 'YouTube/v1/n1/02-02_my.jpg', saveState: 'saved' },
        { id: 'mz', annotation: 'text only' },
      ],
    },
    { id: 'n2', title: 'U', platform: 'youtube', moments: [{ id: 'mw', screenshot: { type: 'data-url', dataUrl: 'data:image/jpeg;base64,x' } }] },
  ];
  const files = [
    parseRelativePath('YouTube/v1/n1/01-01_mx.jpg'),
    parseRelativePath('YouTube/v1/n1/02-02_my.jpg'),
    parseRelativePath('YouTube/v8/99-99_orphan.jpg'),
    parseRelativePath('Screenshots/YouTube/2026-09-17_14-31-00_cafebabe.jpg'),
  ];
  const d = classifyLibrary(files, notes);
  assert.equal(d.files.total, 4);
  assert.equal(d.files.matched, 2);
  assert.equal(d.files.recoverable, 1);
  assert.equal(d.files.manual, 1);
  assert.equal(d.moments.total, 4);
  assert.equal(d.moments.withFile, 2);
  assert.equal(d.moments.textOnly, 1);
  assert.equal(d.moments.pending, 1);
  assert.equal(d.moments.missingFile, 0);
});

test('classifyLibrary flags a recorded file that is missing on disk', () => {
  const notes = [{
    id: 'n1', title: 'T', platform: 'youtube',
    moments: [{ id: 'mx', relativePath: 'YouTube/v1/n1/01-01_mx.jpg', saveState: 'saved' }],
  }];
  // The file does NOT appear in the scanned set.
  const d = classifyLibrary([], notes);
  assert.equal(d.moments.missingFile, 1);
  assert.equal(d.moments.withFile, 0);
});

test('countPendingToFolder counts only unwritten inline screenshots', () => {
  const notes = [
    YT_NOTE(),
    { id: 'np', title: 'P', platform: 'youtube', moments: [{ id: 'p1', screenshot: { type: 'data-url', dataUrl: 'data:image/jpeg;base64,x' } }] },
  ];
  assert.equal(countPendingToFolder(notes), 1);
});

// ---------------------------------------------------------------- Fix 1

test('sweepBlobUrls revokes ONLY paths no longer marked in use (live images survive)', () => {
  // Seed two live URLs, then mark ONE as visible.
  markBlobUrlsInUse(['path/a.jpg']);
  debugSeedBlobUrl('path/a.jpg', 'blob:clipnote-test-1');
  debugSeedBlobUrl('path/b.jpg', 'blob:clipnote-test-2');
  withUrlStub(() => {
    sweepBlobUrls();
  });
  assert.equal(hasBlobUrl('path/a.jpg'), true, 'visible URL must remain');
  assert.equal(hasBlobUrl('path/b.jpg'), false, 'hidden URL must be swept away');
  markBlobUrlsInUse([]);
});

test('markBlobUrlsInUse([]) + sweep empties the registry (nothing visible)', () => {
  // Start clean OUTSIDE the recording stub: earlier tests may have left a
  // visible entry behind, and those revocations must not be counted here.
  revokeAllBlobUrls();
  const { revoked } = withUrlStub(() => {
    markBlobUrlsInUse(['x.jpg']);
    debugSeedBlobUrl('x.jpg', 'blob:x');
    debugSeedBlobUrl('y.jpg', 'blob:y');
    markBlobUrlsInUse([]);
    sweepBlobUrls();
  });
  assert.equal(revoked.length, 2);
  assert.equal(hasBlobUrl('x.jpg'), false);
  assert.equal(hasBlobUrl('y.jpg'), false);
});

test('revokeBlobUrl removes one entry and clear revokes all', () => {
  withUrlStub(() => {
    markBlobUrlsInUse([]);
    debugSeedBlobUrl('a.jpg', 'blob:a');
    debugSeedBlobUrl('b.jpg', 'blob:b');
    revokeBlobUrl('a.jpg');
    assert.equal(hasBlobUrl('a.jpg'), false);
    assert.equal(hasBlobUrl('b.jpg'), true);
    revokeAllBlobUrls();
    assert.equal(hasBlobUrl('b.jpg'), false);
    assert.equal(safeGetBlobUrl('a.jpg'), null);
  });
});

test('in-use URLs survive even an oversized sweep (ceiling never touches visible images)', () => {
  const { revoked } = withUrlStub(() => {
    // 406 entries, ALL marked in use (beyond the 400 hard ceiling).
    markBlobUrlsInUse([...Array(406).keys()].map((i) => `h${i}.jpg`));
    for (let i = 0; i < 406; i++) debugSeedBlobUrl(`h${i}.jpg`, `blob:h${i}`);
    sweepBlobUrls();
    // Every one of them is still live: nothing was revoked.
    assert.equal(hasBlobUrl('h0.jpg'), true, 'in-use URL must never be revoked');
    assert.equal(hasBlobUrl('h405.jpg'), true, 'in-use URL must never be revoked');
  });
  assert.equal(revoked.length, 0, 'no visible image is ever torn down');
});

// ------------------------------------------------------ screenshot target

// Source-level regression guards for the ChatGPT screenshot-target feature:
// page captures must be cropped to the on-page conversation/content area, and
// every platform without such a region (YouTube/Udemy) keeps its full-viewport
// capture. These are static checks over the shipped files (the logic is DOM +
// extension-backed and cannot run under plain Node).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(rootDir, rel), 'utf8');
const CONTENT = read('contentScript.js');
const SIDEBAR = read('sidebar/sidebar.js');
const CHATGPT = read('platforms/chatgpt/chatgpt.js');
const CHATGPT_SELECTORS = read('platforms/chatgpt/chatgpt-selectors.js');
const ADAPTER = read('platforms/shared/platform-adapter.js');
const SELECTOR = read('platforms/shared/screenshot-selector.js');

test('contentScript exposes the screenshot-target lookup and forwards it to the selector', () => {
  assert.match(CONTENT, /CN_GET_SCREENSHOT_TARGET/);
  assert.match(CONTENT, /adapter\.getScreenshotTarget/);
  assert.match(CONTENT, /ScreenshotSelector\.start\(\{[\s\S]*?backgroundImage: msg\.dataUrl,\s*target/s);
  assert.match(CONTENT, /Number\.isFinite\(t\.width\)/, 'target rectangle is validated before use');
});

test('ChatGPT adapter defines a screenshot target on stable selectors, never generated classes', () => {
  assert.match(CHATGPT, /getScreenshotTarget\(\)/);
  // The selector chains live in the single-source-of-truth selectors module.
  assert.match(CHATGPT_SELECTORS, /data-conversation-screenshot-content/);
  assert.match(CHATGPT_SELECTORS, /'#thread'/);
  assert.match(CHATGPT_SELECTORS, /'#main'/);
  // The resilient fallback derives the surface from the stable turn markers.
  assert.match(CHATGPT_SELECTORS, /conversationSurface/);
  assert.match(CHATGPT_SELECTORS, /data-testid\^="conversation-turn-"/);
  assert.match(CHATGPT, /conversationSurface/);
  assert.doesNotMatch(CHATGPT, /qMYqUG|R6Vx5W|Ejxyja|className\s*===\s*['"][A-Za-z0-9_]+['"]/,
    'screenshot target must not rely on generated Tailwind/CSS-module class names');
  assert.doesNotMatch(CHATGPT_SELECTORS, /['"]\.[A-Za-z]/,
    'the selector chains use ids / data-* attributes only, never class selectors');
  assert.match(CHATGPT, /getBoundingClientRect\(\)/, 'target maps CSS viewport px of the live element');
});

test('non-ChatGPT platforms keep their full-viewport captures (shared default is null)', () => {
  assert.match(ADAPTER, /getScreenshotTarget\(\) \{ return null; \}/);
  assert.match(ADAPTER, /on-page content area/);
});

test('the selection layer starts with NO selection: only an intentional drag creates a rectangle', () => {
  assert.doesNotMatch(SELECTOR, /clampRect/, 'no content-target confinement remains anywhere in the selector');
  assert.doesNotMatch(SELECTOR, /fullRect/, 'no full-viewport default selection is pre-created when the layer opens');
  assert.match(SELECTOR, /const DRAG_THRESHOLD/, 'a small drag threshold exists so a plain click is never a selection');
  assert.match(SELECTOR, /if \(!dragging\) \{ cancel\(\)/, 'a plain click (no drag) cancels instead of saving');
  assert.match(SELECTOR, /rect\.width < MIN_SIZE \|\| rect\.height < MIN_SIZE/, 'an undersized rectangle is still rejected');
  assert.match(SELECTOR, /display: 'none'/, 'the selection box starts hidden, never pre-painted over the full frame');
});

test('ChatGPT "+ Capture" crops to the conversation region; the shared Screenshot flow keeps the full visible frame', () => {
  assert.match(SIDEBAR, /const shotPlan = await getScreenshotTarget\(\);.*\n.*const planRect = resolveCaptureRect\(shotPlan\);/,
    '+ Capture queries the ChatGPT capture plan and resolves the conversation rectangle');
  assert.match(SIDEBAR, /contentUrl = await cropCapturedImage\(\s*\n\s*frame\.dataUrl,\s*\n\s*planRect,\s*\n\s*planRect\.viewport\s*\n\s*\)/,
    '+ Capture saves only the conversation region, not the whole viewport');
  assert.match(SIDEBAR, /contentUrl = await cropCapturedImage\([\s\S]{0,4000}async function takeScreenshot/,
    'the conversation-region crop lives in captureChatgptMoment only, never in takeScreenshot');
  assert.doesNotMatch(SIDEBAR, /targetForOverlay/, 'no content-target selection confinement anywhere');
  assert.match(SIDEBAR, /screenshot: \{ type: 'data-url', dataUrl: contentUrl \}/, '+ Capture saves the cropped conversation image');
  assert.match(SIDEBAR, /const cropped = await cropCapturedImage\(originalCapture, selRes\.rect, selRes\.rect\.viewport\);/,
    'the shared Screenshot image is a straight crop of the full visible tab capture');
});

// ------------------------------------------------ ChatGPT timestamps removed

// Source-level regression guards for the ChatGPT timestamp fix: ChatGPT is a
// video-less platform, so its capture flows must be GENUINELY timestamp-free
// (no video time, no fake 00:00, AND no captured wall-clock time), while the
// YouTube/Udemy timestamp pipeline stays byte-for-byte intact.

const LAYOUT = read('platforms/chatgpt/chatgpt-layout.js');

test('ChatGPT capture paths never stamp a timestamp or wall-clock humanTime', () => {
  assert.doesNotMatch(CONTENT, /clockTimestamp/, 'wall-clock helper must be fully removed');
  // "+ Capture": the video-less branch builds a cap with NO time fields.
  assert.match(CONTENT, /Video-less platform \(ChatGPT\): "Capture" means "save what is/,
    'contentScript + Capture chat branch is the video-less path');
  assert.match(CONTENT, /const context = getVideoContext\(\);\s*\n\s*cap = \{\s*\n\s*id: uuid\(\),\s*\n\s*screenshot: \{ type: 'none' \}/,
    'video-less cap carries only id + no-time fields');
  assert.match(CONTENT, /cap\.humanTime \? `Captured at \$\{cap\.humanTime\}` : 'Captured'/,
    'a captionless platform (ChatGPT) toast shows no capture time at all');
  // Region/Screenshot select: the reported humanTime is empty for ChatGPT.
  assert.match(CONTENT, /humanTime: needsVideo\(\) \? formatTimestamp\(ts\) : ''/,
    'CN_SCREENSHOT_SELECT reports no capture time for video-less platforms');
});

test('ChatGPT moments never store time fields (both sidebar capture flows)', () => {
  assert.match(SIDEBAR, /\/\/ ChatGPT moment carries only the capture, the note and the conversation/,
    'captureChatgptMoment return is timestamp-free');
  assert.match(SIDEBAR, /const selIsChat = !platformHasVideo\(selRes\.platform \|\| 'youtube'\)/,
    'Screenshot flow skips time fields for ChatGPT regions explicitly');
  assert.match(SIDEBAR, /\(cap\.platform \|\| note\.platform \|\| 'youtube'\) === 'chatgpt'/,
    'addCaptureToNote keeps time fields VIDEO-platform only');
  assert.match(SIDEBAR, /if \(platformHasVideo\(note\.platform\)\)/,
    'moment card keeps the Jump link VIDEO-platform only');
});

test('the PDF export prints NO timestamps for any platform - annotations only', () => {
  assert.match(SIDEBAR, /toLocaleString\(undefined, shot\.platform === 'chatgpt'/,
    'ChatGPT shots show the DATE only, never time-of-day');
  assert.doesNotMatch(SIDEBAR, /pdf-timestamp/,
    'no timestamp is emitted into the PDF for YouTube, Udemy or ChatGPT');
  assert.match(SIDEBAR, /The PDF prints the annotation TEXT only/,
    'the PDF exports the note text alone');
});

// ------------------------------------------- sidebar position preserved

// Source-level regression guards for the ChatGPT sidebar jump: while a
// capture/screenshot is in flight, a ChatGPT re-render MUST NOT re-anchor the
// sidebar (that mid-capture repositioning moved it to the top). Navigation
// events and layout refreshes are DEFERRED, then replayed once capture exits -
// the sidebar is never remounted and nothing is scrolled or re-scaled.

test('contentScript defers navigation re-anchoring while a capture is active', () => {
  assert.match(CONTENT, /let pendingReanchorAfterCapture = false;/,
    'deferred re-anchor state exists');
  assert.match(CONTENT, /if \(captureModeActive\) \{\s*\n\s*navigationGeneration\+\+;\s*\n\s*pendingReanchorAfterCapture = true;\s*\n\s*return;\s*\n\s*\}/,
    'a mid-capture navigation invalidates stale selections and defers the re-anchor');
  assert.match(CONTENT, /runDeferredReanchorAfterCapture/,
    'the deferred re-anchor routine exists');
  assert.match(CONTENT, /pendingReanchorAfterCapture = false;\s*\n\s*runDeferredReanchorAfterCapture\(\);/,
    'setCaptureMode(false) replays the deferred re-anchor once capture exits');
  assert.match(CONTENT, /A navigation deferred from a just-ended capture must NOT re-mount/,
    'removeSidebar clears the deferred flag before tearing down');
});

test('ChatGPT layout controller freezes re-anchoring during capture and resumes on exit', () => {
  assert.match(LAYOUT, /Capture freeze: a capture\/screenshot is in flight and the content script[\s\S]*?if \(captureActive\) return;/,
    'refresh() is skipped entirely while a capture is active');
  assert.match(LAYOUT, /if \(!on\) schedule\(\);/,
    'setCapture(false) re-runs the layout pipeline after the capture freeze lifts');
  assert.match(LAYOUT, /setCapture: function \(on\) \{/,
    'the capture freeze hook is part of the layout controller');
});

// ----------------------------------------- screenshot never shows ClipNote

// Source-level regression guards for the "ChatGPT screenshot includes
// ClipNote" fix: the sidebar must NEVER appear in a saved image. It is kept
// out GEOMETRICALLY - the shared pipeline captures the visible tab FIRST (with
// the sidebar mounted and visible, never hidden), then crops the saved image
// with 1) the sidebar's OWN live rectangle (left OR right column, read from
// the DOM), and 2) the REAL captured-image scale (never an assumed
// devicePixelRatio) so the exclusion is pixel-accurate at every browser zoom.
// A blank/empty captured frame is validated and refused before it can ever be
// persisted as a "screenshot".

test('contentScript reports capture state so the sidebar hide is verified before shooting', () => {
  assert.match(CONTENT, /CN_CAPTURE_STATE/, 'content script exposes a capture-state query');
  assert.match(CONTENT, /el\.classList\.contains\('cn-capture-hidden'\) &&[\s\S]*?getComputedStyle\(el\)\.visibility === 'hidden'/,
    'the reported state is the VERIFIED hidden state, not just "mode toggled"');
  assert.match(CONTENT, /hidden = !connected \|\|/, 'an absent container is trivially hidden (nothing of ours in the frame)');
  assert.match(CONTENT, /const connected = !!el;/, 'the reply distinguishes "no container" from "container not hidden yet"');
  assert.match(CONTENT, /The sidebar verifies the capture-hide actually LANDED AND PAINTED/,
    'the contract is documented at the handler');
});

test('applyCaptureMode always hides the CONNECTED container, never a stale detached one', () => {
  assert.match(CONTENT, /function applyCaptureMode\(active\) \{[\s\S]*?\n\s*const el = \(sidebarContainer && sidebarContainer\.isConnected\)/,
    'hide targets the mounted container, falling back to a document query');
});

test('the shared pipeline captures the visible tab FIRST and never hides page content before captureVisibleTab completes', () => {
  assert.doesNotMatch(SIDEBAR, /hideHostSidebar|showHostSidebar|CN_CAPTURE_MODE|CN_CAPTURE_STATE/,
    'the sidebar no longer hides/restores/verifies a page hide - ClipNote stays mounted and is cut out by geometry instead');
  assert.match(SIDEBAR, /const frame = await captureVisibleFrame\(tab\);\s*\n\s*if \(frame\.threw\) \{/, 'capture runs before any overlay/crop work');
  assert.match(SIDEBAR, /const frameProbe = await probeCaptureImage\(frame\.dataUrl\);/,
    'the captured bitmap is validated before anything is cropped');
  assert.match(SIDEBAR, /the captured frame was blank\./, 'a blank/empty frame is refused loudly, never saved');
  assert.match(SIDEBAR, /No sidebar hide\/restore to unwind: the sidebar was never touched/, 'finally only re-arms the buttons');
});

test('the DevTools 3425 TypeError is fixed: reloadNotesFromStorage is never .catch()ed as a promise', () => {
  assert.doesNotMatch(SIDEBAR, /reloadNotesFromStorage\(\)\.catch/, 'the storage listener no longer chains .catch() on a non-promise');
  assert.match(SIDEBAR, /try \{ reloadNotesFromStorage\(\); \} catch/, 'the listener guards the synchronous reload call');
});

test('contentScript screenshot-target reply carries clip zone, viewport and platform', () => {
  assert.match(CONTENT, /clip,/, 'reply carries the ClipNote container rect');
  assert.match(CONTENT, /viewport: \{ width: window\.innerWidth, height: window\.innerHeight \}/,
    'reply carries the page viewport (the crop-scale denominator)');
  assert.match(CONTENT, /platform: \(adapter && adapter\.platform\) \|\| ''/, 'reply carries the platform');
});

test('the shared Screenshot pipeline never crops or excludes ClipNote - the full visible tab is what gets saved', () => {
  assert.match(SIDEBAR, /function resolveCaptureRect\(plan\) \{[\s\S]*leftArea[\s\S]*rightArea[\s\S]*return null;/,
    'ClipNote column cut-out logic exists ONLY inside the ChatGPT-only resolveCaptureRect');
  assert.match(SIDEBAR, /const frame = await captureVisibleFrame\(tab\);\s*\n\s*if \(frame\.threw\) \{/,
    'the visible tab is captured first, exactly as it is');
  assert.match(SIDEBAR, /const originalCapture = frame\.dataUrl;/, 'the shared flow keeps the FULL captured frame');
});

test('crop maps the selection with per-axis actual-scale, clamping to the bitmap', () => {
  assert.match(SIDEBAR, /const scaleX = .* img\.naturalWidth \/ viewport\.width/,
    'X scale derived from the actual captured image width - never an assumed DPR');
  assert.match(SIDEBAR, /const scaleY = .* img\.naturalHeight \/ viewport\.height/,
    'Y scale derived from the actual captured image height');
  assert.match(SIDEBAR, /Math\.max\(0, Math\.round\(rect\.x \* scaleX\)\)/, 'crop origin clamped to the image');
  assert.match(SIDEBAR, /Math\.min\(img\.naturalWidth, Math\.max\(x1, Math\.round\(\(rect\.x \+ rect\.width\) \* scaleX\)\)\)/,
    'crop right edge clamped to the image');
  assert.match(SIDEBAR, /Math\.min\(img\.naturalHeight, Math\.max\(y1, Math\.round\(\(rect\.y \+ rect\.height\) \* scaleY\)\)\)/,
    'crop bottom edge clamped to the image');
});

// ----------------------------------------- no jump during screenshot/crop

// Source-level regression guards for the "page/sidebar jumps up" fix: the
// sidebar and the page must not move while a screenshot is being taken and
// cropped. The sidebar is never hidden/remounted/repositioned during a capture
// (ClipNote stays visible and stays included in the saved image - it is never
// cropped out and never toggled), so there is nothing to restore and nothing to
// reflow - the page keeps exactly the layout the user clicked in.

test('the sidebar stays mounted, visible and exactly in place for the whole screenshot', () => {
  assert.doesNotMatch(SIDEBAR, /keepHiddenThroughSelection|showHostSidebar|hideHostSidebar/,
    'no platform special-cases sidebar visibility during a screenshot');
  assert.match(SIDEBAR, /never hidden, cropped, removed, repositioned or resized/, 'ClipNote is never hidden, cropped, removed, repositioned or resized for a capture');
assert.match(SIDEBAR, /a straight crop of the visible tab, never a[\s\S]*?re-composition/,
  'the saved image is a pure crop of what was on screen - ClipNote included');
});

test('contentScript snapshots and restores the page scroll around a capture', () => {
  assert.match(CONTENT, /function recordCaptureScroll\(\)/, 'scroll snapshot routine exists');
  assert.match(CONTENT, /function restoreCaptureScroll\(\)/, 'scroll restore routine exists');
  assert.match(CONTENT, /recordCaptureScroll\(\);\s*\n      captureModeTimer = setTimeout/, 'snapshot is taken when capture mode activates');
  assert.match(CONTENT, /if \(!active\) restoreCaptureScroll\(\);/, 'scroll is handed back when capture mode exits');
});


test('captureContentFrame always attempts restoration when entering capture mode fails', () => {
  const start = SIDEBAR.indexOf('async function captureContentFrame(tab, plan)');
  const end = SIDEBAR.indexOf('\n  async function saveScreenshotMoment', start);
  assert.notEqual(start, -1, 'captureContentFrame exists');
  assert.notEqual(end, -1, 'captureContentFrame boundary exists');
  const body = SIDEBAR.slice(start, end);
  assert.match(body, /try \\{[\\s\\S]*?await setHostCaptureMode\\(true, tab\\);[\\s\\S]*?finally \\{[\\s\\S]*?await setHostCaptureMode\\(false, tab\\);/,
    'the hide attempt is protected by the same try/finally that restores visibility');
  assert.doesNotMatch(body, /\\n\\s*await setHostCaptureMode\\(true, tab\\);\\s*\\n\\s*try \\{/,
    'hide-state verification cannot fail before cleanup is armed');
});


test('Screenshot saves the full visible tab including ClipNote without hiding or cropping the sidebar', () => {
  const start = SIDEBAR.indexOf('async function captureVisiblePage(tab, plan, noteId)');
  const end = SIDEBAR.indexOf('async function takeScreenshot()', start);
  assert.notEqual(start, -1, 'captureVisiblePage exists');
  assert.notEqual(end, -1, 'takeScreenshot boundary exists');
  const captureBody = SIDEBAR.slice(start, end);
  assert.match(captureBody, /const frame = await captureVisibleFrame\(tab\);/,
    'Screenshot captures the visible tab directly');
  assert.match(captureBody, /saveScreenshotMoment\(frame\.dataUrl, noteId, plan\.platform\)/,
    'the complete unmodified frame is saved');
  assert.doesNotMatch(captureBody, /captureContentFrame|cropCapturedImage|setHostCaptureMode/,
    'Screenshot does not hide the sidebar or crop it out');
  const takeStart = end;
  const takeEnd = SIDEBAR.indexOf('\n  // ----------------------- Views', takeStart);
  const takeBody = SIDEBAR.slice(takeStart, takeEnd);
  assert.doesNotMatch(takeBody, /setHostCaptureMode|forceRestoreHostSidebar/,
    'Screenshot cleanup never toggles or force-restores sidebar visibility');
});

// ---------------------------------------------------------------- report

console.log(`\nclipnote-audit-fixes.test.mjs: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nFAILURES:');
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
