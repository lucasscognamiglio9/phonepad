"""The phone's camera and microphone, turned on only while a laptop app reads them.

While the phone is connected the laptop has a webcam ("Cámara del iPhone",
v4l2loopback) and a microphone ("Micrófono del iPhone", PipeWire). Both always
exist with black frames or silence, so apps can list and open them. Demand comes
from the kernel and PipeWire, never from guesses:

* v4l2loopback queues V4L2_EVENT_PRI_CLIENT_USAGE when a capture client starts
  or stops streaming (v4l2loopback.c, client_usage_queue_event).
* A PipeWire link whose output is the microphone node exists only while an app
  records from it.

The phone long-polls the demand and opens a receive-only WebRTC session with
exactly the requested kinds, so iOS shows its camera or microphone indicator
only while a laptop app uses it.
"""
import fcntl
import json
import os
import secrets
import select
import struct
import subprocess
import threading
import time

import gi
gi.require_version('Gst', '1.0')
gi.require_version('GstWebRTC', '1.0')
gi.require_version('GstSdp', '1.0')
from gi.repository import Gst, GstWebRTC, GstSdp

import audio_bridge
import camera_bridge
from rtc_codecs import disable_ice_upnp

CAMERA_CHANNEL = 'phonepad-camera'
MIC_CHANNEL = 'phonepad-mic'
# Both ends of the camera channel use these exact caps. Without a producer,
# intervideosrc leaves fields unset that v4l2sink requires. With one, it copies
# the producer's caps, so any difference stops the webcam with not-negotiated.
CAMERA_CAPS = (camera_bridge.OUTPUT + ',framerate=30/1,interlace-mode=progressive,colorimetry=bt601')
MIC_CAPS = 'audio/x-raw,format=S16LE,layout=interleaved,rate=48000,channels=1'
MICROPHONE = {'media.class': 'Audio/Source', 'node.name': 'phonepad-mic',
              'node.description': 'Micrófono del iPhone', 'node.want-driver': True}
OPUS = 'application/x-rtp,media=audio,encoding-name=OPUS,clock-rate=48000,payload=111'
# A missed poll is not a disconnect; two are.
LEASE_SECONDS = 2 * 25 + 10

# linux/videodev2.h
V4L2_EVENT_PRIVATE_START = 0x08000000
CLIENT_USAGE = V4L2_EVENT_PRIVATE_START + 0x08E00000 + 1
SUB_FL_SEND_INITIAL = 1
EVENT_SIZE = 136  # struct v4l2_event on 64-bit Linux


def _ioc(direction, number, size):
    return (direction << 30) | (size << 16) | (ord('V') << 8) | number


VIDIOC_SUBSCRIBE_EVENT = _ioc(1, 90, 32)
VIDIOC_DQEVENT = _ioc(2, 89, EVENT_SIZE)


class CameraDemand:
    """Count of apps streaming from the loopback webcam."""

    def __init__(self, path, changed):
        self.fd = os.open(path, os.O_RDWR | os.O_NONBLOCK)
        fcntl.ioctl(self.fd, VIDIOC_SUBSCRIBE_EVENT, struct.pack('8I', CLIENT_USAGE, 0, SUB_FL_SEND_INITIAL, 0, 0, 0, 0, 0))
        self.changed = changed
        self.stop_read, self.stop_write = os.pipe()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        poller = select.poll()
        poller.register(self.fd, select.POLLPRI)
        poller.register(self.stop_read, select.POLLIN)
        while True:
            for fd, _ in poller.poll():
                if fd == self.stop_read:
                    os.close(self.fd)
                    return
                event = bytearray(EVENT_SIZE)
                try:
                    fcntl.ioctl(self.fd, VIDIOC_DQEVENT, event)
                except OSError:
                    continue
                kind, count = struct.unpack_from('I4xI', event)
                if kind == CLIENT_USAGE:
                    self.changed(count)

    def close(self):
        os.write(self.stop_write, b'x')
        self.thread.join(timeout=2)
        os.close(self.stop_read)
        os.close(self.stop_write)


def _nodes(objects, node_name):
    return {item['id'] for item in objects.values() if item.get('type') == 'PipeWire:Interface:Node'
            and (item.get('info') or {}).get('props', {}).get('node.name') == node_name}


def node_present(objects, node_name):
    return bool(_nodes(objects, node_name))


def link_count(objects, node_name):
    nodes = _nodes(objects, node_name)
    return sum(1 for item in objects.values() if item.get('type') == 'PipeWire:Interface:Link'
               and (item.get('info') or {}).get('output-node-id') in nodes)


