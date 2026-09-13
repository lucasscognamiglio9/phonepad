# Auditoría de requisitos — 13 de septiembre de 2026

Revisión del pedido completo, incluidos los tres puntos del último prompt y
las correcciones anteriores. La implementación móvil auditada es `a6f6713`;
su actualización publicada es `01a09897-3290-7f67-9927-f2c025c649b1`, canal
`personal`, compatible con el cliente nativo build 4.

## Pedido principal

| Pedido | Implementación y evidencia | Validación restante |
| --- | --- | --- |
| La UI se rompe al girar o abrir/cerrar teclado | Video sin KeyboardAvoidingView; desplazamiento cero explícito del campo; pruebas de giros repetidos, medidas de teclado antiguas y vista previa apagada | Comprobar la versión actual en el iPhone |
| Revisar todos los atajos y controles | Pruebas de Esc, Tab, cuatro flechas, Ctrl/Alt/Super/Shift y combinaciones; Go verifica orden de pulsación y liberación | Confirmar su uso en las aplicaciones elegidas del escritorio |
| Return del teclado no envía; solo Enter del campo envía | Return produce Shift+Enter, sin Enter simple ni texto con salto ASCII; el botón envía una sola vez y limpia modificadores | Confirmar en el campo de chat usado en la laptop |
| Copy/Paste deben entenderse | Etiquetas visibles Copiar/Pegar; Ctrl+C/Ctrl+V probados | Los terminales pueden requerir Ctrl+Shift+V, disponible con modificadores |
| Repositorio limpio, guardado y sincronizado | Código publicado en `lucasscognamiglio9/phonepad`, rama `improve/remote-desktop`; identidad y permiso verificados | Verificar nuevamente el estado remoto después de guardar este informe |

## Pedidos anteriores conservados

| Pedido | Evidencia y estado |
| --- | --- |
| Campo compacto que se expande; escritura inmediata; + y Enter integrados sin fondo propio | Pruebas del componente, posición y reconciliación de texto; falta aceptación visual del renderizado nativo |
| Flechas tipo WASD ocultas hasta abrir el resto | Prueba de ausencia inicial y aparición dentro de Teclas extra |
| Liquid Glass real y más transparente | GlassView nativo, estilo clear; respeta Reducir transparencia y disponibilidad del sistema |
| + superpuesto sin desplazar el campo, responsive | FullWindowOverlay en iOS; foco y cierre probados; 2.744 combinaciones de geometría pasaron con siete tamaños, ambas orientaciones, cuatro alturas de teclado y anclajes actuales/antiguos |
| Cámara, Fotos y Archivos reales hasta la laptop | Selectores nativos, permisos/cancelación/transferencia probados; imagen y documento pegados realmente en Chromium con hashes idénticos en la integración previa; falta prueba de cámara física en la versión actual |
| Adjuntar sin enviar un prompt automáticamente | El upload no emite teclas; Pegar ahora requiere acción explícita y no emite Enter |
| Horizontal inmersivo, controles verticales que se ocultan | Pruebas de barra lateral, áreas seguras y conservación de la sesión de video |
| Cursor visible | Confirmado anteriormente por el usuario; servidor de cursor conservado |
| Sensación de trackpad; no clics al mover ni arrastre trabado | Nueva prueba real con libinput: los nueve controles pasaron, incluidos tap, clic derecho, scroll, pinch, swipe, doble toque/arrastre y cancelación sin clic; el dispositivo de prueba estuvo capturado en exclusiva |
| Actualización completa y sin repetir cable | Build 4 nativo ya instalado y runtime compatible; los 24 archivos de la actualización publicada coincidieron byte por byte con el paquete local |
| Más de 90 FPS sostenidos en el iPhone | Criterio pendiente: los benchmarks de captura o del receptor local no prueban presentación sostenida en el iPhone; no hubo muestras nativas en la ventana reciente consultada |
| No volver a mostrar mensajes viejos en Codex móvil | Problema separado del cliente Codex, reproducido al recuperar historial; no resuelto por los cambios de Phonepad |

## Comprobaciones de esta auditoría

- Pasaron los diez archivos de pruebas móviles, TypeScript y ocho pruebas de
  empaquetado iOS. No se detectó un nuevo fallo de código en esta revisión.
- Pasaron las nueve comprobaciones del dispositivo virtual con libinput real.
- Pasaron las 2.744 combinaciones de límites del menú. Es una prueba de geometría,
  no una captura ni una prueba visual del iPhone.
- La inspección de nombres de los 842 archivos versionados antes de añadir este
  informe no encontró cachés, instaladores, archivos temporales ni archivos
  privados con las extensiones y nombres excluidos por el repositorio.
- Los diagnósticos y experimentos documentados se conservan como fuente; no se
  eliminan trabajos válidos para conseguir un árbol aparentemente limpio.

La aprobación visual/táctil en el teléfono y el criterio de rendimiento siguen
abiertos hasta contar con evidencia. Las pruebas anteriores no acreditan ausencia
absoluta de errores. No hay motivo para reinstalar ni cambiar las credenciales Apple.
