#!/usr/bin/python3
"""Measure the screen stream the way the iPhone receives it, on this laptop.

Talks to the preview service's private Unix socket with the same requests the
app sends, receives with GStreamer's webrtcbin and reports:
  - time from the start request to the first decoded frame,
  - decoded fps and frame gaps,
  - laptop audio level (Opus decoded),
  - cursor metadata messages,
  - glass-to-receiver latency with --flash (a fullscreen window toggles black
    and white; each toggle is matched with the first frame that shows it).
--frame PATH saves one decoded frame as PNG, for checking the cursor.
No SDP, candidates or credentials are printed.
"""
import argparse, json, os, socket, struct, subprocess, sys, threading, time, zlib
import gi
gi.require_version('Gst', '1.0'); gi.require_version('GstWebRTC', '1.0'); gi.require_version('GstSdp', '1.0')
from gi.repository import Gst, GstWebRTC, GstSdp, GLib

SOCKET = os.path.join(os.environ['XDG_RUNTIME_DIR'], 'phonepad-preview', 'capture.sock')


def call(method, path, body=None, timeout=40):
    data = json.dumps(body).encode() if body is not None else b''
    with socket.socket(socket.AF_UNIX) as s:
        s.settimeout(timeout); s.connect(SOCKET)
        head = f'{method} {path} HTTP/1.0\r\nHost: preview\r\nContent-Type: application/json\r\nContent-Length: {len(data)}\r\n\r\n'
        s.sendall(head.encode() + data)
        reply = b''
        while chunk := s.recv(65536): reply += chunk
    status, _, payload = reply.partition(b'\r\n\r\n')
    code = int(status.split()[1])
    if code != 200: raise RuntimeError(f'{path} -> {code} {payload[:200]!r}')
    return json.loads(payload)


def png(path, width, height, rgb):
    rows = b''.join(b'\0' + rgb[y*width*3:(y+1)*width*3] for y in range(height))
    chunk = lambda kind, body: struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body))
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
                + chunk(b'IDAT', zlib.compress(rows, 6)) + chunk(b'IEND', b''))


FLASHER = r'''
import gi,sys,time
gi.require_version('Gtk','4.0')
from gi.repository import Gtk,GLib
app=Gtk.Application()
def run(app):
    w=Gtk.ApplicationWindow(application=app);w.fullscreen()
    css=Gtk.CssProvider();css.load_from_string('.b{background:#000;color:#888}.w{background:#fff;color:#888}')
    Gtk.StyleContext.add_provider_for_display(w.get_display(),css,800)
    w.add_css_class('b');state=[False]
    # A small label that moves every display frame keeps the screen damaged,
    # so the stream runs at its full rate instead of only on toggles.
    tick=Gtk.Label(label='|');tick.set_halign(Gtk.Align.START);tick.set_valign(Gtk.Align.END);w.set_child(tick)
    def move(widget,clock):
        tick.set_margin_start(int(clock.get_frame_time()/16667)%200);return True
    tick.add_tick_callback(move)
    def flip():
        state[0]=not state[0]
        w.remove_css_class('w' if not state[0] else 'b');w.add_css_class('w' if state[0] else 'b')
        print(('W' if state[0] else 'B'),time.monotonic(),flush=True);return True
    GLib.timeout_add(700,flip);w.present()
app.connect('activate',run);app.run([])
'''


