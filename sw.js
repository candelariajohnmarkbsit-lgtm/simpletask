/* SimpleTask service worker: offline app shell + notifications */
const VERSION = 'simpletask-v4';
const CORE_CACHE = VERSION + '-core';
const RUNTIME_CACHE = VERSION + '-runtime';

const CORE_ASSETS = [
  './',
  'index.html',
  'dashboard.html',
  'reset.html',
  'style.css',
  'script.js',
  'dashboard.js',
  'reset.js',
  'supabase-config.js',
  'supabase-client.js',
  'pwa.js',
  'reminder-schedule.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'icons/plmun-logo.png'
];

// Third-party files the pages need to run offline
const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/fullcalendar@6.1.10/index.global.min.js',
  'https://cdn.jsdelivr.net/npm/@emailjs/browser@3/dist/email.min.js',
  'https://cdn.tailwindcss.com/3.4.17'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const core = await caches.open(CORE_CACHE);
    await core.addAll(CORE_ASSETS);
    const runtime = await caches.open(RUNTIME_CACHE);
    await Promise.all(CDN_ASSETS.map(async (url) => {
      try { await runtime.add(new Request(url, { mode: 'no-cors' })); } catch (e) { /* cached later at runtime */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never cache live data or auth calls
  if (url.hostname.endsWith('supabase.co') || url.hostname.endsWith('emailjs.com')) return;

  // Pages: network first, fall back to cache when offline
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CORE_CACHE);
        cache.put(req, fresh.clone());
        return fresh;
      } catch (e) {
        const cached = await caches.match(req, { ignoreSearch: true });
        return cached || (await caches.match('index.html')) || Response.error();
      }
    })());
    return;
  }

  // Own files: show cached copy right away, refresh in background
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(CORE_CACHE);
      const cached = await cache.match(req);
      const refresh = fetch(req).then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
      return cached || (await refresh) || Response.error();
    })());
    return;
  }

  // CDN scripts and fonts: cache first
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req);
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(req, res.clone());
      return res;
    } catch (e) {
      return Response.error();
    }
  })());
});

// Open the app when a reminder is tapped
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || 'dashboard.html';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes('dashboard.html') && 'focus' in c) return c.focus();
    }
    return self.clients.openWindow(target);
  })());
});

// Ready for server push (needs a push server and VAPID keys to send)
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'SimpleTask reminder', {
    body: data.body || 'You have a task due soon.',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    data: { url: data.url || 'dashboard.html' }
  }));
});
