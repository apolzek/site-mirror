// Recorder window: drives the crawl of one tab and saves the archive.
// Opened by the popup as recorder.html?tab=<id>&url=<start url>&options=<json>.

import serveSource from '../../replay/serve.mjs?text';
import { downloadBlob } from '../shared/download.js';
import { makeFilename } from '../shared/filename.js';
import { buildArchive } from './archive.js';
import { fetchIcons, filterLinks, normalizePageUrl, pageInfo, pageLinks, scrollPage } from './crawl.js';
import { Recorder } from './session.js';

const VERSION = chrome.runtime.getManifest().version;

const $ = (id) => document.getElementById(id);

function setStatus(text, kind = '') {
  $('status').textContent = text;
  $('status').className = `status ${kind}`;
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const params = new URLSearchParams(location.search);
const tabId = Number(params.get('tab'));
let startUrl = params.get('url') ? normalizePageUrl(params.get('url')) : '';
const options = {
  crawl: false,
  maxPages: 20,
  maxDepth: 2,
  samePath: false,
  scroll: true,
  thirdParty: true,
  quiet: 2,
  ...JSON.parse(params.get('options') || '{}'),
};

let stopRequested = false;
let cancelled = false;
const pages = []; // { url, title, status }

const recorder = new Recorder(tabId, { thirdParty: options.thirdParty, onChange: render });

function render() {
  $('pageCount').textContent = String(pages.length);
  $('responses').textContent = String(recorder.entries.length);
  $('size').textContent = formatSize(recorder.bytes);
  $('failed').textContent = String(recorder.failed);
}

function addPageRow(url) {
  const li = document.createElement('li');
  li.textContent = url;
  li.className = 'current';
  $('pages').append(li);
  li.scrollIntoView({ block: 'nearest' });
  return li;
}

async function recordPage(url) {
  const row = addPageRow(url);
  const page = { url, title: '', status: 'ok' };
  pages.push(page);
  render();
  try {
    setStatus(`Loading ${url}`);
    await recorder.navigate(url, { quiet: options.quiet * 1000 });
    await recorder.evaluate(fetchIcons).catch(() => {});
    if (options.scroll && !stopRequested) {
      setStatus('Scrolling to load lazy content...');
      await recorder.evaluate(scrollPage, 250);
      await recorder.waitForIdle({ quiet: options.quiet * 1000 });
    }
    const info = await recorder.evaluate(pageInfo);
    page.title = info.title;
    if (normalizePageUrl(info.url) !== url) page.finalUrl = info.url;
    row.title = info.title;
    return true;
  } catch (e) {
    page.status = String((e && e.message) || e);
    row.classList.add('failed');
    row.title = page.status;
    return false;
  } finally {
    row.classList.remove('current');
    render();
  }
}

async function crawl() {
  const seen = new Set([startUrl]);
  const queue = [{ url: startUrl, depth: 0 }];
  const maxPages = options.crawl ? Math.max(1, options.maxPages) : 1;
  while (queue.length && pages.length < maxPages && !stopRequested && !recorder.detachReason) {
    const { url, depth } = queue.shift();
    const ok = await recordPage(url);
    if (!ok || !options.crawl || depth >= options.maxDepth || recorder.detachReason) continue;
    try {
      const links = filterLinks(await recorder.evaluate(pageLinks), { startUrl, samePath: options.samePath, seen });
      queue.push(...links.map((link) => ({ url: link, depth: depth + 1 })));
    } catch {
      /* the page navigated away on its own */
    }
  }
}

async function save(startedAt) {
  setStatus('Building the archive...');
  const { blob, files, entries } = await buildArchive({
    entries: recorder.entries,
    pages,
    startUrl,
    startedAt,
    finishedAt: Date.now(),
    version: VERSION,
    serveSource,
  });
  const filename = makeFilename(startUrl);
  downloadBlob(blob, filename);
  const folder = filename.replace(/\.zip$/, '');
  $('howto').hidden = false;
  $('howto').textContent =
    `To replay it:\n  unzip ${filename} -d ${folder}\n  cd ${folder} && node serve.mjs\n` +
    `then open http://localhost:8080${new URL(startUrl).pathname}`;
  return { filename, size: blob.size, files, entries };
}

function fail(text) {
  setStatus(text, 'err');
  $('stop').disabled = true;
  $('cancel').disabled = true;
}

async function run() {
  const startedAt = Date.now();
  try {
    await recorder.attach();
    if (!startUrl) startUrl = normalizePageUrl((await recorder.send('Target.getTargetInfo')).targetInfo.url);
  } catch (e) {
    await recorder.detach();
    fail(`Could not attach to the tab: ${(e && e.message) || e}`);
    return;
  }
  if (!/^https?:/.test(startUrl)) {
    await recorder.detach();
    fail(`Only web pages (http or https) can be copied, not ${startUrl}`);
    return;
  }
  recorder.origin = new URL(startUrl).origin;
  $('startUrl').textContent = startUrl;
  document.title = `Site Mirror - ${new URL(startUrl).host}`;
  try {
    await crawl();
  } finally {
    // Leave the tab where the user started.
    recorder.recording = false;
    if (pages.length > 1 && !recorder.detachReason) await recorder.send('Page.navigate', { url: startUrl }).catch(() => {});
    await recorder.detach();
  }
  $('stop').disabled = true;
  $('cancel').disabled = true;
  if (cancelled) {
    setStatus('Cancelled, nothing saved.');
    return;
  }
  if (!recorder.entries.length) {
    setStatus(`Nothing was recorded${recorder.detachReason !== 'finished' ? ` (debugger ${recorder.detachReason})` : ''}.`, 'err');
    return;
  }
  try {
    const result = await save(startedAt);
    const failedPages = pages.filter((p) => p.status !== 'ok').length;
    const notes = [];
    if (failedPages) notes.push(`${failedPages} page(s) failed`);
    if (recorder.detachReason && recorder.detachReason !== 'finished') notes.push(`stopped early: ${recorder.detachReason}`);
    setStatus(
      `Saved ${result.filename} (${pages.length} page(s), ${result.entries} responses, ${formatSize(result.size)})` +
        (notes.length ? ` - ${notes.join('; ')}` : ''),
      'ok'
    );
  } catch (e) {
    setStatus(`Could not build the archive: ${(e && e.message) || e}`, 'err');
  }
}

$('stop').addEventListener('click', () => {
  stopRequested = true;
  $('stop').disabled = true;
  setStatus('Finishing the current page...');
});
$('cancel').addEventListener('click', () => {
  stopRequested = true;
  cancelled = true;
  $('stop').disabled = true;
  $('cancel').disabled = true;
  setStatus('Cancelling...');
});
addEventListener('pagehide', () => {
  if (!recorder.detachReason) chrome.debugger.detach({ tabId }).catch(() => {});
});

run();
