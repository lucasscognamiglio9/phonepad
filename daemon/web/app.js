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
  let pingSent = 0;
  let capabilities = null;
  let inputCaps = null;
  let connected = false;     // socket abierto y handshake ok
  let manualClose = false;
  let reconnectTimer = null;
  let connecting = false;
  let epoch = 0;
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

  let token = resolveToken(); // migration only; new sessions use an HttpOnly cookie
  let pairCode = new URLSearchParams((location.hash || "").replace(/^#/, "")).get("pair") || "";
  if (pairCode) {
    try { const u = new URL(location.href); history.replaceState(null,"",u.pathname + u.search); } catch {}
  }
  // Esquema derivado del protocolo de la página: https → wss, http → ws.
  // Una página https no puede abrir ws:// plano (mixed-content); esto lo evita.
  const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  const wsURL = `${wsProto}//${location.host}/ws?protocol=2&directPointer=1`;

  function rejectAuth() {
    authRejected = true;
    connected = false;
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    render("error", "vinculación necesaria · abrí un QR nuevo en la laptop");
  }

  // Los browsers esconden el status HTTP (401) del handshake WebSocket y solo
  // disparan error/close. Este preflight permite distinguir credencial revocada
  // de una caída de red; un 401 es terminal hasta que el usuario reescanee, así
  // evitamos una reconexión infinita que además puede parecer un ataque.
  async function authPreflight() {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), AUTH_TIMEOUT) : null;
    try {
      const claiming = !!pairCode;
      const r = await fetch(claiming ? "/api/claim" : "/api/auth", {
        method: claiming ? "POST" : "GET",
        headers: claiming ? {"Content-Type":"application/json"} : (token ? {Authorization:`Bearer ${token}`} : {}),
        ...(claiming ? {body:JSON.stringify({code:pairCode})} : {}),
        cache: "no-store",
        credentials: "same-origin",
        ...(controller ? {signal:controller.signal} : {}),
      });
      if (r.status === 204) {
        pairCode = ""; token = "";
        try {localStorage.removeItem(STORAGE_KEY);} catch {}
      }
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
    if (authRejected || manualClose || connecting || ws) return;
    connecting = true;
    const attempt = ++epoch;
    const valid = await authPreflight();
    if (attempt !== epoch) return;
    connecting = false;
    if (!valid || manualClose || authRejected) return;
    clearTimeout(reconnectTimer);
    render(connected ? "reconnecting" : "connecting", connected ? "reconectando…" : "conectando…");
    try {
      ws = new WebSocket(wsURL);
    } catch (e) {
      scheduleReconnect();
      return;
    }

    const socket = ws;
    ws.onopen = () => { if (ws === socket) startKeepalive(); };

    ws.onmessage = (ev) => {
      if (ws !== socket) return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === "pong") {
        // Pong recibido: limpiar timeout pendiente y resetear contador de misses.
        if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
        missed = 0;
        if (connected && pingSent) document.getElementById("status-text").textContent = `conectado · ${Math.max(0, Date.now() - pingSent)} ms de red`;
      } else if (msg.t === "capabilities") {
        try { capabilities=PhonepadCore.parseSessionCapabilities(msg);inputCaps=PhonepadCore.inputCapabilities(msg.input); } catch { socket.close(); return; }
        window.dispatchEvent(new CustomEvent('phonepad-capabilities'));
      } else if (msg.t === "receipt") {
        window.dispatchEvent(new CustomEvent('phonepad-receipt',{detail:msg}));
      } else if (msg.t === "ok") {
        try { capabilities=PhonepadCore.parseSessionCapabilities(msg);inputCaps=PhonepadCore.inputCapabilities(msg.input); } catch { socket.close(); render('error','Versiones incompatibles'); return; }
        window.dispatchEvent(new CustomEvent('phonepad-capabilities'));
        connected = true;
        backoffIdx = 0;
        Pad.reset();
        render("connected", "conectado");
      } else if (msg.t === "err") {
        // Token inválido u otro error: el server cierra; mensaje accionable.
        rejectAuth();
      } else if (msg.t === "reload" && window.__PHONEPAD_DEV__) {
        // Hot-reload (solo dev): el daemon detectó un cambio en web/.
        location.reload();
      }
    };

    ws.onclose = (ev) => {
      if (ws !== socket) return;
      cleanupSocket();
      if (ev.code === 1008) {
        manualClose = true;
        render("error", "otra sesión tomó el control");
        window.dispatchEvent(new Event("phonepad-paused"));
      }
      if (!manualClose) scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose se dispara después; dejamos que él agende la reconexión.
      try { socket.close(); } catch {}
    };
  }

  function startKeepalive() {
    stopKeepalive();
    missed = 0;
    pingTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      pingSent = Date.now();
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
    capabilities=null;inputCaps=null;queueMicrotask(()=>window.dispatchEvent(new CustomEvent('phonepad-capabilities')));
    stopKeepalive();
    ws = null;
    connected = false;
    Pad.reset();
    window.dispatchEvent(new Event("phonepad-disconnected"));
  }

  function scheduleReconnect() {
    if (manualClose || authRejected) return;
    clearTimeout(reconnectTimer);
    const delay = BACKOFFS[Math.min(backoffIdx, BACKOFFS.length - 1)];
    backoffIdx++;
    // Mostrar el intento da señal de vida cuando la LAN se cae un rato.
    render("reconnecting", `reconectando… (${backoffIdx})`);
    reconnectTimer = setTimeout(connect, delay);
  }

  function send(obj) {
    if(obj.t!=='ping' && !PhonepadCore.allowsInput(capabilities,obj.t)) return false;
    if(obj.t!=='ping' && capabilities?.sessionEpoch) obj={...obj,sessionEpoch:capabilities.sessionEpoch};
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (ws.bufferedAmount > 65536) { ws.close(); return; }
      if (connected || obj.t === "ping") { ws.send(JSON.stringify(obj)); return true; }
    }
  }

  function isConnected() {
    return connected && !!ws && ws.readyState === WebSocket.OPEN;
  }

  function pause() {
    manualClose = true;
    epoch++;
    connecting = false;
    clearTimeout(reconnectTimer);
    Pad.reset();
    const old = ws;
    cleanupSocket();
    if (old) old.close();
    render("error", "sesión pausada");
  }
  function resume() { manualClose = false; authRejected = false; return connect(); }
  return { connect, send, isConnected, pause, resume, get capabilities(){return capabilities}, get inputCaps(){return inputCaps} };
})();

