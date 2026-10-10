#!/usr/bin/env python3
"""Synthetic two-peer WebRTC loopback for the private rsrtp experiment.

The source is videotestsrc/VP8, the peers share one local GStreamer process,
and no STUN/TURN server or Phonepad runtime is involved.  The sender's
``request-aux-sender`` callback is reached by real SDP negotiation.  The
script records SDP TWCC negotiation, upstream RTPTWCCPackets events on the
returned AUX element, and the encoder setter driven by GCC notifications.
"""

import json
import os
import sys

import gi

gi.require_version("Gst", "1.0")
gi.require_version("GstRtp", "1.0")
gi.require_version("GstWebRTC", "1.0")
from gi.repository import GLib, Gst, GstRtp, GstWebRTC


TWCC_URI = "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01"
TIMEOUT_SECONDS = 30
MIN_RECEIVED_BUFFERS = 32


def factory(name):
    return Gst.ElementFactory.find(name)


def make(factory_name, element_name):
    element = factory(factory_name).create(element_name)
    if element is None:
        raise RuntimeError(f"could not create {factory_name}")
    return element


class Loopback:
    def __init__(self):
        self.loop = GLib.MainLoop()
        self.pipeline = Gst.Pipeline.new("p03-webrtc-loopback")
        self.sender = make("webrtcbin", "p03-sender")
        self.receiver = make("webrtcbin", "p03-receiver")
        self.source = make("videotestsrc", "p03-test-source")
        self.convert = make("videoconvert", "p03-convert")
        self.encoder = make("vp8enc", "p03-vp8enc")
        self.payloader = make("rtpvp8pay", "p03-vp8pay")
        self.queue = make("queue", "p03-send-queue")
        self.receive_sink = make("fakesink", "p03-receive-sink")
        self.state = {
            "aux_calls": 0,
            "estimator": None,
            "twcc_events": 0,
            "notify_count": 0,
            "notify_after_playing": 0,
            "encoder_setter_count": 0,
            "estimated_bitrates": [],
            "encoder_bitrates": [],
            "received_buffers": 0,
            "candidate_counts": {"sender": 0, "receiver": 0},
            "candidate_samples": {"sender": [], "receiver": []},
            "webrtc_states": {"sender": {}, "receiver": {}},
            "bus_errors": [],
            "offer_sdp": "",
            "answer_sdp": "",
            "answer_sdp_raw": "",
            "remote_description": {"sender": False, "receiver": False},
            "pending_candidates": {"sender": [], "receiver": []},
            "offer_started": False,
            "timed_out": False,
            "completed": False,
            "finish_scheduled": False,
            "error": None,
            "play_started": False,
        }
        # GStreamer 1.28.2 only copies the offered extmap into the answer when
        # the answerer's transceiver advertises that extension in its caps.
        # Keep that receiver capability on by default; setting this to 0
        # reproduces the raw answerer behavior for diagnosis.
        self.explicit_receiver_twcc = os.environ.get("P03_EXPLICIT_RECEIVER_TWCC", "1") != "0"

    def configure(self):
        # No STUN/TURN property is set: ICE is restricted to candidates from
        # this host and the test remains local to the lab process.
        self.source.set_property("is-live", True)
        self.source.set_property("pattern", 0)
        self.encoder.set_property("deadline", 1)
        self.encoder.set_property("cpu-used", 8)
        self.encoder.set_property("threads", 1)
        self.encoder.set_property("target-bitrate", 300_000)
        self.payloader.set_property("pt", 96)
        self.queue.set_property("leaky", 2)  # downstream
        self.queue.set_property("max-size-buffers", 3)
        self.receive_sink.set_property("sync", False)
        self.receive_sink.set_property("signal-handoffs", True)

        twcc = GstRtp.RTPHeaderExtension.create_from_uri(TWCC_URI)
        if twcc is None:
            raise RuntimeError("could not create TWCC extension")
        twcc.set_id(3)
        self.payloader.emit("add-extension", twcc)

        self.pipeline.add(self.source)
        self.pipeline.add(self.convert)
        self.pipeline.add(self.encoder)
        self.pipeline.add(self.payloader)
        self.pipeline.add(self.queue)
        self.pipeline.add(self.sender)
        self.pipeline.add(self.receiver)
        self.pipeline.add(self.receive_sink)
        if self.explicit_receiver_twcc:
            receiver_caps = Gst.Caps.from_string(
                "application/x-rtp,media=video,encoding-name=VP8,"
                "clock-rate=90000,payload=96,"
                f"extmap-3=(string){TWCC_URI}"
            )
            self.receiver.emit(
                "add-transceiver",
                GstWebRTC.WebRTCRTPTransceiverDirection.RECVONLY,
                receiver_caps,
            )
        if not self.source.link(self.convert):
            raise RuntimeError("source -> convert link failed")
        if not self.convert.link(self.encoder):
            raise RuntimeError("convert -> encoder link failed")
        if not self.encoder.link(self.payloader):
            raise RuntimeError("encoder -> payloader link failed")
        if not self.payloader.link(self.queue):
            raise RuntimeError("payloader -> queue link failed")
        sink_pad = self.sender.get_request_pad("sink_%u")
        if sink_pad is None:
            raise RuntimeError("webrtcbin sender sink pad unavailable")
        if self.queue.get_static_pad("src").link(sink_pad) != Gst.PadLinkReturn.OK:
            raise RuntimeError("queue -> webrtcbin link failed")

        self.sender.connect("on-negotiation-needed", self.on_negotiation_needed)
        self.sender.connect("on-ice-candidate", self.on_sender_candidate)
        self.receiver.connect("on-ice-candidate", self.on_receiver_candidate)
        self.receiver.connect("pad-added", self.on_receiver_pad)
        self.receive_sink.connect("handoff", self.on_handoff)
        for name, element in (("sender", self.sender), ("receiver", self.receiver)):
            for property_name in (
                "ice-connection-state",
                "connection-state",
                "ice-gathering-state",
                "signaling-state",
            ):
                element.connect(
                    f"notify::{property_name}",
                    self.on_webrtc_state,
                    name,
                    property_name,
                )
        bus = self.pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect("message", self.on_bus_message)

    @staticmethod
    def _enum_text(value):
        value_nick = getattr(value, "value_nick", None)
        if value_nick:
            return value_nick
        value_name = getattr(value, "value_name", None)
        if value_name:
            return value_name
        return str(value)

    def on_webrtc_state(self, element, _pspec, peer_name, property_name):
        try:
            value = element.get_property(property_name)
            self.state["webrtc_states"][peer_name][property_name] = self._enum_text(value)
        except Exception as error:
            self.state["webrtc_states"][peer_name][property_name] = f"error:{error}"

    def on_bus_message(self, _bus, message):
        if message.type == Gst.MessageType.ERROR:
            error, debug = message.parse_error()
            self.state["bus_errors"].append(
                {"source": message.src.get_name(), "error": str(error), "debug": debug}
            )

    def on_handoff(self, _sink, _buffer, _pad):
        self.state["received_buffers"] += 1
        self.maybe_finish()

    def on_receiver_pad(self, _element, pad):
        sink_pad = self.receive_sink.get_static_pad("sink")
        if sink_pad is None or sink_pad.is_linked():
            return
        result = pad.link(sink_pad)
        if result != Gst.PadLinkReturn.OK:
            self.fail(f"receiver pad link failed: {result.value_nick}")

    def install_aux_probe(self, estimator):
        src_pad = estimator.get_static_pad("src")
        if src_pad is None:
            raise RuntimeError("rtpgccbwe src pad unavailable")

        def event_probe(_pad, info):
            event = info.get_event()
            structure = event.get_structure() if event is not None else None
            if structure is not None and structure.get_name() == "RTPTWCCPackets":
                self.state["twcc_events"] += 1
                self.maybe_finish()
            return Gst.PadProbeReturn.OK

        src_pad.add_probe(Gst.PadProbeType.EVENT_UPSTREAM, event_probe)

    def on_estimated_bitrate(self, estimator, _pspec):
        bitrate = int(estimator.get_property("estimated-bitrate"))
        self.state["notify_count"] += 1
        self.state["estimated_bitrates"].append(bitrate)
        self.encoder.set_property("target-bitrate", bitrate)
        self.state["encoder_bitrates"].append(int(self.encoder.get_property("target-bitrate")))
        if self.state["play_started"]:
            self.state["notify_after_playing"] += 1
            self.state["encoder_setter_count"] += 1
            self.maybe_finish()

    def maybe_finish(self):
        """Stop after a short positive end-to-end sample, or let timeout fire."""
        if self.state["finish_scheduled"]:
            return
        offer_has_twcc = TWCC_URI in self.state["offer_sdp"]
        answer_has_twcc = TWCC_URI in self.state["answer_sdp"]
        connected = all(
            self.state["webrtc_states"].get(peer, {}).get("connection-state") == "connected"
            for peer in ("sender", "receiver")
        )
        enough = (
            self.state["aux_calls"] > 0
            and offer_has_twcc
            and answer_has_twcc
            and connected
            and self.state["received_buffers"] >= MIN_RECEIVED_BUFFERS
            and self.state["twcc_events"] > 0
            and self.state["encoder_setter_count"] > 0
        )
        if enough:
            self.state["finish_scheduled"] = True
            GLib.idle_add(self.finish_success)

    def finish_success(self):
        self.state["completed"] = True
        self.loop.quit()
        return False

    def on_request_aux_sender(self, _webrtcbin, _transport):
        self.state["aux_calls"] += 1
        estimator = make("rtpgccbwe", "p03-rtpgccbwe")
        estimator.set_property("min-bitrate", 100_000)
        estimator.set_property("estimated-bitrate", 300_000)
        estimator.set_property("max-bitrate", 2_000_000)
        estimator.connect("notify::estimated-bitrate", self.on_estimated_bitrate)
        self.install_aux_probe(estimator)
        self.state["estimator"] = estimator
        return estimator

    def add_candidate(self, peer_name, mline, candidate):
        other = "receiver" if peer_name == "sender" else "sender"
        if self.state["remote_description"][other]:
            target = self.receiver if other == "receiver" else self.sender
            target.emit("add-ice-candidate", mline, candidate)
        else:
            self.state["pending_candidates"][peer_name].append((mline, candidate))

    def on_sender_candidate(self, _element, mline, candidate):
        self.record_candidate("sender", candidate)
        self.add_candidate("sender", mline, candidate)

    def on_receiver_candidate(self, _element, mline, candidate):
        self.record_candidate("receiver", candidate)
        self.add_candidate("receiver", mline, candidate)

    def record_candidate(self, peer_name, candidate):
        self.state["candidate_counts"][peer_name] += 1
        samples = self.state["candidate_samples"][peer_name]
        if len(samples) < 4:
            samples.append(candidate)

    def flush_candidates(self, peer_name):
        target = self.receiver if peer_name == "sender" else self.sender
        pending = self.state["pending_candidates"][peer_name]
        for mline, candidate in pending:
            target.emit("add-ice-candidate", mline, candidate)
        pending.clear()

    def on_negotiation_needed(self, _element):
        GLib.idle_add(self.start_offer)

    def start_offer(self):
        if self.state["offer_started"]:
            return False
        self.state["offer_started"] = True
        promise = Gst.Promise.new_with_change_func(self.on_offer_created, None)
        self.sender.emit("create-offer", None, promise)
        return False

    def on_offer_created(self, promise, _user_data):
        reply = promise.get_reply()
        offer = reply.get_value("offer")
        if offer is None:
            self.fail("create-offer returned no offer")
            return
        self.state["offer_sdp"] = offer.sdp.as_text()
        self.sender.emit("set-local-description", offer, Gst.Promise.new())
        remote_promise = Gst.Promise.new_with_change_func(self.on_offer_set, offer)
        self.receiver.emit("set-remote-description", offer, remote_promise)

    def on_offer_set(self, promise, offer):
        # set-remote-description replies with an empty promise structure on
        # success, so get_reply() may legitimately be None here.
        self.state["remote_description"]["receiver"] = True
        self.flush_candidates("sender")
        answer_promise = Gst.Promise.new_with_change_func(self.on_answer_created, None)
        self.receiver.emit("create-answer", None, answer_promise)

    def on_answer_created(self, promise, _user_data):
        reply = promise.get_reply()
        answer = reply.get_value("answer")
        if answer is None:
            self.fail("create-answer returned no answer")
            return
        raw_answer_sdp = answer.sdp.as_text()
        self.state["answer_sdp_raw"] = raw_answer_sdp
        self.state["answer_sdp"] = raw_answer_sdp
        self.receiver.emit("set-local-description", answer, Gst.Promise.new())
        remote_promise = Gst.Promise.new_with_change_func(self.on_answer_set, None)
        self.sender.emit("set-remote-description", answer, remote_promise)

    def on_answer_set(self, promise, _user_data):
        # As above, the successful setter promise has no value fields.
        self.state["remote_description"]["sender"] = True
        self.flush_candidates("receiver")

    def fail(self, message):
        if self.state["error"] is None:
            self.state["error"] = message
        self.loop.quit()

    def timeout(self):
        if not self.state["completed"]:
            self.state["timed_out"] = True
        self.loop.quit()
        return False

    def run(self):
        self.configure()
        self.sender.connect("request-aux-sender", self.on_request_aux_sender)
        if self.pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
            self.fail("pipeline PLAYING failed")
        self.state["play_started"] = True
        GLib.timeout_add_seconds(1, self.start_offer)
        GLib.timeout_add_seconds(TIMEOUT_SECONDS, self.timeout)
        self.loop.run()
        self.pipeline.set_state(Gst.State.NULL)
        return self.result()

    def result(self):
        offer_has_twcc = TWCC_URI in self.state["offer_sdp"]
        answer_has_twcc = TWCC_URI in self.state["answer_sdp"]
        passed = (
            self.state["error"] is None
            and not self.state["timed_out"]
            and self.state["aux_calls"] > 0
            and offer_has_twcc
            and answer_has_twcc
            and self.state["received_buffers"] > 0
            and self.state["twcc_events"] > 0
            and self.state["encoder_setter_count"] > 0
        )
        return {
            "status": "passed" if passed else "failed",
            "aux_calls": self.state["aux_calls"],
            "offer_twcc": offer_has_twcc,
            "answer_twcc": answer_has_twcc,
            "answer_twcc_raw": TWCC_URI in self.state["answer_sdp_raw"],
            "received_buffers": self.state["received_buffers"],
            "rtptwccpackets_events": self.state["twcc_events"],
            "estimated_bitrate_notifications": self.state["notify_after_playing"],
            "encoder_setter_count": self.state["encoder_setter_count"],
            "estimated_bitrates": self.state["estimated_bitrates"][-8:],
            "encoder_bitrates": self.state["encoder_bitrates"][-8:],
            "offer_sdp_bytes": len(self.state["offer_sdp"]),
            "answer_sdp_bytes": len(self.state["answer_sdp"]),
            "offer_has_candidates": "a=candidate:" in self.state["offer_sdp"],
            "answer_has_candidates": "a=candidate:" in self.state["answer_sdp"],
            "candidate_counts": self.state["candidate_counts"],
            "candidate_samples": self.state["candidate_samples"],
            "webrtc_states": self.state["webrtc_states"],
            "bus_errors": self.state["bus_errors"][-8:],
            "timeout_seconds": TIMEOUT_SECONDS,
            "scope": "local two-webrtcbin VP8 loopback; no STUN/TURN, screen, Phonepad, or external network",
            "explicit_receiver_twcc": self.explicit_receiver_twcc,
            "error": self.state["error"],
        }


def main():
    Gst.init(None)
    required = ("videotestsrc", "videoconvert", "vp8enc", "rtpvp8pay", "webrtcbin", "fakesink", "rtpgccbwe")
    missing = [name for name in required if factory(name) is None]
    if missing:
        print(json.dumps({"status": "blocked", "missing_factories": missing}, indent=2))
        return 2
    try:
        result = Loopback().run()
    except Exception as error:
        result = {"status": "failed", "error": str(error)}
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result.get("status") == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
