#!/usr/bin/env python3
"""Build the real-time capture adapter with public GStreamer headers."""
import argparse
import os
from pathlib import Path
import shlex
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    flags = shlex.split(subprocess.check_output(
        ['pkg-config', '--cflags', '--libs', 'gstreamer-base-1.0'], text=True))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([
        os.environ.get('CC', 'cc'), '-std=gnu11', '-O2', '-Wall', '-Wextra',
        '-Werror', '-shared', '-fPIC',
        str(Path(__file__).parent / 'preview/live_capture.c'),
        *flags, '-o', str(args.output),
    ], check=True)


if __name__ == '__main__':
    main()
