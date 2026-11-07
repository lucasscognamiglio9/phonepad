import { RTCPeerConnection, RTCSessionDescription, mediaDevices, type MediaStream } from '@livekit/react-native-webrtc';

// The laptop reports when one of its apps opens "Cámara del iPhone" or
// "Micrófono del iPhone". Only then does the phone capture, so iOS shows its
// camera or microphone indicator exactly while a laptop app uses it.
export type SensorKind = 'mic' | 'camera';
export type SensorUse = { kinds: SensorKind[]; denied: SensorKind[] };
type Demand = { version: number; mic: boolean; camera: boolean; cameraAvailable: boolean };

const CAMERA = { facingMode: 'user', width: 1280, height: 720, frameRate: 30 };
const POLL_MS = 35_000; // The laptop answers every 25 s even without changes.
const OFFLINE_MS = 2_000;

export const wantedKinds = (demand: Demand): SensorKind[] =>
  [...(demand.mic ? ['mic' as const] : []), ...(demand.camera && demand.cameraAvailable ? ['camera' as const] : [])];

const sameKinds = (a: SensorKind[], b: SensorKind[]) => a.length === b.length && a.every(kind => b.includes(kind));

export function startSensors(origin: string, controlEpoch: () => string | null, report: (use: SensorUse) => void) {
  const epoch = controlEpoch();
  const headers = { 'Content-Type': 'application/json', Origin: origin, ...(epoch ? { 'X-PhonePad-Session': epoch } : {}) };
  const lifetime = new AbortController();
  let wake = new AbortController();
  let active: { kinds: SensorKind[]; close: () => void } | undefined;
  let use: SensorUse = { kinds: [], denied: [] };
  const publish = (next: SensorUse) => {
    if (!sameKinds(next.kinds, use.kinds) || !sameKinds(next.denied, use.denied)) { use = next; report(next); }
  };

  const request = async (path: string, data: object | undefined, timeoutMs: number, signal = lifetime.signal) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timeout = setTimeout(abort, timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted || (epoch && controlEpoch() !== epoch)) throw Error('Cancelado');
      const response = await fetch(origin + path, {
        method: data ? 'POST' : 'GET', headers, body: data ? JSON.stringify(data) : undefined, signal: controller.signal,
      });
      if (!response.ok) throw Error(`sensors ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout); signal.removeEventListener('abort', abort);
    }
  };

  const open = async (kinds: SensorKind[]) => {
    const peer = new RTCPeerConnection({ iceServers: [] });
    const streams: MediaStream[] = [];
    let id: string | undefined, closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      streams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
      peer.close();
      if (id) void request('/api/preview/sensors', { op: 'stop', id }, 2000, new AbortController().signal).catch(() => {});
    };
    active = { kinds, close };
    try {
      const offer = await request('/api/preview/sensors', { op: 'start', kinds }, 10_000);
      if (typeof offer.id !== 'string' || typeof offer.sdp !== 'string') throw Error('invalid offer');
      id = offer.id;
      await peer.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offer.sdp }));
      const denied: SensorKind[] = [];
      for (const kind of kinds) {
        const media = kind === 'mic' ? 'audio' : 'video';
        const transceiver = peer.getTransceivers().find(item => item.receiver.track?.kind === media);
        if (!transceiver) continue;
        try {
          const stream = await mediaDevices.getUserMedia(kind === 'mic' ? { audio: true } : { video: CAMERA });
          streams.push(stream);
          if (closed) break;
          await transceiver.sender.replaceTrack(stream.getTracks()[0] ?? null);
          transceiver.direction = 'sendonly';
        } catch {
          denied.push(kind);
          transceiver.direction = 'inactive';
        }
      }
      if (closed) return;
      await peer.setLocalDescription(await peer.createAnswer());
      if (peer.iceGatheringState !== 'complete') await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { peer.onicegatheringstatechange = null; reject(Error('ice')); }, 5000);
        peer.onicegatheringstatechange = () => {
          if (peer.iceGatheringState === 'complete') { clearTimeout(timeout); peer.onicegatheringstatechange = null; resolve(); }
        };
      });
      if (closed || !peer.localDescription?.sdp) return;
      peer.onconnectionstatechange = () => {
        if (!closed && peer.connectionState === 'failed' && active?.close === close) {
          close(); active = undefined; publish({ kinds: [], denied: [] });
          wake.abort(); // Ask again; the demand may still be there.
        }
      };
      await request('/api/preview/sensors', { op: 'answer', id, sdp: peer.localDescription.sdp }, 5000);
      publish({ kinds: kinds.filter(kind => !denied.includes(kind)), denied });
    } catch (error) {
      close();
      if (active?.close === close) active = undefined;
      throw error;
    }
  };

  void (async () => {
    let version = -1;
    while (!lifetime.signal.aborted) {
      try {
        const demand: Demand = await request(`/api/preview/sensors?after=${version}`, undefined, POLL_MS, wake.signal);
        version = demand.version;
        const kinds = wantedKinds(demand);
        if (!sameKinds(kinds, active?.kinds ?? [])) {
          active?.close(); active = undefined;
          if (kinds.length) await open(kinds);
          else publish({ kinds: [], denied: [] });
        }
      } catch {
        if (lifetime.signal.aborted) break;
        if (wake.signal.aborted) { wake = new AbortController(); version = -1; continue; }
        publish({ kinds: [], denied: use.denied });
        await new Promise(resolve => setTimeout(resolve, OFFLINE_MS));
        version = -1;
      }
    }
  })();

  return () => {
    lifetime.abort(); wake.abort();
    active?.close(); active = undefined;
  };
}
