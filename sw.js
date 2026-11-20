// Uygulama kabuğunu önbelleğe alır; uygulama hızlı açılır.
// API çağrıları önbelleğe alınmaz.
const CACHE = 'ingilizce-v6';
const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/db.js',
  './js/topics.js',
  './js/openai.js',
  './js/lesson.js',
  './js/teacher.js',
  './js/analysis.js',
  './js/realtime.js',
  './js/summary.js',
  './js/progress.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Önce ağ, olmazsa önbellek: güncellemeler hemen görünür
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // HTTP önbelleğini atla: her açılışta sunucuya güncel sürümü sor
  e.respondWith(
    fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then((res) => {
        if (!res.ok) throw new Error('status ' + res.status);
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
