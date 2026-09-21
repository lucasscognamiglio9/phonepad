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

export const LANDSCAPE_CONTROL_SIZE = 44;
export const LANDSCAPE_CONTROL_GAP = 6;
export const LANDSCAPE_CONTROLS_PADDING = 8;
export const LANDSCAPE_CONTROLS_CONTENT_HEIGHT = LANDSCAPE_CONTROL_SIZE * 4 + LANDSCAPE_CONTROL_GAP * 3 + LANDSCAPE_CONTROLS_PADDING * 2;

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

export function LandscapeControls({
  visible,
  show,
  hide,
  openKeyboard,
  reconnect,
  exitPreview,
  disabled,
  insets,
  optionsLabel,
}: {
  visible: boolean;
  show: () => void;
  hide: () => void;
  openKeyboard: () => void;
  reconnect: () => void;
  exitPreview: () => void;
  disabled: boolean;
  insets: LandscapeControlsInsets;
  optionsLabel?: string;
}) {
  const { height } = useWindowDimensions();
  const frame = getLandscapeControlsFrame(height, insets);

  if (!visible) {
    return <View pointerEvents="box-none" style={styles.overlay}>
      <View pointerEvents="box-none" style={[styles.positioner, { top: frame.handleTop, right: frame.right, height: LANDSCAPE_CONTROL_SIZE }]}>
        <GlassSurface interactive style={styles.handleSurface}>
          <GlassButton compact label="Mostrar controles" action="showControls" onPress={show} />
        </GlassSurface>
      </View>
    </View>;
  }

  return <View pointerEvents="box-none" style={styles.overlay}>
    <View pointerEvents="box-none" style={[styles.positioner, { top: frame.top, right: frame.right, height: frame.height }]}>
      <GlassSurface interactive material="regular" style={[styles.railSurface, { height: frame.height }]}>
        <ScrollView
          style={[styles.scroll, { height: frame.height }]}
          contentContainerStyle={styles.content}
          bounces={false}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="always"
          keyboardDismissMode="none"
        >
          <GlassButton compact label="Ocultar controles" action="hideControls" onPress={hide} />
          <GlassButton compact label="Teclado" action="keyboard" disabled={disabled} onPress={openKeyboard} />
          <GlassButton compact label={optionsLabel ?? "Reconectar"} action={optionsLabel ? "shortcuts" : "reconnect"} onPress={reconnect} />
          <GlassButton compact label="Ocultar pantalla" action="screen" onPress={exitPreview} />
        </ScrollView>
      </GlassSurface>
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
