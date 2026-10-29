import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { filterLinks, normalizePageUrl } from '../../src/recorder/crawl.js';
import { cleanHeaders, decodeBody } from '../../src/recorder/session.js';

describe('filterLinks', () => {
  const startUrl = 'https://site.io/docs/intro';

  it('keeps same-origin pages once, without fragments', () => {
    const links = filterLinks(
      ['/docs/a', 'https://site.io/docs/a#top', 'b', 'https://other.io/x', 'mailto:me@site.io', 'javascript:void 0', '/blog/1'],
      { startUrl }
    );
    assert.deepEqual(links, ['https://site.io/docs/a', 'https://site.io/docs/b', 'https://site.io/blog/1']);
  });

  it('skips downloads and logout links', () => {
    const links = filterLinks(['/file.zip', '/movie.MP4', '/logout', '/account/sign-out?next=/', '/auth/logoff', '/catalog', '/blog/logged-out-users'], { startUrl });
    assert.deepEqual(links, ['https://site.io/catalog', 'https://site.io/blog/logged-out-users']);
  });

  it('can stay under the start folder', () => {
    assert.deepEqual(filterLinks(['/docs/x', '/blog/y'], { startUrl, samePath: true }), ['https://site.io/docs/x']);
  });

  it('shares the seen set across calls', () => {
    const seen = new Set([normalizePageUrl(startUrl)]);
    assert.deepEqual(filterLinks(['/docs/intro#x', '/docs/a'], { startUrl, seen }), ['https://site.io/docs/a']);
    assert.deepEqual(filterLinks(['/docs/a'], { startUrl, seen }), []);
  });
});

describe('session helpers', () => {
  it('decodes text and base64 bodies', () => {
    assert.deepEqual([...decodeBody('hé', false)], [104, 195, 169]);
    assert.deepEqual([...decodeBody('AAH/', true)], [0, 1, 255]);
  });

  it('lowercases headers and drops cookies', () => {
    assert.deepEqual(cleanHeaders({ 'Content-Type': 'text/html', 'Set-Cookie': 'a=1' }), { 'content-type': 'text/html' });
  });
});
