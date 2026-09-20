type MediaState = 'available' | 'unavailable' | 'unknown';
export type MediaCapabilities = {
  version: 1;
  source: {state: MediaState; id?: string; kind?: string; reason?: string};
  geometry: {state: MediaState; epoch?: number; width?: number; height?: number;
    encodedWidth?: number; encodedHeight?: number; reason?: string};
  video: {state: MediaState; codecs?: string[]; selectedCodec?: string; reason?: string};
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const state = (value: unknown): value is MediaState => value === 'available' || value === 'unavailable' || value === 'unknown';
const token = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const dimension = (value: unknown) => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 32768;
const invalid = () => Error('La computadora envió datos de pantalla incompatibles. Reconectá para actualizarla.');

// Absent metadata is the explicit compatibility path for older providers.
// Present but malformed metadata must never become invented dimensions.
export function parseMediaCapabilities(value: unknown): MediaCapabilities | null {
  if (value === undefined) return null;
  if (!object(value) || value.version !== 1) throw invalid();
  const {source, geometry, video} = value;
  for (const part of [source, geometry, video]) {
    if (!object(part) || !state(part.state)
      || (part.reason !== undefined && (typeof part.reason !== 'string' || part.reason.length > 128))) throw invalid();
  }
  if (!object(source) || !object(geometry) || !object(video)) throw invalid();
  if ((source.state === 'available' ? !token(source.id) : source.id !== undefined)
    || (source.kind !== undefined && (typeof source.kind !== 'string' || source.kind.length > 32))) throw invalid();
  const dimensions = ['width', 'height', 'encodedWidth', 'encodedHeight'] as const;
  if (geometry.state === 'available') {
    if (source.state !== 'available' || !Number.isSafeInteger(geometry.epoch) || Number(geometry.epoch) < 1
      || dimensions.some(key => !dimension(geometry[key]))) throw invalid();
  } else if (geometry.epoch !== undefined || dimensions.some(key => geometry[key] !== undefined)) throw invalid();
  if (video.state === 'available') {
    if (!Array.isArray(video.codecs) || video.codecs.length < 1 || video.codecs.length > 8
      || video.codecs.some(codec => typeof codec !== 'string' || !/^[A-Z0-9]{2,16}$/.test(codec))
      || new Set(video.codecs).size !== video.codecs.length
      || (video.selectedCodec !== undefined && !video.codecs.includes(video.selectedCodec))) throw invalid();
  } else if (video.codecs !== undefined || video.selectedCodec !== undefined) throw invalid();
  // Return only contract fields. Provider details such as PipeWire IDs never
  // become part of a caller's coordinate model.
  const reason = (part: Record<string, unknown>) => typeof part.reason === 'string' ? {reason: part.reason} : {};
  return {
    version: 1,
    source: {state: source.state as MediaState, ...reason(source),
      ...(source.id ? {id: source.id as string} : {}), ...(source.kind ? {kind: source.kind as string} : {})},
    geometry: {state: geometry.state as MediaState, ...reason(geometry), ...(geometry.state === 'available' ? {
      epoch: geometry.epoch as number, width: geometry.width as number, height: geometry.height as number,
      encodedWidth: geometry.encodedWidth as number, encodedHeight: geometry.encodedHeight as number,
    } : {})},
    video: {state: video.state as MediaState, ...reason(video), ...(video.state === 'available' ? {
      codecs: [...video.codecs as string[]], ...(video.selectedCodec ? {selectedCodec: video.selectedCodec as string} : {}),
    } : {})},
  };
}

export function selectVideoCodec(media: MediaCapabilities | null): 'H264' {
  // This native libwebrtc build currently accepts H264. Add other codecs only
  // after checking the installed native decoder, not the JavaScript platform.
  if (media?.video.state === 'unavailable'
    || (media?.video.state === 'available' && !media.video.codecs?.includes('H264'))) {
    throw Error('La computadora y esta app no tienen un formato de video compatible.');
  }
  return 'H264';
}

export class MediaBinding {
  current: MediaCapabilities | null = null;
  private known: MediaCapabilities | null = null;
  accept(value: unknown, required = false) {
    const next = parseMediaCapabilities(value);
    if (!next) {
      if (required || this.current) throw invalid();
      return;
    }
    const previous = this.known;
    if (previous?.source.id && next.source.id && previous.source.id !== next.source.id) throw Error('La pantalla cambió. Reconectando…');
    if (previous?.video.selectedCodec && next.video.selectedCodec && previous.video.selectedCodec !== next.video.selectedCodec) throw invalid();
    if (previous?.geometry.state === 'available' && next.geometry.state === 'available') {
      if (next.geometry.epoch! < previous.geometry.epoch!
        || (next.geometry.epoch === previous.geometry.epoch && ['width', 'height', 'encodedWidth', 'encodedHeight'].some(
          key => next.geometry[key as keyof typeof next.geometry] !== previous.geometry[key as keyof typeof previous.geometry]))) throw invalid();
    }
    if (next.source.id && (!this.known || next.geometry.state === 'available')) this.known = next;
    this.current = next;
  }
  coordinates() {
    const media = this.current;
    return {...(media?.source.id ? {sourceId: media.source.id} : {}),
      ...(media?.geometry.state === 'available' ? {geometryEpoch: media.geometry.epoch} : {})};
  }
}
