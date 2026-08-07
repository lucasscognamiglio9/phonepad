// phonepad — PWA cliente. Vanilla JS, sin build, sin deps.
// El cliente NO clasifica gestos: reenvía la foto de contactos crudos por frame
// (§3 mensaje `t`). El daemon emula un touchpad de precisión y libinput clasifica
// los gestos nativamente (ADR 0005). El feel lo hereda de la config de GNOME.
"use strict";

// ───────────────────────────── Transporte WS (§6) ──────────────────────────
const PING_INTERVAL = 2000; // ms
const PONG_TIMEOUT = 5000;  // ms sin pong → contar un miss
const PONG_MAX_MISSES = 2;  // tolerar 2 pings sin pong antes de declarar caída (jitter LAN/cel)
const AUTH_TIMEOUT = 5000;   // ms para el preflight 401; no bloquear el reconnect
const BACKOFFS = [250, 500, 1000, 3000]; // backoff de reconexión, máx 3s

const Net = (() => {
  let ws = null;
  let backoffIdx = 0;
  let pingTimer = null;
  let pongTimer = null;
  let missed = 0;
  let connected = false;     // socket abierto y handshake ok
  let manualClose = false;
  let reconnectTimer = null;
  let authRejected = false;  // 401 definitivo: no volver a martillar el daemon

  // Token persistente: con pairing persistente del daemon, el token estable se
  // guarda en el celular tras el PRIMER escaneo del QR. Así el ícono PWA (cuyo
  // start_url NO lleva token) reusa el guardado y conecta sin re-escanear.
  const STORAGE_KEY = "phonepad-token";
  function resolveToken() {
    const qs = new URLSearchParams(location.search).get("token");
    if (qs) {
      // Primer pairing (o re-pair vía QR nuevo): persistir y limpiar la URL,
      // para no dejar la credencial en el historial del navegador.
      try { localStorage.setItem(STORAGE_KEY, qs); } catch {}
      try {
        const u = new URL(location.href);
        u.searchParams.delete("token");
        history.replaceState(null, "", u.pathname + u.search + u.hash);
      } catch {}
      return qs;
    }
    // Aperturas siguientes (ícono PWA sin token en la URL): reusar el guardado.
    try { return localStorage.getItem(STORAGE_KEY) || ""; } catch { return ""; }
  }

  const token = resolveToken();
  // Esquema derivado del protocolo de la página: https → wss, http → ws.
  // Una página https no puede abrir ws:// plano (mixed-content); esto lo evita.
  const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  const wsURL = `${wsProto}//${location.host}/ws?token=${encodeURIComponent(token)}`;

  function rejectAuth() {
    authRejected = true;
    connected = false;
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    render("error", "token inválido — reescaneá el QR");
  }

  // Los browsers esconden el status HTTP (401) del handshake WebSocket y solo
  // disparan error/close. Este preflight permite distinguir credencial revocada
  // de una caída de red; un 401 es terminal hasta que el usuario reescanee, así
  // evitamos una reconexión infinita que además puede parecer un ataque.
  async function authPreflight() {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), AUTH_TIMEOUT) : null;
    try {
      const r = await fetch("/api/auth", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        credentials: "same-origin",
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (r.status === 401) {
        rejectAuth();
        return false;
      }
      // Daemon anterior a este endpoint: dejamos que el WS intente igual. Un
      // error distinto de 401 (proxy/red) no invalida el token.
      return true;
    } catch {
      return true;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Fuente única de verdad del estado de conexión: render(state, text?).
  // state ∈ {connecting, connected, reconnecting, error}.
  let collapseTimer = null;
  function render(state, text) {
    const el = document.getElementById("status");
    const txt = document.getElementById("status-text");
    if (!el) return;
    el.classList.remove(
      "status--connecting", "status--connected",
      "status--reconnecting", "status--error", "status--collapsed",
    );
    el.classList.add(`status--${state}`);
    if (txt && text != null) txt.textContent = text;

    // Conectado y estable: tras 2s colapsamos el texto (deja solo el punto).
    clearTimeout(collapseTimer);
    if (state === "connected") {
      collapseTimer = setTimeout(() => el.classList.add("status--collapsed"), 2000);
    }
  }

  async function connect() {
    // Sin token guardado (abriste la app sin haber escaneado nunca el QR):
    // mensaje accionable en vez de un bucle de 401/reconexión.
    if (!token) {
      render("error", "escaneá el QR para emparejar");
      return;
    }
    if (authRejected) return;
    if (!await authPreflight()) return;
    if (authRejected) return;
    manualClose = false;
    clearTimeout(reconnectTimer);
    render(connected ? "reconnecting" : "connecting", connected ? "reconectando…" : "conectando…");
    try {
      ws = new WebSocket(wsURL);
    } catch (e) {
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      backoffIdx = 0;
      connected = true;
      missed = 0;
      render("connected", "conectado");
      startKeepalive();
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === "pong") {
        // Pong recibido: limpiar timeout pendiente y resetear contador de misses.
        if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
        missed = 0;
      } else if (msg.t === "ok") {
        connected = true;
        render("connected", "conectado");
      } else if (msg.t === "err") {
        // Token inválido u otro error: el server cierra; mensaje accionable.
        rejectAuth();
      } else if (msg.t === "reload" && window.__PHONEPAD_DEV__) {
        // Hot-reload (solo dev): el daemon detectó un cambio en web/.
        location.reload();
      }
    };

    ws.onclose = () => {
      cleanupSocket();
      if (!manualClose) scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose se dispara después; dejamos que él agende la reconexión.
      try { ws.close(); } catch {}
    };
  }

  function startKeepalive() {
    stopKeepalive();
    missed = 0;
    pingTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      send({ t: "ping" });
      // Solo un timeout pendiente a la vez.
      if (pongTimer === null) {
        pongTimer = setTimeout(() => {
          pongTimer = null;
          missed++;
          // Tolerar PONG_MAX_MISSES pings sin pong: absorbe jitter de red sin
          // tumbar la sesión por un solo glitch.
          if (missed >= PONG_MAX_MISSES) {
            try { ws.close(); } catch {}
          }
        }, PONG_TIMEOUT);
      }
    }, PING_INTERVAL);
  }

  function stopKeepalive() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
  }

  function cleanupSocket() {
    stopKeepalive();
    ws = null;
  }

  function scheduleReconnect() {
    if (authRejected || !token) return;
    const delay = BACKOFFS[Math.min(backoffIdx, BACKOFFS.length - 1)];
    backoffIdx++;
    // Mostrar el intento da señal de vida cuando la LAN se cae un rato.
    render("reconnecting", `reconectando… (${backoffIdx})`);
    reconnectTimer = setTimeout(connect, delay);
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  function isConnected() {
    return !!ws && ws.readyState === WebSocket.OPEN;
  }

  return { connect, send, isConnected };
})();