class MicDemand:
    """Count of PipeWire links that read from the microphone node."""

    def __init__(self, node_name, changed, appeared):
        self.node_name = node_name
        self.changed = changed
        self.appeared = appeared
        self.present = False
        self.count = 0
        self.process = subprocess.Popen(['stdbuf', '--output=L', 'pw-dump', '--monitor', '--no-colors'], stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, text=True)
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        decoder = json.JSONDecoder()
        objects, buffer = {}, ''
        for line in self.process.stdout:
            buffer += line
            try:
                update, end = decoder.raw_decode(buffer.lstrip())
            except ValueError:
                continue
            buffer = buffer.lstrip()[end:]
            for item in update:
                if item.get('info') is None and item.get('props') is None:
                    objects.pop(item.get('id'), None)
                else:
                    objects[item['id']] = {**objects.get(item['id'], {}), **item}
            if not self.present and node_present(objects, self.node_name):
                self.present = True
                self.appeared()
            count = link_count(objects, self.node_name)
            if count != self.count:
                self.count = count
                self.changed(count)

    def close(self):
        self.process.terminate()
        self.process.wait(timeout=2)
        self.thread.join(timeout=2)


class Feeds:
    """The laptop-side webcam and microphone. Black and silent until the phone sends media."""

    def __init__(self, camera_path):
        parts = []
        if camera_path:
            parts.append(f'intervideosrc channel={CAMERA_CHANNEL} ! {CAMERA_CAPS} ! v4l2sink device={camera_path} sync=false')
        parts.append(f'interaudiosrc channel={MIC_CHANNEL} ! {MIC_CAPS} ! pipewiresink name=microphone mode=provide sync=false')
        self.pipeline = Gst.parse_launch(' '.join(parts))
        self.pipeline.get_by_name('microphone').set_property('stream-properties', audio_bridge.node_properties(MICROPHONE))
        bus = self.pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect('message::error', lambda _bus, message: print('sensors feed error: ' + message.parse_error()[0].message, flush=True))
        if self.pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
            self.close()
            raise RuntimeError('sensor feeds unavailable')

    def close(self):
        self.pipeline.get_bus().remove_signal_watch()
        self.pipeline.set_state(Gst.State.NULL)


class Session:
    """Receive-only WebRTC peer carrying only the kinds a laptop app asked for."""

    def __init__(self, kinds):
        self.id = secrets.token_urlsafe(24)
        self.kinds = kinds
        self.ready = threading.Event()
        self.error = None
        self.pipeline = Gst.Pipeline.new('sensors')
        self.peer = Gst.ElementFactory.make('webrtcbin', 'peer')
        self.peer.set_property('bundle-policy', GstWebRTC.WebRTCBundlePolicy.MAX_BUNDLE)
        self.peer.set_property('latency', 30)
        self.pipeline.add(self.peer)
        disable_ice_upnp(self.peer)
        if 'mic' in kinds:
            self.peer.emit('add-transceiver', GstWebRTC.WebRTCRTPTransceiverDirection.RECVONLY, Gst.Caps.from_string(OPUS))
        if 'camera' in kinds:
            camera_bridge.add_receiver(self.peer)
        self.peer.connect('pad-added', self._attach)
        self.peer.connect('notify::ice-gathering-state', self._gathered)
        self.peer.connect('notify::connection-state', self._connection)
        self.pipeline.set_state(Gst.State.PLAYING)
        self.peer.emit('create-offer', None, Gst.Promise.new_with_change_func(self._offered, None))

    def _offered(self, promise, _):
        try:
            reply = promise.get_reply()  # Owns the offer; a temporary would be freed before the copy.
            self.peer.emit('set-local-description', reply.get_value('offer'), Gst.Promise.new())
        except Exception:
            self.error = 'negotiation failed'
            self.ready.set()

    def _gathered(self, peer, _):
        if peer.get_property('ice-gathering-state') == GstWebRTC.WebRTCICEGatheringState.COMPLETE:
            self.ready.set()

    def _connection(self, peer, _):
        print('sensors connection=' + peer.get_property('connection-state').value_nick, flush=True)

    def _attach(self, _peer, pad):
        media = pad.get_current_caps().get_structure(0).get_value('media')
        if media == 'audio':
            description = ('queue max-size-time=40000000 leaky=downstream ! rtpopusdepay ! opusdec plc=true '
                           f'! audioconvert ! audioresample ! {MIC_CAPS} ! interaudiosink channel={MIC_CHANNEL} sync=false')
        elif media == 'video':
            description = ('queue max-size-buffers=4 leaky=downstream '
                           '! rtph264depay request-keyframe=true wait-for-keyframe=true ! h264parse '
                           f'! {camera_bridge.decoder()} ! videoconvert ! videoscale add-borders=true ! videorate '
                           f'! {CAMERA_CAPS} ! intervideosink channel={CAMERA_CHANNEL} sync=false')
        else:
            return
        branch = Gst.parse_bin_from_description(description, True)
        self.pipeline.add(branch)
        branch.sync_state_with_parent()
        pad.link(branch.get_static_pad('sink'))

    def offer(self):
        return self.peer.get_property('local-description').sdp.as_text()

    def answer(self, text):
        if not isinstance(text, str) or len(text) > 65536 or not text.startswith('v=0'):
            raise ValueError('invalid answer')
        result, sdp = GstSdp.SDPMessage.new_from_text(text)
        if result != GstSdp.SDPResult.OK:
            raise ValueError('invalid answer')
        self.peer.emit('set-remote-description',
                       GstWebRTC.WebRTCSessionDescription.new(GstWebRTC.WebRTCSDPType.ANSWER, sdp), Gst.Promise.new())

    def close(self):
        self.pipeline.set_state(Gst.State.NULL)


