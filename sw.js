/**
 * Radar PWA Service Worker
 * Versioned cache with Network-First app shell to guarantee immediate updates on deploy.
 * Note: iOS Safari (iOS 16.4+) requires the PWA to be installed (Added to Home Screen) to receive Web Notifications.
 */

const CACHE_VERSION = 'radar-shell-v20261029-pollen2';
const TILE_CACHE_NAME = 'radar-tiles-v1';
const WIKI_CACHE_NAME = 'sky-wiki-v1';
// sky22: one persistent on-phone cache for map/satellite/model tiles, oldest out first.
// Per-entry time/size/class live in IndexedDB (opaque tile responses can't carry headers).
// sky24: cap 180 MB (was 25), radar/satellite frames (keyed by their frame time/id) evicted after 3 h, basemap
// kept 30 days; "current"/"latest" radar tiles are network-first (2 min) so they can never show an old scan.
const DATA_CACHE = 'heaven-data-v1';
const CAP_BYTES = 180 * 1024 * 1024;
const TTL = { base: 30 * 86400e3, frame: 3 * 3600e3, model: 12 * 3600e3, meta: 6 * 3600e3, live: 2 * 60e3 }; // Star View detail sheet: Wikipedia articles (offline reopen)

// All paths are resolved against the SW scope, so the app works under a sub-path
// (https://marlybiz.github.io/radar/) and on a custom domain root alike.
const SCOPE_URL = self.registration ? self.registration.scope : self.location.href.replace(/sw\.js.*$/, '');
const scoped = (p) => new URL(p, SCOPE_URL).href;

const STATIC_PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './favicon.ico',
  './apple-touch-icon.png',
  './pwa-192x192.png',
  './pwa-512x512.png',
  './pwa-maskable-512x512.png',
  './icon.svg',
  './maplibre-gl-worker.js',
  './assets/sky/day-clear.jpg',
  './assets/sky/day-mostly-clear.jpg',
  './assets/sky/day-partly-cloudy.jpg',
  './assets/sky/day-mostly-cloudy.jpg',
  './assets/sky/day-overcast.jpg',
  './assets/sky/day-fog.jpg',
  './assets/sky/day-drizzle.jpg',
  './assets/sky/day-rain.jpg',
  './assets/sky/day-heavy-rain.jpg',
  './assets/sky/day-sleet.jpg',
  './assets/sky/day-storm.jpg',
  './assets/sky/day-snow-light.jpg',
  './assets/sky/day-snow.jpg',
  './assets/sky/day-snow-heavy.jpg',
  './assets/sky/day-mixed.jpg',
  './assets/sky/night-clear.jpg',
  './assets/sky/night-mostly-clear.jpg',
  './assets/sky/night-partly-cloudy.jpg',
  './assets/sky/night-cloudy.jpg',
  './assets/sky/night-fog.jpg',
  './assets/sky/night-drizzle.jpg',
  './assets/sky/night-rain.jpg',
  './assets/sky/night-heavy-rain.jpg',
  './assets/sky/night-sleet.jpg',
  './assets/sky/night-storm.jpg',
  './assets/sky/night-snow-light.jpg',
  './assets/sky/night-snow.jpg',
  './assets/sky/night-snow-heavy.jpg',
  './assets/sky/night-mixed.jpg',
  './assets/sky/sunrise.jpg',
  './assets/sky/sunset.jpg',
  './assets/sky/moon.png',
];

// 1. Install: Precache shell assets and skip waiting immediately
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      return cache.addAll(STATIC_PRECACHE.map(scoped)).catch((err) => {
        console.warn('[SW] Precache fallback:', err);
      });
    })
  );
  // Force the waiting service worker to become active immediately
  self.skipWaiting();
});

// 2. Activate: Delete old cache versions and claim all clients immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_VERSION && key !== WIKI_CACHE_NAME && key !== DATA_CACHE) { // radar-tiles-v1 (unbounded) retired
            console.log('[SW] Pruning old cache version:', key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  // Take control of uncontrolled clients immediately
  self.clients.claim();
  event.waitUntil(prune().then(warmBaseTiles).catch(() => {}));
});

// 3. Message Handling: Explicit skipWaiting & notification triggers
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
    const { title, options } = event.data;
    self.registration.showNotification(title, {
      icon: scoped('./pwa-192x192.png'),
      badge: scoped('./pwa-192x192.png'),
      ...options,
    });
  }
});

// 3b. Web Push: daily summaries from push.marlylabs.app (arrive even when the app is closed)
self.addEventListener('push', (event) => {
  let msg = {};
  try { msg = event.data ? event.data.json() : {}; } catch { msg = { body: event.data ? event.data.text() : '' }; }
  // type 'live': silent hourly update that quietly replaces the previous one (own tag, so the
  // audible morning/second notifications, tagged daily-morning / daily-second, never replace it)
  const live = msg.type === 'live';
  event.waitUntil(self.registration.showNotification(msg.title || 'Heaven on Earth', {
    body: msg.body || '',
    tag: live ? 'heaven-live' : (msg.tag && msg.tag !== 'heaven-live' ? msg.tag : 'daily'),
    renotify: false,
    silent: live,
    data: msg.data || {},
    icon: scoped('./pwa-192x192.png'),
    badge: scoped('./pwa-192x192.png'),
  }));
});