class Probe:
    def __init__(self, args):
        self.args = args
        self.t0 = time.monotonic()
        self.marks = {}
        self.frames = []          # receive times of decoded frames
        self.levels = []          # audio RMS dB
        self.cursor = 0
        self.flips = []           # (color, monotonic)
        self.transitions = []     # latency samples ms
        self.by_color = {}
        self.last_bright = None
        self.saved = False
        self.pipeline = Gst.Pipeline.new('probe')
        self.peer = Gst.ElementFactory.make('webrtcbin', 'peer')
        self.peer.set_property('bundle-policy', GstWebRTC.WebRTCBundlePolicy.MAX_BUNDLE)
        self.pipeline.add(self.peer)
        self.peer.connect('pad-added', self.pad_added)
        self.peer.connect('on-data-channel', self.channel)
        self.peer.connect('notify::connection-state', lambda p, _: self.mark('connection-' + p.get_property('connection-state').value_nick))
        self.loop = GLib.MainLoop()

    def mark(self, name):
        if name not in self.marks: self.marks[name] = round((time.monotonic() - self.t0) * 1000)

    def channel(self, _peer, channel):
        channel.connect('on-message-string', lambda *_: setattr(self, 'cursor', self.cursor + 1))

    def pad_added(self, _peer, pad):
        caps = pad.get_current_caps().get_structure(0)
        if caps.get_string('media') == 'video':
            desc = ('rtph264depay ! h264parse ! avdec_h264 ! videoconvert ! tee name=t '
                    't. ! queue ! videoscale ! video/x-raw,format=GRAY8,width=64,height=36 ! appsink name=small emit-signals=true sync=false '
                    't. ! queue leaky=downstream max-size-buffers=1 ! videoconvert ! video/x-raw,format=RGB ! appsink name=full emit-signals=true sync=false max-buffers=1 drop=true')
        elif caps.get_string('media') == 'audio':
            desc = 'rtpopusdepay ! opusdec ! audioconvert ! level name=level interval=200000000 post-messages=true ! fakesink sync=false'
        else:
            return
        branch = Gst.parse_bin_from_description(desc, True)
        self.pipeline.add(branch); branch.sync_state_with_parent()
        pad.link(branch.get_static_pad('sink'))
        small = branch.get_by_name('small')
        if small: small.connect('new-sample', self.small_frame)
        full = branch.get_by_name('full')
        if full: full.connect('new-sample', self.full_frame)

    def small_frame(self, sink):
        now = time.monotonic()
        sample = sink.emit('pull-sample'); buf = sample.get_buffer()
        ok, info = buf.map(Gst.MapFlags.READ)
        bright = sum(info.data[::7]) / len(info.data[::7]); buf.unmap(info)
        self.frames.append(now); self.mark('first-frame')
        if self.args.flash and self.last_bright is not None:
            state = 'W' if bright > 128 else 'B'
            prev = 'W' if self.last_bright > 128 else 'B'
            if state != prev:
                flip = next((t for c, t in reversed(self.flips) if c == state and t <= now), None)
                if flip and now - flip < 1: self.transitions.append((now - flip) * 1000); self.by_color.setdefault(state, []).append(round((now - flip) * 1000))
        self.last_bright = bright
        return Gst.FlowReturn.OK

    def full_frame(self, sink):
        sample = sink.emit('pull-sample')
        if self.args.frame and not self.saved and time.monotonic() - self.t0 > self.args.frame_after:
            s = sample.get_caps().get_structure(0)
            w, h = s.get_value('width'), s.get_value('height')
            buf = sample.get_buffer(); ok, info = buf.map(Gst.MapFlags.READ)
            png(self.args.frame, w, h, bytes(info.data[:w*h*3])); buf.unmap(info)
            self.saved = True
        return Gst.FlowReturn.OK

    def bus(self, _bus, msg):
        if msg.type == Gst.MessageType.ELEMENT and msg.get_structure().get_name() == 'level':
            rms = msg.get_structure().get_value('rms')
            if rms: self.levels.append(max(rms))
        elif msg.type == Gst.MessageType.ERROR:
            print('error', msg.parse_error()[0], file=sys.stderr)

    def run(self):
        bus = self.pipeline.get_bus(); bus.add_signal_watch(); bus.connect('message', self.bus)
        self.pipeline.set_state(Gst.State.PLAYING)
        threading.Thread(target=self.signal, daemon=True).start()
        if self.args.flash:
            self.flasher = subprocess.Popen([sys.executable, '-c', FLASHER], stdout=subprocess.PIPE, text=True)
            threading.Thread(target=self.read_flips, daemon=True).start()
        GLib.timeout_add(int(self.args.seconds * 1000), self.finish)
        self.loop.run()

    def read_flips(self):
        for line in self.flasher.stdout:
            color, stamp = line.split(); self.flips.append((color, float(stamp)))

    def signal(self):
        while True:
            state = call('GET', '/status')['state']
            if state in ('ready', 'live'): break
            time.sleep(.2)
        self.mark('status-ready')
        self.t_start = time.monotonic()
        offer = call('POST', '/rtc', {'op': 'start', 'cursorMode': 'metadata', 'cursorDelivery': 2, 'audio': self.args.audio,
                                      'width': 1920, 'codec': 'H264', 'codecs': ['H264']})
        self.mark('offer'); self.id = offer['id']
        self.cursor_mode = offer.get('cursorMode'); self.fallback = offer.get('cursorFallback')
        done = threading.Event()
        def gathered(peer, _):
            if peer.get_property('ice-gathering-state') == GstWebRTC.WebRTCICEGatheringState.COMPLETE: done.set()
        self.peer.connect('notify::ice-gathering-state', gathered)
        _, self.remote_sdp = GstSdp.SDPMessage.new_from_text(offer['sdp'])
        self.remote = GstWebRTC.WebRTCSessionDescription.new(GstWebRTC.WebRTCSDPType.OFFER, self.remote_sdp)
        promise = Gst.Promise.new(); self.peer.emit('set-remote-description', self.remote, promise); promise.wait()
        # A receive-only answer needs codec preferences: take them from the offer.
        for index in range(self.remote_sdp.medias_len()):
            media = self.remote_sdp.get_media(index)
            if media.get_media() not in ('video', 'audio'): continue
            caps = Gst.Caps.new_empty()
            for f in range(media.formats_len()):
                one = GstSdp.SDPMedia.get_caps_from_media(media, int(media.get_format(f)))
                one.get_structure(0).set_name('application/x-rtp'); one.get_structure(0).set_value('media', media.get_media())
                caps.append(one)
            transceiver = self.peer.emit('get-transceiver', index)
            transceiver.set_property('codec-preferences', caps)
            transceiver.set_property('direction', GstWebRTC.WebRTCRTPTransceiverDirection.RECVONLY)
        # The answer belongs to the promise's reply; keep that promise alive.
        self.answer_promise = Gst.Promise.new(); self.peer.emit('create-answer', None, self.answer_promise); self.answer_promise.wait()
        reply = self.answer_promise.get_reply()
        self.local = reply.get_value('answer')
        promise = Gst.Promise.new(); self.peer.emit('set-local-description', self.local, promise); promise.wait()
        done.wait(10)
        sdp = self.peer.get_property('local-description').sdp.as_text()
        call('POST', '/rtc', {'op': 'answer', 'id': self.id, 'sdp': sdp}); self.mark('answer-sent')
        seq = 0
        while True:
            time.sleep(1); seq += 1
            try:
                r = call('POST', '/rtc', {'op': 'feedback', 'id': self.id, 'client': 'probe', 'sequence': seq, 'loss': 0, 'delay': 0.01, 'rtt': 0.001})
                self.sender = {k: r.get(k) for k in ('sourceFps', 'inputFps', 'encodedFps', 'bitrateKbps', 'encodeP95Ms')}
                self.sender['cadence'] = r.get('cadence')
            except RuntimeError:
                break  # the session was stopped

    def finish(self):
        try: call('POST', '/rtc', {'op': 'stop', 'id': self.id})
        except Exception: pass
        if self.args.flash: self.flasher.terminate()
        f = self.frames
        steady = [t for t in f if t - f[0] >= 2] if f else []
        gaps = [round((b - a) * 1000) for a, b in zip(steady, steady[1:])]
        report = {
            'marksMs': self.marks,
            'cursorMode': getattr(self, 'cursor_mode', None), 'cursorFallback': getattr(self, 'fallback', None),
            'frames': len(f),
            'fps': round((len(steady) - 1) / (steady[-1] - steady[0]), 1) if len(steady) > 1 else None,
            'gapMaxMs': max(gaps) if gaps else None,
            'gapsOver50Ms': sum(g > 50 for g in gaps), 'gapsOver100Ms': sum(g > 100 for g in gaps),
            'audioDbMax': round(max(self.levels), 1) if self.levels else None, 'audioSamples': len(self.levels),
            'cursorMessages': self.cursor,
            'sender': getattr(self, 'sender', None),
        }
        if self.transitions:
            t = sorted(self.transitions)
            report['latencyMs'] = {'n': len(t), 'p50': round(t[len(t)//2]), 'p90': round(t[int(len(t)*.9)]), 'max': round(t[-1])}
            report['latencyByColor'] = self.by_color
        print(json.dumps(report))
        self.pipeline.set_state(Gst.State.NULL); self.loop.quit()
        return False


if __name__ == '__main__':
    Gst.init(None)
    p = argparse.ArgumentParser()
    p.add_argument('--seconds', type=float, default=12)
    p.add_argument('--flash', action='store_true')
    p.add_argument('--audio', action='store_true')
    p.add_argument('--frame')
    p.add_argument('--frame-after', type=float, default=4)
    Probe(p.parse_args()).run()
