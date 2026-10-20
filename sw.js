/* Huellitas: permite instalar la app y abrirla aunque la señal esté mala.
   Siempre intenta traer la versión más nueva desde internet; si no hay conexión, usa la última guardada.
   Los datos y archivos (Supabase) nunca se guardan aquí. */
var CACHE = 'huellitas-v2';
var BASE = ['./', './index.html', './huellitas.js', './manifest.webmanifest', './icons/icon-192.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(BASE); }).catch(function () {}));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(fetch(e.request).then(function (res) {
    if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copy); }); }
    return res;
  }).catch(function () {
    return caches.match(e.request).then(function (hit) { return hit || caches.match('./index.html'); });
  }));
});
