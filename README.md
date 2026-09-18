# ClipNote

> Timestamped notes and screenshots for YouTube & Udemy.

ClipNote is a Chrome extension that adds a note panel to YouTube videos and Udemy lectures. Capture the moment you are watching as a timestamped note, add annotations, and jump straight back to any moment later. Screenshots are written to a local folder you choose — no account, no server, and no upload.

![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
![JavaScript](https://img.shields.io/badge/JavaScript-ES6+-f7df1e)
![Local-first](https://img.shields.io/badge/Storage-Local-lightgrey)

## Preview

_Screenshots and a demo GIF will be added here._

## Features

- **Timestamped moments** — capture the current video frame together with its exact position in the video.
- **Region screenshots** — drag a rectangle over a frozen copy of the page to capture just the part you want.
- **Notes per video or lecture** — each note is tied to the video/lecture it was created on and named after it.
- **Moment annotations** — add or edit a text note on any moment; changes save automatically as you type.
- **Click-to-seek** — click a moment's timestamp to jump the video back to that point.
- **Drag-and-drop reordering** — reorder moments by dragging the handle on the left of each card.
- **Note management** — rename or delete notes from the home list, and delete individual moments.
- **Full-size preview** — open any captured image at full size inside the panel.
- **PDF export** — render the open note as a print-ready document and save it as a PDF from the browser's print dialog.
- **Original files on disk** — screenshots are written as real files into a folder you pick, kept in a tidy per-note folder structure.
- **Storage tools** — choose, change, and test your folder, reconnect permissions, scan it, rebuild the library, and migrate pending captures.
- **Save-state recovery** — moments that fail to write show a Retry action instead of being lost.
- **On/off toggle** — enable ClipNote from the toolbar popup; the panel only appears on supported video pages.

## How It Works

1. Click the ClipNote icon in the toolbar and switch it **ON**.
2. Open a supported YouTube video or Udemy lecture. The ClipNote panel appears beside the player.
3. Create a **Note**. It is automatically named after the video or lecture.
4. Capture a moment with **+ Capture** (current video frame) or **Screenshot** (select a region of the page).
5. Add an annotation to the moment if you want one.
6. Click a moment's timestamp to jump the video back to that point.
7. Export the note to PDF when you are done.

## Supported Platforms

| Platform | Support |
|----------|---------|
| YouTube (watch and embed pages) | Yes |
| Udemy (lecture pages) | Yes |

ClipNote only activates on video pages — YouTube search, the home feed, and Udemy course pages stay untouched.

## Project Structure

```
ClipNote/
├── manifest.json
├── contentScript.js              # Platform-agnostic orchestrator: capture, messaging, sidebar lifecycle
├── local-storage.js              # File System Access API + IndexedDB folder storage
├── README.txt                    # Local storage guide and troubleshooting
├── icons/                        # Extension icons (16 / 32 / 48 / 128)
├── popup/                        # Toolbar popup with the on/off toggle
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── sidebar/                      # The note panel injected into the page
│   ├── sidebar.html
│   ├── sidebar.css
│   └── sidebar.js
├── storage/                      # Dedicated storage settings page
│   ├── storage.html
│   ├── storage.css
│   └── storage.js
└── platforms/                    # Site-specific adapters and DOM integration
    ├── shared/
    │   ├── platform-adapter.js   # Base adapter + registry
    │   └── screenshot-selector.js# Interactive region-selection overlay
    ├── youtube/
    │   ├── youtube.js            # YouTube adapter
    │   ├── youtube-layout.js     # Places the panel in the right rail
    │   ├── youtube-navigation.js # SPA navigation hook (yt-navigate-finish)
    │   ├── youtube-selectors.js
    │   └── youtube-video.js      # Player discovery, video id/title, thumbnail fallback
    └── udemy/
        ├── udemy.js              # Udemy adapter
        ├── udemy-layout.js       # Places the panel in Udemy's sidebar column
        ├── udemy-selectors.js
        └── udemy-video.js        # Video.js discovery, course/lecture metadata
```

The content script is deliberately platform-agnostic. Each site under `platforms/` registers an adapter that tells the shared code which video element to bind to, where the panel belongs, and how to reserve layout space for it.

## Tech Stack

- **Chrome Extension Manifest V3**
- **Vanilla JavaScript** — no framework and no bundler
- **HTML & CSS**
- **Chrome Extension APIs** — `chrome.storage.local`, `chrome.tabs`, `chrome.tabs.captureVisibleTab`, `chrome.scripting`, `chrome.runtime`
- **IndexedDB** — screenshot cache and the remembered folder handle
- **File System Access API** — writing original screenshot files to a user-chosen folder
- DOM integration for YouTube and Udemy, including `MutationObserver` and History API hooks for SPA navigation

## Installation

ClipNote is loaded as an unpacked extension — there is no build step.

1. Download or clone this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked**.
5. Select the project folder — the one that contains `manifest.json`.
6. The ClipNote icon appears in your toolbar. Open a supported YouTube or Udemy video and use it.

## Usage

### Enable the panel

Open the popup from the toolbar and switch ClipNote **ON**. The setting is remembered. Open a YouTube video or Udemy lecture to see the panel.

### Create a note

On the home view, click **+ New Note**. A note is created and named after the current video or lecture. Click a note card to open it, or use the pencil / trash icons to rename or delete it.

### Capture moments

- **+ Capture** grabs the current video frame and its timestamp.
- **Screenshot** freezes a copy of the page so you can drag a rectangle around the region you want. The selection is cropped and added as a moment.

Each moment appears as a card with a thumbnail, a clickable timestamp, and a note field.

### Reorder, preview, and export

- Drag the handle on the left of a card to reorder moments.
- Click a thumbnail to view the full-size image.
- Click **Export** to open a print-ready layout, then choose **Save as PDF** in the print dialog.

## Storage & Privacy

ClipNote is local-first. There is no account, no server, and no cloud backend.

| Data | Where it lives |
|------|----------------|
| Notes, moments, timestamps, annotations, ordering | `chrome.storage.local` (`clipnote_notes`) |
| Screenshot image data (preview cache) | IndexedDB (`clipnote_screenshots`) |
| Chosen folder handle and name | IndexedDB (`clipnote_local`) |
| On/off setting | `chrome.storage.local` (`clipnote_enabled`) |
| Original screenshot files | A folder on your computer that you pick |

When you connect a folder, ClipNote writes the captured images there as files and stores only the metadata and a preview in the browser databases. Everything keeps working when the internet is off.

Because Chrome's File System Access API does not expose full paths, the settings page shows the folder name you chose rather than its full path. If the local database is ever cleared but the folder still contains ClipNote files, **Rebuild Library** on the settings page can reconstruct the notes and moments from the files on disk. Original note titles are restored from each note's `_clipnote-note.json` sidecar (falling back to a `Recovered ...` label only when no title survives). Rich text such as annotations exists only in the database and cannot be recovered from a raw image.

## Permissions

| Permission | Why it is required |
|------------|--------------------|
| `activeTab` | Grants temporary access to the active tab after a user action, which the capture and injection flows rely on. |
| `scripting` | Injects the platform modules and content script into the active tab when ClipNote is switched on from the popup. |
| `storage` | Saves the on/off setting and the notes metadata in `chrome.storage.local`. |
| Host access to `*.youtube.com` and `*.udemy.com` | Lets the content scripts run on those sites and read the video/DOM to place the panel and capture frames. |

## Screenshot System

ClipNote has two ways to capture an image:

1. **Video frame (`+ Capture`)** — the current frame is drawn from the `<video>` element at its native resolution and saved as a JPEG. If a frame cannot be drawn, ClipNote falls back to the platform thumbnail (YouTube) or poster (Udemy).
2. **Region screenshot (`Screenshot`)** — the visible tab is captured first, then shown as a static, frozen layer over the page. You drag a rectangle over that frozen image; the selection is cropped and saved. Because the layer is a snapshot, the live page, animations, and video cannot affect what you capture. Press `Esc` to cancel.

Either way, the result becomes a **Moment** with the video's timestamp at capture time. The image is stored as a preview in IndexedDB and written by default into a **per-note folder** in your chosen folder:

```
YouTube/<videoId>/<noteId>/MM-SS_<momentId>.jpg
Udemy/<courseId>/<lectureId>/<noteId>/MM-SS_<momentId>.jpg
Screenshots/<Platform>/yyyy-MM-dd_HH-mm-ss_<id>.jpg   (manual region screenshots)
```

Each note also writes a small metadata sidecar `_clipnote-note.json` into its own folder, recording the note id, title, platform, and video/course/lecture ids. Folder names are built only from stable ids (never the title or a timestamp), and each file name contains a unique moment id so two captures in the same second never collide. Two notes about the same video always land in different folders, and renaming a note never moves its files.

Folders saved by older versions of ClipNote (`YouTube/<videoId>/...` and `Udemy/<courseId>/<lectureId>/...`, with the moment file directly under the video/lecture folder) stay readable: the library scan recognizes both layouts, treats legacy files as a shared per-video group, and re-maps them onto the matching note. Legacy video/lecture folders are never renamed or deleted automatically.

## Notes and Moments

- A **Note** is a container tied to one YouTube video or Udemy lecture. It has a title and a list of moments. Notes live on the home list, sorted by the most recently updated.
- A **Moment** is a single entry inside a note: a video timestamp, an optional screenshot, and an optional annotation. Clicking its timestamp seeks the video to that point.

On Udemy, notes also record the course and lecture ids so moments from different lectures are never mixed together.

## Feedback

Found a bug or have a suggestion?

[Send Feedback](https://forms.gle/tEeSy2en7pbQHri89)

You can also use the **Feedback** button in the ClipNote panel header.

## Bug Reports

When reporting a problem, please include:

- What happened, and what you expected instead
- Steps to reproduce it
- Your Chrome version
- The platform and page (YouTube or Udemy)
- A screenshot if it helps explain the issue

## Contributing

1. Fork the repository.
2. Create a feature branch.
3. Make your changes.
4. Load the extension via `chrome://extensions` → **Load unpacked** and test on both YouTube and Udemy.
5. Open a pull request describing the change.

## Roadmap

More improvements are planned as the project evolves.

## License

License information will be added.