// ─────────────────────── Pad: forwarder de contactos (§3, ADR 0005) ─────────
// El cliente NO clasifica. Captura Pointer Events sobre la superficie y reenvía
// la foto de contactos vivos por frame (coalescing con requestAnimationFrame):
// {"t":"t","c":[{id,x,y},…]} con coordenadas normalizadas 0..1. Un contacto que
// desaparece de la foto = dedo levantado; foto vacía = se levantaron todos. El
// daemon emula un touchpad de precisión y libinput clasifica los gestos.
const Pad = (() => {
  const pad = document.getElementById("pad");

  // Contactos vivos: pointerId -> {x, y} (última posición en px de pantalla).
  const pointers = new Map();
  let touchedOnce = false;
  let rafId = 0;

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  // Serializa la foto de contactos vivos a coordenadas normalizadas y la envía.
  function sendSnapshot() {
    const r = pad.getBoundingClientRect();
    const c = [];
    for (const [id, p] of pointers) {
      c.push({
        id,
        x: clamp01(r.width ? (p.x - r.left) / r.width : 0),
        y: clamp01(r.height ? (p.y - r.top) / r.height : 0),
      });
    }
    Net.send({ t: "t", c }); // c:[] cuando se levantó el último dedo
  }

  // Los moves (alta frecuencia) se coalescen en un frame; down/up (transiciones
  // de estado que no se pueden perder, p.ej. un tap rápido) se envían en el acto.
  function scheduleFrame() {
    if (!rafId) rafId = requestAnimationFrame(() => { rafId = 0; sendSnapshot(); });
  }
  function flushNow() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    sendSnapshot();
  }

  function onDown(ev) {
    pad.setPointerCapture?.(ev.pointerId);
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    pad.classList.add("pad--active");
    if (!touchedOnce) { touchedOnce = true; pad.classList.add("pad--touched"); }
    flushNow();
  }

  function onMove(ev) {
    const p = pointers.get(ev.pointerId);
    if (!p) return;
    // getCoalescedEvents da las muestras intermedias; nos quedamos con la última
    // (la foto es por frame, no por evento).
    const events = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
    const last = events[events.length - 1] || ev;
    p.x = last.clientX; p.y = last.clientY;
    scheduleFrame();
  }

  function onUp(ev) {
    if (!pointers.has(ev.pointerId)) return;
    pad.releasePointerCapture?.(ev.pointerId);
    pointers.delete(ev.pointerId);
    if (pointers.size === 0) pad.classList.remove("pad--active");
    flushNow(); // foto con el contacto ya ausente; c:[] si era el último
  }

  function onCancel(ev) {
    if (!pointers.has(ev.pointerId)) return;
    pointers.delete(ev.pointerId);
    if (pointers.size === 0) pad.classList.remove("pad--active");
    flushNow();
  }

  function init() {
    pad.addEventListener("pointerdown", onDown);
    pad.addEventListener("pointermove", onMove);
    pad.addEventListener("pointerup", onUp);
    pad.addEventListener("pointercancel", onCancel);
    pad.addEventListener("contextmenu", (e) => e.preventDefault());
    pad.addEventListener("dragstart", (e) => e.preventDefault());
  }

  return { init };
})();

