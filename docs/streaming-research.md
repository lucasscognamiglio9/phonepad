# Decisión de transmisión — 2026-09-09

Estado: investigación y propuesta de arquitectura; WebRTC nativo todavía no
implementado ni medido en el iPhone. La implementación vigente es H.264 VA-API
en MP4 fragmentado sobre HTTPS. JPEG ya no forma parte de esa ruta.

## Recomendación para Phonepad

Conservar captura autorizada por portal/PipeWire y codificación Intel por GPU.
Evaluar WebRTC con H.264 como transporte principal, con control de congestión
que modifique realmente el codificador. Mantener HTTPS/MSE como fallback
automático mientras se verifica conectividad WebRTC entre redes mediante Tailscale.
Es la opción mejor ajustada a la UI web actual, no un máximo universal demostrado.

| Alternativa | Ventaja | Coste / decisión |
|---|---|---|
| JPEG continuo | Implementación sencilla | No aprovecha redundancia temporal; descartado para video continuo |
| H.264 GPU + MP4/HTTPS actual | GPU comprobada; misma autorización y ruta HTTPS | Fragmentación, buffering y entrega ordenada; sin adaptación del encoder a la red |
| H.264 GPU + WebRTC | Feedback de red, reproducción de tiempo real, adaptación | Integración ICE, autorización de señalización y pruebas reales necesarias; recomendada |
| Sunshine + Moonlight | Motor existente de baja latencia con hardware encoding | Cliente distinto; no integra por sí solo la preview dentro de Phonepad; referencia comparativa |
| HEVC / AV1 | Candidatos para mejorar compresión | No elegir sin verificar encoder GPU, negociación Safari y latencia/energía en ambos extremos |

WebKit documenta H.264 acelerado por hardware y ajustado para comunicación en
tiempo real. Es una base compatible; no prueba el gasto energético específico
del iPhone 17. [WebKit](https://webkit.org/blog/8672/on-the-road-to-webrtc-1-0-including-vp8/)

GStreamer webrtcsink incorpora feedback transport-wide y adaptación del encoder,
mitigación de pérdida y ajuste de resolución/FPS. Precaución fundamental:
entregarle H.264 ya codificado no obtiene automáticamente esa adaptación del
encoder. Integrar la selección del encoder hardware dentro de webrtcsink o,
si no lo permite el runtime, usar webrtcbin con feedback/control explícitos.
No dar por hecho que cambiar solamente el contenedor resuelve congestión.
[Diseño](https://gstreamer.freedesktop.org/documentation/rswebrtc/index.html),
[propiedades](https://gstreamer.freedesktop.org/documentation/rswebrtc/webrtcsink.html),
[advertencia sobre entrada codificada](https://origin.gstreamer.freedesktop.org/releases/1.24/).

## Optimización que debe acompañar el transporte

- Capturar y codificar solo con preview visible; detener al cerrar o pasar a
  segundo plano. Autenticación persistente no significa video permanente.
- Resolución según tamaño visible y detalle requerido. Subir al ampliar;
  no enviar siempre el escritorio máximo para una tarjeta pequeña.
- FPS según actividad: objetivo hasta 60 durante movimiento si origen y red
  lo permiten; reducir trabajo en imagen estática. No duplicar frames para
  alcanzar una cifra. Separar cursor del video es una optimización posterior,
  condicionada a metadata del portal y sincronización correctas.
- Bitrate adaptativo con margen, recuperación gradual y límite de consumo;
  un VBR fijo de 6 Mbps no equivale a adaptación a ancho de banda disponible.
- Colas cortas antes de codificar, sin B-frames para evitar reordenamiento.
  No descartar arbitrariamente frames H.264 de referencia ya codificados.
- Verificar caps y transferencias CPU/GPU. VA-API no demuestra por sí mismo
  cero copias desde PipeWire. Preferir ruta GPU cuando sea compatible y medir.
- Una sola codificación para este único receptor; sin simulcast innecesario.
- Control del mouse independiente del video; no retrasarlo detrás de frames.

El plugin VA moderno admite superficies GPU y configura bitrate y velocidad/
calidad. No migrar de plugin solo por nombre; el instalado usa vaapih264enc y
el modo low-power falló la prueba local. Mantenerlo desactivado hasta resolverlo.
[VA encoder](https://gstreamer.freedesktop.org/documentation/va/vah264enc.html).

## Red y seguridad

Tailscale directo suele dar menor latencia y mayor rendimiento que DERP.
WebRTC sobre la red privada no garantiza que el túnel subyacente sea directo.
Registrar tipo de conexión y ruta ICE seleccionada en cada benchmark; no
atribuir un problema del relay al codec. Serve lleva HTTPS/señalización, no
es un proxy de los paquetes multimedia UDP de WebRTC.
[Tailscale](https://tailscale.com/docs/reference/connection-types).

Mantener autorización por dispositivo antes de crear sesiones multimedia,
validación de origen, cierre/revocación de sesiones, límites de recursos y
ausencia de exposición pública accidental. La identidad Tailscale existente
debe proteger también la nueva señalización. No instalar CA ni permitir
captura a cualquier miembro de la red por introducir WebRTC.

La selección de pantalla continúa usando el portal y su token de restauración,
sujeto a permisos del sistema.
[Portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html).

Sunshine es una referencia útil para comparar consumo y latencia; soporta
codificación hardware y clientes Moonlight. No demuestra que cambiar a ese
producto sea mejor para la experiencia integrada pedida.
[Sunshine](https://docs.lizardbyte.dev/projects/sunshine/latest/?lng=en-US).

## Validación antes de sustituir la ruta actual

Comparar misma resolución, escena, duración y red: escritorio estático, scroll
de texto, arrastre de ventana y video. Probar preview pequeña y ampliada,
Wi-Fi directo, red móvil, pérdida y ancho de banda limitado. Las restricciones
artificiales deben aislarse al tráfico de prueba, sin cortar la sesión del usuario.

Medir FPS presentados, frames perdidos, bitrate real incluyendo transporte,
CPU por núcleo, GPU, memoria, energía y temperatura en sesiones sostenidas.
Registrar tiempo al primer frame, reconexión, latencia de entrada y latencia
visual p50/p95. RTT y duración del buffer no son latencia de extremo a extremo.
La medición visual necesita un método con relojes coordinados o captura externa;
no inventarla a partir de una estadística de navegador.

El candidato debe reducir retraso bajo congestión sin consumo/legibilidad peor
en condiciones equivalentes, recuperar red sin QR, y dejar de codificar al
cerrar preview. Verificar Safari/iPhone real; Chromium local es solo una etapa.

Base existente: 45.69 FPS a 1536×864, 0.665 Mbps en muestra corta con movimiento
de cursor, CPU 35.27% de un núcleo, buffer 178 ms. No representa video intenso,
consumo de batería, latencia real ni rendimiento celular. Ver preview-hardware.md.

Orden de implementación: prototipo WebRTC aislado con encoder hardware y feedback
verificado; comparación reproducible; integración de señalización autenticada y
fallback; adaptación por viewport/actividad; pruebas de ciclo de vida y dispositivo.
