"""Run with the video runtime and G_DEBUG=fatal-criticals.

The old PyGObject getter path aborts this test during webrtcbin disposal.
No desktop capture, input injection or network connection is started.
"""
import gc
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'setup/preview'))
from rtc import Gst, disable_ice_upnp
Gst.init(None)


class IceOwnershipTests(unittest.TestCase):
    def test_private_agent_can_be_configured_and_destroyed_repeatedly(self):
        destroyed = []
        for _ in range(20):
            peer = Gst.ElementFactory.make('webrtcbin')
            self.assertIsNotNone(peer)
            peer.weak_ref(lambda: destroyed.append(True))
            disable_ice_upnp(peer)
            peer = None
            gc.collect()
        self.assertEqual(len(destroyed), 20)


if __name__ == '__main__':
    unittest.main()
