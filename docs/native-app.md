> Estado actual: ver [verificación del 12/09](verificacion-2026-09-12.md) y [app nativa](../mobile/README.md). Este documento conserva detalles y estados históricos.

# Phonepad nativo — estado y decisiones

> Decisión actual: Lucas retoma la IPA personal gratuita y acepta renovar su firma cada siete días para conservar Phonepad, Liquid Glass y el receptor WebRTC nativo. La versión preparada es 1.0.0 (build 2), con actualizaciones inalámbricas compatibles. Firma e instalación en iPhone pendientes.

El flujo de instalación y publicación está en [mobile-setup.md](mobile-setup.md). La app nativa es el foco actual; no se cambiaron el cliente web ni el servidor durante esta revisión.

## Implementado

`mobile/` es una app Expo SDK 57 / React Native 0.86, con Expo Router. El video usa `@livekit/react-native-webrtc` y `RTCView`: los fotogramas no pasan por React ni JavaScript. La interfaz usa `expo-glass-effect` y SF Symbols; no es una WebView.

- Touchpad completo; movimiento agrupado cada 8 ms, sin renders React por movimiento.
- Tap izquierdo, dos dedos derecho, scroll, tres dedos arriba overview / dos veces apps.
- Preview conserva proporción, admite pinch zoom 1–4× y rotación sin renegociar el stream. En horizontal, controles en una franja lateral fuera del video y barra de estado oculta.
- Teclado e InputAccessoryView nativos, con Keyboard Controller para adaptar la preview al espacio libre y atajos en una sola fila en horizontal amplio. Sin micrófono propio ni barra de formularios de Safari. Dictado del teclado del sistema.
- Copy/Paste son comandos sobre el portapapeles de la laptop; no leen el del teléfono.
- Handshake y señalización con timeout, descarte de comandos viejos, recuperación ante video congelado, y cancelación/liberación del encoder con oferta tardía.
- Reconexión al volver al primer plano; suspensión del video y control en segundo plano. iOS no permite prometer una conexión permanentemente ejecutándose en segundo plano.
- Mantiene la autorización del nodo Tailscale ya fijado en el servidor. No hay contraseña/token maestro embebido. El hostname personal no es un secreto.
- TLS validado por el sistema, sin CA propia ni excepciones a certificados.
- EAS Update para correcciones compatibles, canal `personal` y runtime por fingerprint. Descarga sin bloquear el arranque ni iniciar transferencias durante la preview; aplicación al volver de segundo plano, antes de reconectar el control. Los cambios nativos requieren otra IPA. Una OTA no renueva la firma gratuita de Apple.

## Verificado y límites

Expo Doctor 21/21, dependencias compatibles con SDK 57. TypeScript, 25 pruebas JavaScript (17 de protocolo/control/video y 8 del ciclo de actualizaciones) y 8 pruebas de empaquetado. Los transportes, libwebrtc y las APIs de actualizaciones se simulan en las pruebas unitarias. También se compiló y enlazó el binario con Xcode, y se verificó la distribución real de una OTA. Esto **no equivale** a probar los gestos/Liquid Glass/VideoToolbox ni la actualización aplicada en un iPhone real.

La laptop es Linux. Lucas ya creó la cuenta Expo y conectó GitHub; la CLI de la laptop está autorizada como `lucas0expo`. No hay membresía Apple Developer ni Mac local. Se preparó una ruta personal de costo cero: EAS custom build sin credenciales Apple → IPA Release para iPhone → firma local gratuita con iloader por USB. La firma vence a los siete días; la renovación sigue siendo necesaria. La IPA actual, versión 1.0.0 (build 2), ya se compiló y descargó correctamente. Está sin firmar y todavía no hay instalación comprobada. Expo reporta plan Free, 2/15 builds iOS usados y costo estimado $0.

`eas.json` incluye el perfil `personal`, `withoutCredentials: true`, builder `medium`, Xcode 26.6, canal OTA `personal` y bundle incluido. El workflow no ejecuta publicación en tiendas ni TestFlight. Las pruebas de empaquetado rechazan un archive de simulador, un bundle ausente, permisos de grabación inesperados, un canal OTA incorrecto o fingerprint vacío. Proyecto EAS: `a424819c-da67-44c6-bf43-8a09b2e554a2`. Build actual finalizado: `5397c51e-d6c1-4103-a811-f150d0eafbcd`, 2026-09-09 22:55 UTC. Release con Xcode 26.6 / SDK iPhoneOS 26.5, 15.838.168 bytes, arm64, bundle incluido, libwebrtc y Expo Updates presentes. Hash y ZIP verificados al descargar. SHA-256: `cc2a3fba8a25fec49131483b850c1eb88f45906b1ff53e498a34074ecf671d37`. Firma personal e instalación pendientes. Los perfiles development, preview, testflight y production permanecen disponibles para otros flujos; el presupuesto actual sólo autoriza la ruta personal gratuita.

