import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'setup/preview'))
from frame_freshness import FrameFreshness


class FreshnessTests(unittest.TestCase):
    def record_frame(self, collector, pts=1_000_000_000):
        descriptor = {'memoryCount': 1, 'types': ['VAMemory'], 'sizes': [4096]}
        collector.record('capture', pts, pts + 100_000, descriptor, queue_depth=1)
        collector.record('converter_input', pts, pts + 200_000, descriptor, queue_depth=1)
        collector.record(
            'converter_output',
            pts,
            pts + 300_000,
            {'memoryCount': 1, 'types': ['VASurface'], 'sizes': [4096]},
            queue_depth=0,
        )
        collector.record('encoder_input', pts, pts + 400_000, {'memoryCount': 1, 'types': ['VASurface'], 'sizes': [4096]}, queue_depth=0)
        collector.record('encoded', pts, pts + 1_200_000, {'memoryCount': 1, 'types': ['SystemMemory'], 'sizes': [512]}, queue_depth=0)
        collector.record('packetized', pts, pts + 1_500_000, {'memoryCount': 1, 'types': ['SystemMemory'], 'sizes': [512]}, queue_depth=0)

    def test_stage_latency_age_and_memory_descriptor_are_same_clock(self):
        collector = FrameFreshness(clock_domain='fixture-clock')
        self.record_frame(collector)
        snapshot = collector.snapshot()
        self.assertEqual(snapshot['clockDomain'], 'fixture-clock')
        self.assertEqual(snapshot['latencyMs']['captureToEncoderInput']['p50Ms'], 0.3)
        self.assertEqual(snapshot['latencyMs']['conversion']['p50Ms'], 0.1)
        self.assertEqual(snapshot['latencyMs']['encoderInputToEncoded']['p50Ms'], 0.8)
        self.assertEqual(snapshot['latencyMs']['captureToPacketized']['p50Ms'], 1.4)
        self.assertEqual(snapshot['frameAgeMs']['packetized']['p50Ms'], 1.5)
        self.assertGreaterEqual(snapshot['counters']['memoryDescriptorChanges'], 1)
        self.assertIsNone(snapshot['memory']['copyCount'])
        self.assertTrue(snapshot['memory']['exactCopyMeasurementPending'])
        self.assertEqual(snapshot['queueDepth']['maxDepth'], 1)

    def test_stale_frame_is_dropped_at_encoder_input(self):
        collector = FrameFreshness(max_age_ms=1, clock_domain='fixture-clock')
        collector.record('capture', 1_000_000_000, 1_000_000_000)
        result = collector.record('encoder_input', 1_000_000_000, 1_002_000_000)
        self.assertTrue(result['drop'])
        snapshot = collector.snapshot()
        self.assertEqual(snapshot['counters']['staleCandidate'], 1)
        self.assertEqual(snapshot['counters']['droppedStale'], 1)
        self.assertEqual(snapshot['dropPolicy']['stage'], 'encoder_input')
        self.assertEqual(snapshot['counters']['pendingFrames'], 0)

    def test_missing_pts_is_observed_but_never_dropped(self):
        collector = FrameFreshness(max_age_ms=1, clock_domain='fixture-clock')
        collector.record('capture', None, 1_000_000_000)
        result = collector.record('encoder_input', None, 2_000_000_000)
        self.assertFalse(result['drop'])
        snapshot = collector.snapshot()
        self.assertEqual(snapshot['counters']['missingTimestamp'], 2)
        self.assertEqual(snapshot['counters']['droppedStale'], 0)

    def test_invalid_stage_does_not_get_silently_accepted(self):
        collector = FrameFreshness()
        with self.assertRaises(ValueError):
            collector.record('network_arrival', 1, 2)


if __name__ == '__main__':
    unittest.main()
