# Prototype: computer use para Claude (reusando phonepad)

> THROWAWAY. Borrar o absorber a phonepad cuando responda su pregunta.

## Pregunta que responde

¿Sirve la infra de phonepad (uinput) como capa de ejecución para darle "computer use"
a Claude — control de mouse, teclado y screenshots — y cómo se resuelve el gap entre el
movimiento **relativo** de phonepad (`EV_REL`) y las coordenadas **absolutas** que necesita
un agente que mira screenshots?

## Decisiones tomadas (input del usuario)

1. **Modalidad**: computer-use puro (screenshot + click por coordenada), reusando uinput.
   No browser/CDP por ahora. (Branch LOGIC del skill `prototype`.)
2. **Plan Max, NO API key**: el loop no lo corremos nosotros contra `api.anthropic.com`.
   Exponemos un **MCP server** (tools: `screenshot`, `left_click`, `type`, `key`, `scroll`…)
   que **Claude Code consume bajo el plan Max** — Claude Code ya tiene visión (Opus 4.8) y
   maneja el loop gratis. Cero créditos de API, cero beta header de computer-use.
3. **phonepad NO está cerrado**: se puede extender el paquete `internal/input` directamente
   en vez de copiar (p.ej. agregar un injector absoluto).

## Hallazgos del research

- ⚠ **Gap absoluto-vs-relativo**: phonepad usa `uinput.CreateMouse` (EV_REL, `Move(dx,dy)`).
  Un agente da coords absolutas `[x,y]`. **Solución validada en código**: usar
  `uinput.CreateTouchPad(path, name, 0, W, 0, H)` + `MoveTo(x,y)` (EV_ABS). El rango del
  touchpad mapea 1:1 a la resolución del display ⇒ `MoveTo(x,y)` cae en el pixel `(x,y)`.
  El scroll sigue necesitando el `Mouse` (Wheel); el touchpad no scrollea. ⇒ injector con
  **ambos** devices.
- Texto Unicode y teclas: delegar a `wtype` (Wayland), igual que `input.go`. ✓
- Coordenadas: si usáramos la tool nativa `computer` con Opus 4.8 serían 1:1 hasta 2576px de
  lado largo. Con el approach MCP, Claude Code usa **visión genérica** sobre el screenshot —
  hay que medir qué tan preciso es el grounding de píxeles vs la tool dedicada.
- Captura en este entorno (GNOME Wayland): NO hay grim/gnome-screenshot instalados. El MCP
  server necesitará un backend de captura (grim para wlroots, gnome-screenshot, portal D-Bus,
  o scrot en X11). Pendiente de resolver para esta máquina.
- Seguridad: prompt injection desde contenido en pantalla es el riesgo principal; gatear
  acciones mutantes / correr en entorno acotado.

## Estado del artefacto

- `main.go` v1 — modo `repl` (capa de ejecución uinput **absoluta**, validable a mano) ✓ compila.
  El modo `agent` con x-api-key quedó **obsoleto** por la decisión #2 → se reemplaza por MCP.
- Próximo: reescribir como **MCP server stdio** reusando el injector. (Research del SDK Go en curso.)

## Verdict (parcial)

✓ **El approach es viable.** MCP server `cmd/computer-mcp` verificado por handshake stdio:
  negocia protocolVersion 2025-06-18, lista las 9 tools, resuelve 1920x1080→1280x720 q60.
✓ **Gap de coords resuelto**: touchpad EV_ABS con rango = dims de la imagen lógica ⇒ las
  coords de Claude van directo a MoveTo, sin factor de escala ni estado mutable.
✓ **Tolera uinput ausente**: arranca y deja screenshot funcionando; acciones devuelven error.

Pendiente de probar en sesión con grupo `input`:
- ¿El touchpad absoluto da grounding pixel-perfect en multimonitor? (asume monitor único)
- ¿Claude Code clickea con precisión suficiente mirando el JPEG q60 reducido?
- ¿Devolver screenshot tras cada acción (menos round-trips) vs sólo texto (menos tokens)?

## Deuda resuelta (/simplify + absorción a phonepad)
- ✓ Sin `Injector` duplicado: se extendió `internal/input` con `AbsInjector`/`NewAbsolute`/
  `MoveTo` (camino absoluto) y el server lo consume. Reusa Button/Scroll/Text/Combo.
- ✓ Traducción de teclas movida a `internal/input.ParseKeyCombo`, atada a `specialKeys`/
  `runeToKey` y testeada junto al keymap.

## Robustez agregada (ronda de "cubrir casos")
- ✓ Resolución derivada de una **captura real** (`detectRealSize`), no de xrandr → el rango del
  touchpad coincide exacto con lo que ve Claude (elimina el mismatch que corría los clicks en
  monitor único con scaling).
- ✓ Tool `wait` (espera explícita para que la UI reaccione antes del próximo screenshot).
- ✓ `calibrate` en el REPL: recorre esquinas+centro para verificar el grounding a ojo.
- ✓ Screenshot-tras-acción opcional (`COMPUTER_MCP_SHOT_AFTER_ACTION=1`, off por default).

## Pendiente (no cubierto a propósito)
- ✓ **Multimonitor** (resuelto): `detectScreen`/`pickOutput` (vía xrandr) operan en el monitor
  primario por default; el touchpad mapea al escritorio completo y `moveTo` traduce las coords
  del monitor objetivo con offset. `COMPUTER_MCP_OUTPUT=all|<nombre>` para cambiar. La captura
  se recorta al monitor objetivo (`cropToOutput`).
- ⚠ **Captura = portal xdg-desktop** (D-Bus): la 1ª vez GNOME pide permiso (conceder una vez).
- ⚠ **Prompt injection** si se navega la web: sin sandbox; hoy depende del gate de permisos
  por tool-call de Claude Code (se pierde en auto-accept/yolo mode).
- ? Tamaño real del JPEG sin medir contra el techo de 25k tokens (ajustable por env).
- ? Signo de scroll up/down sin verificar en hardware.

## Verificado por handshake
10 tools listadas; build + `go test ./...` + `go vet ./...` verdes. Falta sólo la prueba con
cursor real (requiere grupo `input`) — usar `--repl` + `calibrate`.
