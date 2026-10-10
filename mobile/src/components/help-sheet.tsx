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
          paddingTop: appearance.spacing.xl + insets.top,
          paddingBottom: appearance.spacing.xl + insets.bottom,
          paddingLeft: appearance.spacing.xl + insets.left,
          paddingRight: appearance.spacing.xl + insets.right,
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
          <Text style={styles.body}>Escribí o dictá en el campo inferior. La flecha envía el texto. Con el borrador vacío, Return y Backspace actúan en el equipo y mantener Espacio permite mover su cursor de texto. Las teclas extra están en una barra separada: deslizá verticalmente para cambiar de menú y horizontalmente para ver más opciones.</Text>
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
  content: { flexGrow: 1, gap: appearance.spacing.md },
  title: { color: appearance.color.text, fontSize: appearance.text.title, fontWeight: appearance.weight.strong },
  subtitle: { color: appearance.color.secondary, fontSize: appearance.text.body, lineHeight: appearance.text.bodyLineHeight },
  card: { borderRadius: appearance.control.menuRadius, padding: appearance.spacing.lg, gap: appearance.spacing.sm },
  heading: { color: appearance.color.text, fontSize: appearance.text.heading, fontWeight: appearance.weight.strong },
  body: { color: appearance.color.secondary, fontSize: appearance.text.body, lineHeight: appearance.text.bodyLineHeight },

});
