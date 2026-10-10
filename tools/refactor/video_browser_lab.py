"""Synthetic production sender and Chromium/libwebrtc in an isolated network.

No user screen, browser profile, credentials, external route or iPhone is used.
This measures receiver decoding, not physical touch-to-display latency.
"""
import http.server
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

from video_network_profile import Profile, verify_namespace

verify_namespace()
root = Path(os.environ['PHONEPAD_HFR_ROOT'])
if not str(root).startswith('/tmp/phonepad-hfr-network-') or not root.is_dir():
    raise RuntimeError('Refusing a non-laboratory output directory')
sys.path.insert(0, os.environ['PHONEPAD_LAB_PREVIEW_DIR'])
from process_backend import ProcessBackend

profile = Profile()
backend = ProcessBackend(command=[sys.executable, str(Path(__file__).with_name('video_network_sender.py'))])
started = None
samples = []
result = None
lock = threading.Lock()
page = Path(__file__).with_suffix('.html').read_bytes()

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/source-text.png' or self.path in [f'/source-cut-{index}.png' for index in range(6)]:
            image = (root / self.path[1:]).read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'image/png')
            self.end_headers()
            self.wfile.write(image)
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write(page)

    def do_POST(self):
        global started, result
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 2097152:
                raise ValueError('Invalid lab body')
            data = json.loads(self.rfile.read(size))
            with lock:
                if data.get('op') == 'pixels':
                    if data.get('name') not in ('initial','busy','recovery'):
                        raise ValueError('Invalid synthetic sample')
                    image = base64.b64decode(data['png'], validate=True)
                    if len(image) > 1048576 or not image.startswith(b'\x89PNG\r\n\x1a\n'):
                        raise ValueError('Invalid synthetic PNG')
                    (root / (data['name'] + '-text.png')).write_bytes(image)
                    output = {'ok': True}
                elif data.get('op') == 'result':
                    result = {**data['result'], 'samples': samples,
                              'scope': 'Synthetic VA sender and Chromium/libwebrtc receiver; no iPhone or physical presentation measurement',
                              'scenario': os.environ.get('PHONEPAD_LAB_NETWORK_SCENARIO', 'impairments')}
                    output = {'ok': True}
                else:
                    stage = profile.tick(time.monotonic() - started) if started else 'clean'
                    output = backend.handle(data)
                    if data.get('op') == 'answer':
                        started = time.monotonic()
                    if data.get('op') == 'feedback':
                        # Do not save SDP, ICE addresses or desktop pixels.
                        samples.append({'elapsed': round(time.monotonic() - started, 3),
                                        'testStage': stage, 'receiver': data.get('receiver'),
                                        'sender': {key: value for key, value in output.items()
                                                   if key != 'freshness'}})
            body = json.dumps(output).encode()
            self.send_response(200)
        except Exception as failure:
            body = json.dumps({'error': str(failure)}).encode()
            self.send_response(500)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
# Chromium must use system libraries, not the private GStreamer/VA library path.
chrome_env = {key: value for key, value in os.environ.items()
              if key not in ('LD_LIBRARY_PATH', 'GI_TYPELIB_PATH', 'GST_PLUGIN_PATH', 'GST_REGISTRY')}
seconds = int(os.environ.get('PHONEPAD_LAB_RECEIVER_SECONDS', '60'))
chrome = None
try:
    with (root / 'chrome.log').open('w') as log:
        chrome = subprocess.Popen([
            '/usr/bin/google-chrome', '--headless=new', '--no-sandbox',
            '--no-first-run', '--disable-background-networking',
            '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
            '--user-data-dir=' + str(root / 'chrome-profile'),
            f'http://127.0.0.1:{server.server_port}/?seconds={seconds}&scenario=' + os.environ.get('PHONEPAD_LAB_NETWORK_SCENARIO', 'impairments'),
        ], env=chrome_env, stdout=log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + seconds + 25
        while result is None and time.monotonic() < deadline and chrome.poll() is None:
            time.sleep(.2)
    if result is None:
        raise RuntimeError('Chromium receiver did not complete')
    if result.get('error'):
        raise RuntimeError(result['error'])
    decoded = [sample['receiver'] for sample in samples if sample.get('receiver')]
    result['flowPassed'] = (len(decoded) >= seconds - 2 and
                           all(sample.get('width') == 1920 and sample.get('height') == 1080
                               for sample in decoded))
    assert result['flowPassed'] and len(samples) >= seconds - 2
    if result['scenario'] == 'desktop':
        from video_quality_gate import desktop_quality_gate
        result['desktopGate'] = desktop_quality_gate(result)
    if result['scenario'] == 'scene-cut':
        from video_quality_gate import scene_cut_quality_gate
        result['sceneCutGate'] = scene_cut_quality_gate(result)
    print(json.dumps({key: result.get(key) for key in ('flowPassed', 'firstFrameMs', 'receiver', 'offerNack', 'offerRtx', 'scenario')}), flush=True)
finally:
    if chrome:
        chrome.terminate()
        try:
            chrome.wait(timeout=5)
        except subprocess.TimeoutExpired:
            chrome.kill()
            chrome.wait(timeout=5)
    backend.close()
    server.shutdown()
    server.server_close()
    thread.join(timeout=2)
    (root / 'result.json').write_text(json.dumps(result or {'error': 'incomplete', 'samples': samples}, indent=2))
if result.get('desktopGate', {}).get('passed') is False:
    raise SystemExit('Desktop regression gate failed: ' + ', '.join(result['desktopGate']['failures']))
if result.get('sceneCutGate', {}).get('passed') is False:
    raise SystemExit('Scene change regression gate failed: ' + ', '.join(result['sceneCutGate']['failures']))
