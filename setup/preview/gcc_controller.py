"""Optional GStreamer GCC/TWCC controller for the native WebRTC session.

The legacy receiver-feedback controller remains the default.  This module is
only constructed when ``PHONEPAD_RTC_CONTROLLER=gcc`` is explicitly set.
GCC reports bitrates in bits per second while the VA encoders use kilobits per
second; conversion and clamping live here so the session has one encoder
setter path.
"""

import math
import os
import re
import threading
from dataclasses import dataclass

import gi

gi.require_version("Gst", "1.0")
try:
    gi.require_version("GstRtp", "1.0")
    from gi.repository import GstRtp
except (ImportError, ValueError):  # Legacy mode must still import without RTP GI.
    GstRtp = None
from gi.repository import Gst


TWCC_URI = "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01"
CONTROLLER_ENV = "PHONEPAD_RTC_CONTROLLER"


class GCCControllerError(RuntimeError):
    """The explicitly requested GCC controller cannot be admitted safely."""


@dataclass(frozen=True)
class GCCBounds:
    min_kbps: int
    start_kbps: int
    max_kbps: int

    @property
    def min_bps(self):
        return self.min_kbps * 1000

    @property
    def start_bps(self):
        return self.start_kbps * 1000

    @property
    def max_bps(self):
        return self.max_kbps * 1000


def controller_name(value=None):
    """Resolve the explicit controller setting without silently falling back."""

    selected = os.environ.get(CONTROLLER_ENV, "") if value is None else value
    if not isinstance(selected, str):
        raise ValueError("invalid PHONEPAD_RTC_CONTROLLER")
    selected = selected.strip().lower()
    if selected in ("", "legacy"):
        return "legacy"
    if selected == "gcc":
        return "gcc"
    raise ValueError("invalid PHONEPAD_RTC_CONTROLLER")


def bounds_for_codec(codec):
    """Keep the existing encoder envelope while expressing GCC limits in bps."""

    if codec == "H264":
        return GCCBounds(min_kbps=350, start_kbps=6000, max_kbps=12000)
    if codec == "H265":
        return GCCBounds(min_kbps=350, start_kbps=4000, max_kbps=8000)
    raise ValueError("unsupported codec for GCC")


