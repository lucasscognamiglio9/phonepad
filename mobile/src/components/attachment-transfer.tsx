import { useEffect, useRef, useState } from 'react';
import { Alert, Modal, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { attachmentBatch, chooseAttachments, type AttachmentBatch, type AttachmentSource } from '../lib/attachments';
import { cancelPreparedBatch, copyPreparedBatch, sendPreparedBatch, transferLimits, type PreparedBatch, type TransferLimits } from '../lib/file-transfer';
import { discardPreparedBatch, prepareBatch, readPreparedChunk, restorePreparedBatch } from '../lib/file-transfer-storage';
import { GlassButton } from './glass-button';

export function useAttachmentTransfer(origin: string, connected: boolean, paste: () => boolean) {
  const insets = useSafeAreaInsets();
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
  const select = (value: AttachmentBatch | null) => { selectionRef.current = value; setSelection(value); };
  const remember = (value: PreparedBatch | null) => { preparedRef.current = value; setPrepared(value); };
  useEffect(() => {
    alive.current = true;
    try {
      const restored = restorePreparedBatch(origin);
      if (restored) {
        remember(restored);
        select({ id: restored.manifest.id, items: restored.manifest.files.map(f => ({ uri: '', name: f.name, type: f.type, size: f.bytes })) });
        setProblem('Hay un lote pendiente. Podés consultar y reanudar el mismo envío.');
      }
    } catch { setProblem('No se pudo recuperar la selección anterior.'); }
    return () => { alive.current = false; request.current?.abort(); };
  }, [origin]);

  const run = async (work: (signal: AbortSignal) => Promise<void>) => {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setProblem('');
    try { await work(controller.signal); }
    catch (error) {
      if (alive.current) setProblem(controller.signal.aborted ? 'Envío pausado. Conservamos el lote para reanudarlo.'
        : error instanceof Error ? error.message : 'Se interrumpió el envío. Conservamos la selección.');
    } finally {
      if (request.current === controller) request.current = null;
      if (alive.current) { setBusy(false); setProgress(''); }
    }
  };

  const choose = (source: AttachmentSource) => {
    if (selectionRef.current) { setVisible(true); return; }
    void run(async signal => {
      // Negotiate before opening a provider so limits are known on both sides.
      const limits = await transferLimits(origin, signal);
      if (alive.current) setLimits(limits);
      const items = await chooseAttachments(source);
      if (!items.length || signal.aborted || !alive.current) return;
      if (items.length > limits.maxFiles) throw Error(`Esta computadora admite hasta ${limits.maxFiles} archivos por lote.`);
      select(attachmentBatch(items)); setVisible(true);
    });
  };

  const send = () => void run(async signal => {
    const batch = selectionRef.current;
    if (!batch) return;
    const limits = await transferLimits(origin, signal);
    if (alive.current) setLimits(limits);
    let saved = preparedRef.current;
    if (!saved) {
      saved = await prepareBatch(origin, batch, limits, signal, text => { if (alive.current) setProgress(text); });
      if (!alive.current) return;
      remember(saved);
    }
    setProgress('Consultando el lote…');
    const status = await sendPreparedBatch(saved, limits, readPreparedChunk, signal, percent => {
      if (alive.current) setProgress(percent === 100 ? 'Verificando archivos…' : `Enviando ${percent}%`);
    });
    if (status.state !== 'stored') throw Error('La computadora todavía no confirmó todos los archivos.');
    setProgress('Preparando el portapapeles…');
    const receipt = await copyPreparedBatch(saved, signal);
    if (!alive.current) return;
    // Local cleanup is safe only after the remote receipt. A lost receipt keeps
    // the manifest so the next attempt can query instead of duplicating work.
    discardPreparedBatch(saved.manifest.id);
    remember(null); select(null); setVisible(false);
    if (receipt.clipboard?.state === 'ready' && !receipt.clipboard.replayed) {
      Alert.alert('Listo para pegar', `${receipt.files.length} archivo(s) guardados. Elegí un campo de la computadora que admita adjuntos.`, [
        { text: 'Cerrar', style: 'cancel' },
        { text: 'Pegar ahora', onPress: () => { if (!paste()) Alert.alert('Reconectá la computadora', 'Los archivos ya están guardados. Revisá el portapapeles antes de pegarlos.'); } },
      ]);
    } else {
      Alert.alert('Guardado en la computadora', receipt.clipboard?.replayed
        ? 'El lote ya estaba guardado. No volvimos a reemplazar el portapapeles. Podés adjuntarlo desde Downloads → Phonepad.'
        : 'Los archivos llegaron a Downloads → Phonepad. Podés adjuntarlos desde esa carpeta; no se pudo confirmar el portapapeles.');
    }
  });

  const discard = () => void run(async signal => {
    const saved = preparedRef.current;
    if (saved) {
      setProgress('Cancelando el lote…');
      const result = await cancelPreparedBatch(saved, signal);
      if (result.state === 'stored' && alive.current) Alert.alert('El lote ya estaba guardado', 'Quitamos la selección del teléfono. Los archivos siguen en Downloads → Phonepad.');
      discardPreparedBatch(saved.manifest.id);
    }
    if (!alive.current) return;
    remember(null); select(null); setVisible(false);
  });

  const remove = (index: number) => {
    if (busy || preparedRef.current || !selectionRef.current) return;
    const items = selectionRef.current.items.filter((_, i) => i !== index);
    select(items.length ? attachmentBatch(items) : null);
    if (!items.length) setVisible(false);
  };
  const total = prepared?.manifest.files.reduce((n, f) => n + f.bytes, 0)
    ?? selection?.items.reduce((n, f) => n + (f.size ?? 0), 0) ?? 0;
  const textStyle = { color: '#f4f5f7', fontSize: 15 };
  const panel = <>
    {!visible && !!selection && <View style={{ position: 'absolute', bottom: insets.bottom + 76, alignSelf: 'center' }}>
      <GlassButton label={`${selection.items.length} archivo(s) pendientes`} onPress={() => setVisible(true)} />
    </View>}
    {!selection && !!problem && <View style={{ position: 'absolute', left: 24, right: 24, bottom: insets.bottom + 76 }}>
      <Text accessibilityRole="alert" style={textStyle}>{problem}</Text>
    </View>}
    <Modal visible={visible && !!selection} animationType="slide" presentationStyle="pageSheet" supportedOrientations={['portrait', 'landscape']} onRequestClose={() => setVisible(false)}>
      <View style={{ flex: 1, backgroundColor: '#14171c', paddingTop: insets.top + 16, paddingBottom: insets.bottom + 12, paddingHorizontal: 20, gap: 16 }}>
        <Text accessibilityRole="header" style={{ ...textStyle, fontSize: 22, fontWeight: '600' }}>Revisar envío</Text>
        <Text style={textStyle}>{selection?.items.length} archivo(s) · {(total / 1024 / 1024).toFixed(1)} MB</Text>
        <Text style={{ ...textStyle, color: '#b7bbc4' }}>{limits
          ? `Hasta ${limits.maxFiles} archivos y ${Math.floor(limits.maxBytes / 1024 / 1024)} MB por envío.`
          : 'Al reanudar se comprobarán los límites de la computadora.'}</Text>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 12 }}>
          {selection?.items.map((item, index) => <View key={`${selection.id}-${index}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Text style={{ ...textStyle, flex: 1 }} numberOfLines={3}>{index + 1}. {item.name}</Text>
            {!prepared && <GlassButton label={`Quitar ${item.name}`} symbol="xmark" disabled={busy} onPress={() => remove(index)} />}
          </View>)}
        </ScrollView>
        {!!progress && <Text accessibilityLiveRegion="polite" style={textStyle}>{progress}</Text>}
        {!!problem && <Text accessibilityRole="alert" style={{ ...textStyle, color: '#ffd7a6' }}>{problem}</Text>}
        {busy ? <GlassButton label="Pausar envío" onPress={() => request.current?.abort()} /> : <>
          <GlassButton label={prepared ? 'Reanudar mismo lote' : 'Enviar y preparar para pegar'} disabled={!connected || !selection} onPress={send} />
          <GlassButton label="Descartar selección" onPress={discard} />
        </>}
        <GlassButton label="Volver a la pantalla" onPress={() => setVisible(false)} />
      </View>
    </Modal>
  </>;
  return { choose, busy, pending: !!selection, panel };
}
