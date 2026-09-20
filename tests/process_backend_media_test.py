import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'setup/preview'))
from process_backend import ProcessBackend  # noqa: E402


MEDIA = {
    'version': 1,
    'source': {'state': 'available', 'id': 'worker-fixture', 'kind': 'hfr-worker'},
    'geometry': {'state': 'available', 'epoch': 1, 'width': 1279, 'height': 719,
                 'encodedWidth': 1279, 'encodedHeight': 719},
    'video': {'state': 'available', 'codecs': ['H264'], 'selectedCodec': 'H264'},
}

FAKE = '''import json,sys
media = %r
for line in sys.stdin:
    data=json.loads(line)
    if data.get('op') == 'start': result={'id':'worker-session','sdp':'fixture','media':media}
    elif data.get('id') != 'worker-session':
        print(json.dumps({'error':'session unavailable','invalid':True}), flush=True); continue
    elif data.get('op') in ('feedback','resume'):
        result={'ok':True,'media':media}
    elif data.get('op') == 'stop':
        result={'ok':True,'media':media}
    else: result={'ok':True}
    print(json.dumps({'result':result}), flush=True)
    if data.get('op') == 'stop': break
''' % MEDIA


class ProcessBackendMediaTests(unittest.TestCase):
    def setUp(self):
        self.backend = ProcessBackend([sys.executable, '-u', '-c', FAKE])

    def tearDown(self):
        self.backend.close()

    def test_parent_propagates_worker_media_only_after_response(self):
        self.assertEqual(self.backend.media_snapshot()['source']['state'], 'unknown')
        result = self.backend.handle({'op': 'start', 'codec': 'H264'})
        self.assertEqual(result['media'], MEDIA)
        self.assertEqual(self.backend.media_snapshot(), MEDIA)
        self.backend.handle({'op': 'feedback', 'id': 'worker-session'})
        self.assertEqual(self.backend.media_snapshot()['geometry']['epoch'], 1)
        self.backend.handle({'op': 'stop', 'id': 'worker-session'})
        self.assertEqual(self.backend.media_snapshot()['source']['state'], 'unknown')

    def test_invalid_worker_media_is_not_advertised(self):
        bad = FAKE.replace("media = %r" % MEDIA, "media = {'version': 1}")
        self.backend.close()
        self.backend = ProcessBackend([sys.executable, '-u', '-c', bad])
        with self.assertRaises(ValueError):
            self.backend.handle({'op': 'start'})
        self.assertEqual(self.backend.media_snapshot()['source']['state'], 'unknown')


if __name__ == '__main__':
    unittest.main()
