# P03.1: sondeo de GCC/TWCC y punto de control WebRTC

Resultado al terminar este bloque: plugin privado compilado y loopback
WebRTC real aprobado, con 23 eventos TWCC y tres ajustes de bitrate en
VP8/software. La sección final conserva los resultados y la negociación del
receptor que fue necesaria. Las secciones iniciales documentan el sondeo
previo, no describen una carencia que siga bloqueando el laboratorio. Falta
integrarlo con H264/VA de PhonePad y medir congestión; P03.1 sigue abierta.

Fecha del sondeo: 2026-09-20. El alcance fue diagnóstico: no se cambió
`setup/preview/rtc.py`, el pipeline de producción, la red, un servicio del
sistema ni la pantalla del usuario. El probe reproducible quedó en
[`tools/refactor/p03_01_probe.py`](../../tools/refactor/p03_01_probe.py). La
preparación de build privada y el smoke sintético quedaron en
[`tools/refactor/p03_01_build_rsrtp.sh`](../../tools/refactor/p03_01_build_rsrtp.sh)
y [`tools/refactor/p03_01_prepare_sdk.sh`](../../tools/refactor/p03_01_prepare_sdk.sh)
y [`tools/refactor/p03_01_gcc_smoke.py`](../../tools/refactor/p03_01_gcc_smoke.py).

## Método y límites del resultado

Se ejecutó `gst-inspect-1.0` 1.28.2 contra el sistema y contra el runtime
aislado de Phonepad (`.../runtime`), con un registro GStreamer temporal en
`/tmp`. También se inspeccionaron el pipeline real, los scripts del
laboratorio y los artefactos del runtime. El probe no inicia una sesión
WebRTC: por eso no demuestra una negociación SDP ni una ruta de paquetes en
una red con congestión.

Para resolver el hook se fijó el repositorio oficial `gst-plugins-rs` en el
commit `b0544c4596f4f4ee4c5602918a4849e5ef51ee6d` (snapshot SHA-256
`6b5c1d3aba84fada30585aa5ab6a7a41e9e9f45c68f50db7aaf1b5ca71c686cd`). La
fuente se extrajo sólo bajo `/tmp`; no se incorporó al repositorio Phonepad.