La OTA publicada `01a0885f-aeb9-7f86-a558-9abafdc5ee7a`, grupo `4e755387-0da7-4061-ba0a-be568d44b45f`, coincide con el runtime embebido `1474787615b80178d88e3c34f427ccb39a1449fe`. El endpoint de Expo respondió HTTP 200 con el manifiesto correcto; se descargaron y verificaron por SHA-256 sus 24 recursos (3.165.364 bytes descomprimidos). Una consulta con runtime incompatible devolvió HTTP 204, sin actualización. No se ha comprobado aún una descarga/aplicación real en el iPhone. La primera IPA, sin OTA, quedó reemplazada antes de instalarla.

El receptor nativo inicia H264 para compatibilidad con libwebrtc de @livekit/react-native-webrtc 144.1.2. HEVC del navegador se negocia aparte. La compilación y el enlace de esa dependencia con RN 0.86 pasaron en Xcode/EAS. La recepción de video, VideoToolbox, gestos y Liquid Glass en este iPhone todavía necesitan una prueba del binario instalado.

## Transmisión: hallazgos comprobados

GNOME reportaba tamaño lógico 1536×864 con escala fraccional; PipeWire entrega **1920×1080 físicos**. Se usaba el dato lógico para reescalar, perdiendo detalle. Ahora las caps negocian la resolución física con límite 1920×1080 sin escalar artificialmente un origen menor.

En el navegador también había un límite por tamaño CSS/DPR: 369 px de ancho × DPR máximo 2 = 738 px solicitados. Ahora el stream solicita los píxeles del escritorio, independientemente de la miniatura. Se abre ampliado y no se reinicia al rotar/ampliar.

H264 arrancaba a 2 Mbps y recuperaba 150 kbps cada tres segundos buenos. Ahora arranca a 6 Mbps y recupera 25% (mínimo 300 kbps) cada dos muestras buenas; techo 12 Mbps, caída bajo pérdida/colas. RTT remoto estable ya no se interpreta por sí solo como congestión. **Sigue siendo AIMD propio, no GCC**. VBR no equivale a tráfico constante ni límite exacto en la red.

Medición local posterior: 1920×1080, 33–39 FPS en muestras sucesivas, 0 frames descartados, encode P95 5.93 ms, decode medio 4.50 ms, jitter buffer 6.89 ms. Es una muestra, con carga concurrente en la laptop, y no mide latencia extremo a extremo ni la red celular del iPhone. No se suma esto y se presenta como glass-to-glass.

El plugin HEVC de esta GPU funciona con quality-level 7, pero falla con 5. Prueba sintética de 180 frames NV12 1080p: H264 nivel5 3.193 s; HEVC nivel7 3.187 s. Incluye generación de imagen y arranque, **no** es medición de latencia por frame ni comparación de calidad a igual bitrate. Se añadió negociación HEVC anunciada por el navegador con fallback H264; recepción HEVC en iPhone pendiente.

## Refactor que merece evaluación posterior

1. Sustituir el control AIMD HTTP de 1 s por GCC/TWCC con pacing nativo. GStreamer's `rtpgccbwe` ofrece estimación y pacing, necesita TWCC y conectar bitrate estimado al encoder. No está instalado en este runtime; no basta con llamarlo WebRTC para tenerlo.
2. Medir captura GNOME/PipeWire y comparar con Sunshine/Moonlight (receptor nativo) sobre el mismo hardware/red. Sunshine soporta VAAPI y Portal/KMS; no se ha instalado ni medido. Evitar permisos KMS ampliados sin demostrar que resuelven el cuello de botella.
3. Benchmark HEVC/H264 con texto y cambios de ventana, igual calidad, CPU/GPU y bitrate real. AV1 no está disponible como encoder hardware en este runtime: usar software sin medir puede empeorar el objetivo.
4. Captura adaptada a daño de pantalla, cursor independiente y pacing de frames. Son trabajo pendiente, no características entregadas.

## Fuentes primarias

- https://docs.expo.dev/versions/v57.0.0/sdk/glass-effect/
- https://docs.expo.dev/versions/v57.0.0/sdk/updates/
- https://docs.expo.dev/eas-update/runtime-versions/
- https://docs.expo.dev/skills/
- https://github.com/livekit/react-native-webrtc
- https://gstreamer.freedesktop.org/documentation/rsrtp/rtpgccbwe.html
- https://gstreamer.freedesktop.org/documentation/rswebrtc/webrtcsink.html
- https://docs.lizardbyte.dev/projects/sunshine/latest/
- https://moonlight-stream.org/
- https://webkit.org/blog/15443/news-from-wwdc24-webkit-in-safari-18-beta/
