import { appearance } from './appearance';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, StyleSheet, View, useWindowDimensions, type ViewProps, type GestureResponderEvent } from 'react-native';
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import { cancelAnimation, Easing, ReduceMotion, useAnimatedReaction, useSharedValue, withTiming } from 'react-native-reanimated';
import { GlassEdge } from './glass-edge';
import { reflectionRest, type GlassPointer } from './glass-reflection';

// Some iOS 26 versions expose the OS version without the glass API. Never mount
// the native view until both runtime and build support have been checked.
const available = (() => {
  try { return isLiquidGlassAvailable() && isGlassEffectAPIAvailable(); }
  catch { return false; }
})();

export function GlassSurface({ interactive: _interactive = false, material: _material = 'clear', style, children,
  glassPointer, onLayout, onTouchStart, onTouchMove, onTouchEnd, onTouchCancel, ...props }: ViewProps & {
  interactive?: boolean; material?: 'clear' | 'regular'; glassPointer?: GlassPointer;
}) {
  const [reduceTransparency, setReduceTransparency] = useState(false);
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const x = useSharedValue<number>(reflectionRest.x), y = useSharedValue<number>(reflectionRest.y);
  const reducedMotion = useSharedValue(false);
  const contact = useSharedValue(0);
  const width = useSharedValue(1), height = useSharedValue(1);
  const styledRadius = StyleSheet.flatten(style)?.borderRadius;
  const radius = typeof styledRadius === 'number' ? styledRadius : appearance.control.menuRadius;

  useEffect(() => {
    let mounted = true;
    const subscription = AccessibilityInfo.addEventListener('reduceTransparencyChanged', setReduceTransparency);
    void AccessibilityInfo.isReduceTransparencyEnabled()
      .then(enabled => { if (mounted) setReduceTransparency(enabled); }).catch(() => {});
    return () => { mounted = false; subscription.remove(); };
  }, []);
  useEffect(() => {
    let mounted = true;
    const update = (enabled: boolean) => {
      reducedMotion.value = enabled;
      if (enabled) { cancelAnimation(x); cancelAnimation(y); cancelAnimation(contact); contact.value = 0; x.value = reflectionRest.x; y.value = reflectionRest.y; }
    };
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', update);
    void AccessibilityInfo.isReduceMotionEnabled().then(enabled => { if (mounted) update(enabled); }).catch(() => {});
    return () => { mounted = false; subscription.remove(); cancelAnimation(x); cancelAnimation(y); cancelAnimation(contact); };
  }, [reducedMotion, x, y, contact]);
  useAnimatedReaction(
    () => glassPointer?.value,
    point => {
      if (!point) return;
      const timing = { duration: point.active ? appearance.glass.followDuration : appearance.glass.settleDuration,
        easing: Easing.out(Easing.exp), reduceMotion: ReduceMotion.System };
      x.value = reducedMotion.value ? point.x : withTiming(point.x, timing);
      y.value = reducedMotion.value ? point.y : withTiming(point.y, timing);
      contact.value = reducedMotion.value ? 0 : withTiming(point.active ? 1 : 0, timing);
    }, [glassPointer],
  );
  const follow = (event?: GestureResponderEvent) => {
    // Observe bubbling touch events only. Do not claim a responder or install
    // competing recognizers on the editor, native buttons or either scroller.
    const point = event?.nativeEvent;
    const timing = { duration: point ? appearance.glass.followDuration : appearance.glass.settleDuration, easing: Easing.out(Easing.exp), reduceMotion: ReduceMotion.System };
    const nextX = point ? Math.max(0, Math.min(1, point.pageX / Math.max(1, screenWidth))) : reflectionRest.x;
    const nextY = point ? Math.max(0, Math.min(1, point.pageY / Math.max(1, screenHeight))) : reflectionRest.y;
    x.value = reducedMotion.value ? nextX : withTiming(nextX, timing);
    y.value = reducedMotion.value ? nextY : withTiming(nextY, timing);
    contact.value = reducedMotion.value ? 0 : withTiming(point ? 1 : 0, timing);
  };
  return <View {...props} style={[style, { backgroundColor: reduceTransparency ? appearance.glass.accessibleFill : 'transparent' }]}
    onLayout={event => { width.value = event.nativeEvent.layout.width; height.value = event.nativeEvent.layout.height; onLayout?.(event); }}
    onTouchStart={event => { follow(event); onTouchStart?.(event); }}
    onTouchMove={event => { follow(event); onTouchMove?.(event); }}
    onTouchEnd={event => { if (!event.nativeEvent.touches?.length) follow(); onTouchEnd?.(event); }}
    onTouchCancel={event => { follow(); onTouchCancel?.(event); }}>
    {available && !reduceTransparency
      ? <GlassView accessible={false} pointerEvents="none" glassEffectStyle="clear" colorScheme="dark" isInteractive={false}
          style={[StyleSheet.absoluteFill, { borderRadius: radius }]} />
      : !reduceTransparency && <View pointerEvents="none" style={[StyleSheet.absoluteFill, {
          borderRadius: radius, backgroundColor: appearance.glass.fallback,
        }]} />}
    {children}
    <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill}>
      <GlassEdge radius={radius} motion={{ x, y, width, height, contact }} />
    </View>
  </View>;
}
