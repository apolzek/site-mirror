// Renders everything from requests, so a copy without the data would be empty.
const t0 = Date.now();
const $ = (id) => document.getElementById(id);
$('clock').textContent = String(t0);

fetch('/api/items?ts=' + t0)
  .then((r) => r.json())
  .then((d) => {
    $('title').textContent = d.title;
    for (const item of d.items) $('items').append(Object.assign(document.createElement('li'), { textContent: item }));
  });

fetch('/api/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: 'shoes', at: t0 }) })
  .then((r) => r.json())
  .then((d) => ($('search').textContent = d.result));

fetch('http://127.0.0.1:4181/data.json')
  .then((r) => r.json())
  .then((d) => ($('cdn').textContent = d.message));

new IntersectionObserver((entries, observer) => {
  if (!entries.some((e) => e.isIntersecting)) return;
  observer.disconnect();
  fetch('/api/lazy').then((r) => r.text()).then((t) => ($('lazy-data').textContent = t));
}).observe($('lazy-data'));

// State the page keeps outside the network: a theme in localStorage, a cookie, and an
// icon in CacheStorage that only the first visit downloads.
document.body.dataset.theme = localStorage.getItem('theme') || 'default';
$('pref').textContent = (document.cookie.match(/(?:^|; )pref=([^;]*)/) || [])[1] || 'none';

caches.open('icons').then(async (cache) => {
  let res = await cache.match('/cached.svg');
  if (!res) {
    await cache.add('/cached.svg');
    res = await cache.match('/cached.svg');
  }
  $('cached').src = URL.createObjectURL(await res.blob());
});

// A chart drawn on a canvas: a snapshot has to keep the drawing.
const ctx = $('chart').getContext('2d');
ctx.fillStyle = 'rgb(200, 30, 40)';
ctx.fillRect(0, 0, 100, 50);
