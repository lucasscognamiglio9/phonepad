# Contrato de operaciones de entrada, versión 1

Estado al 20/09/2026: texto literal integrado por HTTP autenticado, negociado en la sesión v2 y conectado al adaptador Linux AT-SPI. Los lotes de adjuntos también tienen transporte y recibos, documentados en `file-transfer-contract.md`. La confirmación de acciones/atajos sigue pendiente: el protocolo `k` continúa activo para esas acciones. Ver `p01a-02.md`, `p01a-04.md` y `session-contract.md` para la evidencia y los límites de aceptación física.

## Identidad y contenido

Cada operación tiene `version`, `operationId`, `session`, `context` y `sequence`. Los identificadores admiten 1–64 caracteres ASCII alfanuméricos, guion y guion bajo. La secuencia es un entero positivo representable exactamente en JavaScript, creciente dentro de la sesión. Repetir un ID con otro contenido/contexto/secuencia es conflicto. Un ID y manifiesto idénticos recuperan la operación existente.

Familias del contrato que se implementan dentro de P01A, antes de extraerlas en P02:

| Familia | Contenido | Semántica |
| --- | --- | --- |
| `text.literal` | UTF-8, longitud en bytes, SHA256 y fragmentos ordenados | Texto exacto; nunca teclas por posición ni Enter implícito |
| `key.action` | Tecla lógica y modificadores explícitos | Navegación o atajo; no reinterpretar texto literal como acción |
| `attachments.publish` | Manifiesto ordenado de archivos verificados | Publicación del lote completo, separada de su subida |

`text.literal` y los lotes de adjuntos tienen implementación. `key.action` debe incorporar identidad, recibos y barreras compatibles con esos contratos; todavía no se anuncia como operación confirmada.

Manifiesto de texto, sin contenido personal:

```json
{"version":1,"operationId":"op-1","session":"session-1","context":"editor-1","sequence":1,"bytes":102400,"sha256":"<64 dígitos hexadecimales minúsculos>"}
```

Límites iniciales implementados: 128 KiB por texto, 16 KiB por fragmento, 128 fragmentos y 64 operaciones por registro de sesión. Soporta el objetivo mínimo de 100 KiB. No convertir bytes a caracteres para aplicar estos límites. Un fragmento puede dividir una secuencia UTF-8; se valida al reconstruir el bloque. Se rechazan UTF-8 inválido, NUL, checksum incorrecto, exceso de bytes y fragmentos fuera de orden. Se conservan CRLF, CR, LF, tabulaciones, normalización Unicode y emojis tal cual se recibieron.

El registro no elimina recibos para aceptar más operaciones. Al llenarse rechaza nuevas entradas; la futura capa de sesión debe negociar renovación, conservando el registro anterior consultable durante su lease. Debe limitar también el número total de registros, su memoria y retención. El núcleo limita datos de texto a 8 MiB por registro, más metadatos y capacidad de buffers. No es una implementación de almacenamiento durable.

## Estados y efecto permitido

| Estado | Significado | Recuperación |
| --- | --- | --- |
| `receiving` | Bloque parcial, nunca entregado al adaptador | Reanudar fragmentos del mismo ID; repetición idéntica es idempotente |
| `ready` | Longitud, checksum y UTF-8 verificados | El dispatcher puede reclamar la operación una sola vez |
| `dispatching` | El adaptador recibió el bloque | No reenviar aunque falte respuesta |
| `dispatched` | El adaptador terminó su llamada | No prueba que una aplicación arbitraria haya mostrado el texto |
| `uncertain` | No puede establecerse el resultado de la aplicación | Conservar borrador; revisar destino, sin repetición automática |
| `rejected` | Falló validación antes de entregar el bloque | Conservar borrador y explicar rechazo |
| `cancelled` | Cancelada antes de entregar el bloque | No inyectar |

`Claim` es la única salida de texto del núcleo y cambia `ready` a `dispatching` bajo mutex. Ni repetir commit ni dos dispatchers concurrentes permiten reclamarlo otra vez. Cancelar después de claim se rechaza, porque no podría garantizar que no hubo efecto. Un recibo inexistente significa **desconocido**, no “nunca ejecutado”.

## Condiciones de integración

Estos requisitos guiaron la integración del texto literal y continúan vigentes al ampliar acciones y proveedores. El camino texto→TLS/HTTP→AT-SPI tiene pruebas de aplicación GTK; las acciones confirmables y la matriz física de dictado/consumidores siguen abiertas.

1. El servidor crea la sesión opaca y la vincula al controlador autenticado. Nunca confiar en el campo `session` enviado por sí solo. Los leases/controladores anteriores no pueden inyectar. Al reiniciar el host, las sesiones previas no se recrean a partir del pedido del cliente.
2. La capa de transporte valida mensajes, negocia límites y envía recibos. Recupera operaciones por ID en la misma sesión y consulta las de una sesión anterior autorizada. Si el host perdió el registro, informa desconocido y no permite replay automático.
3. Un único dispatcher conserva el orden entre texto, navegación, clics y adjuntos. Antes de Claim verifica que el contexto siga vigente. La secuencia creciente al recibir no sustituye esta barrera de ejecución.
4. Un adaptador de texto devuelve resultado explícito. No conectar Claim directamente al `Injector.Text` actual, que usa keycodes US/clipboard de 40 ms y solo registra errores en el log. El proveedor debe conservar formatos, atender consumidores lentos y no restaurar sobre una copia posterior del usuario.
5. El móvil conserva borrador y composición provisional. No confirma dictado por timeout ni calcula sustituciones remotas mediante miles de Backspace. Cambios de foco/contexto invalidan eventos tardíos. La estrategia nativa precisa captura de eventos reales de iOS/Android.
6. Incorporar fragmentación con backpressure: el límite de 16 KiB de `Connection.send` y los límites del parser actual no se levantan sin actualizar ambos extremos. Control y ACK no deben quedar detrás de una ráfaga de texto. El cliente no limpia un borrador porque `socket.send` devolvió éxito.
7. Al perder confirmación después de Claim, mantener el resultado incierto. Un ACK del adaptador no es observación de contenido en la aplicación. Esa comprobación pertenece a la matriz física.

La UI actual habilita el envío literal solo con las capacidades negociadas del camino completo. Conserva el borrador hasta obtener el recibo y no añade Enter. Un servidor legacy no habilita este envío ni provoca una conversión automática a scancodes.
