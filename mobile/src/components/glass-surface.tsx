import { useEffect, useState } from 'react';
import { AccessibilityInfo, View, type ViewProps } from 'react-native';
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';

// Some iOS 26 versions expose the OS version without the glass API. Never mount
// the native view until both runtime and build support have been checked.
const available = (() => {
  try {
    return isLiquidGlassAvailable() && isGlassEffectAPIAvailable();
  } catch {
    // A stale binary can include the JS package without its native module.
    return false;
  }
})();

export function GlassSurface({ interactive = false, material = 'clear', style, ...props }: ViewProps & {
  interactive?: boolean;
  material?: 'clear' | 'regular';
}) {
  const [reduceTransparency, setReduceTransparency] = useState(false);

  useEffect(() => {
    let mounted = true;
    const subscription = AccessibilityInfo.addEventListener('reduceTransparencyChanged', setReduceTransparency);
    void AccessibilityInfo.isReduceTransparencyEnabled()
      .then(enabled => { if (mounted) setReduceTransparency(enabled); })
      .catch(() => {});
    return () => { mounted = false; subscription.remove(); };
  }, []);

  if (!available || reduceTransparency) {
    return <View {...props} style={[{ backgroundColor: '#24262b' }, style]} />;
  }

  return <GlassView {...props} glassEffectStyle={material} colorScheme="dark" isInteractive={interactive} style={style} />;
}
