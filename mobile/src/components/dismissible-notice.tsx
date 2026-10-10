import { useMemo, useRef, type ReactNode } from 'react';
import { PanResponder, Text, View } from 'react-native';
import { GlassSurface } from './glass-surface';
import { GlassButton } from './glass-button';
import { appearance } from './appearance';

export function DismissibleNotice({ message, dismiss, children, action }: { message: string; dismiss: () => void; children?: ReactNode; action?: {label: string; run: () => void} }) {
  const close = useRef(dismiss); close.current = dismiss;
  const responder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > appearance.notice.swipeStart || gesture.dy < -appearance.notice.swipeStart,
    onPanResponderRelease: (_, gesture) => { if (Math.hypot(gesture.dx, gesture.dy) >= appearance.notice.swipeDismiss) close.current(); },
    onPanResponderTerminationRequest: () => true,
  }), []);
  return <GlassSurface style={{ borderRadius: appearance.control.menuRadius, padding: appearance.control.gap, gap: appearance.control.gap }}>
    <View {...responder.panHandlers} style={{ flexDirection: 'row', alignItems: 'center', gap: appearance.control.gap }}>
      <Text accessibilityLiveRegion="polite" numberOfLines={appearance.notice.maxLines} style={{ flex: 1, color: appearance.color.text, fontSize: appearance.notice.fontSize, lineHeight: appearance.notice.lineHeight }}>{message}</Text>
      {action && <GlassButton compact label={action.label} onPress={action.run} />}
      <GlassButton compact action="remove" label="Cerrar aviso" onPress={dismiss} />
    </View>
    {children}
  </GlassSurface>;
}
