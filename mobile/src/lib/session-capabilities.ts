import { parseMediaCapabilities, type MediaCapabilities } from './media-capabilities';

export type PermissionState = 'granted' | 'revoked' | 'unavailable';
export type PermissionScope = 'view' | 'input' | 'files' | 'clipboard';
export type Permission = { state: PermissionState; reason?: string };
export type CapabilityState = 'available' | 'unavailable' | 'unsupported' | 'unknown';
export type InputAction = 'm' | 'b' | 's' | 'k' | 'g' | 't' | 'p';
export type PointerGeometryKind = 'legacy-aspect-fit' | 'square-centered';
export type PointerGeometryProfile = {
  id: string;
  kind: PointerGeometryKind;
  sideMm?: number;
  widthMm?: number;
  heightMm?: number;
  gainMmPerPoint?: number;
  gainSource?: 'calibrated';
  gainMinMmPerPoint?: number;
  gainMaxMmPerPoint?: number;
};
export type PointerGeometryCapabilities = {
  version: 1;
  supportedProfiles: PointerGeometryProfile[];
  applied: { id: string; geometryEpoch: number };
};
export type SessionCapabilities = {
  protocolVersion: 1 | 2;
  profile: 'legacy-v1' | 'negotiated-v2';
  sessionEpoch: string | null;
  capabilityRevision: number;
  roles: string[];
  permissions: Record<PermissionScope, Permission>;
  input: { state: CapabilityState; actions: InputAction[]; effective: boolean; pointerGeometry: PointerGeometryCapabilities | null };
  literal: CapabilityState;
  video: CapabilityState;
  media: MediaCapabilities | null;
};

const actions: InputAction[] = ['m', 'b', 's', 'k', 'g', 't'];
const scopes: PermissionScope[] = ['view', 'input', 'files', 'clipboard'];
const capabilityStates = ['available', 'unavailable', 'unsupported', 'unknown'];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = () => Error('Las versiones de PhonePad no son compatibles. Actualizá la app y el equipo.');

const pointerProfile = (value: unknown): value is PointerGeometryProfile => {
  if (!record(value) || typeof value.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(value.id)
    || (value.kind !== 'legacy-aspect-fit' && value.kind !== 'square-centered')) return false;
  const positive = (candidate: unknown) => typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0;
  if (value.kind === 'legacy-aspect-fit') {
    return value.widthMm === 100 && value.heightMm === 70
      && value.sideMm === undefined && value.gainMmPerPoint === undefined
      && value.gainSource === undefined && value.gainMinMmPerPoint === undefined
      && value.gainMaxMmPerPoint === undefined;
  }
  return value.widthMm === undefined && value.heightMm === undefined
    && positive(value.sideMm) && Number(value.sideMm) >= 50 && Number(value.sideMm) <= 200
    && positive(value.gainMmPerPoint) && Number(value.gainMmPerPoint) >= .05 && Number(value.gainMmPerPoint) <= .25
    && value.gainSource === 'calibrated'
    && positive(value.gainMinMmPerPoint) && Number(value.gainMinMmPerPoint) >= .05 && Number(value.gainMinMmPerPoint) <= .25
    && positive(value.gainMaxMmPerPoint) && Number(value.gainMaxMmPerPoint) >= .05 && Number(value.gainMaxMmPerPoint) <= .25
    && Number(value.gainMmPerPoint) >= Number(value.gainMinMmPerPoint)
    && Number(value.gainMmPerPoint) <= Number(value.gainMaxMmPerPoint);
};

// Pointer geometry is an optional P04 extension. Older daemons omit it, and a
// malformed extension must keep the byte-compatible legacy mapper rather than
// turning a newly advertised profile into an unsafe coordinate transform.
function parsePointerGeometry(value: unknown): PointerGeometryCapabilities | null {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.supportedProfiles)
    || value.supportedProfiles.length < 1 || value.supportedProfiles.length > 8
    || value.supportedProfiles.some(profile => !pointerProfile(profile))) return null;
  const profiles = value.supportedProfiles as PointerGeometryProfile[];
  const applied = record(value.applied) ? value.applied : null;
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length
    || !applied || typeof applied.id !== 'string'
    || !/^[a-z0-9-]{1,64}$/.test(applied.id)
    || !Number.isSafeInteger(applied.geometryEpoch)
    || Number(applied.geometryEpoch) < 1
    || !profiles.some(profile => profile.id === applied.id)) return null;
  return {
    version: 1,
    supportedProfiles: profiles.map(profile => ({...profile})),
    applied: {id: applied.id, geometryEpoch: Number(applied.geometryEpoch)},
  };
}

