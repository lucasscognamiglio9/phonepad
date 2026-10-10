"""Exercise the native query probe against real GStreamer source latency.

Set PHONEPAD_LIVE_ADAPTER_TEST_LIBRARY to the compiled public-API helper.
The test does not capture a desktop or inject input.
"""
import ctypes
import os
import pathlib
import unittest
import gi
gi.require_version('Gst', '1.0')
from gi.repository import Gst

@unittest.skipUnless(os.environ.get('PHONEPAD_LIVE_ADAPTER_TEST_LIBRARY'), 'native adapter build required')
class LiveCaptureTests(unittest.TestCase):
    def test_probe_preserves_bounds_and_removal_restores_original_live_flag(self):
        Gst.init(None)
        library=ctypes.CDLL(os.environ['PHONEPAD_LIVE_ADAPTER_TEST_LIBRARY'])
        library.phonepad_mark_live_capture.argtypes=[ctypes.c_void_p]
        library.phonepad_mark_live_capture.restype=ctypes.c_ulong
        capsule=ctypes.pythonapi.PyCapsule_GetPointer
        capsule.argtypes=[ctypes.py_object,ctypes.c_char_p];capsule.restype=ctypes.c_void_p
        for live in (False,True):
            pipeline=Gst.parse_launch('videotestsrc name=capture is-live='+str(live).lower()+' ! fakesink name=sink sync=false')
            source=pipeline.get_by_name('capture');sink=pipeline.get_by_name('sink').get_static_pad('sink')
            probe=None
            def query():
                value=Gst.Query.new_latency()
                self.assertTrue(sink.peer_query(value))
                return value.parse_latency()
            try:
                pipeline.set_state(Gst.State.PLAYING);pipeline.get_state(Gst.SECOND)
                original=query()
                probe=library.phonepad_mark_live_capture(capsule(source.__gpointer__,None))
                self.assertGreater(probe,0)
                for _ in range(10):self.assertEqual(query(),(True,original[1],original[2]))
                source.get_static_pad('src').remove_probe(probe);probe=None
                self.assertEqual(query(),original)
                self.assertEqual(library.phonepad_mark_live_capture(capsule(pipeline.__gpointer__,None)),0)
            finally:
                if probe:source.get_static_pad('src').remove_probe(probe)
                pipeline.set_state(Gst.State.NULL)
