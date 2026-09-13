# Phonepad: actualización del 10 de septiembre

## Instalado y verificado en Ubuntu

- Encoder H.264 Intel VA-API estable (`vaapih264enc`), con bibliotecas aisladas y sin sustituir bibliotecas del sistema. Se evaluó `vah264enc` 1.28.2, pero NO se conserva activado: retuvo cinco descriptores DRM y unos 425 MiB de buffers después de cinco cierres. El encoder estable liberó los cinco contextos en la prueba equivalente.
- Cola de un cuadro y sin B-frames; bitrate adaptativo 6–12 Mbps, máximo 1920×1080 preservando proporción. Estos límites no equivalen a resolución o FPS garantizados en cada conexión.
- La pausa de hasta cinco minutos corta los cuadros antes del encoder mediante una válvula. La sesión PipeWire sigue disponible, evitando el atasco observado con `PAUSED`. El cierre envía flush antes de liberar el pipeline. La captura puede seguir produciendo cuadros descartados durante la pausa; no se afirma consumo cero.
- El cierre desconecta señales y probes de GObject y libera las referencias al pipeline. Comparación con weakrefs: antes se retenían 5/5 sesiones; después 0/5.
- El acceso a la propiedad ICE usa las referencias explícitas de la API C pública de GObject: evita que el wrapper PyGObject consuma la referencia flotante propiedad de webrtcbin. Regresión con `G_DEBUG=fatal-criticals`: 20 creaciones y destrucciones sin errores nativos.
- Desactivado UPnP en libnice: el camino privado no necesita abrir puertos del router.
- Endpoint de archivos autenticado y con validación de Origin, limitado a un archivo simultáneo y 100 MiB. Escritura en streaming a archivo temporal privado, publicación atómica sin sobreescritura, eliminación de archivos incompletos. Nunca abre ni ejecuta el contenido recibido.
- Copia anterior conservada en `outputs/rollback-sep10-glass`.

## Pruebas reales

- Cinco ciclos con el paquete temporal, cinco con sus bibliotecas permanentes y cinco contra el servicio instalado pasando por el gateway privado.
- En los cinco ciclos del servicio instalado: llegaron cuadros antes de pausar, no llegaron nuevos cuadros durante la pausa estable, llegaron al reanudar y el cierre terminó correctamente.
- Mediana de reanudación 64 ms, máximo 248 ms. Receptor Chrome local, no medición de latencia ni FPS en el iPhone.
- Archivo de prueba enviado por el gateway instalado: contenido y permisos 0600 verificados; archivo de prueba eliminado. Petición sin autorización rechazada.
- Tests Go del daemon, ocho tests de pausa/adaptación de video y una regresión nativa de propiedad de ICE con 20 ciclos, cinco archivos de tests JS de la app, ocho tests de empaquetado iOS y TypeScript pasan.
- No se modificó ninguna pantalla física/virtual, sesión GNOME ni configuración de red. Sunshine permanece apagado.

## Nueva compilación de iPhone

EAS build 3: `7d150cd3-459e-4eaf-be02-bbfa2cd5f208`, terminado. La receta personalizada conserva CFBundleVersion 2; el nuevo fingerprint nativo es `ab4d79a1dce16a6c308aeebd83e00c7c1791c1e3`. La compatibilidad OTA depende del fingerprint, no del número que muestra EAS.

- Menú + con Teclado, Archivos, Cámara y Fotos, con `expo-glass-effect` nativo y SF Symbols.
- Flechas en T invertida; acceso de modificadores independiente y Enter separado.
- Se conserva cerrar el teclado tocando fuera sin enviar un clic remoto.
- Selectores de archivos y fotos del sistema, cámara explícita sólo para fotos. Sin permiso de micrófono. Archivos enviados por HTTPS/Tailscale a Downloads/Phonepad.
- La preview horizontal utiliza el espacio antes reservado a la barra lateral.
- El cálculo de pérdida/jitter usa una línea de base nueva tras reanudar, evitando penalizar la calidad por muestras antiguas.
- Actualizaciones no se aplican mientras hay selección o transferencia activa.

Los selectores requieren otro binario nativo. No se envían a la instalación anterior como si fueran compatibles por OTA. El efecto Liquid Glass depende de soporte real de iOS y ajustes de accesibilidad; hay fallback accesible cuando no está disponible.

## Pendiente

Archive descargado y validado: arm64/iPhoneOS 26.5, WebRTC, ExpoGlassEffect, ImagePicker y DocumentPicker incluidos, sin micrófono, hash SHA-256 coincidente con el builder. Pendiente: firma personal, instalación y prueba final en el iPhone. No hay un dispositivo Apple conectado por USB en la comprobación final; la firma e instalación personal necesitan volver a conectar el iPhone. No se da por logrado 60/120 FPS reales. El límite de captura observado sigue alrededor de 40 FPS en este escritorio; aumentar el contador del encoder no crea imágenes distintas del escritorio.

Fuentes técnicas: [Expo GlassEffect SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/glass-effect/), [ImagePicker SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/imagepicker/), [DocumentPicker SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/document-picker/), [webrtcbin](https://gstreamer.freedesktop.org/documentation/webrtc/).

## Verificación final instalada

Cinco ciclos del encoder estable con la corrección definitiva: todos reciben, pausan, reanudan y cierran. Mediana 57 ms; máximo 120 ms. Cero descriptores DRM retenidos tras el cierre; sin errores nativos en el log final. Evidencia: `outputs/video-final-sep10.json`.
