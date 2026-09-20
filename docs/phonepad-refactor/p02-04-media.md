# P02-04: media observada de Python a Go y al cliente

Este bloque prepara metadata verificable para la captura y el encoder del
preview. No declara aceptación física ni habilita captura nueva en un
dispositivo. El contrato es aditivo: el proxy puede transportar el objeto sin
conocer sus detalles y los clientes viejos pueden ignorarlo.

## Contrato

`media` contiene exactamente `version: 1`, `source`, `geometry` y `video`:

```json
{
  "media": {
    "version": 1,
    "source": {"state": "available", "id": "nonce", "kind": "portal"},
    "geometry": {
      "state": "available", "epoch": 1,
      "width": 1279, "height": 719,
      "encodedWidth": 1279, "encodedHeight": 719
    },
    "video": {"state": "available", "codecs": ["H264"], "selectedCodec": "H264"}
  }
}
```

Los estados posibles son `available`, `unavailable` y `unknown`. Los campos
opcionales se omiten cuando no hay evidencia. Un estado que no sea
`available` lleva un código `reason` y no lleva medidas, identificadores o
codecs. Las dimensiones son enteros positivos de hasta 32768; pueden ser
impares. `epoch` es un entero de 1 a `2^53-1`. El identificador es un nonce
opaco de hasta 128 caracteres seguros para JSON. El objeto no contiene el
node de PipeWire, un FD, un token del portal, SDP ni datos de pantalla.

`props.size` de ScreenCast es metadata lógica y puede reflejar escala
fraccionaria. No se usa como geometría. Las dimensiones se obtienen solo de
current caps fijos de GStreamer. La geometría pasa a `available` únicamente
cuando se observaron tanto el par real de captura como el par real recibido
por el encoder; mientras falte uno, queda `unknown` y no publica dimensiones.
Ningún límite de la petición (`1920x1080`) se publica como medida observada.

El `source.id` se crea para cada generación del Portal y permanece durante
las renegociaciones que reutilizan esa fuente. Una selección, reinicio o
pérdida de la fuente inicia otra generación. HFR tiene una fuente propia por
worker/Mirror y nunca hereda el ID del Portal. `geometry.epoch` empieza en 1
cuando aparece el primer par de caps y aumenta cuando cambia una medida real;
perder caps no inventa una medida ni cambia por sí solo la época. Una nueva
fuente reinicia la cuenta porque también cambia el ID.

Los codecs se anuncian solo después de comprobar el camino de factories y
runtime. HFR deja que el worker hijo devuelva la evidencia; el proceso padre
permanece `unknown` hasta recibirla. El `selectedCodec` aparece después de
crear la oferta. Las peticiones antiguas con `codec: "H264"` siguen siendo
válidas. Las nuevas pueden enviar `codecs` como preferencias y, en las
operaciones de actualización, `sourceId` y `geometryEpoch`. Una incompatibilidad
devuelve `media_stale`; `stop` sigue siendo cleanup válido aunque la época
haya cambiado.

El proveedor HTTP traduce esa incompatibilidad a `409` con `error:
"media_stale"`; el worker conserva el mismo texto por su RPC local. Un
`stop` no compara la época y queda disponible para liberar el pipeline.

## Alcance y validación

`setup/preview/media_contract.py` valida el objeto y contiene el tracker
thread-safe usado por Portal y HFR. `capture.py` lo incluye en `status` y
propaga el resultado de start/feedback/resume. `rtc.py` lee caps actuales,
negocia la intersección de codecs y conserva la compatibilidad del start
antiguo. `process_backend.py` no adivina factories: solo conserva metadata
validada recibida del worker. `hfr_worker.py` crea su propia generación.

El daemon valida el objeto antes de anunciarlo como capacidad. Observa solo
las consultas de preview solicitadas por el usuario, porque consultar el
estado automáticamente puede abrir el selector Portal. Descarta respuestas
fuera de orden, limita el JSON y vuelve a `unknown` al vencer 30 segundos.
Conserva la última geometría conocida para rechazar épocas reutilizadas con
otras dimensiones. Los cambios de media no invalidan una operación de archivos:
la revisión de permisos es independiente de la revisión de capacidades.

El cliente valida el mismo contrato, elige H264 de las capacidades anunciadas
y vincula las actualizaciones a la fuente y época. Un servidor viejo puede
omitir `media`; un objeto presente e inválido causa un error explícito.

La prueba `session_interop_test.go` ejecuta el tracker Python y transporta su
resultado por el servidor Go y la conexión TypeScript reales con TLS/WS. La
fixture distingue captura 2731x1537 de codificación 1920x1080. Es una prueba
del contrato, separada de la captura del laboratorio siguiente.

## Captura y encoder reales, 20/09/2026

`tools/refactor/p02_media_lab.py` ejecutó el worker HFR dentro de GNOME,
DBus y PipeWire privados, con VA disponible. La prueba descubrió dos errores:
el worker anunciaba H265 aunque solo implementaba H264, y pedir ancho 1280
producía 1280x1080. Ahora HFR anuncia H264 y calcula un tamaño exacto con
píxeles cuadrados a partir de la geometría física que valida Mirror.

| Captura observada | Límite solicitado | Encoder observado | Oferta | Cierre |
| --- | --- | --- | --- | --- |
| 1920x1080 | 1920x1080 | 1920x1080 | 3083,44 ms | stop, 259,44 ms |
| 1920x1080 | 1280x720 | 1280x720 | 2645,62 ms | SIGTERM y shutdown, 332,55 ms |

Ambos workers terminaron con código 0, pipes cerrados y fuentes distintas.
La unidad privada duró 14,818 s y alcanzó 830,5 MiB. Los resultados están en
`outputs/p02/media-hardware-fixed-evidence` y `media-hardware-lab-fixed.log`.
Las corridas que descubrieron el fallo también se conservan.

La corrección de escalado utiliza la geometría física conocida de HFR. El
Portal genérico aún necesita el ajuste de aspecto P03.4/P08; no debe usar
`props.size` lógico como si fuera resolución física. Esta prueba no tuvo un
receptor y no mide FPS presentados, latencia de interacción ni calidad visual
en iPhone. Esos criterios y la matriz Mac/Android siguen pendientes.

Validación adicional: 49 pruebas Python, 174 pruebas móviles, typecheck y
exports Hermes iOS/Android. Los exports no son IPA/APK. Los logs de cada
comprobación y de Go con detector de carreras están en `outputs/p02`.
