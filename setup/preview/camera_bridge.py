"""Write the phone's camera track into the v4l2loopback webcam made by setup.sh."""
from pathlib import Path

import gi
gi.require_version('Gst', '1.0')
gi.require_version('GstWebRTC', '1.0')
from gi.repository import Gst, GstWebRTC

LABEL = 'Cámara del iPhone'
DECODERS = ('avdec_h264', 'openh264dec')
ELEMENTS = ('rtph264depay', 'h264parse', 'videoconvert', 'videoscale', 'v4l2sink')
# Apps keep the first format they see, so the webcam never changes size when the phone rotates.
OUTPUT = 'video/x-raw,format=YUY2,width=1280,height=720,pixel-aspect-ratio=1/1'
RECEIVE = ('application/x-rtp,media=video,encoding-name=H264,clock-rate=90000,payload=102,'
           'packetization-mode=(string)1,profile-level-id=(string)42e01f')


def device(root=Path('/sys/class/video4linux')):
    for entry in sorted(root.glob('video*')):
        try:
            if (entry / 'name').read_text().strip() == LABEL:
                return '/dev/' + entry.name
        except OSError:
            continue
    return None


def decoder():
    return next((name for name in DECODERS if Gst.ElementFactory.find(name)), None)


def available():
    return device() is not None and decoder() is not None and all(Gst.ElementFactory.find(name) for name in ELEMENTS)


def add_receiver(peer):
    transceiver = peer.emit('add-transceiver', GstWebRTC.WebRTCRTPTransceiverDirection.RECVONLY, Gst.Caps.from_string(RECEIVE))
    transceiver.set_property('do-nack', True)
    return transceiver


class Camera:
    def __init__(self, pipeline, path):
        self.pipeline = pipeline
        self.path = path
        self.linked = False

    def attach(self, pad):
        caps = pad.get_current_caps()
        if self.linked or caps is None or caps.get_structure(0).get_value('media') != 'video':
            return False
        branch = Gst.parse_bin_from_description(
            'queue max-size-buffers=4 leaky=downstream '
            '! rtph264depay request-keyframe=true wait-for-keyframe=true ! h264parse '
            f'! {decoder()} ! videoconvert ! videoscale add-borders=true ! {OUTPUT} '
            f'! v4l2sink device={self.path} sync=false', True)
        self.pipeline.add(branch)
        branch.sync_state_with_parent()
        pad.link(branch.get_static_pad('sink'))
        self.linked = True
        return True
