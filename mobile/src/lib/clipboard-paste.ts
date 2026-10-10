import type { ClipboardImage, PasteEventPayload } from 'expo-clipboard';

type ClipboardPort = {
 hasImageAsync: () => Promise<boolean>;
 getImageAsync: (options: { format: 'png' }) => Promise<ClipboardImage | null>;
 getStringAsync: () => Promise<string>;
};

// Called only by an explicit Paste press. iOS retains control over permission.
export async function readClipboardPaste(port: ClipboardPort, textAllowed: boolean, imagesAllowed: boolean): Promise<PasteEventPayload | null> {
 if (imagesAllowed && await port.hasImageAsync()) {
  const image = await port.getImageAsync({format:'png'});
  // A denied image read is not an invitation to request text permission too.
  return image ? {...image,type:'image'} : null;
 }
 if (!textAllowed) return null;
 const text = await port.getStringAsync();
 return text ? {type:'text',text} : null;
}
