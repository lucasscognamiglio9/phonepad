import { File, Paths } from 'expo-file-system';
import { randomUUID } from 'expo-crypto';

export const HOST_SETTINGS_VERSION = 1 as const;
export const HOST_SETTINGS_FILE_NAME = '.phonepad-hosts.v1.json';
export const HOST_SETTINGS_SLOT_A_FILE_NAME = '.phonepad-hosts.v1.a.json';
export const HOST_SETTINGS_SLOT_B_FILE_NAME = '.phonepad-hosts.v1.b.json';
export const HOST_SETTINGS_TEMP_FILE_NAME = '.phonepad-hosts.v1.json.tmp';
export const MAX_HOSTS = 16;
export const MAX_HOST_NAME_LENGTH = 80;
export const MAX_HOST_ORIGIN_LENGTH = 2048;
export const MAX_HOST_SETTINGS_BYTES = 64 * 1024;

const hostIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const controlCharacterPattern = /[\u0000-\u001f\u007f-\u009f]/;

export type HostDevice = {
  id: string;
  name: string;
  origin: string;
};

export type HostSettings = {
  version: typeof HOST_SETTINGS_VERSION;
  devices: HostDevice[];
  selected: string | null;
  /** Journal revision. It is internal metadata and remains JSON-readable. */
  revision?: number;
};

export type HostInput = {
  name: string;
  origin: string;
  id?: string;
};

export type HostSettingsErrorCode =
  | 'invalid-origin'
  | 'invalid-name'
  | 'invalid-id'
  | 'duplicate-origin'
  | 'limit-reached'
  | 'device-not-found'
  | 'stale-settings'
  | 'invalid-settings'
  | 'read-failed'
  | 'write-failed';

export type HostSettingsOperationError = {
  code: HostSettingsErrorCode;
  message: string;
};

export class HostSettingsError extends Error {
  readonly code: HostSettingsErrorCode;

  constructor(code: HostSettingsErrorCode, message: string) {
    super(message);
    this.name = 'HostSettingsError';
    this.code = code;
  }
}

export type HostSettingsLoadResult = {
  settings: HostSettings;
  error?: HostSettingsOperationError;
};

export type HostSettingsSaveResult =
  | { ok: true; settings: HostSettings }
  | { ok: false; error: HostSettingsOperationError };

export interface HostSettingsStorage {
  readText(): Promise<string | null>;
  writeTextAtomically(text: string): Promise<void>;
}

export interface HostSettingsAdapter {
  load(): Promise<HostSettingsLoadResult>;
  save(settings: HostSettings): Promise<HostSettingsSaveResult>;
}

export function createDefaultHostSettings(): HostSettings {
  return { version: HOST_SETTINGS_VERSION, devices: [], selected: null, revision: 0 };
}

const hostSettingsErrorCodes: readonly HostSettingsErrorCode[] = [
  'invalid-origin',
  'invalid-name',
  'invalid-id',
  'duplicate-origin',
  'limit-reached',
  'device-not-found',
  'stale-settings',
  'invalid-settings',
  'read-failed',
  'write-failed',
];

function isHostSettingsErrorCode(value: unknown): value is HostSettingsErrorCode {
  return typeof value === 'string' && hostSettingsErrorCodes.includes(value as HostSettingsErrorCode);
}

function operationError(error: unknown, fallbackCode: HostSettingsErrorCode, fallbackMessage: string): HostSettingsOperationError {
  if (error instanceof HostSettingsError) return { code: error.code, message: error.message };
  // Injected storage can cross a JS realm (native bridge or VM test), so do
  // not lose a validated public error code merely because instanceof differs.
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown };
    if (isHostSettingsErrorCode(candidate.code)) {
      return {
        code: candidate.code,
        message: typeof candidate.message === 'string' ? candidate.message : fallbackMessage,
      };
    }
  }
  return { code: fallbackCode, message: fallbackMessage };
}

