# phonepad — spec

> Celular como touchpad + teclado de la laptop, por LAN. Casero, custom, simple, baja latencia.
> Este documento es el **contrato**: el daemon (Go) y la PWA (web) se implementan contra él.
> Es un documento vivo — iteramos acá a medida que aprendemos.

## 1. Objetivo y alcance

Convertir el celular en un touchpad + teclado para controlar la laptop Linux (Wayland/GNOME)
sobre la red local. La pantalla del celular:

- **Mitad superior**: superficie táctil tipo touchpad.
- **Mitad inferior**: drawer deslizable que despliega el teclado nativo del celular.

Prioridad de diseño: **latencia percibida instantánea** y **mantener todo simple**.

### MVP (lo que entra)

- Mover cursor (1 dedo).
- Click izquierdo (tap 1 dedo), click derecho (tap 2 dedos).
- Scroll (2 dedos, dirección natural).
- Drag (tap-and-a-half, sin lock) — paridad con el touchpad físico de la laptop.
- Teclado: texto Unicode (acentos/emoji), teclas especiales, **modificadores sticky** (Ctrl/Alt/Super/Shift) para atajos.
- Pairing por QR en terminal + token persistente revocable.

### Implementado más allá del MVP original

- **TLS/HTTPS + wss** con cert self-signed (habilita micrófono/secure-context; §8).
- **PWA instalable** (manifest + íconos + service worker): ícono propio, full-screen.
- **Pairing persistente** entre reinicios (token estable en `~/.config/phonepad`; §7).
- **Gestos de 3 dedos** (overview / cambiar workspace).
- **Pinch de 2 dedos nativo → la aplicación activa** (libinput/GNOME, igual que un
  touchpad físico; ADR 0005). El daemon ya no sintetiza una lupa.
- **Toggle de Quick Settings** (extensión GNOME) + servicio systemd de usuario (§13).

### No-goals (v2+)

- Multi-cliente simultáneo (asumimos 1 cliente).
- WebRTC DataChannel (fallback de latencia si el WiFi degrada).
- Drag-lock.

## 2. Arquitectura

```
📱 PWA (vanilla JS, servida por el daemon)            💻 daemon (Go, binario único)
   ├─ superficie táctil → forwarder de contactos        ├─ http: sirve la PWA (//go:embed web/)
   ├─ drawer + teclado nativo                            ├─ ws: recibe JSON, valida token
   └─ WS client (JSON) ───────── wss:// ──────────────▶ └─ touchpad de precisión uinput (MT Type B) + teclado
                                                              ▲ libinput clasifica los gestos y da el feel
   ◀── QR en terminal: https://<ip-lan>:<puerto>/?token=<persistente> ──
```

Principios (ver [ADR 0005](docs/adr/0005-touchpad-precision-emulado.md)):

- **El cliente reenvía contactos; libinput clasifica.** El daemon se presenta ante el SO
  como un touchpad de precisión multitouch (uinput, protocolo MT Type B); el cliente reenvía
  la foto de contactos crudos por frame y **libinput/GNOME clasifican los gestos nativamente**
  (swipe de 3 dedos, scroll/pinch de 2, tap-to-click). Invierte el principio viejo (cliente
  clasificaba, server inyectaba 1:1), que no podía dar animaciones progresivas.
- **El feel lo hereda de GNOME**, no nosotros. Velocidad, aceleración, sentido de scroll,
  tap-to-click: toda la config de touchpad del usuario. Cero código de feel (paridad total).
- **JSON sobre WebSocket text frames.** Debuggeable en DevTools del celular. Binario es v2 si algún día se mide un cuello (no se va a medir en LAN).

## 3. Protocolo (contrato cliente ⇄ server)

WebSocket, mensajes JSON (text frames), uno por línea conceptual. Campo `t` = tipo.

### Cliente → server

> **Legacy (ADR 0005):** `m`/`b`/`s`/`g` eran del clasificador viejo. El pad ahora
> emite sólo `t` (abajo); el daemon todavía rutea `m`/`b`/`s`/`g` por forward-compat,
> pero la PWA ya no los manda. El actionbar sigue usando `k` (teclado).

