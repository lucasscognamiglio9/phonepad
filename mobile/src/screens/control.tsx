import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Keyboard, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Updates from 'expo-updates';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { RTCView, type MediaStream } from '@livekit/react-native-webrtc';
import { GlassButton } from '../components/glass-button';
import { LandscapeControls } from '../components/landscape-controls';
import { TouchSurface } from '../components/touch-surface';
import { useAttachmentTransfer } from '../components/attachment-transfer';
import { NativeKeyboard } from '../components/native-keyboard';
import { Connection, type ConnectionState } from '../lib/connection';
import { startVideo } from '../lib/video';
import { UpdateLifecycle } from '../lib/updates';
import { PreviewLifecycle } from '../lib/preview-lifecycle';
import { keyboardOverlap, keyboardWindowResize } from '../components/keyboard-layout';

const messages: Record<ConnectionState, string> = {
  connecting: 'Conectando…', connected: '', offline: 'Esperando a tu computadora…',
  unauthorized: 'Este dispositivo todavía no está autorizado en la laptop.', paused: 'Otra sesión tomó el control. Tocá reconectar para recuperarlo.',
  incompatible: 'Las versiones de PhonePad no son compatibles. Actualizá la app y el equipo.',
};
export function Control({ origin, onChangeHost }: { origin: string; onChangeHost: () => void }) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const keyboardHeight = useKeyboardState(state => state.isVisible ? state.height : 0);
  const [state, setState] = useState<ConnectionState>('connecting');
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [preview, setPreview] = useState(false), [keyboard, setKeyboard] = useState(false);
  const preKeyboardHeight = useRef(height);
  const previousKeyboard = useRef(keyboard);
  const [pendingText, setPendingText] = useState(false);
  const [, refreshCapabilities] = useState(0);
  const [landscapeControls, setLandscapeControls] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null), [videoError, setVideoError] = useState('');
  const video = useMemo(() => new PreviewLifecycle<MediaStream>(
    (signal, show, failed) => startVideo(origin, signal, show, failed), setStream, setVideoError,
  ), [origin]);
  const connection = useMemo(() => new Connection(origin, setState, () => refreshCapabilities(n => n + 1)), [origin]);
  const inputReady = state === 'connected' && connection.canInput;
  const attachments = useAttachmentTransfer(origin, state === 'connected' && connection.canTransfer,
    () => connection.send({ t: 'k', a: 'combo', mods: ['ctrl'], key: 'v' }), connection.canClipboard);
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
  const landscape = width > height;
  const landscapePreview = preview && landscape;
  const keyboardVisible = keyboard && keyboardHeight > 0;
  const windowResize = keyboardWindowResize(preKeyboardHeight.current, height, keyboardVisible);
  // Android may resize the root window while iOS keeps its full height. Use
  // only the portion not already reflected by the current window dimensions.
  const residualKeyboardOverlap = keyboardOverlap(keyboardHeight, height, windowResize);
  const previewStyle = landscapePreview && residualKeyboardOverlap > 0
    ? { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: residualKeyboardOverlap }
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
  useEffect(() => { hideLandscapeControls(); }, [landscape, preview, hideLandscapeControls]);
  const togglePreview = () => { setPreview(p => !p); closeKeyboard(); };
  const controlNotice = state === 'connected' && !inputReady
    ? 'Solo visualización. El control no está disponible en este equipo.'
    : state === 'connected' && connection.lastRejection ? 'El equipo rechazó la acción. Revisá los permisos y el contenido pendiente.' : '';
  const status = <View accessibilityLabel={state === 'connected' ? 'Conectado' : messages[state]} style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: state === 'connected' ? '#70dbab' : '#b7bbc4' }} />;
  // Keep the RTC view mounted while its visible rectangle follows the actual
  // free window area. The stream/decoder never changes when the keyboard opens.
  return <View pointerEvents={foreground ? 'auto' : 'none'} style={{ flex: 1, backgroundColor: '#090b0e' }}>
    <StatusBar style="light" hidden={landscapePreview} />
    <TouchSurface connection={connection} preview={preview} dismissKeyboard={keyboard ? closeKeyboard : undefined}>
      {stream && <RTCView streamURL={stream.toURL()} objectFit="contain" mirror={false} style={previewStyle} onDimensionsChange={event => {
        // The native renderer has received a sized frame; an SDP/track alone
        // isn't evidence of a working preview.
        if (event.nativeEvent.width > 0 && event.nativeEvent.height > 0) setVideoError('');
      }} />}
    </TouchSurface>
    {landscapePreview ? <LandscapeControls visible={landscapeControls && !keyboard}
      show={() => { closeKeyboard(); setLandscapeControls(true); }} hide={hideLandscapeControls}
      openKeyboard={() => { setLandscapeControls(false); openKeyboard(); }}
      reconnect={() => { hideLandscapeControls(); reconnect(); }} exitPreview={togglePreview}
      disabled={!inputReady} insets={insets} /> : <View pointerEvents="box-none" style={{ position: 'absolute', top: insets.top + 8, left: insets.left + 16, right: insets.right + 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <GlassButton label="Equipos" action="hosts" onPress={changeHost} />
        <GlassButton label="Reconectar" action="reconnect" onPress={() => { closeKeyboard(); reconnect(); }} />
      </View>
      {status}
      <GlassButton label={preview ? 'Ocultar pantalla' : 'Ver pantalla'} action="screen" selected={preview} onPress={togglePreview} />
    </View>}
    {!!(messages[state] || (preview && videoError)) && <View pointerEvents="none" style={{ position: 'absolute', left: 28, right: 28, top: '44%' }}>
      <Text selectable style={{ color: '#b7bbc4', fontSize: 14, textAlign: 'center', lineHeight: 22 }}>{messages[state] || videoError}</Text>
    </View>}
    {!!controlNotice && <View pointerEvents="none" style={{ position: 'absolute', top: insets.top + 78, left: insets.left + 24, right: insets.right + 24 }}>
      <Text accessibilityRole="alert" style={{ color: '#b7bbc4', fontSize: 12, textAlign: 'center' }}>{controlNotice}</Text>
    </View>}
    {attachments.panel}
    <NativeKeyboard connection={connection} active={keyboard} open={openKeyboard} close={closeKeyboard}
      onPendingChange={setPendingText}
      canReview={state === 'connected'} allowAttachments={state === 'connected' && connection.canTransfer}
     visible={!landscapePreview || keyboard}
      disabled={!inputReady} choosing={attachments.busy} choose={attachments.choose} />
  </View>;
}
