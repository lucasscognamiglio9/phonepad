# ADR 0005 — Touchpad de precisión emulado (paridad total de gestos)

Estado: aceptado · Fecha: 2026-06-02 · Supersede a [ADR 0004](0004-pinch-zoom-via-magnifier-gnome.md)

## Contexto

El principio fundacional de phonepad (SPEC §2) era: **"el cliente clasifica
gestos; el server solo inyecta 1:1"**. El cliente detectaba tap/scroll/pinch/swipe
y mandaba intenciones discretas (`m`, `s`, `g`), y el daemon las traducía a eventos
uinput crudos (`EV_REL`, combos de teclas).

Ese modelo nunca puede dar **animaciones progresivas** (overview que sigue al dedo,
scroll con inercia, pinch continuo): GNOME anima esos gestos solo cuando los recibe
de libinput como gestos nativos de touchpad, y libinput solo genera gestos a partir
de un **touchpad** real (no de eventos `EV_REL` ni de un touchscreen). El usuario
pidió paridad total: "exactamente los mismos gestos y animaciones que el touchpad
de la laptop".

Investigación previa (3 agentes, ver handoff `touchpad-precision`):

- El discriminante touchpad-vs-touchscreen en libinput/udev es **una sola cosa**:
  NO declarar `INPUT_PROP_DIRECT`. Con `BTN_TOOL_FINGER` + ejes ABS + sin stylus +
  sin `INPUT_PROP_DIRECT` → libinput lo clasifica touchpad y emite `GESTURE_*`.
- La lib vendoreada `bendahl/uinput` no alcanza: usa el path legacy (sin
  resolución, sin `UI_ABS_SETUP`/`UI_SET_PROPBIT`, sin `BTN_TOOL_*`).
- uinput **descarta el timestamp de userspace** y lo sella el kernel en el `write()`;
  los timeouts de clasificación de libinput se miden contra ese timestamp.
- Sin precedente empírico: ningún proyecto "phone-as-touchpad" lo hizo con gestos
  nativos. Por eso hay un **Paso 0** de validación que gatea todo.

## Decisión

**Invertir el principio:** el daemon se presenta ante el SO como un **touchpad de
precisión multitouch emulado** (uinput, protocolo MT Type B) y **libinput/GNOME
clasifican los gestos nativamente**. El cliente deja de clasificar: se vuelve un
**forwarder de [[contacto]]s crudos**.

Decisiones concretas (las de usuario, grilladas; las de implementación, por mejores
prácticas):

- **Paridad pura (usuario).** El feel (velocidad, aceleración, sentido de scroll,
  tap-to-click, click derecho de 2 dedos) lo hereda **entero de la config de
  touchpad de GNOME**. Se elimina el `SENS`/`SCROLL_SIGN` del cliente. El cursor del
  cel se siente idéntico al touchpad físico.
- **Pinch → zoom de la app (usuario).** Como el touchpad físico: GNOME no captura
  el pinch, va a la app activa. Se revierte el magnifier habilitado a mano y se
  supersede el ADR 0004.
- **Naive-first, mínima latencia (usuario: "máxima velocidad").** El daemon escribe
  a uinput **al recibir** cada frame (sin buffering). El loop resampler a Hz fijo
  (que agregaría latencia) queda como **último recurso**, solo si el Paso 0
  demuestra que el jitter de WiFi rompe la clasificación.
- **Protocolo snapshot (impl).** Mensaje nuevo `{"t":"t","c":[{id,x,y},…]}` = todos
  los contactos vivos en el frame; el lift se nota por ausencia del `id`. Seguro
  sobre WebSocket (TCP: ordenado, sin pérdida). Coordenadas **normalizadas 0–1**; el
  daemon escala al rango lógico del device.
- **Device por ioctls a mano (impl).** Se escribe la secuencia exacta de ioctls con
  `golang.org/x/sys/unix` en un archivo nuevo de `internal/input` (declarando
  `UI_ABS_SETUP`/`UI_SET_PROPBIT`, que ni `x/sys/unix` ni el vendor exponen). No se
  forkea el vendor: parchear una dep vendoreada para el camino crítico es frágil.
- **`Touch([]Contact)` en la interface `Injector` (impl).** Se evaluó una
  interface separada `TouchInjector` (espejando `AbsInjector`), pero el decorator
  `asyncText` **embebe `Injector`**: con `Touch` en otra interface no se promovería
  y el type-assert fallaría. Poniéndolo en `Injector`, `asyncText` lo promueve como
  pass-through 1:1 (lo que queremos: no va por el camino lento del texto). El mismo
  tipo concreto `uinputDevice` implementa todo; en el camino agente (`computer-mcp`,
  sin touchpad MT) `Touch` es no-op, igual que `MoveTo` en el camino relativo. Se
  preserva la intención del ADR (no romper `computer-mcp`) sin el wrinkle.
- **El camino del cel deja de crear el mouse `EV_REL` (impl).** Con el touchpad de
  precisión, tap/click/click-derecho/scroll los da libinput desde los contactos. El
  mouse REL y el camino de gestos discretos (`g`/`gestureCombos`) quedan muertos
  para el cel (siguen vivos para `computer-mcp`, que tiene su propio device).

## Consecuencias

- (+) Animaciones progresivas nativas: overview/workspaces que siguen al dedo 1:1,
  scroll con inercia, pinch continuo. Es lo que se pidió.
- (+) Cero código de "feel": se hereda toda la config de GNOME. Tap-to-click y
  click-derecho de 2 dedos salen gratis (los da libinput).
- (+) El cliente se simplifica fuerte: se borra todo el clasificador del módulo
  `Pad` (~300 líneas: mode machine, handleN-fingers, centroid, emitScroll/Zoom).
- (−) Se pierde el control fino del feel desde el cliente (era deseado: paridad).
- (−) Riesgo principal: sin precedente empírico. **Gateado por el Paso 0**
  (`libinput debug-events` debe reportar `GESTURE_*` desde el device virtual). Si el
  Paso 0 falla, hay que replantear (no hay plan B conocido para forzar gestos).
- (−) Posible necesidad del loop resampler si el jitter de LAN desclasifica gestos
  (se mide en el Paso 0; agrega latencia, contra el objetivo de máxima velocidad).
- (−) SPEC §2 (principio 1:1) y §5 (clasificación en cliente) quedan obsoletos →
  reescribir; §3 suma el mensaje `t`; §4 suma el mapeo MT.
- Alternativa descartada: forkear `bendahl/uinput`. Más magia, dep vendoreada
  frágil, y hay que agregar ioctls que no expone igual.
- Alternativa descartada: seguir incremental sobre el modelo discreto. No puede dar
  animaciones progresivas por diseño — es el problema que este ADR resuelve.