def bps_to_kbps(value, bounds):
    """Round a GCC bitrate to kbps and clamp it to the encoder envelope."""

    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("invalid GCC bitrate")
    if not math.isfinite(value) or value < 0:
        raise ValueError("invalid GCC bitrate")
    rounded = int((value + 500) // 1000)
    return max(bounds.min_kbps, min(bounds.max_kbps, rounded))


def _factory_find():
    return Gst.ElementFactory.find


def require_runtime(factory_find=None):
    """Fail explicitly when the requested private plugin is not available."""

    if GstRtp is None:
        raise GCCControllerError("GCC controller unavailable: GstRtp GI bindings")
    finder = factory_find or _factory_find()
    missing = [name for name in ("rtpgccbwe", "rtphdrexttwcc") if finder(name) is None]
    if missing:
        raise GCCControllerError("GCC controller unavailable: missing " + ", ".join(missing))


def add_twcc_extension(payloader, rtp_module=None):
    """Attach the negotiated TWCC extension before offer creation."""

    module = GstRtp if rtp_module is None else rtp_module
    if module is None:
        raise GCCControllerError("GCC controller unavailable: GstRtp GI bindings")
    if payloader is None or payloader.find_property("extensions") is None:
        raise GCCControllerError("GCC controller unavailable: payloader has no extensions")
    extension = module.RTPHeaderExtension.create_from_uri(TWCC_URI)
    if extension is None:
        raise GCCControllerError("GCC controller unavailable: cannot create TWCC extension")
    extension.set_id(3)
    try:
        payloader.emit("add-extension", extension)
    except Exception as error:
        raise GCCControllerError("GCC controller unavailable: cannot add TWCC extension") from error
    return extension


def _media_sections(sdp_text):
    sections = []
    current = None
    session_direction = "sendrecv"
    for raw_line in sdp_text.splitlines():
        line = raw_line.rstrip("\r")
        if line.startswith("m="):
            if current is not None:
                sections.append(current)
            fields = line[2:].split()
            if len(fields) < 4:
                raise GCCControllerError("GCC controller requires valid SDP media")
            try:
                port = int(fields[1])
            except ValueError as error:
                raise GCCControllerError("GCC controller requires valid SDP media") from error
            current = {
                "media": fields[0],
                "port": port,
                "payloads": set(fields[3:]),
                "lines": [],
                "session_direction": session_direction,
            }
        elif current is not None:
            current["lines"].append(line)
        elif line in ("a=sendrecv", "a=sendonly", "a=recvonly", "a=inactive"):
            session_direction = line[2:]
    if current is not None:
        sections.append(current)
    return sections


def _active_video_section(sdp_text, payload):
    if not isinstance(sdp_text, str):
        raise GCCControllerError("GCC controller requires valid SDP")
    payload_text = str(payload)
    for section in _media_sections(sdp_text):
        if section["media"] == "video" and section["port"] != 0 and payload_text in section["payloads"]:
            return section
    raise GCCControllerError("GCC controller requires an active video payload " + payload_text)


def require_twcc_sdp(sdp_text, description, expected_id=None, payload=96):
    """Validate TWCC on the active video m-line and return its extension ID."""

    section = _active_video_section(sdp_text, payload)
    media_direction = next((line[2:] for line in section["lines"]
                            if line in ("a=sendrecv", "a=sendonly", "a=recvonly", "a=inactive")),
                           section["session_direction"])
    if media_direction == "inactive":
        raise GCCControllerError("GCC controller requires an active video direction")
    if description == "offer" and media_direction == "recvonly":
        raise GCCControllerError("GCC controller offer cannot receive-only video")
    if description == "answer" and media_direction == "sendonly":
        raise GCCControllerError("GCC controller answer cannot send-only video")
    if not any(line.startswith("a=rtpmap:" + str(payload) + " ") for line in section["lines"]):
        raise GCCControllerError("GCC controller requires an rtpmap for payload " + str(payload))
    extension_pattern = re.compile(r"^a=extmap:(\d+)(?:/([a-z]+))?\s+(\S+)(?:\s+.*)?$")
    extensions = []
    extension_ids = []
    for line in section["lines"]:
        match = extension_pattern.match(line)
        if match:
            extension_ids.append(int(match.group(1)))
            if match.group(3) == TWCC_URI:
                extensions.append((int(match.group(1)), match.group(2)))
    if len(extensions) != 1:
        raise GCCControllerError("GCC controller requires one TWCC extmap in " + description)
    ext_id, direction = extensions[0]
    if not 1 <= ext_id <= 255:
        raise GCCControllerError("GCC controller requires a valid TWCC extmap ID")
    if expected_id is not None and ext_id != expected_id:
        raise GCCControllerError("GCC controller requires a consistent TWCC extmap ID")
    if extension_ids.count(ext_id) != 1:
        raise GCCControllerError("GCC controller requires a unique TWCC extmap ID")
    if direction not in (None, "sendonly", "recvonly", "sendrecv"):
        raise GCCControllerError("GCC controller requires an active TWCC direction")
    if description == "offer" and direction == "recvonly":
        raise GCCControllerError("GCC controller offer cannot receive-only TWCC")
    if description == "answer" and direction == "sendonly":
        raise GCCControllerError("GCC controller answer cannot send-only TWCC")
    feedback_pattern = re.compile(r"^a=rtcp-fb:(\d+|\*)\s+transport-cc(?:\s|$)")
    if not any(feedback_pattern.match(line) and match.group(1) in (str(payload), "*")
               for line in section["lines"] for match in [feedback_pattern.match(line)] if match):
        raise GCCControllerError("GCC controller requires transport-cc feedback for payload " + str(payload))
    return ext_id


class GCCController:
    """Own the optional AUX estimator and its one encoder update path."""

    name = "gcc"

    def __init__(self, peer, payloader, encoder, codec, factory_find=None):
        self.peer = peer
        self.payloader = payloader
        self.encoder = encoder
        self.codec = codec
        self.bounds = bounds_for_codec(codec)
        self._factory_find = factory_find or _factory_find()
        self._closed = False
        self._lock = threading.RLock()
        self._peer_handler = None
        self._estimator_handlers = []
        self._estimator_probes = []
        self.estimators = []
        self.twcc_extension = None
        self.twcc_id = 3
        self.aux_requests = 0
        self.receiver_report_count = 0
        self.twcc_event_count = 0
        self.estimated_notifications = 0
        self.setter_count = 0
        self.last_estimate_bps = self.bounds.start_bps
        self.last_applied_kbps = self.bounds.start_kbps
        require_runtime(self._factory_find)
        self.twcc_extension = add_twcc_extension(payloader)
        try:
            self._peer_handler = peer.connect("request-aux-sender", self._request_aux_sender)
        except Exception as error:
            self.close()
            raise GCCControllerError("GCC controller unavailable: AUX hook setup failed") from error

    @property
    def closed(self):
        with self._lock:
            return self._closed

    def _request_aux_sender(self, _webrtcbin, _transport):
        with self._lock:
            if self._closed:
                return None
            factory = self._factory_find("rtpgccbwe")
            if factory is None:
                raise GCCControllerError("GCC controller unavailable: rtpgccbwe disappeared")
            estimator = factory.create("phonepad-gcc")
            if estimator is None:
                raise GCCControllerError("GCC controller unavailable: cannot create rtpgccbwe")
            estimator.set_property("min-bitrate", self.bounds.min_bps)
            estimator.set_property("estimated-bitrate", self.bounds.start_bps)
            estimator.set_property("max-bitrate", self.bounds.max_bps)
            handler = estimator.connect("notify::estimated-bitrate", self._estimated_bitrate)
            src_pad = estimator.get_static_pad("src")
            if src_pad is None:
                try:
                    estimator.disconnect(handler)
                except Exception:
                    pass
                raise GCCControllerError("GCC controller unavailable: AUX src pad missing")
            probe = src_pad.add_probe(Gst.PadProbeType.EVENT_UPSTREAM, self._twcc_event)
            self._estimator_handlers.append((estimator, handler))
            self._estimator_probes.append((src_pad, probe))
            self.estimators.append(estimator)
            self.aux_requests += 1
            print("rtc gcc aux-sender requests=" + str(self.aux_requests), flush=True)
            return estimator

    def _twcc_event(self, _pad, info):
        event = info.get_event()
        structure = event.get_structure() if event is not None else None
        if structure is not None and structure.get_name() == "RTPTWCCPackets":
            with self._lock:
                if not self._closed:
                    self.twcc_event_count += 1
        return Gst.PadProbeReturn.OK

    def _estimated_bitrate(self, estimator, _pspec):
        with self._lock:
            if self._closed:
                return
            estimate = int(estimator.get_property("estimated-bitrate"))
            applied = bps_to_kbps(estimate, self.bounds)
            self.last_estimate_bps = estimate
            self.estimated_notifications += 1
            current = int(self.encoder.get_property("bitrate"))
            if current != applied:
                self.encoder.set_property("bitrate", applied)
                self.setter_count += 1
            self.last_applied_kbps = applied

    def receiver_report_received(self, data):
        """Record HTTP feedback for diagnostics without running a second policy."""

        with self._lock:
            if self._closed:
                return
        for key, limit in (("loss", 1), ("delay", 10), ("rtt", 30)):
            value = data.get(key)
            if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))
                                      or not math.isfinite(value) or not 0 <= value <= limit):
                raise ValueError("invalid feedback")
        route = data.get("route")
        sequence = data.get("sequence")
        if route is not None and (not isinstance(route, str) or len(route) > 256):
            raise ValueError("invalid route")
        if sequence is not None and (type(sequence) is not int or sequence < 0):
            raise ValueError("invalid sequence")
        with self._lock:
            if self._closed:
                return
            self.receiver_report_count += 1
            self.last_feedback = {
                key: data.get(key)
                for key in ("loss", "delay", "rtt", "route", "sequence")
                if key in data
            }

    def validate_offer(self, sdp_text):
        twcc_id = require_twcc_sdp(sdp_text, "offer", payload=96)
        with self._lock:
            if self._closed:
                raise GCCControllerError("GCC controller is closed")
            self.twcc_id = twcc_id

    def validate_answer(self, sdp_text):
        with self._lock:
            expected_id = self.twcc_id
            if self._closed:
                raise GCCControllerError("GCC controller is closed")
        require_twcc_sdp(sdp_text, "answer", expected_id=expected_id, payload=96)

    def snapshot(self):
        with self._lock:
            return {
                "controller": self.name,
                "receiverReportCount": self.receiver_report_count,
                "auxRequests": self.aux_requests,
                "twccEventCount": self.twcc_event_count,
                "estimatedBitrateBps": self.last_estimate_bps,
                "appliedKbps": self.last_applied_kbps,
                "estimatedBitrateNotifications": self.estimated_notifications,
                "encoderSetterCount": self.setter_count,
            }

    def close(self):
        with self._lock:
            if self._closed:
                return
            self._closed = True
            if self._peer_handler is not None:
                try:
                    self.peer.disconnect(self._peer_handler)
                except Exception:
                    pass
                self._peer_handler = None
            for pad, probe in self._estimator_probes:
                try:
                    pad.remove_probe(probe)
                except Exception:
                    pass
            self._estimator_probes.clear()
            for estimator, handler in self._estimator_handlers:
                try:
                    estimator.disconnect(handler)
                except Exception:
                    pass
            self._estimator_handlers.clear()
            self.peer = None
            self.payloader = None
            self.encoder = None
