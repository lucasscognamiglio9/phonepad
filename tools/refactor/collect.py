"""Collect an existing isolated lab run and replay policy; does not open devices."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--network', type=Path, required=True)
    parser.add_argument('--capture', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--compare-policy', type=Path)
    args = parser.parse_args()
    evidence = {}
    for name in ('baseline', 'network', 'capture'):
        path = getattr(args, name).resolve()
        evidence[name] = {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                          'data': json.loads(path.read_text())}
    if not evidence['network']['data'].get('private_network_verified'):
        raise ValueError('Network isolation not verified')
    capture = evidence['capture']['data']
    if capture.get('error') or not capture.get('distinctFramesVerified'):
        raise ValueError('Capture must be decoded and verified before collection')
    args.out.mkdir(parents=True, exist_ok=False)
    command = [sys.executable, str(ROOT / 'tools/refactor/rate_baseline.py'),
               '--out', str(args.out / 'policy.json')]
    if args.compare_policy:
        command += ['--compare', str(args.compare_policy)]
    subprocess.run(command, check=True)
    report = {'schema_version': 1, 'kind': 'phonepad-p00-evidence', 'evidence': evidence,
              'policy': json.loads((args.out / 'policy.json').read_text()),
              'source_commit': subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip(),
              'source_dirty': bool(subprocess.check_output(['git', '-C', str(ROOT), 'status', '--porcelain'])),
              'scope': 'Independent host capture, network smoke and synthetic policy. Not an end-to-end benchmark.',
              'physical_receiver': {'status': 'pending', 'presented_fps': None, 'input_to_photon_ms': None},
              'comparison_rules': 'Policy requires identical fixture hash. Host A/B also requires identical scene, runtime, hardware, duration and profile; receiver metrics require a physical receiver.'}
    (args.out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(args.out / 'report.json')


if __name__ == '__main__':
    main()
