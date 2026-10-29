// Which pages to visit, and the functions run inside each page while it is recorded.
// The page functions are serialized with toString(): they must not reference anything
// outside their own body.

// Links that are clearly not pages, or that would end the user's session.
const SKIPPED_EXTENSIONS =
  /\.(zip|gz|tgz|bz2|xz|7z|rar|tar|exe|msi|dmg|pkg|deb|rpm|apk|iso|img|bin|mp4|mkv|mov|avi|webm|mp3|wav|flac|ogg)$/i;
const SESSION_ENDING = /(^|[/_.-])(log-?out|sign-?out|log-?off|sign-?off)([/_.?-]|$)/i;

/** Canonical form used to avoid visiting a page twice: no fragment. */
export function normalizePageUrl(url) {
  const u = new URL(url);
  u.hash = '';
  return u.href;
}

/**
 * Keeps the links worth crawling: same origin as the start page, under its path when
 * `samePath` is set, http(s) only, not files or logout links, each once.
 */
export function filterLinks(hrefs, { startUrl, samePath = false, seen = new Set() }) {
  const start = new URL(startUrl);
  const prefix = start.pathname.replace(/[^/]*$/, '');
  const out = [];
  for (const href of hrefs) {
    let u;
    try {
      u = new URL(href, startUrl);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(u.protocol) || u.origin !== start.origin) continue;
    if (samePath && !u.pathname.startsWith(prefix)) continue;
    if (SKIPPED_EXTENSIONS.test(u.pathname) || SESSION_ENDING.test(u.pathname + u.search)) continue;
    const url = normalizePageUrl(u.href);
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/** Page function: every link of the document. */
export function pageLinks() {
  return [...document.querySelectorAll('a[href], area[href]')].map((a) => a.href);
}

/**
 * Page function: requests the page's icons. The browser loads favicons outside the page,
 * where the debugger does not see them; fetched from the page, they are recorded.
 */
export async function fetchIcons() {
  const hrefs = new Set([...document.querySelectorAll('link[rel~="icon" i], link[rel="apple-touch-icon" i]')].map((l) => l.href));
  if (!document.querySelector('link[rel~="icon" i]')) hrefs.add(new URL('/favicon.ico', location.href).href);
  await Promise.all(
    [...hrefs].filter((h) => /^https?:/.test(h)).map((h) => fetch(h, { mode: 'no-cors', credentials: 'include' }).catch(() => {}))
  );
  return hrefs.size;
}

/** Page function: title and final URL once the page has loaded. */
export function pageInfo() {
  return { title: document.title, url: location.href };
}

/**
 * Page function: scrolls the document and every large scroll container to the bottom
 * in steps, so lazy images and infinite lists load, then restores the scroll positions.
 */
export async function scrollPage(stepDelay) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const scrollers = [document.scrollingElement || document.documentElement];
  for (const el of document.body ? document.body.querySelectorAll('*') : []) {
    if (el.clientHeight < innerHeight * 0.3 || el.scrollHeight <= el.clientHeight + 1) continue;
    const overflow = getComputedStyle(el).overflowY;
    if (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') scrollers.push(el);
  }
  for (const el of scrollers) {
    const original = el.scrollTop;
    let y = 0;
    for (let i = 0; i < 200; i++) {
      const max = el.scrollHeight - el.clientHeight;
      el.scrollTo({ top: y, behavior: 'instant' });
      await sleep(stepDelay);
      if (y >= max) break;
      y = Math.min(max, y + Math.max(200, el.clientHeight * 0.8));
    }
    el.scrollTo({ top: original, behavior: 'instant' });
  }
  return scrollers.length;
}
