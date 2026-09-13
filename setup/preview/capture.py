#!/usr/bin/python3
"""On-demand PipeWire preview. Unix socket only; Phonepad handles authorization."""
import gi,os,json,time,threading,socketserver,http.server,queue
from pathlib import Path
gi.require_version('Gst','1.0')
from gi.repository import Gio,GLib,Gst
Gst.init(None)
ROOT=Path(os.environ.get('XDG_RUNTIME_DIR','/tmp'))/'phonepad-preview'
ROOT.mkdir(mode=0o700,exist_ok=True)
SOCKET=ROOT/'capture.sock'
CONFIG=Path(os.environ.get('XDG_CONFIG_HOME',str(Path.home()/'.config')))/'phonepad'
CONFIG.mkdir(mode=0o700,parents=True,exist_ok=True)
TOKEN=CONFIG/'capture-restore.json'
lock=threading.Lock();frame=None;stamp=0;last_request=0;state='idle';pipeline=None;session=None;remote_fd=None;stream_info=None;active_stream=None
bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
DEST='org.freedesktop.portal.Desktop';PATH='/org/freedesktop/portal/desktop';IFACE='org.freedesktop.portal.ScreenCast'
def status(value):
 global state
 with lock:state=value
 print(value,flush=True)
def request(method,args,callback):
 # Subscribe before invoking: a restored request can respond immediately.
 token='pp'+str(time.monotonic_ns())
 options=args[-1];options['handle_token']=GLib.Variant('s',token)
 sender=bus.get_unique_name()[1:].replace('.','_')
 path='/org/freedesktop/portal/desktop/request/'+sender+'/'+token
 def result(conn,sender,path,iface,signal,params):
  bus.signal_unsubscribe(sub)
  code,values=params.unpack()
  if code:status('permission-required');return
  callback(values)
 sub=bus.signal_subscribe(DEST,'org.freedesktop.portal.Request','Response',path,None,Gio.DBusSignalFlags.NONE,result)
 signatures={'CreateSession':'(a{sv})','SelectSources':'(oa{sv})','Start':'(osa{sv})'}
 try:bus.call_sync(DEST,PATH,IFACE,method,GLib.Variant(signatures[method],tuple(args)),None,Gio.DBusCallFlags.NONE,10000,None)
 except Exception as e:bus.signal_unsubscribe(sub);status('capture-error');print(str(e),flush=True)
def begin():
 status('selecting-screen')
 request('CreateSession',[{'session_handle_token':GLib.Variant('s','pps'+str(time.monotonic_ns()))}],created)
 return False
def created(values):
 global session
 session=values['session_handle']
 opts={'types':GLib.Variant('u',1),'multiple':GLib.Variant('b',False),'cursor_mode':GLib.Variant('u',2),'persist_mode':GLib.Variant('u',2)}
 try:opts['restore_token']=GLib.Variant('s',json.loads(TOKEN.read_text())['token'])
 except (OSError,ValueError,KeyError):pass
 request('SelectSources',[session,opts],lambda _:request('Start',[session,'',{}],started))
