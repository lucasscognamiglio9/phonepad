import { useEffect, type ReactNode } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { getActionMenuLayout, type ActionMenuAnchor } from './action-menu';
import { GlassSurface } from './glass-surface';
import { appearance } from './appearance';

/** Same measured placement and material as the attachment menu. */
export function GlassPopup({ anchor, rowCount, width, attached = false, bottomInset, close, children }: {
  anchor: ActionMenuAnchor | null; rowCount: number; width?: number; attached?: boolean; bottomInset: number;
  close: () => void; children: ReactNode;
}) {
  const viewport = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const scale = useSharedValue<number>(appearance.motion.popupScale);
  const expandedHeight = useSharedValue<number>(appearance.control.size);
  const open = anchor !== null;
  const layout = getActionMenuLayout(anchor, viewport, insets, bottomInset, rowCount, width, attached ? { rowHeight: appearance.control.size, padding: 0, attachToAnchor: true } : undefined);
  const targetHeight = layout?.height ?? appearance.control.size;
  useEffect(() => {
    if (!open) { expandedHeight.value = appearance.control.size; return; }
    const motion = { duration: appearance.motion.popupDuration, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.System };
    if (attached) expandedHeight.value = withTiming(targetHeight, motion);
    else { scale.value = appearance.motion.popupScale; scale.value = withTiming(1, motion); }
  }, [open, attached, targetHeight, scale, expandedHeight]);
  const animation = useAnimatedStyle(() => attached
    ? { height: expandedHeight.value }
    : { transform: [{ scale: scale.value }] });
  if (!layout) return null;
  const contents = <View pointerEvents="box-none" style={StyleSheet.absoluteFill} accessibilityViewIsModal>
    <Pressable accessibilityRole="button" accessibilityLabel="Cerrar controles" style={StyleSheet.absoluteFill} onPress={close} />
    <Animated.View style={[{ position: 'absolute', left: layout.left, top: layout.top, width: layout.width,
      transformOrigin: [layout.originX, layout.originY, 0] }, animation]}>
      <GlassSurface interactive material={appearance.control.floatingMaterial} style={{ height: attached ? '100%' : layout.height,
        borderRadius: appearance.control.menuRadius, padding: attached ? 0 : appearance.shortcuts.padding }}>
        <ScrollView bounces={false} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="always" keyboardDismissMode="none">
          {children}
        </ScrollView>
      </GlassSurface>
    </Animated.View>
  </View>;
  return Platform.OS === 'ios'
    ? <FullWindowOverlay unstable_accessibilityContainerViewIsModal>{contents}</FullWindowOverlay>
    : <Modal visible transparent supportedOrientations={['portrait', 'landscape']} animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={close}>{contents}</Modal>;
}
