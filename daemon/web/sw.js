// Service worker mínimo: cachea el shell estático para arranque instantáneo y
// resiliente a parpadeos de red. NO intercepta el WS de control, el SSE de
// pairing, la API ni el QR — esos siempre van a la red.
"use strict";

// OJO: bumpear esta versión en CADA cambio del shell (index.html/app.js/
// style.css). El fetch es cache-first sin revalidación, así que un cambio de
// shell NO llega a las PWA ya instaladas hasta que cambia el nombre del cache:
// el SW nuevo reinstala (recachea el shell) y activate borra el cache viejo.
const CACHE = "phonepad-v24";
const SHELL = ["/phonepad-core.js?v=24", "/receiver-controls.js?v=24", "/", "/index.html", "/app.js?v=24", "/preview.js?v=24", "/rtc.js?v=24", "/style.css?v=24", "/manifest.webmanifest"];

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

self.addEventListener("message", (e) => {
  if (e.data?.type === "PHONEPAD_VERSION") e.source?.postMessage({type:"PHONEPAD_VERSION", build:"24"});
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Dinámico/tiempo real: nunca cachear ni servir de cache.
  if (
    e.request.method !== "GET" ||
    url.pathname.startsWith("/ws") ||
    url.pathname.startsWith("/events") ||
    url.pathname.startsWith("/api") ||
    url.pathname === "/qr.svg" || url.pathname === "/share" || url.pathname.startsWith("/pair")
  ) {
    return; // dejar pasar a la red (comportamiento por defecto)
  }
  // Navigation checks the current HTML. Versioned assets keep each release coherent.
  if (e.request.mode === "navigate" && url.origin === location.origin) {
    e.respondWith((async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        const response = await fetch(e.request, {cache:"no-store", signal:controller.signal});
        if (!response.ok) throw Error("navigation unavailable");
        return response;
      } catch (error) {
        const cache = await caches.open(CACHE);
        const offline = await cache.match("/index.html");
        if (offline) return offline;
        throw error;
      } finally { clearTimeout(timeout); }
    })());
    return;
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
