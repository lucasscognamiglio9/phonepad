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
        self.assertEqual(snapshot['observedStages']['encoder_input'], 1)
        self.assertEqual(snapshot['correlatedStages']['encoder_input'], 0)
        self.assertEqual(snapshot['correlation']['unmatchedByStage']['encoder_input'], 1)
        self.assertEqual(snapshot['samplesByStage']['encoder_input'][0]['format'], 'unknown')
        self.assertEqual(snapshot['last']['correlation'], 'unknown')

    def test_pts_rewrite_is_observed_but_not_correlated(self):
        collector = FrameFreshness(clock_domain='fixture-clock')
        collector.record('capture', 1_000_000_000, 1_000_100_000,
                         format_name='video/x-raw,format=BGRA',
                         pts_mapping='segment_to_running_time',
                         source_pts_ns=100_000_000)
        result = collector.record('converter_input', 1_000_100_000, 1_000_200_000,
                                  format_name='video/x-raw,format=NV12')
        self.assertFalse(result['matched'])
        snapshot = collector.snapshot()
        self.assertEqual(snapshot['observedStages']['converter_input'], 1)
        self.assertEqual(snapshot['correlatedStages']['converter_input'], 0)
        self.assertEqual(snapshot['correlation']['unmatchedByStage']['converter_input'], 1)
        self.assertEqual(snapshot['samplesByStage']['capture'][0]['ptsMapping'],
                         'segment_to_running_time')
        self.assertEqual(snapshot['samplesByStage']['capture'][0]['sourcePtsNs'],
                         100_000_000)
        sample = snapshot['samplesByStage']['converter_input'][0]
        self.assertIsNone(sample['frameId'])
        self.assertEqual(sample['format'], 'video/x-raw,format=NV12')
        self.assertEqual(sample['ptsMapping'], 'unknown')
        self.assertNotIn('latencyMs', sample)
        self.assertEqual(snapshot['last']['correlation'], 'unknown')

    def test_repeated_payload_pts_does_not_invent_fifo_correlation(self):
        collector = FrameFreshness(clock_domain='fixture-clock')
        collector.record('capture', 1_000_000_000, 1_000_100_000)
        collector.record('encoded', 1_000_000_000, 1_001_100_000)
        first = collector.record('packetized', 1_000_000_000, 1_001_200_000)
        second = collector.record('packetized', 1_000_000_000, 1_001_300_000)
        self.assertTrue(first['matched'])
        self.assertFalse(second['matched'])
        snapshot = collector.snapshot()
        self.assertEqual(snapshot['observedStages']['packetized'], 2)
        self.assertEqual(snapshot['correlatedStages']['packetized'], 1)
        self.assertEqual(snapshot['correlation']['unmatchedByStage']['packetized'], 1)
        self.assertEqual(snapshot['counters']['unmatchedStage'], 1)
        self.assertFalse(snapshot['samplesByStage']['packetized'][1]['matched'])
        self.assertEqual(snapshot['samplesByStage']['packetized'][1]['correlation'], 'unknown')

    def test_duplicate_capture_pts_is_ambiguous(self):
        collector = FrameFreshness(clock_domain='fixture-clock')
        collector.record('capture', 1_000_000_000, 1_000_100_000)
        collector.record('capture', 1_000_000_000, 1_000_200_000)
        result = collector.record('encoder_input', 1_000_000_000, 1_001_000_000)
        self.assertFalse(result['matched'])
        snapshot = collector.snapshot()
        self.assertEqual(snapshot['correlatedStages']['encoder_input'], 0)
        self.assertEqual(snapshot['counters']['ambiguousCorrelation'], 1)
        self.assertEqual(snapshot['correlation']['unmatchedByStage']['encoder_input'], 1)

    def test_invalid_stage_does_not_get_silently_accepted(self):
        collector = FrameFreshness()
        with self.assertRaises(ValueError):
            collector.record('network_arrival', 1, 2)


if __name__ == '__main__':
    unittest.main()
