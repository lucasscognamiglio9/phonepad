// Service worker mínimo: cachea el shell estático para arranque instantáneo y
// resiliente a parpadeos de red. NO intercepta el WS de control, el SSE de
// pairing, la API ni el QR — esos siempre van a la red.
"use strict";

// OJO: bumpear esta versión en CADA cambio del shell (index.html/app.js/
// style.css). El fetch es cache-first sin revalidación, así que un cambio de
// shell NO llega a las PWA ya instaladas hasta que cambia el nombre del cache:
// el SW nuevo reinstala (recachea el shell) y activate borra el cache viejo.
const CACHE = "phonepad-v2";
const SHELL = ["/", "/index.html", "/app.js", "/style.css", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Dinámico/tiempo real: nunca cachear ni servir de cache.
  if (
    e.request.method !== "GET" ||
    url.pathname.startsWith("/ws") ||
    url.pathname.startsWith("/events") ||
    url.pathname.startsWith("/api") ||
    url.pathname === "/qr.svg"
  ) {
    return; // dejar pasar a la red (comportamiento por defecto)
  }
  // Cache-first para el shell: abre al instante; red como fallback y para poblar
  // assets nuevos (p.ej. fonts) la primera vez.
  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) return hit;
      return fetch(e.request).then((res) => {
        if (res.ok && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match("/index.html"));
    })
  );
});
