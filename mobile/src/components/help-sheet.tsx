import { appearance } from './appearance';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassButton } from './glass-button';
import { GlassSurface } from './glass-surface';

export type HelpSheetProps = {
  visible: boolean;
  close: () => void;
  mode?: 'direct' | 'trackpad';
};

/**
 * The help copy is deliberately derived from controls that are visible in the
 * current surface. It does not promise gestures that are not implemented by
 * the active candidate, and the sheet is independent from the video/editor
 * tree so opening it cannot recreate the stream or discard a draft.
 */
export function HelpSheet({ visible, close, mode = 'trackpad' }: HelpSheetProps) {
  const insets = useSafeAreaInsets();
  const modeLabel = mode === 'direct' ? 'Directo' : 'Trackpad';
  return <Modal
    visible={visible}
    animationType="slide"
    presentationStyle="pageSheet"
    supportedOrientations={['portrait', 'landscape']}
    onRequestClose={close}
  >
    <View style={styles.root} accessibilityViewIsModal>
      <ScrollView
        contentContainerStyle={[styles.content, {
          paddingTop: 20 + insets.top,
          paddingBottom: 20 + insets.bottom,
          paddingLeft: 20 + insets.left,
          paddingRight: 20 + insets.right,
        }]}
        accessibilityLabel="Ayuda de PhonePad"
      >
        <Text accessibilityRole="header" style={styles.title}>Cómo usar PhonePad</Text>
        <Text style={styles.subtitle}>{modeLabel}</Text>

        <GlassSurface style={styles.card}>
          <Text style={styles.heading}>Mover el puntero</Text>
          <Text style={styles.body}>En Trackpad, deslizá un dedo para mover el puntero, tocá para hacer clic y usá dos dedos para desplazar. En Directo, tocá el destino, deslizá para arrastrar o mantené pulsado para abrir el menú contextual. Dos toques hacen doble clic.</Text>
        </GlassSurface>

        <GlassSurface style={styles.card}>
          <Text style={styles.heading}>Escribir y pegar</Text>
          <Text style={styles.body}>Escribí o dictá en el campo inferior. La flecha envía el texto; con el campo vacío, funciona como Enter.</Text>
        </GlassSurface>

        <GlassSurface style={styles.card}>
          <Text style={styles.heading}>Modos y zoom</Text>
          <Text style={styles.body}>Pellizcá para ampliar. Con zoom, desplazá la imagen con dos dedos. Tocá fuera del campo para cerrar el teclado.</Text>
        </GlassSurface>

        <GlassButton label="Cerrar ayuda" onPress={close} />
      </ScrollView>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: appearance.color.background },
  content: { flexGrow: 1, gap: 14 },
  title: { color: appearance.color.text, fontSize: 24, fontWeight: '700' },
  subtitle: { color: appearance.color.secondary, fontSize: 15, lineHeight: 22 },
  card: { borderRadius: 18, padding: 16, gap: 6 },
  heading: { color: appearance.color.text, fontSize: 17, fontWeight: '700' },
  body: { color: '#d4d7de', fontSize: 15, lineHeight: 23 },
  close: { minHeight: 48, borderRadius: 24, backgroundColor: appearance.color.text, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  closeLabel: { color: appearance.color.background, fontSize: 15, fontWeight: '700' },
  pressed: { opacity: 0.72 },
});
