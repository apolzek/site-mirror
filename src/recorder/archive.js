// Laying the recording out as a ZIP: readable files plus the manifest the replay server reads.
//
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

/**
 * Builds the manifest and the file map. Identical bodies of the same URL (a poll that
 * returned the same answer) share one file.
 */
export function layoutArchive({ entries, pages, startUrl, startedAt, finishedAt, version }) {
  const allocate = createPathAllocator();
  const files = {};
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
    pages,
    entries: manifestEntries,
  };
  return { manifest, files };
}

export function readme({ startUrl, pages, entries, startedAt }) {
  return [
    `Site Mirror recording of ${startUrl}`,
    `Recorded ${new Date(startedAt).toISOString()}: ${pages.length} page(s), ${entries} response(s).`,
    '',
    'Replay it exactly as it was (needs Node.js 18 or later, no install):',
    '',
    '    node serve.mjs',
    '',
    'then open http://localhost:8080/ in Chrome, Edge or Firefox.',
    '',
    'Options:',
    '    --port 8080        port to listen on',
    '    --host 127.0.0.1   address to listen on (0.0.0.0 to share on your network)',
    '    --no-freeze-time   let the page see the real clock instead of the recording time',
    '',
    'Pages:',
    ...pages.map((p) => `    ${p.url}`),
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
