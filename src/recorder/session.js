// Recording a tab's network traffic through the DevTools protocol (chrome.debugger).
//
// Every response the page receives is kept with its body: documents, stylesheets,
// scripts, images, fonts, and the XHR/fetch data the scripts load. Cross-origin iframes
// and workers run in their own targets; auto-attach brings their traffic in too.

const PROTOCOL = '1.3';
const MB = 1024 * 1024;

// Response headers that only describe the original transfer or the user's session.
const DROPPED_HEADERS = new Set(['set-cookie', 'set-cookie2']);

// A request still open after this long (long polling, event streams) no longer delays "idle".
const STALLED_MS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function decodeBody(body, base64Encoded) {
  if (!base64Encoded) return new TextEncoder().encode(body);
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function cleanHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const key = name.toLowerCase();
    if (!DROPPED_HEADERS.has(key)) out[key] = String(value);
  }
  return out;
}

export const isRecordable = (url) => /^https?:/i.test(url);

export class Recorder {
  /**
   * @param {number} tabId
   * @param {{ thirdParty?: boolean, onChange?: () => void }} options
   *   thirdParty: also keep responses from origins other than the start page's.
   */
  constructor(tabId, { thirdParty = true, onChange = () => {} } = {}) {
    this.target = { tabId };
    this.thirdParty = thirdParty;
    this.onChange = onChange;
    this.origin = null;
    this.entries = [];
    this.failed = 0;
    this.bytes = 0;
    this.recording = true;
    this.detachReason = null;
    this.requests = new Map(); // `${sessionId}:${requestId}` -> request in progress
    this.pending = new Set(); // body fetches in flight
    this.lastActivity = Date.now();
    this.loadWaiters = [];
    this.frames = new Set(); // sessionIds of attached cross-origin iframes
    this.handleEvent = this.handleEvent.bind(this);
    this.handleDetach = this.handleDetach.bind(this);
  }

  send(method, params = {}, sessionId) {
    if (this.detachReason) return Promise.reject(new Error(`debugger detached (${this.detachReason})`));
    const target = sessionId ? { ...this.target, sessionId } : this.target;
    return chrome.debugger.sendCommand(target, method, params);
  }

  async attach() {
    await chrome.debugger.attach(this.target, PROTOCOL);
    chrome.debugger.onEvent.addListener(this.handleEvent);
    chrome.debugger.onDetach.addListener(this.handleDetach);
    await this.send('Page.enable');
    await this.setupSession(undefined);
  }

  async detach() {
    chrome.debugger.onEvent.removeListener(this.handleEvent);
    chrome.debugger.onDetach.removeListener(this.handleDetach);
    if (!this.detachReason) {
      this.detachReason = 'finished';
      await chrome.debugger.detach(this.target).catch(() => {});
    }
  }