```jsonc
// [legacy] movimiento: delta acumulado del frame. Ya no lo emite el pad.
{"t":"m", "dx":12, "dy":-4}

// botón: down/up separados. btn ∈ {"l","r","m"}. Click = down+up sin moves; drag = down+moves+up.
{"t":"b", "a":"down", "btn":"l"}
{"t":"b", "a":"up",   "btn":"l"}

// scroll: signo ya ajustado a natural-scroll por el cliente. Unidades = "notches".
{"t":"s", "dx":0, "dy":-3}

// teclado — texto plano (camino normal, soporta Unicode/acentos/emoji):
{"t":"k", "a":"text", "text":"café 🚀"}

// teclado — tecla especial: key ∈ {Backspace,Enter,Tab,Escape,ArrowUp,ArrowDown,ArrowLeft,ArrowRight,Delete,Home,End,PageUp,PageDown}
{"t":"k", "a":"special", "key":"Backspace"}

// teclado — combo con modificadores sticky: mods ⊆ {ctrl,alt,super,shift}, key = 1 char o special.
{"t":"k", "a":"combo", "mods":["ctrl"], "key":"c"}
{"t":"k", "a":"combo", "mods":["alt"], "key":"Tab"}

// gesto/acción discreta: intención de alto nivel; el daemon elige las teclas (§4).
// name ∈ {overview (Super), apps (Super+A), ws-left, ws-right}.
// Los nombres zoom-in/zoom-out se aceptan únicamente como compatibilidad con
// clientes/daemons viejos; la PWA actual no los emite y el pinch es nativo.
// overview/apps/ws-* los disparan los gestos de 3 dedos y los botones Vista/Apps.
{"t":"g", "name":"overview"}

// touchpad de precisión (§5, ADR 0005): foto de los contactos vivos del frame.
// Coordenadas normalizadas 0..1; el daemon las mapea a slots MT Type B y libinput
// clasifica el gesto. Un id que desaparece del array = ese dedo se levantó;
// "c":[] = se levantaron todos. Es el ÚNICO mensaje que emite el pad hoy.
{"t":"t", "c":[{"id":1,"x":0.42,"y":0.55},{"id":2,"x":0.6,"y":0.55}]}

// ping de keepalive (cada ~2s; ver §6 reconexión)
{"t":"ping"}
```

### Server → cliente

```jsonc
{"t":"ok"}                       // handshake aceptado (token válido)
{"t":"err", "msg":"bad token"}   // y cierra la conexión
{"t":"pong"}                     // respuesta a ping
```

Reglas:

- El token viaja en la URL del handshake (la PWA usa `wss://` cuando la página es
  HTTPS): `wss://host/ws?token=...`. No se procesa ningún frame sin token válido.
  Server valida antes de procesar nada.
- Mensajes desconocidos se ignoran silenciosamente (forward-compat).
- El server nunca inicia acciones; solo responde.
- **Enter — dos semánticas**: el Enter del **teclado nativo** del celular envía `special Enter`
  (= "enviar", comportamiento normal). El **botón "↵ Línea"** del menú de teclas envía
  `combo shift+Enter` (= salto de línea SIN enviar). A nivel de SO Enter y newline son la misma
  tecla; sólo Shift+Enter las distingue en chats/editores. Con mods sticky armados, el botón
  respeta el combo del usuario (p.ej. Ctrl+Enter).

## 4. Mapeo a uinput (server)

El camino del celular usa **dos devices virtuales**: un **teclado** (para el actionbar) y un
**touchpad de precisión multitouch** (protocolo MT Type B, creado por ioctls a mano — la lib
`bendahl/uinput` no sirve para esto; ver ADR 0005 y Paso 0). El modo agente (`computer-mcp`)
tiene su propio device absoluto. Mapeo:

