# P02-05A: cierre coordinado del daemon

## Contrato

`Server.Shutdown(ctx)` cierra la admisión una sola vez para el listener LAN y
el gateway. Las nuevas peticiones reciben `503`; los handlers ya admitidos
reciben un contexto cancelado. La generación de sesión y los leases de input se
invalidan antes de retirar WebSockets y desktop relay. El cierre de sockets y
las notificaciones ocurren fuera de `mutationGate` y `Server.mu`.

El primer llamador inicia un coordinador único y espera su resultado o su
propio deadline. Si un upload, proveedor o reset conserva un lock o ignora el
contexto, el llamador vuelve con `context.DeadlineExceeded`; el coordinador
continúa en segundo plano y no publica éxito prematuro. Llamadas posteriores
observan el mismo resultado final.

La FIFO `input.NewAsyncText` conserva `Reset`/`Close` históricos para el cierre
normal y añade `ResetContext`/`CloseContext`. Un cierre de lifecycle invalida
operaciones pendientes, espera sólo desde un worker, y permite que el caller
abandone por deadline mientras el proveedor termina. Las operaciones literales
que pierden el contexto se reportan como `uncertain`, nunca como entregadas.

## Señales y listeners

`main` trata `SIGINT` y `SIGTERM` como una única solicitud de cierre, detiene
los watchers, cancela builds de desarrollo antes de `syscall.Exec`, apaga en
paralelo los listeners HTTP con un deadline común y cierra el inyector después
del reset del `Server`. `http.ErrServerClosed` no se registra como fallo. Un
error real de bind conserva salida no cero después de la limpieza.

## Archivos

- `daemon/main.go`: coordinación de señales, listeners y watchers.
- `daemon/internal/server/lifecycle.go`: barrera de admisión, coordinador y
  cierre de recursos hijacked.
- `daemon/internal/server/server.go`, `session.go`, `desktop.go`: contexto de
  lifecycle para handlers, WS y relay.
- `daemon/internal/server/input_operations.go`: provider literal fuera de
  `Server.mu`, permiso revalidado y resultado incierto al cancelar.
- `daemon/internal/input/contracts.go`, `async.go`: hooks cancelables de reset
  y cierre sin romper las interfaces antiguas.

La parada de captura Python/RTC se documenta en
`p02-05-provider-lifecycle.md`. El cierre físico específico de las plataformas
nuevas permanece pendiente. `CloseContext`
no puede interrumpir un proveedor que ignora `context.Context`; en ese caso el
daemon deja constancia de timeout y no promete que el efecto haya terminado.

## Verificación

Las pruebas focalizadas cubren rechazo posterior al cierre, cancelación del
contexto hijacked, deadline con `mutationGate` ocupado, FIFO llena con provider
bloqueado, reset que continúa después de timeout y descarte de input pendiente.
La suite completa de `internal/server` requiere un entorno que permita abrir
listeners localhost; la compilación y las pruebas sin red se ejecutan con el
Go runtime fijado por el plan.

La revisión final añadió tres casos de concurrencia. Un tercer emisor
esperando una FIFO llena ya no bloquea el deadline de reset; los reintentos
concurrentes de `begin` conservan el primer campo de destino; los resets al
reconectar o revocar permisos esperan fuera de `Server.mu` y tienen un límite
de cinco segundos. Si el reset físico falla, la sesión conserva preview y
anuncia `input_reset_incomplete` hasta que una transición posterior consiga
restablecer el proveedor.

Las plantillas systemd fijan 15 segundos y `KillMode=control-group` para
reclamar también los hijos ante una llamada nativa que no retorna. No se
instalaron las plantillas ni se reiniciaron servicios. El proceso principal
conserva su deadline interno de diez segundos.

Pasó la suite Go completa con detector de carreras, incluyendo la prueba
Python/Go/TypeScript y ambas direcciones cliente viejo/servidor nuevo. La
evidencia final está en `outputs/p02/media-lifecycle-compat-go-race-final.log`.
