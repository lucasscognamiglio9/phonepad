export type PermissionState = 'granted' | 'revoked' | 'unavailable';
export type PermissionScope = 'view' | 'input' | 'files' | 'clipboard';
export type Permission = { state: PermissionState; reason?: string };
export type CapabilityState = 'available' | 'unavailable' | 'unsupported' | 'unknown';
export type InputAction = 'm' | 'b' | 's' | 'k' | 'g' | 't';
export type SessionCapabilities = {
  protocolVersion: 1 | 2;
  profile: 'legacy-v1' | 'negotiated-v2';
  sessionEpoch: string | null;
  capabilityRevision: number;
  roles: string[];
  permissions: Record<PermissionScope, Permission>;
  input: { state: CapabilityState; actions: InputAction[]; effective: boolean };
  literal: CapabilityState;
  video: CapabilityState;
};

const actions: InputAction[] = ['m', 'b', 's', 'k', 'g', 't'];
const scopes: PermissionScope[] = ['view', 'input', 'files', 'clipboard'];
const capabilityStates = ['available', 'unavailable', 'unsupported', 'unknown'];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = () => Error('Las versiones de PhonePad no son compatibles. Actualizá la app y el equipo.');

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
      input: {state: 'available', actions: [...actions], effective: true},
      literal: message.input === undefined ? 'unsupported' : 'available', video: 'unknown',
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
    || !Array.isArray(input.actions) || input.actions.length > actions.length
    || input.actions.some(action => !actions.includes(action as InputAction))
    || new Set(input.actions).size !== input.actions.length
    || !record(literal) || !capabilityStates.includes(String(literal.state))
    || !record(video) || !capabilityStates.includes(String(video.state))) throw invalid();
  return {
    protocolVersion: 2, profile: 'negotiated-v2', sessionEpoch: message.sessionEpoch,
    capabilityRevision: Number(message.capabilityRevision), roles: [...message.roles] as string[], permissions,
    input: {state: input.state as CapabilityState, actions: [...input.actions] as InputAction[], effective: input.effective},
    literal: literal.state as CapabilityState, video: video.state as CapabilityState,
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
