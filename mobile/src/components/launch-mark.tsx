import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, AppState, useWindowDimensions } from 'react-native';
import Animated, { cancelAnimation, Easing, ReduceMotion, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { appearance } from './appearance';
import { LaunchTiming } from '../lib/launch-timing';

/** One cold-start mark. Ordinary refresh and session resume never mount this. */
export function LaunchMark({ ready, onComplete }: { ready: boolean; onComplete: () => void }) {
  const { width, height } = useWindowDimensions();
  const [reducedMotion, setReducedMotion] = useState(useReducedMotion());
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [exiting, setExiting] = useState(false);
  const progress = useSharedValue(0);
  const timeline = useRef<LaunchTiming | null>(null);
  const loaded = useRef(false);
  const readyRef = useRef(ready); readyRef.current = ready;
  const mounted = useRef(true);
  const completed = useRef(false);
  const completeRef = useRef(onComplete); completeRef.current = onComplete;
  const complete = useCallback(() => { if (mounted.current && !completed.current) { completed.current = true; completeRef.current(); } }, []);
  useEffect(() => {
    mounted.current = true;
    const timing = new LaunchTiming(appearance.launch.holdDuration, () => setExiting(true));
    timeline.current = timing;
    timing.setActive(AppState.currentState === 'active');
    if (loaded.current) timing.show();
    if (readyRef.current) timing.markReady();
    const motion = AccessibilityInfo.addEventListener('reduceMotionChanged', setReducedMotion);
    const app = AppState.addEventListener('change', state => {
      const next = state === 'active'; timing.setActive(next); setActive(next);
    });
    return () => { mounted.current = false; timing.dispose(); timeline.current = null; motion.remove(); app.remove(); };
  }, []);
  useEffect(() => { if (ready) timeline.current?.markReady(); }, [ready]);
  useEffect(() => {
    if (exiting && active) progress.value = withTiming(1, {
      duration: reducedMotion ? appearance.launch.fadeDuration : appearance.launch.exitDuration,
      easing: Easing.inOut(Easing.cubic), reduceMotion: ReduceMotion.Never,
    }, finished => { if (finished) scheduleOnRN(complete); });
    return () => cancelAnimation(progress);
  }, [exiting, active, reducedMotion, progress, complete]);
  const size = Math.min(appearance.launch.logoSize, width * .6, height * .6);
  const zoom = Math.max(width, height) * 3 / Math.max(1, size);
  const backdrop = useAnimatedStyle(() => ({ opacity: 1 - progress.value }));
  const mark = useAnimatedStyle(() => ({ transform: [{ scale: reducedMotion ? 1 : 1 + (zoom - 1) * progress.value }] }));
  return <Animated.View accessible accessibilityRole="progressbar" accessibilityLabel="PhonePad" accessibilityState={{ busy: true }}
    accessibilityViewIsModal style={[{ flex: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', backgroundColor: appearance.launch.background }, backdrop]}>
    <Animated.Image accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      source={require('../../assets/phonepad-icon.png')} resizeMode="contain" fadeDuration={0}
      onLoad={() => { loaded.current = true; timeline.current?.show(); }} onError={complete}
      style={[{ width: size, height: size }, mark]} />
  </Animated.View>;
}
