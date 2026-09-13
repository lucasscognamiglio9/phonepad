#!/usr/bin/env python3
"""Temporary iPhone-only comparison; no monitor changes or remote input."""
from pathlib import Path
import subprocess
import json, os, uuid
base = Path(__file__).resolve().parents[3] / 'runtime'
trial = base / 'sunshine-trial'

# Persist identity before the first pairing: Moonlight rejects a changed UUID.
identity_file = trial / 'state/sunshine_state.json'
if not identity_file.exists():
    fd = os.open(identity_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump({'root': {'uniqueid': str(uuid.uuid4()), 'named_devices': []}}, out)

props = ['User=luque', 'AmbientCapabilities=CAP_SYS_ADMIN', 'CapabilityBoundingSet=CAP_SYS_ADMIN',
 'NoNewPrivileges=yes', 'IPAddressDeny=any', 'IPAddressAllow=127.0.0.0/8 100.118.23.97/32', 'ProtectSystem=strict', 'ProtectKernelTunables=yes',
 'ProtectKernelModules=yes', 'ProtectControlGroups=yes', 'RestrictNamespaces=yes',
 'RestrictSUIDSGID=yes', 'RuntimeMaxSec=3600', 'TimeoutStopSec=3', 'MemoryMax=768M', 'CPUQuota=200%',
 f'ReadWritePaths={trial}/state', f'BindReadOnlyPaths={trial}/root/usr/share/sunshine:/usr/share/sunshine']
env = {'LD_LIBRARY_PATH':f'{trial}/root/usr/lib/x86_64-linux-gnu:{base}/video-packages/extracted/usr/lib/x86_64-linux-gnu',
 'LIBVA_DRIVERS_PATH':f'{base}/video-packages/full-driver/usr/lib/x86_64-linux-gnu/dri',
 'LIBVA_DRIVER_NAME':'iHD', 'XDG_RUNTIME_DIR':'/run/user/1000','WAYLAND_DISPLAY':'wayland-0',
 'DBUS_SYSTEM_BUS_ADDRESS':'unix:path=/nonexistent-phonepad-trial-bus'}
cmd=['pkexec','/usr/bin/systemd-run','--unit=phonepad-sunshine-trial','--collect','--wait','--pipe']
for prop in props: cmd += ['-p',prop]
cmd += [f'--setenv={k}={v}' for k,v in env.items()]
cmd += [str(trial/'root/usr/bin/sunshine'),str(trial/'state/iphone.conf')]
raise SystemExit(subprocess.call(cmd))