La lectura de esa fuente resuelve el punto que quedaba abierto en el primer
sondeo. Cuando se selecciona Google Congestion Control, la implementación
actual de `webrtcsink` crea `rtpgccbwe`, conecta la señal
`webrtcbin::request-aux-sender`, devuelve el elemento GCC desde ese callback y
reenvía cada `notify::estimated-bitrate` al encoder. También añade una
extensión RTP TWCC al payloader antes de negociar. Las referencias
primarias del snapshot son [`webrtcsink/imp.rs` en el callback AUX](https://gitlab.freedesktop.org/gstreamer/gst-plugins-rs/-/blob/b0544c4596f4f4ee4c5602918a4849e5ef51ee6d/net/webrtc/src/webrtcsink/imp.rs#L3511),
[`webrtcsink/imp.rs` en la configuración TWCC](https://gitlab.freedesktop.org/gstreamer/gst-plugins-rs/-/blob/b0544c4596f4f4ee4c5602918a4849e5ef51ee6d/net/webrtc/src/webrtcsink/imp.rs#L1978)
y [`rtpgccbwe` al procesar `RTPTWCCPackets`](https://gitlab.freedesktop.org/gstreamer/gst-plugins-rs/-/blob/b0544c4596f4f4ee4c5602918a4849e5ef51ee6d/net/rtp/src/gcc/imp.rs#L1219).
La API instalada se comprobó además con [`webrtcbin`](https://gstreamer.freedesktop.org/documentation/webrtc/#webrtcbin-page).
`gst-inspect-1.0` 1.28.2 enumera ambas señales AUX con argumento
`GstWebRTCDTLSTransport` y retorno `GstElement*`.

El runtime actual no tiene `/dev/dri` visible en este entorno. El archivo del
plugin VA moderno está presente, pero `gst-inspect` no puede enumerar sus
features sin el dispositivo DRM. Esa limitación no se registra como ausencia
del plugin.

## Anunciado en el árbol, pero no garantía del runtime

- [`docs/webrtc-implementation.md`](../webrtc-implementation.md) describe el
  control receiver-feedback AIMD vigente y dice explícitamente que GCC/TWCC
  todavía no están implementados.
- [`docs/native-app.md`](../native-app.md) y
  [`docs/streaming-research.md`](../streaming-research.md) dejan
  `rtpgccbwe`/TWCC y `webrtcsink` como evaluación futura. Son referencias de
  diseño, no una dependencia ya instalada.
- [`setup/install-video-runtime.sh`](../../setup/install-video-runtime.sh)
  copia `libgstwebrtc`, `libgstnice`, `libgstdtls`, `libgstsrtp`, VA-API y
  parsers desde paquetes Ubuntu. No instala artefactos de los plugins Rust
  `gst-plugin-rtp` (`rsrtp`) ni `gst-plugin-webrtc` (`rswebrtc`), que son los
  paquetes documentados para `rtpgccbwe` y `webrtcsink`.

La documentación primaria de GStreamer confirma la diferencia: `rtpgccbwe`
es un filtro GCC del plugin `rsrtp` y `webrtcsink` pertenece a `rswebrtc`.
`webrtcsink` ofrece adaptación incorporada pero reserva el control fino de
los elementos; para control granular su propia documentación recomienda usar
`webrtcbin` directamente.

Fuentes: [`rtpgccbwe`](https://gstreamer.freedesktop.org/documentation/rsrtp/rtpgccbwe.html),
[`webrtcsink`](https://gstreamer.freedesktop.org/documentation/rswebrtc/webrtcsink.html)
y [`rswebrtc`](https://gstreamer.freedesktop.org/documentation/rswebrtc/index.html).

## Instalado en el runtime aislado

El host y el runtime reportan GStreamer 1.28.2. El inventario relevante es:

| Artefacto o factory | Sistema | Runtime Phonepad | Lectura |
| --- | --- | --- | --- |
| `libgstwebrtc.so` / `webrtcbin` | factory ausente | archivo y factory presentes | transporte WebRTC actual |
| `rtphdrexttwcc` | presente | presente | extensión TWCC disponible |
| `rtpgccbwe` | ausente | ausente | no hay GCC/pacer nativo |
| `webrtcsink` | ausente | ausente | no hay wrapper `rswebrtc` |
| `libgstvaapi.so` | ausente en el perfil de sistema sondeado | archivo presente | plugin legacy empaquetado |
| `libgstva.so` y `libgstva-1.0.so` | ausentes en el perfil de sistema | archivos presentes | plugin VA moderno, sin enumeración por falta de `/dev/dri` |
| `vah264enc`, `vaapih264enc`, `vapostproc`, `vaapipostproc` | ausentes | no enumerables en esta ejecución | no concluir ausencia del artefacto VA moderno |

No se encontró ningún archivo que nombrara `rtpgccbwe`, `webrtcsink`,
`gst-plugin-rtp`, `gst-plugin-webrtc`, `rsrtp` o `rswebrtc` dentro del runtime.
El resultado completo se puede volver a obtener con:

```sh
python3 tools/refactor/p03_01_probe.py \
  --runtime /home/luque/Documents/Codex/2026-09-08/phonepad/work/runtime \
  --out /tmp/p03-01-probe.json
```

La build privada se completó sin instalar paquetes ni escribir en `/usr` o en
el runtime. Se usó el SDK temporal `/tmp/phonepad-p03-01-sdk`, con Rust
oficial `1.98.1` (commit
`48a229ceaefd4985c50990b14116b6d856af0985`, archivo oficial del 2026-09-03,
SHA-256
`24ba1338a2d35c5a3247936546429e163fa674d726102af18bdf624582c57aea`) y un
sysroot extraído de paquetes Ubuntu fijados a GStreamer `1.28.2`, GLib
`2.88.0` y `pkg-config` `2.5.1-4`. Los módulos `.pc` y headers privados se
resolvieron para `gstreamer-1.0`, `gstreamer-base-1.0`, `gstreamer-rtp-1.0`,
`gstreamer-net-1.0`, `gstreamer-video-1.0`, `glib-2.0`, `gobject-2.0`,
`gmodule-2.0` y `gio-2.0`.

El `Cargo.lock` del snapshot se conservó y se compiló con `--locked`. Fija
los bindings `gstreamer-rs` al commit
`a5b198fceed7a2ebb4f405cc83ec96a0265fa239`; su SHA-256 es
`c4531185577a6082eda1a7c913aa258793a4c9dbc7aeab12de93605252e942e2`.
Cargo terminó el paquete `gst-plugin-rtp` en 12m44s. El artefacto privado
`libgstrsrtp.so` mide `68,394,712` bytes y tiene SHA-256
`ca5a4da007afc849035240591f6ae071743235c09610b6e6878cbc43a0c88003`.
`gst-inspect-1.0` lo cargó como `rsrtp`, versión `0.16.0-alpha-RELEASE`,
licencia `MPL-2.0`, módulo `gst-plugin-rtp`, con el factory `rtpgccbwe` y sus
propiedades de bitrate. `ldd` resolvió sus dependencias dinámicas contra el
runtime GStreamer/GLib del host: `libgstnet`, `libgstreamer`, `libgstaudio`,
`libgstbase`, `libgstvideo`, `libgstrtp`, `libgio`, `libgobject`, `libglib`,
`libgmodule`, además de `libffi`, `libatomic`, `libpcre2`, `liborc`,
`libgsttag`, `libgstallocators`, `libz`, `libmount`, `libselinux`, `libdrm`,
`libblkid` y la libc. El `.so` sólo se copió al prefijo temporal del SDK.

El script acepta ahora `--sdk-root DIR` para repetir esta disposición privada:
exporta `PATH`, `LD_LIBRARY_PATH`, `PKG_CONFIG_SYSROOT_DIR` y
`PKG_CONFIG_LIBDIR` desde `DIR/{rust,sysroot}`; mantiene `CARGO_HOME`,
`CARGO_TARGET_DIR` y el plugin resultante dentro de la carpeta indicada en
`/tmp`. El preparador [`p03_01_prepare_sdk.sh`](../../tools/refactor/p03_01_prepare_sdk.sh)
descarga el archivo oficial de Rust, usa `apt-get --download-only` para los
paquetes fijados, extrae todo al prefijo privado y escribe
`sdk-manifest.txt` con hashes y versiones. Si un paquete deja de estar
disponible con esa versión, falla en vez de sustituir silenciosamente la ABI.

## Qué está conectado hoy

El pipeline de `Session` es, en esencia:

```text
PipeWire source → queue leaky=downstream → valve → VA postproc/encoder
  → H264 parser/payloader → application/x-rtp → webrtcbin (child rtpbin)
```

El punto de control de bitrate que sí existe y fue inspeccionado está en
`setup/preview/rtc.py:233-250`: cada feedback HTTP del receptor pasa por
`RateController.update` y luego ejecuta
`self.encoder.set_property('bitrate', target)`. La respuesta incluye el
`bitrateKbps`, `rateDecision.appliedKbps`, FPS de entrada/salida y P95 de
encode. La cola corta, el reloj de sistema y `latency=0` ayudan a no acumular
frames, pero no son un estimador GCC ni un pacer basado en TWCC.

El factory `rtphdrexttwcc` disponible sólo prueba que la extensión puede
crearse. No prueba que la oferta o respuesta de esta aplicación la hayan
negociado: no hay una captura SDP con `a=extmap` en la evidencia sondeada y
`rtc.py` no configura explícitamente esa extensión. En una ejecución del
laboratorio hay que guardar los SDP que ya devuelve `start` y comprobar la
URI de Transport-Wide Congestion Control, o comprobar una estadística/captura
de RTP equivalente. La descripción de `webrtcbin` también confirma que el
elemento encapsula un `rtpbin` interno. GStreamer 1.28.2 expone
`request-aux-sender` y `request-post-rtp-aux-sender` como señales de AUX
sender. La implementación oficial de `webrtcsink` usa
`request-aux-sender` para devolver `rtpgccbwe`; no usa
`request-post-rtp-aux-sender` para este elemento.

## Dónde conectar GCC/pacing si aparece el plugin

La documentación de `rtpgccbwe` exige que el elemento esté inmediatamente
antes de un `rtpsession`, que TWCC esté activo y que el callback
`notify::estimated-bitrate` lleve el target calculado al encoder. El elemento
también pacea en su propio hilo de streaming. `webrtcbin` es dueño del
`rtpbin` interno, por lo que la integración mínima para Phonepad debe seguir
el patrón AUX que ya usa `webrtcsink`:

1. Al crear cada sesión, buscar `rtpgccbwe`. Si el factory no existe, conservar
   el controlador AIMD actual y registrar la capacidad ausente.
2. Conectar `webrtcbin::request-aux-sender`. El callback debe ajustar
   `min-bitrate`, `estimated-bitrate` y `max-bitrate`, conectar
   `notify::estimated-bitrate` al setter del encoder y devolver la misma
   instancia de `rtpgccbwe`.
3. Añadir al payloader una `GstRtp.RTPHeaderExtension` creada con la URI TWCC,
   asignarle un ID libre y verificar la extensión en la oferta. El código
   oficial usa `create_from_uri`, `set_id` y `add-extension` en ese orden.
4. Verificar en una sesión de loopback que el `rtpbin` envía los eventos
   `RTPTWCCPackets` al AUX sender y que una notificación de GCC cambia el
   bitrate del encoder. El código de `rtpgccbwe` procesa esa estructura en su
   pad de eventos, actualiza la estimación y emite
   `notify::estimated-bitrate`.

Este resultado demuestra que el hook AUX es un punto de integración real. No
demuestra todavía que la sesión personalizada de Phonepad lo active, porque
el runtime no tiene `rtpgccbwe` y el sondeo no inició ICE/DTLS. `webrtcsink`
sería otra ruta, pero el runtime no lo tiene y su control de encoder y
señalización no coincide con la sesión personalizada de Phonepad.

## Cómo medirlo con el laboratorio privado existente

`tools/hfr/isolated.py` crea un compositor, D-Bus, PipeWire y directorios
privados; con `PHONEPAD_LAB_WEBRTC=1` ejecuta la cadena real de `rtc.py`, y
`tools/hfr/webrtc_lab.html` usa un receptor Chromium sólo sobre loopback.
Ese receptor toma cada segundo `inbound-rtp`, paquetes recibidos/perdidos,
jitter buffer, RTT, frames decodificados y bytes; envía esos datos a
`feedback`. La respuesta del servidor deja el valor de bitrate aplicado, de
modo que puede correlacionarse el cambio del encoder con bytes codificados,
FPS y encode P95. `tools/hfr/measure.py` ofrece además un A/B del setter del
encoder sin red. `tools/refactor/network_lab.py` sólo prueba UDP echo sobre
veth/netem privado y no está conectado a la sesión WebRTC; no presentarlo como
prueba de congestión de Phonepad.

La repetición conserva el aislamiento ya documentado en el README (unidad
systemd temporal con límites de memoria/tiempo):

```sh
PHONEPAD_LAB_RUNTIME=/home/luque/Documents/Codex/2026-09-08/phonepad/work/runtime \
PHONEPAD_LAB_WEBRTC=1 PHONEPAD_LAB_SECONDS=15 \
python3 tools/hfr/isolated.py
```

El navegador de laboratorio debe apuntar a la página local que expone el
worker; al finalizar se conserva el `result.json` de `cycle-0`. Para probar
TWCC en una futura iteración, el wrapper de laboratorio debe guardar además
los campos `sdp` de las respuestas `start` y `answer` antes de limpiar el
directorio temporal.

La prueba mínima y efectiva antes de tocar producción es:

1. Ejecutar un ciclo sintético WebRTC con el runtime de hardware y conservar
   `offer.sdp`, `answer.sdp`, las muestras del receptor y cada respuesta
   `feedback`. Validar primero la presencia o ausencia de la URI `a=extmap`
   TWCC.
2. Inyectar durante unos segundos un feedback de congestión controlado en el
   laboratorio (o reutilizar el escenario de pérdida/delay de la política),
   y después muestras buenas de recuperación. Exigir que
   `rateDecision.appliedKbps` cambie al target solicitado, que la pendiente de
   bytes codificados baje durante la fase de reducción y que el receptor no
   pierda el primer frame ni quede detenido. Esto demuestra el setter de
   encoder por la ruta WebRTC actual; no demuestra GCC ni pacing nativo.
3. Sólo después de instalar `rsrtp`, repetir el mismo escenario con una
   cadena de laboratorio que incluya `rtpgccbwe`. Medir además bitrate
   estimado, intervalos de salida RTP y profundidad/tiempo de cola bajo netem
   privado. Un resultado válido necesita estimación, TWCC negociado y efecto
   observable en el encoder, no sólo que `gst-inspect` encuentre el factory.

No se ejecutó el laboratorio completo en este sondeo porque la ejecución no
tenía `/dev/dri` y el objetivo era inspeccionar capacidades sin iniciar
servicios ni tocar la sesión personal. El probe y el inventario anteriores son
repetibles y no leen ni guardan contenido de pantalla.

## Build y smoke sintético

El smoke sintético disponible no abre sockets ni crea una sesión WebRTC. Con
las factories privadas instaladas ejecuta el callback
`webrtcbin::request-aux-sender`, crea `rtpgccbwe`, comprueba el
`notify::estimated-bitrate` que actualiza un target de encoder y acepta una
extensión TWCC en `rtph264pay`; agrega los elementos a un `Gst.Pipeline` y lo
conecta como `rtph264pay ! rtpgccbwe ! rtpsession ! fakesink` antes de llevarlo
a `READY`. La emisión manual deja fuera ICE, DTLS y los eventos
`RTPTWCCPackets`; un loopback WebRTC sigue siendo necesario para esos últimos
pasos. Los comandos son:

```sh
SDK=/tmp/phonepad-p03-01-sdk
BUILD=/tmp/phonepad-p03-01-rsrtp-build
bash tools/refactor/p03_01_build_rsrtp.sh \
  --sdk-root "$SDK" --online --root "$BUILD"

RUNTIME=/home/luque/Documents/Codex/2026-09-08/phonepad/work/runtime
export LD_LIBRARY_PATH="$SDK/sysroot/usr/lib/x86_64-linux-gnu:$RUNTIME/video-modern/lib:$RUNTIME/video-packages/extracted/usr/lib/x86_64-linux-gnu:/usr/lib/x86_64-linux-gnu"
export GST_PLUGIN_PATH="$BUILD/plugin/gstreamer-1.0:$RUNTIME/video-modern/plugins:$RUNTIME/video-plugins:/usr/lib/x86_64-linux-gnu/gstreamer-1.0"
export GI_TYPELIB_PATH="$RUNTIME/video-packages/extracted/usr/lib/x86_64-linux-gnu/girepository-1.0:/usr/lib/x86_64-linux-gnu/girepository-1.0"
GST_PLUGIN_PATH="$GST_PLUGIN_PATH" \
GST_REGISTRY=/tmp/p03-01-rsrtp-smoke-registry.bin \
python3 tools/refactor/p03_01_gcc_smoke.py
```

La ejecución con el SDK privado terminó con estado `passed`:
`request-aux-sender` se llamó una vez, `rtpgccbwe` notificó el target
`1,234,567`, la extensión TWCC se añadió al payloader y el pipeline alcanzó
`READY`. Esta prueba es deliberadamente sintética: no abre sockets ni crea
ICE/DTLS y no inyecta todavía eventos `RTPTWCCPackets`; la validación de ese
feedback requiere el loopback WebRTC descrito arriba. La sintaxis Bash y la
compilación sintáctica Python también quedaron validadas.

## Loopback WebRTC P03.1B

Se añadió [`p03_01_webrtc_loopback.py`](../../tools/refactor/p03_01_webrtc_loopback.py).
Construye en un único proceso una fuente `videotestsrc ! vp8enc ! rtpvp8pay`,
un `webrtcbin` emisor y otro receptor con `fakesink`. La señalización es una
oferta/respuesta local y el intercambio de candidatos ocurre sólo entre los
dos elementos; no se configura STUN/TURN, no se abre un navegador y no se
captura la pantalla. El callback `request-aux-sender` devuelve una instancia
real de `rtpgccbwe`; el script observa `RTPTWCCPackets` en su pad y conecta
`notify::estimated-bitrate` al `target-bitrate` de `vp8enc`.

La primera ejecución dentro del sandbox produjo `aux_calls=1` y una oferta con
TWCC, pero ambos elementos quedaron en `ice-gathering-state=gathering`, sin
candidatos y sin buffers. Esto es un bloqueo de sockets del entorno, no una
ausencia de las factories. Una ejecución local acotada con el mismo runtime
privado, fuera de ese sandbox y sin red externa, generó 25/26 candidatos,
llegó a `connection-state=connected` e `ice-connection-state=completed`, y
entregó 1.119 buffers, 897 eventos `RTPTWCCPackets` y 188 notificaciones que
actualizaron el bitrate de `vp8enc`.

GStreamer 1.28.2 sólo copia la extensión ofrecida a la answer cuando el
transceiver receptor declara esa capacidad en sus caps. El script lo hace
explícitamente con `add-transceiver(RECVONLY, ... extmap-3=TWCC)`; no modifica
la answer después de generarla. Con esa configuración la respuesta cruda
contiene TWCC (`offer_twcc=true`, `answer_twcc_raw=true`) y la ejecución llegó
a `status=passed`: `aux_calls=1`, 32 buffers, 23 eventos
`RTPTWCCPackets`, 3 notificaciones de GCC y 3 cambios observables de
`vp8enc.target-bitrate`; ambos peers quedaron `connected/completed`.

Para reproducir el comportamiento problemático del answerer automático se
puede ejecutar con `P03_EXPLICIT_RECEIVER_TWCC=0`. En ese caso la answer omite
la URI, aunque el camino local pueda seguir entregando feedback; el script lo
marca como fallo de negociación SDP. La capacidad explícita se deja activada
por defecto en el experimento porque permite probar la negociación real sin
parchear SDP en memoria.

Una repetición reproducible, después de preparar las variables de runtime
usadas en la sección anterior, es:

```sh
P03_EXPLICIT_RECEIVER_TWCC=1 \
GST_REGISTRY=/tmp/p03-01-rsrtp-loopback-registry.bin \
python3 tools/refactor/p03_01_webrtc_loopback.py
```

La corrida es sintética y usa VP8/software. No demuestra el comportamiento
del encoder VA/H264 de PhonePad, de un iPhone ni de una red congestionada; no
se presenta como una mejora de calidad o latencia. Tampoco se cambió
`setup/preview/rtc.py` ni el runtime estable.