  /** Network settings for the page and for every iframe/worker target attached later. */
  async setupSession(sessionId) {
    const commands = [
      ['Network.enable', { maxTotalBufferSize: 256 * MB, maxResourceBufferSize: 64 * MB, maxPostDataSize: MB }],
      // Fetch everything from the network, so every body is available.
      ['Network.setCacheDisabled', { cacheDisabled: true }],
      // The site's own service worker would answer some requests out of sight.
      ['Network.setBypassServiceWorker', { bypass: true }],
      ['Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }],
    ];
    for (const [method, params] of commands) {
      try {
        await this.send(method, params, sessionId);
      } catch {
        /* not supported by this target type (e.g. workers) */
      }
    }
    if (sessionId) await this.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
  }

  handleDetach(source, reason) {
    if (source.tabId !== this.target.tabId) return;
    this.detachReason = reason;
    for (const resolve of this.loadWaiters) resolve();
    this.loadWaiters = [];
    this.onChange();
  }

  handleEvent(source, method, params) {
    if (source.tabId !== this.target.tabId) return;
    const sessionId = source.sessionId || '';
    const key = (id) => `${sessionId}:${id}`;

    switch (method) {
      case 'Target.attachedToTarget':
        if (params.targetInfo && params.targetInfo.type === 'iframe') this.frames.add(params.sessionId);
        this.setupSession(params.sessionId);
        break;
      case 'Target.detachedFromTarget':
        this.frames.delete(params.sessionId);
        break;
      case 'Page.loadEventFired':
        if (!sessionId) {
          for (const resolve of this.loadWaiters) resolve();
          this.loadWaiters = [];
        }
        break;
      case 'Network.requestWillBeSent': {
        this.lastActivity = Date.now();
        const previous = this.requests.get(key(params.requestId));
        if (previous && params.redirectResponse) {
          // The same requestId continues with the redirect target: the 3xx is an entry of its own.
          previous.response = params.redirectResponse;
          this.finish(previous, null);
        }
        if (!this.recording || !isRecordable(params.request.url)) break;
        this.requests.set(key(params.requestId), {
          sessionId,
          requestId: params.requestId,
          method: params.request.method,
          url: params.request.url.replace(/#.*$/, ''),
          postData: params.request.postData,
          hasPostData: !!params.request.hasPostData,
          type: params.type || 'Other',
          time: Math.round((params.wallTime || Date.now() / 1000) * 1000),
          started: Date.now(),
          response: null,
        });
        break;
      }
      case 'Network.responseReceived': {
        const request = this.requests.get(key(params.requestId));
        if (request) request.response = params.response;
        break;
      }
      case 'Network.loadingFinished': {
        this.lastActivity = Date.now();
        const request = this.requests.get(key(params.requestId));
        if (!request) break;
        this.requests.delete(key(params.requestId));
        if (request.response) this.track(this.fetchAndFinish(request));
        break;
      }
      case 'Network.loadingFailed': {
        this.lastActivity = Date.now();
        if (this.requests.delete(key(params.requestId)) && !params.canceled) this.failed++;
        this.onChange();
        break;
      }
      default:
    }
  }

  track(promise) {
    this.pending.add(promise);
    promise.finally(() => this.pending.delete(promise));
  }

  async fetchAndFinish(request) {
    let body = null;
    try {
      const res = await this.send('Network.getResponseBody', { requestId: request.requestId }, request.sessionId || undefined);
      body = decodeBody(res.body, res.base64Encoded);
    } catch {
      /* no body (204, HEAD, evicted from the buffer) */
    }
    if (request.hasPostData && request.postData === undefined) {
      try {
        const res = await this.send('Network.getRequestPostData', { requestId: request.requestId }, request.sessionId || undefined);
        request.postData = res.postData;
      } catch {
        /* body not available */
      }
    }
    this.finish(request, body);
  }

  finish(request, body) {
    const { response } = request;
    if (!this.thirdParty && this.origin && new URL(request.url).origin !== this.origin) return;
    this.entries.push({
      method: request.method,
      url: request.url,
      postData: request.postData,
      type: request.type,
      time: request.time,
      status: response.status,
      statusText: response.statusText || '',
      mimeType: response.mimeType || '',
      headers: cleanHeaders(response.headers),
      body,
    });
    if (body) this.bytes += body.length;
    this.onChange();
  }

  /** Waits until no request has started or finished for `quiet` ms, then for the bodies. */
  async waitForIdle({ quiet = 1500, timeout = 30_000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout && !this.detachReason) {
      const now = Date.now();
      const open = [...this.requests.values()].some((r) => now - r.started < STALLED_MS);
      if (!open && now - this.lastActivity >= quiet) break;
      await sleep(100);
    }
    await Promise.allSettled([...this.pending]);
  }

  /** Loads `url` in the tab and records everything until the network goes quiet. */
  async navigate(url, { quiet, timeout = 45_000 } = {}) {
    const loaded = new Promise((resolve) => {
      this.loadWaiters.push(resolve);
      setTimeout(resolve, timeout);
    });
    this.lastActivity = Date.now();
    const result = await this.send('Page.navigate', { url });
    if (result.errorText) throw new Error(`${url}: ${result.errorText}`);
    await loaded;
    await this.waitForIdle({ quiet });
  }

  /** Runs a page function (with JSON arguments) in the page and returns its JSON result. */
  evaluate(fn, ...args) {
    return this.evaluateIn(undefined, fn, args);
  }

  /**
   * Runs a page function in every frame of the tab, cross-origin ones included, in an
   * isolated world (the frame's DOM, out of the page's scripts' way). Frames that fail
   * are skipped.
   */
  async evaluateEverywhere(fn, ...args) {
    const results = [];
    for (const sessionId of [undefined, ...this.frames]) {
      let tree;
      try {
        ({ frameTree: tree } = await this.send('Page.getFrameTree', {}, sessionId));
      } catch {
        continue;
      }
      const frames = [];
      const walk = (node) => {
        frames.push(node.frame.id);
        for (const child of node.childFrames || []) walk(child);
      };
      walk(tree);
      for (const frameId of frames) {
        try {
          const { executionContextId } = await this.send('Page.createIsolatedWorld', { frameId, worldName: 'site-mirror' }, sessionId);
          results.push(await this.evaluateIn(sessionId, fn, args, executionContextId));
        } catch {
          /* frame gone, or out of process (handled through its own session) */
        }
      }
    }
    return results;
  }

  async evaluateIn(sessionId, fn, args = [], contextId = undefined) {
    const res = await this.send(
      'Runtime.evaluate',
      { expression: `(${fn})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true, userGesture: true, contextId },
      sessionId
    );
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text);
    }
    return res.result.value;
  }

  /** The tab as it is now, iframes included, as an MHTML document. */
  async snapshot() {
    const { data } = await this.send('Page.captureSnapshot', { format: 'mhtml' });
    return data;
  }

  /** Cookies scripts can read (not HttpOnly) for `url`. */
  async scriptCookies(url) {
    const { cookies } = await this.send('Network.getCookies', { urls: [url] });
    return cookies.filter((c) => !c.httpOnly).map(({ name, value }) => ({ name, value }));
  }

  /**
   * Adds the responses the site keeps in CacheStorage for `origins`. Pages read those
   * without going to the network (icons, offline data), so the recording never saw them.
   */
  async recordCacheStorage(origins, { maxBytes = 200 * MB } = {}) {
    const recorded = new Set(this.entries.filter((e) => e.method === 'GET').map((e) => e.url));
    let added = 0;
    for (const securityOrigin of origins) {
      let caches = [];
      try {
        ({ caches } = await this.send('CacheStorage.requestCacheNames', { securityOrigin }));
      } catch {
        continue;
      }
      for (const cache of caches) {
        for (let skip = 0; skip < 5000; skip += 200) {
          const { cacheDataEntries } = await this.send('CacheStorage.requestEntries', {
            cacheId: cache.cacheId,
            skipCount: skip,
            pageSize: 200,
          });
          for (const entry of cacheDataEntries) {
            const url = entry.requestURL.replace(/#.*$/, '');
            if (!isRecordable(url) || recorded.has(url) || (entry.requestMethod || 'GET') !== 'GET') continue;
            if (this.bytes > maxBytes) return added;
            if (!this.thirdParty && this.origin && new URL(url).origin !== this.origin) continue;
            let body = null;
            try {
              const res = await this.send('CacheStorage.requestCachedResponse', {
                cacheId: cache.cacheId,
                requestURL: entry.requestURL,
                requestHeaders: entry.requestHeaders,
              });
              body = decodeBody(res.response.body, true);
            } catch {
              continue;
            }
            const headers = cleanHeaders(Object.fromEntries(entry.responseHeaders.map((h) => [h.name, h.value])));
            this.entries.push({
              method: 'GET',
              url,
              type: 'CacheStorage',
              time: Math.round(entry.responseTime * 1000) || Date.now(),
              status: entry.responseStatus || 200,
              statusText: entry.responseStatusText || '',
              mimeType: (headers['content-type'] || '').split(';')[0].trim(),
              headers,
              body,
            });
            recorded.add(url);
            this.bytes += body.length;
            added++;
          }
          if (cacheDataEntries.length < 200) break;
        }
      }
    }
    this.onChange();
    return added;
  }
}
