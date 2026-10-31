import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildArchive, completeSnapshot, createPathAllocator, layoutArchive, shortHash, snapshotPath } from '../../src/recorder/archive.js';
import { unzipText } from './helpers/unzip.js';

describe('createPathAllocator', () => {
  it('names files after their URLs, adding an extension from the MIME type', () => {
    const allocate = createPathAllocator();
    assert.equal(allocate({ url: 'https://example.com/', mimeType: 'text/html' }), 'files/example.com/index.html');
    assert.equal(allocate({ url: 'https://example.com/css/app.css', mimeType: 'text/css' }), 'files/example.com/css/app.css');
    assert.equal(allocate({ url: 'https://example.com/api/items', mimeType: 'application/json; charset=utf-8' }), 'files/example.com/api/items.json');
    assert.equal(allocate({ url: 'https://example.com/blob', mimeType: '' }), 'files/example.com/blob.bin');
    assert.equal(allocate({ url: 'http://localhost:8080/a.js', mimeType: 'text/javascript' }), 'files/localhost_8080/a.js');
  });

  it('gives query and POST variants a stable hash suffix', () => {
    const allocate = createPathAllocator();
    const a = allocate({ url: 'https://x.io/search?q=1', mimeType: 'application/json' });
    const b = allocate({ url: 'https://x.io/search?q=2', mimeType: 'application/json' });
    const c = allocate({ url: 'https://x.io/search', method: 'POST', postData: '{"q":1}', mimeType: 'application/json' });
    assert.match(a, /^files\/x\.io\/search@[0-9a-f]{8}\.json$/);
    assert.notEqual(a, b);
    assert.match(c, /^files\/x\.io\/search@[0-9a-f]{8}\.json$/);
    assert.equal(shortHash('abc'), shortHash('abc'));
  });

  it('never reuses a path, ignoring case, and keeps files and directories apart', () => {
    const allocate = createPathAllocator();
    const first = allocate({ url: 'https://x.io/a/Logo.png' });
    const second = allocate({ url: 'https://x.io/a/logo.png' });
    assert.equal(first, 'files/x.io/a/Logo.png');
    assert.equal(second, 'files/x.io/a/logo~2.png');
    const file = allocate({ url: 'https://x.io/v1.2', mimeType: 'text/html' });
    const nested = allocate({ url: 'https://x.io/v1.2/page', mimeType: 'text/html' });
    assert.equal(file, 'files/x.io/v1.2');
    assert.equal(nested, 'files/x.io/v1.2_/page.html');
    const dir = allocate({ url: 'https://x.io/a', mimeType: 'text/html' });
    assert.equal(dir, 'files/x.io/a.html');
  });

  it('makes unsafe names portable', () => {
    const allocate = createPathAllocator();
    assert.equal(allocate({ url: 'https://x.io/caf%C3%A9/a%20b:c.js' }), 'files/x.io/caf_/a_b_c.js');
    assert.equal(allocate({ url: 'https://x.io/con.js' }), 'files/x.io/_con.js');
    // URL() already resolves encoded dot segments; nothing escapes the host folder.
    assert.equal(allocate({ url: 'https://x.io/%2e%2e/up.js' }), 'files/x.io/up.js');
    assert.equal(allocate({ url: 'https://x.io/a/%2E./..%2f/b.js' }), 'files/x.io/.._/b.js');
  });
});

describe('layoutArchive', () => {
  const body = (s) => new TextEncoder().encode(s);
  const entry = (url, text, extra = {}) => ({
    method: 'GET', url, type: 'XHR', time: 1, status: 200, statusText: 'OK', mimeType: 'application/json', headers: {}, body: text === null ? null : body(text), ...extra,
  });

  it('writes a manifest that points at the bodies and shares identical ones', () => {
    const { manifest, files } = layoutArchive({
      entries: [
        entry('https://x.io/poll', '{"n":1}'),
        entry('https://x.io/poll', '{"n":1}'),
        entry('https://x.io/poll', '{"n":2}'),
        entry('https://x.io/old', null, { status: 301, headers: { location: '/new' } }),
      ],
      pages: [{ url: 'https://x.io/', title: 'X', status: 'ok' }],
      startUrl: 'https://x.io/',
      startedAt: 0,
      finishedAt: 1000,
      version: '1.0.0',
    });
    assert.equal(manifest.format, 'site-mirror/1');
    assert.equal(manifest.origin, 'https://x.io');
    assert.equal(manifest.entries.length, 4);
    assert.equal(manifest.entries[0].file, manifest.entries[1].file);
    assert.notEqual(manifest.entries[0].file, manifest.entries[2].file);
    assert.equal(manifest.entries[3].file, undefined);
    assert.equal(Object.keys(files).length, 2);
    assert.ok(!('body' in manifest.entries[0]));
  });

  it('builds a ZIP with the server, the manifest and the files', async () => {
    const { blob, entries } = await buildArchive({
      entries: [entry('https://x.io/', '<p>hi</p>', { type: 'Document', mimeType: 'text/html' })],
      pages: [{ url: 'https://x.io/', title: 'X', status: 'ok' }],
      startUrl: 'https://x.io/',
      startedAt: 0,
      finishedAt: 1,
      version: '1.0.0',
      serveSource: '// server',
    });
    assert.equal(entries, 1);
    const zip = await unzipText(await blob.arrayBuffer());
    assert.deepEqual([...zip.keys()], ['README.txt', 'serve.mjs', 'mirror.json', 'files/x.io/index.html']);
    assert.equal(zip.get('files/x.io/index.html'), '<p>hi</p>');
    assert.match(zip.get('README.txt'), /node serve\.mjs/);
    assert.equal(JSON.parse(zip.get('mirror.json')).entries[0].file, 'files/x.io/index.html');
  });
});

