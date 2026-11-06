// Makes the kiosk start instantly, even without Wi-Fi (a nightly reload, a
// power cut).
//
// Published builds (GitHub Pages, the release zip) have BUILD stamped with the
// commit, so each deploy is a new version of this file: the browser installs
// it, it fetches the whole new kiosk in one go, and the kiosk switches over at
// its next quiet moment. Until then everything is served from the saved copy,
// with no waiting on the network.
// Unstamped copies (BUILD 'dev', e.g. while developing) fetch fresh files
// whenever the network answers and fall back to the saved copy.
// The face-recognition models never change, so they're kept separately.
// Requests to Google (the Sheets backend) are never touched.
const VERSION = '1.1.0';
const BUILD = 'dev';
const SHELL = `kiosk-shell-${VERSION}-${BUILD}`;
const MODELS = 'kiosk-models-1';

const FILES = [
  './', 'index.html', 'styles.css', 'config.js', 'kiosk-connection.js', 'manifest.webmanifest', 'assets/icon-512.png',
  'js/agreement.js', 'js/signed.js', 'js/agreement-text.js', 'js/api.js', 'js/app.js', 'js/backend-code.js', 'js/checks.js', 'js/engine.js', 'js/face.js', 'js/files.js', 'js/i18n.js', 'js/keyboard.js',
  'js/match.js', 'js/nfc.js', 'js/plans.js', 'js/qr.js', 'js/settings.js', 'js/setup.js', 'js/signature.js', 'js/transitions.js',
  'vendor/face-api/face-api.js', 'vendor/qrcode/qrcode.js',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' skips the browser's HTTP cache, so a new build never saves an old file.
  event.waitUntil(caches.open(SHELL)
    .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== SHELL && key !== MODELS && key.startsWith('kiosk-')) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scope.pathname)) return;
  // The tablet check measures the real network (and the server's clock): never answer it from here.
  if (url.searchParams.has('check') || req.cache === 'no-store') return;

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

  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const key = req.mode === 'navigate' ? new URL('index.html', self.registration.scope).href : req;
    const saved = () => cache.match(key, { ignoreSearch: true });
    if (BUILD !== 'dev') {
      // A published build: the saved copy is this exact version.
      const hit = await saved();
      if (hit) return hit;
    }
    try {
      const res = await withTimeout(fetch(req), BUILD === 'dev' ? 6000 : 15000);
      if (res.ok && res.type === 'basic') cache.put(key, res.clone());
      return res;
    } catch (err) {
      const hit = await saved();
      if (hit) return hit;
      throw err;
    }
  })());
});
