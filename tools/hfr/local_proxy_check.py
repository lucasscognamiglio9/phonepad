"""Short local verification of the installed preview service, without credentials.

Only loopback, exact browser origin, bounded bodies and a systemd deadline.
Screen media goes to the local browser; only numeric counters are saved.
"""
import http.client, http.server, json, os, pathlib, socket, threading

root=pathlib.Path(os.environ['PHONEPAD_LIVE_CHECK_ROOT'])
if not str(root).startswith('/tmp/phonepad-live-check-'):raise SystemExit('Invalid evidence directory')
root.mkdir(mode=0o700,exist_ok=True)
preview=pathlib.Path(os.environ['XDG_RUNTIME_DIR'])/'phonepad-preview/capture.sock'
page=pathlib.Path(__file__).with_name('webrtc_lab.html').read_bytes()

class UnixConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        self.sock.settimeout(15);self.sock.connect(str(preview))

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(page)
    def do_POST(self):
        if self.headers.get('Origin')!='http://127.0.0.1:8133' or self.headers.get('Host')!='127.0.0.1:8133':
            self.send_error(403);return
        connection=None
        try:
            size=int(self.headers.get('Content-Length',0))
            if not 0<size<=65536:raise ValueError('Invalid request')
            data=json.loads(self.rfile.read(size))
            if data.get('op')=='result':
                (root/'result.json').write_text(json.dumps(data['result'],indent=2)+'\n')
                body=b'{"ok":true}';code=200
                threading.Thread(target=server.shutdown,daemon=True).start()
            else:
                connection=UnixConnection('localhost',timeout=15)
                connection.request('POST','/rtc',json.dumps(data),{'Content-Type':'application/json'})
                response=connection.getresponse();code=response.status;body=response.read(131073)
                if len(body)>131072:raise ValueError('Response too large')
            self.send_response(code);self.end_headers();self.wfile.write(body)
        except Exception:
            self.send_error(503)
        finally:
            if connection:connection.close()
    def log_message(self,*args):pass

server=http.server.ThreadingHTTPServer(('127.0.0.1',8133),Handler)
try:server.serve_forever()
finally:server.server_close()
