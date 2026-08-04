const CACHE = 'mdnotes-v39';
const ASSETS = [
  '/', '/index.html', '/style.css', '/app.js', '/merge.js', '/marked.min.js',
  '/manifest.json', '/favicon.ico', '/favicon.svg',
  '/icon-192.png', '/icon-512.png', '/logo.svg'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Only app-shell requests belong to this worker. Third-party requests (for
  // example an analytics beacon injected by a proxy) must be left to the
  // browser, rather than becoming part of our offline cache or fallback path.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        e.waitUntil(caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {}));
      }
      return response;
    }).catch(async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      if (request.mode === 'navigate') {
        return (await caches.match('/')) || new Response('The app is unavailable offline.', {
          status: 503,
          headers: {'Content-Type': 'text/plain; charset=utf-8'},
        });
      }
      return new Response('', {status: 503, statusText: 'Offline'});
    })
  );
});
