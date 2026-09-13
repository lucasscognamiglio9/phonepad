# Phonepad — estado al 9 de septiembre de 2026

## Instalación real

- Laptop: GNOME Shell 50.1, luque-ThinkPad-T490, LAN 192.168.1.134.
- Servicio de usuario instalado, active y enabled. Modo real (demo=false).
- HTTPS verificado con la CA correspondiente en localhost y en
  luque-ThinkPad-T490.local. mDNS resolvió a la IP actual de la laptop.
- Token persistente de producción separado de tokens de benchmark/demo.
- Extensión Phonepad v2 copiada y agregada a enabled-extensions. GNOME todavía
  no la reconoce en la sesión actual: falta cerrar sesión y entrar una vez.
  No se afirma que el botón ya sea visible ni que su interacción se haya probado.
- iPhone informado por el usuario: iPhone 17, iOS 26. Confianza de CA en el
  teléfono pendiente de autorización explícita; no se instaló un perfil allí.

## Rendimiento: datos y límites

La prueba anterior estaba limitada a 30 fps en la fuente y en la captura.
Ahora hay perfiles 1080p/60, 720p/60 y 720p/30, con adaptación de WebRTC.

Fuente canvas 1920×1080/60, dos Chromium en la misma laptop (comparten CPU):
10 muestras VP8 dieron 29–50 fps, media 38.6.
Esto NO demuestra 60 fps sostenidos ni latencia real desde el iPhone.
Un ejemplo de muestra tuvo 12.82 ms de codificación y 8.74 ms de decodificación;
el receptor acumulaba alrededor de 68 ms de búfer promedio de esa sesión.

Forzar H.264 no produjo una mejora consistente: hubo adaptación a 640×360 y
15 fps al inicio y recuperación posterior. No se adopta esa preferencia.
Las mediciones fueron secuenciales, con carga variable; no constituyen una
comparación controlada ni una conclusión universal sobre codecs.

Con sugerencia de búfer de 20 ms se observaron ~10 ms de espera media, pero
hubo limitación CPU y caída a 720p/16–17 fps en una muestra. No se atribuye
causalidad ni se afirma menor latencia extremo a extremo. La API es una
preferencia con detección de soporte, no una reducción garantizada en Safari.

No se probó aceleración de video por hardware. El dato de implementación de
encoder fue null; no permite concluir si se usó CPU o hardware en cada caso.
La limitación CPU sí fue reportada por WebRTC en una muestra. No conviene
cambiar Go o reescribir el cliente basándose en estos resultados.

## Próxima medición útil

En iPhone real: compartir monitor mediante portal GNOME, mover ventana/texto,
probar 1080p/60 durante un minuto y comparar 720p/60. Registrar FPS, codec,
codificación, CPU, pérdida/búfer y retraso visual filmando ambas pantallas.
Si la captura/codificación del navegador limita: evaluar emisor nativo
PipeWire con encoder de hardware conservando WebRTC. El emisor nativo también
permite investigar restauración consentida de sesión de captura; actualmente
el navegador requiere elegir pantalla por sesión, separado del pairing.

## Verificación

Go tests con race pasan, incluido rechazo de fuentes públicas aun con token
correcto. Build y vet pasan. Benchmark reprodujo video en dos navegadores sin
errores JS registrados. Servicio instalado sigue activo; instancias de test
son independientes y se detienen al concluir. Queda pendiente prueba física
completa de cursor/gestos, captura de escritorio e iPhone.

Fuentes: https://gjs.guide/extensions/topics/quick-settings.html
https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/setParameters
https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/jitterBufferTarget
