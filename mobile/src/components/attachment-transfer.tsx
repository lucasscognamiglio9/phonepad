import { appearance } from './appearance';
import { useEffect, useRef, useState } from 'react';
import { Image, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { attachmentBatch, chooseAttachments, type AttachmentBatch, type AttachmentSource } from '../lib/attachments';
import { cancelPreparedBatch, copyPreparedBatch, sendPreparedBatch, transferLimits, type PreparedBatch, type TransferLimits } from '../lib/file-transfer';
import { discardPreparedBatch, prepareBatch, readPreparedChunk, restorePreparedBatch } from '../lib/file-transfer-storage';
import { GlassSurface } from './glass-surface';
import { ActionIcon } from './action-icon';
import { GlassButton } from './glass-button';
import { DismissibleNotice } from './dismissible-notice';
import { noticeMessage } from '../lib/notice-message';
import { Buffer } from 'buffer';
import { File, Paths } from 'expo-file-system';
import type { ClipboardImage } from 'expo-clipboard';

export function useAttachmentTransfer(origin: string, connected: boolean, paste: () => Promise<'executed' | 'rejected' | 'uncertain'>, canClipboard = true, sessionEpoch?: string | null, canInput = true) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [notice, setNotice] = useState('');
  const [selection, setSelection] = useState<AttachmentBatch | null>(null);
  const [prepared, setPrepared] = useState<PreparedBatch | null>(null);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [limits, setLimits] = useState<TransferLimits | null>(null);
  const [problem, setProblem] = useState('');
  const request = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const preparedRef = useRef<PreparedBatch | null>(null);
  const selectionRef = useRef<AttachmentBatch | null>(null);
  const uploading = useRef(false);
  const clipboardImageFile = useRef<File | null>(null);
  const clearClipboardImage = () => { try { clipboardImageFile.current?.delete(); } catch {} clipboardImageFile.current = null; };
  const permissions = useRef({ connected, canClipboard });
  const epoch = useRef(sessionEpoch);
  useEffect(() => { if (epoch.current !== sessionEpoch && uploading.current) request.current?.abort(); epoch.current = sessionEpoch; }, [sessionEpoch]);
  permissions.current = { connected, canClipboard };
  // A native photo picker can temporarily suspend the control connection.
  // Keep its selection; only an upload depends on the current write permission.
  useEffect(() => { if (!connected && uploading.current) request.current?.abort(); }, [connected]);
  const select = (value: AttachmentBatch | null) => { selectionRef.current = value; setSelection(value); };
  const remember = (value: PreparedBatch | null) => { preparedRef.current = value; setPrepared(value); };
  useEffect(() => {
    alive.current = true;
    try {
      const restored = restorePreparedBatch(origin);
      if (restored) {
        remember(restored);
        select({ id: restored.manifest.id, items: restored.manifest.files.map(f => ({ uri: '', name: f.name, type: f.type, size: f.bytes })) });
        setProblem('Envío pendiente. Podés reanudarlo.');
      }
    } catch { setProblem('No se pudo recuperar la selección anterior.'); }
    return () => { alive.current = false; request.current?.abort(); clearClipboardImage(); };
  }, [origin]);

  useEffect(() => {
    if (!problem && !notice) return;
    const timer = setTimeout(() => { setProblem(''); setNotice(''); }, appearance.transfer.toastDuration);
    return () => clearTimeout(timer);
  }, [problem, notice]);

  const run = async (work: (signal: AbortSignal) => Promise<void>, upload = false) => {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller;
    uploading.current = upload;
    setBusy(true); setProblem(''); setNotice('');
    try { await work(controller.signal); }
    catch (error) {
      if (alive.current) setProblem(controller.signal.aborted ? 'Envío pausado.'
        : noticeMessage(error, upload ? 'Envío interrumpido. Podés reanudarlo.' : 'No se pudo preparar la selección.'));
    } finally {
      if (request.current === controller) { request.current = null; uploading.current = false; }
      if (alive.current) { setBusy(false); setProgress(''); }
    }
  };

  const choose = (source: AttachmentSource) => {
    if (selectionRef.current) { setVisible(true); return; }
    if (!permissions.current.connected) { setProblem('El equipo no permite recibir archivos en esta sesión.'); return; }
    void run(async signal => {
      // Negotiate before opening a provider so limits are known on both sides.
      const limits = await transferLimits(origin, signal, epoch.current ?? undefined);
      if (alive.current) setLimits(limits);
      const items = await chooseAttachments(source);
      if (!items.length || signal.aborted || !alive.current) return;
      if (items.length > limits.maxFiles) throw Error(`Esta computadora admite hasta ${limits.maxFiles} archivos por lote.`);
      select(attachmentBatch(items)); setVisible(true);
    });
  };

  const offerClipboardImage = (image: ClipboardImage) => {
    if (selectionRef.current) { setVisible(true); return; }
    if (!permissions.current.connected) { setProblem('El equipo no permite recibir imágenes en esta sesión.'); return; }
    void run(async signal => {
      const limits = await transferLimits(origin, signal, epoch.current ?? undefined);
      const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(image.data);
      if (!match) throw Error('No se pudo leer la imagen copiada.');
      const estimatedBytes = Math.floor(match[2].length * 3 / 4);
      if (estimatedBytes > limits.maxBytes) throw Error('La imagen supera el tamaño permitido por la computadora.');
      const bytes = Buffer.from(match[2], 'base64');
      if (signal.aborted || !alive.current) return;
      const file = new File(Paths.cache, `phonepad-clipboard-${Date.now()}.${match[1] === 'jpeg' ? 'jpg' : 'png'}`);
      file.create(); file.write(new Uint8Array(bytes));
      clearClipboardImage(); clipboardImageFile.current = file;
      select(attachmentBatch([{ uri: file.uri, name: `Imagen copiada.${match[1] === 'jpeg' ? 'jpg' : 'png'}`, type: `image/${match[1]}`, size: bytes.length }]));
      setLimits(limits); setVisible(true);
    });
  };

  const send = (pasteAfter = true) => void run(async signal => {
    const sendingEpoch = epoch.current;
    if (!permissions.current.connected) throw Error('El equipo no permite recibir archivos en esta sesión.');
    const batch = selectionRef.current;
    if (!batch) return;
    const limits = await transferLimits(origin, signal, epoch.current ?? undefined);
    if (alive.current) setLimits(limits);
    let saved = preparedRef.current;
    if (!saved) {
      saved = await prepareBatch(origin, batch, limits, signal, text => { if (alive.current) setProgress(text); });
      if (!alive.current) return;
      remember(saved);
    }
    saved = { ...saved, sessionEpoch: epoch.current ?? undefined };
    setProgress('Consultando el lote…');
    const status = await sendPreparedBatch(saved, limits, readPreparedChunk, signal, percent => {
      if (alive.current) setProgress(percent === 100 ? 'Verificando archivos…' : `Enviando ${percent}%`);
    });
    if (status.state !== 'stored') throw Error('La computadora todavía no confirmó todos los archivos.');
    if (pasteAfter && permissions.current.canClipboard) setProgress('Preparando el portapapeles…');
    const receipt = pasteAfter && permissions.current.canClipboard ? await copyPreparedBatch(saved, signal) : status;
    if (!alive.current || signal.aborted || sendingEpoch !== epoch.current) throw Error('Cambió la conexión. Conservamos el lote para revisar el envío.');
    // Local cleanup is safe only after the remote receipt. A lost receipt keeps
    // the manifest so the next attempt can query instead of duplicating work.
    discardPreparedBatch(saved.manifest.id);
    clearClipboardImage();
    remember(null); select(null); setVisible(false);
    if (pasteAfter && receipt.clipboard?.state === 'ready' && !receipt.clipboard.replayed) {
      const result = await paste();
      if (alive.current) setNotice(result === 'executed' ? 'Enviado' : result === 'rejected'
        ? 'Guardado en el equipo. Reconectá para pegar.' : 'Guardado. Revisá el pegado en el equipo.');
    } else {
      setNotice(pasteAfter && receipt.clipboard?.replayed ? 'Guardado. El pegado anterior requiere revisión.' : 'Guardado en Downloads/Phonepad');
    }
  }, true);

  const discard = () => void run(async signal => {
    const saved = preparedRef.current;
    if (saved) {
      setProgress('Cancelando el lote…');
      const result = await cancelPreparedBatch({ ...saved, sessionEpoch: epoch.current ?? undefined }, signal);
      if (result.state === 'stored' && alive.current) setNotice('El lote ya estaba guardado en el equipo.');
      discardPreparedBatch(saved.manifest.id);
    }
    if (!alive.current) return;
    clearClipboardImage();
    remember(null); select(null); setVisible(false);
  });

  const remove = (index: number) => {
    if (busy || preparedRef.current || !selectionRef.current) return;
    const items = selectionRef.current.items.filter((_, i) => i !== index);
    select(items.length ? attachmentBatch(items) : null);
    if (!items.length) clearClipboardImage();
    if (!items.length) setVisible(false);
  };
  const total = prepared?.manifest.files.reduce((n, f) => n + f.bytes, 0)
    ?? selection?.items.reduce((n, f) => n + (f.size ?? 0), 0) ?? 0;
  const textStyle = { color: appearance.color.text, fontSize: appearance.text.body };
  const panel = <View pointerEvents="box-none" style={{ position: 'absolute', left: insets.left + appearance.control.margin,
    right: insets.right + appearance.control.margin, bottom: insets.bottom + appearance.control.size + appearance.control.margin * 3 }}>
    {!visible && !!selection && <GlassButton label={`${selection.items.length} adjuntos`} onPress={() => setVisible(true)} />}
    {(!!notice || (!selection && !!problem)) && <DismissibleNotice message={notice || problem}
      dismiss={() => { setNotice(''); setProblem(''); }} />}
    {visible && !!selection && <GlassSurface style={{ borderRadius: appearance.control.menuRadius,
      padding: appearance.control.margin, gap: appearance.control.gap, maxHeight: height * appearance.transfer.viewportFraction }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: appearance.control.gap }}>
        <Text accessibilityRole="header" style={{ ...textStyle, flex: 1, fontWeight: appearance.weight.strong }}>
          {selection.items.length === 1 ? '1 adjunto' : `${selection.items.length} adjuntos`} · {(total / 1024 / 1024).toFixed(1)} MB
        </Text>
        <GlassButton compact action="remove" label={busy ? 'Pausar envío' : 'Cancelar adjuntos'} onPress={() => {
          if (busy) { request.current?.abort(); setVisible(false); }
          else discard();
        }} />
      </View>
      <ScrollView style={{ maxHeight: appearance.transfer.thumbnailSize * appearance.transfer.maxVisibleFiles }}
        contentContainerStyle={{ gap: appearance.control.gap }} keyboardShouldPersistTaps="handled">
        {selection.items.map((item, index) => <View key={`${selection.id}-${index}`} style={{ flexDirection: 'row', alignItems: 'center', gap: appearance.control.gap }}>
          {item.type.startsWith('image/') && item.uri ? <Image source={{uri:item.uri}} resizeMode="cover"
            style={{ width: appearance.transfer.thumbnailSize, height: appearance.transfer.thumbnailSize, borderRadius: appearance.control.gap }} />
            : <View style={{width:appearance.transfer.thumbnailSize,alignItems:'center'}}><ActionIcon action="files" size={appearance.control.iconSize} color={appearance.color.text} /></View>}
          <Text style={{ ...textStyle, flex: 1 }} numberOfLines={1}>{item.type.startsWith('image/') ? `Imagen ${index + 1}` : item.name}</Text>
          {!prepared && selection.items.length > 1 && <GlassButton compact action="remove" label={`Quitar ${item.name}`} disabled={busy} onPress={() => remove(index)} />}
        </View>)}
      </ScrollView>
      {!!progress && <Text accessibilityLiveRegion="polite" style={{ ...textStyle, color: appearance.color.secondary }}>{progress}</Text>}
      {!!problem && <Text accessibilityRole="alert" numberOfLines={appearance.notice.maxLines}
        style={{ color: appearance.color.warning, fontSize: appearance.notice.fontSize, lineHeight: appearance.notice.lineHeight }}>{problem}</Text>}
      {busy ? <GlassButton label="Pausar" onPress={() => request.current?.abort()} /> : <View style={{ flexDirection: 'row', gap: appearance.control.gap }}>
        <View style={{flex:1}}><GlassButton label={prepared ? 'Reanudar' : canClipboard && canInput ? 'Enviar y pegar' : 'Enviar'} disabled={!connected} onPress={() => send(canClipboard && canInput)} /></View>
      </View>}
    </GlassSurface>}
  </View>;
  return { choose, offerClipboardImage, busy, pending: !!selection, panel };
}