function invalidSettings(message: string): HostSettingsError {
  return new HostSettingsError('invalid-settings', message);
}

function normalizeName(input: unknown): string {
  if (typeof input !== 'string') throw new HostSettingsError('invalid-name', 'Escribí un nombre para el equipo.');
  const value = input.trim();
  if (!value || value.length > MAX_HOST_NAME_LENGTH || controlCharacterPattern.test(value)) {
    throw new HostSettingsError('invalid-name', `El nombre debe tener entre 1 y ${MAX_HOST_NAME_LENGTH} caracteres.`);
  }
  return value;
}

function normalizeId(input: unknown): string {
  if (typeof input !== 'string' || !hostIdPattern.test(input)) {
    throw new HostSettingsError('invalid-id', 'El identificador del equipo no es válido.');
  }
  return input;
}

/**
 * Accepts only an HTTPS origin. A root slash is normalized away; every other
 * path, credential, query, and fragment is rejected before persistence.
 */
export function normalizeHostOrigin(input: string): string {
  if (typeof input !== 'string') {
    throw new HostSettingsError('invalid-origin', 'Ingresá una dirección HTTPS.');
  }
  const value = input.trim();
  if (!value || value.length > MAX_HOST_ORIGIN_LENGTH || controlCharacterPattern.test(value)
    || value.includes('?') || value.includes('#') || value.includes('\\')) {
    throw new HostSettingsError('invalid-origin', 'Usá solo el origen HTTPS, sin ruta, consulta ni fragmento.');
  }
  const schemeEnd = value.indexOf('://');
  if (schemeEnd < 0) {
    throw new HostSettingsError('invalid-origin', 'La dirección debe empezar con https://.');
  }
  const authorityAndPath = schemeEnd >= 0 ? value.slice(schemeEnd + 3) : value;
  const pathStart = authorityAndPath.indexOf('/');
  if (pathStart >= 0 && authorityAndPath.slice(pathStart) !== '/') {
    throw new HostSettingsError('invalid-origin', 'Usá solo el origen HTTPS, sin ruta, consulta ni fragmento.');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HostSettingsError('invalid-origin', 'La dirección HTTPS no es válida.');
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash || url.origin === 'null') {
    throw new HostSettingsError('invalid-origin', 'Usá solo un origen HTTPS, sin credenciales ni ruta.');
  }
  return url.origin;
}

function randomHostId(): string {
  return `host-${randomUUID()}`;
}

function createUniqueHostId(devices: HostDevice[]): string {
  let id = randomHostId();
  while (devices.some(device => device.id === id)) id = randomHostId();
  return id;
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every(key => allowed.includes(key));
}

function parseSettings(value: unknown): HostSettings {
  if (!value || typeof value !== 'object') throw invalidSettings('La configuración de equipos no es un objeto.');
  const record = value as { version?: unknown; revision?: unknown; devices?: unknown; selected?: unknown };
  if (!hasOnlyKeys(record, ['version', 'revision', 'devices', 'selected'])
    || !Object.prototype.hasOwnProperty.call(record, 'selected')
    || record.version !== HOST_SETTINGS_VERSION || !Array.isArray(record.devices) || record.devices.length > MAX_HOSTS) {
    throw invalidSettings('La configuración de equipos no corresponde a la versión admitida.');
  }
  const revision = record.revision === undefined ? 0 : record.revision;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
    throw invalidSettings('La revisión de la configuración no es válida.');
  }

  const devices: HostDevice[] = [];
  for (const item of record.devices) {
    if (!item || typeof item !== 'object') throw invalidSettings('Hay un equipo con datos incompletos.');
    const device = item as { id?: unknown; name?: unknown; origin?: unknown };
    if (!hasOnlyKeys(device, ['id', 'name', 'origin'])) throw invalidSettings('Hay un equipo con campos desconocidos.');
    let id: string;
    let name: string;
    let origin: string;
    try {
      id = normalizeId(device.id);
      name = normalizeName(device.name);
      origin = normalizeHostOrigin(device.origin as string);
    } catch {
      throw invalidSettings('Hay un equipo con datos no válidos.');
    }
    if (devices.some(existing => existing.id === id || existing.origin === origin)) {
      throw invalidSettings('La configuración contiene equipos repetidos.');
    }
    devices.push({ id, name, origin });
  }

  let selected: string | null = null;
  if (record.selected !== null) {
    try {
      selected = normalizeId(record.selected);
    } catch {
      throw invalidSettings('El equipo seleccionado no es válido.');
    }
    if (!devices.some(device => device.id === selected)) selected = null;
  }
  return { version: HOST_SETTINGS_VERSION, devices, selected, revision: revision as number };
}

