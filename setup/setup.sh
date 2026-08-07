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
install -m 0644 "$RULE_SRC" "$RULE_DST"

echo "==> Agregando '$REAL_USER' al grupo input"
usermod -aG input "$REAL_USER"

echo "==> Recargando reglas udev"
udevadm control --reload-rules
udevadm trigger --subsystem-match=misc --attr-match=name=uinput 2>/dev/null || udevadm trigger

echo "==> Instalando wl-clipboard (texto Unicode vía portapapeles en GNOME Wayland)"
# wtype NO sirve en GNOME (Mutter no implementa zwp_virtual_keyboard_v1); el
# daemon inyecta el Unicode con wl-copy + Ctrl+V (ver internal/input/input.go).
if command -v wl-copy >/dev/null && command -v wl-paste >/dev/null; then
  echo "  wl-clipboard ya instalado"
else
  if ! apt-get install -y wl-clipboard; then
    echo "  ⚠ no pude instalar wl-clipboard; instalalo a mano: sudo apt install wl-clipboard"
  fi
  if ! command -v wl-copy >/dev/null || ! command -v wl-paste >/dev/null; then
    echo "  ⚠ Unicode queda deshabilitado hasta instalar wl-copy y wl-paste; ASCII seguirá funcionando."
  fi
fi

echo
echo "Listo."
echo "IMPORTANTE: cerrá sesión y volvé a entrar (o reiniciá) para que el grupo 'input' tome efecto."
echo "Verificá después con:  ls -l /dev/uinput   (esperado: grupo 'input', modo crw-rw----)"
