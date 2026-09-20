# P03.1C: controlador GCC opcional en la sesión WebRTC

Este documento es el segundo registro de P03. Corresponde a la tarea P03.1
del plan maestro; P03.2, medición de copias y edad del cuadro, sigue pendiente.

La sesión nativa conserva `RateController` como camino predeterminado. GCC
sólo se selecciona con `PHONEPAD_RTC_CONTROLLER=gcc`; cualquier otro valor
desconocido falla explícitamente. El módulo [`gcc_controller.py`](../../setup/preview/gcc_controller.py)
mantiene el estado del AUX sender, la extensión TWCC y el único setter que
lleva el bitrate estimado al encoder.

La integración sigue el punto de extensión oficial de `webrtcbin`:

1. Antes de crear la sesión se comprueban las factories privadas `rtpgccbwe` y
   `rtphdrexttwcc`. Si faltan, la sesión solicitada falla con un error de
   disponibilidad y no se acepta un fallback legacy silencioso.
2. El payloader recibe la extensión
   `http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01`
   con ID 3 antes de crear la oferta.
3. `request-aux-sender` crea `rtpgccbwe` y ajusta `min/start/max` en bps. Para
   H264 son `350000/6000000/12000000`; para H265,
   `350000/4000000/8000000`. Los encoders VA reciben kbps, redondeados al
   entero más cercano y limitados al mismo intervalo.
