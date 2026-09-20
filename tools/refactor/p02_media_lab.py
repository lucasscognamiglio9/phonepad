"""Observe the production worker against an isolated GNOME/PipeWire source.

Run through tools/hfr/isolated.py with PHONEPAD_LAB_MEDIA=1. This measures
capture/encoder metadata and worker ownership, not receiver FPS or latency.
"""

import json
import os
import pathlib
import signal
import sys
import time


root = pathlib.Path(os.environ["PHONEPAD_HFR_ROOT"])
if not str(root).startswith("/tmp/phonepad-hfr-") or str(root) not in os.environ.get("DBUS_SESSION_BUS_ADDRESS", ""):
    raise RuntimeError("Refusing to access a non-lab compositor")
preview = pathlib.Path(__file__).resolve().parents[2] / "setup/preview"
sys.path.insert(0, str(preview))
from media_contract import validate_media
from process_backend import ProcessBackend


backend = ProcessBackend(command=[sys.executable, str(preview / "hfr_worker.py")])
result = {"scope": "isolated GNOME/PipeWire and production HFR worker; no receiver or personal desktop", "cycles": []}
try:
    assert backend.media_snapshot()["geometry"]["state"] == "unknown"
    for width in (1920, 1280):
        start = time.monotonic()
        offer = backend.handle({"op": "start", "width": width, "codec": "H264", "codecs": ["H264"]})
        worker = backend.process
        cycle = {"requestedWidth": width, "offerMs": round((time.monotonic() - start) * 1000, 2),
                 "offerMedia": validate_media(offer["media"]), "samples": []}
        result["cycles"].append(cycle)
        assert offer["media"]["source"]["kind"] == "hfr-worker"
        assert offer["media"]["video"]["selectedCodec"] == "H264"
        assert offer["media"]["video"]["codecs"] == ["H264"]
        for _ in range(20):
            reply = backend.handle({"op": "feedback", "id": offer["id"], "loss": 0, "delay": 0, "rtt": 0,
                                    "sourceId": offer["media"]["source"]["id"]})
            media = validate_media(reply["media"])
            cycle["samples"].append(media)
            if media["geometry"]["state"] == "available":
                break
            time.sleep(.2)
        else:
            raise AssertionError("No observed capture and encoder dimensions")
        assert media["geometry"]["width"] == 1920
        assert media["geometry"]["height"] == 1080
        assert media["geometry"]["encodedWidth"] == width
        assert media["geometry"]["encodedHeight"] == width * 9 // 16, "Encoded video did not preserve the source aspect ratio"
        cycle["observedMedia"] = media
        stop = time.monotonic()
        # Cleanup remains valid even if geometry changed after the last sample.
        if width == 1280:
            cycle["cleanup"] = "SIGTERM and backend shutdown"
            worker.send_signal(signal.SIGTERM)
            backend.shutdown(timeout=5)
        else:
            cycle["cleanup"] = "stop request"
            backend.handle({"op": "stop", "id": offer["id"]})
        cycle["stopMs"] = round((time.monotonic() - stop) * 1000, 2)
        cycle["workerExit"] = worker.poll()
        cycle["pipesClosed"] = worker.stdin.closed and worker.stdout.closed
        assert worker.poll() == 0 and cycle["pipesClosed"]
        assert backend.media_snapshot()["geometry"]["state"] == "unknown"
    assert result["cycles"][0]["observedMedia"]["source"]["id"] != result["cycles"][1]["observedMedia"]["source"]["id"]
    result["passed"] = True
except Exception as error:
    result.update(passed=False, error=str(error))
    raise
finally:
    backend.close()
    (root / "result.json").write_text(json.dumps(result, indent=2))
    (root / "motion.h264").touch()
    print(json.dumps(result), flush=True)
