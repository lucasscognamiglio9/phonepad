#!/usr/bin/env python3
"""Build the metadata reader against public PipeWire headers; no system installation."""
import argparse, os, subprocess
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--headers-root',type=Path);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
if a.headers_root:
 flags=['-I'+str(a.headers_root/'include/pipewire-0.3'),'-I'+str(a.headers_root/'include/spa-0.2'),'-l:libpipewire-0.3.so.0']
else:flags=subprocess.check_output(['pkg-config','--cflags','--libs','libpipewire-0.3'],text=True).split()
a.output.parent.mkdir(parents=True,exist_ok=True)
subprocess.run([os.environ.get('CC','cc'),'-std=gnu11','-O2','-Wall','-Wextra','-Werror',str(Path(__file__).parent/'preview/cursor_metadata.c'),*flags,'-o',str(a.output)],check=True)
