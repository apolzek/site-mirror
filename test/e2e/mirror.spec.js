// End to end: record the fixture site through the extension, shut the site down, then
// replay the archive with serve.mjs and check the page shows the very same data.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { unzip } from '../unit/helpers/unzip.js';
import { expect, test } from './extension.js';
import { CDN, ORIGIN, startSites } from './sites.mjs';

const REPLAY_PORT = 4190;

async function extract(zipFile, dir) {
  for (const [name, { data }] of await unzip(fs.readFileSync(zipFile))) {
    const target = path.join(dir, name);
    if (!target.startsWith(dir + path.sep)) throw new Error(`unsafe path in archive: ${name}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
}

function startReplay(dir) {
  const child = spawn(process.execPath, ['serve.mjs', '--port', String(REPLAY_PORT)], { cwd: dir });
  const output = { text: '' };
  child.stdout.on('data', (d) => (output.text += d));
  child.stderr.on('data', (d) => (output.text += d));
  const ready = new Promise((resolve, reject) => {
    child.on('exit', (code) => reject(new Error(`serve.mjs exited with ${code}: ${output.text}`)));
    const check = setInterval(() => {
      if (output.text.includes('Open http://')) {
        clearInterval(check);
        resolve();
      }
    }, 50);
  });
  return { child, output, ready };
}

test('a crawled site replays offline with the data it had', async ({ context, mirrorVia }, testInfo) => {
  const sites = await startSites();
  let replay;
  try {
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    await expect(page.locator('#items li')).toHaveCount(2);

    const { file, filename, pages } = await mirrorVia(page, { crawl: true, maxPages: 5, maxDepth: 2, quiet: 1 });
    expect(filename).toMatch(/^mirror_127\.0\.0\.1-4180_\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d\.zip$/);
    expect(pages).toEqual([`${ORIGIN}/`, `${ORIGIN}/about.html`]);
    expect(sites.hits['/logout']).toBeUndefined(); // never follows logout links
    // The tab is back on the start page.
    await expect(page).toHaveURL(`${ORIGIN}/`);
    await page.close();

    // From here on the original site is gone: everything must come from the archive.
    await sites.close();

    const dir = testInfo.outputPath('mirror');
    await extract(file, dir);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'mirror.json'), 'utf8'));
    const recorded = (pathname) => {
      const entry = manifest.entries.find((e) => new URL(e.url).pathname === pathname);
      expect(entry, `${pathname} was recorded`).toBeTruthy();
      return fs.readFileSync(path.join(dir, entry.file), 'utf8');
    };
    const items = JSON.parse(recorded('/api/items'));
    const search = JSON.parse(recorded('/api/search'));
    const lazy = recorded('/api/lazy');
    const about = recorded('/api/about');
    const cdn = JSON.parse(recorded('/data.json'));
    expect(fs.existsSync(path.join(dir, 'files/127.0.0.1_4180/index.html'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'files/127.0.0.1_4181/photo.svg'))).toBe(true);
    expect(manifest.entries.some((e) => e.url === `${CDN}/photo.svg`)).toBe(true); // loaded by the scroll

    replay = startReplay(dir);
    await replay.ready;
    const mirror = await context.newPage();
    await mirror.goto(`http://localhost:${REPLAY_PORT}/`);

    await expect(mirror.locator('#title')).toHaveText(items.title);
    await expect(mirror.locator('#items li')).toHaveText(items.items);
    await expect(mirror.locator('#search')).toHaveText(search.result);
    await expect(mirror.locator('#cdn')).toHaveText(cdn.message);
    await expect(mirror.locator('.logo')).toHaveJSProperty('naturalWidth', 40);
    expect(await mirror.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(250, 240, 230)');
    expect(await mirror.locator('#cdn').evaluate((el) => getComputedStyle(el).color)).toBe('rgb(1, 2, 3)');

    // The page saw the recording's clock, not today's.
    const docTime = manifest.entries.find((e) => e.type === 'Document' && e.url === `${ORIGIN}/`).time;
    const clock = Number(await mirror.locator('#clock').textContent());
    expect(Math.abs(clock - docTime)).toBeLessThan(5000);

    // Lazy content from another origin, loaded on scroll.
    await mirror.locator('#lazy-data').scrollIntoViewIfNeeded();
    await expect(mirror.locator('#lazy-data')).toHaveText(lazy);
    await expect(mirror.locator('#lazy')).toHaveJSProperty('naturalWidth', 120);

    // Links work inside the mirror.
    await mirror.evaluate(() => scrollTo(0, 0));
    await mirror.click('#about');
    await expect(mirror).toHaveURL(`http://localhost:${REPLAY_PORT}/about.html`);
    await expect(mirror.locator('#about-data')).toHaveText(about);

    const misses = replay.output.text.split('\n').filter((l) => /^404 /.test(l) && !/favicon\.ico/.test(l));
    expect(misses).toEqual([]);
  } finally {
    if (replay) replay.child.kill();
    await sites.close().catch(() => {});
  }
});

test('a single page without third-party files', async ({ context, mirrorVia }, testInfo) => {
  const sites = await startSites();
  try {
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    const { file, pages } = await mirrorVia(page, { crawl: false, thirdParty: false, scroll: false, quiet: 1 });
    expect(pages).toEqual([`${ORIGIN}/`]);
    const names = [...(await unzip(fs.readFileSync(file))).keys()];
    expect(names.some((n) => /^files\/127\.0\.0\.1_4180\/api\/items@[0-9a-f]{8}\.json$/.test(n))).toBe(true);
    expect(names.some((n) => n.startsWith('files/127.0.0.1_4181/'))).toBe(false);
    expect(names.some((n) => n.includes('/api/lazy'))).toBe(false); // not scrolled into view
    expect(names.some((n) => n.includes('about'))).toBe(false);
  } finally {
    await sites.close();
  }
});
