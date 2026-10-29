// Nogiti service worker: minimal offline shell for the installed app (TWA/PWA).
// Caches static assets so the app opens instantly and shows a friendly offline
// page instead of a browser error when there's no connection. Does NOT cache
// any HTML/API responses that depend on login state, cart, or admin data.
const CACHE_NAME = 'nogiti-shell-v1';
const OFFLINE_URL = '/offline.html';
const PRECACHE = [
  OFFLINE_URL,
  '/public/css/styles.css',
  '/public/js/main.js',
  '/public/images/nogiti-logo-96.webp',
  '/public/favicon-192x192.png',
  '/public/fonts/Vazirmatn-Variable.woff2',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

// Network-first for navigations (pages change often: products, prices, login state),
// falling back to the offline page only when the network truly fails.
// Cache-first for the static assets we precached (css/js/fonts/logo rarely change).
self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(OFFLINE_URL))
    );
    return;
  }

  if (PRECACHE.some(path => request.url.endsWith(path))) {
    event.respondWith(
      caches.match(request).then(cached => cached || fetch(request))
    );
  }
});
