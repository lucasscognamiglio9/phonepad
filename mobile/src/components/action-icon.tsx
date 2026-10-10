import { Text } from 'react-native';
import { appearance } from './appearance';
import { useFonts } from 'expo-font';
import { SymbolView } from 'expo-symbols';
import regular from 'expo-symbols/androidWeights/regular';
import { ACTIONS, type ActionID } from '../lib/actions';

const fonts = { [regular.name]: regular.font };
const weight = { ios: 'regular' as const, android: regular };

export function ActionIcon({ action, color = appearance.color.text, size = appearance.control.iconSize }: {
  action: ActionID;
  color?: string;
  size?: number;
}) {
  const [loaded, error] = useFonts(fonts);
  const definition = ACTIONS[action];
  const fallback = <Text accessible={false} style={{ color, fontSize: size, lineHeight: size + 2 }}>
    {definition.fallback}
  </Text>;

  // expo-symbols leaves an empty view when its font fails to load. Keep an
  // identifiable control during loading or a font error, including offline web.
  if (!loaded || error) return fallback;
  return <SymbolView accessible={false} name={definition.symbol} tintColor={color}
    size={size} weight={weight} fallback={fallback} />;
}
