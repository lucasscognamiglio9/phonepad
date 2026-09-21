"""Single-viewer native WebRTC. Called only behind Phonepad authorization.

The controller is receiver-feedback AIMD, not Google Congestion Control.
All pipeline operations run on the GLib thread; sessions have a short lease.
"""
import os
import math
import json
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


from media_contract import (MediaContractError, MediaTracker, dimensions_from_caps,
                            fit_square_pixel_size, requested_codecs, unknown_media, validate_media)
from rate_control import RateController
from gcc_controller import (GCCController, GCCControllerError, controller_name,
                            require_runtime)
from frame_freshness import FrameFreshness, memory_descriptor


def available_codecs():
    """Return codecs whose complete local GStreamer path is present.

    This is a factory/runtime probe only.  It does not claim that a receiver
    can decode a codec; the Manager still chooses from the request's list.
    """

    try:
        if Gst.ElementFactory.find('webrtcbin') is None:
            return []
        result = []
        modern = os.environ.get('PHONEPAD_ENCODER') == 'va' and Gst.ElementFactory.find('vah264enc') is not None
        h264_encoder = 'vah264enc' if modern else 'vaapih264enc'
        h264_postproc = 'vapostproc' if modern else 'vaapipostproc'
        if all(Gst.ElementFactory.find(name) is not None for name in (h264_postproc, h264_encoder, 'h264parse', 'rtph264pay')):
            result.append('H264')
        if all(Gst.ElementFactory.find(name) is not None for name in ('vaapipostproc', 'vaapih265enc', 'h265parse', 'rtph265pay')):
            result.append('H265')
        return result
    except Exception:
        return []


def _caps_from_pipeline(pipeline, element_name, pad_name):
    if pipeline is None:
        return None
    try:
        element = pipeline.get_by_name(element_name)
        if element is None:
            return None
        pad = element.get_static_pad(pad_name)
        return pad.get_current_caps() if pad is not None else None
    except (AttributeError, TypeError, RuntimeError):
        return None


def _max_frame_age_ms():
    """Read an opt-in pre-encode freshness threshold.

    Zero keeps the existing pipeline behavior.  A future experiment can set a
    bounded threshold after observing the reported age distribution; no value
    is guessed into the default path.
    """

    raw = os.environ.get('PHONEPAD_MAX_FRAME_AGE_MS', '0')
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return 0
    return value if math.isfinite(value) and 0 < value <= 10_000 else 0


def _lab_h264_config(default_keyint):
    """Read H264 matrix knobs only inside the disposable lab."""

    if not os.environ.get('PHONEPAD_HFR_ROOT'):
        return None
    profiles = {
        'baseline': 'constrained-baseline',
        'constrained-baseline': 'constrained-baseline',
        'high': 'high',
    }
    raw_profile = os.environ.get('PHONEPAD_LAB_H264_PROFILE', 'constrained-baseline').strip().lower()
    if raw_profile not in profiles:
        raise ValueError('unsupported PHONEPAD_LAB_H264_PROFILE')
    try:
        bitrate_kbps = int(os.environ.get('PHONEPAD_LAB_H264_BITRATE_KBPS', '6000'))
    except (TypeError, ValueError):
        raise ValueError('invalid PHONEPAD_LAB_H264_BITRATE_KBPS')
    if bitrate_kbps not in (6000, 12000, 18000, 24000, 32000):
        raise ValueError('unsupported PHONEPAD_LAB_H264_BITRATE_KBPS')
    try:
        keyint = int(os.environ.get('PHONEPAD_LAB_H264_KEYINT', str(default_keyint)))
    except (TypeError, ValueError):
        raise ValueError('invalid PHONEPAD_LAB_H264_KEYINT')
    if not 1 <= keyint <= 600:
        raise ValueError('invalid PHONEPAD_LAB_H264_KEYINT')
    try:
        fps = int(float(os.environ.get('PHONEPAD_MIRROR_HZ', '120')))
    except (TypeError, ValueError):
        raise ValueError('invalid PHONEPAD_MIRROR_HZ')
    if fps not in (60, 90, 120):
        raise ValueError('unsupported PHONEPAD_MIRROR_HZ')
    return {
        'profile': profiles[raw_profile],
        'requestedProfile': raw_profile,
        'bitrateKbps': bitrate_kbps,
        'keyint': keyint,
        'fps': fps,
        'fixedBitrate': os.environ.get('PHONEPAD_LAB_FIXED_BITRATE', '0') == '1',
    }


