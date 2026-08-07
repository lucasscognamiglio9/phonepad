# phonepad — diagnóstico de bugs + roadmap de mejoras

> Generado por una sesión de fan-out de agentes (2 diagnóstico + 4 dimensiones de mejora).
> Hallazgos verificados contra el código y el entorno real (GNOME/Wayland, uinput accesible).

## Estado de este diagnóstico

Este documento conserva la investigación histórica, pero esta tabla es la
fuente rápida del estado actual (2026-08-03):

| Área | Estado actual |
|---|---|
| Texto Unicode | ✅ híbrido ASCII por keycodes + Unicode por `wl-copy`; el worker FIFO `asyncText` evita bloquear el read loop |
| Transporte | ✅ `Parse` limita frames/deltas/contactos/mods; read deadline de 15 s + watchdog Ping/Pong (5 s/3 s) limpian sesiones half-open |
| Pairing | ✅ token persistente en `pairing.json` (0600), comparación constant-time, rutas loopback, `/api/auth`, rotación por CLI |
| Setup | ✅ importa el entorno Wayland antes del restart y advierte si faltan `wl-copy`/`wl-paste` |
| Evidencia física | ⚠ pendiente probar en una sesión GNOME/Wayland real: cursor, gestos, Unicode, micrófono y reconexión con el celular |

El camino híbrido y el keepalive ya están implementados; las limitaciones de
GNOME Terminal, `wl-clipboard` sin sesión Wayland y Web Speech API siguen
vigentes. Para contrato y pasos actuales usar [README](../README.md),
[SPEC](../SPEC.md) y [verificacion.md](verificacion.md).

## TL;DR histórico

- ✅ **El diagnóstico histórico de texto quedó resuelto.** `wtype` no funciona en GNOME porque Mutter no implementa `zwp_virtual_keyboard_v1`; phonepad usa ahora keycodes US para ASCII y clipboard-paste para Unicode. El worker FIFO también mantiene orden entre texto, teclas y touch.
- ⚠ **El dictado depende todavía de Web Speech API.** HTTPS/WSS habilita el micrófono y el texto reconocido entra por el camino corregido, pero Chrome/Edge + servicio remoto de STT siguen siendo limitaciones. STT local con whisper.cpp continúa como trabajo futuro.

---

## 1. Bug de texto — causa raíz CONFIRMADA

| | |
|---|---|
| Síntoma | No se puede escribir texto desde el cel; teclas especiales/combos sí andan |
| Causa raíz | `input.go:Text()` → `exec.Command("wtype", ...)`; `wtype` necesita `zwp_virtual_keyboard_v1`; GNOME Mutter no lo implementa |
| Evidencia | `wtype "x"` → `"Compositor does not support the virtual keyboard protocol"`, exit 1. `XDG_CURRENT_DESKTOP=ubuntu:GNOME`, Wayland |
| Por qué lo demás anda | Special/Combo/Gesture van por `d.kbd.KeyPress` (bendahl/uinput → /dev/uinput, kernel-level, independiente del compositor) |
| `bendahl/uinput` ¿ayuda? | No: solo expone `KeyPress/KeyDown/KeyUp(int)` sobre scancodes; el char final lo decide el keymap XKB del sistema |

### Opciones evaluadas

| Opción | Unicode | Deps nuevas | Veredicto |
|---|---|---|---|
| **Híbrido ASCII-keycode + clipboard-paste** | ✅ completo | ninguna (`wl-copy`/`wl-paste` ya están) | ✅ **recomendada** |
| Clipboard-paste puro | ✅ completo | ninguna | clobberea clipboard en cada tecleo; `Ctrl+V` varía por app |
| `ydotool` | ❌ mismo límite de layout | paquete + daemon `ydotoold` | descartada (no resuelve Unicode) |
| IBus codepoint (`Ctrl+Shift+U`) | parcial | — | frágil entre apps; descartada |

> Nota técnica: la idea de "subir un keymap XKB propio sobre uinput" **no es viable** — eso es exactamente lo que hace el virtual-keyboard protocol (ausente en GNOME). uinput solo emite scancodes. Por eso el clipboard es el camino pragmático para Unicode arbitrario.

