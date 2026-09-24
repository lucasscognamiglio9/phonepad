#!/bin/zsh
set -e
cd "$(dirname "$0")"
if ! command -v tailscale >/dev/null; then
  echo 'Instalá Tailscale e iniciá sesión antes de abrir PhonePad.'
  exit 1
fi
dns=$(tailscale status --json | /usr/bin/plutil -extract Self.DNSName raw -o - - 2>/dev/null || true)
dns=${dns%.}
if [[ -z "$dns" || "$dns" != *.ts.net ]]; then
  echo 'Tailscale debe estar conectado y tener MagicDNS activo.'
  exit 1
fi
echo "PhonePad: https://$dns"
tailscale serve --bg --https=443 http://127.0.0.1:8081
./phonepad-daemon --gateway-port 8081 --public-url "https://$dns" &
daemon_pid=$!
trap 'kill $daemon_pid 2>/dev/null || true' EXIT
sleep 2
open https://localhost:8080/share
wait $daemon_pid
