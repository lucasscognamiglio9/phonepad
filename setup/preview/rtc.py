"""Single-viewer native WebRTC. Called only behind Phonepad authorization.

The controller is receiver-feedback AIMD, not Google Congestion Control.
All pipeline operations run on the GLib thread; sessions have a short lease.
"""
import math
import os
import secrets
import threading
import time
import gi
gi.require_version('Gst', '1.0')
gi.require_version('GstWebRTC', '1.0')
gi.require_version('GstSdp', '1.0')
gi.require_version('GstVideo', '1.0')
from gi.repository import Gst, GstWebRTC, GstSdp, GstVideo, GLib


def disable_ice_upnp(peer):
    """Use GObject's public C property API without wrapping the floating ICE.

    webrtcbin owns an unsunk GstWebRTCNice reference. PyGObject get_property
    consumes that floating reference, causing a double unref during teardown.
    g_object_get returns explicit references; release each exactly once here.
    No pointers to screen data or credentials are accessed.
    """
    import ctypes
    capsule = ctypes.pythonapi.PyCapsule_GetPointer
    capsule.argtypes = [ctypes.py_object, ctypes.c_char_p]
    capsule.restype = ctypes.c_void_p
    library = ctypes.CDLL('libgobject-2.0.so.0')
    get = library.g_object_get
    get.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    get.restype = None
    set_property = library.g_object_set
    set_property.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    set_property.restype = None
    unref = library.g_object_unref
    unref.argtypes = [ctypes.c_void_p]
    unref.restype = None
    ice, nice = ctypes.c_void_p(), ctypes.c_void_p()
    try:
        get(capsule(peer.__gpointer__, None), b'ice-agent', ctypes.byref(ice), None)
        if not ice.value:
            raise RuntimeError('ICE unavailable')
        get(ice, b'agent', ctypes.byref(nice), None)
        if not nice.value:
            raise RuntimeError('private ICE unavailable')
        set_property(nice, b'upnp', ctypes.c_int(0), None)
        enabled = ctypes.c_int(1)
        get(nice, b'upnp', ctypes.byref(enabled), None)
        if enabled.value:
            raise RuntimeError('private ICE configuration failed')
    finally:
        if nice.value:
            unref(nice)
        if ice.value:
            unref(ice)


