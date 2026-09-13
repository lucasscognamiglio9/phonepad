import * as Documents from 'expo-document-picker';
import * as Photos from 'expo-image-picker';

export type AttachmentSource = 'files' | 'camera' | 'photos';
export type Attachment = { uri: string; name: string; type: string; size?: number };
export type ClipboardKind = 'image' | 'file';
export type AttachmentReceipt = {
  name: string;
  bytes: number;
  folder: string;
  clipboard: 'ready' | 'unavailable';
  clipboardKind?: ClipboardKind;
  detail?: string;
};

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 115000;
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  avif: 'image/avif', bmp: 'image/bmp', gif: 'image/gif', heic: 'image/heic',
  heif: 'image/heif', jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png',
  tif: 'image/tiff', tiff: 'image/tiff', webp: 'image/webp',
};
const MIME_BY_EXTENSION: Record<string, string> = {
  ...IMAGE_MIME_BY_EXTENSION,
  csv: 'text/csv', json: 'application/json', pdf: 'application/pdf',
  txt: 'text/plain', zip: 'application/zip',
};
const IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
  'image/avif': 'avif', 'image/bmp': 'bmp', 'image/gif': 'gif', 'image/heic': 'heic',
  'image/heif': 'heif', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/tiff': 'tiff',
  'image/webp': 'webp',
};

function normalizeMime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const mime = value.trim().toLowerCase();
  return mime && mime.includes('/') ? mime : undefined;
}

