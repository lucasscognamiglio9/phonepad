"""Lab-only end-to-end WebRTC check using Phonepad's real encoder/transport."""
import json, pathlib, os, sys, threading, http.server
root=pathlib.Path(os.environ['PHONEPAD_HFR_ROOT'])
if not str(root).startswith('/tmp/phonepad-hfr-') or str(root) not in os.environ.get('DBUS_SESSION_BUS_ADDRESS',''):
    raise RuntimeError('Refusing the primary desktop')
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[2]/'setup/preview'))
import rtc
rtc.Gst.init(None)
from mirror_lab import Mirror
holder={}
class Session(rtc.Session):
    def __init__(self,*args,**kwargs):
        self.mirror=holder['mirror']
        super().__init__(*args,**kwargs)
    def close(self):
        if not getattr(self,'closed',True):self.mirror.close()
        return super().close()
rtc.Session=Session
loop=rtc.GLib.MainLoop();threading.Thread(target=loop.run,daemon=True).start()
process_mode=os.environ.get('PHONEPAD_LAB_PROCESS')=='1'
if process_mode:
    from process_backend import ProcessBackend
    manager=ProcessBackend()
else:
    manager=rtc.Manager(lambda:(holder['source'],1920,1080))
lock=threading.Lock()
worker_exits=[]
page=pathlib.Path(__file__).with_suffix('.html').read_bytes()
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(page)
    def do_POST(self):
        try:
            size=int(self.headers.get('Content-Length','0'))
            if not 0<size<=65536:raise ValueError('invalid body')
            data=json.loads(self.rfile.read(size))
            with lock:
                if data.get('op')=='result':
                    data['result']['workerExits']=worker_exits
                    (root/'result.json').write_text(json.dumps(data['result'],indent=2))
                    (root/'motion.h264').touch()
                    result={'ok':True}
                    threading.Thread(target=server.shutdown,daemon=True).start()
                else:
                    if data.get('op')=='start' and not process_mode:
                        holder['mirror']=Mirror();holder['source']=holder['mirror'].prepare()
                    worker=manager.process if process_mode else None
                    result=manager.handle(data)
                    if data.get('op')=='stop' and worker:
                        worker_exits.append({'pid':worker.pid,'exitCode':worker.poll(),'pipesClosed':worker.stdin.closed and worker.stdout.closed})
                    if data.get('op')=='start' and not process_mode:holder['mirror'].activate()
            body=json.dumps(result).encode();self.send_response(200)
        except Exception as e:
            body=json.dumps({'error':str(e)}).encode();self.send_response(500)
        self.end_headers();self.wfile.write(body)
    def log_message(self,*args):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',8133),Handler)
try:server.serve_forever()
finally:
    if manager.session:manager.dispatch(manager.session.close)
    loop.quit();server.server_close()