def started(values):
 global remote_fd,stream_info
 try:
  node,props=values['streams'][0]
  if 'restore_token' in values:
   temp=TOKEN.with_suffix('.tmp');temp.write_text(json.dumps({'token':values['restore_token']}));temp.chmod(0o600);temp.replace(TOKEN)
  reply,fds=bus.call_with_unix_fd_list_sync(DEST,PATH,IFACE,'OpenPipeWireRemote',GLib.Variant('(oa{sv})',(session,{})),None,Gio.DBusCallFlags.NONE,10000,None,None)
  remote_fd=fds.get(reply.unpack()[0])
  w,h=props.get('size',(1920,1080));scale=min(1,1920/w,1080/h)
  width=max(2,int(w*scale)//2*2);height=max(2,int(h*scale)//2*2)
  stream_info=(node,width,height);status('ready')
 except Exception as e:status('capture-error');print(str(e),flush=True)
class Stream:
 def __init__(self):self.q=queue.Queue(maxsize=12);self.done=threading.Event()
def encode(s):
 global pipeline,active_stream
 if rtc_manager and rtc_manager.session:rtc_manager.session.close()
 if active_stream:active_stream.done.set()
 if pipeline:pipeline.set_state(Gst.State.NULL)
 active_stream=s
 try:
  node,w,h=stream_info
  pipeline=Gst.parse_launch(f'pipewiresrc name=mse_source fd={remote_fd} path={node} do-timestamp=true ! queue max-size-buffers=1 leaky=downstream ! vaapipostproc ! video/x-raw(memory:VASurface),format=NV12,width=[2,1920],height=[2,1080] ! vaapih264enc rate-control=vbr bitrate=6000 max-bframes=0 keyframe-period=30 quality-level=5 ! video/x-h264,profile=constrained-baseline ! h264parse config-interval=-1 ! mp4mux fragment-duration=100 streamable=true ! appsink name=frames emit-signals=true max-buffers=2 drop=false sync=false')
  def sample(sink):
   sample=sink.emit('pull-sample');buf=sample.get_buffer()
   if s.done.is_set():return Gst.FlowReturn.FLUSHING
   try:s.q.put_nowait(buf.extract_dup(0,buf.get_size()))
   except queue.Full:s.done.set()
   return Gst.FlowReturn.OK
  pipeline.get_by_name('frames').connect('new-sample',sample)
  def error(bus,msg):
   err,_=msg.parse_error();print(str(err),flush=True);status('capture-error');s.done.set()
  b=pipeline.get_bus();b.add_signal_watch();b.connect('message::error',error)
  pipeline.set_state(Gst.State.PLAYING);status('live')
 except Exception as e:print(str(e),flush=True);status('capture-error');s.done.set()
 return False
def stop_stream(s):
 global pipeline,active_stream
 if active_stream is s:
  if pipeline:pipeline.set_state(Gst.State.NULL);pipeline=None
  active_stream=None
  if state!='capture-error':status('ready')
 return False
def rtc_source():
 if not stream_info:raise RuntimeError('screen unavailable')
 if active_stream:
  active_stream.done.set();stop_stream(active_stream)
 node,w,h=stream_info
 return f'pipewiresrc name=capture fd={remote_fd} path={node} do-timestamp=true',w,h
def rtc_cursor_grant():
 # A new portal-authorized connection for each worker, restricted to the
 # already selected screen. The worker never reads portal credentials.
 if not stream_info or not session:raise RuntimeError('screen unavailable')
 reply,fds=bus.call_with_unix_fd_list_sync(DEST,PATH,IFACE,'OpenPipeWireRemote',GLib.Variant('(oa{sv})',(session,{})),None,Gio.DBusCallFlags.NONE,10000,None,None)
 return fds.get(reply.unpack()[0]),stream_info[0]
try:
 from rtc import Manager
 if os.environ.get('PHONEPAD_VIDEO_MODE')=='hfr':
  from process_backend import ProcessBackend
  rtc_manager=ProcessBackend(cursor_grant=rtc_cursor_grant)
 else:rtc_manager=Manager(rtc_source)
except (ImportError,ValueError):rtc_manager=None
class Handler(http.server.BaseHTTPRequestHandler):
 def do_POST(self):
  if self.path!='/rtc' or rtc_manager is None:self.send_error(503);return
  try:
   size=int(self.headers.get('Content-Length','0'))
   if not 0<size<=65536:raise ValueError('invalid body')
   data=json.loads(self.rfile.read(size))
   if not isinstance(data,dict):raise ValueError('invalid body')
   result=rtc_manager.handle(data);code=200
  except (ValueError,TypeError):result={'error':'invalid request'};code=400
  except Exception as e:print(str(e),flush=True);result={'error':'WebRTC unavailable'};code=503
  body=json.dumps(result).encode()
  self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)

 def do_GET(self):
  global state
  if self.path=='/status':
   with lock:
    current=state
    if current=='idle':state='selecting-screen';GLib.idle_add(begin)
   body=json.dumps({'state':current,'webrtc':rtc_manager is not None,'codec':'h264-vaapi','maxResolution':'1920x1080','bitrateKbps':6000}).encode()
   self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body);return
  if self.path!='/video':self.send_error(404);return
  if not stream_info:self.send_error(503);return
  s=Stream();GLib.idle_add(encode,s)
  self.connection.settimeout(5)
  self.send_response(200);self.send_header('Content-Type','video/mp4');self.send_header('Cache-Control','no-store');self.end_headers()
  try:
   while not s.done.is_set():
    try:data=s.q.get(timeout=1)
    except queue.Empty:continue
    self.wfile.write(data);self.wfile.flush()
  except (BrokenPipeError,ConnectionResetError,TimeoutError):pass
  finally:s.done.set();GLib.idle_add(stop_stream,s)
 def log_message(self,*args):pass
class Server(socketserver.ThreadingMixIn,socketserver.UnixStreamServer):daemon_threads=True
try:SOCKET.unlink()
except FileNotFoundError:pass
server=Server(str(SOCKET),Handler);SOCKET.chmod(0o600)
threading.Thread(target=server.serve_forever,daemon=True).start()
try:GLib.MainLoop().run()
finally:
 if rtc_manager and rtc_manager.session:rtc_manager.dispatch(rtc_manager.session.close)
 if pipeline:pipeline.set_state(Gst.State.NULL)
 server.server_close();SOCKET.unlink(missing_ok=True)