| Mensaje | Eventos uinput |
|---|---|
| `t {c:[{id,x,y}]}` | difea la foto contra el estado de slots → por contacto `ABS_MT_SLOT`/`ABS_MT_TRACKING_ID`/`ABS_MT_POSITION_X/Y` (normalizado→rango del device), `BTN_TOOL_*` según conteo de dedos, `BTN_TOUCH`, `SYN_REPORT`; `id` ausente → `TRACKING_ID -1` |
| `k text` | por cada rune: keycode+mods según layout, o paste Unicode (ver notas) |
| `k special` | `EV_KEY KEY_* 1`, `0`, `SYN_REPORT` |
| `k combo` | press de cada mod → press key → release key → release mods, `SYN_REPORT` |
| `m`/`b`/`s`/`g` (legacy) | el daemon los sigue ruteando (REL/BTN/WHEEL/combo) por compat; el pad ya no los emite |

El touchpad declara `BTN_TOOL_FINGER/DOUBLETAP/TRIPLETAP`, `ABS_MT_*` con resolución
(~100×70mm) e `INPUT_PROP_POINTER` (+`BUTTONPAD`), y **NO** `INPUT_PROP_DIRECT` (eso lo haría
touchscreen → libinput no daría gestos). El feel —scroll natural, aceleración, tap-to-click,
click-derecho de 2 dedos— lo da libinput desde la config de GNOME: cero código de feel.

Notas:

- El touchpad MT se crea por ioctls crudos (`UI_ABS_SETUP`/`UI_DEV_SETUP`/…, en
  `internal/input/touchpad_linux.go`); el mapeo contacto→slot es puro y testeado
  (`touchpad.go`). El teclado sigue con `github.com/bendahl/uinput`.
- Unicode arbitrario es el punto difícil con uinput (emite keycodes, no chars). En **GNOME
  Wayland `wtype` NO sirve**: Mutter no implementa `zwp_virtual_keyboard_v1` (falla con
  "Compositor does not support the virtual keyboard protocol"). Estrategia real (implementada en
  `internal/input`): **híbrido** — el ASCII del layout US se emite por keycode (`runeToKey`), y
  las runes Unicode (acentos/ñ/emoji) se pegan por **portapapeles** (`wl-copy` + `Ctrl+V`,
  guardando/restaurando el clip). Límite conocido: en terminales VTE el paste es `Ctrl+Shift+V`,
  así que ahí el fragmento Unicode no aparece (el ASCII sí).
- `EV_REL` entra por debajo del compositor → libinput acelera. NO escalar/acelerar en el server.

## 5. Pad (cliente) — forwarder de contactos

El cliente **no clasifica** (ADR 0005). Captura **Pointer Events** sobre la superficie y
reenvía la foto de contactos vivos por frame; libinput clasifica el gesto. No hay máquina de
estados, ni sensibilidad, ni signos de scroll: tap/drag/scroll/pinch/swipe los resuelve
libinput desde los contactos + la config de touchpad de GNOME (paridad total).

- **Coalescing por frame.** Los `pointermove` se acumulan y se envía UNA foto por
  `requestAnimationFrame`. `pointerdown`/`pointerup`/`pointercancel` se envían en el acto: son
  transiciones de estado que no se pueden perder (p.ej. un tap más corto que un frame).
- **Foto = todos los contactos vivos.** `{"t":"t","c":[{id,x,y},…]}` con `id`=`pointerId` y
  coordenadas **normalizadas 0..1** (relativas al rect del pad, con clamp). Un `id` que
  desaparece de la foto = ese dedo se levantó; `"c":[]` = se levantaron todos.
- **`setPointerCapture`** para seguir el dedo aunque salga del pad; `contextmenu`/`dragstart`
  prevenidos.

Lado daemon: mantiene el estado de slots Type B y difea cada foto (mapeo puro testeado en
`internal/input/touchpad.go`). **Naive-first**: escribe al recibir, sin buffering (mínima
latencia); un loop resampler a Hz fijo queda como fallback sólo si el jitter de LAN llega a
desclasificar gestos (a medir con el path real; ver ADR 0005).

## 6. Transporte y reconexión

- `wss://` (TLS, cert self-signed; ver §8). Mismo host/puerto que sirve la PWA. El cliente deriva
  el esquema del protocolo de la página (`https:`→`wss:`).
- Keepalive: cliente manda `{"t":"ping"}` cada ~2 s; si no hay `pong` en ~5 s, asume caída.
- Reconexión automática con backoff (250ms → 500 → 1000 → máx 3s). Re-incluir token en la URL.
- 1 sola conexión activa; si llega otra con token válido, la nueva reemplaza a la vieja.
- Si el daemon responde `401` al preflight `/api/auth`, la PWA detiene la
  reconexión y pide reescanear el QR. Una caída de red sí conserva el backoff.