window.PhonepadNet=Net;

// Relative touchpad gestures, shared by the full-screen pad and live preview.
const Pad = (() => {
  const pad = document.getElementById("pad"), points = new Map();
  let peak=0, started=0, moved=false, last=null, origin=null, swiped=false, lastUp=0;
  let scrollX=0, scrollY=0, dragTimer=null, dragging=false;
  const center=()=>{ const p=[...points.values()];return p.length ? {x:p.reduce((s,p)=>s+p.x,0)/p.length,y:p.reduce((s,p)=>s+p.y,0)/p.length}:null; };
  function reset(){clearTimeout(dragTimer);if(dragging)Net.send({t:"b",btn:"l",a:"up"});dragging=false;points.clear();peak=0;last=null;origin=null;scrollX=scrollY=0;pad.classList.remove("pad--active");}
  function down(e){
    if(!Net.isConnected())return;
    e.preventDefault?.();
    if(!points.size){started=Date.now();moved=false;swiped=false;peak=0;}
    points.set(e.pointerId,{x:e.clientX,y:e.clientY});peak=Math.max(peak,points.size);
    clearTimeout(dragTimer);
    if(points.size===1)dragTimer=setTimeout(()=>{if(points.size===1 && !moved){dragging=true;Net.send({t:"b",btn:"l",a:"down"});}},450);
    else if(dragging){Net.send({t:"b",btn:"l",a:"up"});dragging=false;}
    last=center();origin=last;try{(e.currentTarget||pad).setPointerCapture(e.pointerId);}catch{}
    pad.classList.add("pad--active");
  }
  function move(e){
    if(!points.has(e.pointerId))return;
    e.preventDefault?.();points.set(e.pointerId,{x:e.clientX,y:e.clientY});const c=center();
    const dx=c.x-last.x,dy=c.y-last.y;last=c;
    if(Math.hypot(c.x-origin.x,c.y-origin.y)>8)moved=true;
    if(points.size===1 && peak===1){Net.send({t:"m",dx:Math.round(dx*2*(window.PhonepadControlGain?.()??1)),dy:Math.round(dy*2*(window.PhonepadControlGain?.()??1))});}
    else if(points.size===2 && peak===2){
      scrollX+=dx;scrollY+=dy;const x=Math.trunc(scrollX/18),y=Math.trunc(scrollY/18);
      if(x||y){Net.send({t:"s",dx:x,dy:y});scrollX-=x*18;scrollY-=y*18;}
    } else if(points.size===3 && !swiped && c.y-origin.y < -45 && Math.abs(c.x-origin.x)<60){
      const now=Date.now();Net.send({t:"g",name:lastUp && now-lastUp<1600 ? "apps":"overview"});
      lastUp=lastUp && now-lastUp<1600 ? 0:now;swiped=true;
    }
  }
  function up(e){
    if(!points.has(e.pointerId))return;
    points.delete(e.pointerId);last=center();
    if(!points.size){
      if(!dragging && !moved && !swiped && Date.now()-started<350 && peak<=2){
        const btn=peak===2?"r":"l";Net.send({t:"b",btn,a:"down"});Net.send({t:"b",btn,a:"up"});
      }
      reset();
    }
  }
  function init(){
    window.addEventListener("resize",reset);
    for (const surface of [pad, document.getElementById("desktop-preview")]) {
      if (!surface) continue;
      surface.addEventListener("pointerdown",down);surface.addEventListener("pointermove",move);surface.addEventListener("pointerup",up);
      surface.addEventListener("pointercancel",reset);
      surface.addEventListener("lostpointercapture",e=>{if(points.has(e.pointerId))reset();});
      surface.addEventListener("contextmenu",e=>e.preventDefault());
    }
  }
  return {init,reset};
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
    input.focus({preventScroll:true});
    area.classList.add("is-focused");
  }

  function init() {
    window.addEventListener("phonepad-disconnected", () => { disarmAll(); composing = false; reseed(); });
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

  return { init, focusInput, releaseModifiers:disarmAll };
})();

