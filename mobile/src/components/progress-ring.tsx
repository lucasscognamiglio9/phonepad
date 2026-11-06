import Svg, { Circle } from 'react-native-svg';
import { appearance } from './appearance';

export function ProgressRing({ percent }: { percent: number }) {
  const { ringSize: size, ringStroke: stroke } = appearance.transfer;
  const radius = (size - stroke) / 2;
  const length = 2 * Math.PI * radius;
  const done = Math.min(100, Math.max(0, percent));
  return <Svg width={size} height={size} accessibilityRole="progressbar" accessibilityLabel="Envío"
    accessibilityValue={{ min: 0, max: 100, now: Math.round(done) }}>
    <Circle cx={size / 2} cy={size / 2} r={radius} stroke={appearance.color.secondary} strokeOpacity={.3} strokeWidth={stroke} fill="none" />
    <Circle cx={size / 2} cy={size / 2} r={radius} stroke={appearance.color.text} strokeWidth={stroke} fill="none"
      strokeLinecap="round" strokeDasharray={length} strokeDashoffset={length * (1 - done / 100)}
      rotation={-90} origin={`${size / 2}, ${size / 2}`} />
  </Svg>;
}