- Al desconectar o reemplazar una sesión el daemon libera todos los slots MT,
  botones y teclas pendientes. Un contador de generación + mutex descarta frames
  que todavía estén en el read loop de la conexión vieja.
- Los mensajes tienen límites de tamaño/campos (frame ≤64 KiB, texto ≤8 KiB,
  hasta 5 contactos y 4 modificadores); coordenadas fuera de 0..1 y acciones
  desconocidas se descartan sin inyectar.
- Text/Special/Combo/Touch pasan por una FIFO única para no reordenar un paste
  lento frente a una tecla o un frame táctil.

## 7. Pairing (QR + token)

- Al arrancar, el daemon: detecta su IP de LAN, **carga o genera** un token (≥16 bytes, base64url)
  y muestra un QR con `https://<ip>:<puerto>/?token=<token>` (terminal + vista `/pair`).
- **Pairing persistente** (`internal/pairing`): el token se guarda en `~/.config/phonepad/pairing.json`
  (0600) y **se reusa entre reinicios** del daemon. Así el acceso directo del cel no muere al
  reiniciar. Comparación de token en tiempo constante (`subtle.ConstantTimeCompare`). `Rotate()`
  revoca (token nuevo + des-emparejado) si el QR se filtra.
- Rotación operativa: detener el servicio, ejecutar `phonepad --rotate-token` y
  volver a iniciar. El CLI no imprime el secreto; el siguiente arranque muestra
  el QR nuevo y ninguna sesión vieja queda autorizada.
- La PWA lee el token de la query, lo **guarda en `localStorage`** y **lo limpia de la URL**
  (`history.replaceState`, para no dejar la credencial en el historial). El ícono PWA abre
  `start_url` SIN token y **reusa el guardado** → conecta sin re-escanear. Sin token guardado,
  muestra un mensaje accionable.
- El daemon marca "emparejado" tras el primer handshake válido (`MarkPaired`); `/api/pair-info`
  expone `paired` (lo usa el toggle para no reabrir `/pair` en cada arranque).
- El server sirve la PWA siempre; el **WS** es el que exige token (valida antes del upgrade).
- Lib QR sugerida: `github.com/skip2/go-qrcode` (tiene salida a string/half-blocks para terminal)
  o equivalente que renderice ASCII/UTF-8 en consola.

## 8. Secure-context (HTTPS con cert self-signed)

Servimos por **`https://<ip-lan>`** con un cert self-signed persistido en `~/.config/phonepad`
(`internal/tlscert`). Esto da **secure-context**, que desbloquea: micrófono (Web Speech /
`getUserMedia`), service worker, PWA instalable. El WS va por `wss://` (mixed-content obliga: una
página `https` no puede abrir un WS plano).

Costo: la **primera** vez el navegador (cel y laptop) avisa que el cert no es de confianza →
"Avanzado" → "Continuar". Es esperado (cert casero); se acepta una vez por dispositivo.

## 9. Estructura del repo

```
phonepad/
  SPEC.md                       ← este archivo
  daemon/
    go.mod                      ← module phonepad/daemon (go 1.26)
    main.go                     ← flags, arranca server, imprime QR
    internal/
      input/                    ← wrapper de uinput (interfaz + impl bendahl/uinput)
        input.go                ← type Injector interface { Move/Button/Scroll/Text/Special/Combo/Gesture/Touch }
        input_test.go           ← tests de mapeo (con un Injector fake/mock)
      server/
        server.go               ← http (sirve web/) + ws + token + ruteo de mensajes
        protocol.go             ← structs de los mensajes (§3) + (de)serialización
        protocol_test.go        ← tests de parseo del protocolo
    web/                        ← PWA (embebida con //go:embed)
      index.html
      style.css
      app.js                    ← gestos, teclado, WS client
  setup/
    99-phonepad-uinput.rules    ← regla udev
    setup.sh                    ← instala regla, carga módulo, agrega al grupo input (sudo)
```

