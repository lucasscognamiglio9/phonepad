"""The v4l2loopback webcam made by setup.sh and the phone's H264 camera track."""
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

