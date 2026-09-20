# P02-05B: ciclo de vida del proveedor Python

Este bloque coordina el cierre del preview Python, el gestor WebRTC/GLib y el
worker HFR. La admisión se cierra al recibir `SIGTERM` o `SIGINT`; las
peticiones nuevas reciben `503` en HTTP y las operaciones nuevas del gestor o
worker se rechazan con `manager closing` o `backend closing`. `stop` conserva
su lugar como cleanup mientras exista una sesión.

## Cierre y cancelación

`rtc.Manager` encola cada acción con un `_DispatchTask`. El callback marca la
acción como iniciada bajo un lock antes de ejecutar GStreamer. Si el caller
vence su deadline antes de ese punto, el task queda cancelado y el callback
posterior se convierte en no-op; `GLib.source_remove` solo es una optimización
porque puede correr en paralelo con el callback. El timeout del caller queda
acotado y no deja una acción HTTP ejecutándose por sorpresa más tarde.

Una acción que ya empezó no puede interrumpirse de forma segura en mitad de
una operación GStreamer. El caller recibe el timeout acotado, el gestor queda
en estado de cierre y la limpieza encolada libera la sesión cuando esa acción
retorna. Esta es la única ventana de trabajo in-flight: no se promete abortar
un pipeline que ya está dentro de una llamada del runtime.

`Manager.shutdown_on_loop()` es idempotente, quita el timer de expiración,
cierra la sesión en su hilo GLib y marca el gestor cerrado después de que la
limpieza de una sesión retorna, incluso si reporta un error. Un `shutdown()`
desde otro hilo encola un único callback de cierre con un evento propio: si el
deadline vence, informa timeout y deja ese callback en la cola para que el
owner lo ejecute, sin duplicarlo ni cancelarlo. `ProcessBackend.shutdown()`
marca el backend como cerrando antes de tomar el lock, delega el stop/reap a
un coordinador background de espera acotada y rechaza starts que lleguen en la
ventana de carrera.

El worker HFR encola el cierre en GLib desde el handler de señal. Si el owner
queda dentro de una llamada in-flight, la salida conserva el timeout/error y
no ejecuta un destructor GStreamer desde el hilo de entrada; el supervisor y
el proceso terminan de reclamar esos handles.

`capture.py` registra ambas señales, evita nuevas solicitudes portal, detiene
streams/pipeline, cierra el worker o la sesión nativa, apaga el servidor Unix,
cierra el FD remoto y finalmente hace `MainLoop.quit()`. Los callbacks portal,
la codificación y las solicitudes HTTP comprueban la barrera de cierre para no
crear trabajo después de la señal.

## Archivos y pruebas

- `setup/preview/rtc.py`: task cancelable, barrera de admisión y cierre GLib.
- `setup/preview/process_backend.py`: estado de cierre y reap acotado del HFR.
- `setup/preview/capture.py`: señales, barrera HTTP/portal y cierre coordinado.
- `setup/preview/hfr_worker.py`: señal hacia GLib, salida limpia y fallback
  bounded.
- `tests/rtc_lifecycle_test.py`: timeout de acción encolada sin ejecución
  tardía, timeout de acción in-flight sin doble ejecución, cancelación
  explícita, owner GLib, cierre idempotente y callback de shutdown que queda
  encolado una sola vez.
- `tests/process_backend_lifecycle_test.py`: reap del worker, rechazo de un
  nuevo start después del cierre y deadline con el RPC lock ocupado.

Validación ejecutada con el runtime privado de Phonepad
`/home/luque/Documents/Codex/2026-09-08/phonepad/work/runtime`:

```text
python3 -m unittest discover -s tests -p '*_test.py'   49 tests OK
python3 -m py_compile setup/preview/{rtc,capture,process_backend,hfr_worker}.py
```

La revisión comprobó además que un error de cierre permanece visible en los
siguientes llamados a `shutdown`; un segundo llamado no lo convierte en éxito.

El laboratorio GNOME/VA real ejecutó dos workers HFR. El primero respondió a
stop en 259,44 ms y el segundo terminó tras SIGTERM y shutdown en 332,55 ms.
Ambos devolvieron código 0 y cerraron sus pipes. La evidencia está en
`outputs/p02/media-hardware-fixed-evidence`; los detalles de resolución están
en `p02-04-media.md`. Las plantillas systemd acotan el cierre del grupo a 15
segundos si una llamada nativa no devuelve el control. No se instalaron.

Permanecen pendientes el Portal genérico, los clientes físicos Mac, Android e
iPhone y los proveedores nuevos. La aceptación de ese conjunto no se infiere
de la prueba HFR ni bloquea tareas Linux independientes.
