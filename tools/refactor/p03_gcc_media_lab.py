"""Production HFR/VA sender and a real local H264 WebRTC receiver.

Run only via isolated.py with PHONEPAD_LAB_GCC=1. Select the sender controller
with PHONEPAD_RTC_CONTROLLER=gcc or legacy. Uses a private compositor and the
optional private GCC plugin only in GCC mode. Counts decoded buffers, not
distinct presented frames or physical display latency. No external
signaling/STUN.
"""

import faulthandler
import json
import os
from pathlib import Path
import sys
import threading
import time

faulthandler.enable()
root = Path(os.environ['PHONEPAD_HFR_ROOT'])
if not str(root).startswith('/tmp/phonepad-hfr-') or (os.environ.get('PHONEPAD_LAB_NETWORK') != '1' and str(root) not in os.environ.get('DBUS_SESSION_BUS_ADDRESS', '')):
    raise RuntimeError('Refusing to access a non-lab compositor')
controller_name = os.environ.get('PHONEPAD_RTC_CONTROLLER', 'gcc')
if controller_name not in ('gcc', 'legacy'):
    raise RuntimeError('This experiment requires PHONEPAD_RTC_CONTROLLER=gcc or legacy')
gcc_mode = controller_name == 'gcc'
try:
    receiver_seconds = float(os.environ.get('PHONEPAD_LAB_RECEIVER_SECONDS', '12'))
except (TypeError, ValueError):
    raise RuntimeError('Invalid PHONEPAD_LAB_RECEIVER_SECONDS')
if not 1 <= receiver_seconds <= 60:
    raise RuntimeError('PHONEPAD_LAB_RECEIVER_SECONDS must be 1..60')
full_duration = os.environ.get('PHONEPAD_LAB_FULL_DURATION', '0') == '1'

preview = Path(os.environ.get('PHONEPAD_LAB_PREVIEW_DIR', Path(__file__).resolve().parents[2] / 'setup/preview'))
sys.path.insert(0, str(preview))
from process_backend import ProcessBackend
import gi
for namespace in ('Gst', 'GstWebRTC', 'GstSdp'):
    gi.require_version(namespace, '1.0')
from gi.repository import GLib, Gst, GstSdp, GstWebRTC

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
receiver.set_property('latency', 50 if os.environ.get('PHONEPAD_LAB_NETWORK')=='1' else 0)
pipeline.add(receiver)
network = None
if os.environ.get('PHONEPAD_LAB_NETWORK') == '1':
    from video_network_profile import Profile
    network = Profile()

width = int(os.environ.get('PHONEPAD_LAB_VIDEO_WIDTH','1280'))
if width not in (1280,1920): raise RuntimeError('Invalid lab width')
decode = Gst.parse_bin_from_description(
    'rtph264depay ! h264parse ! ' + decoder + (' ! videoconvert ! video/x-raw,format=RGB ! appsink name=decoded emit-signals=true max-buffers=1 drop=true sync=false' if network else ' ! fakesink name=decoded sync=false async=false signal-handoffs=true'), True)
