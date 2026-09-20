import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { Buffer } from 'buffer';
import type { AttachmentBatch } from './attachments';
import { assertActive, type PreparedBatch, type TransferLimits } from './file-transfer';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ttl = 24 * 60 * 60 * 1000;
const maxBytes = 100 * 1024 * 1024;
const root = () => new Directory(Paths.cache, 'phonepad-file-transfers-v2');
const folder = (id: string) => {
  if (!uuid.test(id)) throw Error('Identidad de lote inválida.');
  return new Directory(root(), id);
};
const part = (id: string, index: number) => {
  if (!Number.isInteger(index) || index < 0 || index >= 20) throw Error('Archivo de lote inválido.');
  return new File(folder(id), `${index}.data`);
};
const validName = (name: string) => !!name && name !== '.' && name !== '..'
  && Buffer.byteLength(name, 'utf8') <= 180 && !/[\/\\\u0000-\u001f\u007f-\u009f]/.test(name);
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function writeJSON(file: File, value: unknown) { file.create(); file.write(JSON.stringify(value)); }

function owner(dir: Directory): { version: 2; id: string; origin: string; createdAt: number } | null {
  try {
    const marker = new File(dir, 'owner.json');
    if (!marker.exists || marker.size > 2048) return null;
    const value = JSON.parse(marker.textSync());
    return value?.version === 2 && value.id === dir.name && uuid.test(value.id) && typeof value.origin === 'string'
      && Number.isSafeInteger(value.createdAt) && value.createdAt > 0 ? value : null;
  } catch { return null; }
}

function ownedFolders(): Directory[] {
  const base = root();
  if (!base.exists) return [];
  const active: Directory[] = [];
  for (const entry of base.list()) {
    if (!(entry instanceof Directory) || !uuid.test(entry.name)) continue;
    const marker = owner(entry);
    if (!marker) continue;
    if (Date.now() - marker.createdAt > ttl) { entry.delete(); continue; }
    active.push(entry);
  }
  return active;
}

export function discardPreparedBatch(id: string): void {
  const dir = folder(id);
  if (dir.exists && owner(dir)) dir.delete();
}

export function restorePreparedBatch(origin: string): PreparedBatch | null {
  const candidates: PreparedBatch[] = [];
  for (const dir of ownedFolders()) {
    const marker = owner(dir);
    if (marker?.origin !== origin) continue;
    try {
      const metadata = new File(dir, 'manifest.json');
      if (!metadata.exists || metadata.size > 32768) continue;
      const batch = JSON.parse(metadata.textSync()) as PreparedBatch;
      if (batch.origin !== origin || batch.createdAt !== marker.createdAt || batch.manifest?.version !== 2
        || batch.manifest.id !== marker.id || !Array.isArray(batch.manifest.files)
        || batch.manifest.files.length < 1 || batch.manifest.files.length > 20) continue;
      if (batch.manifest.files.some((f, index) => !f || typeof f.name !== 'string' || !validName(f.name)
        || typeof f.type !== 'string' || f.type.length > 128 || !Number.isSafeInteger(f.bytes) || f.bytes < 0
        || !/^[a-f0-9]{64}$/.test(f.sha256) || !part(marker.id, index).exists || part(marker.id, index).size !== f.bytes)
        || batch.manifest.files.reduce((n, f) => n + f.bytes, 0) > maxBytes) continue;
      candidates.push(batch);
    } catch { /* Incomplete preparation has never been sent; expires with owner. */ }
  }
  return candidates.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

// Snapshot provider assets once. Retries read these same bytes, even if Photos,
// iCloud or the original document later changes. Memory is bounded to 256 KiB.
export async function prepareBatch(origin: string, batch: AttachmentBatch, limits: TransferLimits, signal: AbortSignal, progress: (text: string) => void): Promise<PreparedBatch> {
  assertActive(signal);
  if (!batch.items.length || batch.items.length > limits.maxFiles) throw Error(`Elegí hasta ${limits.maxFiles} archivos.`);
  if (batch.items.some(f => !validName(f.name) || f.type.length > 128)) throw Error('Uno de los archivos tiene un nombre demasiado largo o no válido.');
  const existing = ownedFolders();
  if (existing.length >= 4) throw Error('Hay otros lotes en el teléfono. Completalos o descartalos antes de preparar otro.');
  const dir = folder(batch.id);
  if (dir.exists) throw Error('El lote ya tiene una copia local. Reanudalo desde la selección pendiente.');
  dir.create({ intermediates: true });
  const prepared: PreparedBatch = { origin, createdAt: Date.now(), manifest: { version: 2, id: batch.id, files: [] } };
  try {
    writeJSON(new File(dir, 'owner.json'), { version: 2, id: batch.id, origin, createdAt: prepared.createdAt });
    let total = 0;
    for (let index = 0; index < batch.items.length; index++) {
      assertActive(signal);
      const item = batch.items[index];
      progress(`Preparando ${index + 1} de ${batch.items.length}…`);
      const source = new File(item.uri).open(FileMode.ReadOnly);
      let target: ReturnType<File['open']> | undefined;
      const hash = sha256.create();
      let bytes = 0;
      try {
        const destination = part(batch.id, index);
        destination.create(); target = destination.open(FileMode.WriteOnly);
        while (true) {
          assertActive(signal);
          const data = source.readBytes(Math.min(256 * 1024, limits.maxBytes - total + 1));
          if (!data.length) break;
          total += data.length;
          if (total > limits.maxBytes) throw Error(`El envío admite hasta ${Math.floor(limits.maxBytes / 1024 / 1024)} MB en total.`);
          target.writeBytes(data); hash.update(data); bytes += data.length;
          await tick();
        }
      } finally { source.close(); target?.close(); }
      prepared.manifest.files.push({ name: item.name, type: item.type, bytes, sha256: bytesToHex(hash.digest()) });
    }
    assertActive(signal);
    writeJSON(new File(dir, 'manifest.json'), prepared);
    return prepared;
  } catch (error) { try { dir.delete(); } catch { /* Owned incomplete copy expires. */ } throw error; }
}

export function readPreparedChunk(id: string, index: number, offset: number, count: number): Uint8Array {
  const handle = part(id, index).open(FileMode.ReadOnly);
  try { handle.offset = offset; return handle.readBytes(count); }
  finally { handle.close(); }
}
