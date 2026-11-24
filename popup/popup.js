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
    if (['youtube.com','www.youtube.com','m.youtube.com'].includes(h)) return 'youtube';
    if (['udemy.com','www.udemy.com'].includes(h)) return 'udemy';
    if (['chatgpt.com','www.chatgpt.com','chat.openai.com'].includes(h)) return 'chatgpt';
    return /^https?:$/.test(u.protocol) ? 'universal' : null;
  } catch (_) { return null; }
}
async function applyToTab(enabled) {
  try {
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    if (!tab || !tab.id) return;
    const platform = platformFor(tab.url || '');
    if (enabled && platform) {
      const dedicated = [
        'platforms/shared/platform-adapter.js',
        'platforms/udemy/udemy-selectors.js','platforms/udemy/udemy-layout.js','platforms/udemy/udemy-video.js','platforms/udemy/udemy.js',
        'platforms/youtube/youtube-selectors.js','platforms/youtube/youtube-layout.js','platforms/youtube/youtube-video.js','platforms/youtube/youtube-navigation.js','platforms/youtube/youtube.js',
        'platforms/chatgpt/chatgpt-selectors.js','platforms/chatgpt/chatgpt-chat.js','platforms/chatgpt/chatgpt-layout.js','platforms/chatgpt/chatgpt-navigation.js','platforms/chatgpt/chatgpt.js',
        'platforms/shared/screenshot-selector.js','contentScript.js'
      ];
      const universal = [
        'platforms/shared/platform-adapter.js',
        'platforms/universal/universal-layout.js','platforms/universal/universal.js',
        'platforms/shared/screenshot-selector.js','contentScript.js'
      ];
      await chrome.scripting.executeScript({target:{tabId:tab.id},files:platform === 'universal' ? universal : dedicated});
    }
    chrome.tabs.sendMessage(tab.id,{type:'CN_TOGGLE',enabled},()=> {
      if (chrome.runtime.lastError) console.debug('[ClipNote] No content script in this tab:',chrome.runtime.lastError.message);
    });
  } catch (e) {
    console.warn('[ClipNote] Could not apply toggle:',e && e.message ? e.message : e);
  }
}
async function init() {
  let enabled = await getSetting('clipnote_enabled');
  if (enabled == null) {
    const legacy = await getSetting('vke_enabled');
    if (legacy != null) {
      await new Promise(resolve => chrome.storage.local.set({clipnote_enabled:legacy},resolve));
      chrome.storage.local.remove('vke_enabled');
      enabled = legacy;
    }
  }
  currentEnabled = !!enabled;
  updateUI(currentEnabled);
  toggleBtn.addEventListener('click',async()=>{
    if (toggleLock) return;
    const next = !currentEnabled;
    toggleLock = (async()=>{
      toggleBtn.disabled = true;
      try {
        await new Promise(resolve=>chrome.storage.local.set({clipnote_enabled:next},resolve));
        currentEnabled = next;
        updateUI(next);
        await applyToTab(next);
      } finally { toggleBtn.disabled=false; toggleLock=null; }
    })();
    await toggleLock;
  });
}
init();
