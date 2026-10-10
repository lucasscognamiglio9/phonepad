#!/bin/zsh
set -e
cd "$(dirname "$0")"
tailscale_bin=$(command -v tailscale || true)
if [[ -z "$tailscale_bin" && -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]]; then
  tailscale_bin=/Applications/Tailscale.app/Contents/MacOS/Tailscale
fi
if [[ -z "$tailscale_bin" ]]; then
  echo 'Instalá Tailscale e iniciá sesión antes de abrir PhonePad.'
  exit 1
fi
ts() { TAILSCALE_BE_CLI=1 "$tailscale_bin" "$@"; }
tail_status=$(ts status --json)
dns=$(printf '%s' "$tail_status" | /usr/bin/plutil -extract Self.DNSName raw -o - - 2>/dev/null || true)
dns=${dns%.}
if [[ -z "$dns" || "$dns" != *.ts.net ]]; then
  echo 'Tailscale debe estar conectado y tener MagicDNS activo.'
  exit 1
fi
user_id=$(printf '%s' "$tail_status" | /usr/bin/plutil -extract Self.UserID raw -o - - 2>/dev/null || true)
login=$(printf '%s' "$tail_status" | /usr/bin/plutil -extract "User.$user_id.LoginName" raw -o - - 2>/dev/null || true)
if [[ -z "$login" ]]; then
  echo 'No se pudo identificar la cuenta Tailscale del equipo.'
  exit 1
fi
echo "PhonePad: https://$dns"
serve_status=$(ts serve status --json)
if [[ "$serve_status" == *'127.0.0.1:8081'* ]]; then
  :
elif [[ "$serve_status" == '{}' || "$serve_status" == 'null' ]]; then
  ts serve --bg --https=443 http://127.0.0.1:8081
else
  echo 'Ya existe otra configuración Tailscale Serve. Revisala antes de iniciar PhonePad.'
  exit 1
fi
PHONEPAD_TRUSTED_LOGIN="$login" ./phonepad-daemon --gateway-port 8081 --local-share-port 8082 --public-url "https://$dns" &
daemon_pid=$!
trap 'kill $daemon_pid 2>/dev/null || true' EXIT
ready=false
for attempt in {1..20}; do
  if curl --silent --fail --max-time 2 http://127.0.0.1:8082/share >/dev/null; then ready=true; break; fi
  if ! kill -0 $daemon_pid 2>/dev/null; then
    echo 'PhonePad no pudo iniciar. Revisá el error de arriba.'
    wait $daemon_pid
    exit 1
  fi
  sleep .5
done
if [[ "$ready" != true ]]; then
  echo 'PhonePad no abrió la pantalla local. Revisá la consola del servidor.'
  exit 1
fi
open http://127.0.0.1:8082/share
wait $daemon_pid
