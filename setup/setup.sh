#!/usr/bin/env bash
# phonepad — configura permisos de /dev/uinput para correr el daemon SIN root.
# Uso:  sudo bash setup/setup.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RULE_SRC="$SCRIPT_DIR/99-phonepad-uinput.rules"
RULE_DST="/etc/udev/rules.d/99-phonepad-uinput.rules"

if [[ $EUID -ne 0 ]]; then
  echo "Corré con sudo:  sudo bash $0" >&2
  exit 1
fi

REAL_USER="${SUDO_USER:-$USER}"
if [[ -z "$REAL_USER" || "$REAL_USER" == "root" ]]; then
  echo "No pude determinar el usuario de la sesión. Corré con sudo desde tu usuario (SUDO_USER debe estar definido)." >&2
  exit 1
fi
if ! id "$REAL_USER" >/dev/null 2>&1; then
  echo "El usuario '$REAL_USER' no existe; no modifico grupos." >&2
  exit 1
fi

echo "==> Cargando módulo uinput (ahora y en cada boot)"
modprobe uinput
echo "uinput" > /etc/modules-load.d/uinput.conf

echo "==> Instalando regla udev -> $RULE_DST"
getent group phonepad >/dev/null || groupadd --system phonepad
install -m 0644 "$RULE_SRC" "$RULE_DST"

echo "==> Agregando '$REAL_USER' al grupo phonepad"
usermod -aG phonepad "$REAL_USER"

echo "==> Recargando reglas udev"
udevadm control --reload-rules
udevadm trigger --subsystem-match=misc --attr-match=name=uinput 2>/dev/null || udevadm trigger

echo "==> Instalando herramientas de portapapeles"
# Las transferencias explícitas usan wl-clipboard. El pegado temporal conserva
# todos los formatos mediante GTK 4 y el puente XWayland de GNOME.
if command -v wl-copy >/dev/null && command -v wl-paste >/dev/null; then
  echo "  wl-clipboard ya instalado"
else
  if ! apt-get install -y wl-clipboard; then
    echo "  ⚠ no pude instalar wl-clipboard; instalalo a mano: sudo apt install wl-clipboard"
  fi
  if ! command -v wl-copy >/dev/null || ! command -v wl-paste >/dev/null; then
    echo "  ⚠ Las transferencias de portapapeles necesitan wl-copy y wl-paste."
  fi
fi

if ! /usr/bin/python3 -c "import gi; gi.require_version('Gtk', '4.0'); from gi.repository import Gtk" >/dev/null 2>&1 || ! command -v Xwayland >/dev/null; then
  apt-get install -y python3-gi gir1.2-gtk-4.0 xwayland
fi

echo
echo "Listo."
echo "IMPORTANTE: cerrá sesión y volvé a entrar (o reiniciá) para que el grupo 'phonepad' tome efecto."
echo "Verificá después con:  ls -l /dev/uinput   (esperado: grupo 'phonepad', modo crw-rw----)"
