import { Buffer } from 'buffer';
import * as Clipboard from 'expo-clipboard';
import type { Connection } from './connection';
export function validateClipboardText(text: unknown): asserts text is string {
 if (typeof text !== 'string' || text.includes('\0') || Buffer.from(text, 'utf8').toString('utf8') !== text || Buffer.byteLength(text, 'utf8') > 128 * 1024) {
  throw Error('El límite es 128 KiB de texto, sin caracteres incompletos.');
 }
 if (!text) throw Error('No hay texto copiado.');
}
export async function readPhoneClipboardText() {
 const text = await Clipboard.getStringAsync();
 validateClipboardText(text);
 return text;
}
export async function transferClipboard(connection: Connection, direction: 'phone' | 'host', signal: AbortSignal) {
 const epoch = connection.capabilities?.sessionEpoch;
 if (!epoch || !connection.canClipboard) throw Error('El portapapeles no está disponible en esta sesión.');
 if (signal.aborted) throw Error('La copia se canceló.');
 const text = direction === 'host' ? await readPhoneClipboardText() : undefined;
 if (signal.aborted || epoch !== connection.capabilities?.sessionEpoch || !connection.canClipboard) throw Error('La sesión cambió.');
 const controller = new AbortController();
 const abort = () => controller.abort();
 signal.addEventListener('abort', abort, {once:true});
 const timeout = setTimeout(abort, 6000);
 try {
 const response = await fetch(connection.origin + '/api/clipboard', {
  method: direction === 'host' ? 'POST' : 'GET', signal: controller.signal, credentials: 'include',
  headers: { Origin: connection.origin, 'Content-Type': 'application/json', 'X-PhonePad-Session': epoch },
  body: text === undefined ? undefined : JSON.stringify({ text }),
 });
 if (!response.ok) throw Error('No se confirmó la copia. Revisá permisos y compatibilidad; no se reintenta automáticamente.');
 const result = await response.json();
 if (signal.aborted || controller.signal.aborted || epoch !== connection.capabilities?.sessionEpoch || result?.sessionEpoch !== epoch || !connection.canClipboard) throw Error('La sesión cambió. La copia requiere revisión.');
 if (direction === 'phone') {
  validateClipboardText(result.text);
  if (!await Clipboard.setStringAsync(result.text)) throw Error('No se pudo copiar al iPhone.');
 } else if (result.state !== 'ready') throw Error('El equipo no confirmó la copia.');
 } finally {
  clearTimeout(timeout); signal.removeEventListener('abort', abort);
 }
}
