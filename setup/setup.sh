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

echo "==> Instalando dependencias (portapapeles, accesibilidad, video, indicador)"
# Todo sale de los paquetes del sistema: no hay runtime de video aparte.
packages=(wl-clipboard python3-gi gir1.2-gtk-4.0 gir1.2-atspi-2.0 xwayland
  gir1.2-ayatanaappindicator3-0.1 gir1.2-gstreamer-1.0 gir1.2-gst-plugins-base-1.0
  gir1.2-gst-plugins-bad-1.0 gstreamer1.0-plugins-base gstreamer1.0-plugins-good
  gstreamer1.0-plugins-bad gstreamer1.0-nice gstreamer1.0-pipewire pipewire-bin wireplumber mesa-va-drivers
  gcc pkg-config libpipewire-0.3-dev libgstreamer-plugins-base1.0-dev)
if grep -q GenuineIntel /proc/cpuinfo && ! dpkg -s intel-media-va-driver-non-free >/dev/null 2>&1; then packages+=(intel-media-va-driver); fi
apt-get install -y "${packages[@]}"

echo
echo "Listo."
echo "IMPORTANTE: cerrá sesión y volvé a entrar (o reiniciá) para que el grupo 'phonepad' tome efecto."
echo "Verificá después con:  ls -l /dev/uinput   (esperado: grupo 'phonepad', modo crw-rw----)"