// ─────────────────────────── Sheet del teclado ─────────────────────────────
const Sheet = (() => {
  let open = false;
  let sheet, backdrop, toggle;

  function setOpen(next) {
    open = next;
    sheet.classList.toggle("sheet--hidden", !open);
    document.body.classList.toggle("keyboard-open",open);
    sheet.setAttribute("aria-hidden", String(!open));
    sheet.inert = !open;
    toggle.setAttribute("aria-expanded", String(open));
    if (open) {
      backdrop.hidden = true;
      document.getElementById("keyboard-extras").hidden=false;
      document.getElementById('web-draft')?.focus();
    } else {
      document.getElementById("keyboard-extras").hidden=true;
      Keyboard.releaseModifiers();
      backdrop.classList.remove("is-visible");
      setTimeout(() => { backdrop.hidden = true; }, 240);
      const inp = document.getElementById("web-draft");
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
    const focusTarget=document.getElementById("hidden-input");
    focusTarget.addEventListener("blur",()=>setTimeout(()=>{
      if(open && document.activeElement!==focusTarget && !sheet.contains(document.activeElement))setOpen(false);
    },0));
    backdrop.addEventListener("click", () => setOpen(false));
    function fit(){
      const v=window.visualViewport;
      document.body.classList.toggle("native-keyboard",!!v && window.innerHeight-v.height>100);
      document.documentElement.style.setProperty("--visible-height", `${v?v.height:window.innerHeight}px`);
      document.documentElement.style.setProperty("--visible-top", `${v?v.offsetTop:0}px`);
    }
    window.visualViewport?.addEventListener("resize",fit);
    window.visualViewport?.addEventListener("scroll",fit);
    window.addEventListener("resize",fit);fit();
    if(typeof ResizeObserver!=="undefined") new ResizeObserver(()=>document.documentElement.style.setProperty("--composer-height",`${sheet.getBoundingClientRect().height}px`)).observe(sheet);
  }

  return { init, close: () => setOpen(false) };
})();

// ─────────────────── Telemetría / boot ──────────────────────────────────────
// Módulo ADITIVO: solo lee. HUD de depuración que muestra Δx/Δy, posición,
// velocidad y un crosshair con listeners PASIVOS sobre el pad, más la animación
// de boot. Independiente del forwarder de contactos (Pad): no interfiere con él.
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
    // Keep keyboard focus while operating clipboard actions.
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

// Production updates apply automatically once interaction is idle.
const Updates = (() => {
  let registration, pending = false, timer, activePointers = new Set();
  function apply() {
    if (!pending || document.hidden || activePointers.size) return;
    if ((document.activeElement?.id === "hidden-input" || window.PhonepadHasPendingWork?.())) { idle(); return; }
    Net.pause();
    location.reload();
  }
  function idle() { clearTimeout(timer); timer = setTimeout(apply, 5000); }
  function check() {
    if (document.hidden) return;
    navigator.serviceWorker.controller?.postMessage({type:"PHONEPAD_VERSION"});
    registration?.update().catch(() => {});
  }
  function init() {
    if (!("serviceWorker" in navigator) || window.__PHONEPAD_DEV__) return;
    navigator.serviceWorker.addEventListener("message", e => {
      if (e.data?.type === "PHONEPAD_VERSION" && e.data.build !== document.body.dataset.phonepadBuild) { pending = true; idle(); }
    });
    navigator.serviceWorker.addEventListener("controllerchange", () => { pending = true; idle(); });
    navigator.serviceWorker.register("/sw.js", {updateViaCache:"none"}).then(r => { registration = r; check(); }).catch(() => {});
    document.addEventListener("pointerdown", e => { activePointers.add(e.pointerId); idle(); }, true);
    for (const name of ["pointerup", "pointercancel"]) document.addEventListener(name, e => { activePointers.delete(e.pointerId); idle(); }, true);
    for (const name of ["keydown", "input"]) document.addEventListener(name, idle, true);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) activePointers.clear(); else { check(); idle(); }
    });
    window.addEventListener("online", check);
    setInterval(check, 60000);
  }
  return {init};
})();

