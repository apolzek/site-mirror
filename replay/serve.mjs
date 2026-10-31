#!/usr/bin/env node
// Site Mirror replay server: serves a recording exactly as it was captured.
//
//   node serve.mjs [--port 8080] [--host 127.0.0.1] [--no-freeze-time] [--strict] [--dir <recording>]
//
// Requests to this server stand for requests to the recorded site. A service worker
// (/__mirror/sw.js) sends the requests the page makes to other origins (CDNs, APIs,
// fonts) here as well, as /__mirror/o/<scheme>/<host>/<path>, so nothing goes to the
// network and relative URLs inside those files still resolve. Every request is answered from
// mirror.json: exact match first, then the closest recorded request for the same path.
// The page starts with the localStorage, sessionStorage and cookies it had when recorded.
//
// Single file, no dependencies: it is copied into every recording.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MIRROR = '/__mirror/';

// Response headers that describe the original transfer or would block the replay.
const DROPPED_HEADERS = new Set([
  'content-encoding', // bodies were recorded decoded
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'strict-transport-security',
  'set-cookie',
  'alt-svc',
  'report-to',
  'nel',
  'etag',
  'last-modified',
  'expires',
  'cache-control',
  'age',
]);

// ---------------------------------------------------------------------------------------
// Matching requests to recorded responses

function similarity(a, b) {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return prefix + suffix - Math.abs(a.length - b.length);
}

/** How alike two query strings are: equal parameters count most, missing/extra ones cost. */
export function queryScore(a, b) {
  const pa = new URLSearchParams(a);
  const pb = new URLSearchParams(b);
  const keysA = new Set(pa.keys());
  const keysB = new Set(pb.keys());
  let score = 0;
  for (const k of keysA) {
    if (!keysB.has(k)) score -= 2;
    else if (pa.getAll(k).join('\0') === pb.getAll(k).join('\0')) score += 3;
    else score += 1;
  }
  for (const k of keysB) if (!keysA.has(k)) score -= 2;
  return score;
}

const hasBody = (e) =>
  !!e.file || e.status === 204 || e.status === 304 || (e.status >= 300 && e.status < 400) || (e.headers || {})['content-length'] === '0';

/**
 * Index over the recorded entries.
 * lookup(method, url, body) -> entry | null
 * Repeated identical requests (polling) get the recorded responses in order, then the last
 * one again; reset() starts the sequences over (on every page load).
 */
export function createIndex(entries) {
  const exact = new Map();
  const byPath = new Map();
  const push = (map, key, e) => (map.get(key) || map.set(key, []).get(key)).push(e);
  for (const e of entries) {
    const u = new URL(e.url);
    push(exact, `${e.method} ${u.origin}${u.pathname}${u.search}`, e);
    push(byPath, `${e.method} ${u.origin}${u.pathname}`, e);
  }
  let cursors = new Map();

  function pick(list, body) {
    // A response whose body Chrome no longer had is recorded without one; another
    // recording of the same request is better.
    const complete = list.filter(hasBody);
    if (complete.length && complete.length < list.length) list = complete;
    if (list.length > 1 && body !== undefined) {
      const same = list.filter((e) => (e.postData || '') === body);
      if (same.length) list = same;
      else {
        const best = Math.max(...list.map((e) => similarity(e.postData || '', body)));
        list = list.filter((e) => similarity(e.postData || '', body) === best);
      }
    }
    const key = list[0];
    const i = cursors.get(key) || 0;
    cursors.set(key, i + 1);
    return list[Math.min(i, list.length - 1)];
  }

  function find(m, u, body) {
    const list = exact.get(`${m} ${u.origin}${u.pathname}${u.search}`);
    if (list) return pick(list, body);
    const candidates = byPath.get(`${m} ${u.origin}${u.pathname}`);
    if (!candidates) return null;
    const scores = candidates.map((e) => queryScore(new URL(e.url).search, u.search));
    const best = Math.max(...scores);
    return pick(candidates.filter((_, i) => scores[i] === best), body);
  }

  function lookup(method, url, body) {
    const m = method === 'HEAD' ? 'GET' : method;
    const u = new URL(url);
    const found = find(m, u, body);
    if (found || !/^https?:$/.test(u.protocol)) return found;
    // Protocol-relative URLs (//cdn.example/x) resolve to http: on the mirror.
    const other = new URL(u.href.replace(/^https?:/, u.protocol === 'http:' ? 'https:' : 'http:'));
    return find(m, other, body);
  }

  return { lookup, reset: () => (cursors = new Map()) };
}

// ---------------------------------------------------------------------------------------
// Other origins on the mirror: https://cdn.io/a/b.css?v=1 <-> /__mirror/o/https/cdn.io/a/b.css?v=1

