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
