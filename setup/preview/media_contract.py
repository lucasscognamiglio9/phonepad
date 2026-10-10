"""Small, validated metadata contract for the preview media provider.

The preview path must describe the capture and encoder that actually exist at
runtime.  This module deliberately contains no GStreamer or portal imports so
that its state machine and validation can be exercised with fixtures.
"""

import re
import secrets
import threading


MEDIA_VERSION = 1
MAX_SOURCE_ID_LENGTH = 128
MAX_REASON_LENGTH = 128
MAX_DIMENSION = 32768
MAX_EPOCH = (1 << 53) - 1

STATES = ("available", "unavailable", "unknown")
SOURCE_KINDS = ("portal", "hfr-worker")
CODECS = ("H264", "H265", "VP8", "VP9", "AV1")

_SOURCE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_REASON = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,127}$")
_MISSING = object()


class MediaContractError(ValueError):
    """Raised when a provider or worker sends malformed media metadata."""


def new_source_id():
    """Return an opaque, non-persistent identifier for one source generation."""

    return secrets.token_urlsafe(24)


def _reason(value):
    if not isinstance(value, str) or not _REASON.fullmatch(value):
        raise MediaContractError("invalid media reason")
    return value


def _source_id(value):
    if not isinstance(value, str) or len(value) > MAX_SOURCE_ID_LENGTH or not _SOURCE_ID.fullmatch(value):
        raise MediaContractError("invalid media source id")
    return value


def _dimension(value):
    # bool is an int subclass but is never a geometry measurement.
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_DIMENSION:
        raise MediaContractError("invalid media dimension")
    return value


def _epoch(value):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_EPOCH:
        raise MediaContractError("invalid media geometry epoch")
    return value