export function mirrorPath(url) {
  const u = new URL(url);
  return `${MIRROR}o/${u.protocol.slice(0, -1)}/${u.host}${u.pathname}${u.search}`;
}

/** The original URL of a /__mirror/o/ path (with its query), or null. */
export function fromMirrorPath(pathname, search = '') {
  const m = new RegExp(`^${MIRROR}o/(https?)/([^/]+)(/.*)?$`).exec(pathname);
  return m ? `${m[1]}://${m[2]}${m[3] || '/'}${search}` : null;
}

// ---------------------------------------------------------------------------------------
// Rewriting documents

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Prepares a recorded HTML document for replay: removes CSP meta tags, makes links to the
 * recorded origin relative, routes cross-origin iframes through the mirror, and puts the
 * mirror client script before anything else runs.
 */
export function rewriteHtml(html, { origin, time }) {
  const host = origin.replace(/^https?:/, '');
  const out = html
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy[^>]*>/gi, '')
    .replace(new RegExp(`(?:https?:)?${escapeRe(host)}(?=[/?#])`, 'g'), '')
    .replace(new RegExp(`(?:https?:)?${escapeRe(host)}(?=["'\\s>]|$)`, 'g'), '/')
    .replace(new RegExp(`(?:https?:)?${escapeRe(host.replace(/\//g, '\\/'))}(?=\\\\/)`, 'g'), '')
    .replace(/(<iframe\b[^>]*?\ssrc\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi, (m, pre, q, src) => {
      const raw = src.replace(/&amp;/g, '&');
      return `${pre}${q}${mirrorPath(raw).replace(/&/g, '&amp;')}${q}`;
    });
  const tag = `<script src="${MIRROR}client.js${time ? `?t=${time}` : ''}"></script>`;
  const head = /<head\b[^>]*>/i.exec(out);
  if (head) return out.slice(0, head.index + head[0].length) + tag + out.slice(head.index + head[0].length);
  const root = /<html\b[^>]*>|<!doctype[^>]*>/i.exec(out);
  if (root) return out.slice(0, root.index + root[0].length) + tag + out.slice(root.index + root[0].length);
  return tag + out;
}

/** Maps a recorded Location header onto the mirror. */
export function rewriteLocation(location, base, origin) {
  let u;
  try {
    u = new URL(location, base);
  } catch {
    return location;
  }
  if (u.origin === origin) return u.pathname + u.search + u.hash;
  return mirrorPath(u.href);
}

// ---------------------------------------------------------------------------------------
// Scripts served to the replayed page

/**
 * Runs first in every replayed document. `seed` ({ id, local, session, cookies }) is the
 * recorded storage: localStorage is reset to it once per recording (later changes made in
 * the mirror are kept), sessionStorage once per tab.
 */
export function clientScript(cookieName, seed = null) {
  return `(function () {
  var seed = ${JSON.stringify(seed).replace(/</g, '\\u003c')};
  if (seed) {
    try {
      if (localStorage.getItem('__mirror_seed') !== seed.id) {
        localStorage.clear();
        for (var k in seed.local) localStorage.setItem(k, seed.local[k]);
        localStorage.setItem('__mirror_seed', seed.id);
        (seed.cookies || []).forEach(function (c) {
          document.cookie = c.name + '=' + c.value + '; path=/; SameSite=Lax';
        });
      }
      if (sessionStorage.getItem('__mirror_seed') !== seed.id) {
        for (var s in seed.session) sessionStorage.setItem(s, seed.session[s]);
        sessionStorage.setItem('__mirror_seed', seed.id);
      }
    } catch (e) {}
  }
  var src = (document.currentScript && document.currentScript.src) || '';
  var m = /[?&]t=(\\d+)/.exec(src);
  if (m) {
    // Freeze the clock at the recording time (then let it run), so the page asks for the
    // same time ranges it asked for while it was recorded.
    var RealDate = Date;
    var offset = +m[1] - RealDate.now();
    var MirrorDate = function Date() {
      if (!new.target) return new RealDate(RealDate.now() + offset).toString();
      var args = arguments.length ? Array.prototype.slice.call(arguments) : [RealDate.now() + offset];
      return Reflect.construct(RealDate, args, new.target);
    };
    MirrorDate.prototype = RealDate.prototype;
    MirrorDate.now = function now() { return RealDate.now() + offset; };
    MirrorDate.parse = RealDate.parse;
    MirrorDate.UTC = RealDate.UTC;
    Object.defineProperty(RealDate.prototype, 'constructor', { value: MirrorDate, writable: true, configurable: true });
    window.Date = MirrorDate;
  }
  var sw = navigator.serviceWorker;
  if (!sw) return;
  // The site's own service worker would replace the mirror's.
  try {
    sw.register = function () { return Promise.reject(new DOMException('disabled in the mirror', 'SecurityError')); };
  } catch (e) {}
  // Not controlled (hard reload, worker removed): set the mirror worker up again once.
  var cookie = document.cookie.match(/(?:^|; )${cookieName}=([^;]*)/);
  if (!sw.controller && cookie && cookie[1] === 'sw') {
    var tries = +(sessionStorage.getItem('__mirror_retry') || 0);
    if (tries < 2) {
      sessionStorage.setItem('__mirror_retry', String(tries + 1));
      document.cookie = '${cookieName}=; path=/; max-age=0';
      location.reload();
    }
  } else if (sw.controller) {
    sessionStorage.removeItem('__mirror_retry');
  }
})();
`;
}

