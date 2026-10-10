import { appearance } from './appearance';
import type { SharedValue } from 'react-native-reanimated';

export type GlassPointer = SharedValue<{ x: number; y: number; active: boolean }>;

export type GlassMotion = {
  x: SharedValue<number>; y: SharedValue<number>;
  width: SharedValue<number>; height: SharedValue<number>;
  contact: SharedValue<number>;
};

/** CSS .composer::before / paint() from the approved Work reference.
 * SwiftUI distributes color stops evenly, so sample each percent to retain
 * the original 23%, 52%, and 79% stops, rather than spreading five colors evenly.
 */
export function reflectionGradient(x: number, y: number, width: number, height: number) {
  'worklet';
  x = Number.isFinite(x) ? x : reflectionRest.x; y = Number.isFinite(y) ? y : reflectionRest.y;
  width = Number.isFinite(width) ? width : 1; height = Number.isFinite(height) ? height : 1;
  x = Math.max(0, Math.min(1, x)); y = Math.max(0, Math.min(1, y));
  const angle = (125 + x * 95 + (y - .5) * 30) * Math.PI / 180;
  const dx = Math.sin(angle), dy = -Math.cos(angle);
  const w = Math.max(1, width), h = Math.max(1, height);
  // CSS's gradient line passes through the center and the perpendicular
  // projections of the corners. A non-square composer must retain that angle.
  const length = Math.abs(w * dx) + Math.abs(h * dy);
  const highlight = .17 + Math.max(0, 1 - Math.abs(x - .5) * 2) * .1;
  const stops = [0, 23, 52, 79, 100];
  const alpha = [.025, highlight, .025, .11, .015];
  const colors: string[] = [];
  for (let percent = 0, segment = 0; percent <= 100; percent++) {
    while (segment < 3 && percent > stops[segment + 1]) segment++;
    const t = (percent - stops[segment]) / (stops[segment + 1] - stops[segment]);
    colors.push(`rgba(255,255,255,${(alpha[segment] + t * (alpha[segment + 1] - alpha[segment])).toFixed(4)})`);
  }
  return { type: 'linearGradient' as const, colors,
    startPoint: { x: .5 - dx * length / (2 * w), y: .5 - dy * length / (2 * h) },
    endPoint: { x: .5 + dx * length / (2 * w), y: .5 + dy * length / (2 * h) } };
}

export const reflectionRest = { x: appearance.glass.restX, y: appearance.glass.restY };

/** Localized reflection, masked by the native stroke. No interior paint. */
export function reflectionHighlight(x: number, width: number, contact: number) {
  'worklet';
  const position = Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : reflectionRest.x;
  const radius = Math.max(32, Math.min(100, (Number.isFinite(width) ? width : 1) * .22));
  const alpha = .45 * Math.max(0, Math.min(1, contact));
  return { type: 'radialGradient' as const,
    colors: [`rgba(255,255,255,${alpha.toFixed(4)})`, `rgba(255,255,255,${(alpha * .24).toFixed(4)})`, 'rgba(255,255,255,0)'],
    center: { x: position, y: 0 }, startRadius: 0, endRadius: radius };
}
