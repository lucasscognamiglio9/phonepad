# P04.5/P04.7: diseño de entrada estable del touchpad

Estado: diseño de continuación, 20/09/2026. Esta revisión es de solo lectura.
No implementa todavía el cambio en el cliente ni en el proveedor Linux y no
cierra P04.7-P04.9.

## Lo que existe hoy

`mobile/src/components/touch-surface.tsx` convierte cada snapshot multitáctil
en coordenadas normalizadas para un touchpad virtual de 100 x 70 mm. Mantiene
la proporción de la vista y centra el espacio sobrante:

```text
s  = min(100 / W, 70 / H)
ox = (100 - W*s) / 2
oy = (70  - H*s) / 2
X  = clamp((ox + x*s) / 100)
Y  = clamp((oy + y*s) / 70)
```

La función conserva todos los bordes de la vista, pero deja parte del
touchpad virtual sin usar cuando la vista es muy alta. Con la fixture
390 x 844, el ancho del teléfono ocupa 32,35 mm virtuales. Con 844 x 390,
el mismo eje ocupa 100 mm. El ancho físico total cambia por un factor de
aproximadamente 3,09; el factor 1,4286 corresponde a la ganancia en mm por
punto, porque también cambia el número de puntos lógicos del eje. La cifra de
cinco pasadas frente a una y media es un reporte de uso, todavía no una
medición instrumental.

La vista cancela la secuencia cuando cambia su layout, el modo, el estado de
la aplicación o la apertura del teclado. Eso evita mezclar contactos con dos
geometrías, pero el siguiente contacto vuelve a calcular `s` con el nuevo
rectángulo. `NativeKeyboard` ocupa una capa absoluta y mueve el compositor;
el sistema operativo todavía puede entregar un cambio de viewport al abrir
el teclado o girar el equipo.

`daemon/internal/input/touchpad.go` conserva snapshots completos, asigna
contactos a cinco slots Type B y envía la ausencia de un identificador como
lift. `touchpad_linux.go` declara un dispositivo indirecto con
`INPUT_PROP_POINTER` y `INPUT_PROP_BUTTONPAD`, rango 0..2800 x 0..1960 y
resolución 28 unidades/mm. No declara `INPUT_PROP_DIRECT`. La escritura
redondea únicamente al rango entero del dispositivo. `Touch` entrega los
contactos a ese dispositivo; la ruta de touch no debe sintetizar `Move`, clic,
scroll ni pinch.

