"""Deterministic 1080p scene. Tick numbers are updates, not presented frames."""
WIDTH, HEIGHT = 1920, 1080
TEXT = 'PhonePad AaZz 0123456789 ¿? _ @ # [] {} áéíóú ñ € →'


def frame_state(tick, profile='motion'):
    if tick < 0 or profile not in ('motion', 'quality'):
        raise ValueError('Invalid scene state')
    cycle, position = divmod(tick, 720)
    paused = profile == 'quality' and position >= 480
    frame_id = tick if profile == 'motion' else cycle * 480 + min(position, 480)
    return {
        'frame_id': frame_id,
        'bar_x': frame_id * 9 % WIDTH,
        'phase': 'static' if paused else 'motion',
        'barcode': [1, 0, 1, 0] + [(frame_id >> i) & 1 for i in range(16)],
    }
