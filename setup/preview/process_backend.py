"""Bounded local RPC to an encoder worker; no frames cross Python IPC."""
import json, os, pathlib, select, subprocess, sys, threading, time
class ProcessBackend:
    def __init__(self, command=None, cursor_grant=None):
        self.command=command or [sys.executable,str(pathlib.Path(__file__).with_name('hfr_runtime.py'))]
        self.cursor_grant=cursor_grant
        self.process=None
        self.id=None
        self.lock=threading.RLock()
        self.pending=b''
    @property
    def session(self):
        return self if self.process and self.process.poll() is None else None
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
        return value['result']
    def handle(self,data):
        if not isinstance(data,dict):raise ValueError('Invalid request')
        op=data.get('op')
        if op not in ('start','answer','feedback','suspend','resume','stop','diagnostic'):
            raise ValueError('Invalid operation')
        # Reject malformed input before replacing a currently working session.
        if len(json.dumps(data,allow_nan=False).encode())>65535:raise ValueError('Request too large')
        if op=='start':
            if data.get('codec','H264')!='H264':raise ValueError('HFR requires H264')
            width=data.get('width',1920)
            if type(width) is not int or not 320<=width<=1920:raise ValueError('Invalid width')
        with self.lock:
            if op=='start':
                self.close()
                fd=None
                env=os.environ.copy()
                env.pop('PHONEPAD_CURSOR_FD',None)
                env.pop('PHONEPAD_CURSOR_NODE',None)
                try:
                    if self.cursor_grant:
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
                raise
    def _reap(self):
        proc,self.process=self.process,None
        self.id=None;self.pending=b''
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
