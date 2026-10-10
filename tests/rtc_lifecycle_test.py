"""Lifecycle tests for the GLib-owned provider manager.

Run with the isolated video runtime and system Python GI.  The fake GLib
surface keeps these tests independent of a live portal or display.
"""

import pathlib
import sys
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'setup/preview'))
import rtc  # noqa: E402


class FakeGLib:
    def __init__(self):
        self.callbacks = []
        self.removed = []
        self.next_id = 40

    def idle_add(self, callback):
        self.callbacks.append(callback)
        self.next_id += 1
        return self.next_id

    def source_remove(self, source_id):
        self.removed.append(source_id)
        return True


def manager_fixture():
    manager = rtc.Manager.__new__(rtc.Manager)
    manager._life_lock = threading.RLock()
    manager._dispatch_tasks = set()
    manager._closing = False
    manager._closed = False
    manager._glib_thread_id = None
    manager._expiry_source = None
    manager.session = None
    return manager


class DispatchLifecycleTests(unittest.TestCase):
    def test_repeated_shutdown_keeps_the_cleanup_error(self):
        glib = FakeGLib()
        manager = manager_fixture()
        calls = []

        def fail_close():
            calls.append('close')
            raise RuntimeError('fixture cleanup failed')

        manager.session = SimpleNamespace(closed=False, close=fail_close)
        with patch.object(rtc, 'GLib', glib):
            for operation in (manager.shutdown_on_loop, manager.shutdown, manager.shutdown_on_loop):
                with self.assertRaisesRegex(RuntimeError, 'fixture cleanup failed'):
                    operation()
        self.assertEqual(calls, ['close'])

    def test_queued_timeout_cannot_run_late(self):
        glib = FakeGLib()
        manager = manager_fixture()
        calls = []
        with patch.object(rtc, 'GLib', glib):
            with self.assertRaises(TimeoutError):
                manager.dispatch(lambda: calls.append('late'), timeout=0.01)
            self.assertEqual(calls, [])
            self.assertEqual(glib.removed, [41])
            # A source_remove race may still deliver the callback.  Its own
            # cancellation bit must make that delivery a no-op.
            self.assertFalse(glib.callbacks[0]())
            self.assertEqual(calls, [])

    def test_inflight_timeout_returns_without_second_execution(self):
        glib = FakeGLib()
        manager = manager_fixture()
        started = threading.Event()
        release = threading.Event()
        calls = []

        def action():
            calls.append('started')
            started.set()
            release.wait(1)
            calls.append('finished')

        def run(callback):
            glib.callbacks.append(callback)
            thread = threading.Thread(target=callback)
            thread.start()
            glib.thread = thread
            glib.next_id += 1
            return glib.next_id

        glib.idle_add = run
        with patch.object(rtc, 'GLib', glib):
            began = time.monotonic()
            with self.assertRaises(TimeoutError):
                manager.dispatch(action, timeout=0.02)
            elapsed = time.monotonic() - began
            self.assertTrue(started.wait(0.2))
            self.assertLess(elapsed, 0.5)
            self.assertEqual(glib.removed, [])
            release.set()
            glib.thread.join(1)
        self.assertEqual(calls, ['started', 'finished'])
        self.assertEqual(manager._glib_thread_id, glib.thread.ident)

    def test_manager_cancels_waiting_dispatch_with_explicit_error(self):
        glib = FakeGLib()
        manager = manager_fixture()
        errors = []
        with patch.object(rtc, 'GLib', glib):
            waiter = threading.Thread(target=lambda: self._capture_error(
                errors, manager.dispatch, lambda: errors.append('late'), 1))
            waiter.start()
            while not glib.callbacks:
                time.sleep(0.001)
            manager._begin_closing()
            waiter.join(1)
            self.assertFalse(waiter.is_alive())
            glib.callbacks[0]()
        self.assertEqual(errors[0], rtc.DispatchCancelled)
        self.assertEqual(errors[1:], [])

    @staticmethod
    def _capture_error(errors, dispatch, action, timeout):
        try:
            dispatch(action, timeout=timeout)
        except Exception as error:
            errors.append(type(error))

    def test_shutdown_is_idempotent_and_rejects_new_start(self):
        glib = FakeGLib()
        manager = manager_fixture()
        manager._expiry_source = 99
        session = SimpleNamespace(closed=False, close=lambda: setattr(session, 'closed', True))
        manager.session = session
        with patch.object(rtc, 'GLib', glib):
            self.assertFalse(manager.shutdown_on_loop())
            self.assertTrue(session.closed)
            self.assertIsNone(manager.session)
            self.assertFalse(manager.shutdown_on_loop())
            self.assertEqual(glib.removed, [99])
            with self.assertRaisesRegex(ValueError, 'manager closing'):
                manager.handle({'op': 'start'})
            self.assertTrue(manager.shutdown(timeout=0.01))

    def test_shutdown_timeout_keeps_one_owner_callback_queued(self):
        glib = FakeGLib()
        manager = manager_fixture()
        manager._expiry_source = 101
        close_count = []
        session = SimpleNamespace(closed=False)
        session.close = lambda: (close_count.append(1), setattr(session, 'closed', True))
        manager.session = session
        with patch.object(rtc, 'GLib', glib):
            with self.assertRaises(TimeoutError):
                manager.shutdown(timeout=0.01)
            self.assertFalse(manager.closed)
            self.assertEqual(len(glib.callbacks), 1)
            self.assertFalse(glib.callbacks[0]())
            self.assertTrue(manager.closed)
            self.assertEqual(close_count, [1])
            # A second shutdown observes the same completed request and does
            # not enqueue another owner callback.
            self.assertTrue(manager.shutdown(timeout=0.01))
            self.assertEqual(len(glib.callbacks), 1)


if __name__ == '__main__':
    unittest.main()
