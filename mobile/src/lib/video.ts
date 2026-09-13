import { RTCPeerConnection, RTCSessionDescription, MediaStream } from '@livekit/react-native-webrtc';

export type VideoSession = (() => void) & { setActive: (active: boolean) => Promise<void> };
type Stat = Record<string, unknown>;
const metric = (stat: Stat | undefined, key: string) => {
  const value = stat?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

// RTC counters are cumulative. The first sample after a pause establishes a
// baseline; old loss/jitter must not reduce the resumed stream's quality.
export function networkSample(current: Stat | undefined, previous?: Stat) {
  if (!current || !previous || metric(current, 'packetsReceived') < metric(previous, 'packetsReceived')) {
    return { loss: 0, delay: 0 };
  }
  const delta = (key: string) => Math.max(0, metric(current, key) - metric(previous, key));
  const lost = delta('packetsLost'), received = delta('packetsReceived');
  const emitted = delta('jitterBufferEmittedCount');
  return {
    loss: lost / Math.max(1, lost + received),
    delay: emitted ? delta('jitterBufferDelay') / emitted : 0,
  };
}

// Encoded frames stay in native WebRTC/VideoToolbox. JS only signals and samples stats.
export async function startVideo(origin: string, signal: AbortSignal, show: (stream: MediaStream) => void, failed: (error: Error) => void) {
  const peer = new RTCPeerConnection({ iceServers: [] });
  const lifetime = new AbortController();
  const headers = { 'Content-Type': 'application/json', Origin: origin };
  let suspended = false, suspendedAt = 0;
  let activity = Promise.resolve();
  let phase = 'status';
  let id: string | undefined, released = false, stopped = false, started = false;
  let terminalError: Error | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let previous: Stat | undefined;
  let lastFrameAt = Date.now(), hasFrames = false;

  // Bound the response body as well as the connection. Parent cancellation also
  // cancels in-flight signaling when iOS backgrounds the app or preview closes.
  const request = async (path: string, data?: object) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timeout = setTimeout(abort, 5000);
    lifetime.signal.addEventListener('abort', abort, { once: true });
    try {
      if (lifetime.signal.aborted) throw Error('Cancelado');
      const response = await fetch(origin + path, {
        method: data ? 'POST' : 'GET', headers,
        body: data ? JSON.stringify(data) : undefined, signal: controller.signal,
      });
      if (!response.ok) throw Error('No se pudo conectar la pantalla.');
      return await response.json();
    } finally {
      clearTimeout(timeout); lifetime.signal.removeEventListener('abort', abort);
    }
  };
  const call = (data: object) => request('/api/preview/rtc', data);
  const stop = () => {
    if (!stopped) {
      stopped = true;
      lifetime.abort(); clearTimeout(timer); clearInterval(watchdog);
      peer.close(); signal.removeEventListener('abort', stop);
    }
    // An offer may finish just as cancellation happens. Release a late session
    // too; the server's lease remains the fallback if the network is unavailable.
    if (id && !released) {
      released = true;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      void fetch(origin + '/api/preview/rtc', {
        method: 'POST', headers, body: JSON.stringify({ op: 'stop', id }), signal: controller.signal,
      }).catch(() => {}).finally(() => clearTimeout(timeout));
    }
  };
  const fail = (error: Error) => {
    if (stopped) return;
    terminalError = error; stop();
    // Startup rejects; an established session reports failure. Never both.
    if (started) failed(error);
  };
  const checkActive = () => {
    if (stopped || signal.aborted) throw terminalError || Error('Cancelado');
  };
  const native = <T>(operation: Promise<T>) => new Promise<T>((resolve, reject) => {
    const abort = () => reject(terminalError || Error('Cancelado'));
    if (lifetime.signal.aborted) abort();
    else lifetime.signal.addEventListener('abort', abort, { once: true });
    // A native promise can stall during negotiation. Closing the peer must also
    // unblock startup so the screen can schedule a new session.
    operation.then(resolve, reject).finally(() => lifetime.signal.removeEventListener('abort', abort));
  });
  if (signal.aborted) { stop(); throw Error('Cancelado'); }
  signal.addEventListener('abort', stop, { once: true });
  watchdog = setInterval(() => {
    if (!suspended && Date.now() - lastFrameAt >= (hasFrames ? 8000 : 12000)) {
      fail(Error('Reconectando la pantalla…'));
    }
  }, 1000);
  try {
    const status = await request('/api/preview/status');
    if (!['ready', 'live'].includes(status.state)) throw Error('Preparando la pantalla en la laptop…');
    // H264 is the common denominator of this native libwebrtc build. Keep the
    // physical desktop resolution independent of screen orientation and zoom.
    phase = 'offer';
    const offer = await call({ op: 'start', width: 1920, codec: 'H264' });
    if (typeof offer.id !== 'string' || typeof offer.sdp !== 'string') throw Error('La laptop no pudo preparar la pantalla.');
    id = offer.id;
    checkActive();
    peer.addEventListener('track', event => {
      if (!stopped && event.track?.kind === 'video') show(event.streams[0] || new MediaStream([event.track]));
    });
    peer.onconnectionstatechange = () => {
      if (!suspended && peer.connectionState === 'failed') fail(Error('Reconectando la pantalla…'));
    };
    phase = 'remote-description';
    await native(peer.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offer.sdp })));
    checkActive();
    phase = 'answer';
    const answer = await native(peer.createAnswer());
    checkActive();
    await native(peer.setLocalDescription(answer));
    checkActive();
    phase = 'ice-gathering';
    if (peer.iceGatheringState !== 'complete') await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timeout); peer.onicegatheringstatechange = null; lifetime.signal.removeEventListener('abort', abort); };
      const changed = () => { if (peer.iceGatheringState === 'complete') { cleanup(); resolve(); } };
      const abort = () => { cleanup(); reject(terminalError || Error('Cancelado')); };
      const timeout = setTimeout(() => { cleanup(); reject(Error('La red no respondió.')); }, 5000);
      peer.onicegatheringstatechange = changed; lifetime.signal.addEventListener('abort', abort, { once: true });
      // Also handle completion/abort between the initial check and registration.
      if (lifetime.signal.aborted) abort(); else changed();
    });
    checkActive();
    if (!peer.localDescription?.sdp) throw Error('No se pudo preparar el receptor de pantalla.');
    phase = 'send-answer';
    await call({ op: 'answer', id, sdp: peer.localDescription.sdp });
    phase = 'receiving';
    checkActive(); started = true;
    let misses = 0, feedbackEpoch = 0;
    const feedback = async () => {
      if (stopped || suspended) return;
      const epoch = feedbackEpoch;
      try {
        const stats = await peer.getStats();
        if (stopped || suspended || epoch !== feedbackEpoch) return;
        let inbound: Stat | undefined, pair: Stat | undefined;
        stats.forEach((r: Stat) => {
          if (r.type === 'inbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) inbound = r;
          if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
        });
        const delta = (key: string) => Math.max(0, metric(inbound, key) - metric(previous, key));
        if (delta('framesDecoded') > 0) { hasFrames = true; lastFrameAt = Date.now(); }
        const sample = networkSample(inbound, previous);
        await call({
          op: 'feedback', id, ...sample,
          rtt: metric(pair, 'currentRoundTripTime'),
          client: 'native', frames: metric(inbound, 'framesDecoded'),
          fps: metric(inbound, 'framesPerSecond'), width: metric(inbound, 'frameWidth'), height: metric(inbound, 'frameHeight'),
          bytes: metric(inbound, 'bytesReceived'), connection: peer.connectionState,
        });
        if (epoch !== feedbackEpoch) return;
        previous = inbound; misses = 0;
      } catch { if (epoch !== feedbackEpoch) return; if (++misses >= 3) fail(Error('Reconectando la pantalla…')); }
      if (!stopped && !suspended && epoch === feedbackEpoch) timer = setTimeout(feedback, 1000);
    };
    const setActive = (active: boolean) => {
      // Serialize pause/resume: a late pause must never overwrite a newer resume.
      activity = activity.then(async () => {
        checkActive();
        if (!active) {
          if (suspended) return;
          ++feedbackEpoch; suspended = true; suspendedAt = Date.now(); clearTimeout(timer);
          await call({ op: 'suspend', id });
        } else if (suspended) {
          if (Date.now() - suspendedAt >= 300_000 || ['failed', 'closed'].includes(peer.connectionState)) {
            throw Error('Reconectando la pantalla…');
          }
          await call({ op: 'resume', id });
          checkActive(); suspended = false; lastFrameAt = Date.now(); previous = undefined; misses = 0;
          void feedback();
        }
      }).catch(error => { stop(); throw error; });
      return activity;
    };
    void feedback(); return Object.assign(stop, { setActive }) as VideoSession;
  } catch (error) {
    if (!signal.aborted) {
      const report = new AbortController();
      const timeout = setTimeout(() => report.abort(), 2000);
      void fetch(origin + '/api/preview/rtc', { method: 'POST', headers,
        body: JSON.stringify({ op: 'diagnostic', phase }), signal: report.signal,
      }).catch(() => {}).finally(() => clearTimeout(timeout));
    }
    stop(); throw terminalError || error;
  }
}
