"""Virtual PipeWire speaker and microphone backed by the phone's WebRTC audio."""
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
MICROPHONE = {'media.class': 'Audio/Source', 'node.name': 'phonepad-mic',
              'node.description': 'Micrófono del iPhone', 'node.want-driver': True, 'node.always-process': True}
STATE = Path(os.environ.get('XDG_STATE_HOME', Path.home() / '.local/state')) / 'phonepad/audio-defaults.json'
DEFAULTS = {'sink': '@DEFAULT_AUDIO_SINK@', 'source': '@DEFAULT_AUDIO_SOURCE@'}
ELEMENTS = ('pipewiresrc', 'pipewiresink', 'opusenc', 'opusdec', 'rtpopuspay', 'rtpopusdepay')


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


def restore_defaults():
    """Return the user's previous devices, also after a crashed session."""
    for kind, previous in _read_state().items():
        _run('wpctl', 'set-default', str(previous))
    STATE.unlink(missing_ok=True)


def recover():
    restore_defaults()
    destroy_speaker()


class Devices:
    """The phone is the default speaker and microphone while it is connected."""

    def __init__(self):
        self.cancelled = threading.Event()
        self.lock = threading.Lock()
        self.threads = []
        self.speaker = create_speaker()

    def claim(self, kind, name):
        thread = threading.Thread(target=self._claim, args=(kind, name), daemon=True)
        self.threads.append(thread)
        thread.start()

    def _claim(self, kind, name):
        deadline = time.monotonic() + 3
        ours = node_id(name)
        while ours is None and time.monotonic() < deadline and not self.cancelled.wait(0.1):
            ours = node_id(name)
        with self.lock:
            if ours is None or self.cancelled.is_set():
                return
            previous = _read_state()
            current = default_id(kind)
            if kind not in previous and current is not None and current != ours:
                _write_state({**previous, kind: current})
            _run('wpctl', 'set-default', str(ours))

    def close(self):
        self.cancelled.set()
        for thread in self.threads:
            thread.join(timeout=4)
        with self.lock:
            recover()


class Microphone:
    """Decode the phone's Opus track into a virtual PipeWire source."""

    def __init__(self, pipeline, devices):
        self.pipeline = pipeline
        self.devices = devices
        self.linked = False

    def attach(self, pad):
        caps = pad.get_current_caps()
        if self.linked or caps is None or caps.get_structure(0).get_value('media') != 'audio':
            return False
        branch = Gst.parse_bin_from_description(
            'queue max-size-time=40000000 leaky=downstream ! rtpopusdepay ! opusdec plc=true '
            '! audioconvert ! audioresample ! audio/x-raw,rate=48000,channels=1 '
            '! pipewiresink name=microphone mode=provide sync=false', True)
        branch.get_by_name('microphone').set_property('stream-properties', node_properties(MICROPHONE))
        self.pipeline.add(branch)
        branch.sync_state_with_parent()
        pad.link(branch.get_static_pad('sink'))
        self.linked = True
        self.devices.claim('source', MICROPHONE['node.name'])
        return True
