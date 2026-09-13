#!/usr/bin/env bash
# Run as the desktop user, after installing and signing into Tailscale.
set -euo pipefail
command -v tailscale >/dev/null || { echo 'Instalar Tailscale: https://tailscale.com/download/linux' >&2; exit 1; }
public_host=$(tailscale status --json | python3 -c 'import json,sys,re; s=json.load(sys.stdin); h=s.get("Self",{}).get("DNSName", "").rstrip("."); assert s.get("BackendState")=="Running" and re.fullmatch(r"[a-z0-9-]+\.[a-z0-9.-]+\.ts\.net",h), "Iniciar sesión con sudo tailscale up"; print(h)')
# Refuse to overwrite unrelated Serve/Funnel configuration.
existing=$(tailscale serve status --json)
python3 -c 'import json,sys; s=json.loads(sys.argv[1]); assert not s or s=={}, "Ya existe configuración Serve: revisar manualmente antes de modificarla"' "$existing"
config_dir=${XDG_CONFIG_HOME:-$HOME/.config}/phonepad
mkdir -p "$config_dir"
umask 077
if [[ -f $config_dir/service.env ]]; then cp "$config_dir/service.env" "$config_dir/service.env.before-tailscale"; fi
printf 'PHONEPAD_BIND=127.0.0.1\nPHONEPAD_HOST=localhost\nPHONEPAD_GATEWAY_PORT=8081\nPHONEPAD_PUBLIC_URL=https://%s\n' "$public_host" > "$config_dir/service.env"
systemctl --user restart phonepad.service
systemctl --user is-active --quiet phonepad.service
# Auth must be refused while the unauthenticated shell is accessible.
[[ $(curl --retry 5 --retry-connrefused --retry-delay 1 -s -o /dev/null -w '%{http_code}' -H "Host: $public_host" http://127.0.0.1:8081/api/auth) == 401 ]]
[[ $(curl --retry 5 --retry-connrefused --retry-delay 1 -s -o /dev/null -w '%{http_code}' -H "Host: $public_host" http://127.0.0.1:8081/qr.svg) == 403 ]]
sudo tailscale serve --bg --https=443 http://127.0.0.1:8081
printf 'Dirección privada: https://%s\nValidar desde el iPhone antes de dar por terminado el acceso remoto.\n' "$public_host"
