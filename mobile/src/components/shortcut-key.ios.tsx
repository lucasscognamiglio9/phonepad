import { Button, Host, HStack, Image, Text } from '@expo/ui/swift-ui';
import { accessibilityAddTraits, accessibilityLabel, strokeBorder, buttonStyle, contentShape, disabled as disabledModifier,
  font, foregroundStyle, frame, padding, shapes } from '@expo/ui/swift-ui/modifiers';
import { appearance } from './appearance';
import { ACTIONS } from '../lib/actions';
import type { ShortcutKeyProps } from './shortcut-key';

/** Intrinsic SwiftUI size belongs to the native button, not a guessed label width. */
export function ShortcutKey({ label, action, selected = false, disabled, run }: ShortcutKeyProps) {
  return <Host matchContents ignoreSafeArea="all" colorScheme="dark" seedColor={appearance.color.text}>
    <Button onPress={() => { if (!disabled) run(); }} modifiers={[
      buttonStyle('plain'), disabledModifier(disabled), accessibilityLabel(label),
      accessibilityAddTraits(selected ? ['isSelected', 'isKeyboardKey'] : ['isKeyboardKey']),
    ]}>
      <HStack spacing={appearance.shortcuts.gap} modifiers={[
        foregroundStyle(appearance.color.text), padding({ horizontal: appearance.control.gap }),
        frame({ minWidth: appearance.control.size, minHeight: appearance.control.size }),
        contentShape(shapes.rectangle()),
        ...(selected ? [strokeBorder({ content: appearance.color.border, shape: 'capsule', style: { lineWidth: appearance.glass.edgeWidth } })] : []),
      ]}>
        {action && <Image systemName={ACTIONS[action].symbol.ios} size={appearance.shortcuts.iconSize} />}
        <Text modifiers={[font({ textStyle: appearance.shortcuts.textStyle, weight: 'regular' })]}>{label}</Text>
      </HStack>
    </Button>
  </Host>;
}
