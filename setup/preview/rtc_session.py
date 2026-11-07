"""One native WebRTC viewer: pipeline, peer connection and rate control."""
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
from rtc_codecs import (disable_ice_upnp, modern_h264_encoder, enable_video_recovery, _caps_from_pipeline, _max_frame_age_ms, _lab_h264_config, _lab_encoder_options, desktop_quantizer_limit)
from media_contract import dimensions_from_caps, unknown_media, validate_media
from rate_control import RateController
from gcc_controller import (GCCController, GCCControllerError, controller_name,
                            require_runtime)
from frame_freshness import FrameFreshness, memory_descriptor
from live_capture import configure_live_capture
from frame_cadence import FrameCadence
import audio_bridge


class Session:
    def __init__(self, source, width, height, codec="H264", media_tracker=None, media_provider=None, output_size=None, cursor_metadata=False, cursor_delivery=1, audio=False):
        self.id = secrets.token_urlsafe(24)
        self.audio_devices = audio_bridge.Devices() if audio and audio_bridge.available() else None
        if self.audio_devices is not None and self.audio_devices.speaker is None:
            self.audio_devices.close()
            self.audio_devices = None
        self.audio = self.audio_devices is not None
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
        self.modern = codec == 'H264' and modern_h264_encoder()
        self.lab_config = _lab_h264_config(60 if self.modern else 30) if codec == 'H264' else None
        # VA treats unknown capture cadence as 30 fps. Explicitly bound sparse
        # capture to 60 without inventing idle frames. VCM is the driver's
        # conferencing mode. The measured VBR configuration accumulated delay
        # and degraded desktop detail in the loss/capacity comparison. VCM still
        # calculates driver buffer parameters; it does not remove every buffer.
        options = (_lab_encoder_options() or {'fps': 60, 'targetUsage': 3,
                   'rateControl': 'vcm', 'cpbSize': 0, 'targetPercentage': 100}) if self.modern else None
        cadence = '! identity name=video_cadence ' if options and options['fps'] else ''
        # Set encoder cadence after VA import. capssetter's upstream ANY query
        # otherwise prevents PipeWire from negotiating a DMA-BUF input format.
        cadence_caps = (f'! capssetter name=video_cadence_caps caps="video/x-raw,framerate={options["fps"]}/1" '
                        if options and options['fps'] else '')
        self.frame_cadence = FrameCadence(options['fps']) if options and options['fps'] else None
        default_kbps = 4000 if hevc else 6000
        requested_kbps = self.lab_config['bitrateKbps'] if self.lab_config else None
        maximum_kbps = max(8000 if hevc else 12000, requested_kbps or default_kbps)
        initial_kbps = requested_kbps or default_kbps
        self.quality_recovery_pending = False
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
            cadence + '! vapostproc name=converter '
            f'! video/x-raw(memory:VAMemory),format=NV12,{size_caps},colorimetry=bt709 '
            + cadence_caps +
            f'! vah264enc name=encoder rate-control={options["rateControl"] if options else "vbr"} bitrate={initial_kbps} target-percentage={options["targetPercentage"] if options else 66} '
            f'max-qp={desktop_quantizer_limit(initial_kbps)} b-frames=0 ref-frames=1 key-int-max={self.lab_config["keyint"] if self.lab_config else 60} cpb-size={options["cpbSize"] if options else 720} target-usage={options["targetUsage"] if options else 5} '
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
            '! webrtcbin name=peer bundle-policy=max-bundle latency=30 '
            + (audio_bridge.speaker_branch() if self.audio else ''))
        if self.audio:
            self.pipeline.get_by_name('speaker').set_property('stream-properties', audio_bridge.node_properties(audio_bridge.CAPTURE))
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
        if self.frame_cadence:
            def limit_frames(_pad, info):
                buffer = info.get_buffer()
                if buffer is None:
                    return Gst.PadProbeReturn.OK
                pts = buffer.pts if buffer.pts != Gst.CLOCK_TIME_NONE else time.monotonic_ns()
                # Leaky queues mark loss as DISCONT. That must not bypass the
                # cadence bound; a backwards PTS already starts a new epoch.
                return (Gst.PadProbeReturn.OK if self.frame_cadence.accept(pts)
                        else Gst.PadProbeReturn.DROP)
            pad = self.pipeline.get_by_name('video_cadence').get_static_pad('src')
            self.probes.append((pad, pad.add_probe(Gst.PadProbeType.BUFFER, limit_frames)))
        live_probe = configure_live_capture(self.pipeline.get_by_name('capture'))
        if live_probe: self.probes.append(live_probe)
        self.peer = self.pipeline.get_by_name('peer')
        # webrtcbin disables packet retransmission by default. Enable the
        # video transceiver before creating an offer so RTX/NACK are negotiated
        # with native libwebrtc instead of relying only on periodic keyframes.
        try:
            self.video_transceiver = enable_video_recovery(self.peer)
        except Exception:
            self.pipeline.set_state(Gst.State.NULL)
            raise
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
        self.counts = {'source':0,'input':0,'encoded':0,'keyframes':0}
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
                if not buffer.has_flags(Gst.BufferFlags.DELTA_UNIT):
                    self.counts['keyframes'] += 1
                encode_ms = result.get('latencyMs', {}).get('encoderInputToEncoded')
                if encode_ms is not None:
                    self.encode_ms.append(encode_ms)
                    self.encode_ms = self.encode_ms[-120:]
            if result.get('drop'):
                return Gst.PadProbeReturn.DROP
            return Gst.PadProbeReturn.OK
        capture = self.pipeline.get_by_name('capture')
        if capture:
            # PipeWire is damage-driven: a still desktop may send only one frame
            # before ICE completes. Keep it alive at 2 fps only while unchanged.
            if capture.find_property('keepalive-time') is not None:
                capture.set_property('keepalive-time', 500)
            pad = capture.get_static_pad('src')
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
        if cursor_metadata:
            self.pipeline.set_state(Gst.State.READY)
            options = Gst.Structure.new_empty('cursor-options')
            options.set_value('ordered', False)
            self.cursor_delivery = cursor_delivery
            if cursor_delivery == 2:
                # Positions expire instead of waiting behind an obsolete trail.
                options.set_value('max-packet-lifetime', 50)
                options.set_value('priority', GstWebRTC.WebRTCPriorityType.HIGH)
            else:
                options.set_value('max-retransmits', 0)
            self.cursor_open_state = GstWebRTC.WebRTCDataChannelState.OPEN
            label = 'phonepad-cursor-v2' if cursor_delivery == 2 else 'phonepad-cursor-v1'
            self.cursor_channel = self.peer.emit('create-data-channel', label, options)
            if self.cursor_channel is None:
                self.close(); raise RuntimeError('cursor data channel unavailable')
            if cursor_delivery == 2:
                # A lost bitmap must be retransmitted, without making positions
                # themselves reliable/ordered. Only the newest shape is queued.
                image_options = Gst.Structure.new_empty('cursor-image-options')
                image_options.set_value('priority', GstWebRTC.WebRTCPriorityType.LOW)
                self.cursor_image_channel = self.peer.emit('create-data-channel', 'phonepad-cursor-image-v2', image_options)
                if self.cursor_image_channel is None:
                    self.close(); raise RuntimeError('cursor image channel unavailable')
        self.pipeline.set_state(Gst.State.PLAYING)
        if self.audio:
            self.audio_devices.claim('sink', audio_bridge.SPEAKER['node.name'])
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
        if getattr(self, 'cursor_guardian', None): self.cursor_guardian.set_active(False)
        if not self.suspended:
            self.suspended = True
            self.touched = time.monotonic()
            self.flow.set_property('drop', True)
            if self.audio:
                self.audio_devices.release('sink')
        return {'ok': True}

    def resume(self):
        if getattr(self, 'cursor_guardian', None): self.cursor_guardian.set_active(True)
        if self.suspended and time.monotonic() - self.touched >= 300:
            self.close()
            raise ValueError('session expired')
        if self.suspended and self.audio:
            self.audio_devices.claim('sink', audio_bridge.SPEAKER['node.name'])
        self.suspended = False
        controller_mode = getattr(self, 'controller_name', 'legacy')
        if controller_mode != 'gcc':
            self.rate.reset()
            self.quality_recovery_pending = False
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
            if int(self.encoder.get_property('bitrate')) != target:
                if getattr(self, 'modern', False):
                    maximum_qp = desktop_quantizer_limit(target)
                    if int(self.encoder.get_property('max-qp')) != maximum_qp:
                        # max-qp latches at encoder reconfiguration. Set it
                        # before bitrate, whose setter triggers that reconfig.
                        self.encoder.set_property('max-qp', maximum_qp)
                self.encoder.set_property('bitrate', target)
            applied_kbps = int(self.encoder.get_property('bitrate'))
            decision = {**self.rate.decision, 'appliedKbps': applied_kbps}
        # Reference recovery is codec behavior, independent of the bitrate
        # controller. GCC's transport adaptation cannot repair a lost image.
        # Wait for a known loss-free interval, then request one clean frame.
        loss = data.get('loss')
        if loss is not None and loss >= .08:
            self.quality_recovery_pending = True
        elif (getattr(self, 'quality_recovery_pending', False) and loss == 0
              and time.monotonic() - getattr(self, 'last_keyframe', 0) >= 1):
            self.request_keyframe()
            self.quality_recovery_pending = False
        self.touched = time.monotonic()
        now=time.monotonic();elapsed=max(.001,now-self.sample_time)
        rates={key+'Fps':round((value-self.last_counts[key])/elapsed,1) for key,value in self.counts.items()}
        self.sample_time=now;self.last_counts=self.counts.copy()
        if data.get('client') == 'native' and data.get('frames') == 0:
            self.request_keyframe()
        if data.get('client') == 'native' and data.get('refreshFrame') is True:
            self.request_keyframe()
        if data.get('client') == 'native' and now-self.last_diagnostic >= 1:
            self.last_diagnostic = now
            metrics = {key: data.get(key) for key in ('frames','fps','width','height','bytes') if isinstance(data.get(key),(int,float)) and math.isfinite(data[key])}
            # No candidate addresses, SDP, credentials or user content. These
            # receiver values distinguish encoding delay from network jitter.
            network = {}
            for key, label, scale, maximum in (('loss','lossFraction',1,1), ('delay','jitterBufferMs',1000,10), ('rtt','roundTripMs',1000,30)):
                value = data.get(key)
                if type(value) in (int, float) and math.isfinite(value) and 0 <= value <= maximum:
                    network[label] = round(value * scale, 3)
            freshness = getattr(self, 'freshness', None)
            snapshot = freshness.snapshot(1) if freshness is not None else None
            compact = ({key: snapshot[key] for key in ('stages', 'latencyMs', 'queueDepth')}
                       if snapshot is not None else None)
            print('rtc ' + json.dumps({'receiver': metrics, 'network': network, 'sender': rates, 'controller': reported_controller,
                                       'cursorTransport': dict(self.cursor_sender.counts) if getattr(self, 'cursor_sender', None) else None,
                                       'decision': {key:value for key,value in decision.items() if key != 'route'}, 'gcc': controller.snapshot() if controller else None,
                                       'freshness': compact}), flush=True)
        samples = sorted(self.encode_ms)
        response = {**rates, 'sourceCaps': self.pipeline.get_by_name('capture').get_static_pad('src').get_current_caps().to_string() if self.pipeline.get_by_name('capture') else None, 'codec': self.codec + ' / VA-API', 'encodeP95Ms': round(samples[min(len(samples)-1, int(len(samples)*.95))], 2) if samples else None, 'bitrateKbps': applied_kbps, 'controller': reported_controller, 'rateDecision': decision, 'encoderCaps': self.encoder.get_static_pad('sink').get_current_caps().to_string(), 'media': self.media_snapshot()}
        response['keyframesEncoded'] = self.counts.get('keyframes')
        if getattr(self, 'cursor_sender', None):
            response['cursorTransport'] = {'version': self.cursor_sender.delivery, **self.cursor_sender.counts}
        if getattr(self, 'frame_cadence', None):
            response['cadence'] = {'maximumFps': self.frame_cadence.fps,
                                   'rawFramesDropped': self.frame_cadence.dropped}
        if controller is not None:
            response['gcc'] = controller.snapshot()
        if getattr(self, 'lab_config', None) is not None:
            response['labConfig'] = self.lab_config
            response['actualEncoder'] = {key: self.encoder.get_property(key)
                                        for key in ('cpb-size', 'target-usage', 'bitrate')
                                        if self.encoder.find_property(key)}
        return response

    def close(self):
        sender = getattr(self, 'cursor_sender', None)
        if sender: self.cursor_sender = None; sender.close()
        if getattr(self, 'cursor_guardian', None): self.cursor_guardian.close()
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
            if getattr(self, 'audio_devices', None) is not None:
                self.audio_devices.close()
                self.audio_devices = None
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
