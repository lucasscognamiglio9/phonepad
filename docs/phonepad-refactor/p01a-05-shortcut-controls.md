# P01A-05: estado visible de teclas y atajos

El compositor mostraba flechas, Esc, Tab, Copiar y Pegar habilitados aunque
`canSendKey()` rechazaba su uso ante un borrador literal o envío pendiente.
El tap no enviaba nada y tampoco explicaba por qué. Los modificadores y Enter
tenían condiciones distintas, lo que producía estados visuales inconsistentes.

`NativeKeyboard` ahora comparte la condición de deshabilitado entre todas
esas acciones. Incluye borrador literal, recibo pendiente, envío en curso,
revisión necesaria, visibilidad y permiso de entrada. Cuando se abre el panel
de atajos con contenido pendiente, el mensaje indica enviar el borrador con
Escribir o consultar/revisar el envío anterior. La protección del handler se
conserva para eventos que lleguen después de un cambio de estado.

Verificación: las 29 pruebas existentes del compositor y TypeScript pasaron.
Logs en `outputs/p01a-04/shortcut-controls-test.log` y
`outputs/p01a-04/shortcut-controls-typecheck.log`. No se cambiaron dependencias
nativas ni el protocolo y no se generó una nueva IPA/APK para este ajuste.

## Continuación de acciones confirmadas

Este cambio no confirma la ejecución remota. `Connection.send()` solo informa
admisión local en el socket; `Injector.Special/Combo` todavía devuelve `void`.
P01A conserva pendiente el resultado del proveedor, identidad y deduplicación
de `key.action`, recibos recuperables y cancelación antes de despacho.

El próximo bloque debe ampliar el contrato de `input-operation-contract.md`
y usar la FIFO existente. La interfaz del proveedor debe distinguir rechazo,
despacho e incertidumbre antes de anunciar una capacidad confirmable. No se
puede convertir el retorno del socket o la entrada a una cola en un recibo de
ejecución. La negociación debe conservar las acciones comunes de peers viejos
y los recibos nunca deben provocar reintento automático de un atajo incierto.

P01A sigue abierta para ese bloque, proveedores de texto alternativos,
repetición controlada de flechas y aceptación de dictado/consumidores físicos.
