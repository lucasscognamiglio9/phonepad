import { appearance } from './appearance';
import { Pressable, Text } from 'react-native';
import { GlassSurface } from './glass-surface';
import { ActionIcon } from './action-icon';
import { ACTIONS, type ActionID } from '../lib/actions';
import * as Haptics from 'expo-haptics';

type Props = ({ action: ActionID; label?: string } | { action?: undefined; label: string }) & {
  onPress: () => void;
  onPressIn?: () => void;
  onPressOut?: () => void;
  selected?: boolean;
  disabled?: boolean;
  compact?: boolean;
};
export function GlassButton({ label: customLabel, action, onPress, onPressIn, onPressOut, selected = false, disabled = false, compact = false }: Props) {
  const label = customLabel ?? (action ? ACTIONS[action].label : '');
  const content = <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected, disabled }} disabled={disabled}
      onPressIn={onPressIn} onPressOut={onPressOut}
      onPress={() => { void Haptics.selectionAsync().catch(() => {}); onPress(); }}
      style={({ pressed }) => ({ minHeight: appearance.control.size, minWidth: appearance.control.size, borderRadius: 24, paddingHorizontal: compact ? 0 : action ? 12 : 20, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.4 : pressed ? 0.72 : 1 })}>
      {action ? <ActionIcon action={action} color={selected ? appearance.color.text : appearance.color.text} /> : <Text style={{ color: selected ? appearance.color.text : appearance.color.text, fontSize: compact ? 12 : 15, fontWeight: '500' }}>{label}</Text>}
    </Pressable>;
  if (compact) return content;
  return <GlassSurface interactive style={{ borderRadius: appearance.control.capsuleRadius }}>{content}</GlassSurface>;
}
