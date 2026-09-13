"""Temporary GNOME virtual mirror; never changes persistent monitor configuration."""
import os,threading,time
import gi
from gi.repository import Gio,GLib

SC='org.gnome.Mutter.ScreenCast'
DC='org.gnome.Mutter.DisplayConfig'

def layout(state):
    modes={m[0][0]:next(v[0] for v in m[1] if v[6].get('is-current'))
           for m in state[1] if any(v[6].get('is-current') for v in m[1])}
    return [(v[0],v[1],v[2],v[3],v[4],[(m[0],modes[m[0]],{}) for m in v[5]]) for v in state[2]]

class Mirror:
    def __init__(self):
        lab = os.environ.get('PHONEPAD_HFR_ROOT', '')
        isolated = lab.startswith('/tmp/phonepad-hfr-') and lab in os.environ.get('DBUS_SESSION_BUS_ADDRESS', '')
        if not isolated and os.environ.get('PHONEPAD_VIRTUAL_MIRROR') != '1':
            raise RuntimeError('Virtual mirror is not enabled')
        self.bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
        self.session=None;self.subscription=None;self.connector=None;self.node=None
        self.closed=False;self.added=threading.Event()
        self.original=self.state();self.original_layout=layout(self.original)
        # Preserve complex/external monitor layouts via the existing portal path.
        if len(self.original_layout)!=1 or len(self.original_layout[0][5])!=1:
            raise RuntimeError('mirror requires one active monitor')
        primary=self.original_layout[0][5][0][0]
        monitor=next(m for m in self.original[1] if m[0][0]==primary)
        mode=next(v for v in monitor[1] if v[6].get('is-current'))
        if mode[1:3]!=(1920,1080) and list(mode[1:3])!=[1920,1080]:
            raise RuntimeError('mirror requires native 1080p')
        self.known={m[0][0] for m in self.original[1]}

    def call(self,dest,path,iface,method,args=None):
        return self.bus.call_sync(dest,path,iface,method,args,None,Gio.DBusCallFlags.NONE,5000,None)

    def state(self):
        return self.call(DC,'/org/gnome/Mutter/DisplayConfig',DC,'GetCurrentState').unpack()

    def apply(self,configuration,method=1):
        state=self.state()
        props={'layout-mode':GLib.Variant('u',state[3]['layout-mode'])} if 'layout-mode' in state[3] else {}
        self.call(DC,'/org/gnome/Mutter/DisplayConfig',DC,'ApplyMonitorsConfig',
                  GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})',(state[0],method,configuration,props)))

    def prepare(self):
        self.session=self.call(SC,'/org/gnome/Mutter/ScreenCast',SC,'CreateSession',GLib.Variant('(a{sv})',({},))).unpack()[0]
        modes=[{'size':GLib.Variant('(uu)',(1920,1080)),'refresh-rate':GLib.Variant('d',float(os.environ.get('PHONEPAD_MIRROR_HZ','120'))),'is-preferred':GLib.Variant('b',True)}]
        stream=self.call(SC,self.session,SC+'.Session','RecordVirtual',
             GLib.Variant('(a{sv})',({'cursor-mode':GLib.Variant('u',1),'modes':GLib.Variant('aa{sv}',modes)},))).unpack()[0]
        def added(*args):self.node=args[-1].unpack()[0];self.added.set()
        self.subscription=self.bus.signal_subscribe(SC,SC+'.Stream','PipeWireStreamAdded',stream,None,Gio.DBusSignalFlags.NONE,added)
        self.call(SC,self.session,SC+'.Session','Start')
        if not self.added.wait(5):raise RuntimeError('virtual stream timeout')
        return f'pipewiresrc name=capture path={self.node} do-timestamp=true ! video/x-raw(memory:DMABuf)'

    def activate(self):
        # The virtual monitor appears once PipeWire negotiates its first buffers.
        for _ in range(50):
            current=self.state()
            new=[m for m in current[1] if m[0][0] not in self.known]
            if new:break
            time.sleep(.05)
        else:raise RuntimeError('virtual monitor timeout')
        if len(new)!=1:raise RuntimeError('monitor configuration changed')
        monitor=new[0];self.connector=monitor[0][0]
        preferred=next(v for v in monitor[1] if v[6].get('is-preferred'))
        target=[(v[0],v[1],v[2],v[3],v[4],list(v[5])) for v in self.original_layout]
        target[0][5].append((self.connector,preferred[0],{}))
        self.apply(target,0);self.apply(target,1)

    def close(self):
        if self.closed:return
        self.closed=True
        if self.subscription:self.bus.signal_unsubscribe(self.subscription)
        if self.session:
            self.call(SC,self.session,SC+'.Session','Stop')
        for _ in range(40):
            if layout(self.state()) == self.original_layout: break
            time.sleep(.05)
        else: raise RuntimeError('Monitor layout did not restore after stopping the stream')
        print('mirror restored automatically=True', flush=True)
