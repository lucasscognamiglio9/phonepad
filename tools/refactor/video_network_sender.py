"""Synthetic moving source through the production hardware/WebRTC session.

This worker is laboratory-only. It does not capture any user screen or input.
"""
import json, os
from pathlib import Path
import sys, threading, time
from video_network_profile import verify_namespace
verify_namespace()
sys.path.insert(0,os.environ['PHONEPAD_LAB_PREVIEW_DIR'])
reply=sys.stdout
sys.stdout=sys.stderr
import rtc
from video_desktop_scene import desktop_scene, TEXT_REGION
from PIL import Image, ImageDraw
from media_contract import MediaTracker
rtc.Gst.init(None)
loop=rtc.GLib.MainLoop()
thread=threading.Thread(target=loop.run,daemon=True);thread.start()
media=MediaTracker('hfr-worker');media.begin_source()
fps=int(os.environ.get('PHONEPAD_LAB_NETWORK_FPS','30'))
desktop=os.environ.get('PHONEPAD_LAB_NETWORK_SCENARIO')=='desktop'
scene_cut=os.environ.get('PHONEPAD_LAB_NETWORK_SCENARIO')=='scene-cut'
if scene_cut: fps=60
if desktop: fps=int(os.environ.get('PHONEPAD_LAB_DESKTOP_FPS','120'))
if fps not in (2,30,60,120): raise ValueError('Unsupported test frame rate')
scene = desktop_scene(os.environ['PHONEPAD_HFR_ROOT'])
declared_fps = 0 if os.environ.get('PHONEPAD_LAB_UNKNOWN_FPS') == '1' else fps
source = ('appsrc name=capture is-live=true format=time block=false '
          'max-buffers=1 max-bytes=0 max-time=0 leaky-type=downstream '
          f'caps="video/x-raw,format=BGRA,width=1920,height=1080,framerate={declared_fps}/1"')
# Precompose the desktop once. Alpha blending a 1080p overlay on every
# generated frame made the fixture CPU-bound and invalidated motion gates.
background = Image.new('RGBA', (1920, 1080), (23, 24, 28, 255))
background.alpha_composite(Image.open(scene))
background.crop(TEXT_REGION).save(Path(os.environ['PHONEPAD_HFR_ROOT']) / 'source-text.png')
frames = []
for index in range(8):
    image = background.copy()
    ImageDraw.Draw(image).ellipse((100 + index * 210, 730, 240 + index * 210, 870), fill='white')
    frames.append(image.tobytes('raw', 'BGRA'))
cut_frames = []
if scene_cut:
    # Full desktop scene changes; reproducible source references, no user pixels.
    for scene_index in range(6):
        image = background.copy()
        draw = ImageDraw.Draw(image)
        fill = [(245,245,248),(20,24,30),(45,65,95),(95,40,50),(25,75,50),(210,210,215)][scene_index]
        draw.rectangle((0,0,1919,1079), fill=fill)
        from PIL import ImageFont
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',16)
        for y in range(52,660,24):
            for x in range(32,1900,600):
                draw.text((x,y), f'Tab {scene_index}: const value = 123; ñ € # @ _ []', font=font,
                          fill=(20,20,20) if scene_index in (0,5) else (235,235,240))
        for y in range(690,1080,64):
            for x in range(0,1920,64):
                draw.rectangle((x,y,x+62,y+62), fill=((x//64*19+scene_index*31)%240,(y//64*29+scene_index*41)%240,110))
        draw.rectangle((0,0,31,31),fill=(40+scene_index*30,20,20))
        image.crop(TEXT_REGION).save(Path(os.environ['PHONEPAD_HFR_ROOT']) / f'source-cut-{scene_index}.png')
        cut_frames.append(image.tobytes('raw','BGRA'))
estimator=os.environ.get('PHONEPAD_LAB_GCC_ESTIMATOR')
if estimator:
    if estimator not in ('kalman','linear-regression'): raise ValueError('Invalid lab estimator')
    from gcc_controller import GCCController
    original_aux=GCCController._request_aux_sender
    def lab_aux(self,*args):
        element=original_aux(self,*args)
        if element is not None: element.set_property('estimator',estimator)
        return element
    GCCController._request_aux_sender=lab_aux
manager=rtc.Manager(lambda:(source,1920,1080),media_tracker=media,
                    source_dimensions=lambda:(1920,1080),codec_probe=lambda:['H264'])
status=0
started=None
producer_stop = threading.Event()
producer = None
def produce():
    # The sender needs a raw frame before H264 caps and the offer can finish.
    # Start production while Manager.handle is waiting for that negotiation.
    while manager.session is None:
        if producer_stop.wait(.01): return
    session = manager.session
    source = session.pipeline.get_by_name('capture')
    index = 0
    deadline = time.monotonic()
    while not producer_stop.is_set():
        now = time.monotonic()
        elapsed = now - started if started is not None else 0
        moving = not desktop or 12 <= elapsed < 24 or elapsed >= 34
        interval = 1 / fps if moving else .5
        if producer_stop.wait(max(0, deadline - now)): break
        deadline = max(deadline + interval, time.monotonic())
        data = bytearray(cut_frames[int(elapsed // 2) % len(cut_frames)] if scene_cut else frames[index % len(frames)])
        stamp = (time.time_ns() // 1_000_000) & 0xffffffff
        clock_bits = stamp | ((stamp ^ 0xffffffff) << 32)
        row = b''.join((b'\xff\xff\xff\xff' if clock_bits & (1 << bit) else b'\x00\x00\x00\xff') * 4
                       for bit in range(64))
        for y in range(500, 512):
            start = (y * 1920 + 1600) * 4
            data[start:start + len(row)] = row
        buffer = rtc.Gst.Buffer.new_wrapped(bytes(data))
        buffer.pts = session.pipeline.get_clock().get_time() - session.pipeline.get_base_time()
        buffer.duration = rtc.Gst.CLOCK_TIME_NONE
        if source.emit('push-buffer', buffer) != rtc.Gst.FlowReturn.OK: break
        if moving: index += 1
try:
    for line in sys.stdin:
        data=json.loads(line)
        try:
            if data.get('op') == 'start':
                producer = threading.Thread(target=produce, daemon=True)
                producer.start()
            result=manager.handle(data)
            if data.get('op')=='answer': started=time.monotonic()
            output={'result':result}
        except Exception as error: output={'error':str(error),'invalid':isinstance(error,ValueError)}
        reply.write(json.dumps(output)+'\n');reply.flush()
        if data.get('op')=='stop': break
finally:
    producer_stop.set()
    if producer: producer.join(timeout=2)
    manager.shutdown(timeout=5)
    if not manager.closed: status=1
    loop.quit();thread.join(timeout=2)
    sys.stderr.flush()
    os._exit(status)
