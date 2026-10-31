// Laying the recording out as a ZIP: readable files plus the manifest the replay server reads.
//
//   snapshot.mhtml              the start page as it was on screen (opens in Chrome)
//   snapshots/<n>-<page>.mhtml  the other pages
//   mirror.json                 every response: method, URL, status, headers, body file
//   files/<host>/<path>         response bodies, named after their URLs (like HTTrack)
//   serve.mjs                   the replay server (node serve.mjs)
//   README.txt

import { crc32, zip } from '../shared/zip.js';

export const FORMAT = 'site-mirror/1';

const EXT_BY_MIME = {
  'text/html': 'html',
  'application/xhtml+xml': 'html',
  'text/css': 'css',
  'text/javascript': 'js',
  'application/javascript': 'js',
  'application/x-javascript': 'js',
  'application/json': 'json',
  'application/ld+json': 'json',
  'application/manifest+json': 'webmanifest',
  'text/plain': 'txt',
  'text/xml': 'xml',
  'application/xml': 'xml',
  'text/csv': 'csv',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'font/woff2': 'woff2',
  'font/woff': 'woff',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'application/font-woff': 'woff',
  'application/wasm': 'wasm',
  'application/pdf': 'pdf',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
};

// Names Windows refuses for files, whatever the extension.
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** 32-bit FNV-1a as 8 hex digits: short, stable suffixes for URL variants. */
export function shortHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function segment(raw) {
  let s = raw;
  try {
    s = decodeURIComponent(raw);
  } catch {
    /* keep it encoded */
  }
  s = s.replace(/[^\w.\-~@+=,]/g, '_').slice(0, 100);
  if (!s || s === '.' || s === '..') return '_';
  return RESERVED.test(s.replace(/\..*$/, '')) ? `_${s}` : s;
}

/**
 * Assigns each response a unique, readable path in the archive:
 *   https://example.com/            -> files/example.com/index.html
 *   https://example.com/api/items   -> files/example.com/api/items.json
 *   .../search?q=1 (or a POST)      -> files/example.com/search@1a2b3c4d.json
 * Paths never collide, also on case-insensitive file systems, and a file never has
 * the name of a directory.
 */
export function createPathAllocator() {
  const files = new Set();
  const dirs = new Set();

  return function allocate({ url, method = 'GET', postData = '', mimeType = '' }) {
    const u = new URL(url);
    const parts = u.pathname.split('/').slice(1);
    const dirParts = ['files', segment(u.host)];
    for (const raw of parts.slice(0, -1)) {
      let name = segment(raw);
      while (files.has([...dirParts, name].join('/').toLowerCase())) name += '_';
      dirParts.push(name);
    }

    let name = segment(parts[parts.length - 1] || 'index');
    let ext = '';
    const m = /^(.+)\.([A-Za-z0-9]{1,8})$/.exec(name);
    if (m) [, name, ext] = m;
    else ext = EXT_BY_MIME[mimeType.toLowerCase().split(';')[0].trim()] || 'bin';
    if (u.search || method !== 'GET') name += '@' + shortHash(`${method} ${u.search} ${postData || ''}`);

    const dir = dirParts.join('/');
    let candidate = `${dir}/${name}.${ext}`;
    for (let n = 2; files.has(candidate.toLowerCase()) || dirs.has(candidate.toLowerCase()); n++) {
      candidate = `${dir}/${name}~${n}.${ext}`;
    }
    files.add(candidate.toLowerCase());
    for (let i = 2; i <= dirParts.length; i++) dirs.add(dirParts.slice(0, i).join('/').toLowerCase());
    return candidate;
  };
}

function base64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function decodeQuotedPrintable(text) {
  const flat = text.replace(/=\r?\n/g, '');
  const bytes = new Uint8Array(flat.length);
  let n = 0;
  for (let i = 0; i < flat.length; i++) {
    if (flat[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(flat.slice(i + 1, i + 3))) {
      bytes[n++] = parseInt(flat.slice(i + 1, i + 3), 16);
      i += 2;
    } else bytes[n++] = flat.charCodeAt(i) & 0xff;
  }
  return bytes.subarray(0, n);
}

const latin1 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
};
const fromLatin1 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const wrap = (b64) => b64.replace(/.{76}/g, '$&\r\n');

/**
 * Makes an MHTML snapshot look like the page it was taken from:
 * - Adds the recorded fonts, and the images the page names. Chrome leaves fonts out of
 *   MHTML, so the text would show in a fallback font. Parts are found by Content-Location,
 *   the URL the page's CSS asks for.
 * - Chrome shows MHTML with forms sandboxed, where every control matches :disabled; the
 *   page's CSS for :disabled would grey out all its buttons. The snapshot's HTML and CSS
 *   ask for [disabled] instead.
 */