// ─────────────────────────────── Bootstrap ─────────────────────────────────
function main() {
  document.addEventListener("gesturestart", (e) => e.preventDefault());
  document.addEventListener("dblclick", (e) => e.preventDefault());

  Pad.init();
  // The shared literal composer is initialized by receiver-controls.js.
  Sheet.init();
  // Explicit bidirectional clipboard is initialized by receiver-controls.js.
  Shell.init();

  document.getElementById("refresh-control").addEventListener("click", () => { paused = false; Net.pause(); Net.resume(); window.dispatchEvent(new Event("phonepad-recover")); });

  Net.connect();
  let paused = false;
  const sessionButton = document.getElementById("session-toggle");
  window.addEventListener("phonepad-paused", () => { paused = true; sessionButton.textContent = "Reanudar"; });
  sessionButton.addEventListener("click", () => {
    paused = !paused;
    if (paused) Net.pause(); else Net.resume();
    sessionButton.textContent = paused ? "Reanudar" : "Pausar";
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) Net.pause();
    else if (!paused) Net.resume();
  });
  window.addEventListener("online", () => { if (!paused && !document.hidden) Net.resume(); });
  window.addEventListener("pagehide", () => Net.pause());
  window.addEventListener("pageshow", () => { if (!paused) Net.resume(); });

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
      Updates.init();
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
