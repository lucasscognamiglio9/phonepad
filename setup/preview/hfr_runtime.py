"""Load the isolated VA runtime in the encoder child, never in the gateway."""
import os
import pathlib
import sys

here = pathlib.Path(__file__).resolve().parent
env = os.environ.copy()
lab = env.get('PHONEPAD_HFR_ROOT', '')
isolated = lab.startswith('/tmp/phonepad-hfr-') and lab in env.get('DBUS_SESSION_BUS_ADDRESS', '')
if not isolated:
    runtime = here / 'hfr'
    for directory in (runtime / 'lib', runtime / 'plugins'):
        if not directory.is_dir():
            raise SystemExit('Phonepad HFR runtime is not installed')
    env['LD_LIBRARY_PATH'] = str(runtime / 'lib') + ':' + env.get('LD_LIBRARY_PATH', '')
    env['GST_PLUGIN_PATH'] = str(runtime / 'plugins') + ':' + env.get('GST_PLUGIN_PATH', '')
    env['GST_REGISTRY'] = str(pathlib.Path(env['XDG_RUNTIME_DIR']) / 'phonepad-preview/hfr-registry.bin')
env['PHONEPAD_ENCODER'] = 'va'
os.execve(sys.executable, [sys.executable, str(here / 'hfr_worker.py')], env)
