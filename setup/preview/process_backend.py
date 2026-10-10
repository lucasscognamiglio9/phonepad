"""Bounded local RPC to an encoder worker; no frames cross Python IPC."""
import json, os, pathlib, select, subprocess, sys, threading, time
from media_contract import MediaContractError, requested_codecs, unknown_media, validate_media
class ProcessBackend:
    def __init__(self, command=None, cursor_grant=None):
        self.command=command or [sys.executable,str(pathlib.Path(__file__).with_name('hfr_runtime.py'))]
        self.cursor_grant=cursor_grant
        self.process=None
        self.id=None
        self.lock=threading.RLock()
        self.pending=b''
        self._closing_event=threading.Event()
        self._shutdown_lock=threading.Lock()
        self._shutdown_started=False
        self._shutdown_done=threading.Event()
        self._shutdown_error=None
        # The parent cannot infer the HFR worker's factories or source
        # generation. It remains unknown until a worker response proves it.
        self.media=unknown_media(source_reason='worker_not_started', geometry_reason='worker_not_started', video_reason='worker_not_started')
    @property
    def session(self):
        return self if self.process and self.process.poll() is None else None
    def media_snapshot(self):
        if not self.process or self.process.poll() is not None:
            return unknown_media(source_reason='worker_not_started', geometry_reason='worker_not_started', video_reason='worker_not_started')
        return validate_media(self.media)
    def dispatch(self,action):return action()
    def _exchange(self,data,timeout):
        payload=json.dumps(data,separators=(',',':'),allow_nan=False).encode()+b'\n'
        if len(payload)>65536:raise ValueError('Request too large')
        proc=self.process
        if not proc or proc.poll() is not None:raise ValueError('Session unavailable')
        # Communicating over two local pipes; bounded response, bounded wait.
        end=time.monotonic()+timeout
        view=memoryview(payload)
        while view:
            remaining=end-time.monotonic()
            if remaining<=0 or not select.select([], [proc.stdin], [], remaining)[1]:
                raise TimeoutError('HFR request timeout')
            try:view=view[os.write(proc.stdin.fileno(),view):]
            except BlockingIOError:continue
        while b'\n' not in self.pending:
            remaining=end-time.monotonic()
            if remaining<=0 or not select.select([proc.stdout],[],[],remaining)[0]:
                raise TimeoutError('HFR worker timeout')
            chunk=os.read(proc.stdout.fileno(),8192)
            if not chunk:raise RuntimeError('HFR worker exited')
            self.pending+=chunk
            if len(self.pending)>131072:raise RuntimeError('Oversized worker response')
        line,self.pending=self.pending.split(b'\n',1)
        value=json.loads(line)
        if 'error' in value:
            raise (ValueError if value.get('invalid') else RuntimeError)(value['error'])
        if isinstance(value.get('result'),dict) and 'media' in value['result']:
            try:
                media=validate_media(value['result']['media'])
                if media['source']['state']=='available' and media['source'].get('kind')!='hfr-worker':
                    raise MediaContractError('worker source kind mismatch')
                self.media=media
            except MediaContractError as error:
                self.media=unknown_media(source_reason='worker_metadata_invalid', geometry_reason='worker_metadata_invalid', video_reason='worker_metadata_invalid')
                raise ValueError('invalid worker media') from error
        return value['result']
    def handle(self,data):
        if not isinstance(data,dict):raise ValueError('Invalid request')
        op=data.get('op')
        if op not in ('start','answer','feedback','suspend','resume','stop','diagnostic'):
            raise ValueError('Invalid operation')
        # Reject malformed input before replacing a currently working session.
        if len(json.dumps(data,allow_nan=False).encode())>65535:raise ValueError('Request too large')
        if self._closing_event.is_set() and op!='stop':
            raise ValueError('backend closing')
        if op=='start':
            if data.get('cursorMode') == 'metadata' and not pathlib.Path(__file__).with_name('phonepad-cursor-metadata').is_file():
                data = {**data, 'cursorMode': 'embedded'}
            preferences=requested_codecs(data)
            if any(codec!='H264' for codec in preferences):raise ValueError('HFR requires H264')
            width=data.get('width',1920)
            if type(width) is not int or not 320<=width<=1920:raise ValueError('Invalid width')
        with self.lock:
            # Recheck after validation and immediately before replacing or
            # using the child. Shutdown may have set the event while this
            # request was waiting between the two critical sections.
            if self._closing_event.is_set() and op!='stop':
                raise ValueError('backend closing')
            if op=='start':
                self.close()
                if self._closing_event.is_set():
                    raise ValueError('backend closing')
                self.media=unknown_media(source_reason='worker_starting', geometry_reason='worker_starting', video_reason='worker_starting')
                fd=None
                env=os.environ.copy()
                env.pop('PHONEPAD_CURSOR_FD',None)
                env.pop('PHONEPAD_CURSOR_NODE',None)
                try:
                    if self.cursor_grant and data.get('cursorMode') != 'metadata':
                        fd,node=self.cursor_grant()
                        env.update(PHONEPAD_CURSOR_FD=str(fd),PHONEPAD_CURSOR_NODE=str(node))
                    self.process=subprocess.Popen(self.command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,
                                                  bufsize=0,env=env,pass_fds=(() if fd is None else (fd,)))
                finally:
                    # The worker owns its inherited copy. Never reuse a connected
                    # PipeWire socket across independent encoder processes.
                    if fd is not None:os.close(fd)
                os.set_blocking(self.process.stdin.fileno(),False)
                self.pending=b''
            try:
                result=self._exchange(data,12 if op=='start' else 5)
                if op=='start':self.id=result['id']
                if op=='stop':self._reap()
                return result
            except ValueError:
                if op=='start' or (self.process and self.process.poll() is not None):self._reap()
                raise
            except Exception:
                self._reap()
                if op == 'start' and data.get('cursorMode') == 'metadata':
                    result = self.handle({**data, 'cursorMode': 'embedded'})
                    result['cursorMode'] = 'embedded'
                    result['cursorFallback'] = 'metadata_unavailable'
                    return result
                raise
    def _reap(self):
        proc,self.process=self.process,None
        self.id=None;self.pending=b''
        self.media=unknown_media(source_reason='worker_not_started', geometry_reason='worker_not_started', video_reason='worker_not_started')
        if not proc:return
        proc.stdin.close()
        try:proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.terminate()
            try:proc.wait(timeout=2)
            except subprocess.TimeoutExpired:proc.kill();proc.wait(timeout=2)
        proc.stdout.close()
        print('rtc worker exit='+str(proc.returncode),file=sys.stderr,flush=True)
    def close(self):
        with self.lock:
            if self.process and self.id and self.process.poll() is None:
                try:self._exchange({'op':'stop','id':self.id},3)
                except Exception:pass
            self._reap()
        return False

    def shutdown(self, timeout=5):
        """Stop the worker with bounded waits and reject future sessions."""
        # Admission closes before taking the RPC lock. A request already
        # inside a bounded exchange may finish in the cleanup thread, but no
        # new start can pass the second check in handle().
        self._closing_event.set()
        with self._shutdown_lock:
            start = not self._shutdown_started
            self._shutdown_started=True
            done=self._shutdown_done
        if start:
            threading.Thread(target=self._shutdown_worker, name='phonepad-hfr-shutdown', daemon=True).start()
        if not done.wait(timeout):
            raise TimeoutError('HFR shutdown timed out')
        if self._shutdown_error is not None:
            raise self._shutdown_error
        return True

    def _shutdown_worker(self):
        error=None
        try:
            with self.lock:
                if self.process and self.id and self.process.poll() is None:
                    try:self._exchange({'op':'stop','id':self.id},3)
                    except Exception:pass
                self._reap()
        except Exception as shutdown_error:
            error=shutdown_error
        finally:
            with self._shutdown_lock:
                self._shutdown_error=error
                self._shutdown_done.set()
