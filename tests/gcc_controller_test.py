import pathlib
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'setup/preview'))

import gcc_controller  # noqa: E402
import rtc  # noqa: E402


class FakeEstimator:
    def __init__(self):
        self.properties = {}
        self.handlers = {}
        self.next_handler = 1
        self.pad = FakePad()

    def set_property(self, key, value):
        self.properties[key] = value
        if key == 'estimated-bitrate' and 'notify::estimated-bitrate' in self.handlers:
            self.handlers['notify::estimated-bitrate'](self, None)

    def get_property(self, key):
        return self.properties[key]

    def connect(self, signal, callback):
        self.handlers[signal] = callback
        handler = self.next_handler
        self.next_handler += 1
        return handler

    def disconnect(self, _handler):
        self.handlers.clear()

    def get_static_pad(self, name):
        return self.pad if name == 'src' else None


class FakePad:
    def add_probe(self, _probe_type, _callback):
        return 21

    def remove_probe(self, _probe):
        pass


class FakeInfo:
    def __init__(self, name):
        self.name = name

    def get_event(self):
        return SimpleNamespace(get_structure=lambda: SimpleNamespace(get_name=lambda: self.name))


class FakeFactory:
    def __init__(self, estimator):
        self.estimator = estimator

    def create(self, _name):
        return self.estimator


class FakePeer:
    def __init__(self):
        self.connected = []
        self.disconnected = []

    def connect(self, signal, callback):
        self.connected.append((signal, callback))
        return 11

    def disconnect(self, handler):
        self.disconnected.append(handler)


class FakeEncoder:
    def __init__(self, bitrate=6000):
        self.bitrate = bitrate
        self.setter_calls = []

    def get_property(self, key):
        self.assert_key(key)
        return self.bitrate

    def set_property(self, key, value):
        self.assert_key(key)
        self.setter_calls.append(value)
        self.bitrate = value

    @staticmethod
    def assert_key(key):
        if key != 'bitrate':
            raise AssertionError(key)


class FakePayloader:
    def find_property(self, key):
        return object() if key == 'extensions' else None

    def emit(self, signal, extension):
        if signal != 'add-extension':
            raise AssertionError(signal)
        self.extension = extension


class FakeExtension:
    def set_id(self, value):
        self.id = value


class FakeRtpModule:
    class RTPHeaderExtension:
        @staticmethod
        def create_from_uri(_uri):
            return FakeExtension()


class ControllerSelectionTests(unittest.TestCase):
    def test_legacy_is_default_and_gcc_requires_explicit_selection(self):
        with patch.dict(gcc_controller.os.environ, {}, clear=True):
            self.assertEqual(gcc_controller.controller_name(), 'legacy')
        self.assertEqual(gcc_controller.controller_name('gcc'), 'gcc')
        with self.assertRaisesRegex(ValueError, 'invalid PHONEPAD_RTC_CONTROLLER'):
            gcc_controller.controller_name('other')

    def test_bitrate_conversion_rounds_and_clamps_in_encoder_units(self):
        bounds = gcc_controller.bounds_for_codec('H264')
        self.assertEqual((bounds.min_bps, bounds.start_bps, bounds.max_bps),
                         (350_000, 6_000_000, 12_000_000))
        self.assertEqual(gcc_controller.bps_to_kbps(1_234_567, bounds), 1235)
        self.assertEqual(gcc_controller.bps_to_kbps(1, bounds), 350)
        self.assertEqual(gcc_controller.bps_to_kbps(99_000_000, bounds), 12000)

    def test_missing_factory_is_explicit(self):
        with self.assertRaisesRegex(gcc_controller.GCCControllerError, 'rtpgccbwe'):
            gcc_controller.require_runtime(lambda name: None if name == 'rtpgccbwe' else object())

    def test_sdp_requires_active_video_twcc_and_transport_feedback(self):
        sdp = """v=0
m=audio 9 UDP/TLS/RTP/SAVPF 111
a=extmap:3 {uri}
m=video 9 UDP/TLS/RTP/SAVPF 96
a=rtpmap:96 H264/90000
a=rtcp-fb:96 transport-cc
a=extmap:3 {uri}
a=sendrecv
""".format(uri=gcc_controller.TWCC_URI)
        self.assertEqual(gcc_controller.require_twcc_sdp(sdp, 'offer'), 3)
        answer = sdp.replace('a=sendrecv', 'a=recvonly')
        self.assertEqual(gcc_controller.require_twcc_sdp(answer, 'answer', expected_id=3), 3)
        for description, direction in (('offer', 'sendonly'), ('answer', 'recvonly')):
            with self.subTest(description=description, direction=direction):
                self.assertEqual(gcc_controller.require_twcc_sdp(
                    sdp.replace('extmap:3 ', 'extmap:3/' + direction + ' '), description), 3)
        for description in ('offer', 'answer'):
            for direction in ('inactive', 'unknown'):
                with self.subTest(description=description, direction=direction):
                    with self.assertRaisesRegex(gcc_controller.GCCControllerError, 'active TWCC direction'):
                        gcc_controller.require_twcc_sdp(
                            sdp.replace('extmap:3 ', 'extmap:3/' + direction + ' '), description)
        with self.assertRaisesRegex(gcc_controller.GCCControllerError, 'unique TWCC'):
            gcc_controller.require_twcc_sdp(sdp + 'a=extmap:3 urn:example:another-extension\n', 'answer')

        with self.assertRaisesRegex(gcc_controller.GCCControllerError, 'consistent'):
            gcc_controller.require_twcc_sdp(answer.replace('extmap:3', 'extmap:4'), 'answer', expected_id=3)
        with self.assertRaisesRegex(gcc_controller.GCCControllerError, 'transport-cc'):
            gcc_controller.require_twcc_sdp(sdp.replace('a=rtcp-fb:96 transport-cc\n', ''), 'offer')
        with self.assertRaisesRegex(gcc_controller.GCCControllerError, 'active video'):
            gcc_controller.require_twcc_sdp(sdp.replace('m=video 9', 'm=video 0'), 'offer')
        with self.assertRaisesRegex(gcc_controller.GCCControllerError, 'active video direction'):
            gcc_controller.require_twcc_sdp(sdp.replace('a=sendrecv\n', '').replace('v=0\n', 'v=0\na=inactive\n'), 'offer')


