"""Exercise the production cursor sender on a private Mutter compositor.

Run through tools/hfr/isolated.py with PHONEPAD_LAB_CURSOR=1, or the private
network wrapper. Real PipeWire metadata and ordered/unordered SCTP channels;
this does not measure physical iPhone presentation latency.
"""

import faulthandler
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

faulthandler.enable()
root = Path(os.environ['PHONEPAD_HFR_ROOT'])
if not str(root).startswith('/tmp/phonepad-hfr-') or str(root) not in os.environ.get('DBUS_SESSION_BUS_ADDRESS', ''):
    raise RuntimeError('Private compositor required; never run against the user desktop')
controller_name = os.environ.get('PHONEPAD_RTC_CONTROLLER', 'legacy')
if controller_name not in ('gcc', 'legacy'):
    raise RuntimeError('This experiment requires PHONEPAD_RTC_CONTROLLER=gcc or legacy')
gcc_mode = controller_name == 'gcc'
try:
    receiver_seconds = float(os.environ.get('PHONEPAD_LAB_RECEIVER_SECONDS', '12'))
except (TypeError, ValueError):
    raise RuntimeError('Invalid PHONEPAD_LAB_RECEIVER_SECONDS')
if not 1 <= receiver_seconds <= 60:
    raise RuntimeError('PHONEPAD_LAB_RECEIVER_SECONDS must be 1..60')
full_duration = True
network_profile = None
if os.environ.get('PHONEPAD_LAB_NETWORK') == '1':
    from video_network_profile import Profile
    network_profile = Profile()

preview = Path(os.environ['PHONEPAD_CURSOR_LAB_PREVIEW']).resolve(strict=True)
sys.path.insert(0, str(preview))
from process_backend import ProcessBackend
import gi
for namespace in ('Gst', 'GstWebRTC', 'GstSdp'):
    gi.require_version(namespace, '1.0')
from gi.repository import GLib, Gst, GstSdp, GstWebRTC, Gio

Gst.init(None)
twcc = 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01'
decoder = next((name for name in ('vah264dec', 'vaapih264dec', 'avdec_h264') if Gst.ElementFactory.find(name)), None)
if decoder is None:
    raise RuntimeError('No H264 decoder in the private runtime')

loop = GLib.MainLoop()
loop_thread = threading.Thread(target=loop.run, daemon=True)
loop_thread.start()
pipeline = Gst.Pipeline.new('p03-real-receiver')
receiver = Gst.ElementFactory.make('webrtcbin', 'receiver')
receiver.set_property('bundle-policy', 'max-bundle')
receiver.set_property('latency', 0)
pipeline.add(receiver)
decode = Gst.parse_bin_from_description(
    'rtph264depay ! h264parse ! ' + decoder + ' ! fakesink name=decoded sync=false async=false signal-handoffs=true', True)
pipeline.add(decode)
receiver_feedback = ',rtcp-fb-transport-cc=(boolean)true,extmap-3=(string)' + twcc if gcc_mode else ''
caps = Gst.Caps.from_string(
    'application/x-rtp,media=video,encoding-name=H264,clock-rate=90000,payload=96'
    + receiver_feedback
)
receiver.emit('add-transceiver', GstWebRTC.WebRTCRTPTransceiverDirection.RECVONLY, caps).set_property('do-nack',True)
ready = threading.Event()
result = {'scope': 'production HFR/VA sender and local decoded H264 receiver; no physical presentation measurement',
          'controller': controller_name,
          'receiverDurationRequestedSeconds': receiver_seconds,
          'fullDuration': full_duration,
          'maxFrameAgeMs': os.environ.get('PHONEPAD_MAX_FRAME_AGE_MS', '0'),
          'decoder': decoder, 'decodedBuffers': 0, 'samples': [], 'errors': []}


def checkpoint(stage):
    result['stage'] = stage
    (root / 'progress.json').write_text(json.dumps(result, indent=2))
    print('gcc media lab: ' + stage, flush=True)


def decoded(_sink, _buffer, pad):
    result['decodedBuffers'] += 1
    current = pad.get_current_caps()
    if current:
        result['decodedCaps'] = current.to_string()


