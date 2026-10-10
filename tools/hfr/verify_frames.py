"""Offline barcode verification: transport/encoder counters are insufficient."""
import json, pathlib, sys
import gi
gi.require_version('Gst', '1.0'); gi.require_version('GstVideo', '1.0')
from gi.repository import Gst, GstVideo
Gst.init(None)
root = pathlib.Path(sys.argv[1]).resolve()
if not str(root).startswith('/tmp/phonepad-hfr-'):
    raise SystemExit('Only lab recordings are accepted')
p = Gst.parse_launch(f'filesrc location={root}/motion.h264 ! h264parse ! openh264dec '
                     '! videoconvert ! video/x-raw,format=GRAY8 ! appsink name=out sync=false emit-signals=true max-buffers=2')
ids = []; invalid = [0]; decoded = [0]
def sample(sink):
    s = sink.emit('pull-sample')
    if not s: return Gst.FlowReturn.EOS
    info = GstVideo.VideoInfo.new_from_caps(s.get_caps())
    data = s.get_buffer().extract_dup(info.offset[0] + 24 * info.stride[0] + 24, 16 * 19 + 1)
    bits = [int(data[i * 16] > 128) for i in range(20)]
    decoded[0] += 1
    if bits[:4] == [1, 0, 1, 0]: ids.append(sum(bit << i for i, bit in enumerate(bits[4:])))
    else: invalid[0] += 1
    return Gst.FlowReturn.OK
p.get_by_name('out').connect('new-sample', sample)
p.set_state(Gst.State.PLAYING)
message = p.get_bus().timed_pop_filtered(180 * Gst.SECOND, Gst.MessageType.ERROR | Gst.MessageType.EOS)
p.set_state(Gst.State.NULL)
if not message or message.type == Gst.MessageType.ERROR:
    raise RuntimeError(str(message.parse_error()[0]) if message else 'Decode timeout')
result = json.loads((root / 'result.json').read_text())
transitions = sum(a != b for a, b in zip(ids, ids[1:]))
if not result.get('measurementIncludesStalls'):
    raise RuntimeError('Legacy burst FPS cannot establish sustained performance; re-record with wall-clock metrics')
result.update(decodedFrames=decoded[0], validBarcodeFrames=len(ids), invalidBarcodeFrames=invalid[0],
              uniqueFrameIds=len(set(ids)), repeatedFrames=len(ids) - 1 - transitions if ids else 0,
              distinctFramesVerified=bool(ids) and not invalid[0],
              distinctSceneFps=round(result['encodedFrames'] * transitions / max(1, decoded[0]) / result['measurementSeconds'], 2))
(root / 'result.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result, indent=2))
