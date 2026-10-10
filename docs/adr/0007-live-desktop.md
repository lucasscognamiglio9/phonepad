# Escritorio en vivo: captura local y WebRTC entre navegadores

Phonepad mantiene Go, PWA sin framework y entrada uinput. El daemon agrega un
relay de señalización de SDP/ICE; el video comprimido viaja entre navegadores
por WebRTC. No hay capturas periódicas, servidor de video, STUN/TURN externo,
cuentas, grabación ni costos de servicio.

La página `/share` solo abre en loopback. El operador inicia `getDisplayMedia`
con un clic y selecciona pantalla/ventana en el navegador/portal de Linux.
No se solicitan cámara, micrófono ni audio del escritorio. El receptor requiere
pairing. Origen WebSocket se valida para control y señalización. Captura
apagada de inicio; cerrar la página o detenerla libera las pistas. Un solo
publicador y un solo receptor; reemplazarlos cierra el anterior.

Elegimos esta solución para aprovechar la captura consentida de Wayland y los
codecs interoperables de navegador sin introducir un servicio nativo de video.
La contrapartida es mantener una pestaña de laptop abierta y volver a autorizar
la captura después de cerrarla. La negociación selecciona el codec común; no
forzamos un codec que Safari o el emisor no puedan usar.

El video usa `object-fit: contain`: conserva aspecto sin recortar. Vertical:
video arriba, touchpad abajo. Horizontal: lado a lado. Ampliar 2× permite leer y
desplazar la vista; no altera coordenadas del touchpad. El pad reenvía contactos
relativos normalizados, por lo que monitores y escalas no requieren mapear clics
absolutos. Pinch sobre el pad sigue siendo gesto del escritorio. Sobre la vista
se reserva la interacción para inspeccionar video. No se promete control táctil
absoluto ni paridad de gestos entre compositores.

Se muestran FPS y resolución recibidos; ausencia de frames se indica como
ambigua (pantalla quieta o corte), sin presentar una imagen congelada como
“en vivo”. El RTT de control no es latencia del video. Cerrar/reabrir la vista
renegocia el video tras un corte; el control sí reconecta automáticamente.

Restricciones: sin relay no atraviesa redes aisladas, NAT o Wi-Fi con client
isolation. No abrir puertos del router. El servidor arranca en loopback y
requiere `--bind IP_PRIVADA` para LAN; mantiene otro listener loopback para el
operador. HTTPS confiable requiere configurar certificados en dispositivos.

Evidencia: WebRTC con fuente canvas de prueba alcanzó 29 fps a 1280×720 entre
dos Chromium locales. No equivale a captura física ni a prueba Safari/iPhone.
Portal ScreenCast de GNOME y PipeWire presentes; selección de escritorio
pendiente de una prueba física completada por el operador.

Fuentes: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia
https://webkit.org/blog/8672/on-the-road-to-webrtc-1-0-including-vp8/
