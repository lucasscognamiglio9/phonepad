import { Text } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { ACTIONS, type ActionID } from '../lib/actions';

export function ActionIcon({ action, color = '#f4f5f7', size = 22 }: {
  action: ActionID;
  color?: string;
  size?: number;
}) {
  const definition = ACTIONS[action];
  return <SymbolView accessible={false} name={definition.symbol} tintColor={color}
    size={size} weight="regular" fallback={<Text accessible={false}
      style={{ color, fontSize: size, lineHeight: size + 2 }}>{definition.fallback}</Text>} />;
}
