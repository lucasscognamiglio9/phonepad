import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Keyboard, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Updates from 'expo-updates';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RTCView, type MediaStream } from '@livekit/react-native-webrtc';
import { GlassButton } from '../components/glass-button';
import { LandscapeControls } from '../components/landscape-controls';
import { TouchSurface } from '../components/touch-surface';
import { chooseAttachments, attachmentBatch, sendAttachmentBatch, type AttachmentBatch, type AttachmentSource } from '../lib/attachments';
import { NativeKeyboard } from '../components/native-keyboard';
import { COMPUTER, Connection, type ConnectionState } from '../lib/connection';
import { startVideo } from '../lib/video';
import { UpdateLifecycle } from '../lib/updates';
import { PreviewLifecycle } from '../lib/preview-lifecycle';

const messages: Record<ConnectionState, string> = {
  connecting: 'Conectando…', connected: '', offline: 'Esperando a tu computadora…',
  unauthorized: 'Este dispositivo todavía no está autorizado en la laptop.', paused: 'Otra sesión tomó el control. Tocá reconectar para recuperarlo.',
};
export function Control() {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [transfer, setTransfer] = useState<string>('');
  const [pendingFiles, setPendingFiles] = useState(0);
  const [choosing, setChoosing] = useState(false);
  const upload = useRef<AbortController | null>(null);
  const pendingBatch = useRef<AttachmentBatch | null>(null);
  useEffect(() => () => upload.current?.abort(), []);
  const [state, setState] = useState<ConnectionState>('connecting');
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [preview, setPreview] = useState(false), [keyboard, setKeyboard] = useState(false);
  const [landscapeControls, setLandscapeControls] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null), [videoError, setVideoError] = useState('');
  const video = useMemo(() => new PreviewLifecycle<MediaStream>(
    (signal, show, failed) => startVideo(COMPUTER, signal, show, failed), setStream, setVideoError,
  ), []);
  const connection = useMemo(() => new Connection(COMPUTER, setState), []);
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
  useEffect(() => { if (state !== 'connected') setKeyboard(false); }, [state]);
  useEffect(() => {
    updater.start(AppState.currentState);
    const listener = AppState.addEventListener('change', next => updater.setAppState(next));
    return () => { listener.remove(); updater.dispose(); connection.stop(); };
  }, [updater, connection]);
  useEffect(() => { if (isUpdatePending) updater.markReady(); }, [isUpdatePending, updater]);
  useEffect(() => { updater.setPreview(preview || choosing); }, [preview, choosing, updater]);
  useEffect(() => { video.update(preview && state !== 'unauthorized' && state !== 'paused', foreground, state === 'connected'); }, [video, preview, foreground, state]);
  useEffect(() => () => video.dispose(), [video]);
  const reconnect = () => { connection.start(); video.restart(); void updater.check(true); };
  const closeKeyboard = useCallback(() => { Keyboard.dismiss(); setKeyboard(false); }, []);
  const openKeyboard = useCallback(() => setKeyboard(true), []);
  const hideLandscapeControls = useCallback(() => { closeKeyboard(); setLandscapeControls(false); }, [closeKeyboard]);
  // Reset on actual orientation changes, including when the preview is off.
  // The RTC view and stream stay mounted throughout the transition.
  useEffect(() => { hideLandscapeControls(); }, [landscape, preview, hideLandscapeControls]);
  const togglePreview = () => { setPreview(p => !p); closeKeyboard(); };
  const choose = async (action: AttachmentSource, retry = false) => {
    if (upload.current) return;
    const request = new AbortController(); upload.current = request; setChoosing(true);
    try {
      if (!retry) {
        const items = await chooseAttachments(action);
        if (!items.length || request.signal.aborted) return;
        pendingBatch.current = attachmentBatch(items);
        setPendingFiles(items.length);
      }
      const batch = pendingBatch.current;
      if (!batch || request.signal.aborted) return;
      setTransfer('Enviando…');
      const receipt = await sendAttachmentBatch(COMPUTER, batch, request.signal, percent => setTransfer(percent === 100 ? 'Preparando para pegar…' : `Enviando ${percent}%`));
      if (request.signal.aborted) return;
      pendingBatch.current = null; setPendingFiles(0);
      if (receipt.clipboard === 'ready' && !receipt.replayed) {
        Alert.alert('Listo para pegar', `${receipt.files.length} archivo(s) listos. Pegalos en un campo de la computadora que admita archivos adjuntos.`, [
          { text: 'Cerrar', style: 'cancel' },
          { text: 'Pegar ahora', onPress: () => {
            // Pasting is an explicit user action; uploading never submits a prompt.
            if (!connection.send({ t: 'k', a: 'combo', mods: ['ctrl'], key: 'v' })) {
              Alert.alert('Reconectá la laptop', 'Los archivos ya están guardados. Revisá el portapapeles antes de pegarlos al reconectar.');
            }
          } },
        ]);
      } else {
        Alert.alert('Guardado en la laptop', receipt.replayed ? 'Este lote ya estaba guardado. No lo duplicamos ni reemplazamos tu portapapeles. Podés adjuntar los archivos desde Downloads → Phonepad.' : 'Los archivos llegaron a Downloads → Phonepad. Podés adjuntarlos desde esa carpeta; no se pudo preparar el portapapeles.');
      }
    } catch (error) {
      if (!request.signal.aborted) Alert.alert('No se pudo confirmar el envío', error instanceof Error ? error.message : 'La selección sigue disponible.', [
        { text: 'Cerrar', style: 'cancel' },
        ...(pendingBatch.current ? [{ text: 'Reintentar mismo lote', onPress: () => { void choose(action, true); } }] : []),
      ]);
    } finally { if (upload.current === request) { upload.current = null; setTransfer(''); setChoosing(false); } }
  };
  const status = <View accessibilityLabel={state === 'connected' ? 'Conectado' : messages[state]} style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: state === 'connected' ? '#70dbab' : '#b7bbc4' }} />;
  // The video owns a stable full-screen layout. Only the floating composer
  // follows the keyboard; cached keyboard frames cannot resize the RTC view.
  return <View pointerEvents={foreground ? 'auto' : 'none'} style={{ flex: 1, backgroundColor: '#090b0e' }}>
    <StatusBar style="light" hidden={landscapePreview} />
    <TouchSurface connection={connection} preview={preview} dismissKeyboard={keyboard ? closeKeyboard : undefined}>
      {stream && <RTCView streamURL={stream.toURL()} objectFit="contain" mirror={false} style={StyleSheet.absoluteFill} onDimensionsChange={event => {
        // The native renderer has received a sized frame; an SDP/track alone
        // isn't evidence of a working preview.
        if (event.nativeEvent.width > 0 && event.nativeEvent.height > 0) setVideoError('');
      }} />}
    </TouchSurface>
    {landscapePreview ? <LandscapeControls visible={landscapeControls && !keyboard}
      show={() => { closeKeyboard(); setLandscapeControls(true); }} hide={hideLandscapeControls}
      openKeyboard={() => { setLandscapeControls(false); openKeyboard(); }}
      reconnect={() => { hideLandscapeControls(); reconnect(); }} exitPreview={togglePreview}
      disabled={state !== 'connected'} insets={insets} /> : <View pointerEvents="box-none" style={{ position: 'absolute', top: insets.top + 8, left: insets.left + 16, right: insets.right + 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <GlassButton label="Reconectar" symbol="arrow.clockwise" onPress={() => { closeKeyboard(); reconnect(); }} />
      {status}
      <GlassButton label={preview ? 'Ocultar pantalla' : 'Ver pantalla'} symbol="desktopcomputer" selected={preview} onPress={togglePreview} />
    </View>}
    {!!(messages[state] || (preview && videoError)) && <View pointerEvents="none" style={{ position: 'absolute', left: 28, right: 28, top: '44%' }}>
      <Text selectable style={{ color: '#b7bbc4', fontSize: 14, textAlign: 'center', lineHeight: 22 }}>{messages[state] || videoError}</Text>
    </View>}
    {!choosing && pendingFiles > 0 && <View style={{ position: 'absolute', bottom: insets.bottom + 72, alignSelf: 'center', alignItems: 'center', gap: 8 }}>
      <Text style={{ color: '#f4f5f7' }}>{pendingFiles} archivo(s) pendientes de confirmar</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <GlassButton label="Reintentar lote" onPress={() => { void choose('files', true); }} />
        <GlassButton label="Descartar selección" onPress={() => { pendingBatch.current = null; setPendingFiles(0); }} />
      </View>
    </View>}
    {!!transfer && <View style={{ position: 'absolute', bottom: insets.bottom + 72, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Text style={{ color: '#f4f5f7' }}>{transfer}</Text><GlassButton label="Cancelar envío" symbol="xmark" onPress={() => upload.current?.abort()} />
    </View>}
    <NativeKeyboard connection={connection} active={keyboard} open={openKeyboard} close={closeKeyboard}
     visible={!landscapePreview || keyboard}
      disabled={state !== 'connected'} choosing={choosing} choose={action => void choose(action)} />
  </View>;
}
