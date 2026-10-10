import { type ReactNode, useEffect, useRef } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { selectionAsync } from 'expo-haptics';
import { GlassSurface } from './glass-surface';
import { appearance } from './appearance';

/** Native glass lens; dragging selects on release, cancellation executes nothing. */
export function SessionControlFocus({ children, actions, dragEnabled = true }: {
  children: ReactNode; dragEnabled?: boolean; actions: Array<{ disabled?: boolean; run: () => void }>;
}) {
  const rowHeight = appearance.control.size;
  const position = useSharedValue(0);
  const focused = useSharedValue(0);
  const current = useRef(actions);
  current.current = actions;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const tick = () => { if (mounted.current) void selectionAsync().catch(() => {}); };
  const activate = (index: number) => {
    const action = current.current[index];
    if (mounted.current && action && !action.disabled) action.run();
  };
  const count = actions.length;
  const drag = Gesture.Pan().enabled(dragEnabled).minDistance(appearance.spacing.xs)
    .onUpdate(event => {
      const y = Math.max(0, Math.min((count - 1) * rowHeight, event.y - rowHeight / 2));
      position.value = y;
      const next = Math.round(y / rowHeight);
      if (next !== focused.value) { focused.value = next; scheduleOnRN(tick); }
    })
    .onEnd((event, success) => {
      if (success && event.x >= 0 && event.x <= rowHeight && event.y >= 0 && event.y < count * rowHeight) {
        scheduleOnRN(activate, Math.floor(event.y / rowHeight));
      }
    })
    .onFinalize(() => {
      position.value = withTiming(0, { duration: appearance.motion.popupDuration, reduceMotion: ReduceMotion.System });
      focused.value = 0;
    });
  const lens = useAnimatedStyle(() => ({ transform: [{ translateY: position.value }] }));
  return <GestureDetector gesture={drag}>
    <View style={{ width: rowHeight }}>
      <Animated.View pointerEvents="none" accessible={false} style={[{ position: 'absolute', left: 0, top: 0,
        width: rowHeight, height: rowHeight }, lens]}>
        <GlassSurface interactive style={{ width: rowHeight, height: rowHeight,
          borderRadius: appearance.control.capsuleRadius }} />
      </Animated.View>
      {children}
    </View>
  </GestureDetector>;
}
