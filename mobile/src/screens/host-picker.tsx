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

const contentPadding = 24;

export type HostPickerProps = {
  onSelect: (origin: string) => void;
  /** Set false when returning to this screen to let the user choose again. */
  autoSelect?: boolean;
  /** Injectable for tests and for a future account/profile scope. */
  adapter?: HostSettingsAdapter;
};

function errorMessage(error: unknown): string {
  if (error instanceof HostSettingsError) return error.message;
  return 'No se pudo actualizar la lista de equipos. Podés volver a intentarlo.';
}

export function HostPicker({ onSelect, autoSelect = true, adapter = hostSettingsAdapter }: HostPickerProps) {
  const insets = useSafeAreaInsets();
  const [settings, setSettings] = useState<HostSettings>(createDefaultHostSettings);
  const [name, setName] = useState('');
  const [origin, setOrigin] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const onSelectRef = useRef(onSelect);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  onSelectRef.current = onSelect;

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
        setError(result.error?.message ?? '');
        if (autoSelect && result.origin) onSelectRef.current(result.origin);
      })
      .catch(() => {
        if (!mounted) return;
        setReady(true);
        setError('No se pudo leer la lista de equipos. Podés volver a intentarlo.');
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
      setError(result.error.message);
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

      {!ready ? <ActivityIndicator accessibilityLabel="Cargando equipos" color="#b7e3ff" style={styles.loader} /> : <>
        {settings.devices.map(device => {
          const selected = settings.selected === device.id;
          return <View key={device.id} style={[styles.device, selected && styles.selectedDevice]}>
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
          </View>;
        })}

        <View style={styles.form}>
          <Text style={styles.formTitle}>Agregar equipo</Text>
          <TextInput
            accessibilityLabel="Nombre del equipo"
            autoCapitalize="sentences"
            autoCorrect={false}
            editable={!busy}
            onChangeText={setName}
            placeholder="Nombre, por ejemplo Oficina"
            placeholderTextColor="#858b96"
            style={styles.input}
            value={name}
          />
          <TextInput
            accessibilityLabel="Dirección del equipo"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            keyboardType="url"
            onChangeText={setOrigin}
            placeholder="https://equipo.example"
            placeholderTextColor="#858b96"
            style={styles.input}
            value={origin}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Agregar equipo"
            disabled={busy || !name.trim() || !origin.trim()}
            onPress={() => { void add(); }}
            style={({ pressed }) => [styles.addButton, pressed && styles.pressed, (busy || !name.trim() || !origin.trim()) && styles.disabled]}
          >
            {busy ? <ActivityIndicator color="#090b0e" /> : <Text style={styles.addText}>Agregar</Text>}
          </Pressable>
        </View>
      </>}

      {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    </ScrollView>
  </KeyboardAvoidingView>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#090b0e' },
  content: { flexGrow: 1, padding: contentPadding, gap: 12 },
  title: { color: '#f4f5f7', fontSize: 24, fontWeight: '600', marginTop: 12 },
  subtitle: { color: '#b7bbc4', fontSize: 14, lineHeight: 20, marginBottom: 8 },
  loader: { marginTop: 40 },
  device: { borderRadius: 16, backgroundColor: '#171a20', overflow: 'hidden' },
  selectedDevice: { borderColor: '#70dbab', borderWidth: 1 },
  deviceSelect: { minHeight: 68, paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12 },
  deviceText: { flex: 1, gap: 4 },
  deviceName: { color: '#f4f5f7', fontSize: 16, fontWeight: '600' },
  deviceOrigin: { color: '#b7bbc4', fontSize: 12 },
  deviceAction: { color: '#b7e3ff', fontSize: 13, fontWeight: '600' },
  remove: { minHeight: 40, paddingHorizontal: 16, justifyContent: 'center', borderTopColor: '#2b2f37', borderTopWidth: StyleSheet.hairlineWidth },
  removeText: { color: '#ff9f9f', fontSize: 13, fontWeight: '500' },
  form: { marginTop: 12, gap: 10 },
  formTitle: { color: '#f4f5f7', fontSize: 17, fontWeight: '600' },
  input: { minHeight: 48, paddingHorizontal: 14, borderRadius: 12, backgroundColor: '#171a20', color: '#f4f5f7', fontSize: 15, borderColor: '#2b2f37', borderWidth: 1 },
  addButton: { minHeight: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: '#b7e3ff', marginTop: 2 },
  addText: { color: '#090b0e', fontSize: 15, fontWeight: '700' },
  error: { color: '#ffb4b4', fontSize: 13, lineHeight: 18, marginTop: 4 },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.45 },
});
