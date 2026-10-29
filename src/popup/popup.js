// Popup: collects the options and opens the recorder window for the active tab. The
// recording runs in that window, which (unlike the popup) stays open while pages load.

const NUMBER_IDS = ['maxPages', 'maxDepth', 'quiet'];
const CHECKBOX_IDS = ['samePath', 'scroll', 'thirdParty'];
const STORAGE_KEY = 'sm-options';

const statusEl = document.getElementById('status');
const crawlEl = document.querySelector('.crawl');

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

export function readOptions() {
  const options = { crawl: document.querySelector('input[name="scope"]:checked').value === 'crawl' };
  for (const id of NUMBER_IDS) options[id] = Number(document.getElementById(id).value);
  for (const id of CHECKBOX_IDS) options[id] = document.getElementById(id).checked;
  return options;
}

function saveOptions() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(readOptions()));
  } catch {
    /* storage unavailable */
  }
  crawlEl.setAttribute('aria-disabled', String(!readOptions().crawl));
}

function restoreOptions() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    /* ignore corrupt settings */
  }
  if ('crawl' in saved) document.querySelector(`input[name="scope"][value="${saved.crawl ? 'crawl' : 'page'}"]`).checked = true;
  for (const id of NUMBER_IDS) if (id in saved) document.getElementById(id).value = saved[id];
  for (const id of CHECKBOX_IDS) if (id in saved) document.getElementById(id).checked = !!saved[id];
  document.querySelectorAll('input').forEach((input) => input.addEventListener('change', saveOptions));
  crawlEl.setAttribute('aria-disabled', String(!readOptions().crawl));
}

/** URL of the recorder page for a tab. */
export function recorderUrl(tabId, url, options) {
  const params = new URLSearchParams({ tab: String(tabId), url, options: JSON.stringify(options) });
  return chrome.runtime.getURL(`recorder.html?${params}`);
}

document.getElementById('start').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // tab.url is only visible with host access; without it the recorder reads the URL
    // through the debugger.
    if (!tab || (tab.url && !/^https?:/.test(tab.url))) {
      setStatus('Open a web page (http or https) first.', 'err');
      return;
    }
    await chrome.windows.create({ url: recorderUrl(tab.id, tab.url || '', readOptions()), type: 'popup', width: 440, height: 560 });
    window.close();
  } catch (e) {
    setStatus(`Error: ${(e && e.message) || e}`, 'err');
  }
});

restoreOptions();
