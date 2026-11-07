"""Virtual PipeWire speaker for the phone and the default-device bookkeeping shared with sensors.py."""
import json
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path

import gi
gi.require_version('Gst', '1.0')
from gi.repository import Gst

SPEAKER = {'factory.name': 'support.null-audio-sink', 'media.class': 'Audio/Sink',
           'node.name': 'phonepad-iphone', 'node.description': 'iPhone',
           'audio.position': '[ FL FR ]', 'object.linger': True}
CAPTURE = {'node.name': 'phonepad-iphone-capture', 'stream.capture.sink': True, 'node.dont-reconnect': True}
STATE = Path(os.environ.get('XDG_STATE_HOME', Path.home() / '.local/state')) / 'phonepad/audio-defaults.json'
DEFAULTS = {'sink': '@DEFAULT_AUDIO_SINK@', 'source': '@DEFAULT_AUDIO_SOURCE@'}
ELEMENTS = ('pipewiresrc', 'opusenc', 'rtpopuspay')


def available():
    return all(Gst.ElementFactory.find(name) for name in ELEMENTS) and shutil.which('pw-cli') is not None


def node_properties(values):
    props = Gst.Structure.new_empty('props')
    for key, value in values.items():
        props.set_value(key, value)
    return props


def speaker_branch():
    return (f'pipewiresrc name=speaker target-object={SPEAKER["node.name"]} do-timestamp=true ! audioconvert ! audioresample '
            '! audio/x-raw,rate=48000,channels=2 '
            '! queue leaky=downstream max-size-buffers=0 max-size-bytes=0 max-size-time=40000000 '
            '! opusenc frame-size=10 bitrate=128000 audio-type=restricted-lowdelay '
            '! rtpopuspay pt=111 ! application/x-rtp,media=audio,encoding-name=OPUS,payload=111 ! peer. ')


def _run(*args):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=3)
    except (OSError, subprocess.TimeoutExpired):
        return subprocess.CompletedProcess(args, 1, '', '')


def default_id(kind):
    result = _run('wpctl', 'inspect', DEFAULTS[kind])
    first = result.stdout.split('\n', 1)[0] if result.returncode == 0 else ''
    value = first[3:].split(',', 1)[0].strip() if first.startswith('id ') else ''
    return int(value) if value.isdigit() else None


def node_ids(name):
    result = _run('pw-dump')
    try:
        items = json.loads(result.stdout or '[]') if result.returncode == 0 else []
    except ValueError:
        return []
    return [item['id'] for item in items if item.get('type') == 'PipeWire:Interface:Node'
            and item.get('info', {}).get('props', {}).get('node.name') == name]


def node_id(name):
    ids = node_ids(name)
    return ids[0] if ids else None


def _spa_value(value):
    if value is True or value is False:
        return str(value).lower()
    return value if value.startswith('[') else json.dumps(value, ensure_ascii=False)


def create_speaker():
    """The sink lives in PipeWire itself, so it runs and stays silent even when nothing plays."""
    destroy_speaker()
    props = ' '.join(f'{key}={_spa_value(value)}' for key, value in SPEAKER.items())
    if _run('pw-cli', 'create-node', 'adapter', '{ ' + props + ' }').returncode != 0:
        return None
    deadline = time.monotonic() + 2
    while (ours := node_id(SPEAKER['node.name'])) is None and time.monotonic() < deadline:
        time.sleep(0.05)
    return ours


def destroy_speaker():
    for node in node_ids(SPEAKER['node.name']):
        _run('pw-cli', 'destroy', str(node))


def _read_state():
    try:
        value = json.loads(STATE.read_text())
        return {kind: value[kind] for kind in DEFAULTS if type(value.get(kind)) is int}
    except (OSError, ValueError, AttributeError):
        return {}


def _write_state(value):
    STATE.parent.mkdir(parents=True, exist_ok=True)
    temporary = STATE.with_suffix('.tmp')
    temporary.write_text(json.dumps(value))
    temporary.replace(STATE)


_state_lock = threading.Lock()


def restore_defaults(kind):
    """Return the user's previous device, also after a crashed session."""
    with _state_lock:
        state = _read_state()
        if kind in state:
            _run('wpctl', 'set-default', str(state.pop(kind)))
        if state:
            _write_state(state)
        else:
            STATE.unlink(missing_ok=True)


def claim_default(kind, name):
    """Make our node the default, remembering the user's device once."""
    ours = node_id(name)
    if ours is None:
        return False
    with _state_lock:
        previous = _read_state()
        current = default_id(kind)
        if kind not in previous and current is not None and current != ours:
            _write_state({**previous, kind: current})
        return _run('wpctl', 'set-default', str(ours)).returncode == 0


def recover():
    restore_defaults('sink')
    destroy_speaker()


class Devices:
    """The phone is the default speaker while the user watches the screen session."""

    def __init__(self):
        self.cancelled = threading.Event()
        self.lock = threading.Lock()
        self.threads = []
        self.wanted = set()
        self.speaker = create_speaker()

    def claim(self, kind, name):
        with self.lock:
            self.wanted.add(kind)
        thread = threading.Thread(target=self._claim, args=(kind, name), daemon=True)
        self.threads = [item for item in self.threads if item.is_alive()] + [thread]
        thread.start()

    def release(self, kind):
        """Give the default back while the phone is not showing the screen."""
        with self.lock:
            self.wanted.discard(kind)
            restore_defaults(kind)

    def _claim(self, kind, name):
        deadline = time.monotonic() + 3
        ours = node_id(name)
        while ours is None and time.monotonic() < deadline and not self.cancelled.wait(0.1):
            ours = node_id(name)
        with self.lock:
            if ours is None or self.cancelled.is_set() or kind not in self.wanted:
                return
            claim_default(kind, name)

    def close(self):
        self.cancelled.set()
        for thread in self.threads:
            thread.join(timeout=4)
        with self.lock:
            recover()

