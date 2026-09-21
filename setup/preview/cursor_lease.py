"""Enlarge the one embedded host cursor during an explicit preview session.

A guardian process restores the prior size on EOF or SIGTERM, including when
an encoder worker crashes. Never changes pointer acceleration or sensitivity.
"""
import os
import signal
import subprocess
import sys
from pathlib import Path

class CursorSizeLease:
    def __init__(self, settings, size):
        self.settings = settings
        self.size = max(24, min(128, int(size)))
        self.previous = settings.get_int('cursor-size')
        self.applied = False
    def acquire(self):
        if self.previous >= self.size: return
        self.applied = bool(self.settings.set_int('cursor-size', self.size))
    def close(self):
        if self.applied and self.settings.get_int('cursor-size') == self.size:
            self.settings.set_int('cursor-size', self.previous)
        self.applied = False

class CursorGuardian:
    def __init__(self, size):
        self.size = size
        self.process = None
    def set_active(self, active):
        if not active:
            self.close()
        elif self.process is None and self.size and not os.environ.get('PHONEPAD_HFR_ROOT'):
            try:
                self.process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), str(self.size)], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except OSError:
                self.process = None
    def close(self):
        process, self.process = self.process, None
        if process is not None:
            try:
                process.stdin.close()
                process.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):
                process.terminate()

def main():
    from gi.repository import Gio
    settings = Gio.Settings.new('org.gnome.desktop.interface')
    lease = CursorSizeLease(settings, int(sys.argv[1]))
    def finish(*_):
        lease.close()
        Gio.Settings.sync()
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, finish)
    signal.signal(signal.SIGINT, finish)
    try:
        lease.acquire()
        Gio.Settings.sync()
        sys.stdin.buffer.read()
    finally:
        lease.close()
        Gio.Settings.sync()
if __name__ == '__main__': main()
