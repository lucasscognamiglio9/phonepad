import { Buffer } from 'buffer';
import * as Clipboard from 'expo-clipboard';
import type { Connection } from './connection';
export async function transferClipboard(connection: Connection, direction: 'phone' | 'host', signal: AbortSignal) {
 const epoch = connection.capabilities?.sessionEpoch;
 if (!epoch || !connection.canClipboard) throw Error('El portapapeles no está disponible en esta sesión.');
 const text = direction === 'host' ? await Clipboard.getStringAsync() : undefined;
 if (text !== undefined && (Buffer.byteLength(text, 'utf8') > 128 * 1024 || text.includes('\0'))) throw Error('El límite es 128 KiB de texto, sin caracteres nulos.');
 if (signal.aborted || epoch !== connection.capabilities?.sessionEpoch) throw Error('La sesión cambió.');
 const response = await fetch(connection.origin + '/api/clipboard', {
  method: direction === 'host' ? 'POST' : 'GET', signal,
  headers: { Origin: connection.origin, 'Content-Type': 'application/json', 'X-PhonePad-Session': epoch },
  body: text === undefined ? undefined : JSON.stringify({ text }),
 });
 if (!response.ok) throw Error('No se confirmó la copia. Revisá permisos y compatibilidad; no se reintenta automáticamente.');
 const result = await response.json();
 if (signal.aborted || epoch !== connection.capabilities?.sessionEpoch || result.sessionEpoch !== epoch || !connection.canClipboard) throw Error('La sesión cambió. La copia requiere revisión.');
 if (direction === 'phone') {
  if (typeof result.text !== 'string' || Buffer.byteLength(result.text, 'utf8') > 128 * 1024) throw Error('Respuesta de clipboard inválida.');
  await Clipboard.setStringAsync(result.text);
 } else if (result.state !== 'ready') throw Error('El equipo no confirmó la copia.');
}

// Explicit recovery for editors that do not expose an AT-SPI editable field.
// The caller owns the draft and must not interpret a clipboard acknowledgement
// as proof that the destination app pasted it.
export async function offerTextToHostClipboard(connection: Connection, text: string, signal: AbortSignal) {
 const epoch = connection.capabilities?.sessionEpoch;
 if (!epoch || !connection.canClipboard) throw Error('El portapapeles no está disponible en esta sesión.');
 if (!text || text.includes('\0') || Buffer.from(text, 'utf8').toString('utf8') !== text || Buffer.byteLength(text, 'utf8') > 128 * 1024) {
  throw Error('El borrador contiene texto incompleto o supera 128 KiB.');
 }
 const response = await fetch(connection.origin + '/api/clipboard', {
  method: 'POST', signal,
  headers: { Origin: connection.origin, 'Content-Type': 'application/json', 'X-PhonePad-Session': epoch },
  body: JSON.stringify({ text }),
 });
 if (!response.ok) throw Error('No se pudo copiar el borrador al equipo.');
 const result = await response.json();
 if (signal.aborted || epoch !== connection.capabilities?.sessionEpoch || result.sessionEpoch !== epoch || result.state !== 'ready') {
  throw Error('No se confirmó la copia al equipo.');
 }
}
