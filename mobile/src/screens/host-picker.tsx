import { hostSettingsNotice } from '../lib/notice-message';
import { appearance } from '../components/appearance';
import { GlassSurface } from '../components/glass-surface';
import { DismissibleNotice } from '../components/dismissible-notice';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  addHost,
  createDefaultHostSettings,
  hostSettingsAdapter,
  loadSelectedHost,
  removeHost,
  selectHost,
  type HostSettings,
  type HostSettingsAdapter,
  HostSettingsError,
} from '../lib/host-settings';

const contentPadding = appearance.spacing.xl;

export type HostPickerProps = {
  onSelect: (origin: string) => void;
  /** Set false when returning to this screen to let the user choose again. */
  autoSelect?: boolean;
  /** Injectable for tests and for a future account/profile scope. */
  adapter?: HostSettingsAdapter;
  onStartupComplete?: () => void;
};

function errorMessage(error: unknown): string {
  if (error instanceof HostSettingsError) return hostSettingsNotice(error);
  return 'No se pudo actualizar la lista de equipos. Podés volver a intentarlo.';
}

export function HostPicker({ onSelect, autoSelect = true, adapter = hostSettingsAdapter, onStartupComplete }: HostPickerProps) {
  const insets = useSafeAreaInsets();
  const [settings, setSettings] = useState<HostSettings>(createDefaultHostSettings);
  const [name, setName] = useState('');
  const [origin, setOrigin] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const onSelectRef = useRef(onSelect);
  const onStartupCompleteRef = useRef(onStartupComplete);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  onSelectRef.current = onSelect;
  onStartupCompleteRef.current = onStartupComplete;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    void loadSelectedHost(adapter)
      .then(result => {
        if (!mounted) return;
        setSettings(result.settings);
        setReady(true);
        setError(result.error ? hostSettingsNotice(result.error) : '');
        if (autoSelect && result.origin) onSelectRef.current(result.origin);
        else onStartupCompleteRef.current?.();
      })
      .catch(() => {
        if (!mounted) return;
        setReady(true);
        setError('No se pudo leer la lista de equipos. Podés volver a intentarlo.');
        onStartupCompleteRef.current?.();
      });
    return () => { mounted = false; };
  }, [adapter, autoSelect]);

  const save = async (next: HostSettings, selectedOrigin?: string): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    if (mountedRef.current) {
      setBusy(true);
      setError('');
    }
    try {
      const result = await adapter.save(next);
      if (!mountedRef.current) return false;
      if (result.ok) {
        setSettings(result.settings);
        if (selectedOrigin) onSelectRef.current(selectedOrigin);
        return true;
      }
      setError(hostSettingsNotice(result.error));
      return false;
    } catch {
      if (mountedRef.current) setError('No se pudo guardar la lista de equipos. Podés volver a intentarlo.');
      return false;
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const add = async () => {
    if (!ready || busyRef.current) return;
    try {
      const next = addHost(settings, { name, origin });
      const selected = next.devices.find(device => device.id === next.selected);
      if (await save(next, settings.selected === next.selected ? undefined : selected?.origin)) {
        setName('');
        setOrigin('');
      }
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const choose = async (id: string) => {
    if (!ready || busyRef.current) return;
    try {
      const next = selectHost(settings, id);
      const selected = next.devices.find(device => device.id === next.selected);
      await save(next, selected?.origin);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const remove = async (id: string) => {
    if (!ready || busyRef.current) return;
    try {
      const next = removeHost(settings, id);
      await save(next);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  if (!ready) return <View style={styles.root} />;

  return <KeyboardAvoidingView
    style={styles.root}
    behavior={Platform.OS === 'ios' ? 'padding' : undefined}
  >
    <ScrollView
      contentContainerStyle={[
        styles.content,
        {
          paddingTop: contentPadding + insets.top,
          paddingBottom: contentPadding + insets.bottom,
          paddingLeft: contentPadding + insets.left,
          paddingRight: contentPadding + insets.right,
        },
      ]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      <Text style={styles.title}>Elegí un equipo</Text>
      <Text style={styles.subtitle}>Guardá la dirección de cada computadora que quieras controlar.</Text>

      <>
        {settings.devices.map(device => {
          const selected = settings.selected === device.id;
          return <GlassSurface key={device.id} style={[styles.device, selected && styles.selectedDevice]}>
            <Pressable
              testID={`phonepad-host-${device.id}`}
              accessibilityRole="button"
              accessibilityLabel={`Elegir ${device.name}`}
              accessibilityState={{ selected }}
              disabled={busy}
              onPress={() => { void choose(device.id); }}
              style={({ pressed }) => [styles.deviceSelect, pressed && styles.pressed, busy && styles.disabled]}
            >
              <View style={styles.deviceText}>
                <Text style={styles.deviceName}>{device.name}</Text>
                <Text selectable style={styles.deviceOrigin}>{device.origin}</Text>
              </View>
              <Text style={styles.deviceAction}>{selected ? 'Usando' : 'Elegir'}</Text>
            </Pressable>
            <Pressable
              testID={`phonepad-remove-host-${device.id}`}
              accessibilityRole="button"
              accessibilityLabel={`Quitar ${device.name}`}
              disabled={busy}
              onPress={() => { void remove(device.id); }}
              style={({ pressed }) => [styles.remove, pressed && styles.pressed, busy && styles.disabled]}
            >
              <Text style={styles.removeText}>Quitar</Text>
            </Pressable>
          </GlassSurface>;
        })}

        <View style={styles.form}>
          <Text style={styles.formTitle}>Agregar equipo</Text>
          <GlassSurface style={{ borderRadius: appearance.control.menuRadius }}><TextInput
            accessibilityLabel="Nombre del equipo"
            autoCapitalize="sentences"
            autoCorrect={false}
            editable={!busy}
            onChangeText={setName}
            placeholder="Nombre, por ejemplo Oficina"
            placeholderTextColor={appearance.color.secondary}
            style={styles.input}
            value={name}
          /></GlassSurface>
          <GlassSurface style={{ borderRadius: appearance.control.menuRadius }}><TextInput
            accessibilityLabel="Dirección del equipo"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            keyboardType="url"
            onChangeText={setOrigin}
            placeholder="https://equipo.example"
            placeholderTextColor={appearance.color.secondary}
            style={styles.input}
            value={origin}
          /></GlassSurface>
          <GlassSurface style={{ borderRadius: appearance.control.menuRadius }}><Pressable
            accessibilityRole="button"
            accessibilityLabel="Agregar equipo"
            disabled={busy || !name.trim() || !origin.trim()}
            onPress={() => { void add(); }}
            style={({ pressed }) => [styles.addButton, pressed && styles.pressed, (busy || !name.trim() || !origin.trim()) && styles.disabled]}
          >
            {busy ? <ActivityIndicator color={appearance.color.text} /> : <Text style={styles.addText}>Agregar</Text>}
          </Pressable></GlassSurface>
        </View>
      </>

      {!!error && <DismissibleNotice message={error} dismiss={() => setError('')} />}
    </ScrollView>
  </KeyboardAvoidingView>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: appearance.color.background },
  content: { flexGrow: 1, padding: contentPadding, gap: appearance.spacing.md },
  title: { color: appearance.color.text, fontSize: appearance.text.title, fontWeight: appearance.weight.strong, marginTop: appearance.spacing.md },
  subtitle: { color: appearance.color.secondary, fontSize: appearance.text.body, lineHeight: appearance.text.bodyLineHeight, marginBottom: appearance.spacing.sm },
  device: { borderRadius: appearance.control.menuRadius, overflow: 'hidden' },
  selectedDevice: { borderColor: appearance.color.success, borderWidth: 1 },
  deviceSelect: { minHeight: 68, paddingHorizontal: appearance.spacing.lg, paddingVertical: appearance.spacing.md, flexDirection: 'row', alignItems: 'center', gap: appearance.spacing.md },
  deviceText: { flex: 1, gap: appearance.spacing.xs },
  deviceName: { color: appearance.color.text, fontSize: appearance.text.body, fontWeight: appearance.weight.strong },
  deviceOrigin: { color: appearance.color.secondary, fontSize: appearance.text.compact },
  deviceAction: { color: appearance.color.text, fontSize: appearance.text.caption, fontWeight: appearance.weight.strong },
  remove: { minHeight: appearance.control.size, paddingHorizontal: appearance.spacing.lg, justifyContent: 'center', borderTopColor: appearance.color.border, borderTopWidth: StyleSheet.hairlineWidth },
  removeText: { color: appearance.color.secondary, fontSize: appearance.text.caption, fontWeight: appearance.weight.label },
  form: { marginTop: appearance.spacing.md, gap: appearance.spacing.sm },
  formTitle: { color: appearance.color.text, fontSize: appearance.text.heading, fontWeight: appearance.weight.strong },
  input: { minHeight: appearance.control.size, paddingHorizontal: appearance.spacing.md, borderRadius: appearance.control.menuRadius, backgroundColor: appearance.color.surface, color: appearance.color.text, fontSize: appearance.text.body },
  addButton: { minHeight: appearance.control.size, borderRadius: appearance.control.menuRadius, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  addText: { color: appearance.color.text, fontSize: appearance.text.body, fontWeight: appearance.weight.strong },
  error: { color: appearance.color.warning, fontSize: appearance.text.caption, lineHeight: appearance.text.captionLineHeight, marginTop: 4 },
  pressed: { opacity: appearance.state.pressed },
  disabled: { opacity: appearance.state.disabled },
});
