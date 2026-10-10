"""Shape only a disposable network namespace for real WebRTC video tests.

Never changes a host interface, Tailscale, firewall or user connection. Both
native sender and receiver use the private namespace; Unix capture/control
sockets stay on the isolated compositor. Rates constrain aggregate loopback
traffic, so they are test conditions rather than one-way link measurements.
"""
import json, math, os
from pathlib import Path
import subprocess, sys, time, tempfile

STAGES = [(0,'clean',[]), (6,'jitter',['delay','20ms','10ms','distribution','normal','seed','42']),
          (12,'loss',['loss','10%','seed','42']),
          (18,'capacity',['rate','2mbit','limit','64']), (26,'recovery',[])]

def stages():
    scenario=os.environ.get('PHONEPAD_LAB_NETWORK_SCENARIO','impairments')
    if scenario=='desktop':
        # A loss-free but variable-delay path and alternating sparse/busy
        # desktop updates. Constant motion alone misses application-limited
        # bandwidth estimates and recovery after an idle desktop.
        return [(0,'clean',[]), (6,'desktop',['delay','20ms','5ms','distribution','normal','seed','42']),
                (46,'recovery',[])]
    if scenario=='scene-cut':
        return [(0,'clean',[]), (7,'jitter',['delay','20ms','5ms','distribution','normal','seed','42']), (14,'recovery',[])]
    if scenario=='quality':
        return [(0, 'clean', [])]
    if scenario!='impairments': raise ValueError('Invalid network scenario')
    return STAGES

def command(*args, check=True):
    return subprocess.run(args,check=check,capture_output=True,text=True,timeout=5)

def verify_namespace():
    namespace=os.readlink('/proc/self/ns/net')
    # /proc/1 belongs to the parent user namespace and may be unreadable here.
    # The parent passed its own namespace identity before unshare. Require it.
    parent = os.environ.get('PHONEPAD_PARENT_NET')
    if not parent or namespace == parent or os.environ.get('PHONEPAD_LAB_NETWORK')!='1':
        raise RuntimeError('Refusing network changes outside disposable namespace')

class Profile:
    def __init__(self):
        verify_namespace()
        self.stage=None
        self.previous_packets=None
        self.reference=None
        self.last_pixels=None
        self.stats=[]
    def tick(self,elapsed):
        stage=next(s for s in reversed(stages()) if elapsed>=s[0])
        if stage[1]!=self.stage:
            command('tc','qdisc','del','dev','lo','root',check=False)
            if stage[2]: command('tc','qdisc','add','dev','lo','root','netem',*stage[2])
            self.stage=stage[1]
        return self.stage
    def feedback(self,receiver,Gst):
        promise=Gst.Promise.new()
        receiver.emit('get-stats',None,promise)
        promise.wait()
        reply=promise.get_reply()
        inbound=None
        for i in range(reply.n_fields()):
            value=reply.get_value(reply.nth_field_name(i))
            if isinstance(value,Gst.Structure) and value.has_field('packets-received') and value.has_field('packets-lost'):
                codec=reply.get_value(value.get_value('codec-id')) if value.has_field('codec-id') else None
                if codec is None or codec.get_value('mime-type').lower()!='video/h264': continue
                inbound=value
                break
        if inbound is None: return {'loss':None}
        identity=inbound.get_value('id')
        counters=tuple(int(inbound.get_value(key)) for key in ('packets-received','packets-lost'))
        current=(identity,counters)
        previous=self.previous_packets
        self.previous_packets=current
        received,lost=(tuple(a-b for a,b in zip(counters,previous[1])) if previous and previous[0]==identity else (0,0))
        loss=lost/(received+lost) if received>=0 and lost>=0 and received+lost>0 else None
        return {'loss':loss, 'labReceived':counters[0], 'labLost':counters[1], 'labNacks':inbound.get_value('nack-count') if inbound.has_field('nack-count') else None}
    def observe_pixels(self,buffer,caps):
        structure=caps.get_structure(0)
        width=structure.get_value('width');height=structure.get_value('height')
        data=buffer.extract_dup(0,buffer.get_size())
        stride=((width*3+3)//4)*4
        # Static text above the moving bar. Comparing to decoded clean video
        # measures deterioration/recovery, not fidelity to the source pixels.
        self.last_pixels=b''.join(data[y*stride+20*3:y*stride+(width-20)*3] for y in range(40,min(88,height)))
    def quality(self):
        pixels=self.last_pixels
        if pixels is None: return None
        if self.reference is None and self.stage=='clean': self.reference=pixels
        if self.reference is None or len(self.reference)!=len(pixels): return None
        mse=sum((a-b)**2 for a,b in zip(pixels,self.reference))/len(pixels)
        return {'reference':'first decoded clean text region', 'mse':round(mse,3),
                'psnrDb':round(10*math.log10(255*255/mse),2) if mse else None}

if __name__=='__main__':
    repo=Path(__file__).resolve().parents[2]
    if os.environ.get('PHONEPAD_LAB_NETWORK')=='1':
        verify_namespace()
        command('ip','link','set','lo','up')
        command('ip','link','add','pp-video','type','dummy')
        command('ip','addr','add','198.18.0.1/24','dev','pp-video')
        command('ip','link','set','pp-video','up')
        root=Path(tempfile.mkdtemp(prefix='phonepad-hfr-network-'))
        root.chmod(0o700)
        os.environ['PHONEPAD_HFR_ROOT']=str(root)
        print('Video network evidence: '+str(root),flush=True)
        lab='video_browser_lab.py' if os.environ.get('PHONEPAD_LAB_RECEIVER')=='chromium' else 'p03_gcc_media_lab.py'
        os.execv('/usr/bin/python3',['/usr/bin/python3',str(repo/'tools/hfr/runtime.py'),str(repo/'tools/refactor'/lab)])
    env=os.environ.copy()
    duration={'desktop':'60', 'quality':'18', 'scene-cut':'22'}.get(env.get('PHONEPAD_LAB_NETWORK_SCENARIO'), '42')
    env.update(PHONEPAD_LAB_NETWORK='1',PHONEPAD_PARENT_NET=os.readlink('/proc/self/ns/net'),
               PHONEPAD_LAB_GCC='1',PHONEPAD_LAB_FULL_DURATION='1',PHONEPAD_LAB_RECEIVER_SECONDS=duration,
               PHONEPAD_LAB_SECONDS='85',PHONEPAD_LAB_VIDEO_WIDTH='1920')
    logfile=env.get('PHONEPAD_LAB_LOG') or str(Path(tempfile.mkdtemp(prefix='phonepad-video-log-'))/'run.log')
    with open(logfile,'w') as output:
        result=subprocess.run(['unshare','--user','--map-root-user','--net',sys.executable,__file__],env=env,stdout=output,stderr=subprocess.STDOUT,timeout=110)
    print('Network lab log: '+logfile,flush=True)
    raise SystemExit(result.returncode)
