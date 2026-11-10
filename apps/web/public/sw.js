/*
 * Rakan service worker — keeps the field app usable without a connection.
 * - Built assets (/_next/static/*): cache-first (file names are content-hashed).
 * - Pages (navigations): network-first; the last good copy is served offline, else /offline.html.
 * - API calls are never cached here: the app stores data itself (IndexedDB, per user, wiped on sign-out).
 */
const VERSION = 'rakan-v1';
const STATIC = `${VERSION}-static`;
const PAGES = `${VERSION}-pages`;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(PAGES).then((c) => c.addAll(['/offline.html', '/manifest.webmanifest', '/icons/icon-192.png'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(STATIC)).put(req, res.clone());
  return res;
}

async function pageNetworkFirst(req) {
  const cache = await caches.open(PAGES);
  const key = new URL(req.url).pathname;
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') cache.put(key, res.clone());
    return res;
  } catch {
    return (await cache.match(key)) || (await cache.match('/offline.html'));
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(cacheFirst(req));
  } else if (req.mode === 'navigate') {
    event.respondWith(pageNetworkFirst(req));
  }
});

// The app asks to keep today's screens available offline (after downloading the field pack).
self.addEventListener('message', (event) => {
  if (event.data?.type === 'warm' && Array.isArray(event.data.paths)) {
    event.waitUntil(
      caches.open(PAGES).then((cache) =>
        Promise.all(
          event.data.paths
            .filter((p) => typeof p === 'string' && p.startsWith('/') && !p.startsWith('//'))
            .slice(0, 40)
            .map((p) => fetch(p, { credentials: 'same-origin' }).then((res) => (res.ok ? cache.put(p, res) : undefined)).catch(() => undefined)),
        ),
      ),
    );
  }
  if (event.data?.type === 'wipe') event.waitUntil(caches.delete(PAGES));
});
