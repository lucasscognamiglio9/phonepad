"""Optional VA runtime for the isolated worker; independent of /tmp scripts."""
import os, pathlib, sys
runtime = pathlib.Path(__file__).resolve().parents[3] / 'runtime'
base = runtime / 'video-packages/extracted/usr/lib/x86_64-linux-gnu'
env = os.environ.copy()
for path in [base, runtime / 'video-modern/plugins', runtime / 'video-modern/lib']:
    if not path.is_dir(): raise SystemExit('Missing lab runtime: ' + str(path))
env.update(
    LD_LIBRARY_PATH=str(runtime / 'video-modern/lib') + ':' + str(base),
    LIBVA_DRIVERS_PATH=str(runtime / 'video-packages/full-driver/usr/lib/x86_64-linux-gnu/dri'),
    GST_PLUGIN_PATH=str(runtime / 'video-modern/plugins') + ':' + str(runtime / 'video-plugins'),
    GST_REGISTRY=str(pathlib.Path(env['PHONEPAD_HFR_ROOT']) / 'gst-registry.bin'),
    GI_TYPELIB_PATH=str(base / 'girepository-1.0'),
    PHONEPAD_ENCODER='va',
)
if env.get('PHONEPAD_LAB_DECODE') == '1':
    decoder = runtime.parent / 'tools/hfr-decode'
    env['GST_PLUGIN_PATH'] = str(decoder / 'plugins') + ':' + env['GST_PLUGIN_PATH']
    env['LD_LIBRARY_PATH'] = str(decoder / 'extracted/usr/lib/x86_64-linux-gnu') + ':' + env['LD_LIBRARY_PATH']
os.execve('/usr/bin/python3', ['/usr/bin/python3', *sys.argv[1:]], env)
