"""Run the native cursor fixture inside a disposable, shaped network namespace."""
import os
from pathlib import Path
import tempfile
import subprocess
import sys
from video_network_profile import command, verify_namespace

repo = Path(__file__).resolve().parents[2]
if os.environ.get('PHONEPAD_LAB_NETWORK') == '1':
    verify_namespace()
    command('ip', 'link', 'set', 'lo', 'up')
    command('ip', 'link', 'add', 'pp-cursor', 'type', 'dummy')
    command('ip', 'addr', 'add', '198.18.0.1/24', 'dev', 'pp-cursor')
    command('ip', 'link', 'set', 'pp-cursor', 'up')
    os.execv('/usr/bin/python3', ['/usr/bin/python3', str(repo / 'tools/hfr/isolated.py')])

env = os.environ.copy()
env.update(PHONEPAD_LAB_NETWORK='1', PHONEPAD_PARENT_NET=os.readlink('/proc/self/ns/net'),
           PHONEPAD_LAB_CURSOR='1', PHONEPAD_LAB_RECEIVER_SECONDS='42',
           PHONEPAD_LAB_SECONDS='65')
log = env.get('PHONEPAD_LAB_LOG') or str(Path(tempfile.mkdtemp(prefix='phonepad-cursor-log-')) / 'run.log')
with open(log, 'w') as output:
    result = subprocess.run(['unshare', '--user', '--map-root-user', '--net', sys.executable, __file__],
                            env=env, stdout=output, stderr=subprocess.STDOUT, timeout=95)
print('Native cursor network log: ' + log, flush=True)
raise SystemExit(result.returncode)
