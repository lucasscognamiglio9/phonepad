import json, os, pathlib, threading, time, faulthandler
from frame_metrics import summarize
import gi
gi.require_version('Gst', '1.0')
from gi.repository import Gst, Gio, GLib

root = pathlib.Path(os.environ['PHONEPAD_HFR_ROOT'])
if not str(root).startswith('/tmp/phonepad-hfr-') or str(root) not in os.environ['DBUS_SESSION_BUS_ADDRESS']:
    raise RuntimeError('Refusing to access a non-lab compositor')
Gst.init(None)
faulthandler.dump_traceback_later(int(os.environ.get('PHONEPAD_LAB_SECONDS', '15')) + 15)
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
SC = 'org.gnome.Mutter.ScreenCast'
def call(path, iface, method, args=None):
    return bus.call_sync(SC, path, iface, method, args, None, Gio.DBusCallFlags.NONE, 5000, None)
loop = GLib.MainLoop()
threading.Thread(target=loop.run, daemon=True).start()
mirror = None
session = None
pipeline = None
try:
    if os.environ.get('PHONEPAD_LAB_MIRROR') == '1':
        from mirror_lab import Mirror
        mirror = Mirror()
        source = mirror.prepare()
    else:
        session = call('/org/gnome/Mutter/ScreenCast', SC, 'CreateSession', GLib.Variant('(a{sv})', ({},))).unpack()[0]
        stream = call(session, SC + '.Session', 'RecordMonitor',
                      GLib.Variant('(sa{sv})', ('Meta-0', {'cursor-mode': GLib.Variant('u', 0)}))).unpack()[0]
        nodes = []
        bus.signal_subscribe(SC, SC + '.Stream', 'PipeWireStreamAdded', stream, None,
                             Gio.DBusSignalFlags.NONE, lambda *args: nodes.append(args[-1].unpack()[0]))
        call(session, SC + '.Session', 'Start')
        for _ in range(100):
            if nodes: break
            time.sleep(.05)
        if not nodes: raise RuntimeError('No isolated PipeWire stream')
        source = f'pipewiresrc name=capture path={nodes[0]} do-timestamp=true'
    pipeline = Gst.parse_launch(
        source + ' '
        '! queue max-size-buffers=1 max-size-bytes=0 max-size-time=0 leaky=downstream '
        '! vapostproc name=convert ! video/x-raw(memory:VAMemory),format=NV12 '
        '! vah264enc name=encoder rate-control=vbr bitrate=12000 b-frames=0 ref-frames=1 '
        'key-int-max=60 cpb-size=720 target-usage=5 '
        '! video/x-h264,profile=constrained-baseline ! h264parse '
        f'! filesink location={root}/motion.h264 sync=false')
    arrivals = {'source': [], 'encoded': []}
    def count(pad, info, key):
        arrivals[key].append(time.monotonic()); return Gst.PadProbeReturn.OK
    pipeline.get_by_name('capture').get_static_pad('src').add_probe(Gst.PadProbeType.BUFFER, count, 'source')
    pipeline.get_by_name('encoder').get_static_pad('src').add_probe(Gst.PadProbeType.BUFFER, count, 'encoded')
    pipeline.use_clock(Gst.SystemClock.obtain()); pipeline.set_latency(0)
    pipeline.set_state(Gst.State.PLAYING)
    if mirror: mirror.activate()
    measurement_start = time.monotonic()
    duration = int(os.environ.get('PHONEPAD_LAB_SECONDS', '15'))
    error = None
    while time.monotonic() - measurement_start < duration:
        error = pipeline.get_bus().timed_pop_filtered(Gst.SECOND, Gst.MessageType.ERROR)
        snapshot = {name: len(values) for name, values in arrivals.items()}
        snapshot['elapsed'] = round(time.monotonic() - measurement_start, 2)
        print(json.dumps(snapshot), flush=True)
        if error: break
    measurement_end = time.monotonic()
    caps = pipeline.get_by_name('capture').get_static_pad('src').get_current_caps()
    metrics = {name: summarize(list(values), measurement_start, measurement_end)
               for name, values in arrivals.items()}
    result = {'sourceFps': metrics['source']['fps'], 'encodedFps': metrics['encoded']['fps'],
              'measurementSeconds': measurement_end - measurement_start,
              'metrics': metrics, 'measurementIncludesStalls': True,
              'encodedFrames': metrics['encoded']['frames'], 'sourceCaps': caps.to_string() if caps else None,
              'error': str(error.parse_error()[0]) if error else None,
              'scope': 'isolated GNOME animation; no network or iPhone',
              'distinctFramesVerified': False}
    (root / 'result.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)
finally:
    print('Closing source', flush=True)
    if mirror: mirror.close()
    if pipeline:
        print('Flushing pipeline', flush=True)
        pipeline.send_event(Gst.Event.new_flush_start())
        print('Stopping pipeline', flush=True)
        pipeline.set_state(Gst.State.NULL)
        print('Pipeline stopped', flush=True)
    if session: call(session, SC + '.Session', 'Stop')
    loop.quit()
