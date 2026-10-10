"""Bounded capture-to-send freshness instrumentation.

The collector deliberately does not import GStreamer.  The RTC pipeline feeds
it one clock domain and the buffer timestamp converted into that same domain.
That keeps age and latency arithmetic honest when a buffer has no PTS or when a
stage is observed without its capture predecessor.

Memory descriptors are evidence about allocator/type transitions only.  A
descriptor change does not claim an exact number of copies; exact copy counts
need allocator tracing or a receiver-side measurement.
"""

from collections import defaultdict, deque
import math


_STAGES = (
    "capture",
    "encoder_input",
    "converter_input",
    "converter_output",
    "encoded",
    "packetized",
)


def _finite_timestamp(value):
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < 0 or value >= (1 << 63):
        return None
    return value


def _memory_descriptor(value):
    """Return a JSON-safe, conservative memory descriptor for a buffer.

    GI versions expose different memory helpers.  We use only optional public
    methods and report ``unknown`` when a runtime cannot expose allocator type.
    """

    if value is None:
        return None
    try:
        count = int(value.n_memory())
    except (AttributeError, TypeError, ValueError):
        return {"memoryCount": None, "types": ["unknown"]}
    types = []
    sizes = []
    for index in range(max(0, count)):
        try:
            memory = value.peek_memory(index)
        except (AttributeError, IndexError, TypeError, ValueError):
            types.append("unknown")
            continue
        memory_type = "unknown"
        getter = getattr(memory, "get_memory_type", None)
        if callable(getter):
            try:
                memory_type = str(getter())
            except Exception:
                memory_type = "unknown"
        types.append(memory_type)
        get_sizes = getattr(memory, "get_sizes", None)
        if callable(get_sizes):
            try:
                sizes.append(int(get_sizes()[1]))
            except (IndexError, TypeError, ValueError):
                pass
    return {"memoryCount": count, "types": types, "sizes": sizes}


def memory_descriptor(value):
    """Public adapter used by the GI pipeline to collect safe descriptors."""

    return _memory_descriptor(value)


def _descriptor_key(descriptor):
    if descriptor is None:
        return None
    return (
        descriptor.get("memoryCount"),
        tuple(descriptor.get("types", [])),
        tuple(descriptor.get("sizes", [])),
    )


def _summary(values):
    if not values:
        return {"count": 0, "p50Ms": None, "p95Ms": None, "p99Ms": None, "maxMs": None}
    ordered = sorted(float(value) for value in values)

    def percentile(fraction):
        index = min(len(ordered) - 1, int(len(ordered) * fraction))
        return round(ordered[index], 3)

    return {
        "count": len(ordered),
        "p50Ms": percentile(0.50),
        "p95Ms": percentile(0.95),
        "p99Ms": percentile(0.99),
        "maxMs": round(ordered[-1], 3),
    }


def _depth_summary(values):
    """Summarize queue depth without labelling a depth as milliseconds."""

    if not values:
        return {"count": 0, "p50Depth": None, "p95Depth": None, "maxDepth": None}
    ordered = sorted(max(0, int(value)) for value in values)

    def percentile(fraction):
        index = min(len(ordered) - 1, int(len(ordered) * fraction))
        return ordered[index]

    return {
        "count": len(ordered),
        "p50Depth": percentile(0.50),
        "p95Depth": percentile(0.95),
        "maxDepth": ordered[-1],
    }


