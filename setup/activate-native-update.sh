#!/usr/bin/env bash
# Install the tested gateway and select one IPA for authenticated download.
# Does not sign an app or inspect any credentials.
set -euo pipefail
release=$(realpath -- "${1:?Uso: activate-native-update.sh /ruta/phonepad-complete-candidate}")
python3 - "$release" <<'PY'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1])
info=json.loads((root/'verification.json').read_text())
for name,key in [('Phonepad.ipa','appSha256'),('gateway/phonepad','gatewaySha256')]:
 if hashlib.sha256((root/name).read_bytes()).hexdigest()!=info[key]:
  raise SystemExit('Release checksum mismatch: '+name)
if any(x in str(root) for x in ('\n','\r','"','%','\\')):
 raise SystemExit('Unsupported release path')
PY
bin_dir=$HOME/.local/bin
unit_dir=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/phonepad.service.d
mkdir -p "$unit_dir"
override=$unit_dir/60-native-update.conf
backup=$release/gateway/previous
mkdir -p "$backup"
if [[ -e "$backup/phonepad" ]]; then
 echo 'La copia anterior ya existe; revisar el despliegue antes de repetirlo.' >&2
 exit 1
fi
cp -- "$bin_dir/phonepad" "$backup/phonepad"
if [[ -f "$override" ]]; then cp -- "$override" "$backup/60-native-update.conf"; fi
install -m 755 "$release/gateway/phonepad" "$bin_dir/phonepad.new"
mv -- "$bin_dir/phonepad.new" "$bin_dir/phonepad"
printf '[Service]\nEnvironment="PHONEPAD_NATIVE_UPDATE=%s/Phonepad.ipa"\n' "$release" > "$override"
systemctl --user daemon-reload
if ! systemctl --user restart phonepad.service; then
 install -m 755 "$backup/phonepad" "$bin_dir/phonepad.new"
 mv -- "$bin_dir/phonepad.new" "$bin_dir/phonepad"
 if [[ -f "$backup/60-native-update.conf" ]]; then
  cp -- "$backup/60-native-update.conf" "$override"
 else
  rm -- "$override"
 fi
 systemctl --user daemon-reload
 systemctl --user restart phonepad.service
 exit 1
fi
systemctl --user is-active phonepad.service
