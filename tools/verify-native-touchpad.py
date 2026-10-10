#!/usr/bin/env python3
"""Observe only the owned fixture device through the installed libinput ABI."""
import ctypes as C
import fcntl
import json
import os
from pathlib import Path
import select
import sys
import time

directory = Path(sys.argv[1]).resolve()
deadline = time.monotonic() + 45
while not (directory / 'device.json').exists():
    if time.monotonic() > deadline:
        raise RuntimeError('Fixture device missing')
    time.sleep(.05)
fixture = json.loads((directory / 'device.json').read_text())
device_path = fixture['device']
sysname = fixture['sysname']
if not sysname.startswith('input') or not device_path.startswith('/dev/input/event'):
    raise RuntimeError('Unexpected fixture identity')
sys_path = Path('/sys/devices/virtual/input') / sysname
if (sys_path / 'name').read_text().strip() != 'phonepad-touchpad':
    raise RuntimeError('Refusing to observe another device')
if not (sys_path / Path(device_path).name).exists():
    raise RuntimeError('Fixture node mismatch')

OPEN = C.CFUNCTYPE(C.c_int, C.c_char_p, C.c_int, C.c_void_p)
CLOSE = C.CFUNCTYPE(None, C.c_int, C.c_void_p)
grabbed = []
@OPEN
def open_restricted(path, flags, userdata):
    if os.fsdecode(path) != device_path:
        return -13
    try:
        fd = os.open(device_path, flags)
        # Exclusive access keeps fixture gestures out of the desktop session.
        fcntl.ioctl(fd, 0x40044590, 1)
        grabbed.append(fd)
        return fd
    except OSError as error:
        return -error.errno

@CLOSE
def close_restricted(fd, userdata):
    os.close(fd)

class Interface(C.Structure):
    _fields_ = [('open_restricted', OPEN), ('close_restricted', CLOSE)]
interface = Interface(open_restricted, close_restricted)
lib = C.CDLL('libinput.so.10')
def bind(name, result, *arguments):
    function = getattr(lib, name)
    function.restype, function.argtypes = result, list(arguments)
    return function
ptr = C.c_void_p
context = bind('libinput_path_create_context', ptr, C.POINTER(Interface), ptr)(C.byref(interface), None)
add = bind('libinput_path_add_device', ptr, ptr, C.c_char_p)
time.sleep(.25)  # Let udev classify the newly-created device before libinput opens it.
device = add(context, os.fsencode(device_path))
if not device or not grabbed:
    raise RuntimeError('Could not exclusively observe fixture')
tap = bind('libinput_device_config_tap_set_enabled', C.c_int, ptr, C.c_int)(device, 1)
drag = bind('libinput_device_config_tap_set_drag_enabled', C.c_int, ptr, C.c_int)(device, 1)
bind('libinput_device_config_tap_set_drag_lock_enabled', C.c_int, ptr, C.c_int)(device, 0)
natural = bind('libinput_device_config_scroll_set_natural_scroll_enabled', C.c_int, ptr, C.c_int)(device, 1)
if tap or drag or natural:
    raise RuntimeError(f'Touchpad configuration unsupported: {tap}, {drag}, {natural}')
get_fd = bind('libinput_get_fd', C.c_int, ptr)
dispatch = bind('libinput_dispatch', C.c_int, ptr)
get_event = bind('libinput_get_event', ptr, ptr)
event_type = bind('libinput_event_get_type', C.c_int, ptr)
event_destroy = bind('libinput_event_destroy', None, ptr)
pointer_event = bind('libinput_event_get_pointer_event', ptr, ptr)
button = bind('libinput_event_pointer_get_button', C.c_uint, ptr)
button_state = bind('libinput_event_pointer_get_button_state', C.c_int, ptr)
records = []
(directory / 'start').touch()
deadline = time.monotonic() + 30
while time.monotonic() < deadline:
    select.select([get_fd(context)], [], [], .02)
    dispatch(context)
    while event := get_event(context):
        kind = event_type(event)
        try:
            stage = (directory / 'stage').read_text()
        except FileNotFoundError:
            stage = 'setup'
        record = {'stage': stage, 'type': kind}
        if kind == 402:
            p = pointer_event(event)
            record.update(button=button(p), state=button_state(p))
        records.append(record)
        event_destroy(event)
    if (directory / 'done').exists():
        break
bind('libinput_path_remove_device', None, ptr)(device)
bind('libinput_unref', ptr, ptr)(context)

def events(stage, kind):
    return [event for event in records if event['stage'] == stage and event['type'] == kind]
def presses(stage, code):
    return [event for event in events(stage, 402) if event['button'] == code and event['state'] == 1]
checks = {
    'normalTapClicksOnce': len(presses('tap', 272)) == 1,
    'normalTwoFingerTapRightClicksOnce': len(presses('right_tap', 273)) == 1,
    'cancelOneHasNoClick': not events('cancel_one', 402),
    'cancelTwoHasNoClick': not events('cancel_two', 402),
    'nativeFingerScroll': bool(events('scroll', 405)),
    'nativePinch': bool(events('pinch', 804)),
    'nativeSwipe': bool(events('swipe', 801)),
}
for stage in ['double_tap_drag', 'cancel_drag']:
    buttons = events(stage, 402)
    checks[stage + 'MovesWithButtonAndReleases'] = bool(
        events(stage, 400) and presses(stage, 272) and buttons and buttons[-1]['state'] == 0)
report = {'checks': checks, 'passed': all(checks.values()),
          'device': fixture, 'exclusiveGrab': True, 'events': records}
(directory / 'libinput.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'checks': checks, 'passed': report['passed']}))
raise SystemExit(0 if report['passed'] else 1)
