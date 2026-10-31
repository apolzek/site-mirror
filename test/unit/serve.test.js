import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { after, before, describe, it } from 'node:test';
import {
  clientScript,
  createIndex,
  createMirrorServer,
  fromMirrorPath,
  mirrorPath,
  queryScore,
  rewriteHtml,
  rewriteLocation,
} from '../../replay/serve.mjs';

const e = (method, url, extra = {}) => ({ method, url, status: 200, headers: {}, ...extra });

describe('createIndex', () => {
  it('prefers exact matches, then the closest query on the same path', () => {
    const entries = [
      e('GET', 'https://a.io/api/items?ts=1000&page=1', { id: 1 }),
      e('GET', 'https://a.io/api/items?ts=1000&page=2', { id: 2 }),
      e('GET', 'https://a.io/api/other', { id: 3 }),
    ];
    const index = createIndex(entries);
    assert.equal(index.lookup('GET', 'https://a.io/api/items?ts=1000&page=2').id, 2);
    assert.equal(index.lookup('GET', 'https://a.io/api/items?ts=2000&page=2').id, 2);
    assert.equal(index.lookup('HEAD', 'https://a.io/api/other').id, 3);
    assert.equal(index.lookup('GET', 'https://a.io/api/missing'), null);
    assert.equal(index.lookup('POST', 'https://a.io/api/other'), null);
  });

  it('treats http and https as the same resource when only one was recorded', () => {
    const index = createIndex([e('GET', 'https://cdn.io/logo.png', { id: 1 })]);
    assert.equal(index.lookup('GET', 'http://cdn.io/logo.png').id, 1);
  });

  it('matches POST bodies, exactly or by similarity', () => {
    const index = createIndex([
      e('POST', 'https://a.io/q', { postData: '{"q":"cpu","from":1000}', id: 'cpu' }),
      e('POST', 'https://a.io/q', { postData: '{"q":"memory","from":1000}', id: 'mem' }),
    ]);
    assert.equal(index.lookup('POST', 'https://a.io/q', '{"q":"memory","from":1000}').id, 'mem');
    assert.equal(index.lookup('POST', 'https://a.io/q', '{"q":"memory","from":1234}').id, 'mem');
    assert.equal(index.lookup('POST', 'https://a.io/q', '{"q":"cpu","from":99}').id, 'cpu');
  });

  it('replays repeated requests in order, then repeats the last, until reset', () => {
    const index = createIndex([e('GET', 'https://a.io/poll', { id: 1 }), e('GET', 'https://a.io/poll', { id: 2 })]);
    assert.deepEqual([1, 2, 2].map(() => index.lookup('GET', 'https://a.io/poll').id), [1, 2, 2]);
    index.reset();
    assert.equal(index.lookup('GET', 'https://a.io/poll').id, 1);
  });

  it('prefers a recording that kept its body', () => {
    const index = createIndex([e('GET', 'https://cdn.io/f.woff2', { id: 'lost' }), e('GET', 'https://cdn.io/f.woff2', { id: 'ok', file: 'f' })]);
    assert.equal(index.lookup('GET', 'https://cdn.io/f.woff2').id, 'ok');
    const empty = createIndex([e('GET', 'https://a.io/ping', { status: 204, id: 1 })]);
    assert.equal(empty.lookup('GET', 'https://a.io/ping').id, 1);
  });

  it('scores queries', () => {
    assert.ok(queryScore('?a=1&b=2', '?a=1&b=2') > queryScore('?a=1&b=2', '?a=1&b=3'));
    assert.ok(queryScore('?a=1&b=3', '?a=1&b=2') > queryScore('?a=1', '?a=1&b=2&c=3'));
  });
});

describe('mirrorPath', () => {
  it('maps other origins to paths that keep relative URLs working', () => {
    assert.equal(mirrorPath('https://cdn.io:8443/a/b.css?v=1'), '/__mirror/o/https/cdn.io:8443/a/b.css?v=1');
    assert.equal(fromMirrorPath('/__mirror/o/https/cdn.io:8443/a/b.css', '?v=1'), 'https://cdn.io:8443/a/b.css?v=1');
    assert.equal(fromMirrorPath('/__mirror/o/http/cdn.io'), 'http://cdn.io/');
    assert.equal(fromMirrorPath('/__mirror/client.js'), null);
    // ../fonts/x.woff2 from the stylesheet lands on the font of the same origin.
    const css = `http://localhost${mirrorPath('https://cdn.io/build/app.css')}`;
    assert.equal(fromMirrorPath(new URL('../fonts/x.woff2', css).pathname), 'https://cdn.io/fonts/x.woff2');
  });
});

