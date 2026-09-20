import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export type TransferLimits = { version: 2; maxFiles: number; maxBytes: number; maxChunkBytes: number; ttlSeconds: number };
export type TransferFile = { name: string; type: string; bytes: number; sha256: string };
export type TransferManifest = { version: 2; id: string; files: TransferFile[] };
export type PreparedBatch = { origin: string; manifest: TransferManifest; createdAt: number };
export type TransferStatus = {
  version: 2; id: string; state: 'receiving' | 'stored' | 'cancelled'; folder?: string;
  files: Array<TransferFile & { index: number; receivedBytes: number }>;
  clipboard?: { state: 'unrequested' | 'ready' | 'unavailable' | 'uncertain'; replayed?: boolean };
};
export type ChunkReader = (id: string, index: number, offset: number, count: number) => Uint8Array;
const route = '/api/file-transfers';
const integer = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

export function checksum(data: Uint8Array): string { return bytesToHex(sha256(data)); }
export function assertActive(signal: AbortSignal) {
  if (signal.aborted) throw Error('Envío pausado. Podés reanudar el mismo lote.');
}

// One bounded request at a time. A lost response is recovered by beginning the
// SAME manifest again; nothing implicitly retries a clipboard action.
async function request(origin: string, query: string, method: string, signal: AbortSignal, body?: string | Uint8Array, digest?: string): Promise<unknown> {
  assertActive(signal);
  const abort = new AbortController();
  const stop = () => abort.abort();
  signal.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, 30000);
  try {
    const response = await fetch(origin + route + query, {
      method, credentials: 'include', signal: abort.signal,
      headers: { Origin: origin, ...(body !== undefined ? { 'Content-Type': typeof body === 'string' ? 'application/json' : 'application/octet-stream' } : {}), ...(digest ? { 'X-Chunk-SHA256': digest } : {}) },
      body: body instanceof Uint8Array ? new Uint8Array(body).buffer : body,
    });
    if (!response.ok) throw Error(response.status === 401 || response.status === 403 ? 'Este dispositivo no está autorizado.'
      : response.status === 404 ? 'Actualizá Phonepad en la computadora para enviar lotes reanudables.'
        : response.status === 409 ? 'El lote no coincide con el guardado. Conservamos la selección para revisarla.'
          : response.status === 410 ? 'El lote venció o se canceló. Revisá la selección y creá un envío nuevo.'
            : response.status === 429 ? 'Hay otros envíos pendientes. Pausá o completá uno antes de continuar.'
              : response.status === 507 ? 'La computadora no tiene espacio disponible para el lote.' : 'La computadora no pudo confirmar el lote. Podés reanudarlo.');
    return await response.json();
  } finally { clearTimeout(timer); signal.removeEventListener('abort', stop); }
}

export async function transferLimits(origin: string, signal: AbortSignal): Promise<TransferLimits> {
  const value = await request(origin, '', 'GET', signal) as TransferLimits;
  if (!value || value.version !== 2 || !integer(value.maxFiles) || value.maxFiles < 1 || value.maxFiles > 20
    || !integer(value.maxBytes) || value.maxBytes < 1 || value.maxBytes > 100 * 1024 * 1024
    || !integer(value.maxChunkBytes) || value.maxChunkBytes < 1 || value.maxChunkBytes > 1024 * 1024
    || !integer(value.ttlSeconds) || value.ttlSeconds < 1) throw Error('La computadora no ofrece límites de transferencia compatibles. Actualizá Phonepad.');
  return value;
}