// ─────────────────────────── Teclado (§3) ──────────────────────────────────
const Keyboard = (() => {
  const SEED = "​"; // zero-width space: semilla para que Backspace siempre dispare
  const input = document.getElementById("hidden-input");
  const area = document.getElementById("kbd-area");

  // Modificadores sticky armados (se desarman tras usarse).
  const armed = new Set();
  const modButtons = new Map();

  // Estado de composición del IME: mientras está activo NO reseed-eamos ni
  // mandamos parciales (evita duplicar acentos/palabras en Android).
  let composing = false;

  // Segmentación por grafemas para contar borrados (emoji, ñ compuesta).
  const seg = (typeof Intl !== "undefined" && Intl.Segmenter)
    ? new Intl.Segmenter("es", { granularity: "grapheme" })
    : null;

  function graphemeCount(str) {
    if (!str) return 0;
    if (seg) {
      let n = 0;
      for (const _ of seg.segment(str)) n++;
      return n;
    }
    return [...str].length; // fallback por code points
  }

  function reseed() {
    input.value = SEED;
    try { input.setSelectionRange(SEED.length, SEED.length); } catch {}
  }

  function setArmed(mod, on) {
    if (on) armed.add(mod); else armed.delete(mod);
    const btn = modButtons.get(mod);
    if (btn) btn.classList.toggle("is-armed", on);
  }

  function disarmAll() {
    for (const m of [...armed]) setArmed(m, false);
  }

  // Envía una tecla especial / combo. `key` debe ser 1 grafema o una special.
  function sendKey(key) {
    if (armed.size > 0) {
      Net.send({ t: "k", a: "combo", mods: [...armed], key });
      disarmAll();
    } else {
      Net.send({ t: "k", a: "special", key });
    }
  }

  // Envía texto plano (camino normal Unicode). Si hay mods armados, los
  // desarmamos y mandamos el texto suelto: escribir texto corrido con un
  // modificador armado casi nunca es un combo intencional.
  function sendText(text) {
    if (!text) return;
    if (armed.size > 0) {
      const graphemes = seg ? [...seg.segment(text)].map((s) => s.segment) : [...text];
      if (graphemes.length === 1) {
        // Un solo grafema con mods → combo legítimo (p.ej. Ctrl+a).
        Net.send({ t: "k", a: "combo", mods: [...armed], key: graphemes[0] });
        disarmAll();
        return;
      }
      // Texto corrido: desarmar y mandar como texto.
      disarmAll();
    }
    Net.send({ t: "k", a: "text", text });
  }

  // Manda N pulsaciones de una tecla de borrado.
  function sendDeletes(key, n) {
    for (let i = 0; i < n; i++) sendKey(key);
  }

  function onCompositionStart() { composing = true; }

  function onCompositionEnd(ev) {
    composing = false;
    // El resultado final de la composición llega acá: mandarlo una sola vez.
    if (ev.data) sendText(ev.data);
    reseed();
  }

  function onBeforeInput(ev) {
    const type = ev.inputType;

    // Durante composición no actuamos: esperamos compositionend. Dejar que el
    // input acumule para que el IME funcione; lo limpiamos al cerrar.
    if (composing || (type && type.indexOf("CompositionText") !== -1)) {
      // No preventDefault: el IME necesita su buffer. No reseed acá.
      return;
    }

    switch (type) {
      case "insertText":
      case "insertFromComposition":
      case "insertFromPaste":
        if (ev.data) sendText(ev.data);
        break;
      case "insertReplacementText":
        // Autocorrect que reemplaza: mandar el reemplazo si hay data.
        if (ev.data) sendText(ev.data);
        break;
      case "deleteContentBackward": {
        // Contar grafemas borrados comparando value antes/después no es
        // posible en beforeinput; usamos el rango seleccionado si lo hay.
        const sel = (input.selectionEnd ?? 0) - (input.selectionStart ?? 0);
        // El SEED ocupa 1 code unit; si hay selección real (>0) borrar esos
        // grafemas, si no, un solo Backspace.
        const txt = input.value || "";
        const removed = sel > 0
          ? graphemeCount(txt.slice(input.selectionStart, input.selectionEnd))
          : 1;
        sendDeletes("Backspace", Math.max(1, removed));
        break;
      }
      case "deleteContentForward": {
        const sel = (input.selectionEnd ?? 0) - (input.selectionStart ?? 0);
        const txt = input.value || "";
        const removed = sel > 0
          ? graphemeCount(txt.slice(input.selectionStart, input.selectionEnd))
          : 1;
        sendDeletes("Delete", Math.max(1, removed));
        break;
      }
      case "deleteByCut":
      case "deleteByDrag": {
        const txt = input.value || "";
        const removed = graphemeCount(txt.slice(input.selectionStart, input.selectionEnd));
        sendDeletes("Backspace", Math.max(1, removed));
        break;
      }
      case "insertLineBreak":
      case "insertParagraph":
        sendKey("Enter");
        break;
      default:
        if (ev.data) sendText(ev.data);
        break;
    }
    ev.preventDefault();
    reseed();
  }

  function onInput() {
    // Solo limpiamos fuera de composición. Durante composición el IME maneja
    // su propio buffer y reseed-ear lo rompería.
    if (composing) return;
    if (input.value !== SEED) reseed();
  }

  // Teclados físicos en desktop sí dan keydown útil: cubrimos navegación.
  function onKeyDown(ev) {
    if (composing || ev.isComposing) return;
    const navKeys = [
      "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
      "Home", "End", "PageUp", "PageDown", "Escape", "Tab",
    ];
    if (navKeys.includes(ev.key)) {
      ev.preventDefault();
      sendKey(ev.key);
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      sendKey("Enter");
    } else if (ev.key === "Backspace") {
      ev.preventDefault();
      sendKey("Backspace");
    }
  }

  function focusInput() {
    reseed();
    input.focus();
    area.classList.add("is-focused");
  }

  function init() {
    reseed();
    input.addEventListener("compositionstart", onCompositionStart);
    input.addEventListener("compositionend", onCompositionEnd);
    input.addEventListener("beforeinput", onBeforeInput);
    input.addEventListener("keydown", onKeyDown);
    input.addEventListener("focus", () => area.classList.add("is-focused"));
    input.addEventListener("blur", () => area.classList.remove("is-focused"));
    input.addEventListener("input", onInput);

    area.addEventListener("pointerdown", (ev) => {
      if (ev.target === input) return;
      ev.preventDefault();
      focusInput();
    });

    document.querySelectorAll(".key--mod").forEach((btn) => {
      const mod = btn.dataset.mod;
      modButtons.set(mod, btn);
      btn.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        const on = !armed.has(mod);
        setArmed(mod, on);
        if (on && navigator.vibrate) { try { navigator.vibrate(10); } catch {} }
      });
    });

    document.querySelectorAll(".key--special").forEach((btn) => {
      const key = btn.dataset.key;
      btn.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        // El botón Enter del menú = salto de línea SIN enviar. A nivel de SO eso
        // solo existe como Shift+Enter (newline en chats/editores). El Enter "a
        // secas" del teclado nativo del celular sigue siendo "enviar". Con mods
        // armados respetamos la intención del usuario (p.ej. Ctrl+Enter).
        if (key === "Enter" && armed.size === 0) {
          Net.send({ t: "k", a: "combo", mods: ["shift"], key: "Enter" });
          return;
        }
        sendKey(key);
      });
    });
  }

  return { init, focusInput };
})();

