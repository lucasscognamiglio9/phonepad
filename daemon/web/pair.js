// phonepad — vista de pairing (pantalla de la compu). Vanilla JS, read-only.
//
// Contrato consumido (SPEC §12):
//   GET /qr.svg            → <img>          (PNG fallback vía onerror en el HTML)
//   GET /api/pair-info     → {url,ip,port,paired} (URL sin token; solo loopback)
//   GET /events  (SSE)     → eventos con nombre + payload JSON:
//        event: state               data: {connected:bool, client:Client|null}  (snapshot al suscribir)
//        event: client_connected    data: {connected:true,  client:Client}
//        event: client_disconnected data: {connected:false, client:null}
//   Client = { ua: string, since: string /* RFC3339 */ }
//
// La vista NO envía nada: solo recibe. El EventSource reconecta solo (no escribimos
// reconexión manual); si se cae, mostramos un estado neutro "sin conexión al daemon".

(() => {
  "use strict";

  const root = document.querySelector(".pair");
  const chipLabel = document.getElementById("chip-label");
  const instruction = document.getElementById("instruction");
  const urlEl = document.getElementById("url");
  const deviceEl = document.getElementById("device");

  // ---- Estado de la vista (fuente única de verdad) ----
  // state ∈ waiting | connected | disconnected | error | neutral
  function render(state, opts = {}) {
    root.dataset.state = state;
    switch (state) {
      case "waiting":
        chipLabel.textContent = "esperando al celular…";
        instruction.textContent = "Escaneá con la cámara del celular";
        deviceEl.textContent = "";
        break;
      case "connected":
        chipLabel.textContent = "📱 celular conectado";
        deviceEl.textContent = opts.device || "";
        break;
      case "disconnected":
        chipLabel.textContent = "celular desconectado — reconectando…";
        deviceEl.textContent = "";
        break;
      case "neutral":
        chipLabel.textContent = "sin conexión al daemon…";
        deviceEl.textContent = "";
        break;
      case "error":
        chipLabel.textContent = opts.message || "error";
        deviceEl.textContent = "";
        break;
    }
  }

  // Estado inicial: aún no sabemos nada hasta el snapshot del SSE.
  chipLabel.textContent = "conectando con el daemon…";

  // ---- Texto legible del URL (GET /api/pair-info) ----
  // No bloquea nada; el QR ya lleva el token. Esto es solo ayuda visual.
  fetch("/api/pair-info", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((info) => {
      if (!info) return;
      // Preferimos mostrar host:puerto (sin token) para no exponerlo en pantalla
      // grande; el token vive dentro del QR. Si solo viene url, mostramos su origen.
      if (info.ip && info.port) {
        const scheme = location.protocol === "https:" ? "https" : "http";
        urlEl.textContent = `${scheme}://${info.ip}:${info.port}`;
      } else if (info.url) {
        try {
          urlEl.textContent = new URL(info.url).origin;
        } catch {
          urlEl.textContent = info.url;
        }
      }
    })
    .catch(() => {
      /* opcional: si falla, simplemente no mostramos URL legible */
    });

  // ---- UA → etiqueta corta legible ("Android · Chrome") ----
  function prettyUA(ua) {
    if (!ua) return "";
    let os = "";
    if (/Android/i.test(ua)) os = "Android";
    else if (/iPhone|iPad|iPod/i.test(ua)) os = "iOS";
    else if (/Linux/i.test(ua)) os = "Linux";
    else if (/Windows/i.test(ua)) os = "Windows";
    else if (/Mac OS X/i.test(ua)) os = "macOS";

    let browser = "";
    if (/Edg\//i.test(ua)) browser = "Edge";
    else if (/SamsungBrowser/i.test(ua)) browser = "Samsung Internet";
    else if (/Firefox/i.test(ua)) browser = "Firefox";
    else if (/Chrome|CriOS/i.test(ua)) browser = "Chrome";
    else if (/Safari/i.test(ua)) browser = "Safari";

    return [os, browser].filter(Boolean).join(" · ");
  }

  // ---- SSE: estado de conexión en vivo ----
  function applyState(payload) {
    if (payload && payload.connected) {
      render("connected", {
        device: prettyUA(payload.client && payload.client.ua),
      });
    } else {
      render("waiting");
    }
  }

  function parse(ev) {
    try {
      return JSON.parse(ev.data);
    } catch {
      return null;
    }
  }

  const es = new EventSource("/events");

  // Snapshot inicial al suscribirse (resuelve el caso "la vista abre después
  // de que el celular ya conectó").
  es.addEventListener("state", (ev) => {
    const p = parse(ev);
    if (p) applyState(p);
  });

  es.addEventListener("client_connected", (ev) => {
    const p = parse(ev);
    render("connected", {
      device: prettyUA(p && p.client && p.client.ua),
    });
  });

  es.addEventListener("client_disconnected", () => {
    // Estado intermedio: el celular se fue. Volvemos a "esperando" pero con
    // copy de reconexión; el próximo snapshot/connected re-sincroniza.
    render("disconnected");
  });

  // El EventSource reintenta solo. Mientras está caído, mostramos estado neutro.
  // OJO: onerror también dispara durante reconexiones transitorias; solo pintamos
  // "neutral" si la conexión está realmente CLOSED/CONNECTING (no OPEN).
  es.addEventListener("error", () => {
    if (es.readyState !== EventSource.OPEN) {
      render("neutral");
    }
  });
})();