export function verifiedStatus(value: unknown, manifest: TransferManifest): TransferStatus {
  const status = value as TransferStatus;
  const bad = () => Error('No se pudo verificar el recibo. Conservamos el lote para consultarlo.');
  if (!status || status.version !== 2 || status.id !== manifest.id || !['receiving', 'stored', 'cancelled'].includes(status.state)
    || !Array.isArray(status.files) || status.files.length !== manifest.files.length) throw bad();
  status.files.forEach((file, index) => {
    const expected = manifest.files[index];
    if (!file || file.index !== index || file.name !== `${index + 1}-${expected.name}` || file.type !== expected.type
      || file.bytes !== expected.bytes || file.sha256 !== expected.sha256 || !integer(file.receivedBytes)
      || file.receivedBytes > expected.bytes || (status.state === 'stored' && file.receivedBytes !== expected.bytes)) throw bad();
  });
  if (status.state === 'stored' && (typeof status.folder !== 'string' || !status.folder)) throw bad();
  if (status.clipboard && (!['unrequested', 'ready', 'unavailable', 'uncertain'].includes(status.clipboard.state)
    || (status.clipboard.replayed !== undefined && typeof status.clipboard.replayed !== 'boolean'))) throw bad();
  return status;
}

export async function sendPreparedBatch(batch: PreparedBatch, limits: TransferLimits, read: ChunkReader, signal: AbortSignal, progress: (percent: number) => void): Promise<TransferStatus> {
  const { origin, manifest } = batch;
  const total = manifest.files.reduce((n, file) => n + file.bytes, 0);
  if (manifest.files.length > limits.maxFiles || total > limits.maxBytes) throw Error('El lote supera los límites de esta computadora.');
  let status = verifiedStatus(await request(origin, '?action=begin', 'POST', signal, JSON.stringify(manifest)), manifest);
  if (status.state === 'cancelled') throw Error('Este lote se canceló. Creá una nueva selección.');
  const report = () => progress(total ? Math.floor(status.files.reduce((n, f) => n + f.receivedBytes, 0) / total * 100) : 100);
  report();
  for (let index = 0; index < manifest.files.length && status.state === 'receiving'; index++) {
    while (status.files[index].receivedBytes < manifest.files[index].bytes) {
      assertActive(signal);
      const offset = status.files[index].receivedBytes;
      const count = Math.min(limits.maxChunkBytes, 256 * 1024, manifest.files[index].bytes - offset);
      const data = read(manifest.id, index, offset, count);
      if (data.byteLength !== count) throw Error('La copia local del archivo cambió. Revisá el lote antes de continuar.');
      const next = verifiedStatus(await request(origin, `?id=${manifest.id}&index=${index}&offset=${offset}`, 'PUT', signal, data, checksum(data)), manifest);
      if (next.state !== 'receiving' || next.files[index].receivedBytes !== offset + count
        || next.files.some((file, i) => i !== index && file.receivedBytes !== status.files[i].receivedBytes)) throw Error('La computadora confirmó un avance inesperado. Consultá el lote antes de continuar.');
      status = next; report();
    }
  }
  if (status.state === 'stored') return status;
  assertActive(signal);
  return verifiedStatus(await request(origin, `?action=commit&id=${manifest.id}`, 'POST', signal), manifest);
}

export async function queryPreparedBatch(batch: PreparedBatch, signal: AbortSignal): Promise<TransferStatus> {
  return verifiedStatus(await request(batch.origin, `?id=${batch.manifest.id}`, 'GET', signal), batch.manifest);
}
export async function copyPreparedBatch(batch: PreparedBatch, signal: AbortSignal): Promise<TransferStatus> {
  const status = verifiedStatus(await request(batch.origin, `?action=clipboard&id=${batch.manifest.id}`, 'POST', signal), batch.manifest);
  if (status.state !== 'stored' || !status.clipboard || status.clipboard.state === 'unrequested') throw Error('No se pudo confirmar el portapapeles. Los archivos siguen guardados.');
  return status;
}
export async function cancelPreparedBatch(batch: PreparedBatch, signal: AbortSignal): Promise<TransferStatus> {
  // Carry the immutable manifest so cancellation can reserve a tombstone even
  // if begin never arrived. Cleanup stays available after upload permission is
  // revoked and must not depend on issuing a newly authorized begin request.
  return verifiedStatus(await request(batch.origin, `?action=cancel&id=${batch.manifest.id}`, 'POST', signal,
    JSON.stringify(batch.manifest)), batch.manifest);
}
