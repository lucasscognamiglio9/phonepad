import { useEffect, useState } from 'react';
import { ActivityIndicator, Keyboard, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { appearance } from './appearance';
import { GlassSurface } from './glass-surface';
import { addHost, hostSettingsAdapter, loadSelectedHost, selectHost, type HostSettings, type HostSettingsAdapter } from '../lib/host-settings';

export function HostMenu({ visible, activeOrigin, connected, close, select, canSwitch, adapter = hostSettingsAdapter }: {
  visible: boolean;
  activeOrigin: string;
  connected: boolean;
  close: () => void;
  select: (origin: string) => void;
  canSwitch: () => boolean;
  adapter?: HostSettingsAdapter;
}) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const keyboardHeight = useKeyboardState(state => state.isVisible ? state.height : 0);
  const [settings, setSettings] = useState<HostSettings | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [origin, setOrigin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) {
      setAdding(false);
      setName('');
      setOrigin('');
      setError('');
      return;
    }
    let current = true;
    setSettings(null);
    setError('');
    void loadSelectedHost(adapter).then(result => {
      if (!current) return;
      setSettings(result.settings);
      if (result.error) setError(result.error.message);
    }).catch(() => { if (current) setError('No se pudo cargar la lista de equipos.'); });
    return () => { current = false; };
  }, [visible, adapter]);

  if (!visible) return null;
  const reachable = async (target: string) => {
    const request = new AbortController();
    const timeout = setTimeout(() => request.abort(), 5000);
    try {
      const response = await fetch(target + '/api/auth', { signal: request.signal });
      return response.status === 204 || response.status === 401 || response.status === 403;
    } catch { return false; }
    finally { clearTimeout(timeout); }
  };
  const choose = async (id: string) => {
    if (!settings || busy) return;
    const device = settings.devices.find(item => item.id === id);
    if (!device) return;
    if (device.origin === activeOrigin) { close(); select(device.origin); return; }
    if (!canSwitch()) return;
    setBusy(true);
    try {
      if (!(await reachable(device.origin))) { setError('Ese equipo no está disponible. La sesión actual sigue activa.'); return; }
      const saved = await adapter.save(selectHost(settings, id));
      if (!saved.ok) { setError(saved.error.message); return; }
      setSettings(saved.settings);
      close();
      select(device.origin);
    } catch { setError('No se pudo cambiar de equipo.'); }
    finally { setBusy(false); }
  };
  const add = async () => {
    if (!settings || busy) return;
    if (!canSwitch()) return;
    setBusy(true);
    try {
      const added = addHost(settings, { name, origin });
      const device = added.devices[added.devices.length - 1];
      const saved = await adapter.save(added);
      if (!saved.ok) { setError(saved.error.message); return; }
      Keyboard.dismiss();
      setSettings(saved.settings);
      setAdding(false); setName(''); setOrigin('');
      if (!(await reachable(device.origin))) { setError('Equipo guardado. Cuando esté disponible, tocalo para conectarte.'); return; }
      const selected = await adapter.save(selectHost(saved.settings, device.id));
      if (!selected.ok) { setError(selected.error.message); return; }
      close(); select(device.origin);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo agregar el equipo.'); }
    finally { setBusy(false); }
  };
  const menuWidth = Math.min(appearance.control.menuWidth, width - insets.left - insets.right - 2 * appearance.control.margin);
  const top = insets.top + appearance.control.size + appearance.control.margin + appearance.control.gap;
  return <View style={{ position: 'absolute', inset: 0 }} accessibilityViewIsModal>
    <Pressable accessibilityRole="button" accessibilityLabel="Cerrar equipos" onPress={close} style={{ position: 'absolute', inset: 0 }} />
    <GlassSurface interactive style={{ position: 'absolute', top, right: insets.right + appearance.control.margin, width: menuWidth,
      maxHeight: Math.max(100, height - top - insets.bottom - keyboardHeight - appearance.control.margin), borderRadius: appearance.control.menuRadius, overflow: 'hidden' }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: appearance.control.margin, gap: 4 }}>
        {settings ? settings.devices.map(device => <Pressable key={device.id} testID={`phonepad-menu-host-${device.id}`}
          accessibilityRole="button" accessibilityLabel={device.name} accessibilityState={{ selected: device.origin === activeOrigin }}
          disabled={busy} onPress={() => { void choose(device.id); }}
          style={{ minHeight: appearance.control.size, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, borderRadius: 14 }}>
          <View style={{ width: 7, height: 7, borderRadius: 4,
            backgroundColor: device.origin === activeOrigin ? (connected ? appearance.color.success : appearance.color.warning) : appearance.color.secondary }} />
          <Text numberOfLines={1} style={{ color: appearance.color.text, fontSize: 15, flex: 1 }}>{device.name}</Text>
        </Pressable>) : <ActivityIndicator accessibilityLabel="Cargando equipos" color={appearance.color.text} />}
        {adding ? <View style={{ gap: appearance.control.gap, padding: 6 }}>
          <TextInput accessibilityLabel="Nombre del equipo" placeholder="Nombre" placeholderTextColor={appearance.color.secondary}
            value={name} onChangeText={setName} autoCorrect={false} style={{ color: appearance.color.text, minHeight: appearance.control.size }} />
          <TextInput accessibilityLabel="Dirección HTTPS de Tailscale" placeholder="https://equipo.tailnet.ts.net"
            placeholderTextColor={appearance.color.secondary} value={origin} onChangeText={setOrigin} autoCapitalize="none" autoCorrect={false}
            keyboardType="url" style={{ color: appearance.color.text, minHeight: appearance.control.size }} />
          <Pressable accessibilityRole="button" accessibilityLabel="Guardar equipo" disabled={busy || !name.trim() || !origin.trim()}
            onPress={() => { void add(); }} style={{ minHeight: appearance.control.size, justifyContent: 'center' }}>
            <Text style={{ color: appearance.color.text, fontSize: 15 }}>Agregar</Text>
          </Pressable>
        </View> : <Pressable accessibilityRole="button" accessibilityLabel="Agregar nuevo" onPress={() => setAdding(true)}
          style={{ minHeight: appearance.control.size, justifyContent: 'center', paddingHorizontal: 12 }}>
          <Text style={{ color: appearance.color.text, fontSize: 15 }}>Agregar nuevo</Text>
        </Pressable>}
        {!!error && <Text accessibilityRole="alert" style={{ color: appearance.color.warning, paddingHorizontal: 12 }}>{error}</Text>}
      </ScrollView>
    </GlassSurface>
  </View>;
}