describe('completeSnapshot', () => {
  const B = '----MultipartBoundary--abc----';
  const mhtml = [
    `From: <Saved by Blink>\r\nContent-Type: multipart/related;\r\n\ttype="text/html";\r\n\tboundary="${B}"\r\n\r\n`,
    `--${B}\r\nContent-Type: text/html\r\nContent-Transfer-Encoding: quoted-printable\r\nContent-Location: https://a.io/\r\n\r\n`,
    `<html><head><link rel=3D"stylesheet" href=3D"https://a.io/app.css"></head><body><img src=3D"logo.png"><b=\r\nutton>x</button></body></html>\r\n\r\n`,
    `--${B}\r\nContent-Type: text/css\r\nContent-Transfer-Encoding: quoted-printable\r\nContent-Location: https://a.io/app.css\r\n\r\n`,
    `@font-face { src: url("fonts/f.woff2"); } button:disabled { opacity: 0.3 } a:enabled{}\r\n\r\n`,
    `--${B}--\r\n`,
  ].join('');
  const entry = (url, mimeType, type, body) => ({ method: 'GET', url, status: 200, mimeType, type, body: new Uint8Array(body) });
  const part = (out, location) => {
    const chunk = out.split(`--${B}`).find((c) => c.includes(`Content-Location: ${location}\r\n`));
    return chunk && Buffer.from(chunk.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64');
  };

  it('adds the fonts and the images the page names, once', () => {
    const out = completeSnapshot(mhtml, [
      entry('https://a.io/fonts/f.woff2', 'font/woff2', 'Font', [1, 2, 3]),
      entry('https://a.io/fonts/f.woff2', 'font/woff2', 'Font', [1, 2, 3]),
      entry('https://a.io/logo.png', 'image/png', 'Image', [4, 5]),
      entry('https://a.io/unused.png', 'image/png', 'Image', [6]),
      entry('https://a.io/app.js', 'text/javascript', 'Script', [7]),
    ]);
    assert.deepEqual([...part(out, 'https://a.io/fonts/f.woff2')], [1, 2, 3]);
    assert.deepEqual([...part(out, 'https://a.io/logo.png')], [4, 5]);
    assert.equal(out.split('Content-Location: https://a.io/fonts/f.woff2').length, 2);
    assert.equal(part(out, 'https://a.io/unused.png'), undefined);
    assert.equal(part(out, 'https://a.io/app.js'), undefined);
    assert.ok(out.endsWith(`--${B}--\r\n`));
  });

  it('asks for [disabled] instead of :disabled, which every control matches in MHTML', () => {
    const out = completeSnapshot(mhtml, []);
    const css = part(out, 'https://a.io/app.css').toString();
    assert.match(css, /button\[disabled\] \{ opacity: 0\.3 \}/);
    assert.match(css, /a:not\(\[disabled\]\)\{\}/);
    assert.match(part(out, 'https://a.io/').toString(), /<button>x<\/button>/); // soft line break decoded
  });

  it('leaves anything that is not MHTML alone', () => {
    assert.equal(completeSnapshot('<html></html>', []), '<html></html>');
  });
});

describe('snapshotPath', () => {
  it('names the start page snapshot.mhtml and numbers the others', () => {
    assert.equal(snapshotPath(0, 'https://a.io/x'), 'snapshot.mhtml');
    assert.equal(snapshotPath(1, 'https://a.io/docs/intro?lang=en'), 'snapshots/02-docs_intro_lang=en.mhtml');
    assert.equal(snapshotPath(2, 'https://a.io/'), 'snapshots/03-index.mhtml');
  });
});
