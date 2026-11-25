/* Wild Eagles Scout - service worker (offline app shell).
   - Install: save every app file so the app opens with no internet.
   - Pages: try the network for a short time (so updates arrive), otherwise
     open the saved copy. Never shows the browser's "no connection" page.
   - Files: saved copy first, refreshed in the background.
   - Data (the Google Sheet) is not handled here: app.js keeps the last synced
     data on the phone and shows it when offline. */
const VERSION = 'wes-v5';
const SHELL = ['./', './index.html', './styles.css', './app.js', './outbox.js', './config.js',
  './manifest.webmanifest', './icon-192.png', './icon-512.png', './crest.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) =>
      // one by one, so a single missing file can never stop the install
      Promise.all(SHELL.map((u) => fetch(u, { cache: 'reload' }).then((r) => { if (r.ok) return c.put(u, r); }).catch(() => {})))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function networkWithTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(req).then((r) => { clearTimeout(t); resolve(r); }, (err) => { clearTimeout(t); reject(err); });
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return; // API calls: always network

  if (req.mode === 'navigate') {
    e.respondWith(
      networkWithTimeout(req, 4000).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put('./index.html', copy)); }
        return res;
      }).catch(() =>
        caches.match('./index.html').then((r) => r || caches.match('./')).then((r) => r || Response.error())
      )
    );
    return;
  }

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      const refresh = fetch(req).then((res) => {
        if (res && res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => cached);
      return cached || refresh;
    })
  );
});
