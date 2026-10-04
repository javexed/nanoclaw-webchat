// Cache name is derived at serve time: the webchat server replaces this
// placeholder with a hash of the served assets (see computeSwCacheVersion in
// server.ts), so the cache busts exactly when an asset changes — no
// hand-bumped version constant to conflict across branches. The literal
// fallback only survives if sw.js is served without that substitution.
const CACHE = '__CACHE_VERSION__';
const ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/marked.min.js',
  '/dompurify.min.js',
  '/vue.runtime.min.js',
  '/logo-dark.svg',
  '/logo-light.svg',
];
const VENDORED = new Set(['/marked.min.js', '/dompurify.min.js', '/vue.runtime.min.js', '/logo-dark.svg', '/logo-light.svg']);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

// IndexedDB-backed unread counter shared between the SW and the page.
function badgeDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('nanoclaw-badge', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('state');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function badgeIncrement() {
  const db = await badgeDB();
  return new Promise((resolve) => {
    const tx = db.transaction('state', 'readwrite');
    const store = tx.objectStore('state');
    const getReq = store.get('count');
    getReq.onsuccess = () => {
      const next = (getReq.result || 0) + 1;
      store.put(next, 'count');
      tx.oncomplete = () => resolve(next);
    };
  });
}

async function applyBadge(n) {
  if ('setAppBadge' in self.navigator) {
    try {
      await self.navigator.setAppBadge(n);
    } catch {}
  }
}

self.addEventListener('push', (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    /* best-effort */
  }
  const title = data.title || 'NanoClaw';
  const body = data.body || 'New message';
  const tag = data.tag || 'nanoclaw-msg';
  const roomId = data.roomId || '';
  e.waitUntil(
    (async () => {
      // Only bump the badge if no visible PWA window exists — otherwise the
      // user is already looking at the app and the unread count should stay 0.
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const hasVisible = clients.some((c) => c.visibilityState === 'visible');
      if (!hasVisible) {
        const n = await badgeIncrement();
        await applyBadge(n);
      }
      await self.registration.showNotification(title, {
        body,
        tag,
        data: { roomId },
        badge: '/logo-light.svg',
        icon: '/logo-dark.svg',
      });
    })(),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const roomId = (e.notification.data && e.notification.data.roomId) || '';
  const targetUrl = roomId ? `/?room=${encodeURIComponent(roomId)}` : '/';
  e.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) {
        if (c.url.includes(self.registration.scope.replace(/\/$/, ''))) {
          await c.focus();
          if (roomId) c.postMessage({ type: 'open-room', roomId });
          return;
        }
      }
      await self.clients.openWindow(targetUrl);
    })(),
  );
});

/** How long a page load waits for the server before the cached shell is served instead. */
const NAV_TIMEOUT_MS = 3000;

/**
 * A page load asks the server first, because only the server (or the sign-in
 * front door before it — App Service EasyAuth, an identity-aware proxy) can
 * say the session has ended. Served from cache, an expired session never
 * reached the login page: a normal refresh showed the cached app, stuck
 * reconnecting, and only a hard refresh (which skips this worker) got out.
 *
 * - A redirect, 401 or 403 goes to the browser as it came: the sign-in.
 * - Any other answer: the CACHED shell, when there is one, so the page always
 *   matches the cached scripts (a fresh index.html beside an older app.js
 *   could disagree until the next worker activates).
 * - No answer within NAV_TIMEOUT_MS, or none at all: the cached shell.
 */
async function navigate(request, cacheKey) {
  let res;
  try {
    res = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), NAV_TIMEOUT_MS)),
    ]);
  } catch {
    return (await caches.match(cacheKey || '/')) || offlineResponse();
  }
  if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403) return res;
  return (cacheKey && (await caches.match(cacheKey))) || res;
}

/** A real Response for a request we could not fetch and have not cached. */
function offlineResponse() {
  return new Response('', { status: 503, statusText: 'Offline' });
}

self.addEventListener('fetch', (e) => {
  if (e.request.url.includes('/api/') || e.request.url.includes('/ws')) return;

  const url = new URL(e.request.url);
  // The sign-in front door's own endpoints (EasyAuth's /.auth/login, /.auth/refresh, …): never ours to answer.
  if (url.pathname.startsWith('/.auth/')) return;

  if (e.request.mode === 'navigate') {
    e.respondWith(navigate(e.request, ASSETS.includes(url.pathname) ? url.pathname : null));
    return;
  }

  // Vendored libs: cache-first (they never change)
  if (VENDORED.has(url.pathname)) {
    e.respondWith(caches.match(e.request).then((cached) => cached || fetch(e.request)));
    return;
  }

  // App files: cache-first. The CACHE name is a content hash of every asset
  // (computeSwCacheVersion in server.ts), so a cached asset is immutable within
  // a version — any change ships a new sw.js with a new CACHE name, and the
  // install/activate cycle re-caches + evicts. That means serving from cache is
  // always fresh AND skips a network round-trip on every load (the old
  // network-first path re-downloaded the whole growing bundle each time, even
  // when nothing changed). On a cache miss we fetch and populate.
  //
  // Only KNOWN shell paths are cached, keyed by pathname — so query-string
  // deep-links (e.g. /?room=X from a notification) reuse the single '/' entry
  // instead of each accumulating a redundant shell copy. Anything else
  // (dynamic/unknown non-/api/ responses) is fetched but never cached, so the
  // app cache can't grow unboundedly.
  const cacheKey = ASSETS.includes(url.pathname) ? url.pathname : null;
  e.respondWith(
    caches.match(cacheKey || e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request)
        .then((res) => {
          if (cacheKey && res.ok && res.type !== 'opaque') {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(cacheKey, clone));
          }
          return res;
        })
        .catch(() => {
          // A rejected fetch here rejects respondWith itself, which the browser
          // reports as BOTH "FetchEvent resulted in a network error response"
          // and an uncaught TypeError from inside the worker — noisy, and it
          // fails the request harder than it needs to. Seen for real behind an
          // auth proxy: an expired session turned /manifest.json into a
          // cross-origin login redirect, which the page CSP then blocked.
          //
          // Degrade instead. Any cached copy beats a hard failure, and
          // everything else gets a real Response so the caller sees a status
          // rather than an exception. (Page loads are navigate(), above.)
          return caches.match(e.request).then((stale) => stale || offlineResponse());
        });
    }),
  );
});
