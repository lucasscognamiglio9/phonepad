import { Buffer } from 'buffer';
import * as Crypto from 'expo-crypto';

export type InputCapabilities = {
  version: 1; session: string; textMode: 'literal-block';
  maxTextBytes: number; maxChunkBytes: number; maxChunks: number; maxOperations: number;
};
export type TextManifest = { version: 1; operationId: string; session: string; context: string;
  sequence: number; bytes: number; sha256: string };
export type TextReceipt = TextManifest & { state: 'receiving' | 'ready' | 'dispatching' | 'dispatched' | 'uncertain' | 'rejected' | 'cancelled';
  receivedBytes: number; nextChunk: number };
export type PendingText = { manifest: TextManifest; text: string; receipt?: TextReceipt };
export type LateDraft = { text: string; duplicate: boolean };

export function inputCapabilities(value: unknown): InputCapabilities | null {
  const v = value as InputCapabilities | null;
  if (!v || v.version !== 1 || v.textMode !== 'literal-block' || typeof v.session !== 'string'
    || !/^[a-zA-Z0-9_-]{1,64}$/.test(v.session)) return null;
  for (const [key, maximum] of [['maxTextBytes', 131072], ['maxChunkBytes', 16384], ['maxChunks', 128], ['maxOperations', 64]] as const) {
    if (!Number.isInteger(v[key]) || v[key] < 1 || v[key] > maximum) return null;
  }
  return { version: 1, session: v.session, textMode: 'literal-block', maxTextBytes: v.maxTextBytes,
    maxChunkBytes: v.maxChunkBytes, maxChunks: v.maxChunks, maxOperations: v.maxOperations };
}

