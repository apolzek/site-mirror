// The site under test: an origin whose pages render data from its API (a new random
// token on every request), and a "CDN" on another origin with a stylesheet, an image
// and CORS-enabled JSON.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const fixtures = path.resolve(import.meta.dirname, '../fixtures');
const types = { '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.js': 'text/javascript' };
export const ORIGIN = 'http://127.0.0.1:4180';
export const CDN = 'http://127.0.0.1:4181';

function serveStatic(root, req, res, headers = {}) {
  const file = path.join(root, path.normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  const target = fs.existsSync(file) && fs.statSync(file).isDirectory() ? path.join(file, 'index.html') : file;
  if (!target.startsWith(root) || !fs.existsSync(target)) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': types[path.extname(target)] || 'application/octet-stream', ...headers });
  fs.createReadStream(target).pipe(res);
}

const listen = (server, port) => new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

export async function startSites() {
  const hits = {};
  const token = () => crypto.randomBytes(4).toString('hex');
  const json = (res, value) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));

  const origin = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, ORIGIN);
    hits[pathname] = (hits[pathname] || 0) + 1;
    if (pathname === '/api/items') return json(res, { title: `Shop ${token()}`, items: [`shoe ${token()}`, `hat ${token()}`] });
    if (pathname === '/api/search') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => json(res, { result: `found ${JSON.parse(body).q} ${token()}` }));
      return;
    }
    if (pathname === '/api/lazy') return res.writeHead(200, { 'content-type': 'text/plain' }).end(`lazy ${token()}`);
    if (pathname === '/api/about') return res.writeHead(200, { 'content-type': 'text/plain' }).end(`about ${token()}`);
    if (pathname === '/logout') return res.writeHead(200).end('logged out');
    return serveStatic(path.join(fixtures, 'site'), req, res, { 'content-security-policy': "frame-ancestors 'none'" });
  });

  const cdn = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, CDN);
    hits[`cdn:${pathname}`] = (hits[`cdn:${pathname}`] || 0) + 1;
    const cors = { 'access-control-allow-origin': '*' };
    if (pathname === '/data.json') {
      return res.writeHead(200, { 'content-type': 'application/json', ...cors }).end(JSON.stringify({ message: `from cdn ${token()}` }));
    }
    return serveStatic(path.join(fixtures, 'cdn'), req, res, cors);
  });

  await Promise.all([listen(origin, 4180), listen(cdn, 4181)]);
  return {
    hits,
    close: async () => {
      for (const server of [origin, cdn]) {
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
      }
    },
  };
}

// `npm run fixture` serves the site for trying the extension by hand.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startSites();
  console.log(`Fixture site on ${ORIGIN}/ (CDN on ${CDN})`);
}
