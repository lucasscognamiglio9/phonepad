"""Replay versioned feedback without importing GI, opening capture or connecting."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'tests/fixtures/rate_baseline.json'


def replay(controller, cases):
    results = []
    for case in cases:
        rate = controller(initial=case['initial_kbps'])
        samples, ends = [], []
        for stage in case['stages']:
            for _ in range(stage['count']):
                samples.append(rate.update(stage['loss'], stage['delay'], stage['rtt']))
            ends.append(samples[-1])
        results.append({'name': case['name'], 'targets_kbps': samples,
                        'stage_end_kbps': ends, 'min_kbps': min(samples),
                        'final_kbps': samples[-1]})
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--compare', type=Path)
    args = parser.parse_args()
    source = ROOT / 'setup/preview/rate_control.py'
    spec = importlib.util.spec_from_file_location('rate_control', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    fixtures = json.loads(FIXTURE.read_text())
    report = {
        'schema_version': 1, 'kind': 'synthetic-rate-policy',
        'scope': 'No network, renderer or device measurements. Samples are not wall-clock seconds.',
        'commit': subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip(),
        'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
        'fixture_sha256': hashlib.sha256(FIXTURE.read_bytes()).hexdigest(),
        'cases': replay(module.RateController, fixtures['cases']),
    }
    if args.compare:
        baseline = json.loads(args.compare.read_text())
        if baseline['kind'] != report['kind'] or baseline['fixture_sha256'] != report['fixture_sha256']:
            raise ValueError('A/B requires the same measurement kind and feedback fixture')
        old = {case['name']: case for case in baseline['cases']}
        if old.keys() != {case['name'] for case in report['cases']}:
            raise ValueError('A/B scenario sets differ')
        report['comparison'] = [
            {'name': case['name'],
             'final_delta_kbps': case['final_kbps'] - old[case['name']]['final_kbps'],
             'minimum_delta_kbps': case['min_kbps'] - old[case['name']]['min_kbps']}
            for case in report['cases']]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open('x') as output:
        json.dump(report, output, indent=2)
        output.write('\n')
    for case in report['cases']:
        print(f"{case['name']}: min={case['min_kbps']} final={case['final_kbps']} kbps")
    print(f'Evidence: {args.out}')


if __name__ == '__main__':
    main()
