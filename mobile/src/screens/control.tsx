import { appearance } from '../components/appearance';
import type { CursorState } from '../lib/cursor';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Keyboard, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { keepSessionAwake } from '../lib/session-awake';
import * as Updates from 'expo-updates';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { RTCView, type MediaStream } from '@livekit/react-native-webrtc';
import { GlassSurface } from '../components/glass-surface';
import { GlassButton } from '../components/glass-button';
import { HostMenu } from '../components/host-menu';
import { LandscapeControls } from '../components/landscape-controls';
import { TouchSurface } from '../components/touch-surface';
import { useAttachmentTransfer } from '../components/attachment-transfer';
import { NativeKeyboard } from '../components/native-keyboard';
import { SessionOptions } from '../components/session-options';
import { loadControlPreferences, saveControlPreferences, type ControlPreferences } from '../lib/control-preferences';
import { Connection, type ConnectionState } from '../lib/connection';
import { startVideo } from '../lib/video';
import { UpdateLifecycle } from '../lib/updates';
import { PreviewLifecycle } from '../lib/preview-lifecycle';
import { selectPointerGeometry } from '../lib/pointer-geometry';
import { keyboardOverlap, keyboardWindowResize } from '../components/keyboard-layout';

const messages: Record<ConnectionState, string> = {
  connecting: 'Conectando…', connected: '', offline: 'Esperando a tu computadora…',
  unauthorized: 'Autorizá este teléfono en el equipo.', paused: 'Sesión pausada. Tocá reconectar.',
  incompatible: 'Las versiones de PhonePad no son compatibles. Actualizá la app y el equipo.',
};
export function Control({ origin, onSelectHost, initialPreview = false }: { origin: string; onSelectHost: (origin: string) => void; initialPreview?: boolean }) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const receiverWidth = useRef(width); receiverWidth.current = width;
  const receiverOrientation = useRef(width > height ? 'landscape' : 'portrait');
  receiverOrientation.current = width > height ? 'landscape' : 'portrait';
  const keyboardHeight = useKeyboardState(state => state.isVisible ? state.height : 0);
  const [state, setState] = useState<ConnectionState>('connecting');
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [preview, setPreview] = useState(initialPreview), [keyboard, setKeyboard] = useState(false);
  const [options, setOptions] = useState(false);
  const [hostsOpen, setHostsOpen] = useState(false);
  const [preferences, setPreferences] = useState(() => loadControlPreferences(origin));
  useEffect(() => { setPreferences(loadControlPreferences(origin)); }, [origin]);
  const preferenceWrite = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingPreferences = useRef<{origin: string; value: ControlPreferences} | null>(null);
  const flushPreferences = () => {
    clearTimeout(preferenceWrite.current);
    const pending = pendingPreferences.current;
    if (!pending) return;
    try { saveControlPreferences(pending.origin, pending.value); pendingPreferences.current = null; }
    catch { Alert.alert('No se guardó el ajuste', 'Volvé a intentarlo.'); }
  };
  useEffect(() => {
    const listener = AppState.addEventListener('change', state => { if (state !== 'active') flushPreferences(); });
    return () => { listener.remove(); flushPreferences(); };
  }, [origin]);
  const changePreferences = (next: ControlPreferences) => {
    setPreferences(next); pendingPreferences.current = {origin,value:next};
    clearTimeout(preferenceWrite.current);
    preferenceWrite.current = setTimeout(flushPreferences,250);
  };
  const preKeyboardHeight = useRef(height);
  const preKeyboardWidth = useRef(width);
  if (preKeyboardWidth.current !== width) { preKeyboardWidth.current = width; preKeyboardHeight.current = height; }
  const previousKeyboard = useRef(keyboard);
  const [pendingText, setPendingText] = useState(false);
  const [, refreshCapabilities] = useState(0);
  const [cursor, setCursor] = useState<CursorState | null>(null);
  const [videoSize, setVideoSize] = useState({ width: 0, height: 0 });
  const [stream, setStream] = useState<MediaStream | null>(null), [videoError, setVideoError] = useState('');
  const connection = useMemo(() => new Connection(origin, setState, () => refreshCapabilities(n => n + 1)), [origin]);
  const video = useMemo(() => new PreviewLifecycle<MediaStream>(
    (signal, show, failed) => startVideo(origin, signal, show, failed, () => connection.capabilities?.sessionEpoch ?? null, () => receiverWidth.current, setCursor, () => receiverOrientation.current), setStream, setVideoError,
  ), [origin, connection]);
  const pointerGeometry = useMemo(() => selectPointerGeometry(connection.capabilities), [connection, connection.capabilities]);
  const inputReady = state === 'connected' && connection.canInput;
  const directReady = inputReady && preview && !!stream && !!connection.capabilities?.input.actions.includes('p');
  const mode = preferences.mode === 'direct' && directReady ? 'direct' : 'trackpad';
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
    connection.setForeground(active);
    if (!active) setKeyboard(false);
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
  const previewInset = preview ? Math.min(Math.max(0, height - 1), residualKeyboardOverlap + (keyboard ? composerHeight : 0)) : 0;
  const previewTop = preview && !landscapePreview && previewInset > 0 ? insets.top + appearance.control.size + appearance.control.margin * 2 : 0;
  const sideRail = appearance.control.size + 2 * appearance.control.gap + appearance.control.margin;
  const previewLeft = landscapePreview ? insets.left + sideRail : 0;
  const previewRight = landscapePreview ? insets.right + sideRail : 0;
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
  const reconnect = () => { video.update(preview && viewAllowed, foreground, false); video.restart(); connection.start(); void updater.check(true); };
  const closeKeyboard = useCallback(() => { Keyboard.dismiss(); setKeyboard(false); }, []);
  const openKeyboard = useCallback(() => setKeyboard(true), []);
  const openOptions = () => { closeKeyboard(); setOptions(true); };
  const togglePreview = () => { closeKeyboard(); if (preview) setPreview(false); else setHostsOpen(true); };
  const canSwitchHost = () => {
    if (!pendingText && !attachments.busy && !attachments.pending) return true;
    Alert.alert('Hay contenido pendiente', 'Terminá o descartá el texto o los archivos antes de cambiar de equipo.');
    return false;
  };
  const controlNotice = state === 'connected' && !inputReady
    ? 'Solo lectura'
    : state === 'connected' && connection.lastRejection ? 'Acción rechazada.' : '';
  const status = <View accessibilityLabel={state === 'connected' ? 'Conectado' : messages[state]} style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: state === 'connected' ? appearance.color.success : appearance.color.secondary }} />;
  // Keep the RTC view mounted while its visible rectangle follows the actual
  // free window area. The stream/decoder never changes when the keyboard opens.
  return <View pointerEvents={foreground ? 'auto' : 'none'} style={{ flex: 1, backgroundColor: appearance.color.background }}>
    <StatusBar style="light" hidden={landscapePreview} />
    <TouchSurface cursor={stream ? cursor : null} cursorScale={preferences.cursorScale} connection={connection} preview={preview} dismissKeyboard={keyboard ? closeKeyboard : undefined}
      pointerGeometry={pointerGeometry.geometry} pointerGeometryEpoch={pointerGeometry.geometryEpoch}
      mode={mode} gain={preferences.gain} disabled={!inputReady || options || !foreground}
      videoSize={videoSize} viewportInsetBottom={previewInset} viewportInsetTop={previewTop} viewportInsetLeft={previewLeft} viewportInsetRight={previewRight}>
      {stream && <RTCView streamURL={stream.toURL()} objectFit="contain" mirror={false} style={StyleSheet.absoluteFill} onDimensionsChange={event => {
        // The native renderer has received a sized frame; an SDP/track alone
        // isn't evidence of a working preview.
        if (event.nativeEvent.width > 0 && event.nativeEvent.height > 0) { setVideoError(''); setVideoSize({ width: event.nativeEvent.width, height: event.nativeEvent.height }); }
      }} />}
    </TouchSurface>
    {landscapePreview ? <LandscapeControls openKeyboard={() => { if (keyboard) closeKeyboard(); else openKeyboard(); }} keyboardOpen={keyboard}
      reconnect={() => { closeKeyboard(); reconnect(); }} openOptions={openOptions} exitPreview={togglePreview}
      disabled={!inputReady} insets={insets} viewportInsetBottom={previewInset} /> : <View pointerEvents="box-none" style={{ position: 'absolute', top: insets.top + 8, left: 0, right: 0, paddingLeft: insets.left + 16, paddingRight: insets.right + 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <GlassButton label="Reconectar" action="reconnect" onPress={() => { closeKeyboard(); reconnect(); }} />
      </View>
      <GlassSurface interactive style={{flexDirection:'row',borderRadius:appearance.control.capsuleRadius}}>
        <GlassButton compact label="Mouse" action="mouse" onPress={openOptions} />
        <GlassButton compact label={preview ? 'Ocultar pantalla' : 'Ver pantalla'} action="screen" selected={preview} onPress={togglePreview} />
      </GlassSurface>
    </View>}
    {!landscapePreview && <View pointerEvents="none" style={{position:'absolute',left:0,right:0,top:insets.top+8,height:appearance.control.size,alignItems:'center',justifyContent:'center'}}>{status}</View>}
    {!!(messages[state] || (preview && videoError)) && <View pointerEvents="none" style={{ position: 'absolute', left: 28, right: 28, top: '44%' }}>
      <Text selectable style={{ color: appearance.color.secondary, fontSize: 14, textAlign: 'center', lineHeight: 22 }}>{messages[state] || videoError}</Text>
    </View>}
    {!!controlNotice && <View pointerEvents="none" style={{ position: 'absolute', top: insets.top + 78, left: insets.left + 24, right: insets.right + 24 }}>
      <Text accessibilityRole="alert" style={{ color: appearance.color.secondary, fontSize: 12, textAlign: 'center' }}>{controlNotice}</Text>
    </View>}
    {attachments.panel}
    <NativeKeyboard connection={connection} active={keyboard} open={openKeyboard} close={closeKeyboard}
      onPendingChange={setPendingText} onOcclusionChange={setComposerHeight}
      canReview={state === 'connected'} allowAttachments={state === 'connected' && connection.canTransfer}
     visible={!landscapePreview || keyboard}
      disabled={!inputReady} choosing={attachments.busy} choose={attachments.choose} offerClipboardImage={attachments.offerClipboardImage} />
    <SessionOptions visible={options} close={() => setOptions(false)} preferences={preferences} change={changePreferences} />
    <HostMenu visible={hostsOpen} activeOrigin={origin} connected={state === 'connected'} close={() => setHostsOpen(false)}
      canSwitch={canSwitchHost} select={next => { if (next === origin) setPreview(true); else onSelectHost(next); }} />
  </View>;
}
