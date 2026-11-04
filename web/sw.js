// Keeps the kiosk loading when the Wi-Fi is down (a nightly reload, a power
// cut). The page and its scripts are fetched fresh whenever the network
// answers, so updates show up at once; the copy kept here is only the fallback.
// The face-recognition models never change, so they are served from here.
// Requests to Google (the Sheets backend) are never touched.
const VERSION = '1.0.0';
const SHELL = `kiosk-shell-${VERSION}`;
const MODELS = 'kiosk-models-1';

const FILES = [
  './', 'index.html', 'styles.css', 'config.js', 'kiosk-connection.js', 'manifest.webmanifest', 'assets/icon-512.png',
  'js/api.js', 'js/app.js', 'js/backend-code.js', 'js/face.js', 'js/files.js', 'js/i18n.js', 'js/keyboard.js',
  'js/match.js', 'js/nfc.js', 'js/settings.js', 'js/setup.js', 'js/transitions.js', 'vendor/face-api/face-api.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== SHELL && key !== MODELS && key.startsWith('kiosk-')) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scope.pathname)) return;

  if (url.pathname.includes('/vendor/face-api/model/')) {
    event.respondWith(caches.open(MODELS).then(async (cache) => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    }));
    return;
  }

  // Network first (with a time limit), falling back to the saved copy.
  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const key = req.mode === 'navigate' ? new URL('index.html', self.registration.scope).href : req;
    try {
      const res = await Promise.race([
        fetch(req),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 6000)),
      ]);
      if (res.ok && res.type === 'basic') cache.put(key, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(key, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
