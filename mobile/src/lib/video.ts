import { RTCPeerConnection, RTCSessionDescription, MediaStream } from '@livekit/react-native-webrtc';
import { CursorReceiver, type CursorState } from './cursor';
import { MediaBinding, parseMediaCapabilities, selectVideoCodec } from './media-capabilities';

export type VideoSession = (() => void) & { setActive: (active: boolean) => Promise<void>; getDiagnostics: () => Stat | undefined };
type Stat = Record<string, unknown>;
const metric = (stat: Stat | undefined, key: string) => {
  const value = stat?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

// Missing stats are unknown, never evidence of a healthy interval.
const known = (stat: Stat | undefined, key: string): number | null => {
  const value = stat?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};
export function networkSample(current: Stat | undefined, previous?: Stat) {
  const unknown = { loss: null, delay: null };
  if (!current || !previous || current.id !== previous.id || current.ssrc !== previous.ssrc) return unknown;
  const now = known(current, 'timestamp'), before = known(previous, 'timestamp');
  if (now === null || before === null || now < 0 || before < 0 || now <= before || now - before > 5000) return unknown;
  const delta = (key: string) => {
    const a = known(current, key), b = known(previous, key);
    return a === null || b === null || a < b ? null : a - b;
  };
  const lost = delta('packetsLost'), received = delta('packetsReceived');
  const emitted = delta('jitterBufferEmittedCount'), residence = delta('jitterBufferDelay');
  // Counter resets (including corrected loss counters) invalidate this interval.
  if (received === null || lost === null) return unknown;
  return {
    loss: lost + received > 0 ? lost / (lost + received) : null,
    delay: emitted !== null && emitted > 0 && residence !== null ? residence / emitted : null,
  };
}

export function decodedFrameRate(current: Stat | undefined, previous?: Stat): number | null {
  if (!current || !previous || current.id !== previous.id || current.ssrc !== previous.ssrc) return null;
  const now = known(current, 'timestamp'), before = known(previous, 'timestamp');
  const frames = known(current, 'framesDecoded'), oldFrames = known(previous, 'framesDecoded');
  if (now === null || before === null || now <= before || now - before > 5000
      || frames === null || oldFrames === null || frames < oldFrames) return null;
  return Math.round((frames - oldFrames) * 1000 / (now - before) * 10) / 10;
}

export function selectedPair(stats: Stat[]): Stat | undefined {
  const transport = stats.find(r => r.type === 'transport' && typeof r.selectedCandidatePairId === 'string');
  if (transport) return stats.find(r => r.type === 'candidate-pair' && r.id === transport.selectedCandidatePairId);
  const candidates = stats.filter(r => r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded');
  return candidates.length === 1 ? candidates[0] : undefined;
}

// Encoded frames stay in native WebRTC/VideoToolbox. JS only signals and samples stats.
export async function startVideo(origin: string, signal: AbortSignal, show: (stream: MediaStream) => void, failed: (error: Error) => void, controlEpoch?: () => string | null, receiverWidth?: () => number, onCursor?: (cursor: CursorState | null) => void, orientation?: () => string) {
  const peer = new RTCPeerConnection({ iceServers: [] });
  const lifetime = new AbortController();
  const sessionEpoch = controlEpoch?.();
  const headers = { 'Content-Type': 'application/json', Origin: origin, ...(sessionEpoch ? { 'X-PhonePad-Session': sessionEpoch } : {}) };
  let suspended = false, suspendedAt = 0;
  let activity = Promise.resolve();
  let phase = 'status';
  let id: string | undefined, released = false, stopped = false, started = false;
  let terminalError: Error | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let previous: Stat | undefined;
  let previousRoute: string | undefined, sequence = 0;
  let diagnostics: Stat | undefined;
  let lastFrameAt = Date.now(), hasFrames = false;
  const media = new MediaBinding();
  const cursorReceiver = new CursorReceiver();
  let cursorAt = 0;
  peer.addEventListener('datachannel', event => {
    const channel = event.channel;
    if (channel.label !== 'phonepad-cursor-v1') { channel.close(); return; }
    channel.addEventListener('message', message => {
      if (stopped || suspended || (controlEpoch && controlEpoch() !== sessionEpoch)) return;
      const cursor = cursorReceiver.accept(message.data);
      if (cursor) { cursorAt=Date.now(); onCursor?.(cursor); }
    });
    channel.onclose = () => { if (!stopped) onCursor?.(null); };
  });

  // Bound the response body as well as the connection. Parent cancellation also
  // cancels in-flight signaling when iOS backgrounds the app or preview closes.
  const request = async (path: string, data?: object, timeoutMs = 5000) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timeout = setTimeout(abort, timeoutMs);
    lifetime.signal.addEventListener('abort', abort, { once: true });
    try {
      if (lifetime.signal.aborted || (controlEpoch && sessionEpoch !== controlEpoch())) throw Error('Cancelado');
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
  const call = (data: {op: string; [key: string]: unknown}) => request('/api/preview/rtc', {
    ...data, ...(!['start', 'stop', 'diagnostic'].includes(data.op) ? media.coordinates() : {}),
  }, data.op === 'start' ? 20000 : 5000);
  const stop = () => {
    if (!stopped) {
      stopped = true;
      lifetime.abort(); clearTimeout(timer); clearInterval(watchdog);
      onCursor?.(null); peer.close(); signal.removeEventListener('abort', stop);
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
    if (cursorAt && Date.now()-cursorAt>2500) { cursorAt=0; onCursor?.(null); }
    if (!suspended && Date.now() - lastFrameAt >= (hasFrames ? 8000 : 25000)) {
      fail(Error('Reconectando la pantalla…'));
    }
  }, 1000);
  try {
    const status = await request('/api/preview/status');
    if (!['ready', 'live'].includes(status.state)) throw Error('Preparando la pantalla en la laptop…');
    const advertised = parseMediaCapabilities(status.media);
    // H264 is the common denominator of this native libwebrtc build. Keep the
    // physical desktop resolution independent of screen orientation and zoom.
    phase = 'offer';
    const codec = selectVideoCodec(advertised);
    const offer = await call({ op: 'start', ...(onCursor ? {cursorMode:'metadata'} : {}), width: 1920, codec, ...(receiverWidth ? { cursorSize: Math.max(24, Math.min(128, Math.ceil(28 * 1920 / Math.max(1, receiverWidth())))) } : {}), ...(advertised ? {codecs: [codec]} : {}) });
    if (typeof offer.id !== 'string' || typeof offer.sdp !== 'string') throw Error('La laptop no pudo preparar la pantalla.');
    id = offer.id;
    checkActive();
    if (offer.cursorInitial) { const initial=cursorReceiver.accept(JSON.stringify(offer.cursorInitial)); if(initial){cursorAt=Date.now();onCursor?.(initial);} }
    media.accept(offer.media, advertised !== null);
    if (media.current && media.current.video.selectedCodec !== codec) throw Error('La computadora seleccionó un formato de video incompatible.');
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
    let previousOrientation = orientation?.();
    const feedback = async () => {
      if (stopped || suspended) return;
      const epoch = feedbackEpoch;
      try {
        const stats = await peer.getStats();
        if (stopped || suspended || epoch !== feedbackEpoch) return;
        const reports: Stat[] = [];
        stats.forEach((r: Stat) => reports.push(r));
        const inbound = reports.find(r => r.type === 'inbound-rtp' && (r.kind === 'video' || r.mediaType === 'video'));
        const pair = selectedPair(reports);
        const route = pair ? [pair.id, pair.localCandidateId, pair.remoteCandidateId].join(':') : undefined;
        if (route !== previousRoute) previous = undefined;
        const delta = (key: string) => Math.max(0, metric(inbound, key) - metric(previous, key));
        if (delta('framesDecoded') > 0) { hasFrames = true; lastFrameAt = Date.now(); }
        const sample = networkSample(inbound, previous);
        const currentOrientation = orientation?.();
        const orientationChanged = currentOrientation !== undefined && previousOrientation !== undefined && currentOrientation !== previousOrientation;
        previousOrientation = currentOrientation;
        const response = await call({
          op: 'feedback', id, ...sample,
          ...(orientationChanged ? { refreshFrame: true } : {}),
          rtt: known(pair, 'currentRoundTripTime'), route, sequence: ++sequence,
          client: 'native', frames: metric(inbound, 'framesDecoded'),
          fps: decodedFrameRate(inbound, previous), width: metric(inbound, 'frameWidth'), height: metric(inbound, 'frameHeight'),
          bytes: metric(inbound, 'bytesReceived'), connection: peer.connectionState,
        });
        if (epoch !== feedbackEpoch) return;
        media.accept(response.media);
        diagnostics = response && typeof response === 'object' ? {
          encodeP95Ms: known(response, 'encodeP95Ms'), bitrateKbps: known(response, 'bitrateKbps'),
          encodedFps: known(response, 'encodedFps'), sourceFps: known(response, 'sourceFps'), inputFps: known(response, 'inputFps'),
          rateDecision: response.rateDecision ?? null,
          media: media.current,
        } : undefined;
        previous = inbound; previousRoute = route; misses = 0;
      } catch { if (epoch !== feedbackEpoch) return; if (++misses >= 3) fail(Error('Reconectando la pantalla…')); }
      if (!stopped && !suspended && epoch === feedbackEpoch) timer = setTimeout(feedback, 1000);
    };
    const setActive = (active: boolean) => {
      // Serialize pause/resume: a late pause must never overwrite a newer resume.
      activity = activity.then(async () => {
        checkActive();
        if (!active) {
          if (suspended) return;
          ++feedbackEpoch; onCursor?.(null); suspended = true; suspendedAt = Date.now(); clearTimeout(timer);
          await call({ op: 'suspend', id });
        } else if (suspended) {
          if (Date.now() - suspendedAt >= 300_000 || ['failed', 'closed'].includes(peer.connectionState)) {
            throw Error('Reconectando la pantalla…');
          }
          const resumed = await call({ op: 'resume', id });
          media.accept(resumed.media);
          checkActive(); suspended = false; lastFrameAt = Date.now(); previous = undefined; misses = 0;
          void feedback();
        }
      }).catch(error => { stop(); throw error; });
      return activity;
    };
    void feedback(); return Object.assign(stop, { setActive, getDiagnostics: () => diagnostics }) as VideoSession;
  } catch (error) {
    if (!signal.aborted) console.warn('[PhonePad video]', {phase, error: error instanceof Error ? error.message : String(error)});
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
