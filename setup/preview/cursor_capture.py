"""Composite GNOME's real cursor into the accelerated virtual mirror.

Reuse the existing embedded-cursor portal grant at <=1 fps. Discard auxiliary
DMA-BUFs directly: no second encoder, image copies, or Python frame callbacks.
"""
import os
import re
import socket
import time

import gi
gi.require_version('Gst', '1.0')
from gi.repository import Gst


class EmbeddedCursor:
    def __init__(self, fd, node, source_caps):
        self.fd = fd
        self.node = int(node)
        self.caps = re.sub(r'max-framerate=\(fraction\)\d+/\d+',
                           'max-framerate=(fraction)1/1', source_caps.to_string())
        self.pipeline = None
        self.sink = None

    def start(self):
        try:
            self.pipeline = Gst.parse_launch(
                f'pipewiresrc name=cursor_capture fd={self.fd} path={self.node} do-timestamp=true provide-clock=false '
                f'! {self.caps} '
                '! fakesink name=cursor_sink sync=false async=false enable-last-sample=false')
            self.sink = self.pipeline.get_by_name('cursor_sink')
            self.pipeline.use_clock(Gst.SystemClock.obtain())
            self.pipeline.set_latency(0)
            self.pipeline.set_state(Gst.State.PLAYING)
            end = time.monotonic() + 3
            while not self.samples and time.monotonic() < end:
                error = self.pipeline.get_bus().pop_filtered(Gst.MessageType.ERROR)
                if error:
                    raise RuntimeError(str(error.parse_error()[0]))
                time.sleep(.02)
            if not self.samples:
                raise RuntimeError('cursor frame timeout')
            caps = self.pipeline.get_by_name('cursor_capture').get_static_pad('src').get_current_caps()
            print('cursor embedded capture active: ' + caps.to_string(), flush=True)
        except Exception:
            self.release_connection()
            raise

    @property
    def samples(self):
        return int(self.sink.get_property('stats').get_value('rendered')) if self.sink else 0

    def set_active(self, active):
        if self.pipeline:
            self.pipeline.set_state(Gst.State.PLAYING if active else Gst.State.PAUSED)

    def snapshot(self):
        active = bool(self.fd is not None and self.pipeline and self.pipeline.get_state(0)[1] == Gst.State.PLAYING)
        return {'active': active, 'buffers': self.samples, 'maxFps': 1}

    def release_connection(self):
        # The encoder is a disposable process. Shut down this private portal
        # connection, then let process exit release Gst resources together.
        # PipeWire 1.6.2 can deadlock in synchronous Gst destruction after resume.
        if self.fd is None:
            return
        remote = socket.socket(fileno=self.fd)
        try:
            remote.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        finally:
            remote.close()
            self.fd = None
        print('cursor connection released', flush=True)
