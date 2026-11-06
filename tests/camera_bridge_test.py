import sys
import tempfile
import threading
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'setup/preview'))
import camera_bridge
from camera_bridge import Gst, GstWebRTC
Gst.init(None)


class CameraBridgeTests(unittest.TestCase):
    def test_device_is_found_by_label_not_number(self):
        with tempfile.TemporaryDirectory() as root:
            for name, label in (('video0', 'Integrated Camera'), ('video7', camera_bridge.LABEL)):
                (Path(root) / name).mkdir()
                (Path(root) / name / 'name').write_text(label + '\n')
            self.assertEqual(camera_bridge.device(Path(root)), '/dev/video7')
            (Path(root) / 'video7' / 'name').write_text('Otra\n')
            self.assertIsNone(camera_bridge.device(Path(root)))

    def test_offer_asks_the_phone_for_h264_with_retransmission(self):
        pipeline = Gst.Pipeline.new()
        peer = Gst.ElementFactory.make('webrtcbin')
        pipeline.add(peer)
        camera_bridge.add_receiver(peer)
        pipeline.set_state(Gst.State.PLAYING)
        done = threading.Event()
        result = {}

        def created(promise, _):
            reply = promise.get_reply()
            offer = reply.get_value('offer')
            result['sdp'] = offer.sdp.as_text()
            done.set()
        peer.emit('create-offer', None, Gst.Promise.new_with_change_func(created, None))
        self.assertTrue(done.wait(5))
        video = result['sdp'].split('m=video', 1)[1]
        self.assertIn('a=recvonly', video)
        self.assertIn('H264/90000', video)
        self.assertIn('nack', video)
        pipeline.set_state(Gst.State.NULL)


if __name__ == '__main__':
    unittest.main()