describe('rewriteHtml', () => {
  const origin = 'https://a.io';

  it('puts the client script first in <head> and removes CSP meta tags', () => {
    const out = rewriteHtml('<!DOCTYPE html><html lang="en"><head><meta http-equiv="Content-Security-Policy" content="default-src none"><title>t</title>', { origin, time: 42 });
    assert.equal(out, '<!DOCTYPE html><html lang="en"><head><script src="/__mirror/client.js?t=42"></script><title>t</title>');
    assert.match(rewriteHtml('<p>x</p>', { origin, time: 0 }), /^<script src="\/__mirror\/client\.js"><\/script><p>/);
  });

  it('makes links to the recorded origin local and leaves others alone', () => {
    const out = rewriteHtml('<head><a href="https://a.io">h</a><a href="https://a.io/x?y=1">x</a><img src="//a.io/i.png"><img src="https://a.io.evil.com/z"><script>u="https:\\/\\/a.io\\/api"</script>', { origin, time: 0 });
    assert.match(out, /href="\/">h/);
    assert.match(out, /href="\/x\?y=1"/);
    assert.match(out, /src="\/i\.png"/);
    assert.match(out, /https:\/\/a\.io\.evil\.com\/z/);
    assert.match(out, /u="\\\/api"/);
  });

  it('routes cross-origin iframes through the mirror', () => {
    const out = rewriteHtml('<head><iframe width="1" src="https://v.io/embed?a=1&amp;b=2"></iframe>', { origin, time: 0 });
    assert.match(out, /src="\/__mirror\/o\/https\/v\.io\/embed\?a=1&amp;b=2"/);
  });

  it('rewrites redirects', () => {
    assert.equal(rewriteLocation('/login?next=/', 'https://a.io/x', origin), '/login?next=/');
    assert.equal(rewriteLocation('https://cdn.io/f.js', 'https://a.io/x', origin), '/__mirror/o/https/cdn.io/f.js');
  });
});

