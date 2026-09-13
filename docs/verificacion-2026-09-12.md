# Verificación del 12 de septiembre de 2026

## Correcciones

- Eliminado KeyboardAvoidingView alrededor de la transmisión. La vista de video
  queda independiente de las notificaciones y animaciones del teclado.
- Solo el composer flota con el teclado; al cerrar asigna desplazamiento cero,
  incluso si no llega el evento de ocultación o quedan medidas de otro giro.
- Ancho limitado al viewport actual durante la animación. Teclas extra con scroll
  cuando la altura disponible es corta.
- Return nativo agrega una línea mediante Shift+Enter. Solo Enter del composer
  emite Enter simple; descarta los modificadores pendientes para enviar.
- Copiar/Pegar y Esc/Tab con etiquetas visibles. Regresiones para todas las teclas
  expuestas y para la liberación ordenada de modificadores en el inyector Linux.

## Comprobaciones

Pasaron los 10 archivos de pruebas móviles, TypeScript y 8 pruebas de empaquetado
iOS; los 2 archivos de pruebas web; Go completo con detector de carreras, vet y
compilación; 22 pruebas Python de captura/WebRTC con el runtime instalado y 4 de
métricas HFR. La prueba nueva del inyector verifica orden de teclas sin emitir
input en el escritorio del usuario. La exportación iOS terminó correctamente y
el fingerprint nativo coincide con build 4. La actualización se publicó en el
canal personal: `01a09897-3290-7f67-9927-f2c025c649b1`. La descarga real del canal
respondió HTTP 200 y sus 24 archivos (3.944.680 bytes) coinciden byte por byte con
el paquete local. Runtime: `e08438daeafaecc3eeddd87e38c6004b670a3d9c`.
La inspección visual de esta versión en el iPhone queda pendiente. No se modificó
el servidor de transmisión ni se atribuye una nueva medición de FPS al dispositivo.

También se conservaron y revisaron los resultados de integración previos: los
nueve controles del touchpad virtual pasaron con libinput y captura exclusiva
del dispositivo de prueba; una imagen y un documento llegaron mediante Ctrl+V
real a Chromium y sus hashes coincidieron con los archivos de prueba del servidor.
Estos resultados no sustituyen una prueba de cámara física ni la revisión visual
del iPhone después de esta actualización.

## Repositorio

Se conserva el código, pruebas, configuración de build y herramientas de diagnóstico.
Se excluyen credenciales, configuración privada local, artefactos, dependencias y
cachés. Se eliminó únicamente bytecode Python generado y no versionado.
