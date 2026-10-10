"""Bounded worker shutdown and post-shutdown admission tests."""

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'setup/preview'))
from process_backend import ProcessBackend  # noqa: E402


FAKE = '''import json,sys
for line in sys.stdin:
    data=json.loads(line)
    if data.get('op') == 'start': result={'id':'lifecycle-session'}
    elif data.get('id') != 'lifecycle-session':
        print(json.dumps({'error':'session unavailable','invalid':True}),flush=True); continue
    elif data.get('op') == 'stop': result={'ok':True}
    else: result={'ok':True}
    print(json.dumps({'result':result}),flush=True)
    if data.get('op') == 'stop': break
'''


class ProcessBackendLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.backend = ProcessBackend([sys.executable, '-u', '-c', FAKE])

    def tearDown(self):
        self.backend.close()

    def test_shutdown_reaps_worker_and_rejects_new_session(self):
        self.backend.handle({'op': 'start'})
        process = self.backend.process
        self.assertIsNotNone(process)
        self.assertTrue(self.backend.shutdown(timeout=1))
        self.assertIsNone(self.backend.process)
        self.assertIsNotNone(process.poll())
        self.assertTrue(self.backend.shutdown())
        with self.assertRaisesRegex(ValueError, 'backend closing'):
            self.backend.handle({'op': 'start'})

    def test_shutdown_admission_is_immediate_while_rpc_lock_is_busy(self):
        self.backend.lock.acquire()
        try:
            with self.assertRaises(TimeoutError):
                self.backend.shutdown(timeout=0.01)
            started = __import__('time').monotonic()
            with self.assertRaisesRegex(ValueError, 'backend closing'):
                self.backend.handle({'op': 'start'})
            self.assertLess(__import__('time').monotonic() - started, 0.2)
        finally:
            self.backend.lock.release()
        self.assertTrue(self.backend._shutdown_done.wait(1))


if __name__ == '__main__':
    unittest.main()