pipeline.add(decode)
receiver_feedback = ',rtcp-fb-transport-cc=(boolean)true,extmap-3=(string)' + twcc if gcc_mode else ''
caps = Gst.Caps.from_string(
    'application/x-rtp,media=video,encoding-name=H264,clock-rate=90000,payload=96'
    + receiver_feedback
)
transceiver=receiver.emit('add-transceiver', GstWebRTC.WebRTCRTPTransceiverDirection.RECVONLY, caps)
transceiver.set_property('do-nack', True)
ready = threading.Event()
result = {'scope': 'production HFR/VA sender and local decoded H264 receiver; no physical presentation measurement',
          'controller': controller_name,
          'receiverDurationRequestedSeconds': receiver_seconds, 'sourceFpsRequested': int(os.environ.get('PHONEPAD_LAB_NETWORK_FPS','30')) if network else None,
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


def decoded_sample(sink):
    sample=sink.emit('pull-sample')
    result['decodedBuffers']+=1
    result['decodedCaps']=sample.get_caps().to_string()
    if result.pop('samplePixels',False): network.observe_pixels(sample.get_buffer(),sample.get_caps())
    return Gst.FlowReturn.OK

if network: decode.get_by_name('decoded').connect('new-sample',decoded_sample)
else: decode.get_by_name('decoded').connect('handoff', decoded)
receiver.connect('pad-added', pad_added)
receiver.connect('notify::ice-gathering-state', gathered)
bus = pipeline.get_bus()
bus.add_signal_watch()
bus.connect('message::error', error)
sender=Path(__file__).with_name('video_network_sender.py') if network else preview/'hfr_worker.py'
backend = ProcessBackend(command=[sys.executable,str(sender)])
if network: result['scope']='Synthetic moving source, production VA hardware encoder and real H264 WebRTC receiver in a private network; no iPhone or screen capture'
worker = None
try:
    checkpoint('receiver starting')
    pipeline.set_state(Gst.State.PLAYING)
    offer = backend.handle({'op': 'start', 'width': width, 'codec': 'H264'})
    worker = backend.process
    checkpoint('sender offer received')
    result['offerTwcc'] = twcc in offer['sdp']
    result['offerNack'] = 'a=rtcp-fb:96 nack' in offer['sdp']
    result['offerRtx'] = ' RTX/' in offer['sdp'] or ' rtx/' in offer['sdp']
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
    result['answerNack'] = 'a=rtcp-fb:96 nack' in answer
    result['answerRtx'] = ' RTX/' in answer or ' rtx/' in answer
    backend.handle({'op': 'answer', 'id': offer['id'], 'sdp': answer})
    checkpoint('sender answer applied')
    receiver_started = time.monotonic()
    deadline = receiver_started + receiver_seconds
    while time.monotonic() < deadline:
        time.sleep(.5)
        if result['errors']:
            raise RuntimeError('Receiver error')
        # This requests diagnostics only. GCC must use actual RTCP feedback,
        # not fabricated loss/RTT values sent over the HTTP-style RPC.
        if network:
            stage=network.tick(time.monotonic()-receiver_started)
            feedback=network.feedback(receiver,Gst)
            result['samplePixels']=True
        else: feedback={}
        sample = backend.handle({'op': 'feedback', 'id': offer['id'], **feedback})
        if network:
            sample.update(testStage=stage,testNetwork=feedback,decodedBuffers=result['decodedBuffers'],textQuality=network.quality())
        result['samples'].append(sample)
        if not full_duration and result['decodedBuffers'] >= 60 and (not gcc_mode or sample.get('gcc', {}).get('encoderSetterCount', 0) > 0):
            break
    result['receiverDurationSeconds'] = round(time.monotonic() - receiver_started, 3)
    result['receiverConnection'] = receiver.get_property('connection-state').value_nick
    result['receiverICE'] = receiver.get_property('ice-connection-state').value_nick
    last = result['samples'][-1]
    result['freshness'] = last.get('freshness')
    result['reportedController'] = last.get('controller')
    result['labConfig'] = last.get('labConfig')
    assert (not gcc_mode) or (result['offerTwcc'] and result['answerTwcc']), 'TWCC negotiation missing'
    assert result['receiverConnection'] == 'connected' and result['decodedBuffers'] >= 60, 'No decoded H264 flow'
    if gcc_mode:
        assert last['controller'] == 'gcc', 'GCC was not selected'
        assert last['gcc']['encoderSetterCount'] > 0, 'GCC never adjusted the VA encoder'
        assert last['gcc']['estimatedBitrateNotifications'] > 0, 'No estimate notification'
        assert last['gcc']['twccEventCount'] > 0, 'No actual TWCC feedback reached GCC'
    else:
        assert 'gcc' not in last, 'GCC diagnostics appeared in legacy mode'
    assert last['media']['geometry']['encodedWidth'] == width
    assert last['media']['geometry']['encodedHeight'] == width*9//16
    if network:
        recovery=[s for s in result['samples'] if s.get('testStage')=='recovery']
        assert len(recovery)>4 and recovery[-1]['decodedBuffers']>recovery[0]['decodedBuffers']+(10 if os.environ.get('PHONEPAD_LAB_NETWORK_FPS')=='2' else 60),'Decoded video failed to recover'
        result['networkTest']={'privateNamespace':True,'scenario':os.environ.get('PHONEPAD_LAB_NETWORK_SCENARIO','impairments'),'stages':[s[1] for s in __import__('video_network_profile').stages()], 'recoveryDecodedBuffers':recovery[-1]['decodedBuffers']-recovery[0]['decodedBuffers']}
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
    print(json.dumps(result), flush=True)
