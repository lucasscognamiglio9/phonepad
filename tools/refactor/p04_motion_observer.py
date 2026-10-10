#!/usr/bin/env python3
"""Observe one PhonePad motion fixture through the installed libinput ABI.

The Go fixture writes device.json only after creating its own uinput device.
This process opens exactly that event node, grabs it before writing start, and
never reads or drives a physical input device. It records libinput's
accelerated and unaccelerated motion values without changing any host profile.
"""
import ctypes as C
import fcntl
import json
import os
from pathlib import Path
import select
import sys
import time


OPEN = C.CFUNCTYPE(C.c_int, C.c_char_p, C.c_int, C.c_void_p)
CLOSE = C.CFUNCTYPE(None, C.c_int, C.c_void_p)
PTR = C.c_void_p
EVIOCGRAB = 0x40044590
POINTER_MOTION = 400


class Interface(C.Structure):
    _fields_ = [("open_restricted", OPEN), ("close_restricted", CLOSE)]


def bind(lib, name, result, *arguments):
    function = getattr(lib, name)
    function.restype = result
    function.argtypes = list(arguments)
    return function


def wait_for_fixture(directory):
    deadline = time.monotonic() + 60
    path = directory / "device.json"
    while not path.exists():
        if time.monotonic() > deadline:
            raise RuntimeError("fixture device missing")
        time.sleep(0.05)
    fixture = json.loads(path.read_text())
    device_path = fixture.get("device", "")
    sysname = fixture.get("sysname", "")
    if not sysname.startswith("input") or not device_path.startswith("/dev/input/event"):
        raise RuntimeError("unexpected fixture identity")
    sys_path = Path("/sys/devices/virtual/input") / sysname
    if (sys_path / "name").read_text().strip() != "phonepad-touchpad":
        raise RuntimeError("refusing to observe another device")
    if not (sys_path / Path(device_path).name).exists():
        raise RuntimeError("fixture node mismatch")
    return fixture, device_path


def observe(directory):
    fixture, device_path = wait_for_fixture(directory)
    grabbed = []

    @OPEN
    def open_restricted(path, flags, userdata):
        if os.fsdecode(path) != device_path:
            return -13
        fd = None
        try:
            fd = os.open(device_path, flags)
            # This is the admission boundary. The producer waits for start
            # before it emits the first frame.
            fcntl.ioctl(fd, EVIOCGRAB, 1)
            grabbed.append(fd)
            return fd
        except OSError as error:
            if fd is not None:
                os.close(fd)
            return -error.errno

    @CLOSE
    def close_restricted(fd, userdata):
        try:
            os.close(fd)
        except OSError:
            pass

    lib = C.CDLL("libinput.so.10")
    interface = Interface(open_restricted, close_restricted)
    context = None
    device = None
    try:
        path_context = bind(lib, "libinput_path_create_context", PTR, C.POINTER(Interface), PTR)
        path_add = bind(lib, "libinput_path_add_device", PTR, PTR, C.c_char_p)
        context = path_context(C.byref(interface), None)
        if not context:
            raise RuntimeError("libinput context creation failed")
        time.sleep(0.25)
        device = path_add(context, os.fsencode(device_path))
        if not device or not grabbed:
            raise RuntimeError("could not exclusively observe fixture")

        get_profile = bind(lib, "libinput_device_config_accel_get_profile", C.c_int, PTR)
        get_default_profile = bind(lib, "libinput_device_config_accel_get_default_profile", C.c_int, PTR)
        get_profiles = bind(lib, "libinput_device_config_accel_get_profiles", C.c_int, PTR)
        profile = get_profile(device)
        default_profile = get_default_profile(device)
        profiles = get_profiles(device)

        get_fd = bind(lib, "libinput_get_fd", C.c_int, PTR)
        dispatch = bind(lib, "libinput_dispatch", C.c_int, PTR)
        get_event = bind(lib, "libinput_get_event", PTR, PTR)
        event_type = bind(lib, "libinput_event_get_type", C.c_int, PTR)
        event_destroy = bind(lib, "libinput_event_destroy", None, PTR)
        pointer_event = bind(lib, "libinput_event_get_pointer_event", PTR, PTR)
        pointer_time = bind(lib, "libinput_event_pointer_get_time_usec", C.c_uint64, PTR)
        pointer_dx = bind(lib, "libinput_event_pointer_get_dx", C.c_double, PTR)
        pointer_dy = bind(lib, "libinput_event_pointer_get_dy", C.c_double, PTR)
        pointer_dx_unaccelerated = bind(lib, "libinput_event_pointer_get_dx_unaccelerated", C.c_double, PTR)
        pointer_dy_unaccelerated = bind(lib, "libinput_event_pointer_get_dy_unaccelerated", C.c_double, PTR)

        (directory / "start").touch()
        motions = []
        event_count = 0
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            select.select([get_fd(context)], [], [], 0.02)
            if dispatch(context) < 0:
                raise RuntimeError("libinput dispatch failed")
            while True:
                event = get_event(context)
                if not event:
                    break
                event_count += 1
                try:
                    if event_type(event) == POINTER_MOTION:
                        pointer = pointer_event(event)
                        try:
                            stage = (directory / "stage").read_text()
                        except FileNotFoundError:
                            stage = "setup"
                        motions.append({
                            "stage": stage,
                            "timeUsec": int(pointer_time(pointer)),
                            "dx": float(pointer_dx(pointer)),
                            "dy": float(pointer_dy(pointer)),
                            "dxUnaccelerated": float(pointer_dx_unaccelerated(pointer)),
                            "dyUnaccelerated": float(pointer_dy_unaccelerated(pointer)),
                        })
                finally:
                    event_destroy(event)
            if (directory / "done").exists():
                break
        else:
            raise RuntimeError("motion fixture timed out")

        report = {
            "fixture": fixture,
            "exclusiveGrab": bool(grabbed),
            "acceleration": {
                "profile": int(profile),
                "defaultProfile": int(default_profile),
                "availableProfiles": int(profiles),
                "profileChanged": False,
            },
            "eventCount": event_count,
            "motionEventCount": len(motions),
            "motions": motions,
        }
        (directory / "motion.json").write_text(json.dumps(report, indent=2) + "\n")
        return 0
    finally:
        if device and context:
            remove = bind(lib, "libinput_path_remove_device", None, PTR)
            remove(device)
        if context:
            unref = bind(lib, "libinput_unref", PTR, PTR)
            unref(context)


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: p04_motion_observer.py FIXTURE_DIR")
    directory = Path(sys.argv[1]).resolve()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        return observe(directory)
    except Exception as error:
        (directory / "observer-error.json").write_text(json.dumps({"error": str(error)}, indent=2) + "\n")
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
