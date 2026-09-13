"use strict";
// Native H.264 receiver. Video has its own connection; input keeps its socket.
window.PhonepadRTC = async function(video, signal, width, codec = "H264") {
  const pc = new RTCPeerConnection({iceServers: []});
  let id, timer, previous, stopped = false, failures = 0, stalled = 0;
  const call = async data => {
    const response = await fetch('/api/preview/rtc', {method:'POST',
      headers:{'Content-Type':'application/json'}, body:JSON.stringify(data), signal});
    if (!response.ok) throw Error('rtc-signalling');
    return response.json();
  };
  let rejectEnded;
  const ended = new Promise((_, reject) => { rejectEnded = reject; });
  // A failure can arrive before the caller starts awaiting this promise.
  ended.catch(()=>{});
  function stop() {
    if (stopped) return;
    stopped = true; clearTimeout(timer); pc.close(); video.srcObject = null;
    signal.removeEventListener('abort', abort);
    if (id) fetch('/api/preview/rtc', {method:'POST', keepalive:true,
      headers:{'Content-Type':'application/json'}, body:JSON.stringify({op:'stop', id})}).catch(()=>{});
  }
  function fail(error) { stop(); rejectEnded(error); }
  function abort() { fail(new DOMException('Stopped', 'AbortError')); }
  if (signal.aborted) { abort(); throw new DOMException('Stopped', 'AbortError'); }
  signal.addEventListener('abort', abort, {once:true});
  try {
    const offer = await call({op:'start', codec, width:Math.max(320, Math.min(1920, Math.round(width)))});
    id = offer.id;
    const firstFrame = new Promise((resolve, reject) => {
      const timeout = setTimeout(()=>{cleanup();reject(Error('rtc-first-frame-timeout'));}, 8000);
      const cleanup = () => { clearTimeout(timeout); video.removeEventListener('loadeddata', loaded); signal.removeEventListener('abort', canceled); };
      const loaded = () => { cleanup(); resolve(); };
      const canceled = () => { cleanup(); reject(new DOMException('Stopped','AbortError')); };
      video.addEventListener('loadeddata', loaded, {once:true});
      signal.addEventListener('abort', canceled, {once:true});
    });
    firstFrame.catch(()=>{});
    pc.ontrack = event => {
      // Hint only: browsers may retain a small jitter buffer for smooth playback.
      const receiver = event.receiver;
      if (receiver && 'jitterBufferTarget' in receiver) { try { receiver.jitterBufferTarget = 0; } catch (_) {} }
      video.muted = true; video.autoplay = true; video.playsInline = true;
      video.srcObject = new MediaStream([event.track]); video.hidden = false;
      video.play().catch(()=>{});
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') fail(Error('rtc-connection'));
    };
    await pc.setRemoteDescription({type:'offer', sdp:offer.sdp});
    await pc.setLocalDescription(await pc.createAnswer());
    if (pc.iceGatheringState !== 'complete') await new Promise((resolve, reject) => {
      const timeout = setTimeout(()=>{cleanup();reject(Error('rtc-ice-timeout'));}, 5000);
      function cleanup() { clearTimeout(timeout); pc.removeEventListener('icegatheringstatechange', changed); signal.removeEventListener('abort', canceled); }
      function changed() { if (pc.iceGatheringState === 'complete') { cleanup(); resolve(); } }
      function canceled() { cleanup(); reject(new DOMException('Stopped','AbortError')); }
      pc.addEventListener('icegatheringstatechange', changed); signal.addEventListener('abort', canceled, {once:true});
    });
    await call({op:'answer', id, sdp:pc.localDescription.sdp});
    async function feedback() {
      if (stopped) return;
      try {
        const stats = await pc.getStats(); let inbound, pair;
        stats.forEach(report => {
          if (report.type === 'inbound-rtp' && report.kind === 'video') inbound = report;
          if (report.type === 'candidate-pair' && report.nominated && report.state === 'succeeded') pair = report;
        });
        const delta = key => Math.max(0, (inbound?.[key] || 0) - (previous?.[key] || 0));
        const lost = delta('packetsLost'), received = delta('packetsReceived');
        const emitted = delta('jitterBufferEmittedCount');
        const elapsed = previous && inbound ? (inbound.timestamp-previous.timestamp)/1000 : 0;
        const result = await call({op:'feedback', id,
          loss:lost/Math.max(1, lost+received),
          delay:emitted ? delta('jitterBufferDelay')/emitted : 0,
          rtt:pair?.currentRoundTripTime || 0});
        if (inbound) {
          stalled = pc.connectionState === 'disconnected' ? stalled+1 : 0;
          window.PhonepadVideoDiagnostics = {state:'streaming', transport:'WebRTC', codec:'H.264 / VA-API',
            width:inbound.frameWidth, height:inbound.frameHeight, fps:inbound.framesPerSecond,
            averageMbps:elapsed>0 ? delta('bytesReceived')*8/elapsed/1e6 : 0,
            frames:inbound.framesDecoded, dropped:inbound.framesDropped,
            jitterBufferSeconds:emitted ? delta('jitterBufferDelay')/emitted : 0,
            decodeMs:delta('framesDecoded') ? delta('totalDecodeTime')*1000/delta('framesDecoded') : 0,
            freezes:inbound.freezeCount, packetsLost:inbound.packetsLost,
            rtt:pair?.currentRoundTripTime, ...result};
          previous = inbound;
        } else stalled++;
        if (stalled >= 6) throw Error('rtc-stalled');
        failures = 0;
      } catch(error) {
        if (signal.aborted) return;
        if (++failures >= 3 || error.message === 'rtc-stalled') { fail(error); return; }
      }
      if (!stopped) timer = setTimeout(feedback, 1000);
    }
    feedback();
    await Promise.race([firstFrame, ended]);
    return {ended, stop};
  } catch(error) { stop(); throw error; }
};
