import { appearance } from './appearance';
import { ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { GlassButton } from './glass-button';
import { GlassSurface } from './glass-surface';

export type LandscapeControlsInsets = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export type LandscapeControlsFrame = {
  top: number;
  right: number;
  height: number;
  handleTop: number;
};

export const LANDSCAPE_CONTROL_SIZE = appearance.control.size;
export const LANDSCAPE_CONTROL_GAP = appearance.control.gap;
export const LANDSCAPE_CONTROLS_PADDING = 8;
export const LANDSCAPE_CONTROLS_CONTENT_HEIGHT = LANDSCAPE_CONTROL_SIZE * 3 + LANDSCAPE_CONTROL_GAP * 2 + LANDSCAPE_CONTROLS_PADDING * 2;

function finite(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Position the rail from the screen edges. The parent can remain full-screen;
 * the safe-area right inset is applied exactly once here.
 */
export function getLandscapeControlsFrame(
  viewportHeight: number,
  insets: LandscapeControlsInsets,
): LandscapeControlsFrame {
  const height = Math.max(0, finite(viewportHeight, 0));
  const topInset = Math.max(0, finite(insets.top, 0));
  const rightInset = Math.max(0, finite(insets.right, 0));
  const bottomInset = Math.max(0, finite(insets.bottom, 0));
  const top = Math.max(8, topInset + 8);
  const bottom = Math.max(8, bottomInset + 8);
  const availableHeight = Math.max(1, height - top - bottom);
  const railHeight = Math.min(LANDSCAPE_CONTROLS_CONTENT_HEIGHT, availableHeight);
  const handleTop = clamp(
    (height - LANDSCAPE_CONTROL_SIZE) / 2,
    top,
    Math.max(top, height - bottom - LANDSCAPE_CONTROL_SIZE),
  );
  return { top, right: Math.max(8, rightInset + 8), height: railHeight, handleTop };
}

export function LandscapeControls({ openKeyboard, reconnect, openOptions, exitPreview, disabled, insets, viewportInsetBottom=0, keyboardOpen=false }: {
  openKeyboard: () => void; reconnect: () => void; openOptions: () => void;
  exitPreview: () => void; disabled: boolean; insets: LandscapeControlsInsets; viewportInsetBottom?: number; keyboardOpen?: boolean;
}) {
  const { height } = useWindowDimensions();
  const frame = getLandscapeControlsFrame(Math.max(1,height-viewportInsetBottom), insets);
  return <View pointerEvents="box-none" style={styles.overlay}>
    <View pointerEvents="box-none" style={[styles.positioner, { top: frame.top, right: frame.right, height: frame.height }]}>
      <GlassSurface interactive style={[styles.railSurface, { height: frame.height }]}>
        <ScrollView style={[styles.scroll, { height: frame.height }]} contentContainerStyle={styles.content}
          bounces={false} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="always" keyboardDismissMode="none">
          <GlassButton compact label={keyboardOpen ? "Cerrar teclado" : "Teclado"} selected={keyboardOpen} action="keyboard" disabled={disabled} onPress={openKeyboard} />
          <GlassButton compact label="Reconectar" action="reconnect" onPress={reconnect} />
          <GlassButton compact label="Mouse" action="mouse" onPress={openOptions} />
        </ScrollView>
      </GlassSurface>
    </View>
    <View style={{position:'absolute',left:insets.left+8,top:frame.top}}>
      <GlassButton label="Ocultar pantalla" action="screen" onPress={exitPreview} />
    </View>
  </View>;
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
  },
  positioner: {
    position: 'absolute',
    width: LANDSCAPE_CONTROL_SIZE + LANDSCAPE_CONTROLS_PADDING * 2,
    alignItems: 'flex-end',
  },
  handleSurface: {
    width: LANDSCAPE_CONTROL_SIZE,
    height: LANDSCAPE_CONTROL_SIZE,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: {
    width: LANDSCAPE_CONTROL_SIZE + LANDSCAPE_CONTROLS_PADDING * 2,
  },
  railSurface: {
    borderRadius: 30,
    overflow: 'hidden',
  },
  content: {
    alignItems: 'center',
    gap: LANDSCAPE_CONTROL_GAP,
    padding: LANDSCAPE_CONTROLS_PADDING,
  },
});
