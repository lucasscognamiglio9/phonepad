import { StyleSheet, View } from 'react-native';
import { appearance } from './appearance';
import type { GlassMotion } from './glass-reflection';

/** Platforms without Expo's SwiftUI renderer keep the same transparent
 * interior and one-point perimeter without introducing a new native module.
 */
export function GlassEdge({ radius }: { radius: number; motion: GlassMotion }) {
  return <View pointerEvents="none" style={[StyleSheet.absoluteFill, {
    borderRadius: radius, borderWidth: appearance.glass.edgeWidth, borderColor: appearance.glass.edgeBase,
  }]} />;
}