4. La oferta debe contener la URI TWCC en el `m=video` activo, con el ID del
   extmap, payload 96 y `a=rtcp-fb:96 transport-cc`; la respuesta remota debe
   repetir el ID y la capacidad de recepción. Si la respuesta no negocia
   TWCC, se cierra la sesión antes de aceptar la descripción.
   También se rechazan `/inactive`, direcciones desconocidas y el uso del
   mismo ID para otra extensión. Las direcciones y la unicidad siguen
   [RFC 8285, sección 7](https://www.rfc-editor.org/rfc/rfc8285.html#section-7).

Cuando GCC está activo, `feedback` HTTP sigue actualizando el diagnóstico de
frames, FPS, RTT y pérdida y cuenta las muestras recibidas, pero no ejecuta
`RateController` ni llama al setter del encoder. La respuesta incluye
`controller: "gcc"`, `rateDecision.reason: "gstreamer_gcc"` y un bloque `gcc`
con `receiverReportCount`, `twccEventCount`, solicitudes AUX, estimación bps,
bitrate aplicado y conteo de setters. El setter sólo ocurre desde
`notify::estimated-bitrate`.

`Session.close()` desconecta el callback AUX y las notificaciones de cada
estimador antes de destruir el pipeline. Un callback tardío observa el estado
cerrado y no toca el encoder.

El módulo se copia tanto por `setup/install.sh` como por
`tools/hfr/stage_release.py`. El release sigue siendo una disposición de
archivos Python; `rsrtp` continúa siendo una dependencia privada del runtime
de laboratorio y no se instala en el runtime estable.

Validación focalizada con el SDK privado:

```sh
SDK=/tmp/phonepad-p03-01-sdk
BUILD=/tmp/p03-01-rsrtp-build
RUNTIME=/home/luque/Documents/Codex/2026-09-08/phonepad/work/runtime
export LD_LIBRARY_PATH="$SDK/sysroot/usr/lib/x86_64-linux-gnu:$RUNTIME/video-modern/lib:$RUNTIME/video-packages/extracted/usr/lib/x86_64-linux-gnu:/usr/lib/x86_64-linux-gnu"
export GST_PLUGIN_PATH="$BUILD/plugin/gstreamer-1.0:$RUNTIME/video-modern/plugins:$RUNTIME/video-plugins:/usr/lib/x86_64-linux-gnu/gstreamer-1.0"
export GI_TYPELIB_PATH="$RUNTIME/video-packages/extracted/usr/lib/x86_64-linux-gnu/girepository-1.0:/usr/lib/x86_64-linux-gnu/girepository-1.0"
GST_REGISTRY=/tmp/p03-02-gcc-test-registry.bin \
python3 -m unittest tests/gcc_controller_test.py
```

La suite focalizada cubre selección legacy/GCC, límites y conversión de
unidades, factories ausentes, propiedades AUX, feedback sin segunda política
ni setter, teardown y callbacks tardíos. También pasan `rtc_rate_test.py`,
`rtc_lifecycle_test.py` y `rtc_ice_test.py` con el mismo entorno privado.
La suite completa final pasó 56 pruebas con `G_DEBUG=fatal-criticals`,
incluidas las regresiones de dirección TWCC y colisión de identificador. Log
en `outputs/p03/gcc-integration-python-tests.log`. La revisión independiente
de teardown no encontró otro fallo concreto. `py_compile`, `bash -n`, el
staging del módulo y `git diff --check` también pasaron.

## Validación del camino H264 y VA real

El 20/09/2026, `tools/refactor/p03_gcc_media_lab.py` conectó el worker de
producción a un receptor GStreamer local. La captura usó GNOME y PipeWire
privados; el encoder y el decoder fueron `vah264enc` y `vah264dec`. El
receptor negoció TWCC desde sus caps, sin reescribir SDP ni fabricar feedback.

Resultado conservado en `outputs/p03/gcc-va-evidence/result.json`:

- Captura 1920 x 1080, codificación y decodificación 1280 x 720, píxel cuadrado.
- 66 buffers decodificados, conexión `connected`, ICE `completed`.
- Una solicitud AUX, 62 eventos TWCC reales y tres notificaciones de bitrate.
- Tres ajustes del encoder, última estimación 6.559.276 bps y aplicación
  6.559 kbps. El feedback de diagnóstico no ejecutó otro controlador.
- Worker finalizado con código 0 y ambos pipes cerrados.
- Unidad completa de 13,215 s, 28,431 s de CPU y pico de memoria 816,6 MiB.

La unidad limitó memoria a 1.300 MiB, duración a 75 s y terminó todos sus
procesos como grupo. El entorno seleccionó el plugin privado con
`PHONEPAD_LAB_PLUGIN_DIR` y mantuvo el runtime instalado sin cambios. Los
archivos de evidencia tienen un manifiesto SHA256 en el mismo directorio.

Reproducción desde la raíz del checkout, con el runtime y plugin del sondeo
P03.1 disponibles:

```sh
systemd-run --user --wait --pipe --collect \
  -p MemoryMax=1300M -p RuntimeMaxSec=75 -p KillMode=control-group \
  --setenv=PHONEPAD_LAB_RUNTIME=/ruta/runtime \
  --setenv=PHONEPAD_LAB_GCC=1 --setenv=PHONEPAD_RTC_CONTROLLER=gcc \
  --setenv=PHONEPAD_LAB_PLUGIN_DIR=/ruta/plugin/gstreamer-1.0 \
  --setenv=PHONEPAD_LAB_SECONDS=30 \
  /usr/bin/python3 "$PWD/tools/hfr/isolated.py"
```

El receptor inicial falló con SIGSEGV al liberar un `Gst.Structure` temporal
antes de usar la respuesta SDP que le pertenecía. El receptor ahora conserva
la referencia de `promise.get_reply()` hasta copiar la descripción local.
La traza anterior queda en `outputs/p03/gcc-va-evidence/initial-receiver-crash.log`;
el resumen de la unidad está en `outputs/p03/gcc-va-lab-trace.log`. La ejecución corregida quedó en
`outputs/p03/gcc-va-lab-owner.log`. Esto fue una corrección del laboratorio.

Esta prueba valida la conexión del controlador al encoder real y el cierre de
la sesión. Los buffers contados no demuestran FPS distintos presentados,
calidad visual, latencia física ni comportamiento ante congestión. P03 sigue
abierta para comparación A/B bajo perfiles de red y recepción iPhone/Android.
GCC conserva la selección explícita; no se cambió el default del servicio.
