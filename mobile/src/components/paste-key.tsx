import * as Clipboard from 'expo-clipboard';
import type { AcceptedContentType, PasteEventPayload } from 'expo-clipboard';
import { Text, View } from 'react-native';
import { appearance } from './appearance';
import { ShortcutKey, type ShortcutKeyProps } from './shortcut-key';

// UIPasteControl reads the clipboard without the iOS "Allow Paste" prompt.
// The fallback reads it through `run`, which iOS may still prompt for.
export function PasteKey({ paste, accepted = ['plain-text'], ...key }: ShortcutKeyProps & {
  paste: (item: PasteEventPayload) => void; accepted?: AcceptedContentType[];
}) {
  if (key.disabled || !Clipboard.isPasteButtonAvailable) return <ShortcutKey {...key} />;
  return <View style={{ minHeight: appearance.control.size, flexDirection: 'row', alignItems: 'center', gap: appearance.shortcuts.gap,
    paddingHorizontal: appearance.control.gap }}>
    <Clipboard.ClipboardPasteButton onPress={paste} acceptedContentTypes={accepted} displayMode="iconOnly" cornerStyle="capsule"
      backgroundColor={appearance.color.paste} foregroundColor={appearance.color.text}
      style={{ width: appearance.control.size, height: appearance.control.size }} />
    <Text numberOfLines={1} style={{ color: appearance.color.text, fontSize: appearance.text.caption }}>{key.label}</Text>
  </View>;
}
