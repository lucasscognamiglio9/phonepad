/** Only known, actionable descriptions reach the UI; technical errors stay out. */
export function noticeMessage(error: unknown, fallback: string): string {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  if (/habilitar Cámara|camera.*permission|cámara.*permiso/i.test(message)) return 'Habilitá Cámara en Configuración.';
  if (/cámara no está disponible/i.test(message)) return 'Cámara no disponible.';
  const count = /hasta (\d+) (archivos|fotos)/i.exec(message);
  if (count) return `Elegí hasta ${count[1]} ${count[2].toLowerCase()}.`;
  if (/supera.*tamaño|hasta 100 MB|demasiado grande|excede.*límite/i.test(message)) return 'La selección supera el tamaño permitido.';
  if (/portapapeles|clipboard/i.test(message)) return 'No se pudo preparar el portapapeles.';
  if (/no permite recibir/i.test(message)) return 'Este equipo no permite recibir archivos.';
  if (/cambió la conexión|cambio.*sesión|session.*changed/i.test(message)) return 'Conexión cambiada. Revisá el envío.';
  return fallback;
}

/** Storage adapters can include paths or low-level errors; present by code. */
export function hostSettingsNotice(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  const messages: Record<string, string> = {
    'invalid-origin': 'Ingresá una dirección HTTPS sin ruta ni credenciales.',
    'invalid-name': 'Escribí un nombre de hasta 80 caracteres.',
    'invalid-id': 'No se pudo identificar el equipo.',
    'duplicate-origin': 'Ese equipo ya está guardado.',
    'limit-reached': 'Ya alcanzaste el límite de equipos.',
    'device-not-found': 'Ese equipo ya no está guardado.',
    'stale-settings': 'La lista cambió. Volvé a abrir Equipos.',
    'invalid-settings': 'No se pudo leer la lista guardada.',
    'read-failed': 'No se pudo cargar la lista de equipos.',
    'write-failed': 'No se pudo guardar la lista de equipos.',
  };
  return messages[code] ?? 'No se pudo actualizar la lista de equipos.';
}
