# P04.7: fixture de movimiento del touchpad

Estado: las cuatro variantes legacy/isotrópicas y las dos cuadradas se
ejecutaron en dos laboratorios aislados el 20/09/2026. No declara pasadas
humanas, recorrido de cursor físico ni cierre de P04.7-P04.9.

## Alcance

Este bloque mide el movimiento que entrega libinput para cuatro variantes de
entrada de referencia y dos casos de geometría cuadrada, todos medidos:

- `current-portrait`: reproduce `mapTouchToContact` con una vista 390 x 844 y
  el touchpad virtual existente de 100 x 70 mm a 28 unidades/mm.
- `current-landscape`: reproduce la misma función con 844 x 390 y el mismo
  dispositivo virtual.
- `isotropic-portrait` y `isotropic-landscape`: conservan X→X e Y→Y, envían
  `x/W` e `y/H`, y declaran una geometría por orientación con una ganancia
  isotrópica constante `g = 100/844 mm por punto`. La instancia tiene
  `P_x = g*W` y `P_y = g*H`, con resolución 28 y rangos enteros redondeados.
- `square-portrait` y `square-landscape`: usan un touchpad virtual de 100 x
  100 mm, resolución 28 y `g = 100/844 mm por punto`. El teléfono ocupa un
  subrectángulo centrado sin saturación:

  ```text
  X = (100 - gW) / 200 + g*x / 100
  Y = (100 - gH) / 200 + g*y / 100
  ```

  Estos casos miden el candidato de marco fijo con un dispositivo nuevo por
  caso. Todavía no prueban la transición de orientación sobre una misma instancia.

La propuesta isotrópica no multiplica posiciones normalizadas ni las recorta
después. El cambio de tamaño físico ocurre al crear el dispositivo uinput. No
es una decisión de producto: es una referencia que permite medir si la
invariancia X/Y cambia el movimiento observado.

Cada geometría ejecuta ocho trazas de un dedo: X e Y, sentidos positivo y
negativo, a 20 ms por frame (`slow`) y 8 ms por frame (`comfortable`). Cada
traza recorre 0,10 a 0,90 en 32 pasos, espera 50 ms después del contacto y
120 ms después del lift. Es una cadencia controlada para separar recorrido de
latencia de red.

## Aislamiento y orden de admisión

`daemon/internal/input/touchpad_motion_integration_test.go` se salta si no se
define `PHONEPAD_P04_MOTION_FIXTURE_DIR`. Con la variable definida, crea un
directorio `run-<nanosegundos>` y un subdirectorio por geometría. Cada caso
crea un dispositivo nuevo con `newMTTouchpadWithGeometry` y conserva
`newMTTouchpad()` como wrapper de los valores originales `2800 x 1960`,
resolución 28.

El test escribe el nodo y el nombre de sistema en `device.json`, pero no emite
contactos todavía. Arranca `tools/refactor/p04_motion_observer.py`. El
observador valida el nombre `phonepad-touchpad`, el nodo bajo
`/sys/devices/virtual/input` y la correspondencia `/dev/input/event*`.
`open_restricted` rechaza cualquier otro path y aplica `EVIOCGRAB`. Solo
después de que libinput abrió y tomó en exclusiva el nodo crea `start`. El
productor espera ese archivo antes de emitir el primer frame.

El observador no abre dispositivos físicos, no usa el compositor del usuario y
no cambia perfiles de libinput. Lee el perfil actual, el perfil predeterminado
y los perfiles disponibles para la fixture. Cada movimiento guarda:

```json
{
  "stage": "x-positive-comfortable",
  "timeUsec": 123,
  "dx": 1.2,
  "dy": 0,
  "dxUnaccelerated": 0.8,
  "dyUnaccelerated": 0
}
```

`dx` y `dy` son los valores acelerados de libinput; los campos terminados en
`Unaccelerated` son la referencia sin aceleración para el mismo evento. El
observador no llama a ningún setter de aceleración. El perfil del host queda
intacto y la evidencia deja registrado si la fixture anuncia un perfil plano o
adaptativo.