// 4. Notification Click: Opens/focuses the app and navigates to the alert location
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const lat = data.lat;
  const lon = data.lon;
  const name = data.name;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If a window is already open, focus it and tell it to navigate
      for (const client of clientList) {
        if ('focus' in client) {
          return client.focus().then(() => {
            if (lat !== undefined && lon !== undefined) {
              client.postMessage({
                type: 'NAVIGATE_TO_PLACE',
                lat,
                lon,
                name,
              });
            }
          });
        }
      }

      // If no window is open, open a new one with location parameters in URL
      if (self.clients.openWindow) {
        const targetUrl = lat !== undefined && lon !== undefined
          ? scoped(`./?lat=${lat}&lon=${lon}`)
          : scoped('./');
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

// 5. Periodic Background Sync (best effort on Android Chrome)
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'weather-alerts-check') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window' }).then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: 'TRIGGER_ALERTS_CHECK' });
        });
      })
    );
  }
});

// 6. Fetch Strategy
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Only intercept GET requests
  if (request.method !== 'GET') {
    return;
  }

  // A. Navigation / Document requests (HTML):
  // ALWAYS Network-First with cache fallback.
  // This guarantees new index.html deploys are never stuck on stale SW cache.
  if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseCopy = networkResponse.clone();
            caches.open(CACHE_VERSION).then((cache) => {
              cache.put(request, responseCopy);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          // If offline, return cached index.html
          return caches.match(request).then((cached) => {
            if (cached) return cached;
            return caches.match(scoped('./index.html')).then((c) => c || caches.match(scoped('./')));
          });
        })
    );
    return;
  }

  // B. Same-origin app assets (bundled JS, CSS, manifest, icons):
  // Network-First with cache fallback so new JS/CSS bundles are immediately served.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseCopy = networkResponse.clone();
            caches.open(CACHE_VERSION).then((cache) => {
              cache.put(request, responseCopy);
            });
          }
          return networkResponse;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // C. sky22: map / globe / satellite / model data saved on the phone (see classify)
  const cls = classify(url);
  if (cls) {
    event.respondWith(cached(request, url, cls));
    return;
  }

  // C2. Wikipedia (Star View detail sheet): stale-while-revalidate so reopened articles work offline
  if (url.hostname === 'en.wikipedia.org') {
    event.respondWith(
      caches.open(WIKI_CACHE_NAME).then((cache) =>
        cache.match(request).then((cached) => {
          const net = fetch(request)
            .then((res) => { if (res && res.status === 200) cache.put(request, res.clone()); return res; })
            .catch(() => cached || Response.error());
          return cached || net;
        })
      )
    );
    return;
  }

  // D. Live Weather & Alerts APIs (Open-Meteo, NWS):
  // Network-first with offline fallback only; never long-cache forecast JSON
  if (url.origin.includes('open-meteo.com') || url.origin.includes('weather.gov')) {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          // Serve fresh from network without storing in long cache
          return networkResponse;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // E. Generic fallback
  event.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});

