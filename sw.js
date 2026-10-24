/**
 * Radar PWA Service Worker
 * Versioned cache with Network-First app shell to guarantee immediate updates on deploy.
 * Note: iOS Safari (iOS 16.4+) requires the PWA to be installed (Added to Home Screen) to receive Web Notifications.
 */

const CACHE_VERSION = 'radar-shell-v20261023-sky9';
const TILE_CACHE_NAME = 'radar-tiles-v1';

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
          if (key !== CACHE_VERSION && key !== TILE_CACHE_NAME) {
            console.log('[SW] Pruning old cache version:', key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  // Take control of uncontrolled clients immediately
  self.clients.claim();
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

  // C. Map & Radar Tiles (RainViewer, OpenStreetMap):
  // Stale-While-Revalidate in dedicated tile cache for fast response & offline map view.
  if (url.origin.includes('rainviewer.com') || url.origin.includes('openstreetmap.org')) {
    event.respondWith(
      caches.open(TILE_CACHE_NAME).then((cache) => {
        return cache.match(request).then((cachedResponse) => {
          const fetchPromise = fetch(request)
            .then((networkResponse) => {
              if (networkResponse && networkResponse.status === 200) {
                cache.put(request, networkResponse.clone());
              }
              return networkResponse;
            })
            .catch(() => cachedResponse);

          return cachedResponse || fetchPromise;
        });
      })
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
