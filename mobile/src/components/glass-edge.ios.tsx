import { Host, Rectangle } from '@expo/ui/swift-ui';
import { foregroundStyle, strokeBorder } from '@expo/ui/swift-ui/modifiers';
import { forwardRef, type ComponentRef, type ComponentProps } from 'react';
import { StyleSheet } from 'react-native';
import Animated, { useAnimatedProps, useDerivedValue } from 'react-native-reanimated';
import { appearance } from './appearance';
import { reflectionGradient, reflectionHighlight, reflectionRest, type GlassMotion } from './glass-reflection';

const BorderHost = forwardRef<ComponentRef<typeof Host>, ComponentProps<typeof Host>>((props, ref) => <Host {...props} ref={ref} />);
BorderHost.displayName = 'GlassBorderHost';
const AnimatedHost = Animated.createAnimatedComponent(BorderHost);

/** A native inset stroke masks the gradient to the perimeter. The transparent
 * rectangle contributes no fill; this separate layer has no hit testing.
 */
export function GlassEdge({ radius, motion }: { radius: number; motion: GlassMotion }) {
  const shape = { shape: 'roundedRectangle' as const, cornerRadius: radius,
    style: { lineWidth: appearance.glass.edgeWidth }, antialiased: true };
  const base = strokeBorder({ ...shape, content: appearance.glass.edgeBase });
  const glint = strokeBorder({ ...shape, content: reflectionGradient(reflectionRest.x, reflectionRest.y, 1, 1) });
  const highlight = strokeBorder({ ...shape, content: reflectionHighlight(reflectionRest.x, 1, 0) });
  const gradient = useDerivedValue(() => reflectionGradient(reflectionRest.x, reflectionRest.y, motion.width.value, motion.height.value));
  const animatedProps = useAnimatedProps(() => ({ modifiers: [base, { ...glint,
    content: gradient.value },
    { ...highlight, content: reflectionHighlight(motion.x.value, motion.width.value, motion.contact.value) }] }));
  return <AnimatedHost pointerEvents="none" ignoreSafeArea="all" colorScheme="dark" style={StyleSheet.absoluteFill}
    modifiers={[base, glint, highlight]} animatedProps={animatedProps}>
    <Rectangle modifiers={[foregroundStyle('transparent')]} />
  </AnimatedHost>;
}
