// ClipNote popup ON/OFF toggle.
const toggleBtn = document.querySelector('#toggleBtn');
const toggleState = toggleBtn.querySelector('.toggle-state');
function getSetting(key) {
  return new Promise(resolve => chrome.storage.local.get([key], res => resolve(chrome.runtime.lastError ? null : res[key])));
}
function updateUI(enabled) {
  toggleBtn.classList.toggle('on', enabled);
  toggleState.textContent = enabled ? 'ON' : 'OFF';
}
let currentEnabled = false;
let toggleLock = null;

function platformFor(url) {
  try {
    const u = new URL(url), h = u.hostname.toLowerCase();
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(h)) return 'youtube';
    if (['udemy.com', 'www.udemy.com'].includes(h)) return 'udemy';
    if (['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com'].includes(h)) return 'chatgpt';
    return /^https?:$/.test(u.protocol) ? 'universal' : null;
  } catch (_) { return null; }
}
const DEDICATED_FILES = [
  'platforms/shared/platform-adapter.js',
  'platforms/udemy/udemy-selectors.js', 'platforms/udemy/udemy-layout.js', 'platforms/udemy/udemy-video.js', 'platforms/udemy/udemy.js',
  'platforms/youtube/youtube-selectors.js', 'platforms/youtube/youtube-layout.js', 'platforms/youtube/youtube-video.js', 'platforms/youtube/youtube-navigation.js', 'platforms/youtube/youtube.js',
  'platforms/chatgpt/chatgpt-selectors.js', 'platforms/chatgpt/chatgpt-chat.js', 'platforms/chatgpt/chatgpt-layout.js', 'platforms/chatgpt/chatgpt-navigation.js', 'platforms/chatgpt/chatgpt.js',
  'platforms/shared/screenshot-selector.js', 'contentScript.js'
];
const UNIVERSAL_FILES = [
  'platforms/shared/platform-adapter.js',
  'platforms/universal/universal-layout.js', 'platforms/universal/universal.js',
  'platforms/shared/screenshot-selector.js', 'contentScript.js'
];
function setHint(message) {
  const hint = document.querySelector('.hint');
  if (hint) hint.textContent = message;
}
async function hasUniversalPermission(url) {
  const u = new URL(url);
  const pattern = `${u.protocol}//${u.hostname}/*`;
  return chrome.permissions.contains({ origins: [pattern] });
}
async function requestUniversalPermission(url) {
  const u = new URL(url);
  const pattern = `${u.protocol}//${u.hostname}/*`;
  if (await hasUniversalPermission(url)) return true;
  return chrome.permissions.request({ origins: [pattern] });
}
// Register Universal scripts for this exact permitted host so Chrome injects
// ClipNote again after full document navigations (not only SPA URL changes).
// The global OFF switch removes all of these registrations.
const UNIVERSAL_REGISTRATION_PREFIX = 'clipnote-universal-';
function universalRegistrationId(url) {
  const u = new URL(url);
  return UNIVERSAL_REGISTRATION_PREFIX + u.protocol.replace(':', '-') + '-' + u.hostname.replace(/[^a-z0-9_-]/gi, '-');
}
async function syncUniversalRegistrations(enabled, url) {
  if (!chrome.scripting.getRegisteredContentScripts || !chrome.scripting.registerContentScripts) return;
  if (enabled && url) {
    const u = new URL(url);
    const id = universalRegistrationId(url);
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    if (!existing.length) {
      await chrome.scripting.registerContentScripts([{
        id,
        matches: [`${u.protocol}//${u.hostname}/*`],
        js: UNIVERSAL_FILES,
        runAt: 'document_idle',
        persistAcrossSessions: true
      }]);
    }
    return;
  }
  const registrations = await chrome.scripting.getRegisteredContentScripts();
  const ids = registrations
    .filter(script => script.id.startsWith(UNIVERSAL_REGISTRATION_PREFIX))
    .map(script => script.id);
  if (ids.length) await chrome.scripting.unregisterContentScripts({ ids });
}

async function applyToTab(enabled, tab) {
  if (!tab || !tab.id) return;
  const platform = platformFor(tab.url || '');
  if (!platform) return;
  if (platform === 'universal' && enabled) {
    const granted = await requestUniversalPermission(tab.url);
    if (!granted) throw new Error('Site access was not granted.');
  }
  if (enabled) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: platform === 'universal' ? UNIVERSAL_FILES : DEDICATED_FILES
    });
  }
  await new Promise(resolve => chrome.tabs.sendMessage(
    tab.id, { type: 'CN_TOGGLE', enabled },
    () => { void chrome.runtime.lastError; resolve(); }
  ));
}
async function init() {
  let enabled = await getSetting('clipnote_enabled');
  if (enabled == null) {
    const legacy = await getSetting('vke_enabled');
    if (legacy != null) {
      await new Promise(resolve => chrome.storage.local.set({ clipnote_enabled: legacy }, resolve));
      chrome.storage.local.remove('vke_enabled');
      enabled = legacy;
    }
  }
  currentEnabled = !!enabled;
  updateUI(currentEnabled);
  toggleBtn.addEventListener('click', async () => {
    if (toggleLock) return;
    const next = !currentEnabled;
    toggleLock = (async () => {
      toggleBtn.disabled = true;
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        // Acquire optional site access before committing the global ON state.
        if (next && tab && platformFor(tab.url || '') === 'universal') {
          const granted = await requestUniversalPermission(tab.url);
          if (!granted) {
            setHint('Site access was not granted. ClipNote remains OFF.');
            return;
          }
        }
        // Persist Universal injection for full-page navigation on this host.
        // Turning ClipNote OFF clears all Universal registrations.
        if (next && tab && platformFor(tab.url || '') === 'universal') {
          await syncUniversalRegistrations(true, tab.url);
        } else if (!next) {
          await syncUniversalRegistrations(false);
        }
        await new Promise(resolve => chrome.storage.local.set({ clipnote_enabled: next }, resolve));
        currentEnabled = next;
        updateUI(next);
        await applyToTab(next, tab);
      } catch (error) {
        console.warn('[ClipNote] Toggle failed:', error);
        setHint(error && error.message ? error.message : 'Could not enable ClipNote on this page.');
      } finally {
        toggleBtn.disabled = false;
        toggleLock = null;
      }
    })();
    await toggleLock;
  });
}
init();