class ControllerCallbackTests(unittest.TestCase):
    def make_controller(self):
        estimator = FakeEstimator()
        factory = FakeFactory(estimator)
        peer = FakePeer()
        encoder = FakeEncoder()
        with patch.object(gcc_controller, 'require_runtime'), \
                patch.object(gcc_controller, 'add_twcc_extension', return_value=FakeExtension()):
            controller = gcc_controller.GCCController(
                peer, FakePayloader(), encoder, 'H264', factory_find=lambda name: factory)
        return controller, estimator, peer, encoder

    def test_aux_properties_and_estimator_update_encoder_once(self):
        controller, estimator, _peer, encoder = self.make_controller()
        returned = controller._request_aux_sender(None, None)
        self.assertIs(returned, estimator)
        self.assertEqual(estimator.properties['min-bitrate'], 350_000)
        self.assertEqual(estimator.properties['estimated-bitrate'], 6_000_000)
        self.assertEqual(estimator.properties['max-bitrate'], 12_000_000)
        estimator.set_property('estimated-bitrate', 1_234_567)
        self.assertEqual(encoder.bitrate, 1235)
        self.assertEqual(encoder.setter_calls, [1235])
        self.assertEqual(controller.snapshot()['estimatedBitrateBps'], 1_234_567)

    def test_feedback_is_diagnostic_only_and_late_callback_cannot_set_encoder(self):
        controller, estimator, peer, encoder = self.make_controller()
        controller._request_aux_sender(None, None)
        controller._twcc_event(None, FakeInfo('RTPTWCCPackets'))
        self.assertEqual(controller.twcc_event_count, 1)
        controller.receiver_report_received({'loss': 0.2, 'sequence': 7})
        self.assertEqual(controller.receiver_report_count, 1)
        self.assertEqual(encoder.setter_calls, [])
        controller.close()
        self.assertEqual(peer.disconnected, [11])
        controller._twcc_event(None, FakeInfo('RTPTWCCPackets'))
        self.assertEqual(controller.twcc_event_count, 1)
        estimator.set_property('estimated-bitrate', 2_000_000)
        self.assertEqual(encoder.setter_calls, [])
        self.assertIsNone(controller._request_aux_sender(None, None))


class SessionControllerTests(unittest.TestCase):
    def test_gcc_feedback_does_not_run_legacy_rate_or_second_encoder_setter(self):
        session = rtc.Session.__new__(rtc.Session)
        properties = {'bitrate': 6000}
        calls = []
        session.controller_name = 'gcc'
        session.suspended = False
        session.controller = SimpleNamespace(
            receiver_report_received=lambda data: calls.append(data),
            snapshot=lambda: {'controller': 'gcc', 'receiverReportCount': len(calls)},
        )
        session.rate = SimpleNamespace(update=lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError('legacy rate called')))
        session.sample_time = 9
        session.counts = {'encoded': 10}
        session.last_counts = {'encoded': 0}
        session.last_diagnostic = 0
        session.encode_ms = [1, 2, 3]
        session.codec = 'H264'
        session.encoder = SimpleNamespace(
            set_property=lambda key, value: calls.append(('setter', key, value)),
            get_property=lambda key: properties[key],
            get_static_pad=lambda _key: SimpleNamespace(get_current_caps=lambda: SimpleNamespace(to_string=lambda: 'caps')),
        )
        session.pipeline = SimpleNamespace(get_by_name=lambda _key: None)
        session.request_keyframe = lambda: None
        session.media_snapshot = lambda: {'source': {}, 'geometry': {}, 'video': {}}
        result = session.feedback({'loss': 0.2, 'delay': 0.1, 'rtt': 0.2, 'sequence': 3})
        self.assertEqual(result['controller'], 'gcc')
        self.assertEqual(result['gcc']['receiverReportCount'], 1)
        self.assertEqual(properties['bitrate'], 6000)
        self.assertEqual(calls, [{'loss': 0.2, 'delay': 0.1, 'rtt': 0.2, 'sequence': 3}])


if __name__ == '__main__':
    unittest.main()
