import { useRef } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { scheduleOnRN } from 'react-native-worklets';
import { ShortcutKey } from './shortcut-key';
import { GlassSurface } from './glass-surface';
import { appearance } from './appearance';
import { modifierLabel } from '../lib/control-layout';

/** One horizontal native scroller, with an independent vertical page gesture. */
export function ShortcutPanel({ disabled, clipboardDisabled, platform, modifiers, toggleModifier, special, copy, paste, pasteDraft, toPhone, toHost, page, onPageChange }: {
  disabled: boolean; clipboardDisabled: boolean; platform?: string; modifiers: string[];
  toggleModifier: (mod: string) => void; special: (key: string) => void;
  copy: () => void; paste: () => void; pasteDraft: () => void; toPhone: () => void; toHost: () => void;
  page: number; onPageChange: (page: number) => void;
}) {
  const scroll = useRef<ScrollView>(null);
  const offsets = useRef([0, 0]);
  const switchPage = () => {
    const next = page === 0 ? 1 : 0;
    onPageChange(next);
  };
  // Offset belongs to the page; a prior horizontal drag cannot retain the
  // vertical recognizer. Gesture.Native shares recognition with iOS scrolling.
  const horizontal = Gesture.Native();
  const vertical = Gesture.Pan()
    .activeOffsetY([-appearance.shortcuts.directionThreshold, appearance.shortcuts.directionThreshold])
    .failOffsetX([-appearance.shortcuts.directionThreshold, appearance.shortcuts.directionThreshold])
    .simultaneousWithExternalGesture(horizontal)
    .onEnd(event => {
      if (Math.abs(event.translationY) >= appearance.shortcuts.swipeDistance) scheduleOnRN(switchPage);
    });
  const items = page === 0 ? [
    ...['ctrl', 'alt', 'super', 'shift'].map(mod => ({
      label: modifierLabel(mod, platform), selected: modifiers.includes(mod), disabled, run: () => toggleModifier(mod),
    })),
    { label: 'Esc', disabled, run: () => special('Escape') },
    { label: 'Tab', disabled, run: () => special('Tab') },
  ] : [
    { label: 'Pegar aquí', action: 'pasteDraft' as const, disabled, run: pasteDraft },
    { label: 'Pegar', action: 'paste' as const, disabled, run: paste },
    { label: 'Copiar', action: 'copy' as const, disabled, run: copy },
    { label: 'Al iPhone', action: 'toPhone' as const, disabled: disabled || clipboardDisabled, run: toPhone },
    { label: 'Al equipo', action: 'toHost' as const, disabled: disabled || clipboardDisabled, run: toHost },
  ];
  return <GestureDetector gesture={vertical}>
    <GlassSurface interactive material={appearance.control.floatingMaterial} style={{ borderRadius: appearance.control.menuRadius, padding: appearance.shortcuts.padding }}>
      <View style={{ height: appearance.composer.toolbarHeight, flexDirection: 'row', alignItems: 'center' }}>
        <GestureDetector gesture={horizontal}>
          <ScrollView key={page} ref={scroll} horizontal bounces={false} showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="always" directionalLockEnabled
            onLayout={() => scroll.current?.scrollTo({ x: offsets.current[page], animated: false })}
            onScroll={event => { offsets.current[page] = event.nativeEvent.contentOffset.x; }} scrollEventThrottle={16}
            style={{ flex: 1, height: appearance.composer.toolbarHeight }}
            contentContainerStyle={{ alignItems: 'center', gap: appearance.shortcuts.gap }}>
            {items.map(item => <ShortcutKey key={item.label} {...item} />)}
          </ScrollView>
        </GestureDetector>
        <Pressable accessibilityRole="button" accessibilityLabel={page === 0 ? 'Portapapeles' : 'Modificadores y teclas'}
          accessibilityHint="Deslizá la barra verticalmente para cambiar de menú" onPress={switchPage}
          style={({ pressed }) => ({ width: appearance.control.size, height: appearance.composer.toolbarHeight,
            justifyContent: 'center', alignItems: 'center', gap: appearance.shortcuts.gap, opacity: pressed ? appearance.state.pressed : 1 })}>
          {[0, 1].map(index => <View key={index} style={{ width: 4, height: 4, borderRadius: 2,
            backgroundColor: appearance.color.text, opacity: index === page ? 1 : .3 }} />)}
        </Pressable>
      </View>
    </GlassSurface>
  </GestureDetector>;
}
