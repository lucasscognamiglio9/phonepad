"""Wall-clock metrics: idle/stalled tails must remain in the denominator."""
import math

def summarize(values, start, end):
    duration = end - start
    if duration <= 0:
        raise ValueError('Measurement interval must be positive')
    frames = sorted(t for t in values if start <= t < end)
    buckets = [0] * math.ceil(duration)
    for t in frames:
        buckets[min(int(t - start), len(buckets) - 1)] += 1
    boundaries = [start, *frames, end]
    return {
        'frames': len(frames),
        'fps': round(len(frames) / duration, 2),
        'framesPerSecond': buckets,
        'startupMs': round(1000 * ((frames[0] if frames else end) - start), 2),
        'tailStallMs': round(1000 * (end - (frames[-1] if frames else start)), 2),
        'maxGapMs': round(1000 * max(b - a for a, b in zip(boundaries, boundaries[1:])), 2),
    }
