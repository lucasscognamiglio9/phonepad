import { useSharedValue } from 'react-native-reanimated';
import { reflectionRest } from '../components/glass-reflection';
import { appearance } from '../components/appearance';
import { CursorFeed } from '../lib/cursor';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Dimensions, Keyboard, StyleSheet, View, useWindowDimensions } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { keepSessionAwake } from '../lib/session-awake';
import * as Updates from 'expo-updates';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeyboardState, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { RTCView, type MediaStream } from '@livekit/react-native-webrtc';
import { HostMenu } from '../components/host-menu';
import { SessionControls } from '../components/session-controls';
import { TouchSurface } from '../components/touch-surface';
import { useAttachmentTransfer } from '../components/attachment-transfer';
import { NativeKeyboard } from '../components/native-keyboard';
import { DismissibleNotice } from '../components/dismissible-notice';
import { noticeMessage } from '../lib/notice-message';
import { SessionOptions } from '../components/session-options';
import { loadControlPreferences, saveControlPreferences, type ControlPreferences } from '../lib/control-preferences';
import { Connection, type ConnectionState } from '../lib/connection';
import { startVideo } from '../lib/video';
import { UpdateLifecycle } from '../lib/updates';
import { PreviewLifecycle } from '../lib/preview-lifecycle';
import { selectPointerGeometry } from '../lib/pointer-geometry';
import { landscapeLayout, topPreviewHeight } from '../lib/control-layout';
import { pasteToHost } from '../lib/text-delivery';
import { keyboardOverlap, KeyboardViewport } from '../components/keyboard-layout';

