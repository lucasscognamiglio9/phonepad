"""Reproduce the laptop's fractional scale in the private test compositor."""
import os
from gi.repository import GLib
from mirror_lab import Mirror

mirror = Mirror()  # Enforces the private lab bus before any display change.
scale = float(os.environ['PHONEPAD_LAB_SCALE'])
if scale not in (1, 1.25, 1.5, 2): raise ValueError('Unsupported test scale')
state = mirror.state()
monitor = state[1][0]
mode = next(mode for mode in monitor[1] if mode[6].get('is-current'))
configuration = [(0, 0, scale, 0, True, [(monitor[0][0], mode[0], {})])]
for method in (0, 1):
    current = mirror.state()
    mirror.call('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
                'org.gnome.Mutter.DisplayConfig', 'ApplyMonitorsConfig',
                GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})',
                             (current[0], method, configuration, {'layout-mode': GLib.Variant('u', 1)})))
print('Lab scale:', mirror.state()[2][0][2], flush=True)
