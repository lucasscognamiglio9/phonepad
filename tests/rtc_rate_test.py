"""Run with the isolated video runtime and system Python GI."""
import os
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'setup/preview'))
from rtc import RateController, Session, Manager, GstVideo, Gst, _lab_h264_config
from unittest.mock import patch
from types import SimpleNamespace

class StartupTests(unittest.TestCase):
    def test_recovery_sends_headers_and_is_rate_limited(self):
        events = []
        pad = SimpleNamespace(send_event=lambda event: events.append(event))
        session = Session.__new__(Session)
        session.closed = False
        session.last_keyframe = 0
        session.encoder = SimpleNamespace(get_static_pad=lambda name: pad)
        with patch('rtc.time.monotonic', return_value=10):
            session.request_keyframe()
            session.request_keyframe()
        self.assertEqual(len(events), 1)
        parsed = GstVideo.video_event_parse_upstream_force_key_unit(events[0])
        self.assertTrue(parsed[0])
        self.assertTrue(parsed[2])  # SPS/PPS headers accompany the fresh IDR.
        with patch('rtc.time.monotonic', return_value=12):
            session.request_keyframe()
        self.assertEqual(len(events), 2)
        session.closed = True
        with patch('rtc.time.monotonic', return_value=20):
            session.request_keyframe()
        self.assertEqual(len(events), 2)


class LabMatrixConfigTests(unittest.TestCase):
    def test_lab_matrix_defaults_and_aliases_are_explicit(self):
        with patch.dict(os.environ, {'PHONEPAD_HFR_ROOT': '/tmp/phonepad-hfr-test',
                                     'PHONEPAD_MIRROR_HZ': '120'}, clear=False):
            config = _lab_h264_config(60)
        self.assertEqual(config['profile'], 'constrained-baseline')
        self.assertEqual(config['bitrateKbps'], 6000)
        self.assertEqual(config['keyint'], 60)
        self.assertEqual(config['fps'], 120)
        with patch.dict(os.environ, {'PHONEPAD_HFR_ROOT': '/tmp/phonepad-hfr-test',
                                     'PHONEPAD_MIRROR_HZ': '90',
                                     'PHONEPAD_LAB_H264_PROFILE': 'baseline',
                                     'PHONEPAD_LAB_H264_BITRATE_KBPS': '18000',
                                     'PHONEPAD_LAB_H264_KEYINT': '45',
                                     'PHONEPAD_LAB_FIXED_BITRATE': '1'}, clear=False):
            config = _lab_h264_config(60)
        self.assertEqual(config, {'profile': 'constrained-baseline',
                                  'requestedProfile': 'baseline',
                                  'bitrateKbps': 18000,
                                  'keyint': 45, 'fps': 90,
                                  'fixedBitrate': True})

    def test_production_ignores_lab_matrix_environment(self):
        with patch.dict(os.environ, {'PHONEPAD_HFR_ROOT': '',
                                     'PHONEPAD_LAB_H264_PROFILE': 'high',
                                     'PHONEPAD_LAB_H264_BITRATE_KBPS': '32000'}, clear=False):
            self.assertIsNone(_lab_h264_config(30))

    def test_lab_matrix_rejects_unsupported_capacity_requests(self):
        for key, value in (('PHONEPAD_LAB_H264_PROFILE', 'main'),
                           ('PHONEPAD_LAB_H264_BITRATE_KBPS', '17000'),
                           ('PHONEPAD_MIRROR_HZ', '75')):
            with self.subTest(key=key):
                env = {'PHONEPAD_HFR_ROOT': '/tmp/phonepad-hfr-test', key: value}
                with patch.dict(os.environ, env, clear=False):
                    with self.assertRaises(ValueError):
                        _lab_h264_config(60)
