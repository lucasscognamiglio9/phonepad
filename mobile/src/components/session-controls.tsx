import { useEffect, useRef, useState } from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassButton } from './glass-button';
import { GlassSurface } from './glass-surface';
import { GlassPopup } from './glass-popup';
import { ActionIcon } from './action-icon';
import { SessionControlFocus } from './session-control-focus';
import { appearance } from './appearance';
import type { ActionMenuAnchor } from './action-menu';

export function SessionControls({ preview, keyboardOpen, disabled, bottomInset, openKeyboard, togglePreview, openOptions, reconnect }: {
  preview: boolean; keyboardOpen: boolean; disabled: boolean; bottomInset: number;
  openKeyboard: () => void; togglePreview: () => void; openOptions: () => void; reconnect: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const button = useRef<View>(null);
  const [anchor, setAnchor] = useState<ActionMenuAnchor | null>(null);
  const presented = useRef(false);
  const request = useRef(0);
  const measure = () => {
    const generation = ++request.current;
    button.current?.measureInWindow((x, y, width, height) => {
      if (presented.current && request.current === generation) setAnchor({ x, y, width, height });
    });
  };
  const close = () => { presented.current = false; request.current++; setAnchor(null); };
  useEffect(() => { if (presented.current) measure(); }, [width, height, insets.top, insets.right, bottomInset]);
  useEffect(() => { if (disabled) close(); }, [disabled]);
  useEffect(() => () => { presented.current = false; request.current++; }, []);
  const items = [
    { action: 'screen' as const, label: preview ? 'Ocultar pantalla' : 'Ver pantalla', selected: preview, run: togglePreview, disabled: false },
    { action: 'keyboard' as const, label: keyboardOpen ? 'Cerrar teclado' : 'Teclado', selected: keyboardOpen, run: openKeyboard, disabled },
    { action: 'mouse' as const, label: 'Mouse', selected: false, run: openOptions, disabled: false },
    { action: 'reconnect' as const, label: 'Reconectar', selected: false, run: reconnect, disabled: false },
  ];
  return <View pointerEvents="box-none" style={{ position: 'absolute', inset: 0 }}>
    <View ref={button} collapsable={false} onLayout={measure} style={{ position: 'absolute',
      top: insets.top + appearance.control.gap, right: insets.right + appearance.control.gap, width: appearance.control.size, height: appearance.control.size }}>
      {!anchor && <GlassSurface interactive material={appearance.control.floatingMaterial} style={{ borderRadius: appearance.control.menuRadius }}><GlassButton compact action="sessionMenu" selected={anchor !== null} onPress={() => {
        if (presented.current) close(); else { presented.current = true; request.current++; measure(); }
      }} /></GlassSurface>}
    </View>
    <GlassPopup anchor={anchor} rowCount={items.length + 1} attached width={appearance.control.size} bottomInset={bottomInset} close={close}>
      <SessionControlFocus dragEnabled={height - insets.top - insets.bottom - bottomInset - appearance.control.gap * 2 >= (items.length + 1) * appearance.control.size} actions={[{ run: close }, ...items.map(item => ({ disabled: item.disabled, run: () => { close(); item.run(); } }))]}>
      <Pressable accessibilityRole="button" accessibilityLabel="Cerrar opciones" accessibilityState={{ expanded: true }} onPress={close}
        style={({ pressed }) => ({ height: appearance.control.size, alignItems: 'center', justifyContent: 'center', opacity: pressed ? appearance.state.pressed : 1 })}>
        <ActionIcon action="sessionMenu" />
      </Pressable>
      {items.map(item => <Pressable key={item.action} accessibilityRole="button" accessibilityLabel={item.label}
        accessibilityState={{ selected: item.selected, disabled: item.disabled }} disabled={item.disabled}
        onPress={() => { close(); item.run(); }} style={({ pressed }) => ({ minHeight: appearance.control.size,
          borderRadius: appearance.control.menuRadius, alignItems: 'center', justifyContent: 'center',
          opacity: item.disabled ? appearance.state.disabled : pressed ? appearance.state.pressed : 1,
          backgroundColor: pressed ? appearance.color.pressed : undefined })}>
        <ActionIcon action={item.action} />
      </Pressable>)}
      </SessionControlFocus>
    </GlassPopup>
  </View>;
}
