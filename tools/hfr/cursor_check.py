"""Validate real WebRTC results and the matching worker lifecycle log offline.

Collect results with local_proxy_check.py + webrtc_lab.html. Supply a log scoped
to precisely that run. A stop RPC alone does not prove process cleanup.
This check never opens a capture or reads/saves video frames.
"""
import argparse
import json
import math
from pathlib import Path
import re


def validate(result, log):
    cycles = result.get('cycles', [result])
    if result.get('error') or not cycles:
        raise ValueError('Missing or failed receiver run')
    fps = []
    for cycle in cycles:
        if cycle.get('error') or not cycle.get('stopped'):
            raise ValueError('Receiver did not complete a cycle')
        if cycle.get('pausedFrames') is None or cycle['pausedFrames'] != cycle.get('afterPauseFrames'):
            raise ValueError('Receiver kept decoding during pause')
        if not cycle.get('receivedAfterResume'):
            raise ValueError('Receiver did not resume')
        if not cycle.get('samples'):
            raise ValueError('No receiver samples')
        for sample in cycle['samples']:
            value = sample.get('decodedFps', 0)
            if sample.get('error') or not math.isfinite(value) or value <= 0:
                raise ValueError('Missing decoded frames')
            cursor = sample.get('server', {}).get('cursor', {})
            if not cursor.get('active') or cursor.get('buffers', 0) <= 0 or cursor.get('maxFps') != 1:
                raise ValueError('Auxiliary cursor capture is not active or bounded')
            fps.append(value)
    exits = [int(code) for code in re.findall(r'rtc worker exit=(-?\d+)', log)]
    count = len(cycles)
    if exits != [0] * count:
        raise ValueError(f'Expected {count} clean worker exits, got {exits}')
    for marker in ('mirror restored automatically=True', 'cursor connection released'):
        if log.count(marker) != count:
            raise ValueError('Missing or mismatched cleanup evidence: ' + marker)
    return {'cycles': count, 'workerExitCodes': exits,
            'decodedFpsSampleRange': [round(min(fps), 2), round(max(fps), 2)],
            'nativeCursorVisualVerified': False, 'nativeFpsVerified': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('result', type=Path)
    parser.add_argument('lifecycle_log', type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(validate(json.loads(args.result.read_text()), args.lifecycle_log.read_text()), indent=2))
    except (ValueError, TypeError, KeyError) as error:
        raise SystemExit(str(error))
