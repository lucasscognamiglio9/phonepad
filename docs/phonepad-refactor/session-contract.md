# Contrato de sesión P02

Fecha: 20/09/2026. El protocolo de sesión envuelve los contratos existentes de [texto literal](input-operation-contract.md) y [adjuntos](file-transfer-contract.md). No sustituye sus identificadores, hashes o recibos.

## Negociación y compatibilidad

El cliente nuevo abre `/ws?protocol=2`. El servidor conserva `/ws` para clientes anteriores. El mensaje inicial mantiene `t: "ok"`; v2 agrega `protocolVersion: 2`, `compatibleVersions`, `sessionEpoch`, `capabilityRevision`, roles, permisos y capacidades. El objeto superior `input` de texto literal conserva el esquema P01A.

Un servidor anterior sin versión anunciada activa el perfil `legacy-v1`, con las funciones comunes anteriores. Una versión anunciada pero incompatible, o un mensaje v2 mal formado, detiene el control y muestra la incompatibilidad. Nunca se interpreta como autorización para volver a enviar texto mediante scancodes.

| Campo | Significado |
| --- | --- |
| `sessionEpoch` | Nonce de la conexión de control. Cambia al reemplazar o reconectar el WebSocket, también después de reiniciar el proceso |
| `capabilityRevision` | Revisión creciente de permisos y capacidades. El cliente ignora notificaciones anteriores o repetidas |
| `input.session` | Lease de operaciones literales P01A; tiene retención y cuota propias, independientes del nonce de control |
| `permissions` | `view`, `input`, `files`, `clipboard`; cada entrada declara `granted`, `revoked` o `unavailable` y puede dar un motivo |
| `capabilities.input` | Estado `available`, `unavailable`, `unsupported` o `unknown`, acciones admitidas `m/b/s/k/g/t` y si tienen efectos reales |
| `capabilities.literal` | Disponibilidad del contrato literal, separada del texto simulado por teclas de clientes anteriores |
| `capabilities.video` | `unknown` hasta consultar el proveedor de preview. La existencia del gateway no prueba una captura activa |

En este bloque, fuente y geometría se anuncian como no disponibles. No se inventan dimensiones, identidad de monitor, codec activo ni `geometryEpoch`. La conexión real de esos datos sigue pendiente en P02/P04.

## Permisos y cancelación

Todos los comandos v2 que producen input llevan `sessionEpoch`; ping queda fuera de esa validación. Los clientes v1 conservan el control por generación del socket. El servidor rechaza un comando sin permiso o con época vieja mediante `t: "rejected"`, un código estable y `fatal: false`. El socket y su heartbeat siguen vivos.

`SetPermissions` aplica una política del host, no una ACL por dispositivo. El pairing actual todavía comparte la credencial anterior. Al revocar input se liberan contactos/teclas y se retiran operaciones pendientes. Consultar recibos y cancelar staging sigue permitido para el cliente autorizado. Restaurar un permiso no reenvía automáticamente texto, acciones, movimiento o gestos anteriores.

Los archivos y el clipboard usan permisos independientes del input. Un host sin inyector puede compartir pantalla y recibir archivos si su política lo permite. Un token de mutación captura revisión y época antes de trabajar; el servidor lo revalida antes de publicar archivos o copiar al clipboard. La lectura HTTP y el hash de 100 MiB no mantienen el mutex de permisos. Revocar o cambiar de sesión se ordena con el mismo mutex que protege el efecto final.

La cancelación v2 puede incluir el manifiesto inmutable. Así reserva el recibo cancelado aunque el primer begin no haya llegado, sin exigir un permiso nuevo de subida. Cancelar un lote ya guardado devuelve su estado y conserva los archivos publicados.

La revocación de visualización todavía necesita detener la captura/media en el proveedor. Por ahora `SetPermissions` rechaza un cambio de `view` en vez de anunciar una revocación que el flujo RTP no aplica. Ese trabajo queda para P07 y los proveedores de captura.

## Cliente y contenido pendiente

Cambiar de equipo requiere resolver sus borradores y adjuntos. Un callback tardío del teclado sigue asociado al editor anterior. El cliente permite consultar, cancelar y descartar explícitamente contenido local después de perder permiso de input. Perder autorización para escribir no implica perder la posibilidad de limpiar una operación.

Un cambio de permisos de archivos no invalida un gesto de cursor activo. Una transición real de input sí invalida la generación local y descarta movimiento acumulado. El preview conserva su sesión cuando input se revoca. El selector nativo de fotos puede suspender temporalmente el control sin perder la selección; una subida activa se pausa y mantiene su manifiesto.

## Verificación y límites

Las suites Go ejercitan ambos protocolos, reconexión, épocas antiguas, permisos, publicación concurrente y cleanup. Las suites móviles comprueban el parser, que no haya fallback ante mensajes mal formados, el descarte de movimiento, revisión de borradores, varios hosts y mantenimiento del preview. Los logs de integración se registran en `estado.md`.

Estas comprobaciones no sustituyen instalación nativa, dictado real, consumo de archivos en aplicaciones finales ni medición física de latencia. P02 sigue abierto hasta resolver fuente/geometría, el ciclo de vida completo y la matriz de compatibilidad comprometida.
