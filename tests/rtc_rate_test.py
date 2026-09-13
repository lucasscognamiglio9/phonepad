"""Run with the isolated video runtime and system Python GI."""
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'setup/preview'))
from rtc import RateController, Session, Manager, GstVideo, Gst
from unittest.mock import patch
from types import SimpleNamespace

class RateTests(unittest.TestCase):
    def test_congestion_and_gradual_recovery(self):
        rate = RateController()
        self.assertEqual(rate.update(.1, .02, .05), 4500)
        self.assertEqual(rate.update(0, .02, .05), 4500)
        self.assertEqual(rate.update(0, .02, .05), 5625)

    def test_stable_remote_rtt_does_not_destroy_quality(self):
        rate = RateController()
        for _ in range(20): rate.update(0, .02, .6)
        self.assertEqual(rate.target, rate.maximum)
        self.assertLess(rate.update(0, .02, .9), rate.maximum)

    def test_recovers_in_seconds_not_minutes(self):
        rate = RateController()
        rate.target = 2000
        for _ in range(12): rate.update(0, .02, .03)
        self.assertGreaterEqual(rate.target, 6000)

    def test_bounded_and_invalid_feedback(self):
        rate = RateController(3500)
        for _ in range(100): rate.update(1, 1, 1)
        self.assertEqual(rate.target, 350)
        for _ in range(1000): rate.update(0, 0, 0)
        self.assertEqual(rate.target, 3500)
        for bad in [float('nan'),float('inf'),-1,'0',None]:
            with self.assertRaises(ValueError): rate.update(bad,0,0)

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

class WarmTests(unittest.TestCase):
    def session(self):
        states=[]
        s=Session.__new__(Session)
        s.suspended=False;s.modern=False;s.touched=0;s.counts={'encoded':2};s.closed=False
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

if __name__ == '__main__': unittest.main()