// One controller per connection, retained across component unmount/reconnect.
// No retries or silent fallback to scancodes. A lost receipt requires status.
export class LiteralTransfer {
  draft = '';
  lateDraft: LateDraft | null = null;
  pending: PendingText | null = null;
  busy = false;
  private sequence = 0;
  private session = '';
  constructor(private origin: string, private capabilities: () => InputCapabilities | null,
    private sessionEpoch: () => string | null = () => null) {}
  private async request(body: object): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      // Recovery can inspect a retired text lease through a new control
      // connection. The request uses the current epoch, not the old lease ID.
      const epoch = this.sessionEpoch();
      const response = await fetch(this.origin + '/api/input', { method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', Origin: this.origin },
        body: JSON.stringify({ ...body, ...(epoch ? { sessionEpoch: epoch } : {}) }), signal: controller.signal });
      if (!response.ok) throw Error('No se pudo confirmar el envío. Tu borrador sigue acá.');
      return await response.json();
    } finally { clearTimeout(timeout); }
  }
  private receipt(value: unknown, manifest: TextManifest): TextReceipt {
    const wrapped = value as { receipt?: unknown } | null;
    const r = (wrapped?.receipt ?? value) as TextReceipt;
    if (!r || Object.keys(manifest).some(key => r[key as keyof TextManifest] !== manifest[key as keyof TextManifest])
      || !['receiving', 'ready', 'dispatching', 'dispatched', 'uncertain', 'rejected', 'cancelled'].includes(r.state)
      || !Number.isInteger(r.receivedBytes) || r.receivedBytes < 0 || r.receivedBytes > manifest.bytes
      || (r.state === 'dispatched' && r.receivedBytes !== manifest.bytes)
      || !Number.isInteger(r.nextChunk) || r.nextChunk < 0 || r.nextChunk > 128) {
      throw Error('No se pudo verificar el recibo. Revisá la computadora antes de continuar.');
    }
    return r;
  }
  async send(text: string): Promise<TextReceipt> {
    if (this.busy || this.pending) throw Error('Revisá el envío anterior antes de continuar.');
    const capabilities = this.capabilities();
    if (!capabilities) throw Error('La computadora no admite este envío de texto.');
    const data = Buffer.from(text, 'utf8');
    // Buffer replaces unpaired surrogates; detect that before accepting the draft.
    if (!text || text.includes('\0') || data.toString('utf8') !== text) throw Error('El texto contiene caracteres incompletos. Tu borrador sigue acá.');
    if (data.length > capabilities.maxTextBytes || Math.ceil(data.length / capabilities.maxChunkBytes) > capabilities.maxChunks) {
      throw Error('El texto supera el tamaño admitido. Dividilo en bloques; tu borrador sigue acá.');
    }
    this.busy = true;
    try {
      if (this.session !== capabilities.session) { this.session = capabilities.session; this.sequence = 0; }
      if (this.sequence >= capabilities.maxOperations) throw Error('Reconectá para seguir escribiendo. Tu borrador sigue acá.');
      const manifest: TextManifest = { version: 1, operationId: Crypto.randomUUID(), session: capabilities.session,
        context: 'composer', sequence: ++this.sequence, bytes: data.length,
        sha256: await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text) };
      if (this.capabilities()?.session !== manifest.session) throw Error('La conexión cambió. Tu borrador sigue acá.');
      this.pending = { manifest, text };
      const request = async (body: object) => {
        if (this.capabilities()?.session !== manifest.session) throw Error('La conexión cambió. Consultá el envío antes de continuar.');
        const r = this.receipt(await this.request({ ...body, session: manifest.session, operationId: manifest.operationId }), manifest);
        this.pending!.receipt = r; return r;
      };
      let receipt = await request({ op: 'begin', manifest });
      if (receipt.state !== 'receiving') return receipt;
      for (let offset = 0, index = 0; offset < data.length; offset += capabilities.maxChunkBytes, index++) {
        receipt = await request({ op: 'chunk', index, data: Buffer.from(data.subarray(offset, offset + capabilities.maxChunkBytes)).toString('base64') });
        if (receipt.state !== 'receiving' || receipt.nextChunk !== index + 1
          || receipt.receivedBytes !== Math.min(offset + capabilities.maxChunkBytes, data.length)) {
          throw Error('La transferencia se interrumpió. Tu borrador sigue acá.');
        }
      }
      receipt = await request({ op: 'commit' });
      return receipt;
    } finally { this.busy = false; }
  }
  async status(): Promise<TextReceipt> {
    if (this.busy || !this.pending) throw Error('No hay un envío disponible para consultar.');
    this.busy = true;
    try {
      const pending = this.pending;
      const { manifest } = pending;
      const receipt = this.receipt(await this.request({ op: 'status', session: manifest.session, operationId: manifest.operationId }), manifest);
      if (this.pending === pending) pending.receipt = receipt;
      return receipt;
    } finally { this.busy = false; }
  }
  // A terminal receipt returned by send/status is already verified locally.
  // Clear only those receipts synchronously; uncertain work still requires an
  // explicit review and a status query.
  acknowledged() {
    if (this.busy || !this.pending) return;
    const state = this.pending.receipt?.state;
    if (state === 'dispatched' || state === 'rejected' || state === 'cancelled') this.pending = null;
  }
  noteLateDraft(text: string, confirmedText: string): LateDraft {
    this.lateDraft = { text, duplicate: text === confirmedText };
    return this.lateDraft;
  }
  useLateDraft(): LateDraft | null {
    const late = this.lateDraft;
    if (late) {
      const current = this.draft;
      this.draft = late.text;
      this.lateDraft = current && current !== late.text ? { text: current, duplicate: false } : null;
    }
    return late;
  }
  discardLateDraft() { this.lateDraft = null; }
  // Forgetting a prepared operation must leave no staged text behind. The
  // server's cancel is idempotent from the client's point of view: a second
  // review first observes the cancelled receipt and does not send another
  // cancel request. Claimed work is queried before it can be forgotten.
  async reviewed(): Promise<boolean> {
    const pending = this.pending;
    if (this.busy || !pending) return false;
    let receipt = pending.receipt;
    if (!receipt || receipt.state === 'dispatching' || receipt.state === 'dispatched' || receipt.state === 'uncertain') {
      try { receipt = await this.status(); }
      catch { return false; }
    }
    if (this.pending !== pending) return false;
    if (receipt.state === 'receiving' || receipt.state === 'ready') {
      this.busy = true;
      try {
        const cancelled = this.receipt(await this.request({ op: 'cancel', session: pending.manifest.session,
          operationId: pending.manifest.operationId }), pending.manifest);
        pending.receipt = cancelled;
        if (cancelled.state !== 'cancelled') return false;
      } catch {
        // A lost cancel response may still have committed the tombstone. Read
        // it before deciding whether the local operation can be forgotten.
        this.busy = false;
        try { receipt = await this.status(); }
        catch { return false; }
        if (receipt.state !== 'cancelled') return false;
      } finally { this.busy = false; }
    } else if (receipt.state === 'dispatching') {
      return false;
    }
    if (this.pending === pending) this.pending = null;
    return true;
  }
}