export function addHost(settings: HostSettings, input: HostInput): HostSettings {
  const current = parseSettings(settings);
  if (current.devices.length >= MAX_HOSTS) {
    throw new HostSettingsError('limit-reached', `Podés guardar hasta ${MAX_HOSTS} equipos.`);
  }
  const name = normalizeName(input.name);
  const origin = normalizeHostOrigin(input.origin);
  if (current.devices.some(device => device.origin === origin)) {
    throw new HostSettingsError('duplicate-origin', 'Ese equipo ya está guardado.');
  }
  const id = input.id === undefined ? createUniqueHostId(current.devices) : normalizeId(input.id);
  if (current.devices.some(device => device.id === id)) {
    throw new HostSettingsError('invalid-id', 'El identificador del equipo ya está en uso.');
  }
  const device = { id, name, origin };
  return {
    version: HOST_SETTINGS_VERSION,
    devices: [...current.devices, device],
    selected: current.selected ?? id,
    revision: current.revision,
  };
}

export function selectHost(settings: HostSettings, id: string): HostSettings {
  const current = parseSettings(settings);
  const selected = normalizeId(id);
  if (!current.devices.some(device => device.id === selected)) {
    throw new HostSettingsError('device-not-found', 'El equipo seleccionado ya no existe.');
  }
  return { ...current, selected, revision: current.revision };
}

export function removeHost(settings: HostSettings, id: string): HostSettings {
  const current = parseSettings(settings);
  const removed = normalizeId(id);
  if (!current.devices.some(device => device.id === removed)) {
    throw new HostSettingsError('device-not-found', 'El equipo seleccionado ya no existe.');
  }
  const devices = current.devices.filter(device => device.id !== removed);
  const selected = current.selected === removed ? null : current.selected;
  return { version: HOST_SETTINGS_VERSION, devices, selected, revision: current.revision };
}

export function getSelectedHostOrigin(settings: HostSettings): string | null {
  const current = parseSettings(settings);
  return current.devices.find(device => device.id === current.selected)?.origin ?? null;
}

function serializeSettings(settings: HostSettings, revision = settings.revision ?? 0): string {
  const normalized = parseSettings(settings);
  return `${JSON.stringify({ ...normalized, revision }, null, 2)}\n`;
}

type JournalCandidate = {
  name: string;
  file: File;
  raw: string | null;
  valid: boolean;
  revision: number;
  oversized: boolean;
};

/**
 * The SDK 57 move API may remove a destination before a move failure. Keep two
 * complete JSON slots so a failed replacement leaves another valid snapshot.
 * The temporary file is written in the same document directory, and writes
 * are serialized. A restart scans both slots and chooses the highest valid
 * revision; an unfinished temporary file is ignored.
 */