// ─────────────────────────── Sheet del teclado ─────────────────────────────
const Sheet = (() => {
  let open = false;
  let sheet, backdrop, toggle;

  function setOpen(next) {
    open = next;
    sheet.classList.toggle("sheet--hidden", !open);
    sheet.setAttribute("aria-hidden", String(!open));
    toggle.setAttribute("aria-expanded", String(open));
    if (open) {
      backdrop.hidden = false;
      requestAnimationFrame(() => backdrop.classList.add("is-visible"));
      Keyboard.focusInput();
    } else {
      backdrop.classList.remove("is-visible");
      setTimeout(() => { backdrop.hidden = true; }, 240);
      const inp = document.getElementById("hidden-input");
      if (inp) inp.blur();
    }
  }

  function init() {
    sheet = document.getElementById("sheet");
    backdrop = document.getElementById("sheet-backdrop");
    toggle = document.getElementById("kbd-toggle");
    const handle = document.getElementById("sheet-handle");

    toggle.addEventListener("click", () => setOpen(!open));
    handle.addEventListener("click", () => setOpen(false));
    backdrop.addEventListener("click", () => setOpen(false));
  }

  return { init };
})();

// ─────────────────────────── Micrófono (Web Speech API) ────────────────────
const Mic = (() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  let stillOn = false;
  let btn, interim;
  // Cuántos resultados finales de la sesión actual ya inyectamos. Evita el doble
  // tipeo en Chrome Android, que con continuous=true re-emite resultados ya
  // finalizados en eventos posteriores (la causa de las palabras repetidas).
  // Se resetea en cada (re)arranque del reconocedor: cada sesión empieza en 0.
  let finalCount = 0;

  function setUI(state) {
    if (!btn) return;
    btn.classList.remove("mic--listening", "mic--error");
    btn.setAttribute("aria-pressed", String(state === "listening"));
    if (state === "listening") btn.classList.add("mic--listening");
    else if (state === "error") {
      btn.classList.add("mic--error");
      setTimeout(() => btn.classList.remove("mic--error"), 2000);
    }
  }

  function showInterim(text) {
    if (!interim) return;
    interim.textContent = text;
    interim.classList.toggle("is-visible", !!text);
  }

  function onResult(e) {
    // Recorremos toda la lista (no desde e.resultIndex): en Chrome Android ese
    // índice no es confiable y reprocesar finales ya enviados es lo que duplicaba
    // las palabras. finalCount es la barrera: solo inyectamos finales nuevos.
    // Defensivo: si la lista es más corta que la barrera, arrancó una sesión nueva
    // que no pasó por start()/onend → resetear para no descartar sus finales.
    if (e.results.length < finalCount) finalCount = 0;
    let live = "";
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) {
        if (i >= finalCount) {
          const text = r[0].transcript.trim();
          if (text) Net.send({ t: "k", a: "text", text: text + " " });
          finalCount = i + 1;
        }
      } else {
        // Solo el interim más reciente: acumular todos los parciales del evento
        // los pega repetidos en pantalla ("hohola").
        live = r[0].transcript;
      }
    }
    showInterim(live);
  }

  function start() {
    stillOn = true;
    finalCount = 0; // nueva sesión: la lista de resultados arranca de cero
    try { rec.start(); } catch {}
  }

  function stop() {
    stillOn = false;
    try { rec.stop(); } catch {}
    showInterim("");
    setUI("idle");
  }

  function toggle() {
    if (!rec) return;
    if (stillOn) stop();
    else start();
  }

  function init() {
    btn = document.getElementById("mic");
    interim = document.getElementById("mic-interim");
    if (!btn) return;

    // Sin secure-context / sin soporte → botón deshabilitado con motivo.
    if (!SR || !window.isSecureContext) {
      btn.disabled = true;
      btn.setAttribute("aria-disabled", "true");
      btn.title = SR ? "requiere HTTPS" : "voz no soportada en este navegador";
      return;
    }

    rec = new SR();
    rec.lang = "es-AR"; // fijo: el dictado es en español aunque el SO del cel esté en otro idioma
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => setUI("listening");
    rec.onresult = onResult;
    rec.onend = () => {
      // continuous se corta solo tras silencio: reanudar mientras el usuario lo quiera.
      // El rearranque abre una sesión nueva (results desde 0) → resetear la barrera.
      if (stillOn) { finalCount = 0; try { rec.start(); } catch {} }
      else { setUI("idle"); showInterim(""); }
    };
    rec.onerror = (e) => {
      switch (e.error) {
        case "not-allowed":
        case "service-not-allowed":
          stillOn = false;
          // Permiso denegado: motivo accionable (no deshabilitamos por si el
          // usuario lo concede después y reintenta).
          btn.title = "micrófono bloqueado — permitilo en el navegador";
          setUI("error");
          break;
        case "audio-capture":
          stillOn = false;
          btn.disabled = true;
          setUI("error");
          break;
        case "no-speech":
        case "aborted":
          break; // benigno; onend decide
        case "network":
          setUI("error");
          break;
        default:
          setUI("error");
      }
    };

    btn.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();   // no robar foco al input ni disparar gestos
      ev.stopPropagation();
    });
    btn.addEventListener("click", toggle);
  }

  return { init };
})();