/** Sends the page's requests to other origins to the mirror instead of the network. */
export function serviceWorkerScript(origin) {
  return `const ORIGIN = ${JSON.stringify(origin)};
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin === self.location.origin || !/^https?:$/.test(url.protocol) || req.mode === 'navigate') return;
  const local = url.origin === ORIGIN
    ? url.pathname + url.search
    : '${MIRROR}o/' + url.protocol.slice(0, -1) + '/' + url.host + url.pathname + url.search;
  event.respondWith((async () => {
    const init = { method: req.method, headers: req.headers, credentials: 'same-origin', redirect: 'follow' };
    if (req.method !== 'GET' && req.method !== 'HEAD') init.body = await req.arrayBuffer();
    return fetch(local, init);
  })());
});
`;
}

/** First visit: installs the service worker, then reloads into the real page. */
export function bootstrapHtml(cookieName) {
  return `<!DOCTYPE html><meta charset="utf-8"><title>Opening mirror...</title>
<script>
(async function () {
  function done(mode) {
    document.cookie = '${cookieName}=' + mode + '; path=/; SameSite=Lax';
    location.reload();
  }
  var sw = navigator.serviceWorker;
  if (!sw) return done('nosw');
  try {
    await sw.register('${MIRROR}sw.js', { scope: '/' });
    await sw.ready;
    if (!sw.controller) {
      await new Promise(function (r) { sw.addEventListener('controllerchange', r); setTimeout(r, 1500); });
    }
    done('sw');
  } catch (e) {
    console.warn('[mirror] service worker unavailable, other origins will not be replayed', e);
    done('nosw');
  }
})();
</script>
`;
}

// ---------------------------------------------------------------------------------------
// Server

// Paths that are files, not data: a miss on one of these is a 404 even outside --strict.
const STATIC_PATH = /\.(js|mjs|css|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|wasm|map|html?|mp4|webm|mp3)$/i;

