# WebRTC nativo — 2026-09-09

Instalado: captura portal/PipeWire, H.264 Intel VA-API, RTP/SRTP mediante
GStreamer webrtcbin, receptor RTCPeerConnection. La señalización POST pasa por
la autorización existente de Phonepad. No se agregaron STUN/TURN públicos ni CA.
El fallback sigue siendo H.264 MP4/HTTPS, no JPEG.

La resolución inicial sigue el ancho visible de la preview y densidad hasta 2x,
con límite de 1920×1080 y sin ampliar el origen. El mouse conserva su WebSocket.
El receptor cierra el peer y pide cerrar la sesión al ocultarse/cerrar la preview.
Una concesión de 12 segundos libera la captura si desaparece el cliente sin aviso.
La fuente y codificador se detienen; conservar la autorización no exige video activo.

## Adaptación efectivamente implementada

Control receiver-feedback AIMD, **no GCC**: consulta estadísticas WebRTC cada
segundo; pérdidas, jitter buffer alto o RTT alto reducen el objetivo un 25%;
tres muestras buenas permiten recuperar 150 kbps. Objetivo inicial 2 Mbps,
mínimo 350 kbps, máximo 3.5 o 6 Mbps según resolución. VBR no es un límite
estricto de bytes ni de gasto de datos; el tráfico real depende de la escena y
del transporte. El objetivo se aplica a la propiedad bitrate del encoder VA-API.

No están implementados todavía GCC/TWCC, cambio dinámico de resolución/FPS
dentro de la sesión, detección explícita de escritorio estático ni cursor separado.
La resolución se selecciona al abrir/reconectar. No presentar esta etapa como
optimización máxima terminada ni como equivalente a webrtcsink con GCC.

## Correcciones encontradas durante la verificación

- La oferta SDP requería mantener vivo su objeto contenedor en Python GI;
  liberarlo antes de set-local-description causaba un fallo nativo. Corregido.
- El pipeline RTC inicialmente entregaba ~18 FPS. Reloj explícito GstSystemClock
  y latencia global cero recuperaron ~43–48 FPS en las muestras locales.
  Se desactiva sincronización adicional de nicesink cuando se crea.
- No se fuerza 60/1 en PipeWire: el monitor ofrece una fracción cercana a 60
  y esa restricción exacta producía «no more input formats».
- RTP usa MTU 1200 para dejar margen al transporte privado; sin B-frames,
  cola raw de un buffer y bitrate acotado. No se copian todos los cuadros a CPU
  como supuesto arreglo: la prueba de desactivar el pool no resolvió el límite.

## Evidencia y límites

1. Video sintético recibido por Chromium: 1280×720, 30 FPS (frecuencia de esa
   fuente), sin cuadros descartados.
2. Pantalla real: muestras locales de 43–48 FPS a 1536×864. En una ventana GTK
   animada, última muestra 43 FPS, 0 descartados, 0.286 Mbps de payload recibido,
   jitter buffer medio del intervalo 6.8 ms; CPU del capturador 39.1% de UN núcleo.
   Estos valores no son una medición de latencia extremo a extremo ni incluyen
   todos los bytes de Tailscale. Ver outputs/webrtc-local-measurement.json.
3. Misma escena de ruido sintético: al inyectar feedback de congestión, tráfico
   recibido bajó de 3.460 a 0.443 Mbps, con objetivo configurado de 350 kbps.
   Prueba la adaptación efectiva del encoder; **no simula una red móvil real**.
4. Cierre de preview: estado stopped y muestra de tres segundos con CPU 0.0%.
5. Falla WebRTC provocada: fallback HTTP reprodujo la pantalla (~43 FPS en
   comparación local). Sin invitación/QR adicional.
6. Endpoint RTC por Tailscale Serve sin autorización: 401. Tests rechazan origen
   ajeno, origen ausente y cuerpos >64 KiB antes de acceder al capturador.
7. Go race tests y vet; regresiones del cliente; tres pruebas de cierre/error/
   cancelación RTC y dos del controlador de bitrate.

Pendiente: Safari/iPhone físico, red móvil y ruta ICE/Tailscale seleccionada,
congestión real, batería/temperatura sostenidas y comparación de calidad a igual
bitrate. No prometer 60 FPS constantes ni menor energía solo por usar WebRTC.

Runtime: bibliotecas oficiales Ubuntu extraídas de forma aislada; instalación
reproducible en setup/install-video-runtime.sh. Los servicios conservan identidad,
token del portal y respaldo anterior. El shell web incluye rtc.js en el cache
versionado para que llegue mediante el mecanismo de actualización existente.