// ─────────────────── Telemetría / boot ──────────────────────────────────────
// Módulo ADITIVO: solo lee. HUD de depuración que muestra Δx/Δy, posición,
// velocidad y un crosshair con listeners PASIVOS sobre el pad, más la animación
// de boot. Independiente del forwarder de contactos (Pad): no interfiere con él.
const Telemetry = (() => {
  let pad, cross, elDx, elDy, elPos, elVel, elEvt;
  let last = null;          // {x, y, t} del último pointermove
  let padRect = null;       // bounds del pad, cacheado por interacción (ver onMove)
  let evtHoldTimer = null;  // mantiene el último evento discreto visible

  const reduce = () => window.matchMedia
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // "+012" / "-004": signo + 3 dígitos con relleno.
  const sgn3 = (n) => (n >= 0 ? "+" : "-") + String(Math.abs(n)).padStart(3, "0");
  const pad3 = (n) => String(Math.max(0, Math.round(n))).padStart(3, "0");

  // Setea el readout de evento; los discretos se sostienen ~600ms.
  function evt(label, hold) {
    if (!elEvt) return;
    elEvt.textContent = label;
    clearTimeout(evtHoldTimer);
    if (hold) {
      evtHoldTimer = setTimeout(() => {
        elEvt.textContent = pad.classList.contains("pad--active") ? "MOVE" : "IDLE";
      }, 600);
    }
  }

  function onMove(e) {
    // El pad no se mueve ni redimensiona mientras hay un dedo encima, así que su
    // rect es estable durante una interacción: lo medimos una sola vez (en el
    // primer move, cuando last es null) en vez de forzar un reflow por frame en
    // este hot path. onUp resetea last → el próximo gesto lo vuelve a medir.
    if (!last) padRect = pad.getBoundingClientRect();
    const r = padRect;
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const now = performance.now();

    if (last) {
      const dx = Math.round(x - last.x);
      const dy = Math.round(y - last.y);
      const dt = (now - last.t) / 1000;
      const dist = Math.hypot(dx, dy);
      const v = dt > 0 ? dist / dt : 0;
      elDx.textContent = sgn3(dx);
      elDy.textContent = sgn3(dy);
      elVel.textContent = String(Math.min(9999, Math.round(v))).padStart(4, "0");
    }
    elPos.textContent = pad3(x) + "," + pad3(y);

    // Crosshair sigue al puntero (a menos que se reduzca movimiento).
    if (!reduce()) {
      cross.style.left = x + "px";
      cross.style.top = y + "px";
    }

    // Solo etiqueta MOVE si no hay un discreto sostenido encima.
    if (!evtHoldTimer && elEvt.textContent !== "DRAG" && elEvt.textContent !== "SCROLL") {
      elEvt.textContent = "MOVE";
    }
    last = { x, y, t: now };
  }

  function onUp() {
    last = null;
    if (!evtHoldTimer) evt("IDLE");
  }

  function init() {
    pad = document.getElementById("pad");
    cross = document.getElementById("tel-cross");
    elDx = document.getElementById("tel-dx");
    elDy = document.getElementById("tel-dy");
    elPos = document.getElementById("tel-pos");
    elVel = document.getElementById("tel-vel");
    elEvt = document.getElementById("tel-evt");
    if (!pad || !elEvt) return;

    // Listeners PASIVOS y adicionales: no interfieren con los del clasificador.
    pad.addEventListener("pointermove", onMove, { passive: true });
    pad.addEventListener("pointerup", onUp, { passive: true });
    pad.addEventListener("pointercancel", onUp, { passive: true });

    boot();
  }

  // Secuencia de boot: revela líneas tipo log y luego se desvanece (~1s).
  function boot() {
    const bootEl = document.getElementById("boot");
    if (!bootEl || reduce()) { if (bootEl) bootEl.classList.add("is-done"); return; }
    const lines = [...bootEl.querySelectorAll(".boot__line")];
    let i = 0;
    const step = () => {
      if (i < lines.length) {
        lines[i].classList.add("show");
        i++;
        setTimeout(step, 80 + Math.random() * 90);
      } else {
        setTimeout(() => bootEl.classList.add("is-done"), 380);
      }
    };
    setTimeout(step, 120);
  }

  return { init };
})();

