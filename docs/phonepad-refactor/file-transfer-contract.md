# Transferencia de adjuntos v2

P01A-04 amplía el contrato de operaciones de P01A. La ruta v1 `/api/file-batches` continúa disponible para clientes anteriores. El cliente nuevo exige la capacidad v2 antes de abrir el selector; un servidor anterior muestra una actualización necesaria y no recibe un envío parcial como alternativa.

## Recorrido

1. `GET /api/file-transfers` negocia versión, cantidad, bytes totales, tamaño máximo de bloque y TTL. Los límites iniciales son 20 archivos, 100 MiB por lote, 1 MiB por bloque y 24 horas. El cliente utiliza bloques de hasta 256 KiB para limitar memoria y trabajo del hilo JS. Solo hay un PUT activo por servidor; los demás reciben 429 recuperable.
2. El usuario revisa la lista y puede quitar archivos. No se empieza a subir al cerrar el selector nativo. Las fotos mantienen el orden proporcionado por el selector; la cámara captura un archivo.
3. El teléfono copia los archivos a un directorio propio, por bloques acotados, y calcula SHA-256 de los bytes de cada copia. Nombres, MIME, tamaños reales, hashes y UUID forman el manifiesto. Reintentar reutiliza esa copia, aunque el documento original haya cambiado.
4. `POST ?action=begin`, con el manifiesto JSON, crea o consulta la misma identidad. El servidor rechaza cambiar el manifiesto de un UUID existente. Los nombres repetidos conservan todos sus archivos mediante prefijos `1-`, `2-`, etc.
5. `PUT ?id=UUID&index=N&offset=BYTES` lleva bytes binarios y `X-Chunk-SHA256`. El servidor valida hash, límites y solapamiento; rechaza huecos o contenido diferente. Un bloque repetido puede coincidir con el prefijo recibido y completar su sufijo. El ACK sigue a la sincronización de la escritura. La longitud en disco permite recuperar una escritura interrumpida.
6. `POST ?action=commit&id=UUID` verifica tamaños y hashes completos antes de publicar el directorio por rename. No toca el portapapeles ni emite teclas. Repetirlo devuelve el recibo existente; un estado ambiguo se rechaza.
7. `POST ?action=clipboard&id=UUID` es una operación separada sobre el lote guardado. Primero persiste un marcador de intento incierto. Después comprueba nuevamente los archivos e intenta ofrecer una imagen individual o la lista completa de archivos. Un crash o respuesta perdida nunca provoca un segundo intento automático con el mismo lote.
8. La app ofrece **Pegar ahora** solo tras un recibo nuevo de clipboard preparado. Ese botón es una acción explícita de teclado. Subir, guardar y copiar nunca envían Enter. Un recibo repetido no acredita que el lote siga siendo el propietario actual del portapapeles.

## Recuperación y almacenamiento

- `GET ?id=UUID` consulta el estado sin copiar ni inyectar entrada. `begin` también recupera offsets y el resultado de un commit cuya respuesta se perdió.
- **Pausar envío** cancela la petición actual y conserva la identidad. **Reanudar mismo lote** consulta los bytes recibidos y continúa por los pendientes.
- **Descartar selección** cancela staging remoto antes de eliminar la copia local. Un lote ya publicado se conserva en Downloads/Phonepad y la app lo comunica. Si el servidor no contesta, la selección permanece disponible; nunca se interpreta silencio como cancelación confirmada.
- El servidor conserva tombstones por 24 horas, dentro del límite total de staging, para rechazar reintentos tardíos. Libera los payloads después de persistir una cancelación. La limpieza solo elimina staging propio con esquema, identidad y entradas reconocidas; no borra directorios publicados ni hijos ajenos.
- La copia móvil vive en cache privada con manifiesto y propietario versionados. Se recupera al reabrir la app en el mismo host mientras el sistema conserve esa cache. Expira tras 24 horas y se elimina al completar o descartar. La app no promete supervivencia si el sistema purga la cache, desinstala la app o elimina sus datos.
- Los metadatos no contienen tokens ni contenido del clipboard. El daemon no registra contenido de archivos, texto dictado o texto pegado.

## Estados y errores

El lote informa `receiving`, `stored` o `cancelled`, con tamaño y SHA-256 esperados y cantidad de bytes recibidos de cada archivo. `stored` acredita la publicación del lote, no que una aplicación haya adjuntado su contenido. El clipboard informa `unrequested`, `ready`, `unavailable` o `uncertain` y si el recibo corresponde a un intento previo.

La API exige la autenticación existente y origen permitido, también a través de `RemoteHandler`. Los errores 400/409 rechazan datos inválidos o conflictos; 410 indica expiración, 429 limita concurrencia o staging y 507 indica almacenamiento no disponible. El código no devuelve rutas internas ni contenido en los errores. P02/P07 deben extender esta autorización a capacidades y permisos por dispositivo; el token compartido actual no equivale a ese registro futuro.

## Aceptación

Las pruebas cubren hashes calculados en origen, archivos vacíos, nombres iguales, pausas, solapamientos, respuestas perdidas, reinicio de Store, publicación única, cancelación durable, límites, limpieza segura y gateway público. Las pruebas móviles verifican revisión, quitar archivos, conservación de selección, destinos aislados y continuidad del stream.

Quedan separadas la instalación de un binario compatible con Expo FileSystem, la selección de iCloud/HEIC real, consumo de memoria en equipos antiguos y la aceptación de lotes en las aplicaciones objetivo. Los mocks de proveedores nativos y la compilación del bundle no sustituyen esa evidencia.