def fit_square_pixel_size(source, bounds):
    """Fit measured physical dimensions into even encoder bounds, no upscale."""

    width, height = map(_dimension, source)
    max_width, max_height = map(_dimension, bounds)
    if min(width, height, max_width, max_height) < 2:
        raise MediaContractError("source is too small for the encoder")
    scale = min(1, max_width / width, max_height / height)
    return max(2, int(width * scale) // 2 * 2), max(2, int(height * scale) // 2 * 2)


def _state(value):
    if value not in STATES:
        raise MediaContractError("invalid media state")
    return value


def _check_no_unknown(value, allowed):
    if any(key not in allowed for key in value):
        raise MediaContractError("unknown media field")


def _validate_source(value):
    if not isinstance(value, dict):
        raise MediaContractError("invalid media source")
    _check_no_unknown(value, {"state", "id", "kind", "reason"})
    state = _state(value.get("state"))
    result = {"state": state}
    if state == "available":
        if set(value) != {"state", "id", "kind"}:
            raise MediaContractError("available media source is incomplete")
        result["id"] = _source_id(value["id"])
        if value["kind"] not in SOURCE_KINDS:
            raise MediaContractError("invalid media source kind")
        result["kind"] = value["kind"]
    else:
        if set(value) != {"state", "reason"}:
            raise MediaContractError("unavailable media source is incomplete")
        result["reason"] = _reason(value["reason"])
    return result


def _validate_geometry(value):
    if not isinstance(value, dict):
        raise MediaContractError("invalid media geometry")
    allowed = {"state", "epoch", "width", "height", "encodedWidth", "encodedHeight", "reason"}
    _check_no_unknown(value, allowed)
    state = _state(value.get("state"))
    result = {"state": state}
    if state != "available":
        if set(value) != {"state", "reason"}:
            raise MediaContractError("unknown media geometry is incomplete")
        result["reason"] = _reason(value["reason"])
        return result

    if "reason" in value or "epoch" not in value:
        raise MediaContractError("available media geometry is incomplete")
    result["epoch"] = _epoch(value["epoch"])
    pairs = 0
    for width_key, height_key in (("width", "height"), ("encodedWidth", "encodedHeight")):
        present = width_key in value or height_key in value
        if present:
            if width_key not in value or height_key not in value:
                raise MediaContractError("media geometry dimensions are incomplete")
            result[width_key] = _dimension(value[width_key])
            result[height_key] = _dimension(value[height_key])
            pairs += 1
    if pairs != 2:
        raise MediaContractError("available media geometry is incomplete")
    return result


def _validate_video(value):
    if not isinstance(value, dict):
        raise MediaContractError("invalid media video")
    _check_no_unknown(value, {"state", "codecs", "selectedCodec", "reason"})
    state = _state(value.get("state"))
    result = {"state": state}
    if state != "available":
        if set(value) != {"state", "reason"}:
            raise MediaContractError("unknown media video is incomplete")
        result["reason"] = _reason(value["reason"])
        return result
    if "reason" in value or not isinstance(value.get("codecs"), list) or not value["codecs"]:
        raise MediaContractError("available media video is incomplete")
    codecs = []
    for codec in value["codecs"]:
        if codec not in CODECS or codec in codecs:
            raise MediaContractError("invalid media codec")
        codecs.append(codec)
    result["codecs"] = codecs
    if "selectedCodec" in value:
        if value["selectedCodec"] not in codecs:
            raise MediaContractError("selected media codec is not advertised")
        result["selectedCodec"] = value["selectedCodec"]
    return result


def validate_media(value):
    """Validate and return a canonical copy of one inner ``media`` object."""

    if not isinstance(value, dict):
        raise MediaContractError("invalid media metadata")
    _check_no_unknown(value, {"version", "source", "geometry", "video"})
    # ``bool`` compares equal to ``1`` in Python, but it is not a protocol
    # version.  Keep the wire contract exact before validating nested data.
    if type(value.get("version")) is not int or value["version"] != MEDIA_VERSION:
        raise MediaContractError("unsupported media metadata version")
    if set(value) != {"version", "source", "geometry", "video"}:
        raise MediaContractError("incomplete media metadata")
    result = {
        "version": MEDIA_VERSION,
        "source": _validate_source(value["source"]),
        "geometry": _validate_geometry(value["geometry"]),
        "video": _validate_video(value["video"]),
    }
    if result["geometry"]["state"] == "available" and result["source"]["state"] != "available":
        raise MediaContractError("available media geometry has no source")
    return result


def requested_codecs(data):
    """Normalize legacy ``codec`` and additive codec preference requests."""

    if not isinstance(data, dict):
        raise MediaContractError("invalid request")
    codec = data.get("codec", None)
    preferences = data.get("codecs", None)
    if preferences is not None:
        if not isinstance(preferences, list) or not preferences or len(preferences) > 8:
            raise MediaContractError("invalid codecs")
        if any(not isinstance(value, str) or value not in CODECS for value in preferences):
            raise MediaContractError("invalid codecs")
        if len(set(preferences)) != len(preferences):
            raise MediaContractError("invalid codecs")
        if codec is not None and (not isinstance(codec, str) or codec not in preferences):
            raise MediaContractError("codec preference conflict")
        return list(preferences)
    if codec is None:
        return ["H264"]
    if not isinstance(codec, str) or codec not in CODECS:
        raise MediaContractError("unsupported codec")
    return [codec]


def unknown_media(source_reason="source_not_observed", geometry_reason="geometry_not_observed",
                  video_reason="codec_not_probed"):
    """Return a valid metadata object with no unverified measurements."""

    return {
        "version": MEDIA_VERSION,
        "source": {"state": "unknown", "reason": _reason(source_reason)},
        "geometry": {"state": "unknown", "reason": _reason(geometry_reason)},
        "video": {"state": "unknown", "reason": _reason(video_reason)},
    }


def unavailable_media(source_reason="source_unavailable", geometry_reason="source_unavailable",
                      video_reason="codec_unavailable"):
    return {
        "version": MEDIA_VERSION,
        "source": {"state": "unavailable", "reason": _reason(source_reason)},
        "geometry": {"state": "unavailable", "reason": _reason(geometry_reason)},
        "video": {"state": "unavailable", "reason": _reason(video_reason)},
    }


def dimensions_from_caps(caps):
    """Extract fixed width/height from a current-caps fixture or GstCaps.

    Ranges, lists, logical portal properties and malformed values return None;
    only dimensions represented by actual current caps are accepted.
    """

    if caps is None:
        return None
    if isinstance(caps, dict):
        width, height = caps.get("width"), caps.get("height")
        try:
            return (_dimension(width), _dimension(height))
        except MediaContractError:
            return None
    try:
        size = caps.get_size()
    except (AttributeError, TypeError, ValueError):
        size = 0
    for index in range(size):
        try:
            structure = caps.get_structure(index)
            width = structure.get_value("width")
            height = structure.get_value("height")
            return (_dimension(width), _dimension(height))
        except (AttributeError, TypeError, ValueError, MediaContractError):
            continue
    # A fixture may provide a fixed caps string. Do not parse ranges: a range
    # is a negotiation limit, not evidence of the frame geometry.
    if isinstance(caps, str):
        match = re.search(r"(?:^|[, ])width=(\d+).*?(?:^|[, ])height=(\d+)(?:[, ]|$)", caps)
        if match:
            try:
                return (_dimension(int(match.group(1))), _dimension(int(match.group(2))))
            except MediaContractError:
                pass
    return None


def _pair(value):
    if value is None:
        return None
    if not isinstance(value, (tuple, list)) or len(value) != 2:
        raise MediaContractError("invalid media geometry pair")
    return (_dimension(value[0]), _dimension(value[1]))


class MediaTracker:
    """Thread-safe source, geometry and codec state for one provider process."""

    def __init__(self, kind="portal", source_state="unknown", source_reason="source_not_started"):
        if kind not in SOURCE_KINDS:
            raise ValueError("invalid media source kind")
        if source_state not in ("unknown", "unavailable"):
            raise ValueError("invalid initial source state")
        self.kind = kind
        self._lock = threading.RLock()
        self._source_state = source_state
        self._source_reason = _reason(source_reason)
        self._source_id = None
        self._capture = None
        self._encoded = None
        self._last_capture = None
        self._last_encoded = None
        self._epoch = None
        self._video_state = "unknown"
        self._video_reason = "codec_not_probed"
        self._codecs = []
        self._selected = None

    def begin_source(self, source_id=None):
        with self._lock:
            source_id = new_source_id() if source_id is None else _source_id(source_id)
            self._source_id = source_id
            self._source_state = "available"
            self._source_reason = None
            self._capture = self._encoded = None
            self._last_capture = self._last_encoded = None
            self._epoch = None
            self._selected = None
            return source_id

    def set_source_unavailable(self, reason="source_unavailable"):
        with self._lock:
            self._source_id = None
            self._source_state = "unavailable"
            self._source_reason = _reason(reason)
            self._capture = self._encoded = None
            self._epoch = None
            self._selected = None

    def set_source_unknown(self, reason="source_not_observed"):
        with self._lock:
            self._source_id = None
            self._source_state = "unknown"
            self._source_reason = _reason(reason)
            self._capture = self._encoded = None
            self._epoch = None
            self._selected = None

    def _update_geometry(self, capture=_MISSING, encoded=_MISSING):
        with self._lock:
            if self._source_state != "available":
                return
            old_last_capture = self._last_capture
            old_last_encoded = self._last_encoded
            new_capture = self._capture if capture is _MISSING else _pair(capture)
            new_encoded = self._encoded if encoded is _MISSING else _pair(encoded)
            if self._epoch is None and (new_capture is not None or new_encoded is not None):
                self._epoch = 1
            else:
                changed_capture = capture is not _MISSING and new_capture is not None and old_last_capture is not None and new_capture != old_last_capture
                changed_encoded = encoded is not _MISSING and new_encoded is not None and old_last_encoded is not None and new_encoded != old_last_encoded
                if changed_capture or changed_encoded:
                    if self._epoch >= MAX_EPOCH:
                        raise MediaContractError("media geometry epoch exhausted")
                    self._epoch += 1
            if capture is not _MISSING and new_capture is not None:
                self._last_capture = new_capture
            if encoded is not _MISSING and new_encoded is not None:
                self._last_encoded = new_encoded
            self._capture, self._encoded = new_capture, new_encoded

    def update_capture(self, value):
        self._update_geometry(capture=value)

    def update_encoded(self, value):
        self._update_geometry(encoded=value)

    def update_geometry(self, capture=_MISSING, encoded=_MISSING):
        self._update_geometry(capture=capture, encoded=encoded)

    def clear_encoded(self):
        """Forget measurements owned by a closed encoder, retaining capture."""

        with self._lock:
            self._encoded = None
            self._selected = None

    def set_codecs(self, codecs, selected=None):
        with self._lock:
            if not isinstance(codecs, (tuple, list)):
                raise MediaContractError("invalid media codecs")
            values = []
            for codec in codecs:
                if codec not in CODECS or codec in values:
                    raise MediaContractError("invalid media codec")
                values.append(codec)
            if not values:
                self._video_state = "unavailable"
                self._video_reason = "codec_unavailable"
                self._codecs = []
                self._selected = None
                return
            if selected is not None and selected not in values:
                raise MediaContractError("selected media codec is not advertised")
            self._video_state = "available"
            self._video_reason = None
            self._codecs = values
            self._selected = selected

    def set_video_unknown(self, reason="codec_not_probed"):
        with self._lock:
            self._video_state = "unknown"
            self._video_reason = _reason(reason)
            self._codecs = []
            self._selected = None

    def set_video_unavailable(self, reason="codec_unavailable"):
        with self._lock:
            self._video_state = "unavailable"
            self._video_reason = _reason(reason)
            self._codecs = []
            self._selected = None

    def select_codec(self, codec):
        with self._lock:
            if codec not in self._codecs:
                raise MediaContractError("selected media codec is not advertised")
            self._selected = codec

    def snapshot(self):
        with self._lock:
            if self._source_state == "available":
                source = {"state": "available", "id": self._source_id, "kind": self.kind}
            else:
                source = {"state": self._source_state, "reason": self._source_reason}
            if self._source_state == "unavailable":
                geometry = {"state": "unavailable", "reason": "source_unavailable"}
            elif self._epoch is None or self._capture is None or self._encoded is None:
                geometry = {"state": "unknown", "reason": "geometry_not_observed"}
            else:
                geometry = {"state": "available", "epoch": self._epoch}
                if self._capture is not None:
                    geometry.update(width=self._capture[0], height=self._capture[1])
                if self._encoded is not None:
                    geometry.update(encodedWidth=self._encoded[0], encodedHeight=self._encoded[1])
            if self._video_state == "available":
                video = {"state": "available", "codecs": list(self._codecs)}
                if self._selected is not None:
                    video["selectedCodec"] = self._selected
            else:
                video = {"state": self._video_state, "reason": self._video_reason}
            return validate_media({"version": MEDIA_VERSION, "source": source, "geometry": geometry, "video": video})
