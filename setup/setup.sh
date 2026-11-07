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
  gstreamer1.0-plugins-bad gstreamer1.0-nice gstreamer1.0-pipewire gstreamer1.0-libav pipewire-bin wireplumber mesa-va-drivers v4l2loopback-dkms
  gcc pkg-config libpipewire-0.3-dev libgstreamer-plugins-base1.0-dev)
if grep -q GenuineIntel /proc/cpuinfo && ! dpkg -s intel-media-va-driver-non-free >/dev/null 2>&1; then packages+=(intel-media-va-driver); fi
if apt-cache show "linux-headers-$(uname -r)" >/dev/null 2>&1; then packages+=("linux-headers-$(uname -r)"); fi
apt-get install -y "${packages[@]}"

echo "==> Creando la webcam 'Cámara del iPhone'"
camera_label='Cámara del iPhone'
echo "options v4l2loopback card_label=\"$camera_label\" exclusive_caps=1" > /etc/modprobe.d/phonepad-v4l2loopback.conf
echo "v4l2loopback" > /etc/modules-load.d/phonepad-v4l2loopback.conf
has_camera() { grep -qxF "$camera_label" /sys/class/video4linux/video*/name 2>/dev/null; }
if ! has_camera && lsmod | grep -q '^v4l2loopback '; then modprobe -r v4l2loopback 2>/dev/null || true; fi
if ! has_camera && ! modprobe v4l2loopback 2>/dev/null; then
  if command -v mokutil >/dev/null && mokutil --sb-state 2>/dev/null | grep -qi enabled; then
    echo "AVISO: Secure Boot está activo y el módulo de la cámara no está firmado." >&2
    echo "Reiniciá, elegí 'Enroll MOK' en la pantalla azul y poné la clave que pidió apt. Después la cámara aparece sola." >&2
  else
    echo "AVISO: no pude cargar v4l2loopback; reiniciá y la cámara aparece en el arranque." >&2
  fi
fi
has_camera && echo "Cámara lista: $(grep -lxF "$camera_label" /sys/class/video4linux/video*/name | cut -d/ -f5)"

echo "Sistema listo."