// An absent version is an explicit legacy profile. A malformed advertisement
// must never silently fall back to the old, unrestricted command path.
export function parseSessionCapabilities(message: unknown): SessionCapabilities {
  if (!record(message)) throw invalid();
  if (message.protocolVersion === undefined) {
    if (['permissions', 'capabilities', 'sessionEpoch', 'capabilityRevision', 'compatibleVersions'].some(key => key in message)) throw invalid();
    return {
      protocolVersion: 1, profile: 'legacy-v1', sessionEpoch: null, capabilityRevision: 0,
      roles: ['viewer', 'controller'],
      permissions: { view: {state: 'granted'}, input: {state: 'granted'}, files: {state: 'granted'}, clipboard: {state: 'granted'} },
      input: {state: 'available', actions: [...actions], effective: true, pointerGeometry: null},
      literal: message.input === undefined ? 'unsupported' : 'available', video: 'unknown', media: null,
    };
  }
  if (message.protocolVersion !== 2 || !Array.isArray(message.compatibleVersions)
    || message.compatibleVersions.length > 8 || !message.compatibleVersions.includes(2)
    || message.compatibleVersions.some(v => !Number.isSafeInteger(v) || v < 1)
    || typeof message.sessionEpoch !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(message.sessionEpoch)
    || !Number.isSafeInteger(message.capabilityRevision) || Number(message.capabilityRevision) < 1
    || !Array.isArray(message.roles) || message.roles.length > 8
    || !message.roles.every(role => typeof role === 'string' && /^[a-z-]{1,32}$/.test(role))
    || !record(message.permissions) || !record(message.capabilities)) throw invalid();

  const permissions = {} as Record<PermissionScope, Permission>;
  for (const scope of scopes) {
    const value = message.permissions[scope];
    if (!record(value) || !['granted', 'revoked', 'unavailable'].includes(String(value.state))
      || (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 128))) throw invalid();
    permissions[scope] = {state: value.state as PermissionState, ...(value.reason ? {reason: String(value.reason)} : {})};
  }
  const {input, literal, video} = message.capabilities;
  if (!record(input) || !capabilityStates.includes(String(input.state)) || typeof input.effective !== 'boolean'
    || !Array.isArray(input.actions) || input.actions.length > actions.length + 1
    || input.actions.some(action => ![...actions, 'p'].includes(action as InputAction))
    || new Set(input.actions).size !== input.actions.length
    || !record(literal) || !capabilityStates.includes(String(literal.state))
    || !record(video) || !capabilityStates.includes(String(video.state))) throw invalid();
  return {
    protocolVersion: 2, profile: 'negotiated-v2', sessionEpoch: message.sessionEpoch,
    capabilityRevision: Number(message.capabilityRevision), roles: [...message.roles] as string[], permissions,
    input: {state: input.state as CapabilityState, actions: [...input.actions] as InputAction[], effective: input.effective,
      pointerGeometry: parsePointerGeometry(input.pointerGeometry)},
    literal: literal.state as CapabilityState, video: video.state as CapabilityState,
    media: parseMediaCapabilities(message.media),
  };
}

export function allowsInput(capabilities: SessionCapabilities | null, action?: InputAction): boolean {
  return !!capabilities && capabilities.permissions.input.state === 'granted'
    && capabilities.input.state === 'available' && capabilities.input.effective
    && (action === undefined || capabilities.input.actions.includes(action));
}

export function allowsPermission(capabilities: SessionCapabilities | null, scope: PermissionScope): boolean {
  return capabilities?.permissions[scope].state === 'granted';
}
