# ADR 0004 — Pinch de 2 dedos → zoom vía la lupa (magnifier) de GNOME

Estado: **superseded por [ADR 0005](0005-touchpad-precision-emulado.md)** · Fecha: 2026-06-02

> Superseded (2026-06-02): con el touchpad de precisión emulado, el pinch va a la
> app (zoom de contenido) como en el touchpad físico, no a la lupa. El cliente deja
> de clasificar pinch. Cutover hecho: el usuario probó el zoom nativo en el cel y lo
> aprobó (paridad pura confirmada), y se revirtió el magnifier habilitado a mano
> (`screen-magnifier-enabled=false`). La lupa de GNOME sigue disponible por teclado.

## Contexto

El usuario quería el zoom de su trackpad: pellizcar con dos dedos y que la
pantalla se vea más grande, sin que cambie el contenido — exactamente la **lupa
de accesibilidad de GNOME** (magnifier), no el zoom de la app (Ctrl+scroll, que
re-renderiza el contenido). Hasta ahora el gesto de 2 dedos sólo hacía scroll;
pinch-zoom estaba listado como no-goal.

Dos problemas a resolver:

1. **Distinguir pinch de scroll**: ambos son 2 dedos. Un scroll mueve los dedos
   en paralelo (el centroide se desplaza, la separación se mantiene); un pinch
   cambia la separación (el centroide queda ~quieto).
2. **Mapear el pinch a un zoom de pantalla real** desde un daemon que sólo inyecta
   eventos uinput crudos (no puede generar gestos de pinch nativos de libinput,
   que es lo que consumiría una app para hacer pinch-zoom propio).

## Decisión

**Cliente — clasificación comprometida.** En `handleTwoFingers`, al superar el
umbral inicial se decide una sola vez: si el cambio de separación entre los dedos
supera al desplazamiento del centroide por un factor `PINCH_BIAS` → `zoom`; si no
→ `scroll`. Comprometerse evita que el jitter alterne entre ambos a mitad del
gesto. En modo zoom se acumula el cambio de separación y se emite un gesto
discreto `{"t":"g","name":"zoom-in"|"zoom-out"}` por cada `ZOOM_DIVISOR` px de
pellizco (separar = in, juntar = out).

**Daemon — mapeo a los atajos del magnifier.** Se reusa el camino de gestos
existente (`gestureCombos` en `internal/input/keymap.go`): `zoom-in` → `Alt+Super+=`
y `zoom-out` → `Alt+Super+-`, que son los atajos por defecto de
`org.gnome.settings-daemon.plugins.media-keys magnifier-zoom-in/out`. El primer
`zoom-in` enciende la lupa si estaba apagada. El daemon no necesitó lógica nueva:
`Combo` ya resolvía mods + tecla (`=`/`-` por `runeToKey`), así que el cambio fue
sólo **datos** (dos entradas en el mapa) + sus aserciones en `TestGestureCombos`.

## Consecuencias

- (+) Es la "lupa" que pidió el usuario: agranda la pantalla entera sin tocar el
  contenido, idéntico al pinch del trackpad físico.
- (+) Cero lógica nueva en el daemon: reusa `g`/`gestureCombos`/`Combo`; el zoom
  queda testeado por el mismo `TestGestureCombos` que el resto de los gestos.
- (+) Scroll y zoom conviven en el mismo gesto de 2 dedos, como un trackpad real.
- (−) El zoom es **discreto** (steps del magnifier), no continuo: no se puede fijar
  un factor arbitrario vía teclas. Para zoom continuo habría que controlar
  `org.gnome.desktop.a11y.magnifier mag-factor` desde la extensión GNOME — más
  acoplamiento, descartado para v1.
- (−) Depende de los atajos por defecto de GNOME y de que la lupa esté permitida.
  Si el usuario los reconfigura, se cambia una línea en `keymap.go`.
- (−) `PINCH_BIAS`/`ZOOM_DIVISOR` son heurísticos; se calibran probando en el cel.
- Alternativa descartada: `Ctrl+scroll` (zoom de la app, no de pantalla) — cambia
  el contenido y no funciona uniforme en todas las apps; no es lo que el usuario
  describió.
