"""Stage a complete, versioned server release without touching running services."""
import argparse
import hashlib
import json
import pathlib
import shutil

parser = argparse.ArgumentParser()
parser.add_argument('--runtime', type=pathlib.Path, required=True)
parser.add_argument('--destination', type=pathlib.Path, required=True)
args = parser.parse_args()
source = pathlib.Path(__file__).resolve().parents[2] / 'setup/preview'
runtime = args.runtime.resolve()
destination = args.destination.resolve()
manifest = json.loads((runtime/'manifest.json').read_text())
expected = {'plugins/libgstva.so', 'lib/libgstva-1.0.so.0.2802.0',
            'lib/libgstcodecparsers-1.0.so.0.2802.0', 'lib/libgstcodecs-1.0.so.0.2802.0'}
if set(manifest['files']) != expected: raise SystemExit('Unexpected runtime manifest')
for name, digest in manifest['files'].items():
    if hashlib.sha256((runtime/name).read_bytes()).hexdigest() != digest:
        raise SystemExit('Runtime checksum failed: ' + name)
destination.mkdir(parents=True, exist_ok=False)
for name in ('capture.py', 'rtc.py', 'rate_control.py', 'virtual_source.py', 'process_backend.py', 'hfr_runtime.py', 'hfr_worker.py', 'power_lease.py', 'cursor_capture.py', 'media_contract.py'):
    shutil.copyfile(source/name, destination/name)
shutil.copytree(runtime, destination/'hfr', symlinks=True)
hashes = {str(p.relative_to(destination)):hashlib.sha256(p.read_bytes()).hexdigest()
          for p in destination.rglob('*') if p.is_file()}
(destination/'release.json').write_text(json.dumps({'files':hashes,'mode':'hfr','targetHz':120}, indent=2)+'\n')
print(destination)
