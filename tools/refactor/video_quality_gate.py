"""Admission checks for the reproducible loss-free desktop scenario.

This catches controller collapse and receiver stalls. It does not certify
visual quality on an iPhone. PSNR is reported separately against source pixels;
the gate must not mistake a changed decoded picture for improved fidelity.
"""
import math

def desktop_quality_gate(result):
    samples = result.get('samples', [])
    failures = []
    if result.get('error') or not result.get('flowPassed'):
        failures.append('decoded_flow_missing')
    if not samples or samples[-1].get('elapsed', 0) < 55:
        failures.append('incomplete_desktop_scenario')
    # Known unlimited-capacity synthetic path, with <=25ms one-way jitter.
    # Losing >half the initial 6Mbit/s target here is a regression, not evidence
    # of a bandwidth-limited real-world network. Do not apply this floor to
    # the separate capacity/loss test or production congestion control.
    steady = [sample for sample in samples if sample.get('elapsed', 0) > 8]
    rates = [sample['sender']['bitrateKbps'] for sample in steady]
    if rates and min(rates) < 3000:
        failures.append('bitrate_collapsed_on_known_unconstrained_path')
    motion = [sample for sample in steady
              if 14 <= sample['elapsed'] <= 23 or 36 <= sample['elapsed'] <= 45
              or sample['elapsed'] >= 49]
    def motion_received(sample):
        fps = (sample.get('receiver') or {}).get('decodedFps')
        return type(fps) in (int, float) and math.isfinite(fps) and fps >= 20
    if not motion or not all(motion_received(sample) for sample in motion):
        failures.append('decoded_motion_stalled')
    residence = [(sample.get('receiver') or {}).get('jitterMs') for sample in motion]
    if any(value is not None and value > 150 for value in residence):
        failures.append('receiver_queue_exceeded_150ms_budget')
    return {'passed': not failures, 'failures': failures,
            'scope': 'known unconstrained synthetic desktop path; not physical iPhone quality',
            'minimumTargetKbps': min(rates) if rates else None}


def scene_cut_quality_gate(result):
    """Admission for the six synthetic tabs on the defined loss-free path."""
    cuts = result.get('cutMetrics', [])
    failures = []
    if result.get('error') or not result.get('flowPassed'):
        failures.append('decoded_flow_missing')
    if len(cuts) < 11 or set(cut.get('scene') for cut in cuts) != set(range(6)):
        failures.append('incomplete_scene_changes')
    quality = [(cut.get('quality') or {}).get('psnrDb') for cut in cuts]
    if not quality or any(type(value) not in (int, float) or not math.isfinite(value) or value < 34 for value in quality):
        failures.append('scene_change_detail_below_budget')
    gaps = [cut.get('gapMs') for cut in cuts[1:]]
    if not gaps or any(type(value) not in (int, float) or not math.isfinite(value) or value > 150 for value in gaps):
        failures.append('scene_change_presentation_stalled')
    return {'passed': not failures, 'failures': failures,
            'scope': 'synthetic 1080p VA to Chromium; defined clean/jitter path, not physical iPhone',
            'minimumCutPsnrDb': min(quality) if quality and all(type(v) in (int,float) for v in quality) else None,
            'maximumCutGapMs': max(gaps) if gaps and all(type(v) in (int,float) for v in gaps) else None}
