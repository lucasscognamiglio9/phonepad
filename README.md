# phonepad

Convierte un celular en touchpad multitáctil + teclado para una laptop Linux
(Wayland/GNOME), dentro de la red local. Es un proyecto casero: el objetivo es
latencia baja, una sola sesión y un camino de instalación que se pueda repetir.

```
PWA (celular) -- HTTPS + WSS/JSON --> daemon Go -- uinput --> libinput/GNOME
 contactos crudos + teclado           valida token      touchpad virtual MT-B
```

## Demo rápida

Requisitos: Linux con GNOME/Wayland (los scripts de privilegios usan
`modprobe`, udev y `apt-get`, probados en Debian/Ubuntu), Go 1.26+,
`/dev/uinput` y `wl-clipboard` para pegar Unicode.

```bash
sudo bash setup/setup.sh       # uinput + regla udev + wl-clipboard (una vez)
# cerrar sesión y volver a entrar para tomar el grupo input
bash setup/install.sh           # binario, servicio de usuario y toggle GNOME
gnome-extensions enable phonepad@local  # si el instalador no pudo habilitarlo
```

Luego: Quick Settings → `phonepad` → activar. La primera vez se abre
`https://localhost:8080/pair` en la laptop. Acepta el certificado casero,
escanea el QR con el celular y agrega la PWA a la pantalla de inicio. El QR y la
salida de arranque contienen la credencial; `/pair`, `/qr.svg`, `/events` y
`/api/pair-info` solo responden a la laptop (loopback). El endpoint `/api/auth`
permite a la PWA detectar un token revocado y detenerse con un mensaje en vez de
reconectar indefinidamente.

El token se guarda en `~/.config/phonepad/pairing.json` (modo 0600), el
certificado en el mismo directorio y ambos sobreviven reinicios. Para revocar un
celular de forma explícita, detené el servicio, rotá y volvé a iniciar:

```bash
systemctl --user stop phonepad
~/.local/bin/phonepad --rotate-token
systemctl --user start phonepad
```

El comando no imprime la credencial; el arranque siguiente muestra el QR nuevo.

## Qué hace hoy

- Un dedo mueve el cursor; tap, dos dedos, scroll, drag y gestos de tres dedos
  los interpreta libinput desde un touchpad virtual MT Type-B.
- El pinch de dos dedos también llega como gesto nativo a la aplicación activa;
  no se convierte en una lupa del daemon.
- Teclado nativo, teclas especiales, combos y modificadores sticky.
- ASCII por keycodes US; acentos/ñ/emoji por `wl-copy` + Ctrl+V. En GNOME
  Terminal el pegado necesita Ctrl+Shift+V, por lo que Unicode allí es una
  limitación conocida.
- HTTPS/WSS con certificado self-signed persistente y PWA offline instalable.
- Una sola conexión activa: una conexión nueva reemplaza a la vieja y libera
  slots MT, botones y teclas. Los mensajes se validan (tamaño, coordenadas,
  acciones y límites) y Text/Special/Combo/Touch se ejecutan en FIFO.

## Desarrollo y verificación

```bash
cd daemon
~/.local/go/bin/go test ./...
~/.local/go/bin/go test -race ./...
~/.local/go/bin/go vet ./...
~/.local/go/bin/go build ./...
```

Los tests no necesitan hardware. La verificación física pendiente es aceptar el
certificado en un teléfono y comprobar cursor/gestos/texto en una sesión GNOME
real con `/dev/uinput` accesible. No ejecutes el daemon como root: usa la regla
udev y el grupo `input`.

## Límites honestos

- Solo un cliente; la última sesión válida gana.
- El certificado es self-signed: no es una PKI pública y debe aceptarse una vez
  por dispositivo. La seguridad adicional es el token de pairing y la LAN.
- No hay drag-lock, WebRTC ni sincronización de portapapeles.
- `wl-copy` necesita una sesión Wayland (`WAYLAND_DISPLAY`); sin él funcionan
  las teclas ASCII pero no el camino Unicode.
- La detección de IP usa la primera IPv4 activa. Si la red cambia, el daemon
  regenera el certificado con el nuevo SAN; vuelve a aceptar el aviso del
  navegador.

## Estructura

- `daemon/`: binario Go, servidor HTTP/WS, pairing, TLS, uinput y PWA embebida.
- `setup/`: permisos uinput, instalación del servicio systemd de usuario y
  extensión Quick Settings.
- `SPEC.md`, `CONTEXT.md`, `docs/adr/`: contrato y decisiones del proyecto.