class Session:
    def __init__(self, source, width, height, codec="H264", media_tracker=None, media_provider=None, output_size=None):
        self.id = secrets.token_urlsafe(24)
        self.touched = time.monotonic()
        self.ready = threading.Event()
        self.error = None
        self.closed = False
        self.suspended = False
        self.codec = codec
        self.media_tracker = media_tracker
        self.media_provider = media_provider
        self.controller_name = controller_name()
        self.controller = None
        if self.controller_name == 'gcc':
            # Reject a requested controller before opening capture or starting
            # a pipeline. Missing private factories must be visible to the
            # caller, never turn into a silent legacy fallback.
            require_runtime()
        print('rtc start codec=' + codec + ' controller=' + self.controller_name, flush=True)
        hevc = codec == 'H265'
        encoder = 'vaapih265enc' if hevc else 'vaapih264enc'
        # Modern VA imports PipeWire DMA-BUF; selection never changes monitors.
        self.modern = codec == 'H264' and os.environ.get('PHONEPAD_ENCODER') == 'va' and Gst.ElementFactory.find('vah264enc') is not None
        self.lab_config = _lab_h264_config(60 if self.modern else 30) if codec == 'H264' else None
        default_kbps = 4000 if hevc else 6000
        requested_kbps = self.lab_config['bitrateKbps'] if self.lab_config else None
        maximum_kbps = max(8000 if hevc else 12000, requested_kbps or default_kbps)
        initial_kbps = requested_kbps or default_kbps
        self.rate = (RateController(maximum_kbps, initial_kbps,
                                    policy=os.environ.get('PHONEPAD_RATE_POLICY', 'windowed'))
                     if self.controller_name == 'legacy' else None)
        profile = ('video/x-h265,profile=main' if hevc else
                   'video/x-h264,profile=' + (self.lab_config['profile'] if self.lab_config else 'constrained-baseline'))
        parser, payloader = ('h265parse', 'rtph265pay') if hevc else ('h264parse', 'rtph264pay')
        # A virtual source with validated physical dimensions can choose an
        # exact square-pixel output. Portal logical sizes are not such proof.
        size_caps = (f'width={output_size[0]},height={output_size[1]},pixel-aspect-ratio=1/1'
                     if output_size else f'width=[2,{width}],height=[2,{height}]')
        processing = (
            '! vapostproc name=converter '
            f'! video/x-raw(memory:VAMemory),format=NV12,{size_caps},colorimetry=bt709 '
            f'! vah264enc name=encoder rate-control=vbr bitrate={initial_kbps} '
            f'b-frames=0 ref-frames=1 key-int-max={self.lab_config["keyint"] if self.lab_config else 60} cpb-size=720 target-usage=5 '
        ) if self.modern else (
            '! vaapipostproc name=converter '
            f'! video/x-raw(memory:VASurface),format=NV12,{size_caps} '
            f'! {encoder} name=encoder rate-control=vbr bitrate={initial_kbps} '
            f'max-bframes=0 keyframe-period={self.lab_config["keyint"] if self.lab_config else 30} cpb-length=120 quality-level={7 if hevc else 5} '
        )
        self.pipeline = Gst.parse_launch(
            f'{source} ! queue name=frame_queue max-size-buffers=1 max-size-bytes=0 max-size-time=0 leaky=downstream '
            '! valve name=flow drop-mode=transform-to-gap '
            + processing +
            f'! {profile} '
            f'! {parser} config-interval=-1 ! {payloader} name=payloader pt=96 mtu=1200 config-interval=-1 aggregate-mode=zero-latency '
            f'! application/x-rtp,media=video,encoding-name={codec},payload=96 '
            '! webrtcbin name=peer bundle-policy=max-bundle latency=30')
        def configure_transport(bin, sub_bin, element):
            factory = element.get_factory()
            if factory and factory.get_name() == 'nicesink':
                element.set_property('sync', False)
                element.set_property('async', False)
        # All local stage timestamps use this one clock.  Buffer PTS values are
        # converted from running-time by adding the same pipeline base time.
        self.pipeline.use_clock(Gst.SystemClock.obtain())
        self.handlers = [(self.pipeline, self.pipeline.connect('deep-element-added', configure_transport))]
        self.probes = []
        self.peer = self.pipeline.get_by_name('peer')
        # The private Tailscale path needs no router port mappings. libnice's
        # UPnP discovery/removal can also stall negotiation and teardown.
        disable_ice_upnp(self.peer)
        self.encoder = self.pipeline.get_by_name('encoder')
        self.payloader = self.pipeline.get_by_name('payloader')
        if getattr(self, 'controller_name', 'legacy') == 'gcc':
            try:
                self.controller = GCCController(self.peer, self.payloader, self.encoder, codec)
            except Exception:
                self.pipeline.set_state(Gst.State.NULL)
                raise
        self.flow = self.pipeline.get_by_name('flow')
        self.counts = {'source':0,'input':0,'encoded':0}
        self.last_counts = self.counts.copy()
        self.freshness = FrameFreshness(
            max_age_ms=_max_frame_age_ms(),
            clock_domain='gst-pipeline-clock',
        )
        self.encode_ms = []
        self.sample_time = time.monotonic()
        self.last_diagnostic = 0
        self.last_keyframe = 0
        def queue_depth():
            queue = self.pipeline.get_by_name('frame_queue')
            if queue is None:
                return None
            try:
                return int(queue.get_property('current-level-buffers'))
            except (AttributeError, TypeError, ValueError, RuntimeError):
                return None

        def clock_time_ns():
            try:
                clock = self.pipeline.get_clock()
                if clock is not None:
                    return int(clock.get_time())
            except (AttributeError, TypeError, ValueError, RuntimeError):
                pass
            return time.monotonic_ns()

        def buffer_timestamp_ns(pad, buffer):
            if buffer is None:
                return None, None, 'unknown'
            try:
                pts = int(buffer.pts)
                if pts < 0 or pts >= (1 << 63):
                    return None, None, 'unknown'
                source_pts = pts
                base_time = int(self.pipeline.get_base_time())
                if base_time <= 0:
                    return None, source_pts, 'unknown'
                mapping = 'base_time_plus_pts'
                segment_event = pad.get_sticky_event(Gst.EventType.SEGMENT, 0)
                if segment_event is not None:
                    segment = segment_event.parse_segment()
                    if segment.format != Gst.Format.TIME:
                        return None, source_pts, 'unknown_non_time_segment'
                    running_time = segment.to_running_time(Gst.Format.TIME, pts)
                    if running_time == Gst.CLOCK_TIME_NONE:
                        return None, source_pts, 'unknown_segment_range'
                    pts = int(running_time)
                    mapping = 'segment_to_running_time'
                return base_time + pts, source_pts, mapping
            except (AttributeError, TypeError, ValueError, RuntimeError):
                return None, None, 'unknown'

        def buffer_format_name(pad):
            """Return caps observed at this probe, or explicit unknown.

            A pad's negotiated caps describe the format at that stage.  Do
            not infer a format from an earlier pad when caps are unavailable;
            that would make the stage sample look more certain than it is.
            """
            try:
                caps = pad.get_current_caps()
                return caps.to_string() if caps is not None else 'unknown'
            except (AttributeError, TypeError, RuntimeError):
                return 'unknown'

        def observe(pad, info, stage):
            buffer = info.get_buffer()
            if buffer is None:
                return Gst.PadProbeReturn.OK
            key = {'capture': 'source', 'encoder_input': 'input', 'encoded': 'encoded'}.get(stage)
            if key is not None:
                self.counts[key] += 1
            timestamp_ns, source_pts_ns, pts_mapping = buffer_timestamp_ns(pad, buffer)
            result = self.freshness.record(
                stage,
                timestamp_ns,
                clock_time_ns(),
                descriptor=memory_descriptor(buffer),
                queue_depth=queue_depth(),
                format_name=buffer_format_name(pad),
                pts_mapping=pts_mapping,
                source_pts_ns=source_pts_ns,
            )
            if stage == 'encoded':
                encode_ms = result.get('latencyMs', {}).get('encoderInputToEncoded')
                if encode_ms is not None:
                    self.encode_ms.append(encode_ms)
                    self.encode_ms = self.encode_ms[-120:]
            if result.get('drop'):
                return Gst.PadProbeReturn.DROP
            return Gst.PadProbeReturn.OK
        if self.pipeline.get_by_name('capture'):
            # PipeWire is damage-driven: a still desktop may send only one frame
            # before ICE completes. Keep it alive at 2 fps only while unchanged.
            self.pipeline.get_by_name('capture').set_property('keepalive-time', 500)
            pad = self.pipeline.get_by_name('capture').get_static_pad('src')
            self.probes.append((pad, pad.add_probe(Gst.PadProbeType.BUFFER, observe, 'capture')))
        converter = self.pipeline.get_by_name('converter')
        if converter is not None:
            for direction, stage in [('sink', 'converter_input'), ('src', 'converter_output')]:
                pad = converter.get_static_pad(direction)
                self.probes.append((pad, pad.add_probe(Gst.PadProbeType.BUFFER, observe, stage)))
        for direction, stage in [('sink', 'encoder_input'), ('src', 'encoded')]:
            pad = self.encoder.get_static_pad(direction)
            self.probes.append((pad, pad.add_probe(Gst.PadProbeType.BUFFER, observe, stage)))
        payloader_src = self.payloader.get_static_pad('src')
        self.probes.append((payloader_src, payloader_src.add_probe(Gst.PadProbeType.BUFFER, observe, 'packetized')))
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
        self.pipeline.set_latency(0)
        self.pipeline.set_state(Gst.State.PLAYING)
        self.refresh_media()

    def refresh_media(self):
        """Refresh only from fixed current caps; logical portal properties are ignored."""

        tracker = getattr(self, 'media_tracker', None)
        if tracker is not None:
            capture = dimensions_from_caps(_caps_from_pipeline(self.pipeline, 'capture', 'src'))
            # The encoder sink is raw input to the selected encoder.  Prefer
            # its src caps when the encoder exposes fixed encoded dimensions.
            encoded = dimensions_from_caps(_caps_from_pipeline(self.pipeline, 'encoder', 'src'))
            if encoded is None:
                encoded = dimensions_from_caps(_caps_from_pipeline(self.pipeline, 'encoder', 'sink'))
            tracker.update_geometry(capture=capture, encoded=encoded)
            return tracker.snapshot()
        provider = getattr(self, 'media_provider', None)
        if provider is not None:
            return validate_media(provider())
        return unknown_media(source_reason='source_not_exposed', geometry_reason='geometry_not_exposed', video_reason='codec_not_exposed')

    def media_snapshot(self):
        return self.refresh_media()

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
        if getattr(self, 'controller_name', 'legacy') == 'gcc':
            try:
                self.controller.validate_answer(text)
            except GCCControllerError:
                # Do not leave a GCC session alive after accepting an answer
                # that cannot provide the feedback the requested controller
                # depends on.
                self.close()
                raise
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
        controller_mode = getattr(self, 'controller_name', 'legacy')
        if controller_mode != 'gcc':
            self.rate.reset()
        self.touched = time.monotonic()
        self.sample_time = time.monotonic()
        self.last_counts = self.counts.copy()
        self.flow.set_property('drop', False)
        self.request_keyframe()
        return {'ok': True, 'media': self.media_snapshot()}

    def feedback(self, data):
        if self.suspended:
            result = {'suspended': True}
            if getattr(self, 'media_tracker', None) is not None or getattr(self, 'media_provider', None) is not None:
                result['media'] = self.media_snapshot()
            return result

        controller = getattr(self, 'controller', None)
        controller_mode = getattr(self, 'controller_name', 'legacy')
        reported_controller = 'gcc' if controller_mode == 'gcc' else self.rate.policy
        if controller_mode == 'gcc':
            controller.receiver_report_received(data)
            applied_kbps = int(self.encoder.get_property('bitrate'))
            decision = {
                'controller': 'gcc',
                'reason': 'gstreamer_gcc',
                'requestedKbps': None,
                'appliedKbps': applied_kbps,
            }
        else:
            if getattr(self, 'lab_config', None) and self.lab_config['fixedBitrate']:
                target = self.lab_config['bitrateKbps']
                self.rate.target = target
                self.rate.decision = {
                    'policy': 'lab_fixed',
                    'reason': 'fixed_matrix_rate',
                    'requestedKbps': target,
                }
            else:
                target = self.rate.update(data.get('loss'), data.get('delay'), data.get('rtt'), route=data.get('route'), sequence=data.get('sequence'))
            self.encoder.set_property('bitrate', target)
            applied_kbps = int(self.encoder.get_property('bitrate'))
            decision = {**self.rate.decision, 'appliedKbps': applied_kbps}
        self.touched = time.monotonic()
        now=time.monotonic();elapsed=max(.001,now-self.sample_time)
        rates={key+'Fps':round((value-self.last_counts[key])/elapsed,1) for key,value in self.counts.items()}
        self.sample_time=now;self.last_counts=self.counts.copy()
        if data.get('client') == 'native' and data.get('frames') == 0:
            self.request_keyframe()
        if data.get('client') == 'native' and now-self.last_diagnostic >= 1:
            self.last_diagnostic = now
            metrics = {key: data.get(key) for key in ('frames','fps','width','height','bytes') if isinstance(data.get(key),(int,float)) and math.isfinite(data[key])}
            freshness = getattr(self, 'freshness', None)
            print('rtc ' + json.dumps({'receiver': metrics, 'sender': rates, 'controller': reported_controller,
                                       'decision': decision, 'gcc': controller.snapshot() if controller else None,
                                       'freshness': freshness.snapshot() if freshness is not None else None}), flush=True)
        samples = sorted(self.encode_ms)
        freshness = getattr(self, 'freshness', None)
        response = {**rates, 'sourceCaps': self.pipeline.get_by_name('capture').get_static_pad('src').get_current_caps().to_string() if self.pipeline.get_by_name('capture') else None, 'codec': self.codec + ' / VA-API', 'encodeP95Ms': round(samples[min(len(samples)-1, int(len(samples)*.95))], 2) if samples else None, 'bitrateKbps': applied_kbps, 'controller': reported_controller, 'rateDecision': decision, 'encoderCaps': self.encoder.get_static_pad('sink').get_current_caps().to_string(), 'freshness': freshness.snapshot() if freshness is not None else None, 'media': self.media_snapshot()}
        if controller is not None:
            response['gcc'] = controller.snapshot()
        if getattr(self, 'lab_config', None) is not None:
            response['labConfig'] = self.lab_config
        return response

    def close(self):
        if not self.closed:
            self.closed = True
            freshness = getattr(self, 'freshness', None)
            print('rtc closed encoded=' + str(self.counts['encoded']) +
                  ' freshness=' + json.dumps(freshness.snapshot() if freshness is not None else None),
                  flush=True)
            controller = getattr(self, 'controller', None)
            if controller is not None:
                controller.close()
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
            if getattr(self, 'media_tracker', None) is not None:
                self.media_tracker.clear_encoded()
            self.ready.set()
        return False


