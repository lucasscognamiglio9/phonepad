"""Production HFR/VA sender and a real local H264 WebRTC receiver.

Run only via isolated.py with PHONEPAD_LAB_GCC=1. Uses a private compositor
and the optional private rsrtp plugin. Counts decoded buffers, not distinct
presented frames or physical display latency. No external signaling/STUN.
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
if not str(root).startswith('/tmp/phonepad-hfr-') or str(root) not in os.environ.get('DBUS_SESSION_BUS_ADDRESS', ''):
    raise RuntimeError('Refusing to access a non-lab compositor')
if os.environ.get('PHONEPAD_RTC_CONTROLLER') != 'gcc':
    raise RuntimeError('This experiment requires explicit GCC selection')

preview = Path(__file__).resolve().parents[2] / 'setup/preview'
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
receiver.set_property('latency', 0)
pipeline.add(receiver)
decode = Gst.parse_bin_from_description(
    'rtph264depay ! h264parse ! ' + decoder + ' ! fakesink name=decoded sync=false async=false signal-handoffs=true', True)
pipeline.add(decode)
caps = Gst.Caps.from_string('application/x-rtp,media=video,encoding-name=H264,clock-rate=90000,payload=96,rtcp-fb-transport-cc=(boolean)true,extmap-3=(string)' + twcc)
receiver.emit('add-transceiver', GstWebRTC.WebRTCRTPTransceiverDirection.RECVONLY, caps)
ready = threading.Event()
result = {'scope': 'production HFR/VA sender and local decoded H264 receiver; no physical presentation measurement',
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
receiver.connect('pad-added', pad_added)
receiver.connect('notify::ice-gathering-state', gathered)
bus = pipeline.get_bus()
bus.add_signal_watch()
bus.connect('message::error', error)
backend = ProcessBackend(command=[sys.executable, str(preview / 'hfr_worker.py')])
worker = None
try:
    checkpoint('receiver starting')
    pipeline.set_state(Gst.State.PLAYING)
    offer = backend.handle({'op': 'start', 'width': 1280, 'codec': 'H264'})
    worker = backend.process
    checkpoint('sender offer received')
    result['offerTwcc'] = twcc in offer['sdp']
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
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        time.sleep(.5)
        if result['errors']:
            raise RuntimeError('Receiver error')
        # This requests diagnostics only. GCC must use actual RTCP feedback,
        # not fabricated loss/RTT values sent over the HTTP-style RPC.
        sample = backend.handle({'op': 'feedback', 'id': offer['id']})
        result['samples'].append(sample)
        if result['decodedBuffers'] >= 60 and sample.get('gcc', {}).get('encoderSetterCount', 0) > 0:
            break
    result['receiverConnection'] = receiver.get_property('connection-state').value_nick
    result['receiverICE'] = receiver.get_property('ice-connection-state').value_nick
    last = result['samples'][-1]
    assert result['offerTwcc'] and result['answerTwcc'], 'TWCC negotiation missing'
    assert result['receiverConnection'] == 'connected' and result['decodedBuffers'] >= 60, 'No decoded H264 flow'
    assert last['controller'] == 'gcc', 'GCC was not selected'
    assert last['gcc']['encoderSetterCount'] > 0, 'GCC never adjusted the VA encoder'
    assert last['gcc']['estimatedBitrateNotifications'] > 0, 'No estimate notification'
    assert last['gcc']['twccEventCount'] > 0, 'No actual TWCC feedback reached GCC'
    assert last['media']['geometry']['encodedWidth'] == 1280
    assert last['media']['geometry']['encodedHeight'] == 720
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
