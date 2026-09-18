// ClipNote - popup ON/OFF toggle

// Grab the toggle button from the popup page.
const toggleBtn = document.querySelector('#toggleBtn');
// Grab the small "ON/OFF" label inside that button.
const toggleState = toggleBtn.querySelector('.toggle-state');

// Look up a setting from Chrome's storage and return a Promise.
function getSetting(key) {
  // Return a Promise so the caller can await the storage result.
  return new Promise((resolve) => {
    // Ask Chrome for the value stored under this key.
    chrome.storage.local.get([key], (res) => {
      // If Chrome reported an error, resolve with null instead.
      if (chrome.runtime.lastError) return resolve(null);
      // Otherwise resolve with the stored value.
      resolve(res[key]);
    });
  });
}

// Paint the switch to match the current on/off state.
function updateUI(enabled) {
  // Add or remove the "on" class depending on the value.
  toggleBtn.classList.toggle('on', enabled);
  // Show "ON" or "OFF" text inside the button.
  toggleState.textContent = enabled ? 'ON' : 'OFF';
}

// The last authoritatively stored value (source of truth for the toggle, so a
// rapid second click flips the PREVIOUS state, never a stale DOM class).
let currentEnabled = false;
// Serializes the toggle so a second click can never overlap/desync the write.
let toggleLock = null;

// Check if a URL belongs to a supported video site.
function isSupportedSite(url) {
  // Parse the hostname and compare against the same explicit allowlist the
  // content scripts use, so e.g. music.youtube.com is not injected into.
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com' ||
      host === 'udemy.com' || host === 'www.udemy.com';
  } catch (e) {
    // Unparsable URL: fall back to the old substring check.
    return !!url && (url.includes('youtube.com') || url.includes('udemy.com'));
  }
}

// Send the new enabled state to the page in the active tab.
async function applyToTab(enabled) {
  // Wrap everything so a failure never crashes the popup.
  try {
    // Find the tab that is currently open and active.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // If there is no active tab, do nothing.
    if (!tab) return;

    // If we are turning ON and the tab is supported, make sure the scripts are
    // loaded. Order matters: the shared adapter and the platform modules must
    // run before contentScript.js (which asks the adapter registry for the
    // active platform).
    const CONTENT_SCRIPT_FILES = [
      'platforms/shared/platform-adapter.js',
      'platforms/udemy/udemy-selectors.js',
      'platforms/udemy/udemy-layout.js',
      'platforms/udemy/udemy-video.js',
      'platforms/udemy/udemy.js',
      'platforms/youtube/youtube-selectors.js',
      'platforms/youtube/youtube-layout.js',
      'platforms/youtube/youtube-video.js',
      'platforms/youtube/youtube-navigation.js',
      'platforms/youtube/youtube.js',
      'platforms/shared/screenshot-selector.js',
      'contentScript.js'
    ];
    if (enabled && isSupportedSite(tab.url)) {
      // Try to inject the content scripts into the page.
      try {
        await chrome.scripting.executeScript({
          // Which tab to inject into.
          target: { tabId: tab.id },
          // Which files to inject.
          files: CONTENT_SCRIPT_FILES
        });
      } catch (e) {
        // Already injected - that's fine.
      }
    }

    // Tell the content script to show or hide the sidebar.
    chrome.tabs.sendMessage(tab.id, { type: 'CN_TOGGLE', enabled }, () => {
      // Swallow the "no receiver" error so the console stays clean.
      void chrome.runtime.lastError;
    });
  } catch (e) {
    // No content script on this page; ignore.
  }
}

// Startup: load the saved state and wire up the click handler.
async function init() {
  // Read the current on/off flag from the new key.
  let enabled = await getSetting('clipnote_enabled');
  // If nothing is stored under the new key yet:
  if (enabled == null) {
    // Look for the flag saved before the ClipNote rename.
    const legacy = await getSetting('vke_enabled');
    // If the old flag existed, carry it over.
    if (legacy != null) {
      // Save it under the new key.
      await new Promise((resolve) => {
        // Store the migrated value.
        chrome.storage.local.set({ clipnote_enabled: legacy }, resolve);
      });
      // Remove the old key.
      chrome.storage.local.remove('vke_enabled');
      // Use the migrated value.
      enabled = legacy;
    }
  }
  // Paint the switch to match (undefined becomes false).
  currentEnabled = !!enabled;
  updateUI(currentEnabled);

  // When the user clicks the toggle button:
  toggleBtn.addEventListener('click', async () => {
    // A click while the previous toggle is still in flight is ignored: the
    // state machine in the first click already represents the new value.
    if (toggleLock) return;
    // Flip the last AUTHORITATIVE value (not the DOM class, which updates
    // async) so double-clicks can never produce two equal writes or desync
    // the storage flag from the content script.
    const next = !currentEnabled;
    toggleLock = (async () => {
      toggleBtn.disabled = true;
      try {
        // Save the new value to Chrome's storage.
        await new Promise((resolve) => {
          chrome.storage.local.set({ clipnote_enabled: next }, () => {
            chrome.storage.local.remove('vke_enabled');
            resolve();
          });
        });
        // Only now is the value authoritative.
        currentEnabled = next;
        updateUI(next);
        // Push the change through to the active tab.
        await applyToTab(next);
      } finally {
        toggleBtn.disabled = false;
        toggleLock = null;
      }
    })();
    await toggleLock;
  });
}

// Kick everything off.
init();