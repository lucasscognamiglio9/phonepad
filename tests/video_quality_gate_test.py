"""Verify admission rejects a decoded-but-unusable stream and idle is valid."""
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tests/support'))
from video_quality_gate import desktop_quality_gate, scene_cut_quality_gate

class DesktopAdmissionTests(unittest.TestCase):
    def result(self):
        return {'flowPassed': True, 'samples': [
            {'elapsed': second, 'sender': {'bitrateKbps': 6000},
             'receiver': {'decodedFps': 60 if 12 <= second <= 24 or second >= 34 else 2,
                          'jitterMs': 40}}
            for second in range(1, 61)]}

    def test_sparse_idle_desktop_does_not_fail_motion_check(self):
        self.assertTrue(desktop_quality_gate(self.result())['passed'])

    def test_connectivity_and_decoded_frames_do_not_hide_rate_collapse(self):
        result = self.result()
        for sample in result['samples'][12:]: sample['sender']['bitrateKbps'] = 350
        gate = desktop_quality_gate(result)
        self.assertFalse(gate['passed'])
        self.assertIn('bitrate_collapsed_on_known_unconstrained_path', gate['failures'])

    def test_motion_freeze_and_growing_queue_reject_candidate(self):
        result = self.result()
        result['samples'][20]['receiver'] = {'decodedFps': 0, 'jitterMs': 500}
        self.assertEqual(set(desktop_quality_gate(result)['failures']),
                         {'decoded_motion_stalled', 'receiver_queue_exceeded_150ms_budget'})

    def test_short_run_cannot_claim_recovery(self):
        result = self.result(); result['samples'] = result['samples'][:20]
        self.assertIn('incomplete_desktop_scenario', desktop_quality_gate(result)['failures'])

    def test_unknown_motion_is_not_a_success(self):
        result = self.result(); result['samples'][20]['receiver']['decodedFps'] = None
        self.assertIn('decoded_motion_stalled', desktop_quality_gate(result)['failures'])

    def test_scene_changes_require_first_frame_detail_not_only_connectivity(self):
        result = {'flowPassed':True, 'cutMetrics':[
            {'scene':index % 6, 'gapMs':35, 'quality':{'psnrDb':36}} for index in range(12)]}
        self.assertTrue(scene_cut_quality_gate(result)['passed'])
        result['cutMetrics'][5]['quality']['psnrDb'] = 31
        self.assertIn('scene_change_detail_below_budget',scene_cut_quality_gate(result)['failures'])
        result['cutMetrics'][5]['quality']['psnrDb'] = 36
        result['cutMetrics'][8]['gapMs'] = 300
        self.assertIn('scene_change_presentation_stalled',scene_cut_quality_gate(result)['failures'])

    def test_missing_scene_measurements_cannot_certify_quality(self):
        self.assertFalse(scene_cut_quality_gate({'flowPassed':True})['passed'])

if __name__ == '__main__': unittest.main()
