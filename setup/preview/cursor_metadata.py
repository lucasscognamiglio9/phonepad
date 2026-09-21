"""Bounded real-cursor metadata, coalesced onto the video's WebRTC connection."""
import base64, hashlib, json, re, struct, subprocess, threading, time, zlib
from pathlib import Path

HELPER = Path(__file__).with_name('phonepad-cursor-metadata')

def png_rgba(width, height, pixels):
    if type(width) is not int or type(height) is not int or not 1 <= width <= 256 or not 1 <= height <= 256 or len(pixels) != width * height * 4:
        raise ValueError('invalid cursor bitmap')
    # Mutter sends premultiplied RGBA; PNG and the receivers expect straight alpha.
    pixels = bytearray(pixels)
    for i in range(0, len(pixels), 4):
        alpha = pixels[i + 3]
        if 0 < alpha < 255:
            for c in range(3): pixels[i+c] = min(255, (pixels[i+c]*255 + alpha//2)//alpha)
    def chunk(kind, body):
        return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body))
    rows = b''.join(b'\0' + pixels[y*width*4:(y+1)*width*4] for y in range(height))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')

class CursorMetadata:
    def __init__(self, node, source_caps):
        modifier = re.search(r'0x[0-9a-fA-F]+', source_caps)
        if not modifier or 'AR24:' not in source_caps:
            raise RuntimeError('cursor metadata requires the validated BGRA DMA source')
        self.lock = threading.Lock(); self.ready = threading.Event(); self.failed = False
        self.latest = {'visible': False}; self.version = 0
        self.process = subprocess.Popen([str(HELPER), str(node), modifier.group(0)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.thread = threading.Thread(target=self.read, daemon=True); self.thread.start()
        if not self.ready.wait(2) or self.failed:
            self.close(); raise RuntimeError('cursor metadata unavailable')

    def read(self):
        try:
            while True:
                line = self.process.stdout.readline(525000)
                if not line: break
                if not line.endswith(b'\n'): raise ValueError('cursor message too large')
                value = json.loads(line)
                if value.get('ready'):
                    continue
                if value.get('unsupported'): raise ValueError('unsupported cursor bitmap')
                with self.lock:
                    state = dict(self.latest)
                    if 'rgba' in value:
                        png = png_rgba(value['w'], value['h'], bytes.fromhex(value['rgba']))
                        image = 'data:image/png;base64,' + base64.b64encode(png).decode()
                        if len(image) > 60000: raise ValueError('cursor image too large')
                        state.update(image=image, imageId=hashlib.sha256(png).hexdigest()[:16], w=value['w'], h=value['h'])
                    for key in ('x','y','hx','hy','visible'):
                        if key in value: state[key] = value[key]
                    if state != self.latest:
                        self.latest = state; self.version += 1
                    if 'visible' in value: self.ready.set()
        except (OSError, ValueError, KeyError, TypeError): pass
        finally:
            self.failed = True; self.ready.set()

    def snapshot(self):
        with self.lock: return self.version, dict(self.latest)

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try: self.process.wait(timeout=2)
            except subprocess.TimeoutExpired: self.process.kill(); self.process.wait(timeout=2)
        self.thread.join(timeout=1)
        self.process.stdout.close()

class CursorSender:
    def __init__(self, session, reader, glib):
        self.session, self.reader, self.glib = session, reader, glib
        self.sequence = 0; self.version = -1; self.image = None; self.full_at = 0
        self.source = glib.timeout_add(33, self.send)

    def send(self):
        session = self.session
        if session.closed: return False
        if self.reader.failed:
            self.source = None; session.error = 'cursor metadata lost'; session.close(); return False
        channel = session.cursor_channel
        if session.suspended or channel.get_property('ready-state') != session.cursor_open_state: return True
        # One pending message at most. Never queue a trail of obsolete positions.
        if channel.get_property('buffered-amount') != 0: return True
        version, state = self.reader.snapshot(); now = time.monotonic()
        full = now - self.full_at >= 1 or state.get('imageId') != self.image
        if version == self.version and not full: return True
        self.sequence += 1
        state.update(t='cursor', version=1, sequence=self.sequence, sourceWidth=1920, sourceHeight=1080)
        if not full: state.pop('image', None)
        payload = json.dumps(state, separators=(',', ':'), allow_nan=False)
        channel.emit('send-string', payload)
        self.version = version
        if full: self.full_at = now; self.image = state.get('imageId')
        return True

    def close(self):
        if self.source: self.glib.source_remove(self.source); self.source = None
        self.reader.close()