class Sensors:
    """Demand state, the phone's lease and the one active sensor session."""

    def __init__(self):
        self.condition = threading.Condition()
        self.version = 0
        self.demand = {'mic': 0, 'camera': 0}
        self.watched_until = 0.0
        self.feeds = self.camera_demand = self.mic_demand = None
        self.session = None
        self.source_claimed = False
        audio_bridge.restore_defaults('source')
        threading.Thread(target=self._expire, daemon=True).start()

    def _changed(self, kind, count):
        with self.condition:
            if self.demand[kind] != count:
                self.demand[kind] = count
                self.version += 1
                print(f'sensors demand {kind}={count}', flush=True)
                self.condition.notify_all()

    def _open(self):
        camera_path = camera_bridge.device() if camera_bridge.available() else None
        self.feeds = Feeds(camera_path)
        if camera_path:
            self.camera_demand = CameraDemand(camera_path, lambda count: self._changed('camera', count))
        self.mic_demand = MicDemand(MICROPHONE['node.name'], lambda count: self._changed('mic', count), self._claim_source)
        print('sensors available camera=' + str(bool(camera_path)).lower(), flush=True)

    def _claim_source(self):
        claimed = audio_bridge.claim_default('source', MICROPHONE['node.name'])
        with self.condition:
            if self.mic_demand is not None:
                self.source_claimed = claimed
            elif claimed:
                audio_bridge.restore_defaults('source')

    def _close(self):
        if self.session:
            self.session.close()
            self.session = None
        for part in (self.camera_demand, self.mic_demand, self.feeds):
            if part:
                part.close()
        self.feeds = self.camera_demand = self.mic_demand = None
        if self.source_claimed:
            audio_bridge.restore_defaults('source')
            self.source_claimed = False
        self.demand = {'mic': 0, 'camera': 0}
        self.version += 1
        print('sensors closed', flush=True)

    def _expire(self):
        with self.condition:
            while True:
                self.condition.wait(5)
                if self.feeds and time.monotonic() > self.watched_until:
                    self._close()

    def watch(self, after, timeout=25):
        """Long-poll: answer when the demand differs from version `after`."""
        with self.condition:
            if self.feeds is None:
                self._open()
            self.watched_until = time.monotonic() + LEASE_SECONDS
            self.condition.wait_for(lambda: self.version != after or self.feeds is None, timeout)
            self.watched_until = time.monotonic() + LEASE_SECONDS
            return {'version': self.version, 'mic': self.demand['mic'] > 0, 'camera': self.demand['camera'] > 0,
                    'cameraAvailable': self.camera_demand is not None}

    def handle(self, data):
        operation = data.get('op')
        with self.condition:
            if operation == 'start':
                kinds = data.get('kinds')
                if (not isinstance(kinds, list) or not kinds or len(set(kinds)) != len(kinds)
                        or not set(kinds) <= {'mic', 'camera'} or self.feeds is None
                        or ('camera' in kinds and self.camera_demand is None)):
                    raise ValueError('invalid kinds')
                if self.session:
                    self.session.close()
                self.session = session = Session(sorted(kinds))
            elif operation in ('answer', 'stop'):
                session = self.session
                if not session or not secrets.compare_digest(str(data.get('id', '')), session.id):
                    raise ValueError('session unavailable')
                if operation == 'answer':
                    session.answer(data.get('sdp'))
                else:
                    session.close()
                    self.session = None
                return {'ok': True}
            else:
                raise ValueError('invalid operation')
        if not session.ready.wait(5) or session.error:
            with self.condition:
                if self.session is session:
                    self.session = None
            session.close()
            raise RuntimeError('sensor session unavailable')
        return {'id': session.id, 'sdp': session.offer()}

    def shutdown(self):
        with self.condition:
            if self.feeds:
                self._close()
