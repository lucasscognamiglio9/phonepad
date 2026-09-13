import unittest
from frame_metrics import summarize

class FrameMetricsTests(unittest.TestCase):
    def test_stalled_tail_lowers_average(self):
        result = summarize([i / 120 for i in range(4200)], 0, 60)
        self.assertEqual(result['fps'], 70)
        self.assertGreater(result['tailStallMs'], 25000)
        self.assertEqual(result['framesPerSecond'][-1], 0)

    def test_continuous_stream(self):
        self.assertEqual(summarize([i / 120 for i in range(7200)], 0, 60)['fps'], 120)

    def test_no_frames(self):
        self.assertEqual(summarize([], 0, 5)['maxGapMs'], 5000)

    def test_half_open_interval(self):
        self.assertEqual(summarize([-1, 0, .5, 1], 0, 1)['frames'], 2)

if __name__ == '__main__':
    unittest.main()