La API de libinput interpreta `dx/dy` como movimiento de un mouse
estandarizado en píxeles y los valores no acelerados como coordenadas crudas
del dispositivo, sujetas a su resolución. La referencia primaria es
[Pointer events](https://wayland.freedesktop.org/libinput/doc/latest/api/group__event__pointer.html).
Por eso la ganancia geométrica se calcula con `dxUnaccelerated / 28` en mm;
`dx/dy` se conserva en las unidades de salida de libinput y no se convierte
como si fueran mm.

## Ejecución

La prueba necesita un `/dev/uinput` autorizado y `libinput.so.10`. Se puede
ejecutar desde el módulo Go:

```sh
cd /home/luque/Documents/Codex/2026-09-15/https-github-com-peetzweg-opendisplay-mir/work/phonepad-refactor/daemon
PHONEPAD_P04_MOTION_FIXTURE_DIR=/tmp/phonepad-p04-motion \
PHONEPAD_REPO_ROOT=/home/luque/Documents/Codex/2026-09-15/https-github-com-peetzweg-opendisplay-mir/work/phonepad-refactor \
go test ./internal/input -run '^TestNativeTouchpadMotionFixture$' -count=1 -v
```

La ejecución conservada en este checkout terminó correctamente bajo un límite
de 240 segundos y 4 GiB de memoria virtual:

```text
=== RUN   TestNativeTouchpadMotionFixture
--- PASS: TestNativeTouchpadMotionFixture (22.52s)
PASS
```

La evidencia queda en
`outputs/p04/motion-lab-capped/run-1789894509520582846/summary.json`. Los cuatro
casos informaron `exclusiveGrab: true`, perfil actual y predeterminado `2`,
`availableProfiles: 7` (la máscara de bits `0b111`, no siete perfiles) y
`profileChanged: false`. No se produjo un `observer-error.json`.

Para ejecutar solamente los dos casos nuevos, el filtro opcional conserva el
resto de la prueba sin repetir mediciones anteriores. Este comando está
preparado para el laboratorio autorizado y no se ejecutó durante esta revisión:

```sh
cd /home/luque/Documents/Codex/2026-09-15/https-github-com-peetzweg-opendisplay-mir/work/phonepad-refactor/daemon
GOCACHE=/tmp/phonepad-refactor-go-cache GOPROXY=off \
PHONEPAD_P04_MOTION_FIXTURE_DIR=/tmp/phonepad-p04-square \
PHONEPAD_P04_MOTION_CASES=square-portrait,square-landscape \
PHONEPAD_REPO_ROOT=/home/luque/Documents/Codex/2026-09-15/https-github-com-peetzweg-opendisplay-mir/work/phonepad-refactor \
/home/luque/Documents/Codex/2026-09-08/phonepad/work/runtime/go/bin/go \
test -mod=vendor ./internal/input -run '^TestNativeTouchpadMotionFixture$' -count=1 -v
```

El límite del observador es de 60 segundos por caso y el test conserva los
archivos aunque un caso falle. `summary.json` reúne las respuestas válidas.
Cada caso también deja `device.json`, `traces.json`, `observer.log` y
`motion.json`; un fallo de identidad, `EVIOCGRAB`, libinput o timeout deja
`observer-error.json`. La prueba falla ante esos errores y no los convierte en
datos de movimiento.

## Qué se puede concluir

La salida permite comparar por caso la suma de `dx/dy`, su versión sin
acelerar, el tiempo entre eventos y el sentido de cada traza. Permite medir
la ganancia real del dispositivo virtual bajo dos velocidades y comprobar si
la geometría isotrópica mantiene la relación de mm por punto al girar.

En la salida observada de las cuatro variantes ya medidas, la mediana de la
ganancia no acelerada sobre las trazas fue:

| Caso | X, mm/punto | Y, mm/punto |
| --- | ---: | ---: |
| current portrait | 0,080 | 0,079–0,080 |
| current landscape | 0,115 | 0,115 |
| isotropic portrait | 0,115 | 0,111–0,115 |
| isotropic landscape | 0,115 | 0,111–0,115 |

El mapeo actual cambia la ganancia X aproximadamente 1,43 veces al girar. La
propuesta isotrópica conserva cerca de 0,115 mm por punto en ambos ejes y
orientaciones, dentro de la variación de cuantización y del primer/último
evento de cada traza. En las trazas X positivas de landscape, por ejemplo, la
salida acelerada acumuló `812,3386779` píxeles estandarizados a velocidad
lenta y `1636,2532921` a velocidad cómoda, mientras el movimiento no
acelerado fue `2170` unidades del dispositivo en ambas trazas. Esos valores
acelerados no se dividen por la resolución: solo la suma no acelerada se
convierte a mm (`2170 / 28 = 77,5 mm`). Esto confirma que la velocidad forma
parte de la política de libinput; no autoriza a añadir otra curva en PhonePad.

El análisis reproducible del archivo conservado se ejecuta sin crear otro
uinput ni consultar un dispositivo físico:

```sh
PHONEPAD_P04_MOTION_SUMMARY=/home/luque/Documents/Codex/2026-09-15/https-github-com-peetzweg-opendisplay-mir/work/phonepad-refactor/outputs/p04/motion-lab-capped/run-1789894509520582846/summary.json \
go test ./internal/input -run '^TestP04MotionEvidence' -count=1 -v
```

Para cada caso y traza, `analyzeP04MotionReport` exige las ocho etapas, al
menos un evento por etapa, signo correcto en el eje esperado y una componente
perpendicular dentro del 1% (con mínimo de una unidad). El log identifica cada
línea como `case/stage`. Calcula `rawMM` como
`abs(sum(axisUnaccelerated)) / resolution` y `mmPerPoint` como `rawMM /
(abs(end-start) * viewportAxis)`. La salida acelerada queda en las unidades
de píxeles estandarizados de libinput y no entra en esa conversión.

La prueba pura `TestP04SquareCenteredMapper` comprueba offline las cuatro
esquinas, monotonicidad de ambos ejes, márgenes centrados, ganancia de 100
puntos y ausencia de saturación para portrait y landscape. Bitácora de esta
revisión:

```text
=== RUN   TestP04SquareCenteredMapper
--- PASS: TestP04SquareCenteredMapper (0.00s)
```

La segunda ejecución seleccionó solo los dos casos square. Terminó en
11,08 s, con límite externo de 180 s y memoria virtual de 4 GiB. Ambos casos
registraron grab exclusivo, perfil 2 y ningún cambio de perfil. La evidencia
está en `outputs/p04/square-motion-lab/run-1789896079817643851/summary.json`;
los logs son `outputs/p04/square-motion-lab.log` y
`outputs/p04/square-motion-analysis.log`.

| Caso | Mediana X, mm/punto | Mediana Y, mm/punto |
| --- | ---: | ---: |
| square portrait | 0,114812 | 0,112930 |
| square landscape | 0,114781 | 0,114812 |

La diferencia de ganancia X entre orientaciones fue aproximadamente 0,03% en
esta ejecución. En Y fue aproximadamente 1,7%. El análisis validó las ocho
trazas de cada caso y rechazó una copia incompleta. Esta evidencia respalda
la invariancia geométrica del candidato; todavía no elige su ganancia final.

Las trazas recorren una fracción del viewport en el mismo tiempo, por lo que
portrait y landscape no tienen la misma velocidad en puntos por segundo. No
comparar directamente sus sumas aceleradas como una prueba de respuesta a
velocidad idéntica. La siguiente calibración debe usar también distancia y
velocidad lógicas iguales, un cursor observable y blancos pequeños.

No permite afirmar cuántas pasadas necesita una persona ni dónde termina el
cursor en una pantalla física. Tampoco mide una pantalla, un compositor o una
sesión iPhone. P04.7 todavía necesita una ventana privada con un cursor
observable para contar recorridos y la matriz física de P04.9. Ninguna salida
del fixture debe usarse como aceptación de la meta de una a dos pasadas.

Archivos de este bloque:

- `daemon/internal/input/touchpad_linux.go`: seam privado de geometría; los
  defaults de producción no cambian.
- `daemon/internal/input/touchpad_motion_integration_test.go`: casos, trazas,
  admisión y preservación de evidencia.
- `tools/refactor/p04_motion_observer.py`: identidad, grab exclusivo y
  lecturas de libinput.
- Este documento.

La validación anterior incluye `python3 -m py_compile` del observador,
formateo y compilación focal del paquete Go con el runtime privado y la
ejecución opt-in de cuatro casos en 22,52 s. La segunda añadió dos casos
cuadrados reales en 11,08 s, la prueba pura y el análisis de su evidencia. No se tocaron perfiles globales,
dispositivos físicos ni la configuración del usuario.
