import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {expect, test, vi} from 'vitest';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const serviceWorkerSource = fs.readFileSync(path.join(testDirectory, '..', 'static', 'sw.js'), 'utf8');

function cacheKey(request) {
  return typeof request === 'string' ? new URL(request, 'http://localhost:8080/').href : request.url;
}

function createCacheStorage() {
  const entries = new Map();
  const caches = {
    async open(name) {
      if (!entries.has(name)) {
        const values = new Map();
        entries.set(name, {
          async match(request) {
            const response = values.get(cacheKey(request));
            return response?.clone();
          },
          async put(request, response) {
            values.set(cacheKey(request), response.clone());
          },
          values,
        });
      }
      return entries.get(name);
    },
    async match(request) {
      for (const cache of entries.values()) {
        const response = await cache.match(request);
        if (response) return response;
      }
      return undefined;
    },
    async keys() {
      return [...entries.keys()];
    },
    async delete(name) {
      return entries.delete(name);
    },
    entries,
  };
  return caches;
}

function loadWorker({revision = 'new', caches, fetchImpl}) {
  const handlers = new Map();
  const self = {
    location: new URL(`http://localhost:8080/sw.js?revision=${revision}`),
    addEventListener(type, handler) {
      handlers.set(type, handler);
    },
    skipWaiting: vi.fn(async () => {}),
    clients: {claim: vi.fn(async () => {})},
  };
  const context = {
    self,
    caches,
    fetch: fetchImpl,
    URL,
    Request,
    Response,
    Headers,
    console,
  };
  vm.runInNewContext(serviceWorkerSource, context);
  return {
    self,
    async install() {
      const promises = [];
      handlers.get('install')({waitUntil: promise => promises.push(Promise.resolve(promise))});
      return Promise.all(promises);
    },
    async activate() {
      const promises = [];
      handlers.get('activate')({waitUntil: promise => promises.push(Promise.resolve(promise))});
      return Promise.all(promises);
    },
    async fetch(request) {
      let responsePromise;
      handlers.get('fetch')({request, respondWith: promise => { responsePromise = Promise.resolve(promise); }});
      return responsePromise;
    },
  };
}

test('a failed install leaves the active revision cache untouched', async () => {
  const caches = createCacheStorage();
  const oldCache = await caches.open('mdnotes-shell-old');
  await oldCache.put('/app.js', new Response('old app'));
  const fetchImpl = vi.fn(async (request, options) => {
    expect(options.headers['X-MDNotes-Shell']).toBe('1');
    if (String(request).endsWith('/app.js')) throw new Error('asset unavailable');
    return new Response(`asset ${request}`);
  });
  const worker = loadWorker({caches, fetchImpl});

  await expect(worker.install()).rejects.toThrow('asset unavailable');
  expect(await caches.keys()).toEqual(expect.arrayContaining(['mdnotes-shell-old', 'mdnotes-shell-new']));
  expect(await (await caches.open('mdnotes-shell-old')).match('/app.js')).toBeDefined();
  expect(worker.self.skipWaiting).not.toHaveBeenCalled();
});

test('activation promotes a complete revision and removes old shell caches', async () => {
  const caches = createCacheStorage();
  await caches.open('mdnotes-shell-old');
  await caches.open('mdnotes-shell');
  await caches.open('mdnotes-fonts');
  const worker = loadWorker({caches, fetchImpl: async request => new Response(`asset ${request}`)});

  await worker.install();
  await worker.activate();

  expect(await caches.keys()).toEqual(expect.arrayContaining(['mdnotes-shell-new', 'mdnotes-fonts']));
  expect(await caches.keys()).not.toEqual(expect.arrayContaining(['mdnotes-shell-old', 'mdnotes-shell']));
  expect(worker.self.clients.claim).toHaveBeenCalledOnce();
});

test('navigation is served from the active shell cache without waiting for network', async () => {
  const caches = createCacheStorage();
  const shell = await caches.open('mdnotes-shell-new');
  await shell.put('/index.html', new Response('cached shell'));
  const fetchImpl = vi.fn(async () => { throw new Error('network unavailable'); });
  const worker = loadWorker({caches, fetchImpl});

  const response = await worker.fetch({method: 'GET', mode: 'navigate', url: 'http://localhost:8080/note-a'});
  expect(await response.text()).toBe('cached shell');
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('caches Google Fonts CSS and font binaries for offline reloads', async () => {
  const caches = createCacheStorage();
  const fetchImpl = vi.fn(async request => {
    const url = typeof request === 'string' ? request : request.url;
    if (url.includes('fonts.googleapis.com')) return new Response('font css');
    if (url.includes('fonts.gstatic.com')) return new Response('font binary');
    throw new Error(`unexpected request: ${url}`);
  });
  const worker = loadWorker({caches, fetchImpl});
  const cssRequest = {method: 'GET', url: 'https://fonts.googleapis.com/css2?family=Inter'};
  const fontRequest = {method: 'GET', url: 'https://fonts.gstatic.com/s/inter/test.woff2'};

  expect(await (await worker.fetch(cssRequest)).text()).toBe('font css');
  expect(await (await worker.fetch(fontRequest)).text()).toBe('font binary');
  expect(await (await worker.fetch(cssRequest)).text()).toBe('font css');
  expect(await (await worker.fetch(fontRequest)).text()).toBe('font binary');
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
