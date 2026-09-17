import unittest
from scene_model import frame_state


class SceneTests(unittest.TestCase):
    def test_motion_barcode_round_trip(self):
        for tick in range(1, 21601):
            state = frame_state(tick)
            bits = state['barcode']
            self.assertEqual(bits[:4], [1, 0, 1, 0])
            self.assertEqual(sum(bit << i for i, bit in enumerate(bits[4:])), tick)

    def test_static_phase_does_not_manufacture_unique_frames(self):
        states = [frame_state(tick, 'quality') for tick in range(480, 720)]
        self.assertEqual({s['frame_id'] for s in states}, {480})
        self.assertEqual({s['bar_x'] for s in states}, {480 * 9 % 1920})
        self.assertEqual({s['phase'] for s in states}, {'static'})
        self.assertEqual(frame_state(721, 'quality')['frame_id'], 481)


if __name__ == '__main__':
    unittest.main()
