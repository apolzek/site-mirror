# Site Mirror

[![CI](https://github.com/apolzek/site-mirror/actions/workflows/ci.yml/badge.svg)](https://github.com/apolzek/site-mirror/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Chrome extension that copies a website the way HTTrack does, and can play it back **exactly as it was, with its data**.

HTTrack downloads the files a site links to. Pages built by JavaScript need more than that: the API responses their scripts fetched at that moment. Site Mirror records everything the browser actually received while the page loaded:

- HTML documents
- CSS
- JS
- images and fonts
- the XHR/fetch, POST and iframe responses

It saves all of it in a ZIP, with two ways to open the copy offline:

- **`snapshot.mhtml`**: the page exactly as it was on screen when you clicked **Copy site**, including charts drawn on canvases, text you typed, and iframes. Double-click it to open it in Chrome or Edge. It needs nothing else, but it is a still picture: its scripts don't run.
- **`node serve.mjs`**: the site running again from the recording, with its scripts, links and data, the same localStorage, cookies and cache, and the same clock.

| In the ZIP | What it is |
| --- | --- |
| `snapshot.mhtml` | The start page as it was on screen. `snapshots/` has the other pages of a crawl. |
| `files/<host>/<path>` | Every response body, named after its URL (`files/example.com/api/items.json`). |
| `mirror.json` | Each request (method, URL, request body) with its status, headers and body file. |
| `serve.mjs` | The replay server. It is a single file with no dependencies. |
| `README.txt` | How to replay this recording. |

## Use

1. Open the site in a tab. Log in first if the content needs it, since the recording uses your session.
2. Click the extension's icon. Choose **This page only**, or **Follow links on this site** with a page and depth limit, then click **Copy site**.
3. A small recorder window opens. It first saves the tab as it is (snapshot, localStorage, sessionStorage, cookies). Then it reloads the page to record every response, scrolls to load lazy content, waits for the network to go quiet, follows links if you asked it to, reads the site's CacheStorage, and downloads `mirror_<host>_<date>.zip`.

Open the copy:

```sh
unzip mirror_example.com_2026-10-29_10-00-00.zip -d mirror
# exactly as it was on screen: open mirror/snapshot.mhtml in Chrome

cd mirror && node serve.mjs          # the live site, offline (Node.js 18 or later)
# open http://localhost:8080/        # --port 8080 --host 127.0.0.1 --no-freeze-time --strict
```

## How replay works

- **Every request is answered from the recording.** The server stands in for the recorded origin. A service worker that it installs on the first visit sends the page's requests to other origins (CDNs, fonts, APIs) to the server as well, as `/__mirror/o/<scheme>/<host>/<path>`, so nothing goes to the network and relative URLs inside those files still work.
- **Requests are matched, not just looked up.** An exact match (method, URL and POST body) wins. Otherwise the server picks the closest recorded request on the same path, so cache-busting parameters like `?_=1730000000` still find their data. Repeated requests, such as polling, get the recorded answers in their original order.
- **The page starts with the state it had.** The localStorage, sessionStorage and script-readable cookies of the moment you clicked are restored on the first visit (theme, selected tabs, dismissed popups). Responses the site kept in CacheStorage, which the page reads without going to the network, are part of the recording.
- **The clock is frozen at the recording time.** Pages that compute "last 6 hours" or "today" ask for the same ranges they asked for when they were recorded. Use `--no-freeze-time` to turn this off.
- **Links stay inside the mirror.** Absolute links to the recorded origin become local, and cross-origin iframes are served from the recording.
- **The original headers are replayed, minus a few.** CSP, `X-Frame-Options`, HSTS, cookies and the original transfer encodings are dropped.
- **Client-side routes the crawl never loaded** get the start page, so the app's router can handle them.
- **Data requests that were never recorded** (a background ping, a click you didn't make) get an empty JSON object `{}`, which most apps ignore, where a 404 would show an error. Files that were never recorded get a 404. Use `--strict` to answer every miss with a 404. The server logs each miss.

## Install

```sh
npm ci
npm run build   # outputs dist/
```

Then:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select `dist/`.

Site Mirror needs Chrome, Edge or Brave 125 or later.

## Permissions and privacy

- **`debugger`** is the permission used to read the response bodies. While a recording runs, Chrome shows a "started debugging this browser" bar.
- **`activeTab`** gives access to the tab you click the extension on.
- Nothing is sent anywhere. The ZIP is built locally.
- `Set-Cookie` headers and request headers are not saved. HttpOnly cookies are not saved.
- The localStorage, sessionStorage and script-readable cookies of the start page are saved in `mirror.json`, so the replay starts with the same state. Apps sometimes keep tokens there.
- The responses themselves are saved as they were. If the site showed your private data, the ZIP contains it.
- When it follows links, the crawler skips logout and sign-out links and downloads such as `.zip` or `.mp4`.

## Limitations

- **WebSockets and Server-Sent Events** are not recorded. Live streams stop at the recorded state.
- **Unrecorded interactions don't replay.** Anything that needs a request the recording never made, such as a search you didn't run or a page you didn't visit, returns `404 Not in the recording` (the server logs these misses). To include it, record it: open the page in that state and copy again with **This page only**.
- **The snapshot is a still picture.** MHTML opens in Chrome and Edge, not Firefox. Its scripts don't run, and its scroll position starts at the top.
- **IndexedDB is not restored.** Apps that keep their state there start without it in the replay; the snapshot still shows it.
- **Time is frozen only in the page's main thread.** Web workers see the real clock.
- **Video streamed with range requests** may not seek or play beyond what was recorded.
- **Bot protection pages** (Cloudflare challenges, CAPTCHAs) are recorded as what they are. Pass the check in the tab first.
- **The ZIP format is limited to 4 GB** (no ZIP64).

## Development

```sh
npm ci
npm run build          # dist/; `npm run watch` rebuilds on change
npm test               # unit tests (node:test)
npm run test:e2e       # records the fixture site through the real extension, shuts it down,
                       # replays the archive with serve.mjs and checks the data matches
npm run fixture        # serves the fixture site on http://127.0.0.1:4180/ to try by hand
npm run package        # site-mirror-<version>.zip
```

Set `CHROMIUM_PATH` to run the end-to-end tests with a system Chromium instead of Playwright's.

Layout:

| Path | What it does |
| --- | --- |
| `src/popup/` | Options. Opens the recorder window for the active tab. |
| `src/recorder/session.js` | DevTools-protocol recording, including auto-attached iframes and workers. |
| `src/recorder/crawl.js` | Which links to follow, plus the scripts run in each page (scroll, links, icons, storage, freezing canvases and form values for the snapshot). |
| `src/recorder/archive.js` | File naming, `mirror.json`, the snapshots (fonts added) and the ZIP. |
| `replay/serve.mjs` | The replay server. It is bundled into every archive. |

## License

[MIT](LICENSE)