def _remove_glib_source(source_id):
    """Best-effort removal of a source that has not started yet.

    GLib can race a source callback with ``source_remove``.  The dispatch task
    still checks its cancellation bit in that case, so removal is only a
    scheduling optimisation and never the correctness guard.
    """
    if source_id is None:
        return
    try:
        GLib.source_remove(source_id)
    except Exception:
        pass


class DispatchCancelled(RuntimeError):
    """An action was withdrawn before its GLib callback began."""


class _DispatchTask:
    """One cancellable action queued on the GLib context."""

    def __init__(self, action, owner=None):
        self.action = action
        self.owner = owner
        self.event = threading.Event()
        self.box = {}
        self.lock = threading.Lock()
        self.started = False
        self.cancelled = False
        self.source_id = None

    def attach_source(self, source_id):
        with self.lock:
            self.source_id = source_id
            remove = self.cancelled and not self.started
        if remove:
            _remove_glib_source(source_id)

    def cancel(self):
        """Cancel only if the action has not begun; return whether it did."""
        with self.lock:
            if self.started:
                return False
            self.cancelled = True
            source_id = self.source_id
        self.event.set()
        _remove_glib_source(source_id)
        return True

    def run(self):
        with self.lock:
            if self.cancelled:
                self.event.set()
                return False
            self.started = True
        if self.owner is not None:
            with self.owner._life_lock:
                self.owner._glib_thread_id = threading.get_ident()
        try:
            self.box['result'] = self.action()
        except Exception as error:
            self.box['error'] = error
        finally:
            self.event.set()
        return False