function basename(uri: unknown): string | undefined {
  if (typeof uri !== 'string') return undefined;
  const withoutQuery = uri.split(/[?#]/, 1)[0];
  const value = withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1);
  return value || undefined;
}

function extension(name: string | undefined): string | undefined {
  const match = name?.match(/\.([a-z0-9]+)$/i);
  return match?.[1].toLowerCase();
}

function mimeForName(name: string | undefined): string | undefined {
  const ext = extension(name);
  return ext ? MIME_BY_EXTENSION[ext] : undefined;
}

function imageName(name: string | undefined, mime: string): string {
  const targetExtension = IMAGE_EXTENSION_BY_MIME[mime] || 'jpg';
  const candidate = name?.trim() || 'Foto';
  const currentExtension = extension(candidate);
  if (currentExtension && IMAGE_MIME_BY_EXTENSION[currentExtension] === mime) return candidate;
  const stem = currentExtension ? candidate.slice(0, -(currentExtension.length + 1)) : candidate;
  return `${stem || 'Foto'}.${targetExtension}`;
}

function documentAttachment(item: Documents.DocumentPickerAsset): Attachment {
  const name = typeof item.name === 'string' && item.name.trim() ? item.name : basename(item.uri) || 'Documento';
  return {
    uri: item.uri,
    name,
    type: normalizeMime(item.mimeType) || mimeForName(name) || 'application/octet-stream',
    size: typeof item.size === 'number' && Number.isFinite(item.size) ? item.size : undefined,
  };
}

function imageAttachment(item: Photos.ImagePickerAsset): Attachment {
  const candidate = typeof item.fileName === 'string' && item.fileName.trim() ? item.fileName : basename(item.uri);
  const declared = normalizeMime(item.mimeType);
  const type = declared?.startsWith('image/') ? declared : mimeForName(candidate) || 'image/jpeg';
  return {
    uri: item.uri,
    name: imageName(candidate, type),
    type,
    size: typeof item.fileSize === 'number' && Number.isFinite(item.fileSize) ? item.fileSize : undefined,
  };
}

function pickerAsset<T extends { uri: string }>(result: { canceled: boolean; assets?: T[] | null }): T | null {
  if (result.canceled) return null;
  return result.assets?.[0] || null;
}

function isCameraUnavailable(error: unknown): boolean {
  const value = typeof error === 'object' && error !== null
    ? `${String((error as { code?: unknown }).code || '')} ${String((error as { message?: unknown }).message || '')}`
    : String(error || '');
  return /camera.{0,24}(unavailable|not available|not found|does not exist)|no camera|camera_unavailable|e_camera_unavailable/i.test(value);
}

export async function chooseAttachment(source: AttachmentSource): Promise<Attachment | null> {
  if (source === 'files') {
    const result = await Documents.getDocumentAsync({ multiple: false, copyToCacheDirectory: true });
    const item = pickerAsset(result);
    return item ? documentAttachment(item) : null;
  }

  if (source === 'camera') {
    const permission = await Photos.requestCameraPermissionsAsync();
    if (!permission?.granted) throw Error('Podés habilitar Cámara para Phonepad en Configuración.');
  }

  // Ask Photos for a compatible representation without cropping or lowering
  // quality. The native picker supplies the resulting MIME; camera use does
  // not request microphone permission.
  const options: Photos.ImagePickerOptions = {
    mediaTypes: ['images'], allowsEditing: false, quality: 1,
    ...(source === 'photos' ? { preferredAssetRepresentationMode: Photos.UIImagePickerPreferredAssetRepresentationMode.Compatible } : {}),
  };
  let result: Photos.ImagePickerResult;
  try {
    result = source === 'camera' ? await Photos.launchCameraAsync(options) : await Photos.launchImageLibraryAsync(options);
  } catch (error) {
    if (source === 'camera' && isCameraUnavailable(error)) {
      throw Error('La cámara no está disponible en este dispositivo.');
    }
    throw error;
  }
  const item = pickerAsset(result);
  return item ? imageAttachment(item) : null;
}

function uploadReceipt(value: unknown): AttachmentReceipt {
  if (!value || typeof value !== 'object') throw Error('La computadora devolvió una respuesta inválida.');
  const body = value as Record<string, unknown>;
  const name = typeof body.name === 'string' && body.name.trim() ? body.name : undefined;
  const bytes = typeof body.bytes === 'number' && Number.isSafeInteger(body.bytes) && body.bytes >= 0 ? body.bytes : undefined;
  const folder = typeof body.folder === 'string' && body.folder.trim() ? body.folder : undefined;
  if (!name || bytes === undefined || !folder) throw Error('La computadora devolvió una respuesta incompleta.');

  const clipboard = body.clipboard === 'ready' ? 'ready' : 'unavailable';
  const kind = body.clipboardKind === 'image' || body.clipboardKind === 'file' ? body.clipboardKind : undefined;
  const detail = typeof body.detail === 'string' && body.detail ? body.detail : undefined;
  return { name, bytes, folder, clipboard, ...(kind ? { clipboardKind: kind } : {}), ...(detail ? { detail } : {}) };
}

function responseBody(request: XMLHttpRequest): unknown {
  const text = typeof request.responseText === 'string' ? request.responseText.trim() : '';
  if (text) {
    try { return JSON.parse(text); } catch { throw Error('La computadora devolvió una respuesta inválida.'); }
  }
  if (request.response && typeof request.response === 'object') return request.response;
  throw Error('La computadora no confirmó el archivo.');
}

export function sendAttachment(
  origin: string,
  item: Attachment,
  signal: AbortSignal,
  progress: (percent: number) => void,
): Promise<AttachmentReceipt> {
  if (typeof item.size === 'number' && item.size > MAX_UPLOAD_BYTES) {
    return Promise.reject(Error('Elegí un archivo de hasta 100 MB.'));
  }
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    let settled = false;
    const abort = () => {
      if (settled) return;
      try { request.abort(); } catch { /* The request may already have been torn down. */ }
      finish(Error('Transferencia cancelada.'));
    };
    const finish = (error?: Error, receipt?: AttachmentReceipt) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (request.upload) request.upload.onprogress = null;
      request.onload = request.onerror = request.ontimeout = request.onabort = null;
      if (error) reject(error); else resolve(receipt as AttachmentReceipt);
    };

    request.open('POST', origin + '/api/files');
    request.setRequestHeader('Origin', origin);
    request.timeout = UPLOAD_TIMEOUT_MS;
    request.upload.onprogress = event => {
      if (settled || !event.lengthComputable || event.total <= 0) return;
      const percent = Math.max(0, Math.min(100, Math.round(event.loaded / event.total * 100)));
      try { progress(percent); } catch { abort(); }
    };
    request.onload = () => {
      if (request.status !== 201) {
        finish(Error(request.status === 413 ? 'El archivo supera los 100 MB.'
          : request.status === 401 || request.status === 403 ? 'Este dispositivo no está autorizado.'
            : request.status === 408 || request.status === 504 ? 'La transferencia tardó demasiado. Probá con un archivo más pequeño.'
              : 'No se pudo guardar el archivo en la computadora.'));
        return;
      }
      try { finish(undefined, uploadReceipt(responseBody(request))); }
      catch (error) { finish(error instanceof Error ? error : Error('La computadora devolvió una respuesta inválida.')); }
    };
    request.onerror = () => finish(Error('Se interrumpió la conexión. El archivo no se completó.'));
    request.ontimeout = () => finish(Error('La transferencia tardó demasiado. Probá con un archivo más pequeño.'));
    request.onabort = () => finish(Error('Transferencia cancelada.'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try {
      const body = new FormData();
      body.append('file', { uri: item.uri, name: item.name, type: item.type } as unknown as Blob);
      body.append('intent', 'clipboard');
      request.send(body);
    } catch {
      finish(Error('No se pudo iniciar la transferencia. Volvé a seleccionar el archivo.'));
    }
  });
}
