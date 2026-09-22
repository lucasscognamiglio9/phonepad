"""Use a larger frame of the exact host cursor, never a guessed replacement."""
import hashlib, struct, subprocess
from pathlib import Path

IMAGE = 0xfffd0002

def frames(data):
    if len(data) < 16 or len(data) > 4_000_000: return []
    magic, header, version, count = struct.unpack_from('<4I', data)
    if magic != 0x72756358 or count > 1024 or header < 16 or header+count*12 > len(data): return []
    result = []
    for i in range(count):
        kind, nominal, offset = struct.unpack_from('<3I', data, header+i*12)
        if kind != IMAGE or offset+36 > len(data): continue
        size, actual, subtype, _, width, height, hx, hy, delay = struct.unpack_from('<9I', data, offset)
        if actual != IMAGE or subtype != nominal or size < 36 or not 0 < width <= 256 or not 0 < height <= 256 or hx >= width or hy >= height: continue
        end = offset+size+width*height*4
        if end > len(data): continue
        bgra = data[offset+size:end]
        rgba = bytearray(len(bgra))
        rgba[0::4],rgba[1::4],rgba[2::4],rgba[3::4] = bgra[2::4],bgra[1::4],bgra[0::4],bgra[3::4]
        result.append((nominal,width,height,hx,hy,bytes(rgba)))
    return result

def key(width,height,pixels):
    return width,height,hashlib.sha256(pixels).digest()

class CursorTheme:
    def __init__(self, directories=None):
        self.images = {}; self.sources = []; self.scaled = {}; self.resolved = {}
        if directories is None:
            try:
                theme = subprocess.check_output(['gsettings','get','org.gnome.desktop.interface','cursor-theme'], text=True, timeout=1).strip().strip("'")
                if not theme or '/' in theme: return
                directories = [Path.home()/'.icons'/theme/'cursors',Path.home()/'.local/share/icons'/theme/'cursors',Path('/usr/share/icons')/theme/'cursors']
            except (OSError,subprocess.SubprocessError): return
        visited=set()
        for directory in directories:
            if not directory.is_dir(): continue
            for path in sorted(directory.iterdir())[:1024]:
                try:
                    real=path.resolve()
                    if real in visited: continue
                    visited.add(real)
                    if real.stat().st_size>4_000_000: continue
                    images=frames(real.read_bytes())
                except (OSError,ValueError,struct.error): continue
                groups={}
                for frame in images: groups.setdefault(frame[0],[]).append(frame)
                if not groups: continue
                target=min(groups,key=lambda size:abs(size-96))
                for size, low in groups.items():
                    if size>=target or len(low)!=len(groups[target]): continue
                    for a,b in zip(low,groups[target]):
                        fingerprint=key(a[1],a[2],a[5])
                        if fingerprint not in self.images: self.sources.append((a[1:],b[1:]))
                        self.images.setdefault(fingerprint,b[1:])
    def resolve(self,width,height,pixels):
        fingerprint=key(width,height,pixels)
        if fingerprint in self.images: return self.images[fingerprint]
        if fingerprint in self.resolved: return self.resolved[fingerprint]
        # Mutter renders fractional-scale cursor metadata using GPU bilinear
        # sampling. Compare every channel with a small rounding tolerance;
        # custom cursors that do not match the theme retain their own pixels.
        dimensions=(width,height)
        if dimensions not in self.scaled:
            try:
                import cairo
                candidates=[]
                for source,target in self.sources:
                    w,h,_,_,rgba=source
                    if abs(w/h-width/height)>.01: continue
                    bgra=bytearray(rgba);bgra[0::4],bgra[2::4]=rgba[2::4],rgba[0::4]
                    src=cairo.ImageSurface.create_for_data(bgra,cairo.FORMAT_ARGB32,w,h,w*4)
                    dst=cairo.ImageSurface(cairo.FORMAT_ARGB32,width,height)
                    ctx=cairo.Context(dst);ctx.scale(width/w,height/h);ctx.set_source_surface(src)
                    ctx.get_source().set_filter(cairo.FILTER_BILINEAR);ctx.paint()
                    data=bytes(dst.get_data());sample=bytearray(data);sample[0::4],sample[2::4]=data[2::4],data[0::4]
                    candidates.append((bytes(sample),target))
                if len(self.scaled)>=8: self.scaled.clear()
                self.scaled[dimensions]=candidates
            except ImportError: self.scaled[dimensions]=[]
        best=None;best_error=float('inf')
        for sample,target in self.scaled[dimensions]:
            error=0
            for a,b in zip(sample,pixels):
                delta=abs(a-b)
                if delta>4: break
                error+=delta
            else:
                if error<len(pixels)*.5 and error<best_error: best,best_error=target,error
        if len(self.resolved)>=256: self.resolved.clear()
        self.resolved[fingerprint]=best
        return best
