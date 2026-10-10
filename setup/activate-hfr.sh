#!/usr/bin/env bash
# Switch only the preview service; pairing, uploads and the gateway are preserved.
set -euo pipefail
release_dir=$(realpath -- "${1:?Uso: activate-hfr.sh /ruta/release-server}")
python3 - "$release_dir" <<'PY'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1])
for name,digest in json.loads((root/'release.json').read_text())['files'].items():
 path=(root/name).resolve()
 if not path.is_relative_to(root) or hashlib.sha256(path.read_bytes()).hexdigest()!=digest:
  raise SystemExit('Release integrity check failed')
PY
unit_dir=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/phonepad-preview.service.d
mkdir -p "$unit_dir"
override=$unit_dir/50-phonepad-hfr.conf
if [[ -f "$override" ]]; then cp -- "$override" "$override.previous"; fi
printf '[Service]\nExecStart=\nExecStart=/usr/bin/python3 "%s/capture.py"\nEnvironment=PHONEPAD_VIDEO_MODE=hfr\nEnvironment=PHONEPAD_VIRTUAL_MIRROR=1\nMemoryHigh=750M\nMemoryMax=1000M\nTimeoutStopSec=10\nKillMode=control-group\n' "$release_dir" > "$override.new"
mv -- "$override.new" "$override"
systemctl --user daemon-reload
if ! systemctl --user restart phonepad-preview.service; then
 if [[ -f "$override.previous" ]]; then mv -- "$override.previous" "$override"; else rm -- "$override"; fi
 systemctl --user daemon-reload
 systemctl --user restart phonepad-preview.service
 exit 1
fi
systemctl --user is-active phonepad-preview.service
