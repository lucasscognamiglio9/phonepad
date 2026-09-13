#!/bin/bash
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Necesita autorización de administrador.'; exit 1; }
# Add capacity without disabling existing swap or pulling its pages into RAM.
swap_path=/phonepad-swap.img
if [[ ! -e "$swap_path" ]]; then
 available=$(df --output=avail -B1 / | tail -1)
 (( available > 20*1024*1024*1024 )) || { echo 'Espacio insuficiente'; exit 1; }
 umask 077
 fallocate -l 12G "$swap_path"
 chmod 600 "$swap_path"
 mkswap "$swap_path"
fi
[[ ! -L "$swap_path" && -f "$swap_path" ]] || exit 1
[[ $(stat -c %u "$swap_path") == 0 && $(stat -c %a "$swap_path") == 600 ]] || exit 1
[[ $(blkid -p -s TYPE -o value "$swap_path") == swap ]] || exit 1
if ! swapon --show=NAME --noheadings | grep -Fxq "$swap_path"; then swapon "$swap_path"; fi
if ! grep -Eq '^/phonepad-swap\.img[[:space:]]' /etc/fstab; then
 cp -a /etc/fstab /etc/fstab.phonepad-before
 printf '\n/phonepad-swap.img none swap sw 0 0\n' >> /etc/fstab
fi
# zswap compresses evicted pages before the SSD; no RAM preallocation.
if [[ -w /sys/module/zswap/parameters/enabled ]]; then
 install -d /etc/systemd/system
 cat > /etc/systemd/system/phonepad-zswap.service <<'EOF'
[Unit]
Description=Compressed swap cache for memory pressure
ConditionPathExists=/sys/module/zswap/parameters/enabled
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo Y > /sys/module/zswap/parameters/enabled'
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
EOF
 systemctl daemon-reload
 systemctl enable --now phonepad-zswap.service
fi
install -d /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/60-phonepad-health.conf <<'EOF'
[Journal]
Storage=persistent
SystemMaxUse=1G
SystemKeepFree=2G
MaxRetentionSec=14day
MaxFileSec=1day
SyncIntervalSec=30s
EOF
systemctl restart systemd-journald
journalctl --flush
swapon --show
printf 'zswap: '; cat /sys/module/zswap/parameters/enabled
