"""One native encoder process per session. The parent owns the request pipe."""
import json, os, select, signal, sys, threading, traceback
reply = sys.stdout
sys.stdout = sys.stderr  # Protocol output must never contain GStreamer diagnostics.
import rtc
from virtual_source import Mirror
from power_lease import PowerLease
from cursor_capture import EmbeddedCursor
rtc.Gst.init(None)
if os.environ.get('PHONEPAD_ENCODER')!='va' or rtc.Gst.ElementFactory.find('vah264enc') is None:
    raise RuntimeError('HFR requires the modern VA hardware encoder runtime')
loop=rtc.GLib.MainLoop()
threading.Thread(target=loop.run,daemon=True).start()
mirror=None
cursor=None
source=None
stopping=False
class Session(rtc.Session):
    def close(self):
        # Stop the producer while the PipeWire consumer is still alive. Mutter
        # removes its virtual monitor and restores the original layout itself.
        if not getattr(self,'closed',True) and mirror:
            mirror.close()
        return super().close()
rtc.Session=Session
manager=rtc.Manager(lambda:(source,1920,1080))
def terminate(*_):
    global stopping
    stopping=True
signal.signal(signal.SIGTERM,terminate)
signal.signal(signal.SIGINT,terminate)
started=False
power=PowerLease()
exit_status=0
try:
    while not stopping:
        if started and (manager.session is None or manager.session.closed):break
        if not select.select([sys.stdin],[],[],.2)[0]:continue
        line=sys.stdin.buffer.readline(65538)
        if not line:break
        try:
            if len(line)>65536 or not line.endswith(b'\n'):raise ValueError('Invalid request size')
            data=json.loads(line)
            if not isinstance(data,dict):raise ValueError('Invalid request')
            if data.get('op')=='start':
                if started:raise ValueError('Only one session per worker')
                if data.get('codec','H264')!='H264':raise ValueError('HFR requires H264')
                if not os.environ.get('PHONEPAD_HFR_ROOT'):power.set_active(True)
                mirror=Mirror();source=mirror.prepare()
            result=manager.handle(data)
            if data.get('op')=='resume':
                if not os.environ.get('PHONEPAD_HFR_ROOT'):power.set_active(True)
                if cursor:cursor.set_active(True)
            if data.get('op')=='suspend':
                power.set_active(False)
                if cursor:cursor.set_active(False)
            if data.get('op')=='feedback' and not os.environ.get('PHONEPAD_HFR_ROOT'):power.refresh()
            if data.get('op')=='start':
                mirror.activate();started=True
                if 'PHONEPAD_CURSOR_FD' in os.environ:
                    source_caps=manager.session.pipeline.get_by_name('capture').get_static_pad('src').get_current_caps()
                    cursor=EmbeddedCursor(int(os.environ['PHONEPAD_CURSOR_FD']),int(os.environ['PHONEPAD_CURSOR_NODE']),source_caps)
                    try:cursor.start()
                    except Exception as error:print('cursor capture unavailable:',str(error),flush=True)
            if cursor and data.get('op') in ('start','feedback','suspend','resume'):
                result['cursor']=cursor.snapshot()
            output={'result':result}
        except Exception as error:
            output={'error':str(error),'invalid':isinstance(error,ValueError)}
            if not started:stopping=True
        reply.write(json.dumps(output,separators=(',',':'))+'\n');reply.flush()
except BaseException:
    exit_status=1
    traceback.print_exc()
finally:
    if manager.session and not manager.session.closed:
        try:manager.dispatch(manager.session.close)
        except Exception as error:
            exit_status=1;print('HFR shutdown:',str(error),flush=True)
    elif mirror and not mirror.closed:
        try:mirror.close()
        except Exception as error:
            exit_status=1;print('HFR source shutdown:',str(error),flush=True)
    loop.quit()
    power.close()
    if cursor:cursor.release_connection()
    # All desktop/power state has been restored. Like multiprocessing workers,
    # exit without running third-party Gst destructors a second time: the OS
    # closes this process's PipeWire sockets, GPU handles and threads together.
    sys.stderr.flush()
    os._exit(exit_status)
