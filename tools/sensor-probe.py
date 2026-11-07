#!/usr/bin/python3
"""Play the iPhone's side of the sensors, on this laptop.

Long-polls the preview service like the app does and, only while a laptop app
reads "Cámara del iPhone" or "Micrófono del iPhone", sends a test tone and a
moving test pattern over WebRTC. Prints one JSON line per demand change and
per session, so a test can check that capture follows demand.
No SDP, candidates or credentials are printed.
"""
import argparse, importlib.util, json, os, sys, threading, time
import gi
gi.require_version('Gst', '1.0'); gi.require_version('GstWebRTC', '1.0'); gi.require_version('GstSdp', '1.0')
from gi.repository import Gst, GstWebRTC, GstSdp, GLib

spec = importlib.util.spec_from_file_location('stream_probe', os.path.join(os.path.dirname(__file__), 'stream-probe.py'))
probe = importlib.util.module_from_spec(spec); spec.loader.exec_module(probe)
call = probe.call
SOURCES = {
    'audio': 'audiotestsrc is-live=true wave=sine freq=440 volume=0.3 ! audioconvert ! audioresample ! opusenc ! rtpopuspay pt=111',
    'video': ('videotestsrc is-live=true pattern=ball ! video/x-raw,width=1280,height=720,framerate=30/1 ! videoconvert '
              '! openh264enc ! h264parse ! rtph264pay pt=102 config-interval=-1 '
              '! capsfilter caps="application/x-rtp,media=video,encoding-name=H264,payload=102"'),
}
started = time.monotonic()


def log(**values):
    print(json.dumps({'t': round(time.monotonic() - started, 2), **values}), flush=True)


class Sender:
    def __init__(self, kinds):
        offer = call('POST', '/sensors', {'op': 'start', 'kinds': kinds})
        self.id = offer['id']
        self.pipeline = Gst.Pipeline.new('phone')
        self.peer = Gst.ElementFactory.make('webrtcbin', 'peer')
        self.pipeline.add(self.peer)
        self.pipeline.set_state(Gst.State.PLAYING)
        _, sdp = GstSdp.SDPMessage.new_from_text(offer['sdp'])
        done = threading.Event()
        self.peer.emit('set-remote-description', GstWebRTC.WebRTCSessionDescription.new(GstWebRTC.WebRTCSDPType.OFFER, sdp),
                       Gst.Promise.new_with_change_func(lambda *_: done.set(), None))
        done.wait(5)
        for index in range(sdp.medias_len()):
            media = sdp.get_media(index).get_media()
            transceiver = self.peer.emit('get-transceiver', index)
            transceiver.set_property('direction', GstWebRTC.WebRTCRTPTransceiverDirection.SENDONLY)
            source = Gst.parse_bin_from_description(SOURCES[media], True)
            self.pipeline.add(source); source.sync_state_with_parent()
            source.get_static_pad('src').link(self.peer.request_pad_simple(f'sink_{index}'))
        answered = threading.Event(); box = {}
        def created(promise, _):
            box['reply'] = reply = promise.get_reply(); box['answer'] = reply.get_value('answer'); answered.set()
        self.peer.emit('create-answer', None, Gst.Promise.new_with_change_func(created, None))
        answered.wait(5)
        gathered = threading.Event()
        self.peer.connect('notify::ice-gathering-state', lambda peer, _: peer.get_property('ice-gathering-state') == GstWebRTC.WebRTCICEGatheringState.COMPLETE and gathered.set())
        self.peer.emit('set-local-description', box['answer'], Gst.Promise.new())
        gathered.wait(5)
        call('POST', '/sensors', {'op': 'answer', 'id': self.id, 'sdp': self.peer.get_property('local-description').sdp.as_text()})
        log(event='sending', kinds=kinds)

    def close(self):
        self.pipeline.set_state(Gst.State.NULL)
        try: call('POST', '/sensors', {'op': 'stop', 'id': self.id}, timeout=3)
        except RuntimeError: pass
        log(event='stopped')


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--seconds', type=float, default=30)
    args = parser.parse_args()
    Gst.init(None)
    version, sender, kinds = -1, None, []
    while time.monotonic() - started < args.seconds:
        demand = call('GET', f'/sensors?after={version}', timeout=30)
        version = demand['version']
        wanted = [kind for kind in ('camera', 'mic') if demand[kind]]
        log(event='demand', mic=demand['mic'], camera=demand['camera'])
        if wanted != kinds:
            if sender: sender.close(); sender = None
            kinds = wanted
            if kinds: sender = Sender(kinds)
    if sender: sender.close()


if __name__ == '__main__':
    main()