class FrameFreshness:
    """Correlate a bounded frame history across the local send pipeline."""

    def __init__(self, max_age_ms=0, clock_domain="gst-pipeline-clock", limit=120):
        try:
            age_ms = float(max_age_ms)
        except (TypeError, ValueError):
            age_ms = 0
        if not math.isfinite(age_ms) or age_ms < 0:
            age_ms = 0
        self.max_age_ms = round(age_ms, 3)
        self.max_age_ns = int(age_ms * 1_000_000) if age_ms > 0 else None
        self.clock_domain = str(clock_domain)
        self.limit = max(8, int(limit))
        self._next_id = 0
        self._by_pts = defaultdict(deque)
        self._without_pts = deque()
        self._recent = deque(maxlen=self.limit)
        self._samples = {stage: deque(maxlen=self.limit) for stage in _STAGES}
        self._durations = defaultdict(list)
        self._ages = defaultdict(list)
        self._memory_transitions = []
        self._queue_depths = []
        self._counters = defaultdict(int)
        self._correlated = defaultdict(int)
        self._last = None

    @property
    def drop_enabled(self):
        return self.max_age_ns is not None

    def _new_frame(self, pts_ns, observed_ns, descriptor, format_name, pts_mapping,
                   source_pts_ns):
        self._next_id += 1
        if len(self._recent) >= self.limit:
            oldest = self._recent[0]
            if self._is_pending(oldest):
                self._counters["evictedPending"] += 1
            self._finalize(oldest)
        frame = {
            "frameId": self._next_id,
            "ptsNs": _finite_timestamp(pts_ns),
            "sourcePtsNs": {},
            "stages": {},
            "formats": {},
            "descriptors": {},
            "dropped": False,
        }
        self._recent.append(frame)
        if frame["ptsNs"] is None:
            self._without_pts.append(frame)
        else:
            self._by_pts[frame["ptsNs"]].append(frame)
        self._record_stage(frame, "capture", observed_ns, descriptor, None, format_name,
                           pts_mapping, source_pts_ns)
        return frame

    def _match(self, pts_ns, stage):
        valid = _finite_timestamp(pts_ns)
        if valid is not None and self._by_pts.get(valid):
            candidates = [
                frame for frame in self._by_pts[valid]
                if stage not in frame["stages"] and not frame["dropped"]
            ]
            if len(candidates) == 1:
                return candidates[0]
            if len(candidates) > 1:
                self._counters["ambiguousCorrelation"] += 1
        self._counters["unmatchedStage"] += 1
        return None

    def _stage_age(self, pts_ns, observed_ns):
        pts = _finite_timestamp(pts_ns)
        observed = _finite_timestamp(observed_ns)
        if pts is None or observed is None or observed < pts:
            return None
        return round((observed - pts) / 1_000_000, 3)

    def _format_name(self, format_name):
        return format_name if isinstance(format_name, str) and format_name else "unknown"

    def _record_sample(self, stage, pts_ns, observed_ns, format_name, queue_depth,
                       frame_id=None, matched=False, correlation="unknown", age_ms=None,
                       pts_mapping="unknown", source_pts_ns=None):
        observed = _finite_timestamp(observed_ns)
        pts = _finite_timestamp(pts_ns)
        if queue_depth is not None:
            try:
                depth = max(0, int(queue_depth))
                self._queue_depths.append(depth)
                self._queue_depths = self._queue_depths[-self.limit :]
            except (TypeError, ValueError):
                self._counters["invalidQueueDepth"] += 1
        sample = {
            "frameId": frame_id,
            "ptsNs": pts,
            "sourcePtsNs": _finite_timestamp(source_pts_ns) if source_pts_ns is not None else pts,
            "observedNs": observed,
            "ageMs": age_ms if age_ms is not None else self._stage_age(pts, observed),
            "format": self._format_name(format_name),
            "ptsMapping": pts_mapping if isinstance(pts_mapping, str) else "unknown",
            "matched": bool(matched),
            "correlation": correlation if matched else "unknown",
        }
        self._samples[stage].append(sample)
        return sample

    def _record_unmatched(self, stage, pts_ns, observed_ns, format_name, queue_depth,
                          pts_mapping, source_pts_ns):
        observed = _finite_timestamp(observed_ns)
        if observed is None:
            self._counters["invalidStageTimestamp"] += 1
        sample = self._record_sample(
            stage, pts_ns, observed, format_name, queue_depth,
            pts_mapping=pts_mapping,
            source_pts_ns=source_pts_ns,
        )
        self._last = {
            "frameId": None,
            "stage": stage,
            "ptsNs": sample["ptsNs"],
            "observedNs": sample["observedNs"],
            "ageMs": sample["ageMs"],
            "queueDepth": queue_depth,
            "latencyMs": {},
            "matched": False,
            "correlation": "unknown",
            "ptsMapping": sample["ptsMapping"],
        }
        return self._last

    def _record_stage(self, frame, stage, observed_ns, descriptor, queue_depth,
                      format_name, pts_mapping, source_pts_ns):
        observed = _finite_timestamp(observed_ns)
        if observed is None:
            self._counters["invalidStageTimestamp"] += 1
        else:
            frame["stages"][stage] = observed
        frame["sourcePtsNs"][stage] = (
            _finite_timestamp(source_pts_ns)
            if source_pts_ns is not None else frame.get("ptsNs")
        )
        frame["formats"][stage] = self._format_name(format_name)
        if descriptor is not None:
            frame["descriptors"][stage] = descriptor
        age_ms = self._stage_age(frame.get("ptsNs"), observed)
        self._record_sample(
            stage, frame.get("ptsNs"), observed, format_name, queue_depth,
            frame_id=frame["frameId"], matched=True, correlation="exact_pts",
            age_ms=age_ms,
            pts_mapping=pts_mapping,
            source_pts_ns=source_pts_ns,
        )
        stage_latencies = {}
        for previous, suffix in (
            ("capture", "captureToEncoderInput"),
            ("encoder_input", "encoderInputToEncoded"),
            ("capture", "captureToPacketized"),
            ("converter_input", "conversion"),
        ):
            if suffix == "captureToEncoderInput" and stage != "encoder_input":
                continue
            if suffix == "encoderInputToEncoded" and stage != "encoded":
                continue
            if suffix == "captureToPacketized" and stage != "packetized":
                continue
            if suffix == "conversion" and stage != "converter_output":
                continue
            start = frame["stages"].get(previous)
            if start is not None and observed is not None and observed >= start:
                duration_ms = (observed - start) / 1_000_000
                self._durations[suffix].append(duration_ms)
                self._durations[suffix] = self._durations[suffix][-self.limit :]
                stage_latencies[suffix] = round(duration_ms, 3)
        if age_ms is not None:
            self._ages[stage].append(age_ms)
            self._ages[stage] = self._ages[stage][-self.limit :]
        self._last = {
            "frameId": frame["frameId"],
            "stage": stage,
            "ptsNs": frame.get("ptsNs"),
            "observedNs": observed,
            "ageMs": age_ms,
            "queueDepth": queue_depth,
            "latencyMs": stage_latencies,
            "matched": True,
            "correlation": "exact_pts",
            "ptsMapping": pts_mapping if isinstance(pts_mapping, str) else "unknown",
        }
        return self._last

    def record(self, stage, pts_ns, observed_ns, descriptor=None, queue_depth=None,
               format_name=None, pts_mapping="unknown", source_pts_ns=None):
        """Record one stage and return ``{"drop": bool, ...}`` for probes."""

        if stage not in _STAGES:
            raise ValueError("unknown frame stage")
        pts = _finite_timestamp(pts_ns)
        if stage == "capture":
            self._counters["capture"] += 1
            if pts is None:
                self._counters["missingTimestamp"] += 1
            self._correlated[stage] += 1
            self._new_frame(pts, observed_ns, descriptor, format_name, pts_mapping,
                            source_pts_ns)
            result = dict(self._last or {})
            result["drop"] = False
            return result

        self._counters[stage] += 1
        if pts is None:
            self._counters["missingTimestamp"] += 1
        frame = self._match(pts, stage)
        if frame is None:
            result = dict(self._record_unmatched(
                stage, pts, observed_ns, format_name, queue_depth, pts_mapping,
                source_pts_ns,
            ))
            result["drop"] = False
            return result
        self._correlated[stage] += 1
        if stage == "encoder_input" and self.max_age_ns is not None:
            frame_pts = frame.get("ptsNs")
            if frame_pts is not None and _finite_timestamp(observed_ns) is not None:
                age_ns = max(0, observed_ns - frame_pts)
                if age_ns > self.max_age_ns:
                    frame["dropped"] = True
                    self._counters["staleCandidate"] += 1
                    self._counters["droppedStale"] += 1
                    self._record_stage(frame, stage, observed_ns, descriptor, queue_depth,
                                       format_name, pts_mapping, source_pts_ns)
                    self._last["dropReason"] = "stale_before_encode"
                    self._finalize(frame)
                    return {**self._last, "drop": True, "matched": True}
        previous_descriptor = frame["descriptors"].get("capture")
        self._record_stage(frame, stage, observed_ns, descriptor, queue_depth,
                           format_name, pts_mapping, source_pts_ns)
        if previous_descriptor is not None and descriptor is not None and _descriptor_key(previous_descriptor) != _descriptor_key(descriptor):
            self._counters["memoryDescriptorChanges"] += 1
            if len(self._memory_transitions) < self.limit:
                self._memory_transitions.append({
                    "frameId": frame["frameId"],
                    "from": previous_descriptor,
                    "to": descriptor,
                    "at": stage,
                })
        if stage == "packetized":
            self._finalize(frame)
        return {**(self._last or {}), "drop": False, "matched": True}

    def _finalize(self, frame):
        pts = frame.get("ptsNs")
        if pts is not None and self._by_pts.get(pts):
            try:
                self._by_pts[pts].remove(frame)
            except ValueError:
                pass
            if not self._by_pts[pts]:
                del self._by_pts[pts]
        elif pts is None:
            try:
                self._without_pts.remove(frame)
            except ValueError:
                pass

    def _is_pending(self, frame):
        pts = frame.get("ptsNs")
        if pts is None:
            return frame in self._without_pts
        return frame in self._by_pts.get(pts, ())

    def snapshot(self, sample_limit=8):
        try:
            sample_limit = max(1, min(self.limit, int(sample_limit)))
        except (TypeError, ValueError):
            sample_limit = 8
        stage_counts = {stage: self._counters.get(stage, 0) for stage in _STAGES}
        correlated_counts = {stage: self._correlated.get(stage, 0) for stage in _STAGES}
        unmatched_counts = {
            stage: max(0, stage_counts[stage] - correlated_counts[stage])
            for stage in _STAGES
        }
        durations = {key: _summary(values) for key, values in self._durations.items()}
        ages = {key: _summary(values) for key, values in self._ages.items()}
        queue = _depth_summary(self._queue_depths)
        return {
            "clockDomain": self.clock_domain,
            "maxFrameAgeMs": self.max_age_ms,
            "dropPolicy": {
                "enabled": self.drop_enabled,
                "stage": "encoder_input",
                "reason": "stale_before_encode",
                "disabledByDefault": self.max_age_ns is None,
            },
            "stages": stage_counts,
            "observedStages": stage_counts,
            "correlatedStages": correlated_counts,
            "correlation": {
                "method": "exact_pts_only",
                "fifoFallback": False,
                "unmatchedByStage": unmatched_counts,
                "unknownWhenPtsMissingOrRewritten": True,
            },
            "samplesByStage": {
                stage: list(samples)[-sample_limit:]
                for stage, samples in self._samples.items()
            },
            "sampleLimit": sample_limit,
            "counters": {
                "missingTimestamp": self._counters.get("missingTimestamp", 0),
                "unmatchedStage": self._counters.get("unmatchedStage", 0),
                "ambiguousCorrelation": self._counters.get("ambiguousCorrelation", 0),
                "invalidStageTimestamp": self._counters.get("invalidStageTimestamp", 0),
                "invalidQueueDepth": self._counters.get("invalidQueueDepth", 0),
                "staleCandidate": self._counters.get("staleCandidate", 0),
                "droppedStale": self._counters.get("droppedStale", 0),
                "memoryDescriptorChanges": self._counters.get("memoryDescriptorChanges", 0),
                "evictedPending": self._counters.get("evictedPending", 0),
                "pendingFrames": sum(map(len, self._by_pts.values())) + len(self._without_pts),
            },
            "latencyMs": durations,
            "frameAgeMs": ages,
            "queueDepth": queue,
            "memory": {
                "copyCount": None,
                "copyObservability": "descriptor_only",
                "descriptorTransitions": self._memory_transitions[-self.limit :],
                "exactCopyMeasurementPending": True,
            },
            "last": self._last,
        }