class RateController:
    def __init__(self, maximum=12000, initial=6000):
        self.maximum = maximum
        self.target = min(initial, maximum)
        self.base_rtt = None
        self.good = 0

    def update(self, loss, delay, rtt):
        values = (loss, delay, rtt)
        if not all(isinstance(x, (int, float)) and math.isfinite(x) for x in values):
            raise ValueError('invalid feedback')
        if not (0 <= loss <= 1 and 0 <= delay <= 10 and 0 <= rtt <= 30):
            raise ValueError('invalid feedback')
        # A distant but stable path must not be mistaken for congestion.
        if rtt > 0:
            self.base_rtt = min(self.base_rtt or rtt, rtt)
        queued_rtt = max(0, rtt - (self.base_rtt or rtt))
        if loss > .025 or delay > .10 or queued_rtt > .15:
            self.target = max(350, int(self.target * .75))
            self.good = 0
        else:
            self.good += 1
            if self.good >= 2:
                self.target = min(self.maximum, self.target + max(300, self.target // 4))
                self.good = 0
        return self.target


class Session:
    def __init__(self, source, width, height, codec="H264"):
        self.id = secrets.token_urlsafe(24)
        self.touched = time.monotonic()
        self.ready = threading.Event()
        self.error = None
        self.closed = False
        self.suspended = False
        self.codec = codec
        print('rtc start codec=' + codec, flush=True)
        hevc = codec == 'H265'
        self.rate = RateController(8000 if hevc else 12000, 4000 if hevc else 6000)
        encoder = 'vaapih265enc' if hevc else 'vaapih264enc'
        profile = 'video/x-h265,profile=main' if hevc else 'video/x-h264,profile=constrained-baseline'
        parser, payloader = ('h265parse', 'rtph265pay') if hevc else ('h264parse', 'rtph264pay')
        # Modern VA imports PipeWire DMA-BUF; selection never changes monitors.
        self.modern = codec == 'H264' and os.environ.get('PHONEPAD_ENCODER') == 'va' and Gst.ElementFactory.find('vah264enc') is not None
        processing = (
            '! vapostproc '
            f'! video/x-raw(memory:VAMemory),format=NV12,width=[2,{width}],height=[2,{height}],colorimetry=bt709 '
            f'! vah264enc name=encoder rate-control=vbr bitrate={self.rate.target} '
            'b-frames=0 ref-frames=1 key-int-max=60 cpb-size=720 target-usage=5 '
        ) if self.modern else (
            '! vaapipostproc '
            f'! video/x-raw(memory:VASurface),format=NV12,width=[2,{width}],height=[2,{height}] '
            f'! {encoder} name=encoder rate-control=vbr bitrate={self.rate.target} '
            f'max-bframes=0 keyframe-period=30 cpb-length=120 quality-level={7 if hevc else 5} '
        )
        self.pipeline = Gst.parse_launch(
            f'{source} ! queue max-size-buffers=1 max-size-bytes=0 max-size-time=0 leaky=downstream '
            '! valve name=flow drop-mode=transform-to-gap '
            + processing +
            f'! {profile} '
            f'! {parser} config-interval=-1 ! {payloader} pt=96 mtu=1200 config-interval=-1 aggregate-mode=zero-latency '
            f'! application/x-rtp,media=video,encoding-name={codec},payload=96 '
            '! webrtcbin name=peer bundle-policy=max-bundle latency=30')
        def configure_transport(bin, sub_bin, element):
            factory = element.get_factory()
            if factory and factory.get_name() == 'nicesink':
                element.set_property('sync', False)
                element.set_property('async', False)
        self.handlers = [(self.pipeline, self.pipeline.connect('deep-element-added', configure_transport))]
        self.probes = []
        self.peer = self.pipeline.get_by_name('peer')
        # The private Tailscale path needs no router port mappings. libnice's
        # UPnP discovery/removal can also stall negotiation and teardown.
        disable_ice_upnp(self.peer)
        self.encoder = self.pipeline.get_by_name('encoder')
        self.flow = self.pipeline.get_by_name('flow')
        self.counts = {'source':0,'input':0,'encoded':0}
        self.last_counts = self.counts.copy()
        self.encode_started = {}
        self.encode_ms = []
        self.sample_time = time.monotonic()
        self.last_diagnostic = 0
        self.last_keyframe = 0
        def count(pad, info, key):
            self.counts[key] += 1
            buffer = info.get_buffer()
            if buffer and key == 'input':
                if len(self.encode_started) > 120:
                    self.encode_started.clear()
                self.encode_started[buffer.pts] = time.monotonic()
            elif buffer and key == 'encoded':
                started = self.encode_started.pop(buffer.pts, None)
                if started is not None:
                    self.encode_ms.append((time.monotonic() - started) * 1000)
                    self.encode_ms = self.encode_ms[-120:]
            return Gst.PadProbeReturn.OK
        if self.pipeline.get_by_name('capture'):
            # PipeWire is damage-driven: a still desktop may send only one frame
            # before ICE completes. Keep it alive at 2 fps only while unchanged.
            self.pipeline.get_by_name('capture').set_property('keepalive-time', 500)
            pad = self.pipeline.get_by_name('capture').get_static_pad('src')
            self.probes.append((pad, pad.add_probe(Gst.PadProbeType.BUFFER, count, 'source')))
        for direction, key in [('sink', 'input'), ('src', 'encoded')]:
            pad = self.encoder.get_static_pad(direction)
            self.probes.append((pad, pad.add_probe(Gst.PadProbeType.BUFFER, count, key)))
        self.bus = self.pipeline.get_bus()
        self.bus.add_signal_watch()
        for owner, signal, callback in [
            (self.bus, 'message::error', self.failed),
            (self.peer, 'notify::ice-gathering-state', self.gathered),
            (self.peer, 'notify::connection-state', self.connection),
            (self.peer, 'on-negotiation-needed', self.negotiate),
        ]:
            self.handlers.append((owner, owner.connect(signal, callback)))
        self.offering = False
        # Explicit real-time clock/latency prevents the transport pipeline from
        # throttling PipeWire (measured ~18 fps before, ~43-48 fps after locally).
        self.pipeline.use_clock(Gst.SystemClock.obtain())
        self.pipeline.set_latency(0)
        self.pipeline.set_state(Gst.State.PLAYING)

    def negotiate(self, peer):
        if self.offering or self.closed:
            return
        self.offering = True
        peer.emit('create-offer', None, Gst.Promise.new_with_change_func(self.offered, None))

    def offered(self, promise, _):
        if self.closed:
            return
        try:
            reply = promise.get_reply()
            offer = reply.get_value('offer')
            self.peer.emit('set-local-description', offer, Gst.Promise.new())
        except Exception:
            self.error = 'negotiation failed'
            self.ready.set()

    def gathered(self, peer, _):
        if peer.get_property('ice-gathering-state') == GstWebRTC.WebRTCICEGatheringState.COMPLETE:
            print('rtc offer gathered', flush=True)
            self.ready.set()

    def connection(self, peer, _):
        print('rtc connection=' + peer.get_property('connection-state').value_nick, flush=True)
        if peer.get_property('connection-state') == GstWebRTC.WebRTCPeerConnectionState.CONNECTED:
            GLib.idle_add(self.request_keyframe)
        if peer.get_property('connection-state') == GstWebRTC.WebRTCPeerConnectionState.FAILED:
            GLib.idle_add(self.close)

    def request_keyframe(self):
        if not self.closed and time.monotonic() - self.last_keyframe >= 1:
            self.last_keyframe = time.monotonic()
            event = GstVideo.video_event_new_upstream_force_key_unit(Gst.CLOCK_TIME_NONE, True, 0)
            self.encoder.get_static_pad('src').send_event(event)
        return False

    def failed(self, bus, message):
        self.error = str(message.parse_error()[0])
        print(self.error, flush=True)
        self.ready.set()
        self.close()

    def answer(self, text):
        if not isinstance(text, str) or len(text) > 65536 or not text.startswith('v=0'):
            raise ValueError('invalid answer')
        print('rtc answer candidates=' + str(text.count('a=candidate:')), flush=True)
        result, sdp = GstSdp.SDPMessage.new_from_text(text)
        if result != GstSdp.SDPResult.OK:
            raise ValueError('invalid answer')
        self.peer.emit('set-remote-description',
                       GstWebRTC.WebRTCSessionDescription.new(GstWebRTC.WebRTCSDPType.ANSWER, sdp),
                       Gst.Promise.new())
        self.touched = time.monotonic()

    def suspend(self):
        if not self.suspended:
            self.suspended = True
            self.touched = time.monotonic()
            self.flow.set_property('drop', True)
        return {'ok': True}

    def resume(self):
        if self.suspended and time.monotonic() - self.touched >= 300:
            self.close()
            raise ValueError('session expired')
        self.suspended = False
        self.touched = time.monotonic()
        self.sample_time = time.monotonic()
        self.last_counts = self.counts.copy()
        self.flow.set_property('drop', False)
        self.request_keyframe()
        return {'ok': True}

    def feedback(self, data):
        if self.suspended:
            return {'suspended': True}

        target = self.rate.update(data.get('loss', 0), data.get('delay', 0), data.get('rtt', 0))
        self.encoder.set_property('bitrate', target)
        self.touched = time.monotonic()
        now=time.monotonic();elapsed=max(.001,now-self.sample_time)
        rates={key+'Fps':round((value-self.last_counts[key])/elapsed,1) for key,value in self.counts.items()}
        self.sample_time=now;self.last_counts=self.counts.copy()
        if data.get('client') == 'native' and data.get('frames') == 0:
            self.request_keyframe()
        if data.get('client') == 'native' and now-self.last_diagnostic >= 1:
            self.last_diagnostic = now
            metrics = {key: data.get(key) for key in ('frames','fps','width','height','bytes') if isinstance(data.get(key),(int,float)) and math.isfinite(data[key])}
            print('rtc native=' + str(metrics) + ' sender=' + str(rates), flush=True)
        samples = sorted(self.encode_ms)
        return {**rates, 'sourceCaps': self.pipeline.get_by_name('capture').get_static_pad('src').get_current_caps().to_string() if self.pipeline.get_by_name('capture') else None, 'codec': self.codec + ' / VA-API', 'encodeP95Ms': round(samples[min(len(samples)-1, int(len(samples)*.95))], 2) if samples else None, 'bitrateKbps': self.encoder.get_property('bitrate'), 'controller': 'receiver-aimd', 'encoderCaps': self.encoder.get_static_pad('sink').get_current_caps().to_string()}

    def close(self):
        if not self.closed:
            self.closed = True
            print('rtc closed encoded=' + str(self.counts['encoded']), flush=True)
            self.flow.set_property('drop', True)
            self.pipeline.send_event(Gst.Event.new_flush_start())
            self.pipeline.set_state(Gst.State.NULL)
            self.bus.remove_signal_watch()
            # GObject callbacks retain Python closures; disconnect them explicitly
            # so old sessions and their GPU buffers cannot form ownership cycles.
            for owner, handler in self.handlers:
                owner.disconnect(handler)
            self.handlers.clear()
            for pad, probe in self.probes:
                pad.remove_probe(probe)
            self.probes.clear()
            self.encoder = self.flow = self.peer = self.bus = self.pipeline = None
            self.ready.set()
        return False


class Manager:
    def __init__(self, source):
        self.source = source
        self.session = None
        GLib.timeout_add_seconds(2, self.expire)

    def expire(self):
        if self.session and time.monotonic() - self.session.touched >= (300 if self.session.suspended else 12):
            self.session.close()
            self.session = None
        return True

    def dispatch(self, action):
        event = threading.Event()
        box = {}
        def run():
            try:
                box['result'] = action()
            except Exception as error:
                box['error'] = error
            finally:
                event.set()
            return False
        GLib.idle_add(run)
        if not event.wait(5):
            raise TimeoutError('capture busy')
        if 'error' in box:
            raise box['error']
        return box.get('result')

    def handle(self, data):
        operation = data.get('op')
        if operation == 'diagnostic':
            phase = data.get('phase')
            if phase not in ('status','offer','remote-description','answer','ice-gathering','send-answer','receiving'):
                raise ValueError('invalid diagnostic')
            print('rtc native startup failed phase=' + phase, flush=True)
            return {'ok': True}
        if operation == 'start':
            def start():
                if self.session:
                    self.session.close()
                source, original_width, original_height = self.source()
                codec = data.get('codec', 'H264')
                if codec not in ('H264', 'H265'):
                    raise ValueError('unsupported codec')
                width = data.get('width', 1920)
                if not isinstance(width, int) or not 320 <= width <= 1920:
                    raise ValueError('invalid width')
                # Portal size is logical on fractional-scale GNOME. Negotiate physical
                # PipeWire dimensions with bounds, rather than rescaling to that metadata.
                self.session = Session(source, width, 1080, codec)
                return self.session
            session = self.dispatch(start)
            if not session.ready.wait(7) or session.error or session.closed:
                self.dispatch(session.close)
                raise RuntimeError('WebRTC unavailable')
            def description():
                local = session.peer.get_property('local-description')
                return {'id': session.id, 'type': 'offer', 'sdp': local.sdp.as_text()}
            return self.dispatch(description)
        def update():
            session = self.session
            if not session or session.closed or not secrets.compare_digest(str(data.get('id', '')), session.id):
                raise ValueError('session unavailable')
            if operation == 'answer':
                session.answer(data.get('sdp'))
                return {'ok': True}
            if operation == 'suspend':
                return session.suspend()
            if operation == 'resume':
                return session.resume()
            if operation == 'feedback':
                return session.feedback(data)
            if operation == 'stop':
                session.close()
                return {'ok': True}
            raise ValueError('invalid operation')
        return self.dispatch(update)
