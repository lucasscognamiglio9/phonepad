"""GStreamer codec, encoder and ICE helpers shared by the WebRTC session."""
import os
import math
import gi
gi.require_version('Gst', '1.0')
from gi.repository import Gst


def disable_ice_upnp(peer):
    """Use GObject's public C property API without wrapping the floating ICE.

    webrtcbin owns an unsunk GstWebRTCNice reference. PyGObject get_property
    consumes that floating reference, causing a double unref during teardown.
    g_object_get returns explicit references; release each exactly once here.
    No pointers to screen data or credentials are accessed.
    """
    import ctypes
    capsule = ctypes.pythonapi.PyCapsule_GetPointer
    capsule.argtypes = [ctypes.py_object, ctypes.c_char_p]
    capsule.restype = ctypes.c_void_p
    library = ctypes.CDLL('libgobject-2.0.so.0')
    get = library.g_object_get
    get.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    get.restype = None
    set_property = library.g_object_set
    set_property.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    set_property.restype = None
    unref = library.g_object_unref
    unref.argtypes = [ctypes.c_void_p]
    unref.restype = None
    ice, nice = ctypes.c_void_p(), ctypes.c_void_p()
    try:
        get(capsule(peer.__gpointer__, None), b'ice-agent', ctypes.byref(ice), None)
        if not ice.value:
            raise RuntimeError('ICE unavailable')
        get(ice, b'agent', ctypes.byref(nice), None)
        if not nice.value:
            raise RuntimeError('private ICE unavailable')
        set_property(nice, b'upnp', ctypes.c_int(0), None)
        enabled = ctypes.c_int(1)
        get(nice, b'upnp', ctypes.byref(enabled), None)
        if enabled.value:
            raise RuntimeError('private ICE configuration failed')
    finally:
        if nice.value:
            unref(nice)
        if ice.value:
            unref(ice)



def modern_h264_encoder():
    # gstreamer1.0-vaapi is deprecated and absent from current Ubuntu; the VA
    # plugin is the default whenever it exists.
    return os.environ.get('PHONEPAD_ENCODER') != 'vaapi' and Gst.ElementFactory.find('vah264enc') is not None


def available_codecs():
    """Return codecs whose complete local GStreamer path is present.

    This is a factory/runtime probe only.  It does not claim that a receiver
    can decode a codec; the Manager still chooses from the request's list.
    """

    try:
        if Gst.ElementFactory.find('webrtcbin') is None:
            return []
        result = []
        modern = modern_h264_encoder()
        h264_encoder = 'vah264enc' if modern else 'vaapih264enc'
        h264_postproc = 'vapostproc' if modern else 'vaapipostproc'
        if all(Gst.ElementFactory.find(name) is not None for name in (h264_postproc, h264_encoder, 'h264parse', 'rtph264pay')):
            result.append('H264')
        if all(Gst.ElementFactory.find(name) is not None for name in ('vaapipostproc', 'vaapih265enc', 'h265parse', 'rtph265pay')):
            result.append('H265')
        return result
    except Exception:
        return []


def enable_video_recovery(peer):
    """Negotiate NACK/RTX before the video offer is created."""
    transceiver = peer.emit('get-transceiver', 0)
    if transceiver is None or transceiver.find_property('do-nack') is None:
        raise RuntimeError('WebRTC video recovery unavailable')
    transceiver.set_property('do-nack', True)
    return transceiver


def _caps_from_pipeline(pipeline, element_name, pad_name):
    if pipeline is None:
        return None
    try:
        element = pipeline.get_by_name(element_name)
        if element is None:
            return None
        pad = element.get_static_pad(pad_name)
        return pad.get_current_caps() if pad is not None else None
    except (AttributeError, TypeError, RuntimeError):
        return None


def _max_frame_age_ms():
    """Read an opt-in pre-encode freshness threshold.

    Zero keeps the existing pipeline behavior.  A future experiment can set a
    bounded threshold after observing the reported age distribution; no value
    is guessed into the default path.
    """

    raw = os.environ.get('PHONEPAD_MAX_FRAME_AGE_MS', '0')
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return 0
    return value if math.isfinite(value) and 0 < value <= 10_000 else 0


def _lab_h264_config(default_keyint):
    """Read H264 matrix knobs only inside the disposable lab."""

    if not os.environ.get('PHONEPAD_HFR_ROOT'):
        return None
    profiles = {
        'baseline': 'constrained-baseline',
        'constrained-baseline': 'constrained-baseline',
        'high': 'high',
    }
    raw_profile = os.environ.get('PHONEPAD_LAB_H264_PROFILE', 'constrained-baseline').strip().lower()
    if raw_profile not in profiles:
        raise ValueError('unsupported PHONEPAD_LAB_H264_PROFILE')
    try:
        bitrate_kbps = int(os.environ.get('PHONEPAD_LAB_H264_BITRATE_KBPS', '6000'))
    except (TypeError, ValueError):
        raise ValueError('invalid PHONEPAD_LAB_H264_BITRATE_KBPS')
    if bitrate_kbps not in (6000, 12000, 18000, 24000, 32000):
        raise ValueError('unsupported PHONEPAD_LAB_H264_BITRATE_KBPS')
    try:
        keyint = int(os.environ.get('PHONEPAD_LAB_H264_KEYINT', str(default_keyint)))
    except (TypeError, ValueError):
        raise ValueError('invalid PHONEPAD_LAB_H264_KEYINT')
    if not 1 <= keyint <= 600:
        raise ValueError('invalid PHONEPAD_LAB_H264_KEYINT')
    try:
        fps = int(float(os.environ.get('PHONEPAD_MIRROR_HZ', '120')))
    except (TypeError, ValueError):
        raise ValueError('invalid PHONEPAD_MIRROR_HZ')
    if fps not in (60, 90, 120):
        raise ValueError('unsupported PHONEPAD_MIRROR_HZ')
    return {
        'profile': profiles[raw_profile],
        'requestedProfile': raw_profile,
        'bitrateKbps': bitrate_kbps,
        'keyint': keyint,
        'fps': fps,
        'fixedBitrate': os.environ.get('PHONEPAD_LAB_FIXED_BITRATE', '0') == '1',
    }


def _lab_encoder_options():
    if not os.environ.get('PHONEPAD_HFR_ROOT'):
        return None
    fps = int(os.environ.get('PHONEPAD_LAB_ENCODE_FPS', '60'))
    usage = int(os.environ.get('PHONEPAD_LAB_TARGET_USAGE', '3'))
    mode = os.environ.get('PHONEPAD_LAB_RATE_CONTROL', 'vcm')
    cpb = int(os.environ.get('PHONEPAD_LAB_CPB_SIZE', '0'))
    percentage = int(os.environ.get('PHONEPAD_LAB_TARGET_PERCENTAGE', '100'))
    if fps not in (0, 30, 60, 120) or usage not in range(1, 8) or mode not in ('vbr', 'cbr', 'vcm') or cpb not in (0, 720, 6000) or percentage not in (66,100):
        raise ValueError('invalid laboratory encoder options')
    return {'fps': fps, 'targetUsage': usage, 'rateControl': mode, 'cpbSize': cpb, 'targetPercentage': percentage}


def desktop_quantizer_limit(bitrate_kbps):
    # At the normal desktop budget, do not let VA hide a scene change behind
    # coarse macroblocks and spend subsequent frames restoring the detail.
    # Congested paths retain the full rate-control range, so this quality
    # bound cannot force a 6 Mbit/s picture into a 2 Mbit/s connection.
    return 30 if bitrate_kbps >= 6000 else 51
