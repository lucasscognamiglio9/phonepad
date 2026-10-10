"""Bounded real-cursor metadata, coalesced onto the video's WebRTC connection."""
import base64, hashlib, json, os, queue, re, struct, subprocess, threading, time, zlib
from pathlib import Path
from cursor_theme import CursorTheme

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
        self.theme = CursorTheme(); self.image_scale = (1,1); self.hotspot_offset = (0,0)
        self.jobs = queue.Queue(maxsize=1); self.stopping = threading.Event(); self.shape_generation = 0; self.applied_shape = 0
        lab = os.environ.get('PHONEPAD_HFR_ROOT', '')
        isolated = lab.startswith('/tmp/phonepad-hfr-') and lab in os.environ.get('DBUS_SESSION_BUS_ADDRESS', '')
        self.log = (Path(lab) / 'cursor-helper.log').open('w') if isolated else None
        self.process = subprocess.Popen([str(HELPER), str(node), modifier.group(0)], stdout=subprocess.PIPE, stderr=self.log or subprocess.DEVNULL)
        self.shape_thread = threading.Thread(target=self.shapes, daemon=True); self.shape_thread.start()
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
                    self.ready.set()
                    continue
                if value.get('unsupported'): raise ValueError('unsupported cursor bitmap')
                # Positions must never wait for theme lookup or PNG encoding.
                job = None
                with self.lock:
                    state = dict(self.latest)
                    if 'rgba' in value:
                        self.shape_generation += 1
                        job = (self.shape_generation, value)
                    for key in ('x','y','hx','hy','visible','capturedAtUs'):
                        if key not in value or (key in ('hx','hy') and self.shape_generation != self.applied_shape): continue
                        state[key] = value[key] * self.image_scale[0 if key == 'hx' else 1] + self.hotspot_offset[0 if key == 'hx' else 1] if key in ('hx','hy') else value[key]
                    if state != self.latest:
                        self.latest = state; self.version += 1
                if job:
                    try: self.jobs.put_nowait(job)
                    except queue.Full:
                        # Only the newest pending shape is useful. The in-flight
                        # job checks its generation before publishing.
                        try: self.jobs.get_nowait()
                        except queue.Empty: pass
                        self.jobs.put_nowait(job)
                if 'visible' in value: self.ready.set()
        except (OSError, ValueError, KeyError, TypeError): pass
        finally:
            self.failed = True; self.ready.set(); self.stopping.set()

    def shapes(self):
        try:
            while not self.stopping.is_set():
                try: generation, value = self.jobs.get(timeout=.1)
                except queue.Empty: continue
                pixels = bytes.fromhex(value['rgba'])
                width, height = value['w'], value['h']
                hx, hy = value.get('hx',0), value.get('hy',0)
                enhanced = self.theme.resolve(width, height, pixels)
                scale = (1,1); offset = (0,0)
                if enhanced:
                    original_width, original_height = width, height
                    width, height, new_hx, new_hy, pixels = enhanced
                    scale = (width/original_width, height/original_height)
                    offset = (new_hx-hx*scale[0],new_hy-hy*scale[1])
                    hx, hy = new_hx, new_hy
                png = png_rgba(width, height, pixels)
                image = 'data:image/png;base64,' + base64.b64encode(png).decode()
                if len(image) > 60000: raise ValueError('cursor image too large')
                with self.lock:
                    if generation != self.shape_generation or self.stopping.is_set(): continue
                    self.image_scale, self.hotspot_offset = scale, offset
                    self.applied_shape = generation
                    self.latest = {**self.latest, 'image':image, 'imageId':hashlib.sha256(png).hexdigest()[:16],
                                   'w':width, 'h':height, 'hx':hx, 'hy':hy}
                    self.version += 1
        except (ValueError, KeyError, TypeError):
            self.failed = True; self.stopping.set()

    def snapshot(self):
        with self.lock: return self.version, dict(self.latest)

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try: self.process.wait(timeout=2)
            except subprocess.TimeoutExpired: self.process.kill(); self.process.wait(timeout=2)
        self.stopping.set()
        self.thread.join(timeout=1); self.shape_thread.join(timeout=1)
        self.process.stdout.close()
        if self.log: self.log.close()

class CursorSender:
    def __init__(self, session, reader, glib):
        self.session, self.reader, self.glib = session, reader, glib
        self.sequence = 0; self.version = -1; self.image = None; self.full_at = 0; self.position_at = 0
        self.delivery = getattr(session, 'cursor_delivery', 1)
        self.counts = {'positions': 0, 'images': 0, 'positionBackpressure': 0, 'imageBackpressure': 0}
        self.source = glib.timeout_add(16, self.send)

    def send(self):
        session = self.session
        if session.closed: return False
        if self.reader.failed:
            self.source = None; session.error = 'cursor metadata lost'; session.close(); return False
        channel = session.cursor_channel
        if session.suspended or channel.get_property('ready-state') != session.cursor_open_state: return True
        # One pending message at most. Never queue a trail of obsolete positions.
        version, state = self.reader.snapshot(); now = time.monotonic()
        if self.delivery == 2:
            image_channel = session.cursor_image_channel
            if state.get('image') and state.get('imageId') != self.image:
                if image_channel.get_property('ready-state') == session.cursor_open_state and image_channel.get_property('buffered-amount') == 0:
                    shape = {k: state[k] for k in ('imageId', 'image', 'w', 'h', 'hx', 'hy')}
                    shape.update(t='cursor-image', version=2)
                    image_channel.emit('send-string', json.dumps(shape, separators=(',', ':'), allow_nan=False))
                    self.image = state['imageId']; self.counts['images'] += 1
                else: self.counts['imageBackpressure'] += 1
        if channel.get_property('buffered-amount') != 0:
            self.counts['positionBackpressure'] += 1; return True
        full = now - self.full_at >= 1 or state.get('imageId') != self.image
        if version == self.version and now - self.position_at < 1: return True
        self.sequence += 1
        state.update(t='cursor', version=self.delivery, sequence=self.sequence, sourceWidth=1920, sourceHeight=1080)
        if self.delivery == 2 or not full: state.pop('image', None)
        payload = json.dumps(state, separators=(',', ':'), allow_nan=False)
        channel.emit('send-string', payload)
        self.version = version
        self.counts['positions'] += 1
        self.position_at = now
        if self.delivery == 1 and full: self.full_at = now; self.image = state.get('imageId')
        return True

    def close(self):
        if self.source: self.glib.source_remove(self.source); self.source = None
        self.reader.close()
