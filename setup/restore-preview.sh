#!/usr/bin/env bash
set -euo pipefail
override=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/phonepad-preview.service.d/50-phonepad-hfr.conf
if [[ -f "$override" ]]; then
 mv -- "$override" "$override.disabled"
 systemctl --user daemon-reload
 systemctl --user restart phonepad-preview.service
fi
systemctl --user is-active phonepad-preview.service