### Boceto del fix (input.go + keymap.go)

```go
func (d *uinputDevice) Text(s string) {
    var buf []rune // acumula no-ASCII contiguos
    flush := func() { if len(buf) > 0 { d.pasteUnicode(string(buf)); buf = buf[:0] } }
    for _, r := range s {
        if code, shift, ok := runeToKey(r); ok { // runeToKey YA existe (usado en Combo)
            flush()
            if shift { d.kbd.KeyDown(uinput.KeyLeftshift) }
            d.kbd.KeyPress(code)
            if shift { d.kbd.KeyUp(uinput.KeyLeftshift) }
        } else {
            buf = append(buf, r)
        }
    }
    flush()
}

func (d *uinputDevice) pasteUnicode(frag string) {
    saved, _ := exec.Command("wl-paste", "-n").Output()
    c := exec.Command("wl-copy"); c.Stdin = strings.NewReader(frag); c.Run()
    d.kbd.KeyDown(uinput.KeyLeftctrl); d.kbd.KeyPress(uinput.KeyV); d.kbd.KeyUp(uinput.KeyLeftctrl)
    time.Sleep(40 * time.Millisecond) // dejar consumir el paste antes de restaurar
    r := exec.Command("wl-copy"); r.Stdin = bytes.NewReader(saved); r.Run()
}
```

⚠ **Decisión a resolver antes de implementar:** el atajo de pegar varía (`Ctrl+V` en GUI vs `Ctrl+Shift+V` en GNOME Terminal/VTE). Para el MVP: `Ctrl+V` y documentar el límite en terminales; a futuro, detección de app.

### Verificación

1. Automatizado: `go test ./...`, `go test -race ./...`, `go vet ./...` y `go build ./...`.
2. Físico pendiente: en una sesión GNOME/Wayland con `/dev/uinput` y `wl-clipboard`, dictá/escribí `café ñoño 🚀` en un editor GUI y confirma cursor, teclas y foco.
3. En GNOME Terminal el paste Unicode requiere `Ctrl+Shift+V`; el límite está documentado, no es una regresión del transporte.

---

## 2. Bug de micrófono — dos fallas en cadena

| Capa | Estado |
|---|---|
| **1. Acceso al mic (secure-context)** | ✅ Ya OK: `main.go` sirve `https://` + `wss://` con cert self-signed (`tlscert.go`). `window.isSecureContext` es true tras aceptar el cert. |
| **2. Inyección del texto reconocido** | ✅ El final va por `{t:"k",a:"text"}` y usa el camino híbrido corregido; falta validar físicamente dictado + foco en una sesión GNOME real. |

Limitaciones residuales del Web Speech API (independientes del fix): solo Chrome/Edge, **rutea audio a Google** (necesita internet — contradice "todo por LAN"), no anda en Firefox/iOS.

### Recomendación por fases

1. **Arreglar `Text()`** (sección 1) → recupera teclado **y** dictado-en-Chrome. Causa raíz compartida.
2. **STT server-side (opcional, fase 2):** `MediaRecorder` en el cel → POST `/stt` → `whisper.cpp` local → inyecta por `Text()`. Independiza de Google/Chrome, funciona offline y cross-browser. Costo: deps pesadas (`ffmpeg` + modelo whisper, hoy no instalados) y latencia batch (no streaming). Hacerlo **opt-in** con fallback al Web Speech actual.

---

## 3. Mejoras priorizadas (best practices)

### Quick wins — alto valor / bajo esfuerzo