def pad_added(_peer, pad):
    if pad.get_direction() == Gst.PadDirection.SRC:
        linked = pad.link(decode.get_static_pad('sink'))
        if linked != Gst.PadLinkReturn.OK:
            result['errors'].append('decode pad link: ' + str(linked))
        decode.sync_state_with_parent()


def error(_bus, message):
    result['errors'].append(str(message.parse_error()[0]))
    ready.set()


def gathered(peer, _property):
    if peer.get_property('ice-gathering-state') == GstWebRTC.WebRTCICEGatheringState.COMPLETE:
        ready.set()


def answered(promise, _data):
    try:
        # GI borrows the boxed answer from the reply structure. Keep that
        # owner alive until set-local-description has copied the SDP.
        reply = promise.get_reply()
        answer = reply.get_value('answer')
        receiver.emit('set-local-description', answer, Gst.Promise.new())
    except Exception as failure:
        result['errors'].append(str(failure))
        ready.set()


def remote_set(_promise, _data):
    receiver.emit('create-answer', None, Gst.Promise.new_with_change_func(answered, None))


decode.get_by_name('decoded').connect('handoff', decoded)
def on_channel(peer, channel):
    result.setdefault('channels', []).append({'label':channel.get_property('label'),'ordered':channel.get_property('ordered'),'lifetimeMs':channel.get_property('max-packet-lifetime')})
    def message(channel,text):
        state=json.loads(text)
        result['cursorPackets']=result.get('cursorPackets',0)+1
        if state.get('t') != 'cursor': return
        result.setdefault('cursorTimeline',[]).append({'at':time.monotonic(), 'sequence':state.get('sequence'), 'x':state.get('x'), 'y':state.get('y'), 'visible':state.get('visible'), 'imageId':state.get('imageId'), 'bitmap': 'image' in state,'capturedAtUs':state.get('capturedAtUs')})
        if 'image' in state:result['cursorBitmapSize']=[state.get('w'),state.get('h')]
    channel.connect('on-message-string',message)