class Manager:
    def __init__(self, source, media_tracker=None, media_provider=None, codec_probe=None, source_dimensions=None):
        self.source = source
        self.media_tracker = media_tracker
        self.media_provider = media_provider
        self.codec_probe = codec_probe or available_codecs
        self.source_dimensions = source_dimensions
        self.session = None
        self._life_lock = threading.RLock()
        self._dispatch_tasks = set()
        self._closing = False
        self._closed = False
        self._glib_thread_id = None
        self._shutdown_started = False
        self._shutdown_queued = False
        self._shutdown_event = threading.Event()
        self._shutdown_error = None
        self._probe_media()
        self._expiry_source = GLib.timeout_add_seconds(2, self.expire)

    def _ensure_lifecycle(self):
        # A few small tests construct Manager.__new__(Manager) to exercise
        # expiry without bringing up GStreamer.  Keep those fixtures valid.
        if not hasattr(self, '_life_lock'):
            self._life_lock = threading.RLock()
        if not hasattr(self, '_dispatch_tasks'):
            self._dispatch_tasks = set()
        if not hasattr(self, '_closing'):
            self._closing = False
        if not hasattr(self, '_closed'):
            self._closed = False
        if not hasattr(self, '_glib_thread_id'):
            self._glib_thread_id = None
        if not hasattr(self, '_shutdown_started'):
            self._shutdown_started = False
        if not hasattr(self, '_shutdown_queued'):
            self._shutdown_queued = False
        if not hasattr(self, '_shutdown_event'):
            self._shutdown_event = threading.Event()
        if not hasattr(self, '_shutdown_error'):
            self._shutdown_error = None

    def _cancel_pending(self):
        self._ensure_lifecycle()
        with self._life_lock:
            tasks = list(self._dispatch_tasks)
        for task in tasks:
            task.cancel()

    def _begin_closing(self):
        self._ensure_lifecycle()
        with self._life_lock:
            self._closing = True
        self._cancel_pending()

    @property
    def closing(self):
        self._ensure_lifecycle()
        with self._life_lock:
            return self._closing

    @property
    def closed(self):
        self._ensure_lifecycle()
        with self._life_lock:
            return self._closed

    def _probe_media(self):
        if self.media_tracker is None:
            return
        try:
            codecs = self.codec_probe()
            if codecs:
                self.media_tracker.set_codecs(codecs)
            else:
                self.media_tracker.set_video_unavailable('encoder_unavailable')
        except Exception:
            self.media_tracker.set_video_unknown('codec_probe_failed')

    def media_snapshot(self):
        if self.media_tracker is not None:
            return self.media_tracker.snapshot()
        if self.media_provider is not None:
            return validate_media(self.media_provider())
        if self.session is not None:
            return self.session.media_snapshot()
        return unknown_media(source_reason='source_not_exposed', geometry_reason='geometry_not_exposed', video_reason='codec_not_exposed')

    def _media_fence(self, data):
        expected_source = data.get('sourceId')
        expected_epoch = data.get('geometryEpoch')
        if expected_source is None and expected_epoch is None:
            return
        if expected_source is not None and not isinstance(expected_source, str):
            raise ValueError('media_stale')
        if expected_epoch is not None and (isinstance(expected_epoch, bool) or not isinstance(expected_epoch, int) or not 1 <= expected_epoch <= (1 << 53) - 1):
            raise ValueError('media_stale')
        media = self.media_snapshot()
        source = media['source']
        geometry = media['geometry']
        if expected_source is not None and (source.get('state') != 'available' or source.get('id') != expected_source):
            raise ValueError('media_stale')
        if expected_epoch is not None and (geometry.get('state') != 'available' or geometry.get('epoch') != expected_epoch):
            raise ValueError('media_stale')

    def _source_value(self):
        value = self.source()
        if not isinstance(value, (tuple, list)) or not value:
            raise RuntimeError('source unavailable')
        if len(value) >= 3:
            return value[0], value[1], value[2]
        return value[0], None, None

    def expire(self):
        self._ensure_lifecycle()
        with self._life_lock:
            if self._closing or self._closed:
                return False
        if self.session and time.monotonic() - self.session.touched >= (300 if self.session.suspended else 12):
            self.session.close()
            self.session = None
        return True

    def dispatch(self, action, timeout=5, allow_closing=False):
        self._ensure_lifecycle()
        with self._life_lock:
            if self._closing and not allow_closing:
                raise ValueError('manager closing')
            task = _DispatchTask(action, self)
            self._dispatch_tasks.add(task)
        try:
            task.attach_source(GLib.idle_add(task.run))
            if not task.event.wait(timeout):
                # If the callback has not started, this prevents it from
                # executing after the HTTP request already timed out.  Once
                # started, GStreamer cannot safely interrupt the in-flight
                # action; the caller gets a bounded timeout and shutdown will
                # close the session when the GLib action returns.
                task.cancel()
                raise TimeoutError('capture busy')
            with task.lock:
                if task.cancelled:
                    raise DispatchCancelled('capture action cancelled')
            if 'error' in task.box:
                raise task.box['error']
            return task.box.get('result')
        finally:
            with self._life_lock:
                self._dispatch_tasks.discard(task)

    def _shutdown_on_loop(self):
        self._begin_closing()
        with self._life_lock:
            if self._closed:
                if self._shutdown_error is not None:
                    raise self._shutdown_error
                return False
            if self._shutdown_started:
                return False
            self._shutdown_started = True
            self._shutdown_queued = True
            expiry_source = getattr(self, '_expiry_source', None)
            self._expiry_source = None
            session = self.session
            self.session = None
        _remove_glib_source(expiry_source)
        error = None
        try:
            if session is not None and not getattr(session, 'closed', False):
                session.close()
        except Exception as shutdown_error:
            error = shutdown_error
        finally:
            with self._life_lock:
                self._shutdown_error = error
                # Do not advertise closed until the owner-thread destructor
                # has returned. Callers may still observe closing meanwhile.
                self._closed = True
                self._shutdown_started = False
                self._shutdown_event.set()
        if error is not None:
            raise error
        return False

    def shutdown_on_loop(self):
        """Close on the GLib owner thread; safe to call repeatedly."""
        return self._shutdown_on_loop()

    def shutdown(self, timeout=5):
        """Request bounded shutdown from any thread.

        The normal signal path queues ``shutdown_on_loop``. Its private
        completion event is never cancelled on timeout, so a close requested
        during a busy GLib action runs once when the owner becomes available.
        A timeout is reported explicitly; an in-flight GStreamer action cannot
        be interrupted safely.
        """
        self._ensure_lifecycle()
        self._begin_closing()
        if threading.get_ident() == getattr(self, '_glib_thread_id', None):
            return self._shutdown_on_loop()
        with self._life_lock:
            if self._closed:
                if self._shutdown_error is not None:
                    raise self._shutdown_error
                return True
            enqueue = not self._shutdown_queued
            self._shutdown_queued = True
            event = self._shutdown_event
        if enqueue:
            try:
                GLib.idle_add(self._shutdown_callback)
            except Exception:
                with self._life_lock:
                    self._shutdown_queued = False
                raise
        if not event.wait(timeout):
            raise TimeoutError('manager shutdown timed out')
        with self._life_lock:
            error = self._shutdown_error
            closed = self._closed
        if error is not None:
            raise error
        return closed

    def _shutdown_callback(self):
        try:
            self._shutdown_on_loop()
        except Exception as error:
            # _shutdown_on_loop records the error and marks completion. Keep
            # the GLib callback itself non-throwing so the context survives.
            with self._life_lock:
                self._shutdown_error = error
                self._shutdown_event.set()
        return False

    def handle(self, data):
        operation = data.get('op')
        self._ensure_lifecycle()
        with self._life_lock:
            if self._closing and operation != 'stop':
                raise ValueError('manager closing')
        if operation == 'diagnostic':
            phase = data.get('phase')
            if phase not in ('status','offer','remote-description','answer','ice-gathering','send-answer','receiving'):
                raise ValueError('invalid diagnostic')
            print('rtc native startup failed phase=' + phase, flush=True)
            return {'ok': True}
        if operation == 'start':
            preferences = requested_codecs(data)
            width = data.get('width', 1920)
            if type(width) is not int or not 320 <= width <= 1920:
                raise ValueError('invalid width')
            self._media_fence(data)
            available = []
            try:
                available = list(self.codec_probe())
            except Exception:
                available = []
            if not available:
                raise ValueError('no codec available')
            chosen = next((codec for codec in preferences if codec in available), None)
            if chosen is None:
                raise ValueError('unsupported codec')
            if chosen not in ('H264', 'H265'):
                raise ValueError('unsupported codec')

            def start():
                with self._life_lock:
                    if self._closing:
                        raise ValueError('manager closing')
                source, _logical_width, _logical_height = self._source_value()
                output_size = None
                if self.source_dimensions is not None:
                    output_size = fit_square_pixel_size(self.source_dimensions(), (width, 1080))
                if self.session:
                    self.session.close()
                # Portal size is logical on fractional-scale GNOME. Negotiate physical
                # PipeWire dimensions with encode bounds, rather than rescaling to
                # that metadata. Actual geometry is read from current caps.
                self.session = Session(source, width, 1080, chosen,
                                       media_tracker=self.media_tracker,
                                       media_provider=self.media_provider, output_size=output_size)
                return self.session
            session = self.dispatch(start)
            if not session.ready.wait(7) or session.error or session.closed:
                self.dispatch(session.close)
                with self._life_lock:
                    if self.session is session:
                        self.session = None
                raise RuntimeError('WebRTC unavailable')
            def description():
                local = session.peer.get_property('local-description')
                offer_sdp = local.sdp.as_text()
                if session.controller_name == 'gcc':
                    session.controller.validate_offer(offer_sdp)
                if self.media_tracker is not None:
                    try:
                        self.media_tracker.select_codec(session.codec)
                    except MediaContractError:
                        # A successful offer is a runtime proof when a factory
                        # probe was unavailable; never claim it before this
                        # point.
                        self.media_tracker.set_codecs([session.codec], selected=session.codec)
                return {'id': session.id, 'type': 'offer', 'sdp': offer_sdp, 'media': session.media_snapshot()}
            try:
                return self.dispatch(description)
            except Exception:
                self.dispatch(session.close)
                with self._life_lock:
                    if self.session is session:
                        self.session = None
                raise
        def update():
            session = self.session
            if not session or session.closed or not secrets.compare_digest(str(data.get('id', '')), session.id):
                raise ValueError('session unavailable')
            # stop is cleanup and must remain possible after a source or caps
            # generation changed. Every other update can opt into the fence.
            if operation != 'stop':
                self._media_fence(data)
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
        return self.dispatch(update, allow_closing=(operation == 'stop'))
