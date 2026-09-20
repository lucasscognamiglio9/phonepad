# P02.7: configuración versionada y rollback

Fecha: 20/09/2026. Este bloque conserva la credencial y los dispositivos al actualizar o volver a una versión anterior. No introduce todavía identidades individuales por dispositivo; eso pertenece a P07.

## Emparejamiento del daemon

`pairing.json` conserva los campos `token` y `paired` del servidor estable. La versión nueva añade `version: 1`. Leer un archivo legacy válido no lo reescribe ni rota el token. La siguiente mutación explícita, como confirmar un emparejamiento o rotar su credencial, guarda el campo de versión.

El parser estable puede leer ese objeto porque ignora el campo adicional. Si la versión anterior vuelve a escribirlo sin `version`, una actualización posterior lo reconoce como legacy y conserva `token` y `paired`. Este es el alcance del rollback P02; una futura política de permisos por dispositivo necesita una migración nueva con su propia matriz.

La auditoría encontró que `Open` podía regenerar el token ante JSON dañado o errores de lectura. Ahora solo crea una credencial cuando el archivo no existe. JSON inválido, versiones desconocidas, campos no reconocidos y errores de lectura devuelven un error y conservan el archivo. La lectura tiene un límite de 64 KiB y los mensajes no incluyen el token. No se interpreta una configuración futura como una instalación vacía.

La recuperación de un archivo inválido requiere conservarlo para diagnóstico y restaurar una copia válida o crear un emparejamiento por una acción explícita del usuario. La migración nunca borra claves ni reduce permisos de forma implícita. P11 incorporará esa recuperación en el instalador/interfaz del host.

## Equipos guardados en el móvil

P02-01 ya usa `HostSettings.version: 1` con revisiones y dos archivos de journal. El parser comprueba cada equipo, ID, origen HTTPS y selección. No agrega automáticamente el host personal que antes estaba compilado en `COMPUTER`. Una primera instalación elige/configura un equipo y usa ese mismo origen para video, input, archivos y clipboard.

El almacenamiento conserva la última revisión válida si una escritura se interrumpe. Una versión desconocida o una lectura corrupta bloquea la escritura sobre esos datos. Los archivos están separados de cookies y credenciales de emparejamiento. Volver a la app estable no migra esos archivos hacia el host fijo ni los borra: la app estable no implementa el selector. Reinstalar/desinstalar y restaurar datos mediante mecanismos del sistema operativo sigue pendiente de la prueba física.

## Verificación

`daemon/internal/pairing/migration_test.go` prueba lectura legacy sin cambios, escritura v1, lectura/escritura con el esquema anterior, actualización posterior y conservación exacta de archivos futuros, incompletos o demasiado grandes. La suite se ejecutó con el detector de carreras. Las pruebas existentes de host settings cubren versión, journal, escrituras interrumpidas, revisiones concurrentes y conservación ante corrupción.

La prueba de transporte entre versiones pasó en ambas direcciones con el código estable `adab7c77` y se registra en `p02-07-compatibility.md`. La simulación del esquema de pairing anterior no equivale a ejecutar el binario nativo anterior ni a verificar toda la instalación.