class WarmTests(unittest.TestCase):
    def session(self):
        states=[]
        s=Session.__new__(Session)
        s.rate=RateController();s.suspended=False;s.modern=False;s.touched=0;s.counts={'encoded':2};s.closed=False
        s.pipeline=SimpleNamespace(set_state=lambda state:states.append(state))
        s.flow=SimpleNamespace(set_property=lambda key,value:states.append((key,value)))
        s.request_keyframe=lambda:states.append('keyframe')
        s.close=lambda:states.append('closed')
        return s,states

    def test_pause_is_idempotent_and_feedback_cannot_extend_lease(self):
        s,states=self.session()
        with patch('rtc.time.monotonic',return_value=10):s.suspend()
        with patch('rtc.time.monotonic',return_value=100):
            s.suspend();self.assertEqual(s.feedback({}),{'suspended':True})
        self.assertEqual(s.touched,10);self.assertEqual(states,[('drop',True)])
        with patch('rtc.time.monotonic',return_value=309):s.resume()
        self.assertFalse(s.suspended);self.assertEqual(states[-2:],[('drop',False),'keyframe'])

    def test_resume_cannot_bypass_five_minute_expiration(self):
        s,states=self.session()
        with patch('rtc.time.monotonic',return_value=10):s.suspend()
        with patch('rtc.time.monotonic',return_value=310):
            with self.assertRaises(ValueError):s.resume()
        self.assertEqual(states[-1],'closed')

    def test_server_releases_background_resources_without_client_timer(self):
        s,states=self.session();m=Manager.__new__(Manager);m.session=s
        with patch('rtc.time.monotonic',return_value=10):s.suspend()
        with patch('rtc.time.monotonic',return_value=309):m.expire()
        self.assertIs(m.session,s)
        with patch('rtc.time.monotonic',return_value=310):m.expire()
        self.assertIsNone(m.session);self.assertEqual(states[-1],'closed')


class FeedbackTests(unittest.TestCase):
    def session(self):
        s = Session.__new__(Session)
        s.suspended = False; s.rate = RateController(); s.sample_time = 9
        s.counts = {'encoded': 10}; s.last_counts = {'encoded': 0}
        s.last_diagnostic = 0; s.encode_ms = [1, 2, 3]; s.codec = 'H264'
        properties = {'bitrate': 6000}
        caps = SimpleNamespace(to_string=lambda: 'fixture-caps')
        pad = SimpleNamespace(get_current_caps=lambda: caps)
        s.encoder = SimpleNamespace(set_property=lambda k,v: properties.update({k:v}),
                                    get_property=lambda k: properties[k], get_static_pad=lambda k: pad)
        s.pipeline = SimpleNamespace(get_by_name=lambda k: None)
        s.request_keyframe = lambda: None
        return s

    def test_native_feedback_reports_requested_applied_and_encode_without_missing_metric_growth(self):
        s = self.session()
        with patch('rtc.time.monotonic', return_value=10), patch('builtins.print') as log:
            result = s.feedback({'client':'native', 'frames':10})
        self.assertEqual(result['bitrateKbps'], 6000)
        self.assertEqual(result['rateDecision']['requestedKbps'], 6000)
        self.assertEqual(result['rateDecision']['appliedKbps'], 6000)
        self.assertIsNone(result['rateDecision']['loss'])
        self.assertEqual(result['encodeP95Ms'], 3)
        self.assertNotIn('freshness', result)
        self.assertTrue(log.called)

    def test_severe_loss_refreshes_reference_once_after_bitrate_recovers(self):
        s = self.session()
        s.quality_recovery_pending = False
        s.last_keyframe = 0
        keyframes = []
        s.request_keyframe = lambda: keyframes.append(True)
        with patch('builtins.print'):
            for second, loss in [(10, .65), (11, 0), (12, 0), (13, 0), (14, 0), (15, 0)]:
                with patch('rtc.time.monotonic', return_value=second):
                    s.feedback({'loss':loss, 'client':'native', 'frames':10, 'sequence':second})
        self.assertEqual(keyframes, [True])
        self.assertFalse(s.quality_recovery_pending)

    def test_recovery_does_not_wait_for_initial_bitrate(self):
        s = self.session()
        s.quality_recovery_pending = False
        s.last_keyframe = 0
        keyframes = []
        s.request_keyframe = lambda: keyframes.append(True)
        with patch('builtins.print'):
            with patch('rtc.time.monotonic', return_value=10):
                s.feedback({'loss': .65, 'client': 'native', 'frames': 10, 'sequence': 1})
            with patch('rtc.time.monotonic', return_value=11):
                response = s.feedback({'loss': 0, 'client': 'native', 'frames': 11, 'sequence': 2})
        self.assertLess(response['bitrateKbps'], 6000)
        self.assertEqual(keyframes, [True])
        self.assertFalse(s.quality_recovery_pending)

if __name__ == '__main__': unittest.main()
