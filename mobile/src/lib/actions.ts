import type { SymbolViewProps } from 'expo-symbols';

type Action = {
  label: string;
  symbol: Exclude<SymbolViewProps['name'], string>;
  fallback: string;
};

// Each action has an icon on every receiver. A bare SF Symbol string would
// render nothing on Android/web in expo-symbols 57.
export const ACTIONS = {
  showControls: { label: 'Mostrar controles', symbol: { ios: 'chevron.left', android: 'chevron_left', web: 'chevron_left' }, fallback: '‹' },
  hideControls: { label: 'Ocultar controles', symbol: { ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }, fallback: '›' },
  keyboard: { label: 'Teclado', symbol: { ios: 'keyboard', android: 'keyboard', web: 'keyboard' }, fallback: '⌨' },
  reconnect: { label: 'Reconectar', symbol: { ios: 'arrow.clockwise', android: 'refresh', web: 'refresh' }, fallback: '↻' },
  screen: { label: 'Ver pantalla', symbol: { ios: 'desktopcomputer', android: 'desktop_windows', web: 'desktop_windows' }, fallback: '▣' },
  hosts: { label: 'Equipos', symbol: { ios: 'laptopcomputer', android: 'laptop', web: 'laptop' }, fallback: '▣' },
  files: { label: 'Archivos', symbol: { ios: 'paperclip', android: 'attach_file', web: 'attach_file' }, fallback: '▤' },
  camera: { label: 'Cámara', symbol: { ios: 'camera', android: 'photo_camera', web: 'photo_camera' }, fallback: '◎' },
  photos: { label: 'Fotos', symbol: { ios: 'photo.on.rectangle', android: 'photo_library', web: 'photo_library' }, fallback: '▧' },
  remove: { label: 'Quitar', symbol: { ios: 'xmark', android: 'close', web: 'close' }, fallback: '×' },
  up: { label: 'Arriba', symbol: { ios: 'arrow.up', android: 'arrow_upward', web: 'arrow_upward' }, fallback: '↑' },
  left: { label: 'Izquierda', symbol: { ios: 'arrow.left', android: 'arrow_back', web: 'arrow_back' }, fallback: '←' },
  down: { label: 'Abajo', symbol: { ios: 'arrow.down', android: 'arrow_downward', web: 'arrow_downward' }, fallback: '↓' },
  right: { label: 'Derecha', symbol: { ios: 'arrow.right', android: 'arrow_forward', web: 'arrow_forward' }, fallback: '→' },
  more: { label: 'Agregar', symbol: { ios: 'plus', android: 'add', web: 'add' }, fallback: '+' },
  shortcuts: { label: 'Teclas extra', symbol: { ios: 'keyboard.badge.ellipsis', android: 'keyboard_alt', web: 'keyboard_alt' }, fallback: '⋯' },
  mouse: { label: 'Mouse', symbol: { ios: 'computermouse', android: 'mouse', web: 'mouse' }, fallback: '◇' },
  send: { label: 'Enviar', symbol: { ios: 'arrow.up.circle.fill', android: 'arrow_circle_up', web: 'arrow_circle_up' }, fallback: '↑' },
  enter: { label: 'Enter', symbol: { ios: 'return', android: 'keyboard_return', web: 'keyboard_return' }, fallback: '↵' },
  help: { label: 'Ayuda', symbol: { ios: 'questionmark.circle', android: 'help_outline', web: 'help_outline' }, fallback: '?' },
} as const satisfies Record<string, Action>;

export type ActionID = keyof typeof ACTIONS;
export const ATTACHMENT_MENU_ACTIONS = ['files', 'camera', 'photos'] as const;
