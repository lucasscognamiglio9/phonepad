import { Pressable, Text } from 'react-native';
import { ActionIcon } from './action-icon';
import { appearance } from './appearance';
import type { ActionID } from '../lib/actions';

export type ShortcutKeyProps = { label: string; action?: ActionID; selected?: boolean; disabled: boolean; run: () => void };

/** Non-iOS fallback shares the native control's metrics and accessible state. */
export function ShortcutKey({ label, action, selected = false, disabled, run }: ShortcutKeyProps) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected, disabled }} disabled={disabled}
    onPress={run} style={({ pressed }) => ({ minHeight: appearance.control.size, minWidth: appearance.control.size,
      borderRadius: appearance.control.menuRadius, borderWidth: appearance.glass.edgeWidth, borderColor: selected ? appearance.color.border : 'transparent',
      justifyContent: 'center', alignItems: 'center', flexDirection: 'row', gap: appearance.shortcuts.gap,
      paddingHorizontal: appearance.control.gap, opacity: disabled ? appearance.state.disabled : pressed ? appearance.state.pressed : 1 })}>
    {action && <ActionIcon action={action} size={appearance.shortcuts.iconSize} />}
    <Text numberOfLines={1} style={{ color: appearance.color.text, fontSize: appearance.text.caption, fontWeight: appearance.weight.regular }}>{label}</Text>
  </Pressable>;
}