## 10. Setup (preparación de la máquina)

1. **Go**: instalado en `~/.local/go` (go1.26.3). Usar `~/.local/go/bin/go` o exportar PATH inline.
2. **uinput**: `/dev/uinput` es `root:root 0600` y el usuario no está en grupo `input`.
   `setup/setup.sh` (requiere sudo) debe:
   - `modprobe uinput` + asegurar carga en boot (`/etc/modules-load.d/uinput.conf`).
   - instalar `setup/99-phonepad-uinput.rules` → `/etc/udev/rules.d/` con
     `KERNEL=="uinput", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"`.
   - `usermod -aG input $USER` (requiere re-login para tomar efecto).
   - `udevadm control --reload-rules && udevadm trigger`.
   - instala `wl-clipboard` (lo necesita el texto Unicode; §4). Si apt no puede
     instalarlo, el script lo advierte: ASCII sigue funcionando y Unicode queda
     pendiente hasta instalar `wl-copy` + `wl-paste`.
3. **Instalación de usuario** (sin sudo): `bash setup/install.sh` compila el binario a
   `~/.local/bin/phonepad`, instala el servicio systemd de usuario y la extensión de GNOME (§13).

## 11. Hitos (orden de implementación)

1. **Tracer-bullet: mover el cursor end-to-end.** PWA mínima (solo superficie que manda `m`) →
   WS → uinput → el cursor se mueve. Valida lo más riesgoso: permisos uinput en Wayland + latencia real.
2. Click + drag (tap, tap-and-a-half) y click derecho.
3. Scroll de 2 dedos (natural).
4. QR + token (reemplaza IP a mano).
5. Teclado: texto + especiales.
6. Modificadores sticky + drawer.
7. Reconexión + keepalive + pulido de sensibilidad.

Verificación de cada hito: evidencia real (cursor que se mueve / texto que aparece), no vibes.

## 12. Vista de pairing (`/pair`)

Página servida por el daemon (no es la PWA) para emparejar desde la propia laptop:

- `GET /pair` → HTML con el QR grande (`/qr.svg`, SVG vectorial de la misma `pairURL`).
- `GET /events` → canal **SSE**: snapshot de estado + transiciones (`client_connected` /
  `client_disconnected`) + heartbeat. La vista muestra "conectado" en vivo.
- `GET /api/pair-info` → JSON `{url, ip, port, paired}` (texto legible + estado de emparejado),
  **sin el token**.

Estas cuatro rutas son solo para la laptop: el daemon exige una dirección
loopback y responde `403` a clientes de la LAN. La PWA remota solo usa `/` y
`/ws`; `/api/auth` recibe el token en el header `Authorization: Bearer …` y
responde `204`/`401` sin devolver la credencial.

## 13. Arranque y toggle (setup express)

Objetivo: prender phonepad y entrar desde el cel **sin terminal**, estilo Caffeine.

- **Servicio systemd de usuario** (`setup/phonepad.service` → `~/.config/systemd/user/`): corre el
  binario sin terminal. Lifecycle **on-demand** vía el toggle (`systemctl --user start/stop`); no se
  habilita al boot por defecto (off = no corre nada). `install.sh` importa
  `WAYLAND_DISPLAY`/`XDG_RUNTIME_DIR` antes de reiniciar el servicio, para que
  `wl-copy` (texto Unicode) vea el display. Si falta `wl-clipboard`, ASCII sigue
  funcionando y el instalador deja una instrucción explícita para completarlo.
- **Extensión GNOME** (`setup/gnome-extension/phonepad@local`, GNOME 50/ESM): `QuickToggle` en Quick
  Settings. Estado derivado de `systemctl --user is-active` (sync con cualquier vía). Al prender:
  `start` + abre `/pair` en el navegador **solo si `paired=false`** (lee `pairing.json`). Al apagar:
  `stop`. En Wayland, habilitar una extensión nueva requiere **un logout/login** (limitación del
  compositor, una sola vez).
- **Flujo diario**: tap toggle → (1ª vez) escaneás el QR de `/pair` y "Agregar a inicio" en el cel →
  después, tap en el ícono PWA → conectado (token persistente, §7). Toggle off → nada corre.