// ---------- sky22: persistent tile + data cache ----------
// base: basemap + label tiles + Black Marble (static)      -> stale-while-revalidate, kept 30 days
// frame: time-stamped radar / satellite frames (immutable)  -> cache-first, kept 3 h
// model: GFS images keyed by run (immutable)               -> cache-first, kept 12 h
// meta: GFS meta.json (query ignored)                      -> saved copy first, refreshed in the background
function classify(u) {
  const h = u.hostname, p = u.pathname;
  if (h.endsWith('tile.openstreetmap.org') || (h === 'server.arcgisonline.com' && p.includes('/tile/'))) return 'base';
  if (h === 'gibs.earthdata.nasa.gov' && p.includes('VIIRS_Black_Marble')) return 'base';
  if (h === 'marlybiz.github.io' && p.startsWith('/heaven-gfs/')) return p.endsWith('meta.json') ? 'meta' : 'model';
  if (h.endsWith('rainviewer.com') && p.includes('/v2/radar/')) return 'frame';
  if (h === 'push.marlylabs.app' && p.startsWith('/radar/')) return /\/(current|latest)\.png$/.test(p) ? 'live' : /\/\d{12}\.png$|\/[0-9a-f]{6,24}\.png$/.test(p) ? 'frame' : null;
  // sky24: direct radar fallbacks that carry an explicit scan time
  if (h === 'opengeo.ncep.noaa.gov' && /request=GetMap/i.test(u.search) && /[?&]TIME=/i.test(u.search)) return 'frame';
  if (h === 'geo.weather.gc.ca' && /request=GetMap/i.test(u.search) && /[?&]TIME=/i.test(u.search)) return 'frame';
  if (h === 'mesonet.agron.iastate.edu' && /USCOMP-N0Q-\d{12}\//.test(p)) return 'frame';
  if (h === 'gibs.earthdata.nasa.gov' && /\/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\//.test(p)) return 'frame';
  if ((h === 'nowcoast.noaa.gov' || h === 'view.eumetsat.int') && /request=GetMap/i.test(u.search) && /time=/i.test(u.search)) return 'frame';
  return null;
}
// sky24: the Worker's per-session ?s= counter param is not part of the key, so a frame tile is saved once for every session
const keyOf = (u, cls) => {
  if (cls === 'meta') return u.origin + u.pathname;
  if (u.hostname === 'push.marlylabs.app') { const c = new URL(u.href); c.searchParams.delete('s'); return c.href; }
  return u.href;
};
let dbP = null;
function db() {
  if (!dbP) dbP = new Promise((res, rej) => { const r = indexedDB.open('heaven-sw', 1); r.onupgradeneeded = () => r.result.createObjectStore('meta'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return dbP;
}
const idb = (mode, fn) => db().then((d) => new Promise((res, rej) => { const tx = d.transaction('meta', mode); const st = tx.objectStore('meta'); const out = fn(st); tx.oncomplete = () => res(out && out.result !== undefined ? out.result : out); tx.onerror = () => rej(tx.error); }));
let puts = 0;
let lastPrune = 0;
async function save(cache, key, res, cls) {
  const len = +(res.headers.get('content-length') || 0);
  let size = res.type === 'opaque' ? 30000 : len;
  if (!size) { try { size = (await res.clone().blob()).size || 30000; } catch { size = 30000; } }
  await cache.put(key, res);
  await idb('readwrite', (st) => st.put({ t: Date.now(), s: size, c: cls }, key)).catch(() => {});
  // prune at most once a minute (the metadata scan grows with the 180 MB cap)
  if (++puts % 100 === 0 && Date.now() - lastPrune > 60e3) { lastPrune = Date.now(); prune().catch(() => {}); }
}
async function cached(request, url, cls) {
  const cache = await caches.open(DATA_CACHE);
  const key = keyOf(url, cls);
  let hit = await cache.match(key);
  if (hit && hit.type === 'opaque' && request.mode === 'cors') hit = undefined; // an <img> copy can't serve a CORS fetch
  const meta = hit ? await idb('readonly', (st) => st.get(key)).catch(() => null) : null;
  const fresh = hit && meta && Date.now() - meta.t < TTL[cls];
  const net = () => fetch(request).then((res) => {
    if (res && (res.status === 200 || res.type === 'opaque')) save(cache, key, res.clone(), cls).catch(() => {});
    return res;
  });
  if (cls === 'frame' || cls === 'model' || (cls === 'live' && fresh)) {
    if (fresh) return hit;
    return net().catch(() => hit || Response.error());
  }
  if (cls === 'live') return net().catch(() => hit || Response.error()); // newest scan: network first, saved copy offline
  // base + meta: saved copy first, refresh in the background (always for meta, after a day for base)
  if (hit) {
    if (cls === 'meta' || !meta || Date.now() - meta.t > 86400e3) net().catch(() => {});
    return hit;
  }
  return net();
}
async function prune() {
  const cache = await caches.open(DATA_CACHE);
  const all = await idb('readonly', (st) => { const out = []; const r = st.openCursor(); r.onsuccess = () => { const c = r.result; if (c) { out.push([c.key, c.value]); c.continue(); } }; return { get result() { return out; } }; });
  const now = Date.now(); let total = 0; const keep = [];
  for (const [k, v] of all) {
    if (now - v.t > (TTL[v.c] || TTL.frame) * (v.c === 'model' || v.c === 'meta' ? 2 : v.c === 'live' ? 30 : 1)) { await cache.delete(k); await idb('readwrite', (st) => st.delete(k)); }
    else { keep.push([k, v]); total += v.s; }
  }
  if (total <= CAP_BYTES) return;
  keep.sort((a, b) => a[1].t - b[1].t);
  for (const [k, v] of keep) {
    if (total <= CAP_BYTES * 0.85) break;
    await cache.delete(k); await idb('readwrite', (st) => st.delete(k)); total -= v.s;
  }
}
// Whole-world basemap at zoom 0-2 (21 tiles, what one globe view loads anyway) saved once a month, so the map
// and globe paint instantly and offline. Kept small on purpose: OpenStreetMap's tile policy forbids bulk pre-seeding;
// deeper zooms are saved as you view them.
async function warmBaseTiles() {
  const cache = await caches.open(DATA_CACHE);
  for (let z = 0; z <= 2; z++) for (let x = 0; x < 1 << z; x++) for (let y = 0; y < 1 << z; y++) {
    const u = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
    if (await cache.match(u)) continue;
    try { const res = await fetch(u, { mode: 'cors', credentials: 'omit' }); if (!res.ok) continue; await save(cache, u, res, 'base'); } catch {}
  }
}
