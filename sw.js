/* Offline support for the configurable kiosk.
 * Network first, so updates show up straight away, with a fallback to the cached copy when offline.
 * Only this kiosk's own files are handled. Everything else, including the Shock Tech kiosk in web/
 * (which this worker's scope also covers when both are hosted together) and Google Sheets requests,
 * goes straight to the network untouched. */
const CACHE = 'vsi-v1';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './apps-script.js', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png'];
const OWN_PATHS = new Set(ASSETS.map(a => new URL(a, self.registration.scope).pathname));

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(ASSETS).catch(() => undefined))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !OWN_PATHS.has(url.pathname)) return;
  event.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});
