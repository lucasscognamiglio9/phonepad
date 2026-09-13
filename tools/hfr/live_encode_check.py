"""Explicit, bounded live-desktop validation. Saves counters, never screen frames.

Must run in a dedicated systemd unit with RuntimeMaxSec and KillMode=control-group.
The same producer-first shutdown has been checked in isolated GNOME, including
capture-worker SIGKILL. The original display scale and resolution are preserved.
"""
import json, os, pathlib, signal, subprocess, sys, threading, time

if sys.argv[1:] != ['--validate-live'] or os.environ.get('PHONEPAD_VIRTUAL_MIRROR') != '1':
    raise SystemExit('Explicit live validation required')
root=pathlib.Path(os.environ['PHONEPAD_LIVE_CHECK_ROOT'])
if not str(root).startswith('/tmp/phonepad-live-check-'):
    raise SystemExit('Invalid evidence directory')
root.mkdir(mode=0o700,exist_ok=True)
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[2]/'setup/preview'))
import gi
gi.require_version('Gst','1.0')
from gi.repository import Gst, GLib
from virtual_source import Mirror
from frame_metrics import summarize
Gst.init(None)
loop=GLib.MainLoop();threading.Thread(target=loop.run,daemon=True).start()
stop=threading.Event()
signal.signal(signal.SIGTERM,lambda *_:stop.set())
signal.signal(signal.SIGINT,lambda *_:stop.set())
mirror=Mirror();pipeline=None;scene=None;metrics={'source':[],'encoded':[]}
try:
    source=mirror.prepare()
    pipeline=Gst.parse_launch(source+' ! queue max-size-buffers=1 max-size-bytes=0 max-size-time=0 leaky=downstream '
        '! vapostproc ! video/x-raw(memory:VAMemory),format=NV12,colorimetry=bt709 '
        '! vah264enc name=encoder bitrate=12000 rate-control=vbr b-frames=0 ref-frames=1 key-int-max=60 cpb-size=720 target-usage=5 '
        '! video/x-h264,profile=constrained-baseline ! fakesink sync=false async=false')
    def count(pad,info,key):metrics[key].append(time.monotonic());return Gst.PadProbeReturn.OK
    for element,pad,key in [('capture','src','source'),('encoder','src','encoded')]:
        pipeline.get_by_name(element).get_static_pad(pad).add_probe(Gst.PadProbeType.BUFFER,count,key)
    pipeline.use_clock(Gst.SystemClock.obtain());pipeline.set_latency(0);pipeline.set_state(Gst.State.PLAYING)
    mirror.activate()
    # Only our temporary test window is closed. Existing apps are untouched.
    scene_env=os.environ.copy()
    for key in ('LD_LIBRARY_PATH','GST_PLUGIN_PATH','GST_REGISTRY','GI_TYPELIB_PATH','LIBVA_DRIVERS_PATH'):
        scene_env.pop(key,None)
    scene=subprocess.Popen(['/usr/bin/python3',str(pathlib.Path(__file__).with_name('scene.py'))],env=scene_env,stdout=subprocess.DEVNULL)
    stop.wait(2)
    start=time.monotonic();stop.wait(15);end=time.monotonic()
    result={'scope':'live desktop capture and encode; no network or iPhone',
            'originalScale':mirror.original_layout[0][2], 'seconds':end-start,
            'metrics':{k:summarize(v,start,end) for k,v in metrics.items()}}
    (root/'result.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result),flush=True)
finally:
    if scene and scene.poll() is None:
        scene.terminate()
        try:scene.wait(timeout=2)
        except subprocess.TimeoutExpired:scene.kill();scene.wait()
    mirror.close()
    if pipeline:
        pipeline.send_event(Gst.Event.new_flush_start());pipeline.set_state(Gst.State.NULL)
    loop.quit()
    print('live check restored original display',flush=True)
