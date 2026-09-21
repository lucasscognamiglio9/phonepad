import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
        <Text style={styles.subtitle}>El modo actual es {modeLabel}. La ayuda sigue el teclado y los controles que ves en esta pantalla.</Text>

        <GlassSurface style={styles.card}>
          <Text style={styles.heading}>Mover el puntero</Text>
          <Text style={styles.body}>Deslizá un dedo sobre la superficie para mover el puntero. Levantá el dedo para terminar el contacto. Si aparece el teclado, el primer toque devuelve el foco a la superficie.</Text>
        </GlassSurface>

        <GlassSurface style={styles.card}>
          <Text style={styles.heading}>Escribir y pegar</Text>
          <Text style={styles.body}>Abrí Teclado para escribir. Usá Copiar o Pegar para las acciones disponibles; el borrador queda conservado si la computadora rechaza o no confirma una acción.</Text>
        </GlassSurface>

        <GlassSurface style={styles.card}>
          <Text style={styles.heading}>Trackpad Mode</Text>
          <Text style={styles.body}>El modo Trackpad envía contactos al trackpad de la computadora. Las flechas admiten mantener pulsado; soltarlas detiene la repetición. Los gestos incompletos se cancelan al ocultar la superficie, girar la ventana o perder la conexión.</Text>
        </GlassSurface>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cerrar ayuda"
          onPress={close}
          style={({ pressed }) => [styles.close, pressed && styles.pressed]}
        >
          <Text style={styles.closeLabel}>Cerrar</Text>
        </Pressable>
      </ScrollView>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#090b0e' },
  content: { flexGrow: 1, gap: 14 },
  title: { color: '#f4f5f7', fontSize: 24, fontWeight: '700' },
  subtitle: { color: '#b7bbc4', fontSize: 15, lineHeight: 22 },
  card: { borderRadius: 18, padding: 16, gap: 6 },
  heading: { color: '#f4f5f7', fontSize: 17, fontWeight: '700' },
  body: { color: '#d4d7de', fontSize: 15, lineHeight: 23 },
  close: { minHeight: 48, borderRadius: 24, backgroundColor: '#b7e3ff', alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  closeLabel: { color: '#090b0e', fontSize: 15, fontWeight: '700' },
  pressed: { opacity: 0.72 },
});