describe('clientScript', () => {
  it('freezes the clock at the recording time and keeps Date working', () => {
    const recorded = Date.UTC(2020, 0, 2, 3, 4, 5);
    const context = {
      document: { currentScript: { src: `http://localhost:8080/__mirror/client.js?t=${recorded}` }, cookie: '' },
      navigator: {},
      Reflect,
      DOMException: Error,
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext('Date = this.Date || Date', context);
    vm.runInContext(clientScript('__mirror_8080'), context);
    const result = vm.runInContext(
      `({ now: Date.now(), made: new Date().getTime(), fixed: new Date(0).getTime(), parsed: Date.parse('2001-01-01T00:00:00Z'),
          isDate: new Date() instanceof Date, str: typeof Date(), ctor: new Date().constructor === Date })`,
      context
    );
    assert.ok(result.now - recorded >= 0 && result.now - recorded < 1000);
    assert.ok(result.made - recorded >= 0 && result.made - recorded < 1000);
    assert.equal(result.fixed, 0);
    assert.equal(result.parsed, Date.UTC(2001, 0, 1));
    assert.equal(result.isDate, true);
    assert.equal(result.str, 'string');
    assert.equal(result.ctor, true);
  });

  it('restores the recorded storage once per recording, keeping later changes', () => {
    const store = () => {
      const data = new Map();
      return {
        data,
        getItem: (k) => (data.has(k) ? data.get(k) : null),
        setItem: (k, v) => data.set(k, String(v)),
        clear: () => data.clear(),
      };
    };
    const context = { document: { cookie: '' }, navigator: {}, localStorage: store(), sessionStorage: store() };
    context.window = context;
    context.localStorage.setItem('stale', 'from another mirror');
    vm.createContext(context);
    const seed = { id: 'rec-1', local: { theme: 'dark' }, session: { tab: '2' }, cookies: [{ name: 'pref', value: 'blue' }] };
    vm.runInContext(clientScript('__mirror_8080', seed), context);
    assert.equal(context.localStorage.getItem('theme'), 'dark');
    assert.equal(context.localStorage.getItem('stale'), null);
    assert.equal(context.sessionStorage.getItem('tab'), '2');
    assert.match(context.document.cookie, /pref=blue/);
    context.localStorage.setItem('theme', 'light'); // changed in the mirror
    vm.runInContext(clientScript('__mirror_8080', seed), context);
    assert.equal(context.localStorage.getItem('theme'), 'light');
  });
});

describe('createMirrorServer', () => {
  let dir;
  let server;
  let base;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-serve-'));
    fs.mkdirSync(path.join(dir, 'files'));
    fs.writeFileSync(path.join(dir, 'files/index.html'), '<html><head></head><body><a href="https://a.io/next">n</a></body></html>');
    fs.writeFileSync(path.join(dir, 'files/data.json'), '{"ok":true}');
    fs.writeFileSync(path.join(dir, 'files/cdn.js'), 'cdn()');
    fs.writeFileSync(
      path.join(dir, 'mirror.json'),
      JSON.stringify({
        startUrl: 'https://a.io/',
        origin: 'https://a.io',
        startedAt: '2026-01-01T00:00:00.000Z',
        pages: [],
        storage: { origin: 'https://a.io', local: { theme: 'dark' }, session: {}, cookies: [] },
        entries: [
          e('GET', 'https://a.io/', { type: 'Document', mimeType: 'text/html', time: 1234, file: 'files/index.html', headers: { 'content-type': 'text/html', 'content-security-policy': "default-src 'none'", 'content-encoding': 'gzip' } }),
          e('GET', 'https://a.io/data?ts=1', { type: 'Fetch', mimeType: 'application/json', file: 'files/data.json', headers: { 'content-type': 'application/json' } }),
          e('GET', 'https://a.io/old', { type: 'Document', status: 302, headers: { location: 'https://a.io/' } }),
          e('GET', 'https://cdn.io/lib.js', { type: 'Script', mimeType: 'text/javascript', file: 'files/cdn.js', headers: { 'content-type': 'text/javascript', 'set-cookie': 'x=1' } }),
        ],
      })
    );
    ({ server } = createMirrorServer({ dir, port: 1, log: () => {} }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

  const doc = { 'sec-fetch-dest': 'document' };

  it('bootstraps the service worker on the first visit', async () => {
    const res = await fetch(`${base}/`, { headers: doc });
    assert.match(await res.text(), /serviceWorker[\s\S]*register\('\/__mirror\/sw\.js'/);
  });

  it('serves recorded documents rewritten, without the original transfer headers', async () => {
    const res = await fetch(`${base}/`, { headers: { ...doc, cookie: '__mirror_1=sw' } });
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-security-policy'), null);
    assert.equal(res.headers.get('content-encoding'), null);
    assert.match(html, /<head><script src="\/__mirror\/client\.js\?t=1234"><\/script><\/head>/);
    assert.match(html, /href="\/next"/);
  });

  it('answers data requests with the closest recording', async () => {
    const res = await fetch(`${base}/data?ts=999`);
    assert.deepEqual(await res.json(), { ok: true });
    assert.match(res.headers.get('x-mirror'), /closest/);
  });

  it('serves other origins under /__mirror/o/', async () => {
    const res = await fetch(`${base}/__mirror/o/https/cdn.io/lib.js`);
    assert.equal(await res.text(), 'cdn()');
    assert.equal(res.headers.get('set-cookie'), null);
  });

  it('resolves root-relative URLs from another origin\'s files against that origin', async () => {
    const res = await fetch(`${base}/lib.js`, { headers: { referer: `${base}/__mirror/o/https/cdn.io/app/main.js` } });
    assert.equal(await res.text(), 'cdn()');
  });

  it('answers unrecorded data requests with {}, or 404 for files', async () => {
    const data = await fetch(`${base}/api/ping`, { headers: { 'sec-fetch-dest': 'empty' } });
    assert.equal(data.status, 200);
    assert.deepEqual(await data.json(), {});
    assert.equal((await fetch(`${base}/icon.svg`, { headers: { 'sec-fetch-dest': 'empty' } })).status, 404);
  });

  it('seeds the recorded storage through the client script', async () => {
    const text = await (await fetch(`${base}/__mirror/client.js`)).text();
    assert.match(text, /"local":\{"theme":"dark"\}/);
  });

  it('still serves other origins through /__mirror/raw', async () => {
    const res = await fetch(`${base}/__mirror/raw?url=${encodeURIComponent('https://cdn.io/lib.js')}`);
    assert.equal(await res.text(), 'cdn()');
    assert.equal(res.headers.get('set-cookie'), null);
  });

  it('replays redirects onto the mirror', async () => {
    const res = await fetch(`${base}/old`, { redirect: 'manual', headers: { ...doc, cookie: '__mirror_1=sw' } });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/');
  });

  it('falls back to the start page for unknown documents, 404 otherwise', async () => {
    const page = await fetch(`${base}/client/route`, { headers: { ...doc, cookie: '__mirror_1=sw' } });
    assert.equal(page.status, 200);
    assert.match(page.headers.get('x-mirror'), /start page/);
    assert.equal((await fetch(`${base}/missing.js`)).status, 404);
  });

  it('serves its service worker with the recorded origin', async () => {
    const res = await fetch(`${base}/__mirror/sw.js`);
    assert.equal(res.headers.get('service-worker-allowed'), '/');
    assert.match(await res.text(), /const ORIGIN = "https:\/\/a\.io"/);
  });
});