export function createExpoHostSettingsStorage(): HostSettingsStorage {
  const file = (name: string) => new File(Paths.document, name);
  const temporary = () => file(HOST_SETTINGS_TEMP_FILE_NAME);
  const slotNames = [HOST_SETTINGS_SLOT_A_FILE_NAME, HOST_SETTINGS_SLOT_B_FILE_NAME] as const;
  const candidates = () => [
    ...slotNames.map(name => ({ name, file: file(name) })),
    { name: HOST_SETTINGS_FILE_NAME, file: file(HOST_SETTINGS_FILE_NAME) },
  ];
  const inspect = async ({ name, file: target }: { name: string; file: File }): Promise<JournalCandidate> => {
    if (!target.exists) return { name, file: target, raw: null, valid: false, revision: -1, oversized: false };
    // File.size is nullable in Expo SDK 57. If it is unavailable, do not read
    // an unbounded file just to discover whether it exceeds the limit.
    if (target.size === null || !Number.isSafeInteger(target.size)
      || target.size < 0 || target.size > MAX_HOST_SETTINGS_BYTES) {
      return { name, file: target, raw: null, valid: false, revision: -1, oversized: true };
    }
    const raw = await target.text();
    try {
      const settings = parseSettings(JSON.parse(raw));
      return { name, file: target, raw, valid: true, revision: settings.revision ?? 0, oversized: false };
    } catch {
      return { name, file: target, raw, valid: false, revision: -1, oversized: false };
    }
  };
  const inspectAll = () => Promise.all(candidates().map(inspect));
  const validFirst = (entries: JournalCandidate[]) => entries
    .filter(entry => entry.valid && entry.raw !== null)
    .sort((left, right) => right.revision - left.revision);
  let writeQueue: Promise<void> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = writeQueue.then(task, task);
    writeQueue = run.then(() => undefined, () => undefined);
    return run;
  };

  return {
    async readText() {
      const entries = await inspectAll();
      if (entries.some(entry => entry.oversized)) {
        throw invalidSettings('La lista de equipos guardada es demasiado grande.');
      }
      const valid = validFirst(entries);
      if (valid.length) return valid[0].raw;
      return entries.find(entry => entry.raw !== null)?.raw ?? null;
    },
    writeTextAtomically(text: string) {
      return enqueue(async () => {
        const entries = await inspectAll();
        const invalidSnapshot = entries.some(entry =>
          entry.oversized || (entry.raw !== null && !entry.valid));
        if (invalidSnapshot) {
          throw new HostSettingsError('invalid-settings', 'Hay un snapshot desconocido. Se conserva y requiere una migración explícita.');
        }

        let incoming: HostSettings;
        try {
          incoming = parseSettings(JSON.parse(text));
        } catch {
          throw invalidSettings('La configuración de equipos que se quiere guardar no es válida.');
        }
        const valid = validFirst(entries);
        const currentRevision = valid.length ? valid[0].revision : 0;
        const nextRevision = currentRevision + 1;
        if (!Number.isSafeInteger(nextRevision)) {
          throw invalidSettings('La revisión de la configuración agotó su límite.');
        }
        if (incoming.revision !== nextRevision) {
          throw new HostSettingsError('stale-settings', 'La lista de equipos cambió. Volvé a cargarla antes de guardar otra modificación.');
        }

        const validSlots = valid.filter(entry => slotNames.includes(entry.name as typeof slotNames[number]));

        let targetName: string = HOST_SETTINGS_SLOT_A_FILE_NAME;
        if (validSlots.length === 1) {
          targetName = validSlots[0].name === HOST_SETTINGS_SLOT_A_FILE_NAME
            ? HOST_SETTINGS_SLOT_B_FILE_NAME : HOST_SETTINGS_SLOT_A_FILE_NAME;
        } else if (validSlots.length > 1) {
          targetName = validSlots[validSlots.length - 1].name;
        }
        const target = file(targetName);
        const temp = temporary();
        try {
          if (temp.exists) temp.delete();
          temp.write(text);
          await temp.move(target, { overwrite: true });
        } catch (error) {
          try {
            if (temp.exists) temp.delete();
          } catch {
            // Preserve the original write/move error for the recoverable result.
          }
          throw error;
        }
      });
    },
  };
}