receiver.connect('on-data-channel',on_channel)
receiver.connect('pad-added', pad_added)
receiver.connect('notify::ice-gathering-state', gathered)
bus = pipeline.get_bus()
bus.add_signal_watch()
bus.connect('message::error', error)
backend = ProcessBackend(command=[sys.executable, str(preview / 'hfr_runtime.py')])
worker = None
try:
    checkpoint('receiver starting')
    pipeline.set_state(Gst.State.PLAYING)
    # A private native lease injects exactly paced movement. This exercises the
    # production PipeWire metadata reader and SCTP, not a fabricated cursor.
    connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    def desktop_layout():
        state = connection.call_sync('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
                                     'org.gnome.Mutter.DisplayConfig', 'GetCurrentState', None, None,
                                     Gio.DBusCallFlags.NONE, 1000, None).unpack()
        return {'scale':state[2][0][2], 'logicalMonitors':len(state[2]),
                'mirroredMonitors':len(state[2][0][5]), 'layoutMode':state[3].get('layout-mode')}
    result['initialLayout'] = desktop_layout()
    destination = 'org.gnome.Mutter.RemoteDesktop'
    created = connection.call_sync(destination, '/org/gnome/Mutter/RemoteDesktop', destination, 'CreateSession',
                                   None, GLib.VariantType.new('(o)'), Gio.DBusCallFlags.NONE, 1000, None)
    pointer_path = created.unpack()[0]
    interface = destination + '.Session'
    def native(method, args=None):
        return connection.call_sync(destination,pointer_path,interface,method,args,None,Gio.DBusCallFlags.NONE,1000,None)
    native('Start')
    native('NotifyKeyboardKeysym', GLib.Variant('(ub)', (0xff1b,True)))
    native('NotifyKeyboardKeysym', GLib.Variant('(ub)', (0xff1b,False)))
    native('NotifyPointerMotionRelative', GLib.Variant('(dd)', (-10000.,-10000.)))
    native('NotifyPointerMotionRelative', GLib.Variant('(dd)', (300.,250.)))
    offer = backend.handle({'op': 'start', 'width': 1920, 'codec': 'H264', 'cursorMode':'metadata','cursorDelivery':2})
    worker = backend.process
    result['captureLayout'] = desktop_layout()
    if os.environ.get('PHONEPAD_GO'):
        test_env = os.environ.copy()
        test_env.update(GOPROXY='off', GOSUMDB='off',
                        GOCACHE=os.environ.get('PHONEPAD_GOCACHE',str(root/'go-cache')))
        test = subprocess.run([os.environ['PHONEPAD_GO'], 'test', '-mod=vendor', '-tags=phonepad_lab',
                               '-run', '^TestMutterPredictionContractLab$', './internal/input'],
                              cwd=Path(__file__).resolve().parents[2]/'daemon',env=test_env,
                              capture_output=True,text=True,timeout=30)
        (root/'prediction-go-test.log').write_text(test.stdout+test.stderr)
        assert test.returncode == 0, 'Provider contract failed with capture mirror active'
        result['providerContract'] = json.loads((root/'prediction-contract.json').read_text())
    result['cursorMode']=offer.get('cursorMode');result['cursorInitialSize']=[offer.get('cursorInitial',{}).get(k) for k in ('w','h')];checkpoint('sender offer received')
    result['offerTwcc'] = twcc in offer['sdp'];result['offerNack']='a=rtcp-fb:96 nack' in offer['sdp'];result['offerRtx']='RTX/' in offer['sdp'] or 'rtx/' in offer['sdp']
    parsed, sdp = GstSdp.SDPMessage.new_from_text(offer['sdp'])
    if parsed != GstSdp.SDPResult.OK:
        raise RuntimeError('Invalid production offer')
    receiver.emit('set-remote-description', GstWebRTC.WebRTCSessionDescription.new(
        GstWebRTC.WebRTCSDPType.OFFER, sdp), Gst.Promise.new_with_change_func(remote_set, None))
    checkpoint('receiver gathering answer')
    if not ready.wait(12) or result['errors']:
        raise RuntimeError('Receiver failed to gather a complete answer')
    local_description = receiver.get_property('local-description')
    answer = local_description.sdp.as_text()
    result['answerTwcc'] = twcc in answer
    backend.handle({'op': 'answer', 'id': offer['id'], 'sdp': answer})
    checkpoint('sender answer applied')
    motion_errors=[]
    def motion():
        try:
            time.sleep(1)
            result['motionStart'] = time.monotonic()
            result['nativeCalls'] = []
            for index in range(2400 if network_profile else 480):
                due = result['motionStart'] + index/60
                time.sleep(max(0,due-time.monotonic()))
                dx = 3. if index//120%2==0 else -3.
                before=time.monotonic()
                native('NotifyPointerMotionRelative', GLib.Variant('(dd)', (dx,0.)))
                result['nativeCalls'].append({'at':before, 'dx':dx, 'elapsedMs':1000*(time.monotonic()-before)})
            result['motionEnd'] = time.monotonic()
        except Exception as failure: motion_errors.append(str(failure))
    motion_thread=threading.Thread(target=motion,daemon=True)
    motion_thread.start()
    receiver_started = time.monotonic()
    deadline = receiver_started + receiver_seconds
    while time.monotonic() < deadline:
        time.sleep(.5)
        if result['errors']:
            raise RuntimeError('Receiver error')
        # This requests diagnostics only. GCC must use actual RTCP feedback,
        # not fabricated loss/RTT values sent over the HTTP-style RPC.
        stage=network_profile.tick(time.monotonic()-receiver_started) if network_profile else 'clean'
        report=network_profile.feedback(receiver,Gst) if network_profile else {}
        sample = backend.handle({'op': 'feedback', 'id': offer['id'], **report, 'sequence':len(result['samples'])})
        sample['labAt']=time.monotonic();sample['labStage']=stage
        result['samples'].append(sample)
        if not full_duration and result['decodedBuffers'] >= 60 and (not gcc_mode or sample.get('gcc', {}).get('encoderSetterCount', 0) > 0):
            break
    motion_thread.join(timeout=3)
    native('Stop')
    assert not motion_thread.is_alive() and not motion_errors, str(motion_errors)
    timeline=[item for item in result.get('cursorTimeline',[]) if result['motionStart'] < item['at'] < result['motionEnd']]
    changed=[item for i,item in enumerate(timeline) if i and (item['x'],item['y']) != (timeline[i-1]['x'],timeline[i-1]['y'])]
    gaps=sorted(1000*(b['at']-a['at']) for a,b in zip(changed,changed[1:]))
    ages=[x['at']*1000-x['capturedAtUs']/1000 for x in changed if x.get('capturedAtUs')]
    result['captureClock']={'validatedPackets':len(ages),'minAgeMs':min(ages,default=None),'maxAgeMs':max(ages,default=None)}
    result['motionDelivery']={'changes':len(changed),'maxGapMs':max(gaps,default=0),'p95GapMs':gaps[int(len(gaps)*.95)] if gaps else None}
    if not network_profile:
        scale=result['captureLayout']['scale']
        observed=max(x['x'] for x in changed)-min(x['x'] for x in changed)
        expected=360*scale
        result['coordinateModel']={'logicalDisplacement':360,'scale':scale,
                                  'expectedStreamDisplacement':expected,'observedStreamDisplacement':observed}
        assert abs(observed-expected)<=4, 'Physical cursor and logical input scale disagree'
    assert len(changed)>300, 'Too few moving cursor updates'
    if not network_profile: assert max(gaps,default=1000)<120, 'Native cursor delivery stalled'
    for stage in ('clean','jitter','loss','capacity','recovery'):
        samples=[x for x in result['samples'] if x['labStage']==stage]
        if not samples:continue
        lo=min(x['labAt'] for x in samples);hi=max(x['labAt'] for x in samples)
        points=[x for x in changed if lo<x['at']<hi]
        delays=sorted(1000*(b['at']-a['at']) for a,b in zip(points,points[1:]))
        result.setdefault('deliveryByStage',{})[stage]={'changes':len(points),'maxGapMs':max(delays,default=0),'p95GapMs':delays[int(len(delays)*.95)] if delays else None}
    result['receiverDurationSeconds'] = round(time.monotonic() - receiver_started, 3)
    result['receiverConnection'] = receiver.get_property('connection-state').value_nick
    result['receiverICE'] = receiver.get_property('ice-connection-state').value_nick
    last = result['samples'][-1]
    result['freshness'] = last.get('freshness')
    result['reportedController'] = last.get('controller')
    result['labConfig'] = last.get('labConfig')
    assert (not gcc_mode) or (result['offerTwcc'] and result['answerTwcc']), 'TWCC negotiation missing'
    assert result['receiverConnection'] == 'connected' and result['decodedBuffers'] >= 8, 'No decoded H264 idle flow'
    if gcc_mode:
        assert last['controller'] == 'gcc', 'GCC was not selected'
        assert last['gcc']['encoderSetterCount'] > 0, 'GCC never adjusted the VA encoder'
        assert last['gcc']['estimatedBitrateNotifications'] > 0, 'No estimate notification'
        assert last['gcc']['twccEventCount'] > 0, 'No actual TWCC feedback reached GCC'
    else:
        assert 'gcc' not in last, 'GCC diagnostics appeared in legacy mode'
    assert result['cursorMode']=='metadata' and result.get('cursorPackets',0)>0, 'Native cursor metadata channel missing'
    assert last['media']['geometry']['encodedWidth'] == 1920
    assert last['media']['geometry']['encodedHeight'] == 1080
    backend.handle({'op':'suspend','id':offer['id']})
    time.sleep(.5);paused=result['decodedBuffers'];time.sleep(.5)
    assert result['decodedBuffers']==paused, 'Decoded buffers continued while suspended'
    backend.handle({'op':'resume','id':offer['id']})
    deadline=time.monotonic()+3
    while result['decodedBuffers']==paused and time.monotonic()<deadline:time.sleep(.02)
    assert result['decodedBuffers']>paused, 'No frames after resume'
    result['pauseResumePassed']=True
    backend.handle({'op': 'stop', 'id': offer['id']})
    assert worker.poll() == 0 and worker.stdin.closed and worker.stdout.closed, 'Worker did not clean up'
    result['workerExit'] = worker.poll()
    result['passed'] = True
except Exception as failure:
    result.update(passed=False, error=str(failure))
    raise
finally:
    backend.close()
    pipeline.set_state(Gst.State.NULL)
    bus.remove_signal_watch()
    loop.quit()
    loop_thread.join(timeout=2)
    (root / 'result.json').write_text(json.dumps(result, indent=2))
    (root / 'motion.h264').touch()
    print(json.dumps({k:result.get(k) for k in ('passed','error','cursorMode','motionDelivery','deliveryByStage')}), flush=True)
