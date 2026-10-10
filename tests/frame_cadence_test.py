"""Exercise sparse capture and frame shedding through actual Gst buffers."""
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'setup/preview'))
import gi
gi.require_version('Gst', '1.0')
from gi.repository import Gst
from frame_cadence import FrameCadence


class CadenceTests(unittest.TestCase):
    def test_unknown_capture_rate_drops_excess_frames_without_creating_idle_frames(self):
        Gst.init(None)
        pipeline = Gst.parse_launch(
            'appsrc name=source is-live=true format=time '
            'caps="video/x-raw,format=NV12,width=64,height=64,framerate=0/1" '
            '! identity name=cadence '
            '! capssetter caps="video/x-raw,framerate=60/1" '
            '! appsink name=received sync=false')
        source, sink = pipeline.get_by_name('source'), pipeline.get_by_name('received')
        limiter = FrameCadence(60)
        pipeline.get_by_name('cadence').get_static_pad('src').add_probe(
            Gst.PadProbeType.BUFFER, lambda _pad, info: Gst.PadProbeReturn.OK
            if limiter.accept(info.get_buffer().pts) else Gst.PadProbeReturn.DROP)
        timestamps = [0, Gst.SECOND // 2] + [Gst.SECOND + i * Gst.SECOND // 120 for i in range(120)]
        pipeline.set_state(Gst.State.PLAYING)
        try:
            for timestamp in timestamps:
                buffer = Gst.Buffer.new_allocate(None, 64 * 64 * 3 // 2, None)
                buffer.pts = timestamp
                buffer.duration = Gst.CLOCK_TIME_NONE
                self.assertEqual(source.emit('push-buffer', buffer), Gst.FlowReturn.OK)
            source.emit('end-of-stream')
            received = []
            while (sample := sink.emit('try-pull-sample', Gst.SECOND)) is not None:
                received.append(sample.get_buffer().pts)
                self.assertEqual(tuple(sample.get_caps().get_structure(0).get_fraction('framerate')), (True, 60, 1))
            self.assertEqual(received[:2], timestamps[:2])
            self.assertTrue(58 <= len(received[2:]) <= 61, (len(received), received[:12]))
            self.assertTrue(set(received).issubset(timestamps))
            self.assertGreater(limiter.dropped, 50)
        finally:
            pipeline.set_state(Gst.State.NULL)

    def test_clock_restart_and_cadence_change_do_not_freeze_capture(self):
        limiter = FrameCadence(60)
        self.assertTrue(limiter.accept(1_000_000_000))
        self.assertFalse(limiter.accept(1_000_000_000))
        self.assertTrue(limiter.accept(0))
        limiter.fps = 15
        self.assertFalse(limiter.accept(16_666_667))
        self.assertTrue(limiter.accept(66_666_667))
        self.assertTrue(limiter.accept(70_000_000, discontinuity=True))

    def test_capture_jitter_preserves_cadence_without_idle_debt(self):
        limiter = FrameCadence(60)
        limiter.accept(0)
        limiter.accept(500_000_000)
        timestamps = [1_000_000_000 + i * 1_000_000_000 // 120
                      + (700_000 if i % 2 else -700_000) for i in range(120)]
        accepted = [pts for pts in timestamps if limiter.accept(pts)]
        self.assertTrue(58 <= len(accepted) <= 61, len(accepted))