const messages: Record<ConnectionState, string> = {
  connecting: 'Conectando…', connected: '', offline: 'Sin conexión.',
  unauthorized: 'Autorizá el iPhone en el equipo.', paused: 'Sesión pausada.',
  incompatible: 'Actualizá PhonePad y el equipo.',
};
export function Control({ origin, onSelectHost, initialPreview = false, onStartupComplete }: { origin: string; onSelectHost: (origin: string) => void; initialPreview?: boolean; onStartupComplete?: () => void }) {
  const insets = useSafeAreaInsets();
  const glassPointer = useSharedValue<{ x: number; y: number; active: boolean }>({ ...reflectionRest, active: false });
  const { width, height } = useWindowDimensions();
  const screen = Dimensions.get('screen');
  // A resized Android window can become wider than tall without rotating.
  const landscape = screen.width > screen.height;
  const receiverWidth = useRef(width); receiverWidth.current = width;
  const receiverOrientation = useRef(landscape ? 'landscape' : 'portrait');
  receiverOrientation.current = landscape ? 'landscape' : 'portrait';
  const keyboardHeight = useKeyboardState(state => state.isVisible ? state.height : 0);
  const keyboardAnimation = useReanimatedKeyboardAnimation();
  const [state, setState] = useState<ConnectionState>('connecting');
  useEffect(() => { if (state !== 'connecting') onStartupComplete?.(); }, [state, onStartupComplete]);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [preview, setPreview] = useState(initialPreview), [keyboard, setKeyboard] = useState(false);
  const [options, setOptions] = useState(false);
  const [controlError, setControlError] = useState('');
  const [dismissedNotice, setDismissedNotice] = useState('');
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
    catch { setDismissedNotice(''); setControlError('No se guardó el ajuste.'); }
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
  const keyboardViewport = useRef(new KeyboardViewport(width, height, screen.height));
  const [pendingText, setPendingText] = useState(false);
  const [, refreshCapabilities] = useState(0);
  const cursorFeed = useMemo(() => new CursorFeed(), [origin]);
  const [videoSize, setVideoSize] = useState({ width: 0, height: 0 });
  const [stream, setStream] = useState<MediaStream | null>(null), [videoError, setVideoError] = useState('');
  const connection = useMemo(() => new Connection(origin, setState, () => refreshCapabilities(n => n + 1)), [origin]);
  const video = useMemo(() => new PreviewLifecycle<MediaStream>(
    (signal, show, failed) => startVideo(origin, signal, show, failed, () => connection.capabilities?.sessionEpoch ?? null, () => receiverWidth.current, cursorFeed.publish, () => receiverOrientation.current), setStream, setVideoError,
  ), [origin, connection, cursorFeed]);
  const pointerGeometry = useMemo(() => selectPointerGeometry(connection.capabilities), [connection, connection.capabilities]);
  const inputReady = state === 'connected' && connection.canInput;
  const directReady = inputReady && preview && !!stream && !!connection.capabilities?.input.actions.includes('p');
  const mode = preferences.mode === 'direct' && directReady ? 'direct' : 'trackpad';
  useEffect(() => {
    if (foreground && state === 'connected') return keepSessionAwake(activateKeepAwakeAsync, deactivateKeepAwake, `phonepad-${Date.now()}-${Math.random()}`);
  }, [foreground, state, connection]);
  const attachments = useAttachmentTransfer(origin, state === 'connected' && connection.canTransfer,
    () => pasteToHost(connection), connection.canClipboard, connection.capabilities?.sessionEpoch, connection.canInput);
  const { isUpdatePending } = Updates.useUpdates();
  const updater = useMemo(() => new UpdateLifecycle({
    enabled: Updates.isEnabled,
    check: Updates.checkForUpdateAsync,
    download: Updates.fetchUpdateAsync,
    reload: () => Updates.reloadAsync(),
  }, active => {
    connection.setForeground(active);
    // A system paste permission dialog makes iOS inactive without leaving the
    // app. Keep the local composer/menu; input still pauses in the connection.
    if (!active && AppState.currentState !== 'inactive') setKeyboard(false);
    setForeground(active);
  }), [connection]);
  const [composerHeight, setComposerHeight] = useState(0);
  const landscapePreview = preview && landscape;
  const windowResize = keyboardViewport.current.resize(width, height, screen.height, keyboard);
  // Android may resize the root window while iOS keeps its full height. Use
  // only the portion not already reflected by the current window dimensions.
  const residualKeyboardOverlap = keyboardOverlap(keyboardHeight, height, windowResize);
  const previewInset = preview ? Math.min(Math.max(0, height - 1), residualKeyboardOverlap + (keyboard && !landscapePreview ? composerHeight : 0)) : 0;
  const horizontalLayout = landscapeLayout(width, height, insets, residualKeyboardOverlap, keyboard);
  const previewTop = preview ? insets.top + (landscapePreview ? 0 : appearance.control.size + appearance.control.margin * 2) : 0;
  const previewLeft = landscapePreview ? horizontalLayout.left : 0;
  const previewRight = landscapePreview ? horizontalLayout.right : 0;
  const previewHeight = topPreviewHeight(width - previewLeft - previewRight, height - previewTop - previewInset, videoSize);
  const topAlignedBottom = landscapePreview ? horizontalLayout.bottom : preview ? Math.max(previewInset, height - previewTop - previewHeight) : 0;
  const previewKeyboardMotion = useMemo(() => landscapePreview ? {
    height: keyboardAnimation.height, windowResize, bottom: insets.bottom, visible: keyboardHeight > 0,
  } : undefined, [landscapePreview, keyboardAnimation.height, windowResize, insets.bottom, keyboardHeight > 0]);
  useEffect(() => { if (!inputReady) setKeyboard(false); }, [inputReady]);
  useEffect(() => {
    updater.start(AppState.currentState);
    const listener = AppState.addEventListener('change', next => updater.setAppState(next));
    return () => { listener.remove(); updater.dispose(); connection.stop(); };
  }, [updater, connection]);
  useEffect(() => { if (isUpdatePending) updater.markReady(); }, [isUpdatePending, updater]);
  useEffect(() => { updater.setPendingContent(pendingText || attachments.busy || attachments.pending); }, [pendingText, attachments.busy, attachments.pending, updater]);
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
    setDismissedNotice(''); setControlError('Terminá el contenido pendiente.');
    return false;
  };
  const capturePreparing = preview && /Preparando|Reconectando|Conectando la pantalla|Reintentando/.test(videoError);
  const globalNotice = controlError || (['unauthorized', 'incompatible'].includes(state) ? messages[state] : '') ||
    (preview && videoError && !capturePreparing ? noticeMessage(videoError, 'No se pudo abrir la pantalla.') : '');
  const status = <View accessibilityLabel={state === 'connected' ? 'Conectado' : messages[state]} style={{ width: appearance.status.size, height: appearance.status.size, borderRadius: appearance.status.radius, backgroundColor: state === 'connected' ? appearance.color.success : appearance.color.secondary }} />;
  // Keep the RTC view mounted while its visible rectangle follows the actual
  // free window area. The stream/decoder never changes when the keyboard opens.
  return <View pointerEvents={foreground ? 'auto' : 'none'} style={{ flex: 1, backgroundColor: appearance.color.background }}>
    <StatusBar style="light" hidden={landscapePreview} />
    <TouchSurface glassPointer={glassPointer} cursorFeed={cursorFeed} cursorScale={preferences.cursorScale} connection={connection} preview={preview} dismissKeyboard={keyboard && !landscapePreview ? closeKeyboard : undefined}
      pointerGeometry={pointerGeometry.geometry} pointerGeometryEpoch={pointerGeometry.geometryEpoch}
      mode={mode} gain={preferences.gain} disabled={!inputReady || options || !foreground}
      videoSize={videoSize} viewportInsetBottom={topAlignedBottom} viewportInsetTop={previewTop} viewportInsetLeft={previewLeft} viewportInsetRight={previewRight}
      keyboardMotion={previewKeyboardMotion}>
      {stream && <RTCView streamURL={stream.toURL()} objectFit="contain" mirror={false} style={StyleSheet.absoluteFill} onDimensionsChange={event => {
        // The native renderer has received a sized frame; an SDP/track alone
        // isn't evidence of a working preview.
        if (event.nativeEvent.width > 0 && event.nativeEvent.height > 0) { setVideoError(''); setVideoSize({ width: event.nativeEvent.width, height: event.nativeEvent.height }); }
      }} />}
    </TouchSurface>
    <SessionControls preview={preview} openKeyboard={() => { if (keyboard) closeKeyboard(); else openKeyboard(); }} keyboardOpen={keyboard}
      reconnect={() => { closeKeyboard(); reconnect(); }} openOptions={openOptions} togglePreview={togglePreview}
      disabled={!inputReady} bottomInset={residualKeyboardOverlap} />
    {!landscapePreview && <View pointerEvents="none" style={{position:'absolute',left:0,right:0,top:insets.top+appearance.control.gap,height:appearance.control.size,alignItems:'center',justifyContent:'center'}}>{status}</View>}
    {!!globalNotice && globalNotice !== dismissedNotice && <View pointerEvents="box-none" style={{ position: 'absolute',
      left: insets.left + appearance.control.margin, top: insets.top + appearance.control.size + appearance.control.gap * 2,
      width: Math.min(appearance.control.menuWidth, width - insets.left - insets.right - appearance.control.margin * 2) }}>
      <DismissibleNotice message={globalNotice} dismiss={() => { setDismissedNotice(globalNotice); setControlError(''); }} />
    </View>}

    {attachments.panel}
    <NativeKeyboard glassPointer={glassPointer} connection={connection} active={keyboard} open={openKeyboard} close={closeKeyboard}
      onPendingChange={setPendingText} onOcclusionChange={setComposerHeight}
      canReview={state === 'connected'} allowAttachments={state === 'connected' && connection.canTransfer}
      column={landscapePreview ? horizontalLayout.column : undefined}
     visible={!landscapePreview || keyboard}
      disabled={!inputReady} choosing={attachments.busy} choose={attachments.choose} />
    <SessionOptions visible={options} close={() => setOptions(false)} preferences={preferences} change={changePreferences} />
    <HostMenu visible={hostsOpen} activeOrigin={origin} connected={state === 'connected'} close={() => setHostsOpen(false)}
      canSwitch={canSwitchHost} select={next => { if (next === origin) setPreview(true); else onSelectHost(next); }} />
  </View>;
}