export function completeSnapshot(mhtml, entries, { maxPartBytes = 8 * 1024 * 1024 } = {}) {
  const boundary = /boundary="([^"]+)"/.exec(mhtml.slice(0, 2000));
  if (!boundary) return mhtml;
  const sep = `--${boundary[1]}`;
  const end = mhtml.lastIndexOf(`${sep}--`);
  if (end < 0) return mhtml;
  const chunks = mhtml.slice(0, end).split(`${sep}\r\n`);
  const head = chunks.shift();
  const present = new Set();
  const names = new Set();
  const parts = chunks.map((chunk) => {
    const split = chunk.indexOf('\r\n\r\n');
    if (split < 0) return chunk;
    const headers = chunk.slice(0, split);
    const location = /^Content-Location: *(\S+)/im.exec(headers);
    if (location) present.add(location[1]);
    if (!/^Content-Type: *text\/(html|css)/im.test(headers) || !/^Content-Transfer-Encoding: *quoted-printable/im.test(headers)) {
      return chunk;
    }
    let text = latin1(decodeQuotedPrintable(chunk.slice(split + 4).replace(/\r\n$/, '')));
    for (const m of text.matchAll(/[\w.~-]+\.(?:png|jpe?g|gif|webp|avif|svg|ico)\b/gi)) names.add(m[0]);
    text = text.replace(/:disabled\b/g, '[disabled]').replace(/:enabled\b/g, ':not([disabled])');
    const rest = headers.replace(/^Content-Transfer-Encoding: *quoted-printable/im, 'Content-Transfer-Encoding: base64');
    return `${rest}\r\n\r\n${wrap(base64(fromLatin1(text)))}\r\n\r\n`;
  });
  for (const e of entries) {
    if (e.method !== 'GET' || e.status !== 200 || !e.body || !e.body.length || e.body.length > maxPartBytes) continue;
    if (present.has(e.url)) continue;
    const font = e.type === 'Font' || /^font\/|woff/.test(e.mimeType);
    const image = /^image\//.test(e.mimeType) && names.has(new URL(e.url).pathname.split('/').pop());
    if (!font && !image) continue;
    present.add(e.url);
    parts.push(
      `Content-Type: ${e.mimeType || 'application/octet-stream'}\r\nContent-Transfer-Encoding: base64\r\n` +
        `Content-Location: ${e.url}\r\n\r\n${wrap(base64(e.body))}\r\n\r\n`
    );
  }
  return [head, ...parts].join(`${sep}\r\n`) + mhtml.slice(end);
}

/** Where the snapshot of the n-th page (0 = start page) goes in the archive. */
export function snapshotPath(n, url) {
  if (n === 0) return 'snapshot.mhtml';
  const u = new URL(url);
  const name = segment(`${u.pathname}${u.search}`.replace(/^\/+|\/+$/g, '') || 'index').slice(0, 60);
  return `snapshots/${String(n + 1).padStart(2, '0')}-${name}.mhtml`;
}

/**
 * Builds the manifest and the file map. Identical bodies of the same URL (a poll that
 * returned the same answer) share one file.
 */
export function layoutArchive({ entries, pages, storage = null, startUrl, startedAt, finishedAt, version }) {
  const allocate = createPathAllocator();
  const files = {};
  const manifestPages = pages.map(({ snapshot, ...page }, n) => {
    if (!snapshot) return page;
    const file = snapshotPath(n, page.url);
    files[file] = new TextEncoder().encode(completeSnapshot(snapshot, entries));
    return { ...page, snapshot: file };
  });
  const byContent = new Map();
  const manifestEntries = entries.map((e) => {
    const { body, ...entry } = e;
    if (entry.postData === undefined) delete entry.postData;
    if (body && body.length) {
      const key = `${e.method} ${e.url} ${body.length} ${crc32(body)}`;
      let file = byContent.get(key);
      if (!file) {
        file = allocate(e);
        files[file] = body;
        byContent.set(key, file);
      }
      entry.file = file;
    }
    return entry;
  });
  const manifest = {
    format: FORMAT,
    generator: `Site Mirror ${version}`,
    startUrl,
    origin: new URL(startUrl).origin,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    pages: manifestPages,
    storage,
    entries: manifestEntries,
  };
  return { manifest, files };
}

export function readme({ startUrl, pages, entries, startedAt }) {
  return [
    `Site Mirror recording of ${startUrl}`,
    `Recorded ${new Date(startedAt).toISOString()}: ${pages.length} page(s), ${entries} response(s).`,
    '',
    'To see the page exactly as it was on screen, open snapshot.mhtml in Chrome or Edge',
    '(double-click it, or drag it into a window). It is a still picture of the page: it',
    'needs nothing else, but its links and scripts do not run. snapshots/ has the other pages.',
    '',
    'To use the site offline, with its links, scripts and data (needs Node.js 18 or later):',
    '',
    '    node serve.mjs',
    '',
    `then open http://localhost:8080${new URL(startUrl).pathname}${new URL(startUrl).search} in Chrome, Edge or Firefox.`,
    '',
    'Options:',
    '    --port 8080        port to listen on',
    '    --host 127.0.0.1   address to listen on (0.0.0.0 to share on your network)',
    '    --no-freeze-time   let the page see the real clock instead of the recording time',
    '    --strict           answer data requests that were never recorded with 404',
    '                       instead of an empty JSON object',
    '',
    'Pages:',
    ...pages.map((p, n) => `    ${p.url}${p.snapshot ? `  (${snapshotPath(n, p.url)})` : ''}`),
    '',
    'files/ holds every response body named after its URL; mirror.json maps each',
    'request (method, URL, request body) to its status, headers and file.',
    '',
  ].join('\n');
}

export async function buildArchive({ serveSource, ...recording }) {
  const { manifest, files } = layoutArchive(recording);
  const blob = await zip({
    'README.txt': readme({ ...recording, entries: manifest.entries.length }),
    'serve.mjs': serveSource,
    'mirror.json': JSON.stringify(manifest, null, 1),
    ...files,
  });
  return { blob, files: Object.keys(files).length, entries: manifest.entries.length };
}
