import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Keyboard, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { keepSessionAwake } from '../lib/session-awake';
import * as Updates from 'expo-updates';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { RTCView, type MediaStream } from '@livekit/react-native-webrtc';
import { GlassButton } from '../components/glass-button';
import { LandscapeControls } from '../components/landscape-controls';
import { TouchSurface } from '../components/touch-surface';
import { useAttachmentTransfer } from '../components/attachment-transfer';
import { NativeKeyboard } from '../components/native-keyboard';
import { HelpSheet } from '../components/help-sheet';
import { SessionOptions } from '../components/session-options';
import { loadControlPreferences, saveControlPreferences, type ControlPreferences } from '../lib/control-preferences';
import { transferClipboard } from '../lib/clipboard-transfer';
import { Connection, type ConnectionState } from '../lib/connection';
import { startVideo } from '../lib/video';
import { UpdateLifecycle } from '../lib/updates';
import { PreviewLifecycle } from '../lib/preview-lifecycle';
import { selectPointerGeometry } from '../lib/pointer-geometry';
import { keyboardOverlap, keyboardWindowResize } from '../components/keyboard-layout';

const messages: Record<ConnectionState, string> = {
  connecting: 'Conectando…', connected: '', offline: 'Esperando a tu computadora…',
  unauthorized: 'Este dispositivo todavía no está autorizado en la laptop.', paused: 'Otra sesión tomó el control. Tocá reconectar para recuperarlo.',
  incompatible: 'Las versiones de PhonePad no son compatibles. Actualizá la app y el equipo.',
};
export function Control({ origin, onChangeHost }: { origin: string; onChangeHost: () => void }) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const receiverWidth = useRef(width); receiverWidth.current = width;
  const keyboardHeight = useKeyboardState(state => state.isVisible ? state.height : 0);
  const [state, setState] = useState<ConnectionState>('connecting');
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [preview, setPreview] = useState(false), [keyboard, setKeyboard] = useState(false);
  const [help, setHelp] = useState(false);
  const [options, setOptions] = useState(false);
  const [preferences, setPreferences] = useState(() => loadControlPreferences(origin));
  const [clipboardBusy, setClipboardBusy] = useState(false);
  const [clipboardNotice, setClipboardNotice] = useState('');
  const clipboardRequest = useRef<AbortController | null>(null);
  useEffect(() => { setPreferences(loadControlPreferences(origin)); return () => { clipboardRequest.current?.abort(); }; }, [origin]);
  const changePreferences = (next: ControlPreferences) => {
    try { saveControlPreferences(origin, next); setPreferences(next); } catch { Alert.alert('No se guardó el ajuste', 'Reintentá antes de salir de la sesión.'); }
  };
  const preKeyboardHeight = useRef(height);
  const preKeyboardWidth = useRef(width);
  if (preKeyboardWidth.current !== width) { preKeyboardWidth.current = width; preKeyboardHeight.current = height; }
  const previousKeyboard = useRef(keyboard);
  const [pendingText, setPendingText] = useState(false);
  const [, refreshCapabilities] = useState(0);
  const [landscapeControls, setLandscapeControls] = useState(false);
  const [videoSize, setVideoSize] = useState({ width: 0, height: 0 });
  const [stream, setStream] = useState<MediaStream | null>(null), [videoError, setVideoError] = useState('');
  const connection = useMemo(() => new Connection(origin, setState, () => refreshCapabilities(n => n + 1)), [origin]);
  const video = useMemo(() => new PreviewLifecycle<MediaStream>(
    (signal, show, failed) => startVideo(origin, signal, show, failed, () => connection.capabilities?.sessionEpoch ?? null, () => receiverWidth.current), setStream, setVideoError,
  ), [origin, connection]);
  const pointerGeometry = useMemo(() => selectPointerGeometry(connection.capabilities), [connection, connection.capabilities]);
  const inputReady = state === 'connected' && connection.canInput;
  const directReady = inputReady && preview && !!stream && !!connection.capabilities?.input.actions.includes('p');
  const mode = preferences.mode === 'direct' && directReady ? 'direct' : 'trackpad';
  const copyClipboard = async (direction: 'phone' | 'host') => {
    if (clipboardRequest.current) return;
    const request = new AbortController(); clipboardRequest.current = request; setClipboardBusy(true); setClipboardNotice('Copiando…');
    const timeout = setTimeout(() => request.abort(), 10000);
    try { await transferClipboard(connection, direction, request.signal); setClipboardNotice(direction === 'phone' ? 'Texto copiado al teléfono.' : 'Texto copiado al equipo.'); }
    catch (error) { setClipboardNotice(error instanceof Error ? error.message : 'No se confirmó la copia.'); }
    finally { clearTimeout(timeout); clipboardRequest.current = null; setClipboardBusy(false); }
  };
  useEffect(() => { if (!foreground || state !== 'connected') clipboardRequest.current?.abort(); }, [foreground, state]);
  useEffect(() => {
    if (foreground && state === 'connected') return keepSessionAwake(activateKeepAwakeAsync, deactivateKeepAwake, `phonepad-${Date.now()}-${Math.random()}`);
  }, [foreground, state, connection]);
  const attachments = useAttachmentTransfer(origin, state === 'connected' && connection.canTransfer,
    () => connection.send({ t: 'k', a: 'combo', mods: ['ctrl'], key: 'v' }), connection.canClipboard, connection.capabilities?.sessionEpoch);
  const { isUpdatePending } = Updates.useUpdates();
  const updater = useMemo(() => new UpdateLifecycle({
    enabled: Updates.isEnabled,
    check: Updates.checkForUpdateAsync,
    download: Updates.fetchUpdateAsync,
    reload: () => Updates.reloadAsync(),
  }, active => {
    if (active) connection.start(); else { connection.stop(); setKeyboard(false); }
    setForeground(active);
  }), [connection]);
  const [composerHeight, setComposerHeight] = useState(0);
  const landscape = width > height;
  const landscapePreview = preview && landscape;
  const keyboardVisible = keyboard && keyboardHeight > 0;
  const windowResize = keyboardWindowResize(preKeyboardHeight.current, height, keyboardVisible);
  // Android may resize the root window while iOS keeps its full height. Use
  // only the portion not already reflected by the current window dimensions.
  const residualKeyboardOverlap = keyboardOverlap(keyboardHeight, height, windowResize);
  const previewInset = landscapePreview ? Math.min(Math.max(0, height - 1), residualKeyboardOverlap + (keyboard ? composerHeight : 0)) : 0;
  const previewStyle = landscapePreview && previewInset > 0
    ? { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: previewInset }
    : StyleSheet.absoluteFill;
  useEffect(() => {
    if (!keyboard) preKeyboardHeight.current = height;
    else if (!previousKeyboard.current) preKeyboardHeight.current = height;
    previousKeyboard.current = keyboard;
  }, [keyboard, height]);
  useEffect(() => { if (!inputReady) setKeyboard(false); }, [inputReady]);
  useEffect(() => {
    updater.start(AppState.currentState);
    const listener = AppState.addEventListener('change', next => updater.setAppState(next));
    return () => { listener.remove(); updater.dispose(); connection.stop(); };
  }, [updater, connection]);
  useEffect(() => { if (isUpdatePending) updater.markReady(); }, [isUpdatePending, updater]);
  useEffect(() => { updater.setPreview(preview || pendingText || attachments.busy || attachments.pending); }, [preview, pendingText, attachments.busy, attachments.pending, updater]);
  const viewAllowed = connection.capabilities === null || connection.canView;
  useEffect(() => { video.update(preview && viewAllowed && !['unauthorized', 'paused', 'incompatible'].includes(state), foreground, state === 'connected'); }, [video, preview, foreground, state, viewAllowed]);
  useEffect(() => () => video.dispose(), [video]);
  const reconnect = () => { connection.start(); video.restart(); void updater.check(true); };
  const closeKeyboard = useCallback(() => { Keyboard.dismiss(); setKeyboard(false); }, []);
  const openKeyboard = useCallback(() => setKeyboard(true), []);
  const closeHelp = useCallback(() => setHelp(false), []);
  const openHelp = useCallback(() => { closeKeyboard(); setHelp(true); }, [closeKeyboard]);
  const openOptions = () => { closeKeyboard(); setOptions(true); };
  const changeHost = () => {
    const literal = connection.literal;
    if (pendingText || literal.busy || literal.pending || literal.draft || literal.lateDraft || attachments.busy || attachments.pending) {
      Alert.alert('Hay contenido pendiente', 'Revisá el texto y los adjuntos antes de cambiar de equipo. Se conservan en esta sesión.');
      return;
    }
    closeKeyboard();
    onChangeHost();
  };
  const hideLandscapeControls = useCallback(() => { closeKeyboard(); setLandscapeControls(false); }, [closeKeyboard]);
  // Reset on actual orientation changes, including when the preview is off.
  // The RTC view and stream stay mounted throughout the transition.
  useEffect(() => { setLandscapeControls(false); }, [landscape, preview]);
  const togglePreview = () => { setPreview(p => !p); closeKeyboard(); };
  const controlNotice = state === 'connected' && !inputReady
    ? 'Solo visualización. El control no está disponible en este equipo.'
    : state === 'connected' && connection.lastRejection ? 'El equipo rechazó la acción. Revisá los permisos y el contenido pendiente.' : '';
  const status = <View accessibilityLabel={state === 'connected' ? 'Conectado' : messages[state]} style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: state === 'connected' ? '#70dbab' : '#b7bbc4' }} />;
  // Keep the RTC view mounted while its visible rectangle follows the actual
  // free window area. The stream/decoder never changes when the keyboard opens.
  return <View pointerEvents={foreground ? 'auto' : 'none'} style={{ flex: 1, backgroundColor: '#090b0e' }}>
    <StatusBar style="light" hidden={landscapePreview} />
    <TouchSurface connection={connection} preview={preview} dismissKeyboard={keyboard && !preview ? closeKeyboard : undefined}
      pointerGeometry={pointerGeometry.geometry} pointerGeometryEpoch={pointerGeometry.geometryEpoch}
      mode={mode} gain={preferences.gain} disabled={!inputReady || options || help || !foreground}
      videoSize={videoSize} viewportInsetBottom={previewInset}>
      {stream && <RTCView streamURL={stream.toURL()} objectFit="contain" mirror={false} style={previewStyle} onDimensionsChange={event => {
        // The native renderer has received a sized frame; an SDP/track alone
        // isn't evidence of a working preview.
        if (event.nativeEvent.width > 0 && event.nativeEvent.height > 0) { setVideoError(''); setVideoSize({ width: event.nativeEvent.width, height: event.nativeEvent.height }); }
      }} />}
    </TouchSurface>
    {landscapePreview ? <LandscapeControls visible={landscapeControls && !keyboard}
      show={() => { closeKeyboard(); setLandscapeControls(true); }} hide={hideLandscapeControls}
      openKeyboard={() => { setLandscapeControls(false); openKeyboard(); }}
      reconnect={openOptions} exitPreview={togglePreview} optionsLabel="Opciones"
      disabled={!inputReady} insets={insets} /> : <View pointerEvents="box-none" style={{ position: 'absolute', top: insets.top + 8, left: insets.left + 16, right: insets.right + 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <GlassButton label="Equipos" action="hosts" onPress={changeHost} />
        <GlassButton label="Reconectar" action="reconnect" onPress={() => { closeKeyboard(); reconnect(); }} />
      </View>
      {status}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <GlassButton label="Opciones" action="shortcuts" onPress={openOptions} />
        <GlassButton label={preview ? 'Ocultar pantalla' : 'Ver pantalla'} action="screen" selected={preview} onPress={togglePreview} />
      </View>
    </View>}
    {!!(messages[state] || (preview && videoError)) && <View pointerEvents="none" style={{ position: 'absolute', left: 28, right: 28, top: '44%' }}>
      <Text selectable style={{ color: '#b7bbc4', fontSize: 14, textAlign: 'center', lineHeight: 22 }}>{messages[state] || videoError}</Text>
    </View>}
    {!!controlNotice && <View pointerEvents="none" style={{ position: 'absolute', top: insets.top + 78, left: insets.left + 24, right: insets.right + 24 }}>
      <Text accessibilityRole="alert" style={{ color: '#b7bbc4', fontSize: 12, textAlign: 'center' }}>{controlNotice}</Text>
    </View>}
    {attachments.panel}
    <NativeKeyboard connection={connection} active={keyboard} open={openKeyboard} close={closeKeyboard}
      onPendingChange={setPendingText} onOcclusionChange={setComposerHeight}
      canReview={state === 'connected'} allowAttachments={state === 'connected' && connection.canTransfer}
     visible={!landscapePreview || keyboard}
      disabled={!inputReady} choosing={attachments.busy} choose={attachments.choose} />
    <HelpSheet visible={help} close={closeHelp} mode={mode} />
    <SessionOptions visible={options} close={() => setOptions(false)} preferences={preferences} change={changePreferences} direct={directReady}
      clipboard={state === 'connected' && connection.canClipboard && !!connection.capabilities?.sessionEpoch} copy={direction => void copyClipboard(direction)} busy={clipboardBusy} notice={clipboardNotice}
      help={() => { setOptions(false); openHelp(); }} hosts={() => { setOptions(false); changeHost(); }} />
  </View>;
}
