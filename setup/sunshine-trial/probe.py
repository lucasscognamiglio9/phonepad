#!/usr/bin/env python3
"""25-second local-only KMS encoder probe; never changes monitor configuration."""
from pathlib import Path
import subprocess
base = Path(__file__).resolve().parents[3] / 'runtime'
trial = base / 'sunshine-trial'
props = ['User=luque', 'AmbientCapabilities=CAP_SYS_ADMIN', 'CapabilityBoundingSet=CAP_SYS_ADMIN',
 'NoNewPrivileges=yes', 'PrivateNetwork=yes', 'ProtectSystem=strict', 'ProtectKernelTunables=yes',
 'ProtectKernelModules=yes', 'ProtectControlGroups=yes', 'RestrictNamespaces=yes',
 'RestrictSUIDSGID=yes', 'RuntimeMaxSec=25', 'TimeoutStopSec=3', 'MemoryMax=512M', 'CPUQuota=150%',
 f'ReadWritePaths={trial}/state', f'BindReadOnlyPaths={trial}/root/usr/share/sunshine:/usr/share/sunshine']
env = {'LD_LIBRARY_PATH':f'{trial}/root/usr/lib/x86_64-linux-gnu:{base}/video-packages/extracted/usr/lib/x86_64-linux-gnu',
 'LIBVA_DRIVERS_PATH':f'{base}/video-packages/full-driver/usr/lib/x86_64-linux-gnu/dri',
 'LIBVA_DRIVER_NAME':'iHD', 'XDG_RUNTIME_DIR':'/run/user/1000','WAYLAND_DISPLAY':'wayland-0',
 'DBUS_SYSTEM_BUS_ADDRESS':'unix:path=/nonexistent-phonepad-trial-bus'}
cmd=['pkexec','/usr/bin/systemd-run','--unit=phonepad-sunshine-probe','--collect','--wait','--pipe']
for prop in props: cmd += ['-p',prop]
cmd += [f'--setenv={k}={v}' for k,v in env.items()]
cmd += [str(trial/'root/usr/bin/sunshine'),str(trial/'state/sunshine.conf')]
raise SystemExit(subprocess.call(cmd))
