"""Declare the known real-time source before the encoder negotiates its mode."""
import ctypes
from pathlib import Path

LIBRARY = Path(__file__).with_name('libphonepad-live-capture.so')
_library = None

def configure_live_capture(capture):
    global _library
    if capture is None or capture.get_factory().get_name() != 'pipewiresrc':
        return None
    if not LIBRARY.is_file():
        # Source-only installs still work; staging a low-latency release must
        # include the helper and record it in the hash manifest.
        print('rtc live capture adapter unavailable', flush=True)
        return None
    if _library is None:
        _library = ctypes.CDLL(str(LIBRARY))
        _library.phonepad_mark_live_capture.argtypes = [ctypes.c_void_p]
        _library.phonepad_mark_live_capture.restype = ctypes.c_ulong
    capsule = ctypes.pythonapi.PyCapsule_GetPointer
    capsule.argtypes = [ctypes.py_object, ctypes.c_char_p]
    capsule.restype = ctypes.c_void_p
    probe = _library.phonepad_mark_live_capture(capsule(capture.__gpointer__, None))
    if not probe:
        raise RuntimeError('cannot establish live capture contract')
    print('rtc live capture contract active', flush=True)
    return capture.get_static_pad('src'), probe
