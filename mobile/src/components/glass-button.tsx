import type { ComponentProps } from 'react';
import { Pressable, Text } from 'react-native';
import { GlassSurface } from './glass-surface';
import { SymbolView } from 'expo-symbols';
import * as Haptics from 'expo-haptics';

type Props = { label: string; symbol?: ComponentProps<typeof SymbolView>['name']; onPress: () => void; selected?: boolean; disabled?: boolean; compact?: boolean };
export function GlassButton({ label, symbol, onPress, selected = false, disabled = false, compact = false }: Props) {
  const content = <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected, disabled }} disabled={disabled}
      onPress={() => { void Haptics.selectionAsync().catch(() => {}); onPress(); }}
      style={({ pressed }) => ({ minHeight: 44, minWidth: 44, borderRadius: 24, paddingHorizontal: compact ? 0 : symbol ? 12 : 20, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.4 : pressed ? 0.72 : 1 })}>
      {symbol ? <SymbolView name={symbol} tintColor={selected ? '#b7e3ff' : '#f4f5f7'} size={22} weight="regular" /> : <Text style={{ color: selected ? '#b7e3ff' : '#f4f5f7', fontSize: compact ? 12 : 15, fontWeight: '500' }}>{label}</Text>}
    </Pressable>;
  if (compact) return content;
  return <GlassSurface interactive style={{ borderRadius: 28 }}>{content}</GlassSurface>;
}
