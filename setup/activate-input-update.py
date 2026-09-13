#!/usr/bin/env python3
"""Install a verified gateway candidate, preserving the video service and a rollback."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

release = Path(sys.argv[1]).resolve()
expected_parent = Path(__file__).resolve().parents[3] / 'outputs'
if release.parent != expected_parent or release.name != 'phonepad-plus-update':
    raise SystemExit('Unexpected release directory')

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

source = release / 'gateway/phonepad'
checks = json.loads((release / 'gateway/checks.json').read_text())
if checks.get('tests') != 'passed' or digest(source) != checks['sha256']:
    raise SystemExit('Unverified candidate')
target = Path.home() / '.local/bin/phonepad'
previous = release / 'gateway/previous/phonepad'
previous.parent.mkdir(parents=True, exist_ok=True)
before = digest(target)
if not previous.exists():
    shutil.copy2(target, previous)
elif digest(previous) != before and before != checks['sha256']:
    raise SystemExit('Existing backup differs from installed binary')

def install(path):
    temporary = target.with_name('phonepad.input-update')
    shutil.copyfile(path, temporary)
    temporary.chmod(0o755)
    os.replace(temporary, target)

def restart():
    subprocess.run(['systemctl', '--user', 'restart', 'phonepad.service'], check=True, timeout=25)

def status(path):
    request = urllib.request.Request('http://127.0.0.1:8081' + path,
                                     headers={'Host': 'luque-thinkpad-t490.tail27a66d.ts.net'})
    try:
        with urllib.request.urlopen(request, timeout=2) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code

try:
    install(source)
    restart()
    for attempt in range(20):
        try:
            if status('/api/auth') == 401 and status('/qr.svg') == 403:
                break
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(.25)
    else:
        raise RuntimeError('Gateway readiness/authentication guard failed')
    subprocess.run(['systemctl', '--user', 'is-active', '--quiet', 'phonepad.service'], check=True)
except BaseException:
    install(previous)
    restart()
    raise

result = {'installedSHA256': digest(target), 'previousSHA256': digest(previous),
          'authStatus': 401, 'pairingRouteStatus': 403, 'service': 'active',
          'previewServiceChanged': False}
(release / 'gateway/activation.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