| Mejora | Dim | Impacto/Esf | Por qué |
|---|---|---|---|
| **Media keys** (vol/play/brillo) como fila fija | producto | alto/S | Caso de uso #1 (control de sala). `specialKeys` + 6 botones. Keys globales en Linux, no necesitan foco. |
| **Modo presentación** (◀▶ PageUp/Down gigantes) | producto | alto/S | Reusa specials existentes + `MoveTo` absoluto que ya existe. |
| **Read deadline + watchdog Ping/Pong** | transporte | ✅ implementado | Read idle deadline (15 s) y pings de control (5 s/3 s) cierran half-open y pasan por `Reset`; cobertura con tests WS reales. |
| **Clamp de dx/dy y scroll** | transporte | ✅ implementado | `Parse` limita deltas, scroll, frame, texto, contactos, coordenadas y modificadores antes de rutear. |
| **Token constant-time + pairing seguro** | seguridad | ✅ implementado | `subtle.ConstantTimeCompare`, `history.replaceState`, rutas loopback, `/api/auth` y `--rotate-token`; el token sigue en la query del handshake por contrato WS. |
| **Sync de portapapeles cel↔laptop** | producto | medio/S | Resuelve "pasarme un link". `wl-copy`/`wl-paste`, mismo patrón que el fix de texto. |
| **Middle-click** (tap 3 dedos, hoy no-op) | cliente | bajo/S | `btn:"m"` ya está en el protocolo/server pero el cliente nunca lo emite. |
| **Métrica de RTT** reusando ping/pong | transporte | medio/S | Convierte "JSON en LAN alcanza" (asunción del SPEC) en dato observable. |

### Inversiones de fondo — alto valor / esfuerzo medio-alto

| Mejora | Dim | Impacto/Esf | Por qué |
|---|---|---|---|
| **Desacoplar `Text()` del read loop** (worker + channel) | transporte | ✅ implementado | `NewAsyncText` procesa una FIFO única (Text/Special/Combo/Gesture/Touch) y un epoch descarta operaciones viejas al reset. |
| **Macros configurables** (`~/.config/phonepad/config.toml`) | producto | alto/M | Hoy todo hardcodeado; recompilás para customizar. `ParseKeyCombo` (keycombo.go) ya parsea `ctrl+alt+t`. La PWA renderiza botones desde `/api/config`. |
| **Sensibilidad ajustable** (SENS/scroll en Settings + localStorage) | cliente | alto/M | El propio SPEC §5 dice "ajustable luego"; hoy es const. |
| **Extraer módulo `auth`/`pairing`** | seguridad | ✅ implementado | `internal/pairing` encapsula persistencia 0600, comparación constant-time, estado paired y `Rotate`; queda pendiente solo la operación física de re-pair. |
| **Unificar phonepad + computer-mcp** (un binario, un dueño de uinput) | producto | alto/L | `computer-mcp` es throwaway que ya absorbió `AbsInjector`; hoy dos procesos pelean por `/dev/uinput`. Convierte phonepad en "plano de control humano+IA". |
| **STT server-side (whisper.cpp)** | producto | medio/L | Dictado privado/offline/cross-browser (ver sección 2). |

### Nice-to-have / evaluar (no bloquean el camino actual)

- Drag-lock opcional, auto-repeat en flechas, a11y de teclas (operables por teclado/AT), indicador de modificadores armados con sheet cerrado.
- Pinch nativo ya llega a la app activa mediante el touchpad MT; no reintroducir un clasificador de `pinch-zoom` en la PWA.
- PWA instalable y rotación de token por CLI ya están implementadas; quedan rate-limiting de `/ws` y, si se desea, una señal en caliente para rotación.
- Perfiles por app: **diferir** — en Wayland requiere extensión de GNOME Shell; hacerlo como selección manual, no automática.

### Decisiones a NO tomar (anti-scope-creep)

- **No migrar a binario** (JSON ~25 B/msg, coalescing ya correcto en `MoveQueue`) salvo que el RTT medido lo exija.
- **No habilitar multi-cliente** (invariante deliberada; el Injector es recurso único).
- **No invertir en sandbox de uinput** (no hay frontera de privilegio que cruzar en este modelo; la barrera real es red+token).
- **Modo gamepad:** empuja el límite "baja latencia" — solo para emuladores/juegos lentos, no competitivo.

---

## 4. Deuda de documentación y evidencia

- ✅ SPEC, CONTEXT y ADRs ya reflejan HTTPS/WSS, Touch frames, pinch nativo,
  pairing persistente y el estado de sesión/keepalive.
- ⚠ La evidencia pendiente es física, no documental: aceptar el certificado en
  un teléfono, verificar cursor/tap/scroll/swipe/pinch en GNOME, Unicode en un
  editor GUI, micrófono y recuperación después de cortar Wi‑Fi. Los tests no
  necesitan hardware y cubren el contrato, parser, FIFO, pairing y liveness.
