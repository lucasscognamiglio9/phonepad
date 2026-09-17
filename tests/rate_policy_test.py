"""Policy regressions use a deterministic seconds clock, never sleep."""
import json
import random
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'setup/preview'))
sys.path.insert(0, str(ROOT / 'tools/refactor'))
from rate_control import RateController
from rate_baseline import replay, FIXTURE


class PolicyTests(unittest.TestCase):
    def test_import_without_gstreamer(self):
        subprocess.run([sys.executable, '-S', '-c', 'from rate_control import RateController'],
                       cwd=ROOT / 'setup/preview', check=True)

    def test_audited_false_congestion_no_longer_collapses(self):
        results = {r['name']: r for r in replay(RateController, json.loads(FIXTURE.read_text())['cases'])}
        for name in ('stable_path_change_20_to_200_ms', 'receiver_buffer_120_ms_without_loss_or_rtt_growth', 'two_good_one_bad_repeated'):
            self.assertEqual(results[name]['final_kbps'], 12000)
            self.assertGreaterEqual(results[name]['min_kbps'], 6000)
        self.assertLess(results['thirteen_loss_samples_then_recovery']['min_kbps'], 12000)
        self.assertEqual(results['thirteen_loss_samples_then_recovery']['final_kbps'], 12000)

    def test_real_congestion_reduces_then_recovers(self):
        r = RateController(initial=12000)
        for t in range(12): r.update(.15, .2, .4, now=t)
        self.assertLess(r.target, 1000)
        for t in range(12, 44): r.update(0, .02, .04, now=t)
        self.assertEqual(r.target, 12000)

    def test_sustained_moderate_loss_and_joint_queue_growth_reduce(self):
        for samples in ([(.03, .02, .02)]*12, [(0, .02+t*.03, .02+t*.04) for t in range(12)]):
            r = RateController(initial=12000)
            for t, sample in enumerate(samples): r.update(*sample, now=t)
            self.assertLess(r.target, 8000)

    def test_unknown_and_repeated_feedback_cannot_raise_or_lower_rate(self):
        r = RateController()
        for t in range(20): r.update(None, None, None, now=t)
        self.assertEqual(r.target, 6000)
        r.update(.2, .2, .2, now=21, sequence=1)
        target = r.target
        for t in range(22, 40): r.update(.2, .2, .2, now=t, sequence=1)
        self.assertEqual(r.target, target)
        r.update(.2, .2, .2, now=20, sequence=2)
        self.assertEqual(r.target, target)

    def test_route_window_resume_and_gap_reset_old_evidence(self):
        r = RateController(initial=12000)
        r.update(0, .02, .02, now=0, route='a')
        r.update(0, .02, .2, now=1, route='b')
        self.assertEqual(r.base_rtt, .2)
        for t in range(2, 35): r.update(0, .02, .3, now=t, route='b')
        self.assertEqual(r.base_rtt, .3)
        r.reset()
        r.update(None, None, .6, now=100)
        self.assertEqual(r.base_rtt, .6)
        self.assertEqual(r.target, 12000)
        r.update(None, None, .8, now=110)
        self.assertEqual(r.base_rtt, .8)

    def test_feedback_frequency_does_not_multiply_cuts(self):
        r = RateController(initial=12000)
        for n in range(100): r.update(.2, .2, .2, now=n/100)
        self.assertEqual(r.target, 9000)

    def test_invalid_inputs_do_not_mutate_policy(self):
        r = RateController()
        for value in (float('nan'), float('inf'), -1, '0', True):
            with self.assertRaises(ValueError): r.update(value, 0, 0, now=0)
            self.assertEqual(r.target, 6000)
        with self.assertRaises(ValueError): r.update(0, 0, 0, route=12)

    def test_bounds_over_varied_feedback(self):
        rng = random.Random(17); r = RateController(maximum=3500)
        for t in range(2000):
            target = r.update(rng.choice([None, 0, .01, .03, .1]), rng.choice([None, .02, .12]), rng.choice([None, .02, .2]), now=t)
            self.assertTrue(350 <= target <= 3500)

    def test_legacy_rollback_reproduces_fixture(self):
        factory = lambda initial: RateController(initial=initial, policy='legacy')
        cases = json.loads(FIXTURE.read_text())['cases']
        for case, result in zip(cases, replay(factory, cases)):
            self.assertEqual(result['stage_end_kbps'], [s['expected_end_kbps'] for s in case['stages']])


if __name__ == '__main__': unittest.main()