export function createMirrorServer({ dir, freezeTime = true, strict = false, port = 8080, log = console.log }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'mirror.json'), 'utf8'));
  const { origin, entries } = manifest;
  const { storage } = manifest;
  const seed =
    storage && storage.origin === origin
      ? { id: manifest.startedAt, local: storage.local || {}, session: storage.session || {}, cookies: storage.cookies || [] }
      : null;
  const index = createIndex(entries);
  const cookieName = `__mirror_${port}`;
  const startDocument =
    entries.find((e) => e.type === 'Document' && e.url === manifest.startUrl && e.status === 200) ||
    entries.find((e) => e.type === 'Document' && e.status === 200);

  const isDocument = (req) =>
    req.headers['sec-fetch-dest'] === 'document' ||
    (!req.headers['sec-fetch-dest'] && req.method === 'GET' && /text\/html/.test(req.headers.accept || ''));

  function readBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined));
      req.on('error', () => resolve(undefined));
    });
  }

  function send(res, status, headers, body) {
    res.writeHead(status, { 'cache-control': 'no-store', ...headers });
    res.end(body);
  }

  function serveEntry(req, res, entry, target, note) {
    const headers = {};
    for (const [name, value] of Object.entries(entry.headers || {})) {
      if (!DROPPED_HEADERS.has(name)) headers[name] = String(value).split('\n');
    }
    if (headers.location) headers.location = rewriteLocation(String(headers.location[0]), entry.url, origin);
    if (note) headers['x-mirror'] = note;
    let body = entry.file ? fs.readFileSync(path.join(dir, entry.file)) : Buffer.alloc(0);
    const html = /html/i.test(entry.mimeType) || (entry.type === 'Document' && !entry.mimeType);
    if (html && entry.type === 'Document') {
      body = Buffer.from(rewriteHtml(body.toString('utf8'), { origin, time: freezeTime ? entry.time : 0 }), 'utf8');
    }
    log(`${entry.status} ${req.method} ${target}${note ? ` (${note})` : ''}`);
    send(res, entry.status, headers, req.method === 'HEAD' ? undefined : body);
  }

  async function handle(req, res) {
    const local = new URL(req.url, 'http://mirror.local');
    if (local.pathname === `${MIRROR}sw.js`) {
      return send(res, 200, { 'content-type': 'text/javascript', 'service-worker-allowed': '/' }, serviceWorkerScript(origin));
    }
    if (local.pathname === `${MIRROR}client.js`) {
      return send(res, 200, { 'content-type': 'text/javascript' }, clientScript(cookieName, seed));
    }

    let target = fromMirrorPath(local.pathname, local.search);
    if (target) {
      target = target.replace(/#.*$/, '');
    } else if (local.pathname === `${MIRROR}raw`) {
      target = local.searchParams.get('url') || '';
      try {
        target = new URL(target).href.replace(/#.*$/, '');
      } catch {
        return send(res, 400, { 'content-type': 'text/plain' }, 'bad url');
      }
    } else {
      target = origin + local.pathname + local.search;
    }

    const document = isDocument(req);
    if (document) {
      const cookie = new RegExp(`(?:^|;\\s*)${cookieName}=`).test(req.headers.cookie || '');
      if (!cookie && req.method === 'GET') {
        return send(res, 200, { 'content-type': 'text/html; charset=utf-8' }, bootstrapHtml(cookieName));
      }
      index.reset();
    }

    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
    const entry = index.lookup(req.method, target, body);
    if (entry) return serveEntry(req, res, entry, target, entry.url === target ? '' : `closest: ${entry.url}`);
    // A root-relative URL ("/x.js") asked for by a file from another origin means that origin.
    let referer = null;
    try {
      const r = new URL(req.headers.referer || '');
      referer = fromMirrorPath(r.pathname, r.search);
    } catch {
      /* no referer */
    }
    if (referer && new URL(target).origin === origin && new URL(referer).origin !== origin) {
      const other = new URL(local.pathname + local.search, referer).href;
      const found = index.lookup(req.method, other, body);
      if (found) return serveEntry(req, res, found, other, `from ${new URL(referer).origin}`);
    }
    if (document && startDocument && new URL(target).origin === origin) {
      // Client-side routes the crawl never loaded: let the app's router handle them.
      return serveEntry(req, res, startDocument, target, 'not recorded, served the start page');
    }
    if (!strict && req.headers['sec-fetch-dest'] === 'empty' && !STATIC_PATH.test(new URL(target).pathname)) {
      // A data request the recording never made (a background ping, a click the user did
      // not make): an empty answer keeps most apps quiet where a 404 shows an error.
      log(`200 ${req.method} ${target} (not recorded, answered {})`);
      return send(res, 200, { 'content-type': 'application/json', 'x-mirror': 'not recorded' }, '{}');
    }
    log(`404 ${req.method} ${target} (not recorded)`);
    return send(res, 404, { 'content-type': 'text/plain; charset=utf-8', 'x-mirror': 'not recorded' }, `Not in the recording: ${req.method} ${target}\n`);
  }

  return {
    manifest,
    server: http.createServer((req, res) => {
      handle(req, res).catch((e) => {
        log(`500 ${req.method} ${req.url}: ${e.stack || e}`);
        if (!res.headersSent) send(res, 500, { 'content-type': 'text/plain' }, String(e));
        else res.end();
      });
    }),
  };
}

function parseArgs(argv) {
  const opts = { port: 8080, host: '127.0.0.1', freezeTime: true, dir: path.dirname(fileURLToPath(import.meta.url)), quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--host') opts.host = argv[++i];
    else if (a === '--dir') opts.dir = argv[++i];
    else if (a === '--no-freeze-time') opts.freezeTime = false;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--help' || a === '-h') {
      console.log('usage: node serve.mjs [--port 8080] [--host 127.0.0.1] [--no-freeze-time] [--strict] [--dir <recording>] [--quiet]');
      process.exit(0);
    } else {
      console.error(`unknown option: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const opts = parseArgs(process.argv.slice(2));
  const { manifest, server } = createMirrorServer({ ...opts, log: opts.quiet ? () => {} : console.log });
  server.listen(opts.port, opts.host, () => {
    const shown = opts.host === '0.0.0.0' || opts.host === '127.0.0.1' ? 'localhost' : opts.host;
    console.log(`Mirror of ${manifest.startUrl} (recorded ${manifest.startedAt})`);
    console.log(`${manifest.entries.length} responses, ${manifest.pages.length} page(s)`);
    console.log(`Open http://${shown}:${opts.port}${new URL(manifest.startUrl).pathname}${new URL(manifest.startUrl).search}`);
  });
}
