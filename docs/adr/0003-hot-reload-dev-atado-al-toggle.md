# ADR 0003 — Hot-reload de desarrollo atado al toggle, con re-exec del daemon

Estado: aceptado · Fecha: 2026-06-02

## Contexto

El ciclo de desarrollo tenía cuatro pasos de fricción por cada cambio en la PWA:
recompilar (la PWA va embebida con `//go:embed`), reiniciar el daemon, bumpear el
nombre de cache del service worker (es cache-first sin revalidación) y recargar el
celular dos veces (baile de update del SW). Para cambios en Go, el rebuild+restart
es inherente (binario compilado).

El requisito del usuario fue tajante: **cero acciones por cambio**, y que el
control siga siendo el toggle de Quick Settings (ON/OFF, sin comandos nuevos),
sin ensuciar la arquitectura de producción (embed + SW + servicio systemd), que
es la base sólida a preservar.

## Decisión

Un **modo dev gateado por la env var `PHONEPAD_DEV_SRC`**. Sin esa variable, el
binario es producción pura (embed + SW, sin watchers). Cuando apunta al fuente:

- **Web desde disco**: `os.DirFS($SRC/web)` en vez del embed → un cambio en
  `app.js`/CSS/HTML no necesita recompilar.
- **Live-reload de web**: un poller de ~400ms (mtime+tamaño, `internal/devreload`)
  vigila `web/`; ante un cambio el daemon manda `{"t":"reload"}` por el WS ya
  conectado y la PWA hace `location.reload()`.
- **Re-exec ante cambios en Go**: otro poller vigila `*.go`; ante un cambio corre
  `go build -o <binario-actual>` y se **re-ejecuta a sí mismo con `syscall.Exec`**
  (mismo PID, así systemd no lo cuenta como caída). El cel se reconecta solo.
- **SW neutralizado en dev**: se inyecta `window.__PHONEPAD_DEV__` en el `index.html`
  servido (la PWA desregistra el SW y no cachea) y `/sw.js` devuelve un SW de
  autodestrucción que limpia un SW de prod previo (el browser revalida el script
  del SW salteando su propio cache, así la transición prod→dev es automática).

El **toggle es la flag**: la extensión hace `systemctl --user start/stop`; el
servicio local (lo configura `install.sh` al instalar desde el repo) arranca con
`PHONEPAD_DEV_SRC` apuntando al fuente. Prender el toggle = daemon + watchers;
apagarlo = se mata todo. No queda nada corriendo por fuera del toggle.

## Consecuencias

- (+) Cero comandos por cambio: guardás y el cel se actualiza solo (web al
  instante; Go en ~1s vía recompilar + re-exec + reconexión).
- (+) Producción intacta: todo el modo dev vive detrás de una env var; el binario
  y el código por defecto son prod (embed + SW). Un deploy de binario suelto (sin
  la env) corre en prod sin tocar nada.
- (+) Un solo proceso atado al toggle: sin unidades systemd extra ni daemons de
  watch sueltos.
- (+) Lógica testeable aislada (`internal/devreload`: inyección + watcher) con
  tests; el server tiene tests de inyección/kill-switch hermético.
- (−) En la máquina de dev el servicio corre permanentemente en modo dev (sirve
  desde disco, recompila). Es lo deseado acá, pero acopla el servicio al checkout
  del repo: si se mueve/borra el fuente, hay que reinstalar (vuelve a prod).
- (−) El re-exec necesita `go` accesible (PATH del servicio o `~/.local/go`) y
  recompila en background; si el build falla, loguea y sigue con el binario viejo.
- (−) Polling de mtime (no `fsnotify`): elegido por cero dependencias; poda
  `vendor`/`.git` para no escanear miles de archivos por tick.
- Alternativas descartadas: `make dev`/watcher externo (el usuario quería que el
  toggle solo bastara) y `air` (suma dependencia y un proceso extra no atado al
  toggle).
