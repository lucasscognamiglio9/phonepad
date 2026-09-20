# P02-03B: permisos efectivos para archivos y portapapeles

## Alcance

Este bloque conecta las rutas de archivos con el permiso efectivo que expone
P02-03. Conserva la autenticación, la validación de origen y las rutas v1 y
v2 existentes.

Las consultas de límites y estado no requieren el permiso de archivos. La
cancelación v2 tampoco lo requiere, porque debe poder limpiar una selección
después de una revocación.

## Cambios implementados

- `POST /api/files` captura un permiso de archivos antes de leer el cuerpo y
  lo vuelve a comprobar justo antes de crear el enlace que publica el archivo.
  Una revocación deja el temporal privado y devuelve 403.
- La intención `clipboard` captura un permiso separado. La copia ocurre bajo
  ese permiso y la respuesta sólo informa `ready` cuando el proveedor devuelve
  éxito. La subida del archivo y la copia siguen siendo efectos separados.
- `POST /api/file-batches` lee y valida el multipart completo antes de tomar el
  guard de publicación. El guard cubre el recibo y el rename del lote. Una
  revocación antes del rename deja el staging privado, sin lote visible.
- La preparación del portapapeles en v1 ocurre bajo su permiso. El recibo
  inicial queda en `unavailable`; sólo pasa a `ready` después de copiar y
  persistir ese estado bajo el mismo guard.
- `POST /api/file-transfers?action=begin`, `PUT` y `commit` exigen el permiso
  de archivos. `BeginWithGuard` y `WriteChunkWithGuard` toman primero
  `store.mu`; validan el manifiesto o el bloque y sólo después ejecutan el
  guard sobre la creación o escritura del staging. La lectura de cuerpos y el
  hash de un lote no sostienen `mutationGate`. `commit` usa
  `Store.CommitWithGuard`, que comprueba el permiso antes del recibo, la
  reorganización y el rename.
- `POST /api/file-transfers?action=clipboard` exige el permiso de portapapeles.
  Comprueba tamaños y SHA-256 fuera del guard. Después crea el claim durable,
  copia una sola vez y guarda el recibo dentro del efecto protegido. Un claim
  existente se devuelve como replay y no vuelve a llamar al proveedor.
- `POST /api/file-transfers?action=cancel&id=...` acepta un manifiesto JSON
  opcional de hasta 32 KiB. El servidor valida JSON estricto, versión, límites
  e identidad mediante `Store.Begin`, y luego llama `Store.Cancel`. Eso permite
  crear el tombstone aunque el `begin` original no haya llegado al daemon. La
  forma sin cuerpo conserva el comportamiento para registros existentes. Si el
  lote ya está `stored`, ambas formas devuelven su recibo con 200 y dejan la
  carpeta publicada intacta.

`Store.Begin` y `Store.WriteChunk` mantienen sus APIs anteriores.
`CommitWithGuard` no invoca el guard si el lote ya está almacenado, porque el
handler ya validó el permiso de la petición. Las tres operaciones guardadas
usan el orden `store.mu`, `mutationGate`, `server.mu`. No se mantiene ese
guard durante la lectura del cuerpo ni durante los hashes largos.

## Verificación local

Pasaron las suites dirigidas de `internal/filebatches` y `internal/server`,
incluidas las pruebas nuevas de revocación durante un cuerpo lento, cancelación
por manifiesto, publicación v1 sin clipboard, replay del claim y concurrencia
entre un commit y un bloque. También pasaron con `-race`:

```text
GOCACHE=/tmp/phonepad-refactor-go-cache GOPROXY=off \
  go test -race -mod=vendor ./internal/filebatches ./internal/server \
  -run 'Test(FileTransfer|Batch|PrivateFileTransfer|Clipboard|LegacyUpload|Store)' -count=1
```

La verificación de integración posterior ejecutó la suite Go completa con
`-race` y loopback autorizado, además de `go vet` y build. Pasaron las tres.
El registro está en `outputs/p02/negotiation-go-race.log`.

## Cierre pendiente

La integración de capacidades y archivos pasó las pruebas automáticas. La
aceptación física del clipboard y de los archivos en las aplicaciones objetivo
sigue separada de estas pruebas.

Archivos de este bloque:

- `daemon/internal/filebatches/store.go`
- `daemon/internal/filebatches/store_test.go`
- `daemon/internal/server/files.go`
- `daemon/internal/server/files_test.go`
- `daemon/internal/server/file_batches.go`
- `daemon/internal/server/file_batches_test.go`
- `daemon/internal/server/file_transfers.go`
- `daemon/internal/server/file_transfers_test.go`
