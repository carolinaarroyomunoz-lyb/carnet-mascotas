/* Huellitas: permite instalar la app y abrirla aunque la señal esté mala.
   Siempre intenta traer la versión más nueva desde internet; si no hay conexión, usa la última guardada.
   Los datos y archivos (Supabase) nunca se guardan aquí. */
var CACHE = 'huellitas-v3';
var IMGS = 'huellitas-fotos'; /* fotos y archivos de Supabase, por enlace firmado (cambia cada 7 días) */
var BASE = ['./', './index.html', './huellitas.js', './manifest.webmanifest', './icons/icon-192.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(BASE); }).catch(function () {}));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE && k !== IMGS; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method === 'GET' && /\.supabase\.co$/.test(url.hostname) && url.pathname.indexOf('/storage/v1/object/sign/') === 0 && e.request.destination === 'image') {
    e.respondWith(caches.open(IMGS).then(function (c) {
      return c.match(e.request).then(function (hit) {
        if (hit) return hit;
        return fetch(e.request).then(function (res) {
          if (res && (res.ok || res.type === 'opaque')) {
            c.put(e.request, res.clone());
            c.keys().then(function (ks) { ks.slice(0, Math.max(0, ks.length - 150)).forEach(function (k) { c.delete(k); }); });
          }
          return res;
        });
      });
    }));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(fetch(e.request).then(function (res) {
    if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copy); }); }
    return res;
  }).catch(function () {
    return caches.match(e.request).then(function (hit) { return hit || caches.match('./index.html'); });
  }));
});

/* Avisos al celular: los manda la función "avisos" de Supabase. */
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'Huellitas', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Huellitas', {
    body: d.body || '', tag: d.tag || undefined, icon: 'icons/icon-192.png', data: { url: d.url || './' }
  }));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) if ('focus' in list[i]) return list[i].focus();
    return self.clients.openWindow(url);
  }));
});
