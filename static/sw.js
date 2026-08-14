const CACHE_PREFIX = 'mdnotes-shell-';
const LEGACY_CACHE = 'mdnotes-shell';
const revisionFromURL = new URL(self.location.href).searchParams.get('revision') || 'legacy';
const safeRevision = /^[A-Za-z0-9._-]{1,128}$/.test(revisionFromURL) ? revisionFromURL : 'legacy';
const CACHE = `${CACHE_PREFIX}${safeRevision}`;
const ASSETS = [
  '/', '/index.html', '/style.css', '/themes.js', '/app.js', '/merge.js', '/marked.min.js',
  '/manifest.json', '/favicon.ico', '/favicon.svg',
  '/icon-192.png', '/icon-512.png', '/logo.svg'
];
const SHELL_ASSETS = new Set(ASSETS);
const FONT_CACHE = 'mdnotes-fonts';
const FONT_ORIGINS = new Set(['https://fonts.googleapis.com', 'https://fonts.gstatic.com']);

async function normalizeShellResponse(response) {
  if (!response) return undefined;
  const headers = new Headers(response.headers);
  headers.delete('Content-Encoding');
  headers.delete('Content-Length');
  return new Response(await response.arrayBuffer(), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isShellCache(name) {
  return name === LEGACY_CACHE || name.startsWith(CACHE_PREFIX);
}

async function cachedShellResponse(request) {
  const cache = await caches.open(CACHE);
  if (request.mode === 'navigate') return normalizeShellResponse((await cache.match('/index.html')) || await cache.match('/'));
  return normalizeShellResponse(await cache.match(request));
}

async function fetchShellAsset(request) {
  const response = await fetch(request, {cache: 'no-cache', headers: {'X-MDNotes-Shell': '1'}});
  if (response.ok) {
    const url = new URL(request.url);
    if (!url.search && SHELL_ASSETS.has(url.pathname)) {
      const cache = await caches.open(CACHE);
      await cache.put(url.pathname, response.clone());
    }
  }
  return response;
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    // This cache is revision-specific, so a failed install cannot modify the
    // cache used by the active worker.
    const cache = await caches.open(CACHE);
    await Promise.all(ASSETS.map(async asset => {
      const response = await fetch(asset, {cache: 'no-cache', headers: {'X-MDNotes-Shell': '1'}});
      if (!response.ok) throw new Error(`could not cache ${asset}`);
      await cache.put(asset, response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => isShellCache(key) && key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const {request} = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (FONT_ORIGINS.has(url.origin)) {
    e.respondWith(caches.open(FONT_CACHE).then(async cache => {
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      // gstatic can be returned as an opaque response in some browser modes.
      // It is still a valid cache entry for the browser's font loader.
      if (response.ok || response.type === 'opaque') await cache.put(request, response.clone());
      return response;
    }).catch(async () => (await caches.match(request)) || new Response('', {status: 503, statusText: 'Offline'})));
    return;
  }
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    e.respondWith((async () => {
      const cached = await cachedShellResponse(request);
      if (cached) return cached;
      try {
        return await fetchShellAsset(request);
      } catch (_) {
        return new Response('The app is unavailable offline.', {
          status: 503,
          headers: {'Content-Type': 'text/plain; charset=utf-8'},
        });
      }
    })());
    return;
  }

  if (!SHELL_ASSETS.has(url.pathname) || url.search) return;
  e.respondWith((async () => {
    const cached = await cachedShellResponse(request);
    if (cached) return cached;
    try {
      return await fetchShellAsset(request);
    } catch (_) {
      return new Response('', {status: 503, statusText: 'Offline'});
    }
  })());
});
