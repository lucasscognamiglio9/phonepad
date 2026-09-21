"""Consume clipboard paste in a real GTK widget with no EditableText interface.

The fixture runs only under isolated.py's private D-Bus/display environment.
It deliberately waits before reading so the fallback cannot mistake a TARGETS
request or a short sleep for consumption. Some cases replace the clipboard
from a second GTK provider while the read is pending.
"""
import json
import os
from pathlib import Path
import subprocess

import gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gdk, GLib, Gtk


root = Path(os.environ['PHONEPAD_HFR_ROOT'])
if not str(root).startswith('/tmp/phonepad-hfr-'):
    raise RuntimeError('Refusing non-lab fixture root')

app = Gtk.Application(application_id='app.phonepad.FallbackLab')
case_index = 0
pending = False
external_processes = []


def clipboard_bytes(clipboard, result):
    try:
        stream, offered = clipboard.read_finish(result)
        chunks = []
        while True:
            block = stream.read_bytes(4096, None).get_data()
            if not block:
                break
            chunks.append(bytes(block))
        stream.close(None)
        return offered, b''.join(chunks).decode('utf-8')
    except Exception as error:
        return '', 'READ_ERROR:' + str(error)


def publish_external(text):
    # A second wl-copy process models a separate clipboard owner. It inherits
    # only the private Wayland environment from isolated.py.
    process = subprocess.Popen(['wl-copy', '--foreground'], stdin=subprocess.PIPE,
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    process.stdin.write(text.encode('utf-8'))
    process.stdin.close()
    external_processes.append(process)
    return False


def consume(request):
    global pending
    clipboard = Gdk.Display.get_default().get_clipboard()
    case = request['case']
    if case == 'external-same':
        GLib.timeout_add(300, publish_external, request['text'])
    elif case == 'external-different':
        GLib.timeout_add(300, publish_external, 'external-copy-¿_')

    def read_now():
        def received(clipboard, result):
            global pending, case_index
            offered, actual = clipboard_bytes(clipboard, result)
            expected = request['text']
            if case == 'external-different':
                expected = 'external-copy-¿_'
            report = {
                'case': case,
                'delayBeforeReadMs': 1250,
                'offered': offered,
                'actual': actual,
                'expected': expected,
                'exact': actual == expected,
                'editableText': False,
                'scope': 'private GTK drawing area on isolated Wayland/XWayland',
            }
            (root / f'fallback-result-{case_index}.json').write_text(
                json.dumps(report, ensure_ascii=False, indent=2))
            pending = False
            case_index += 1
            if case_index >= 3:
                GLib.timeout_add(200, app.quit)
                return
            GLib.timeout_add(50, poll_request)

        clipboard.read_async(
            ['text/plain;charset=utf-8', 'text/plain'],
            GLib.PRIORITY_DEFAULT, None, received)
        return False

    GLib.timeout_add(1250, read_now)
    return False


def poll_request():
    global pending
    if pending:
        return True
    path = root / f'fallback-request-{case_index}.json'
    if not path.exists():
        return True
    request = json.loads(path.read_text())
    pending = True
    GLib.timeout_add(0, consume, request)
    return False


def on_key(_controller, keyval, _keycode, state):
    if keyval == Gdk.KEY_v and state & Gdk.ModifierType.CONTROL_MASK:
        return True
    return False


def activate(application):
    window = Gtk.ApplicationWindow(application=application,
                                   title='PhonePad clipboard fallback fixture')
    # DrawingArea is intentionally focusable but has no EditableText state.
    area = Gtk.DrawingArea()
    area.set_focusable(True)
    controller = Gtk.EventControllerKey()
    controller.connect('key-pressed', on_key)
    area.add_controller(controller)
    window.set_child(area)
    window.set_default_size(800, 500)
    window.present()
    area.grab_focus()
    (root / 'fallback-ready').write_text(json.dumps({
        'widget': 'Gtk.DrawingArea', 'editableText': False,
        'scope': 'private GTK on isolated Wayland/XWayland'}))
    GLib.timeout_add(100, poll_request)


app.connect('activate', activate)
app.run([])
for process in external_processes:
    if process.poll() is None:
        process.kill()
    process.wait()
