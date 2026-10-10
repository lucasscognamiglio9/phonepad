export type ArrowKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';
export function directionKey(x: number, y: number, deadZone: number): ArrowKey | null {
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.hypot(x, y) < deadZone) return null;
  return Math.abs(x) > Math.abs(y) ? (x < 0 ? 'ArrowLeft' : 'ArrowRight') : (y < 0 ? 'ArrowUp' : 'ArrowDown');
}
export function topPreviewHeight(width: number, availableHeight: number, video: {width: number; height: number}): number {
  if (video.width <= 0 || video.height <= 0) return Math.max(0, availableHeight);
  return Math.max(0, Math.min(availableHeight, width * video.height / video.width));
}
export function primaryModifier(platform?: string): 'ctrl' | 'super' { return platform === 'darwin' ? 'super' : 'ctrl'; }
export function modifierLabel(mod: string, platform?: string): string {
  if (mod === 'super') return platform === 'darwin' ? 'Cmd' : platform === 'windows' ? 'Win' : 'Super';
  if (mod === 'alt' && platform === 'darwin') return 'Option';
  return mod[0].toUpperCase() + mod.slice(1);
}
import { appearance } from '../components/appearance';

export type ComposerColumn = { left: number; top: number; width: number; height: number };
type Insets = { left: number; right: number; top: number; bottom: number };

/** One coordinate system for the renderer, direct pointer and landscape editor. */
export function landscapeLayout(width: number, height: number, insets: Insets, keyboardOverlap: number, editing: boolean) {
  const gap = appearance.control.gap;
  const rail = appearance.control.size + gap * 3;
  const right = insets.right + rail;
  const top = insets.top;
  const bottom = Math.max(insets.bottom, keyboardOverlap);
  const usableWidth = Math.max(0, width - insets.left - right);
  const columnWidth = Math.max(0, (usableWidth - gap * 2) * appearance.composer.landscapeFraction);
  const column = editing ? {
    left: insets.left + gap, top: top + gap, width: columnWidth,
    height: Math.max(0, height - top - bottom - gap * 2),
  } : undefined;
  return { top, bottom, left: column ? column.left + column.width + gap : insets.left, right, column };
}