// ─────────────────────────── Copiar / Pegar (§3) ───────────────────────────
// Dos botones de la actionbar que disparan Ctrl+C / Ctrl+V sobre la app
// enfocada en la PC. Son combos comunes (mismo camino que el teclado): el
// server rutea {t:"k",a:"combo",mods:["ctrl"],key} a Injector.Combo.
// Nota: en una terminal el copiar/pegar es Ctrl+Shift+C/V — mismo límite
// conocido que el pegado Unicode (ADR 0002).
const Clipboard = (() => {
  function bind(id, key) {
    const btn = document.getElementById(id);
    if (!btn) return; // defensivo: id ausente no debe romper el boot
    // pointerdown: evitar robar foco / disparar gestos del pad (igual que Mic).
    btn.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });
    btn.addEventListener("click", () => {
      Net.send({ t: "k", a: "combo", mods: ["ctrl"], key });
      if (navigator.vibrate) { try { navigator.vibrate(10); } catch {} }
    });
  }

  function init() {
    bind("copy", "c");
    bind("paste", "v");
  }

  return { init };
})();

// ──────────────────────── Acciones de GNOME Shell (§4) ─────────────────────
// Dos botones que abren vistas de GNOME mandando la intención de gesto: el
// daemon elige las teclas (overview = Super, apps = Super+A), igual que los
// gestos de 3 dedos. Así el atajo se reconfigura sin tocar la PWA.
const Shell = (() => {
  function bind(id, name) {
    const btn = document.getElementById(id);
    if (!btn) return; // defensivo: id ausente no debe romper el boot
    btn.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });
    btn.addEventListener("click", () => {
      Net.send({ t: "g", name });
      if (navigator.vibrate) { try { navigator.vibrate(10); } catch {} }
    });
  }

  function init() {
    bind("overview", "overview");
    bind("apps", "apps");
  }

  return { init };
})();

// ─────────────────────────────── Bootstrap ─────────────────────────────────
function main() {
  document.addEventListener("gesturestart", (e) => e.preventDefault());
  document.addEventListener("dblclick", (e) => e.preventDefault());

  Pad.init();
  Keyboard.init();
  Sheet.init();
  Mic.init();
  Clipboard.init();
  Shell.init();
  Telemetry.init();
  Net.connect();

  // Service worker: arranque instantáneo del shell. Requiere secure-context
  // (HTTPS), que ya tenemos; en http simplemente no se registra.
  // En DEV no registramos (y desregistramos lo que haya) para ver siempre lo
  // último sin cache; el daemon dev sirve un SW de autodestrucción en /sw.js
  // que limpia un SW de prod previo.
  if ("serviceWorker" in navigator) {
    if (window.__PHONEPAD_DEV__) {
      navigator.serviceWorker.getRegistrations()
        .then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
    } else if (location.protocol === "https:") {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }

  // Reveal escalonado en carga.
  requestAnimationFrame(() => document.body.classList.add("loaded"));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
