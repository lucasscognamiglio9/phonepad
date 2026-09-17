"""P00 characterizes the existing faults. P01 must change their expectations."""
import ast
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
    def test_import_works_without_site_packages_or_gstreamer(self):
        subprocess.run([sys.executable, '-S', '-c',
                        'from rate_control import RateController; assert RateController().target == 6000'],
                       cwd=ROOT / 'setup/preview', check=True, capture_output=True)

    def test_audited_feedback_reproduces_all_stage_endpoints(self):
        cases = json.loads(FIXTURE.read_text())['cases']
        for case, result in zip(cases, replay(RateController, cases)):
            with self.subTest(case=case['name']):
                self.assertEqual(result['stage_end_kbps'], [s['expected_end_kbps'] for s in case['stages']])
                self.assertEqual(result['min_kbps'], case['expected_min_kbps'])

    def test_extraction_preserves_original_policy_over_varied_feedback(self):
        # Frozen audit commit, never HEAD: ensures extraction has no behavioral change.
        original = subprocess.check_output(
            ['git', '-C', str(ROOT), 'show', 'adab7c7:setup/preview/rtc.py'], text=True)
        tree = ast.parse(original)
        node = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'RateController')
        import math
        namespace = {'math': math}
        exec(compile(ast.Module(body=[node], type_ignores=[]), '<audited-policy>', 'exec'), namespace)
        rng = random.Random(17092026)
        for initial in (6000, 12000):
            old, new = namespace['RateController'](initial=initial), RateController(initial=initial)
            for _ in range(1000):
                feedback = (rng.choice([0, .01, .03, .1]), rng.choice([0, .005, .12]), rng.choice([.02, .2, .6]))
                self.assertEqual(new.update(*feedback), old.update(*feedback))

if __name__ == '__main__':
    unittest.main()
