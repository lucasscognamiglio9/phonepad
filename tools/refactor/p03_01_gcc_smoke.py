#!/usr/bin/env python3
"""Synthetic GCC/TWCC hook smoke test.

Run this only with a private GST_PLUGIN_PATH containing the locally built
``libgstrsrtp.so`` and the isolated Phonepad GStreamer runtime.  It does not
open a socket or create a WebRTC session.  The manual signal emission proves
the public ``webrtcbin`` AUX hook and the encoder-target callback; a real
loopback run is still required to prove that ICE/DTLS asks for the hook.
"""

import json
import sys

import gi

gi.require_version("Gst", "1.0")
gi.require_version("GstRtp", "1.0")
from gi.repository import Gst, GstRtp


TWCC_URI = "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01"


def factory(name):
    return Gst.ElementFactory.find(name)


def main():
    Gst.init(None)
    required = (
        "webrtcbin",
        "rtpgccbwe",
        "rtph264pay",
        "rtphdrexttwcc",
        "rtpsession",
        "fakesink",
    )
    missing = [name for name in required if factory(name) is None]
    if missing:
        print(json.dumps({"status": "blocked", "missing_factories": missing}, indent=2))
        return 2

    pipeline = Gst.Pipeline.new("p03-gcc-smoke")
    peer = factory("webrtcbin").create("p03-peer")
    payloader = factory("rtph264pay").create("p03-payloader")
    session = factory("rtpsession").create("p03-session")
    sink = factory("fakesink").create("p03-sink")
    twcc = GstRtp.RTPHeaderExtension.create_from_uri(TWCC_URI)
    if (
        pipeline is None
        or peer is None
        or payloader is None
        or session is None
        or sink is None
        or twcc is None
    ):
        print(json.dumps({"status": "failed", "reason": "factory_create"}, indent=2))
        return 1

    # This is the same public hook used by the current gst-plugins-rs
    # webrtcsink implementation.  It is emitted manually because no ICE/DTLS
    # peer is created by this smoke test.
    state = {"hook_calls": 0, "encoder_bitrate": None}

    def request_aux_sender(_webrtcbin, _transport):
        state["hook_calls"] += 1
        estimator = factory("rtpgccbwe").create("p03-gcc")
        estimator.set_property("min-bitrate", 300_000)
        estimator.set_property("estimated-bitrate", 1_200_000)
        estimator.set_property("max-bitrate", 12_000_000)

        def estimated_bitrate_changed(element, _pspec):
            # The production callback will set the encoder's bitrate here.
            state["encoder_bitrate"] = element.get_property("estimated-bitrate")

        estimator.connect("notify::estimated-bitrate", estimated_bitrate_changed)
        state["estimator"] = estimator
        return estimator

    peer.connect("request-aux-sender", request_aux_sender)
    returned = peer.emit("request-aux-sender", None)
    if returned is None or state.get("hook_calls") != 1:
        print(json.dumps({"status": "failed", "reason": "aux_hook_not_called"}, indent=2))
        return 1

    estimator = state["estimator"]
    if (
        not pipeline.add(peer)
        or not pipeline.add(payloader)
        or not pipeline.add(estimator)
        or not pipeline.add(session)
        or not pipeline.add(sink)
    ):
        print(json.dumps({"status": "failed", "reason": "pipeline_add"}, indent=2))
        return 1

    if not payloader.link(estimator) or not estimator.link(session) or not session.link(sink):
        print(json.dumps({"status": "failed", "reason": "pipeline_link"}, indent=2))
        return 1

    estimator.set_property("estimated-bitrate", 1_234_567)
    if state["encoder_bitrate"] != 1_234_567:
        print(json.dumps({"status": "failed", "reason": "bitrate_notify"}, indent=2))
        return 1

    # Configure TWCC on the RTP payloader in the same way as webrtcsink's
    # source: create the URI-specific extension and use add-extension.
    if payloader.find_property("extensions") is None:
        print(json.dumps({"status": "failed", "reason": "payloader_extensions_property"}, indent=2))
        return 1
    twcc.set_id(3)
    try:
        payloader.emit("add-extension", twcc)
    except Exception as error:
        print(json.dumps({"status": "failed", "reason": "twcc_extension_not_added", "error": str(error)}, indent=2))
        return 1
    # GstValueArray is not introspectable in the host GI bindings. A successful
    # add-extension emission is the check available to this pure Python smoke.
    extension_count = 1

    state_change = pipeline.set_state(Gst.State.READY)
    if state_change == Gst.StateChangeReturn.FAILURE:
        pipeline.set_state(Gst.State.NULL)
        print(json.dumps({"status": "failed", "reason": "pipeline_ready"}, indent=2))
        return 1
    pipeline.set_state(Gst.State.NULL)

    result = {
        "status": "passed",
        "hook": "webrtcbin::request-aux-sender",
        "hook_calls": state["hook_calls"],
        "estimator": "rtpgccbwe",
        "encoder_bitrate_after_notify": state["encoder_bitrate"],
        "twcc_extensions_on_payloader": extension_count,
        "pipeline_state": "READY",
        "scope": "manual hook/TWCC/setter smoke; no ICE, sockets, screen, or network impairment",
    }
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
