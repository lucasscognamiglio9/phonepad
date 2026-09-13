# Preview nativa acelerada — 2026-09-09

Instalado: captura PipeWire mediante portal de Linux, selección persistente si
el portal la permite, conversión/escalado VA-API, H.264 Intel VA-API VBR 6 Mbps,
sin B-frames, GOP máximo30, fragmentos MP4 de100ms, reproducción MSE o
ManagedMediaSource. Máximo1920x1080 conservando proporciones sin aumentar origen.
La versión JPEG de diagnóstico fue reemplazada, no se usa para transmisión.
La captura solo se codifica con una preview activa. Cerrar cancela HTTP y libera
pipeline; al reabrir se crea un stream MP4 independiente, sin cuadros anteriores.
La sesión del portal permanece para evitar volver a elegir monitor.

Medición real con movimiento de cursor, Chromium local, 6.5s:1536x864,
45.69 FPS, cero cuadros descartados, promedio0.665Mbps, buffer final0.178s.
CPU del proceso capturador35.27% de UN núcleo durante la muestra, no del total.
CPU en reposo de una muestra de2s tras cierre:0.00% de un núcleo.
El búfer no es una medición de latencia extremo a extremo. No se prometen60fps.
Codificador sintético1080p60:180 cuadros en2.15s; modo low-power falla negociación,
por lo que NO se activa. Usa controlador completo Intel distribuido por Ubuntu
multiverse en runtime aislado. No se cambian bibliotecas globales ni permisos GPU.

UI: Desktop muestra imagen real dentro de Phonepad. No minimiza ventanas.
Sin Web Speech API, sin Voz. Teclas rápidas12, dos filas de6 (una de12 en
horizontal), sin scroll. Controles SVG. Las flechas/✓ y dominio de Safari son
interfaz del navegador y no se pueden retirar mediante CSS de Phonepad.
El input interno mínimo se conserva únicamente para teclado nativo y dictado iOS.

Validación: reproducción de pantalla real y screenshot; pruebas Go race/vet,
11 regresiones JS; prueba del gateway de video:sin autorización401, origen ajeno403.
No se ha probado todavía la reproducción ManagedMediaSource en el iPhone físico
ni el rendimiento de esta nueva transmisión usando datos móviles. No equiparar
estas mediciones locales con rendimiento entre redes.

Instalación reproducible Ubuntu amd64:setup/install-video-runtime.sh prepara
bibliotecas aisladas; setup/install.sh instala capturador si video.env existe.
Dependencias base:GStreamer/PipeWire/PythonGI/Gst. No exponer el socket Unix:
Go aplica la misma autorización del iPhone antes de servir status/video.
