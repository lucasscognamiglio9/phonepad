import { useCallback, useEffect, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { Control } from '../screens/control';
import { HostPicker } from '../screens/host-picker';
import { LaunchMark } from '../components/launch-mark';

export default function PhonePad() {
  const [origin, setOrigin] = useState<string | null>(null);
  const [openPreview, setOpenPreview] = useState(false);
  // A retained process resumes its session; only a new root starts the brand presentation.
  const [coldStart, setColdStart] = useState(AppState.currentState !== 'background');
  const [startupReady, setStartupReady] = useState(false);
  const prepareReveal = useCallback(() => setStartupReady(true), []);
  const finishStartup = useCallback(() => setColdStart(false), []);
  useEffect(() => {
    const listener = AppState.addEventListener('change', state => { if (state === 'background') finishStartup(); });
    return () => listener.remove();
  }, [finishStartup]);
  // Keep one brand presentation mounted across storage → connection handoff.
  return <View style={{ flex: 1 }}>
  {!origin ? <HostPicker onStartupComplete={prepareReveal}
    onSelect={selected => { setOpenPreview(false); setOrigin(selected); }} /> :
  <Control key={origin} origin={origin} onStartupComplete={prepareReveal} initialPreview={openPreview} onSelectHost={selected => {
    setOpenPreview(true);
    setOrigin(selected);
  }} />}
  {coldStart && <View style={StyleSheet.absoluteFill}><LaunchMark ready={startupReady} onComplete={finishStartup} /></View>}
  </View>;
}
