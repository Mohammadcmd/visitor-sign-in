/* An earlier version of this project served a second kiosk from the repository root,
 * with this offline worker. The kiosk now lives in web/ only. This version removes
 * itself and its cache, so browsers that installed it go straight to the kiosk. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('vsi-')) await caches.delete(key);
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url);
  })());
});
