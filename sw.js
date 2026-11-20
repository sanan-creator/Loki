self.addEventListener('notificationclick', event => {
  event.notification.close();

  const requestedTarget =
    (event.notification.data && event.notification.data.url) || './';

  event.waitUntil((async () => {
    const targetUrl = new URL(requestedTarget, self.location.href);

    // Notifications must never navigate the user to an external origin.
    if (targetUrl.origin !== self.location.origin) {
      targetUrl.href = self.registration.scope;
    }

    const windows = await clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });

    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;

      if ('navigate' in client) {
        try {
          await client.navigate(targetUrl.href);
        } catch (error) {
          console.warn('Loki could not navigate the existing window:', error);
        }
      }

      if ('focus' in client) {
        try {
          return await client.focus();
        } catch (error) {
          console.warn('Loki could not focus the existing window:', error);
        }
      }
    }

    if (clients.openWindow) {
      return clients.openWindow(targetUrl.href);
    }
  })());
});

// Firebase is optional for the core Service Worker. If its CDN is temporarily
// unavailable, the PWA shell and local notification features can still work.
try {
  importScripts('https://www.gstatic.com/firebasejs/13.0.0/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/13.0.0/firebase-messaging-compat.js');

  if (self.firebase && typeof firebase.messaging === 'function') {
    if (!firebase.apps.length) {
      firebase.initializeApp({
        apiKey: 'AIzaSyBXfTGg2JB6hLCy78WEC0aNOAuXMqg7CV4',
        authDomain: 'loki-2d9d9.firebaseapp.com',
        projectId: 'loki-2d9d9',
        storageBucket: 'loki-2d9d9.firebasestorage.app',
        messagingSenderId: '890801691330',
        appId: '1:890801691330:web:56ecdcbf0138cd851bb95b',
        measurementId: 'G-GGTVKG9CNP'
      });
    }

    const lokiMessaging = firebase.messaging();

    lokiMessaging.onBackgroundMessage(payload => {
      // FCM automatically displays notification payloads.
      // Display only data-only messages here to avoid duplicate notifications.
      if (payload && payload.notification) return;

      const title = (payload && payload.data && payload.data.title) || 'Loki';
      const body =
        (payload && payload.data && payload.data.body) ||
        'You have a new notification.';

      self.registration.showNotification(title, {
        body,
        icon: './icon-192.png',
        badge: './icon-192.png',
        data: { url: './' }
      });
    });
  }
} catch (error) {
  console.error(
    'Loki Firebase messaging is unavailable in this Service Worker:',
    error
  );
}

const CACHE_NAME = 'loki-pwa-v15-stability-audit';

// Core app files are required. Icons are cached when present, but a missing
// optional icon must not prevent the Service Worker from installing.
const CORE_ASSETS = [
  './',
  './index.html',
  './styles.css?v=11',
  './app.js?v=15',
  './manifest.webmanifest'
];

const OPTIONAL_ASSETS = [
  './icon-192.png?v=11',
  './icon-512.png?v=11',
  './icon-maskable-512.png?v=11',
  './apple-touch-icon.png?v=11',
  './favicon-64.png?v=11',
  './icon.svg'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(CORE_ASSETS);

    await Promise.allSettled(
      OPTIONAL_ASSETS.map(asset => cache.add(asset))
    );

    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys
        .filter(key => key.startsWith('loki-pwa-') && key !== CACHE_NAME)
        .map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached =>
      cached || fetch(event.request).then(response => {
        if (
          response &&
          response.ok &&
          new URL(event.request.url).origin === self.location.origin
        ) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }

        return response;
      })
    )
  );
});