export function createHostSettingsAdapter(storage: HostSettingsStorage = createExpoHostSettingsStorage()): HostSettingsAdapter {
  let saveQueue: Promise<void> = Promise.resolve();
  const enqueueSave = <T>(task: () => Promise<T>): Promise<T> => {
    const run = saveQueue.then(task, task);
    saveQueue = run.then(() => undefined, () => undefined);
    return run;
  };

  return {
    async load() {
      let raw: string | null;
      try {
        raw = await storage.readText();
      } catch (error) {
        return {
          settings: createDefaultHostSettings(),
          error: operationError(error, 'read-failed', 'No se pudo leer la lista de equipos. Podés volver a intentarlo.'),
        };
      }
      if (raw === null) return { settings: createDefaultHostSettings() };
      if (raw.length > MAX_HOST_SETTINGS_BYTES) {
        return {
          settings: createDefaultHostSettings(),
          error: { code: 'invalid-settings', message: 'La lista de equipos guardada es demasiado grande.' },
        };
      }
      try {
        return { settings: parseSettings(JSON.parse(raw)) };
      } catch {
        return {
          settings: createDefaultHostSettings(),
          error: { code: 'invalid-settings', message: 'La lista de equipos guardada no es válida.' },
        };
      }
    },
    save(settings) {
      return enqueueSave(async () => {
        let raw: string | null;
        try {
          raw = await storage.readText();
        } catch (error) {
          return { ok: false, error: operationError(error, 'read-failed', 'No se pudo leer la lista de equipos. Podés volver a intentarlo.') };
        }

        let current: HostSettings;
        if (raw === null) {
          current = createDefaultHostSettings();
        } else if (raw.length > MAX_HOST_SETTINGS_BYTES) {
          return { ok: false, error: { code: 'invalid-settings', message: 'La lista de equipos guardada es demasiado grande.' } };
        } else {
          try {
            current = parseSettings(JSON.parse(raw));
          } catch (error) {
            return { ok: false, error: operationError(error, 'invalid-settings', 'La lista de equipos guardada no es válida.') };
          }
        }

        let normalized: HostSettings;
        try {
          normalized = parseSettings(settings);
        } catch (error) {
          return { ok: false, error: operationError(error, 'invalid-settings', 'La configuración de equipos no es válida.') };
        }
        const expectedRevision = normalized.revision ?? 0;
        const currentRevision = current.revision ?? 0;
        if (expectedRevision !== currentRevision) {
          return { ok: false, error: {
            code: 'stale-settings',
            message: 'La lista de equipos cambió. Volvé a cargarla antes de guardar otra modificación.',
          } };
        }

        const revision = currentRevision + 1;
        if (!Number.isSafeInteger(revision)) {
          return { ok: false, error: { code: 'invalid-settings', message: 'La revisión de la configuración agotó su límite.' } };
        }
        const persisted = { ...normalized, revision };
        const text = serializeSettings(persisted, revision);
        try {
          await storage.writeTextAtomically(text);
        } catch (error) {
          return { ok: false, error: operationError(error, 'write-failed', 'No se pudo guardar la lista de equipos. Podés volver a intentarlo.') };
        }
        return { ok: true, settings: persisted };
      });
    },
  };
}

let defaultAdapter: HostSettingsAdapter | undefined;
export function getHostSettingsAdapter(): HostSettingsAdapter {
  return defaultAdapter ??= createHostSettingsAdapter(createExpoHostSettingsStorage());
}

// Lazy indirection keeps importing this module safe in tests and during the
// initial render before Expo has initialized its native filesystem module.
export const hostSettingsAdapter: HostSettingsAdapter = {
  load: () => getHostSettingsAdapter().load(),
  save: settings => getHostSettingsAdapter().save(settings),
};

export async function loadSelectedHost(adapter: HostSettingsAdapter = hostSettingsAdapter): Promise<HostSettingsLoadResult & { origin: string | null }> {
  const result = await adapter.load();
  return { ...result, origin: getSelectedHostOrigin(result.settings) };
}
