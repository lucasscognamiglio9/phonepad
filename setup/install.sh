#!/usr/bin/env bash
# phonepad — instalación de USUARIO (sin sudo): compila el binario, instala el
# servicio systemd de usuario y la extensión de GNOME (toggle de Quick Settings).
#
# Antes, una sola vez, corré la parte con privilegios (permisos de /dev/uinput):
#     sudo bash setup/setup.sh
# y volvé a loguearte para tomar el grupo 'input'.
#
# Uso:  bash setup/install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DAEMON_DIR="$REPO_DIR/daemon"

BIN_DIR="$HOME/.local/bin"
UNIT_DIR="$HOME/.config/systemd/user"
EXT_UUID="phonepad@local"
EXT_DST="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"

# Encontrar go (PATH o ~/.local/go).
GO="$(command -v go || true)"
[[ -z "$GO" && -x "$HOME/.local/go/bin/go" ]] && GO="$HOME/.local/go/bin/go"
if [[ -z "$GO" ]]; then
  echo "✗ no encontré 'go' (ni en PATH ni en ~/.local/go/bin). Instalalo y reintentá." >&2
  exit 1
fi

echo "==> Compilando el binario -> $BIN_DIR/phonepad"
mkdir -p "$BIN_DIR"
( cd "$DAEMON_DIR" && "$GO" build -o "$BIN_DIR/phonepad" . )

echo "==> Instalando el servicio systemd de usuario"
mkdir -p "$UNIT_DIR"
# Modo dev (hot-reload): como instalamos desde el checkout del repo, el servicio
# arranca apuntando al fuente (PHONEPAD_DEV_SRC) → el toggle de GNOME da
# hot-reload sin comandos (ver docs/adr/0003). El PATH incluye el dir de 'go'
# para que el daemon pueda recompilarse a sí mismo. Sin estas líneas (deploy de
# binario suelto) el servicio corre en prod (embed + service worker).
GO_BIN_DIR="$(dirname "$GO")"
sed \
  -e "s#@DEV_SRC@#$DAEMON_DIR#" \
  -e "s#@GO_BIN_DIR@#$GO_BIN_DIR#" \
  "$SCRIPT_DIR/phonepad.service" > "$UNIT_DIR/phonepad.service"
chmod 0644 "$UNIT_DIR/phonepad.service"
systemctl --user daemon-reload
# Para que la inyección de texto Unicode (wl-copy) vea el display Wayland.
# Importar antes de reiniciar: de lo contrario el servicio puede arrancar con
# el entorno viejo y fallar sólo al primer paste Unicode.
systemctl --user import-environment WAYLAND_DISPLAY XDG_RUNTIME_DIR 2>/dev/null || true
# Si el servicio ya estaba corriendo (toggle ON), reiniciarlo para tomar el modo
# dev y el binario nuevo de una.
systemctl --user try-restart phonepad 2>/dev/null || true

echo "==> Instalando la extensión de GNOME ($EXT_UUID)"
mkdir -p "$EXT_DST"
cp "$SCRIPT_DIR/gnome-extension/$EXT_UUID/"* "$EXT_DST/"

echo "==> Chequeos"
if command -v wl-copy >/dev/null && command -v wl-paste >/dev/null; then
  echo "  ✓ wl-clipboard presente"
else
  echo "  ⚠ falta wl-copy y/o wl-paste (texto Unicode): sudo apt install wl-clipboard"
  echo "    ASCII seguirá funcionando; instalalo y reintentá para pegar Unicode."
fi
if [[ -r /dev/uinput && -w /dev/uinput ]]; then
  echo "  ✓ /dev/uinput accesible"
else
  echo "  ⚠ /dev/uinput sin permisos: corré 'sudo bash setup/setup.sh' y re-logueá"
fi

# Intentar habilitar la extensión (en Wayland puede requerir relogin primero).
if gnome-extensions enable "$EXT_UUID" 2>/dev/null; then
  echo "  ✓ extensión habilitada"
  ENABLED=1
else
  ENABLED=0
fi

cat <<EOF

Instalación de usuario lista.

Pasos finales:
EOF
if [[ "$ENABLED" -eq 0 ]]; then
  cat <<EOF
  1) CERRÁ SESIÓN y volvé a entrar (en Wayland GNOME necesita recargar para ver
     la extensión nueva), luego habilitala:
         gnome-extensions enable $EXT_UUID
EOF
else
  cat <<EOF
  1) Si el toggle no aparece aún, cerrá sesión y volvé a entrar una vez.
EOF
fi
cat <<EOF
  2) Abrí Quick Settings y tocá el toggle 'phonepad' para prenderlo.
  3) La 1ª vez se abre /pair con el QR: escanealo desde el cel y elegí
     'Agregar a pantalla de inicio'.
  4) Después: tocá el ícono del cel -> conectado. Toggle off -> no corre nada.

Tip: la 1ª vez el navegador (cel y laptop) avisa por el certificado casero;
'Avanzado' -> 'Continuar'. Es esperado.
EOF