La clasificación de tap, arrastre, scroll, pinch y swipe queda en libinput.
La política de aceleración también pertenece al touchpad del host. La
documentación primaria es [pointer acceleration de libinput](https://wayland.freedesktop.org/libinput/doc/latest/pointer-acceleration.html)
y [touchpad gestures](https://wayland.freedesktop.org/libinput/doc/latest/touchpad-gestures.html).
Agregar una curva de velocidad en PhonePad encima de esa política produciría
dos aceleraciones y cambiaría la comparación con el touchpad físico.

## Primer bloque propuesto

El primer bloque debe cambiar el mapeo geométrico y, cuando el peer lo admita,
la geometría física declarada por el touchpad virtual. Ambas partes se
coordinan antes de comenzar una secuencia. Debe conservar `TouchContact`, los
snapshots ordenados por `id`, el límite de cinco contactos, el camino
`connection.touch` y `CancelTouch`. No introduce un clasificador de gestos,
timestamps inventados ni un canal relativo paralelo.

### Marco de calibración estable

La conversión debe conservar los ejes de pantalla. Un dedo hacia la derecha
debe mover el cursor hacia la derecha, y uno hacia abajo debe moverlo hacia
abajo, también en portrait. Para cada orientación se guarda un marco de touch
completo, con su rectángulo de entrada y sus dimensiones `W_o` y `H_o` en
puntos lógicos. `W_o` y `H_o` son las dimensiones de la superficie antes de
que el teclado reduzca o mueva la vista. El contacto local `(x,y)` se
normaliza dentro de ese rectángulo:

```text
a = x / W_o
b = y / H_o
```

El marco debe distinguir la orientación del dispositivo de un resize por
teclado. Los ejes locales ya siguen los ejes visibles de la pantalla; no se
intercambian X e Y al girar. En la referencia medida por orientación, la
conversión normalizada fue:

```text
X = a
Y = b
```

Esa referencia modificó la geometría física que ve libinput. Para ganancias
constantes `gx` y `gy`, en mm por punto, declaró una instancia por orientación:

```text
P_x(o) = gx * W_o       mm
P_y(o) = gy * H_o       mm
```

### Candidato preferente: cuadrado fijo por sesión

Antes de recrear el uinput en cada giro, se debe medir como candidato
preferente una geometría cuadrada fija para toda la sesión. Sea `P` el lado
físico del cuadrado, elegido de modo que `P >= g * max(W,H)` para las
orientaciones de la sesión, y sea `g` una ganancia isotrópica en mm por punto.
El teléfono ocupa un subrectángulo centrado, mientras el marco del dispositivo
permanece estable:

```text
X = (P - gW) / (2P) + g*x / P
Y = (P - gH) / (2P) + g*y / P
```

Aquí `x` e `y` son las coordenadas lógicas dentro de `W` x `H`. La fórmula
conserva X→X e Y→Y, cubre todos los puntos del teléfono y deja márgenes
virtuales deliberados cuando el subrectángulo no llena el cuadrado. No hace
falta consumir esos márgenes para obtener la ganancia `g`, y no se recrea el
dispositivo al girar. Las esquinas del teléfono se convierten en las esquinas
del subrectángulo; no se aplica `clamp` para ocultar una geometría inválida.

La primera ejecución P04.7 midió cuatro dispositivos por orientación y
variante. Una segunda ejecución probó este cuadrado de 100 mm en ambas
orientaciones y confirmó una ganancia X casi idéntica. Ver las cifras y
limitaciones en `p04-02-motion-lab.md`. Cada caso todavía crea su propia
instancia; falta la transición sobre un único uinput y calibrar recorrido y
precisión antes de elegir `P` y `g`. No cambia los defaults ni se aplica todavía.

### Referencia ya medida: dispositivo por orientación

El primer experimento usó la opción isotrópica `gx = gy = g`, con
`g = 100 / max(W_ref,H_ref)` y la referencia 844 x 390 de la fixture. Así,
390 x 844 declara aproximadamente 46,2 x 100 mm y 844 x 390 declara 100 x
46,2 mm. X y Y conservan sus ejes de pantalla y cada punto tiene la misma
ganancia en ambas orientaciones. La opción mide invariancia y precisión; no
se acepta todavía como tamaño final ni como garantía de una a dos pasadas.

El rango de uinput y su resolución se calculan para que la coordenada 0..1
recorra `P_x(o)` y `P_y(o)` sin saturación. Cambiar esas dimensiones requiere
recrear el dispositivo antes de la siguiente secuencia, porque `UI_ABS_SETUP`
no reconfigura un device ya creado. La generación de orientación cancela la
secuencia anterior, destruye el touchpad anterior y espera la nueva instancia
antes de admitir contactos. La posición remota no se restablece por enviar un
contacto artificial durante esa transición.

No se toma `70 / 390` como ganancia Y del mapeo actual en landscape. El
mapeo actual conserva la proporción y usa `min(100/844,70/390)` para ambos
ejes, dejando margen virtual en Y. Una ganancia anisotrópica sería otro
experimento, no una reproducción del comportamiento existente.

La negociación debe ser aditiva. Un peer nuevo puede anunciar una versión de
geometría, las dos ganancias, la orientación vigente y una generación. Un
peer viejo conserva el device fijo de 100 x 70 mm y el mapeo legacy, sin
pretender invariancia entre orientaciones. Un cliente viejo contra un daemon
nuevo sigue funcionando con esa ruta legacy. No se debe interpretar como
aceptada una geometría nueva hasta que ambos extremos la confirmen.

La referencia por orientación conserva X→X e Y→Y y mantiene `gx` y `gy` al girar, pero cambia el
tamaño físico que libinput asocia con el touchpad. El laboratorio debe verificar
que el cursor no salta al recrear el device y que la aceleración adaptativa no
introduce una diferencia inesperada. Si el cuadrado fijo resulta inaceptable,
la geometría fija legacy de 100 x 70 mm sigue siendo el fallback de
compatibilidad; su ganancia dependiente de la orientación y sus márgenes no
deben presentarse como aceptación del candidato de cobertura completa.

### Teclado, layout y reclutch

El marco elegido para una orientación se conserva mientras el teclado esté
abierto. La apertura consume el primer contacto para cerrar el teclado, como
ya hace `TouchSurface`, y cancela cualquier secuencia remota que estuviera
activa. El siguiente contacto comienza una secuencia nueva con el mismo marco
de orientación, aunque el compositor haya movido la barra del compositor.

Un cambio real de orientación, safe area, split view o rectángulo de entrada
crea una nueva generación. La generación anterior recibe exactamente un
`CancelTouch`; ningún contacto viejo se transforma con el marco nuevo. Un
levantamiento normal sigue enviando el snapshot vacío. Un reclutch empieza
con un nuevo contacto y un nuevo tracking ID, sin conservar un acumulador de
la secuencia anterior. Esto separa una liberación intencional de una
interrupción por rotación, cambio de modo, pérdida de foco o reconexión.

Las posiciones se calculan con `number`/`Float64` hasta la serialización. No
se redondean deltas en el cliente ni se descarta el residuo de una fracción.
El último redondeo conocido ocurre al convertir a los ejes del uinput. Con
28 unidades/mm, el error de cuantización de una coordenada es como máximo
0,01786 mm, equivalente a 0,0001786 en X normalizado y 0,0002551 en Y. Si un
bloque posterior necesita convertir deltas, el residuo debe vivir por
contacto y por eje, y resetearse en lift, cancelación, reclutch y rotación.

## Qué no se debe hacer para ganar recorrido

- No multiplicar `X` o `Y` por un factor de velocidad y aplicar `clamp` al
  resultado. Esa operación hace que varios puntos distintos terminen en el
  mismo borde y vuelve imposible medir la superficie efectiva.
- No aplicar una curva de aceleración al contacto y dejar que libinput aplique
  otra. La primera medición debe conservar la única curva del host y cambiar
  solo la geometría de entrada.
- No modificar la sensibilidad global del touchpad físico. Si el recorrido
  sigue por encima de dos pasadas después de usar toda la superficie virtual,
  el siguiente experimento debe ser una ganancia local del dispositivo virtual
  o un ajuste por equipo, con sus propios límites y rollback. No se debe
  escoger un multiplicador a partir de la relación informal 5/1,5.
- No convertir el snapshot en `EV_REL` ni sintetizar botones, scroll o pinch
  en el cliente. El touchpad virtual conserva las animaciones y la semántica
  nativas que motivaron el ADR 0005.

## Validación del primer bloque

Las pruebas puras deben cubrir lo siguiente:

1. Las cuatro esquinas de cada orientación llegan a las cuatro esquinas del
   rectángulo de entrada. Para el candidato cuadrado fijo, esas esquinas son
   las del subrectángulo centrado dentro del marco `P`; los márgenes virtuales
   no tienen que llenarse con coordenadas del teléfono. Los valores
   intermedios permanecen monotónicos en cada eje y no se usa `clamp` para
   afirmar cobertura.
2. Un desplazamiento de 100 puntos sobre el eje X de pantalla informa el
   mismo `100*gx` mm en portrait y landscape de la fixture 390 x 844. El eje Y
   informa el mismo `100*gy` mm. Con la referencia isotrópica son 11,848 mm
   en ambos ejes. El test no debe usar solo un punto central.
3. Abrir el teclado, cambiar el tamaño del compositor y cerrarlo no cambia la
   ganancia del marco vigente. Una rotación durante un contacto produce una
   cancelación y la siguiente secuencia usa únicamente el marco nuevo.
4. Cinco contactos con identificadores desordenados conservan sus posiciones,
   lifts parciales y orden estable. Un reclutch no reusa el acumulador ni deja
   un contacto pegado.
5. Una secuencia de desplazamientos fraccionarios conserva el valor flotante
   antes de la cuantización del host. La prueba registra el error contra el
   límite de 28 unidades/mm, sin exigir más precisión de la que ofrece uinput.
6. Un snapshot que cambia solo por posición no genera ningún comando de botón,
   `Move`, scroll o gesto discreto.

El laboratorio sin dispositivos físicos puede reutilizar
`daemon/internal/input/touchpad_desktop_integration_test.go` con
`PHONEPAD_MT_FIXTURE_DIR` y el observador aislado
`tools/verify-native-touchpad.py`. La prueba actual crea un touchpad uinput,
lo entrega al observador con `EVIOCGRAB` y verifica tap, doble toque y
arrastre, cancelación, scroll, pinch y swipe. `tools/hfr/input_lab.py` solo
prueba texto literal en un editor GTK privado; no mide recorrido de cursor.

Para medir P04.7 sin tocar el escritorio del usuario, el siguiente fixture
debe emitir trazas sintéticas de 125 Hz, igual que las etapas actuales de
8 ms, con velocidades lenta y cómoda registradas. El observador debe guardar
el timestamp del evento, `dx/dy` de libinput y la posición de un cursor dentro
de una ventana GTK del laboratorio. Cada pasada es un contacto desde un borde
de la superficie hasta el opuesto antes del lift. Se repiten ambos sentidos,
los dos ejes, portrait/landscape y teclado visible/oculto. Se guardan el
marco usado, los contactos normalizados, los milímetros virtuales, el perfil
de aceleración de libinput, la resolución y las posiciones inicial/final del
cursor. El host de prueba debe seguir en una sesión privada y la captura debe
rechazar cualquier dispositivo que no sea el fixture.

La aceptación conserva el criterio ya aprobado en P04.9: mediana de diez
recorridos horizontales de no más de dos pasadas cómodas en cada sentido,
además de los blancos pequeños, arrastres, subpíxeles, inversión de sentido,
lift/reclutch, varios monitores y cambios de modo. La dispersión de ganancia,
el tiempo y el sobrepaso se registran como diagnóstico. No hay evidencia
física todavía para afirmar el resultado en Ubuntu+iPhone, Mac o Android.

## Dependencias y cierre

El primer bloque puede validarse con el mapper y el touchpad virtual en Linux.
No necesita una pantalla personal ni cambiar la configuración global de
libinput. P04.7 requiere el observador de cursor del laboratorio y una traza
con velocidades comparables. P04.8 solo debe ajustar una ganancia local si la
geometría de cobertura completa no alcanza el objetivo. P04.9 sigue pendiente
hasta repetir la matriz física en los dispositivos declarados.

Archivos revisados para este diseño:

- `mobile/src/components/touch-surface.tsx` y sus pruebas en
  `mobile/tests/touch-surface.test.cjs`.
- `daemon/internal/input/touchpad.go`, `touchpad_linux.go`,
  `touchpad_desktop_integration_test.go` y `touchpad_linux_test.go`.
- `tools/verify-native-touchpad.py` y `tools/hfr/input_lab.py`.
- `docs/adr/0005-touchpad-precision-emulado.md`,
  `outputs/phonepad-auditoria.md`,
  `outputs/phonepad-auditoria-entrada-adjuntos.md` y las tareas P04.5/P04.7/P04.9
  del plan maestro.

Este documento es la propuesta medible para continuar. No se editaron los
archivos de implementación, el protocolo, uinput, capture ni los fixtures.
