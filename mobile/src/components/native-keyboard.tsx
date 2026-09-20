import { useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassSurface } from './glass-surface';
import { GlassButton } from './glass-button';
import { ActionMenu } from './action-menu';
import type { Connection } from '../lib/connection';
import type { AttachmentSource } from '../lib/attachments';
import type { LateDraft } from '../lib/literal-transfer';
import { textCommands } from '../lib/protocol';

type MenuAnchor = { x: number; y: number; width: number; height: number };
type MenuAction = AttachmentSource | 'keyboard';

export function composerKeyboardOffset(active: boolean, keyboardHeight: number, viewportHeight: number) {
  'worklet';
  // Always write zero on close. Removing an animated style (or returning {})
  // can leave its previous value applied to the native view after rotation.
  return active && Number.isFinite(keyboardHeight)
    ? -Math.min(Math.max(0, -keyboardHeight), Math.max(0, viewportHeight - 104)) : 0;
}

// Keep text state here: typing must not rerender the video or restart its stream.
export function NativeKeyboard({ connection, active, open, close, disabled, choosing, choose, visible = true, onPendingChange }: {
  connection: Connection; active: boolean; open: () => void; close: () => void;
  disabled: boolean; choosing: boolean; choose: (source: AttachmentSource) => void;
  visible?: boolean;
  onPendingChange?: (pending: boolean) => void;
}) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const { height: keyboardHeight } = useReanimatedKeyboardAnimation();
  const input = useRef<TextInput>(null);
  const literal = connection.literal;
  const literalMode = !!connection.inputCapabilities || !!literal?.pending || !!literal?.draft || !!literal?.lateDraft;
  const [value, setValue] = useState(literal?.draft ?? '');
  const [sending, setSending] = useState(false);
  const [textStatus, setTextStatus] = useState('');
  const previous = useRef('');
  const draft = useRef(literal?.draft ?? '');
  const interrupted = useRef(!!literal?.lateDraft);
  const editorGeneration = useRef(0);
  const confirmedText = useRef('');
  const [inputGeneration, setInputGeneration] = useState(0);
  const [lateDraft, setLateDraft] = useState<LateDraft | null>(literal?.lateDraft ?? null);
  const [deliveryIssue, setDeliveryIssue] = useState(!!literal?.lateDraft);
  const hasPendingContent = !!value || sending || deliveryIssue || !!lateDraft || !!literal?.pending;
  useEffect(() => { onPendingChange?.(hasPendingContent); }, [hasPendingContent, onPendingChange]);
  const [shortcuts, setShortcuts] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<MenuAnchor | null>(null);
  const [mods, setMods] = useState<string[]>([]);
  const [contentHeight, setContentHeight] = useState(24);
  const addButton = useRef<View>(null);
  const menuInteraction = useRef(false);
  const menuWasActive = useRef(false);
  const menuRequest = useRef(0);
  const menuAnchorRef = useRef<MenuAnchor | null>(null);
  const measureAnchorRef = useRef<() => void>(() => {});
  const available = width - insets.left - insets.right - 24;
  const compactWidth = Math.min(available, Math.max(240, available * .72));
  const targetWidth = active ? available : compactWidth;
  const animatedWidth = useSharedValue(targetWidth);
  const bottom = active ? 8 : insets.bottom + 12;
  const maxTextHeight = width > height ? 56 : 116;
  const followsKeyboard = active && visible && !disabled;
  const style = useAnimatedStyle(() => ({
    width: Math.min(available, animatedWidth.value),
    transform: [{ translateY: composerKeyboardOffset(followsKeyboard, keyboardHeight.value, height) }],
  }));
  const extrasStyle = useAnimatedStyle(() => ({ maxHeight: Math.max(0,
    height - insets.top - bottom - maxTextHeight - 68
      + composerKeyboardOffset(followsKeyboard, keyboardHeight.value, height)),
  }));
  const measureMenuAnchor = () => {
    const request = menuRequest.current;
    addButton.current?.measureInWindow((x, y, measuredWidth, measuredHeight) => {
      if (!menuInteraction.current || request !== menuRequest.current) return;
      const next = { x, y, width: measuredWidth, height: measuredHeight };
      const previousAnchor = menuAnchorRef.current;
      if (!previousAnchor || previousAnchor.x !== x || previousAnchor.y !== y
        || previousAnchor.width !== measuredWidth || previousAnchor.height !== measuredHeight) {
        menuAnchorRef.current = next;
        setMenuAnchor(next);
      }
    });
  };
  measureAnchorRef.current = measureMenuAnchor;
  useEffect(() => {
    animatedWidth.value = withTiming(targetWidth, { duration: 220, reduceMotion: ReduceMotion.System });
  }, [animatedWidth, targetWidth]);
  useEffect(() => {
    if (active && visible && !disabled) input.current?.focus();
    else {
      input.current?.blur(); setShortcuts(false); setMods([]); menuAnchorRef.current = null; setMenuAnchor(null);
      menuRequest.current += 1;
      menuInteraction.current = false; menuWasActive.current = false;
      // A disconnect can happen after only part of a correction was queued.
      // Keep the draft and require review; reconnect must never replay it.
      if (disabled && draft.current) { interrupted.current = true; setDeliveryIssue(true); }
      if (!interrupted.current && !literalMode) { previous.current = ''; draft.current = ''; setValue(''); setContentHeight(24); }
    }
  }, [active, visible, disabled, literalMode]);
  useEffect(() => {
    if (inputGeneration > 0 && active && visible && !disabled) input.current?.focus();
  }, [inputGeneration, active, visible, disabled]);
  useEffect(() => {
    // A keyboard frame change can move the composer without changing its
    // React layout. Re-measure while the popup is open so its window anchor
    // follows the button instead of retaining the pre-keyboard coordinates.
    const remeasure = () => {
      if (menuInteraction.current) measureAnchorRef.current();
    };
    const events: Array<'keyboardWillChangeFrame' | 'keyboardDidChangeFrame' | 'keyboardDidShow' | 'keyboardDidHide'> = Platform.OS === 'ios'
      ? ['keyboardWillChangeFrame', 'keyboardDidChangeFrame', 'keyboardDidShow', 'keyboardDidHide']
      : ['keyboardDidShow', 'keyboardDidHide'];
    const subscriptions = events.map(event => Keyboard.addListener(event, remeasure));
    return () => subscriptions.forEach(subscription => subscription.remove());
  }, []);
  useEffect(() => {
    // Width/height changes cover rotation and split-screen resizing. The
    // button's onLayout below covers ordinary composer relayouts.
    if (menuInteraction.current) measureAnchorRef.current();
  }, [width, height, insets.top, insets.right, insets.bottom, insets.left]);
  const resetContext = () => { previous.current = ''; draft.current = ''; setValue(''); setContentHeight(24); };
  const preserveDraft = (text = draft.current) => {
    draft.current = text; setValue(text);
    interrupted.current = true; setDeliveryIssue(true);
  };
  const canSend = () => !disabled && visible && !interrupted.current && !sending && !literal?.busy;
  const canSendKey = () => canSend() && !(literalMode && (draft.current || literal?.pending));
  const finishReview = () => {
    // This does not assert that the host applied anything and sends no input.
    // The user has reviewed the remote field; only later edits may be sent.
    previous.current = draft.current;
    setTextStatus('');
    interrupted.current = false; setDeliveryIssue(false); setMods([]);
  };
  const useLateDraft = () => {
    const selected = literal?.useLateDraft ? literal.useLateDraft() : lateDraft;
    if (!selected) return;
    draft.current = selected.text; literal.draft = selected.text; setValue(selected.text);
    setLateDraft(literal.lateDraft ?? null);
    interrupted.current = false; setDeliveryIssue(false); setMods([]);
    setTextStatus(selected.duplicate
      ? 'La versión tardía coincide con el bloque confirmado. Revisala antes de escribir.'
      : 'Versión tardía seleccionada. Revisala antes de escribir.');
  };
  const discardLateDraft = () => {
    literal?.discardLateDraft?.();
    setLateDraft(null);
    interrupted.current = false; setDeliveryIssue(false); setMods([]);
    setTextStatus('');
  };
  const reviewed = () => {
    if (disabled || !visible) return;
    if (sending) return;
    if (!literal?.pending) {
      finishReview();
      return;
    }
    setSending(true);
    Promise.resolve(literal.reviewed()).then(accepted => {
      setSending(false);
      if (accepted === false) {
        setTextStatus('No se pudo cancelar el envío preparado. Consultá el estado antes de continuar.');
        return;
      }
      finishReview();
    }).catch(() => {
      setSending(false);
      setTextStatus('No se pudo consultar el envío. Revisá la computadora antes de continuar.');
    });
  };
  const special = (key: string) => {
    if (!canSendKey()) return;
    if (!connection.send(mods.length ? { t: 'k', a: 'combo', mods, key } : { t: 'k', a: 'special', key })) { preserveDraft(); return; }
    setMods([]); resetContext();
  };
  const clipboard = (key: string) => {
    if (!canSendKey()) return;
    if (!connection.send({ t: 'k', a: 'combo', mods: ['ctrl'], key })) { preserveDraft(); return; }
    setMods([]); resetContext();
  };
  const submit = () => {
    if (!canSendKey()) return;
    if (!connection.send({ t: 'k', a: 'special', key: 'Enter' })) { preserveDraft(); return; }
    setMods([]); resetContext();
  };
  const applyReceipt = (state: string, sentText: string) => {
    if (state === 'dispatched') {
      // Replacing the native editor makes callbacks from the old editor
      // carry a generation that can never be mistaken for a new edit.
      editorGeneration.current += 1;
      setInputGeneration(editorGeneration.current);
      confirmedText.current = sentText;
      literal.acknowledged?.();
      if (draft.current.startsWith(sentText)) {
        // A late native event may append text while editable=false is taking
        // effect. Keep only the unsent suffix, never resend the delivered block.
        const remaining = draft.current.slice(sentText.length);
        draft.current = remaining; literal.draft = remaining; previous.current = '';
        setValue(remaining); setContentHeight(24);
        interrupted.current = false; setDeliveryIssue(false);
        setTextStatus('Texto enviado. Revisá el resultado en la computadora.');
      } else {
        preserveDraft();
        setTextStatus('Se escribió el bloque enviado, pero el borrador cambió durante el envío. Revisalo y quitá lo ya enviado antes de continuar.');
      }
    } else {
      preserveDraft();
      setTextStatus(state === 'rejected' || state === 'cancelled'
        ? 'No se escribió el texto. Seleccioná un campo editable en la computadora y revisá el envío.'
        : 'No se pudo confirmar el resultado. Revisá la computadora antes de volver a escribir.');
    }
  };
  const writeText = async () => {
    if (!canSend() || !literal || !draft.current) return;
    const text = draft.current;
    setSending(true); setTextStatus('Enviando texto…');
    try { const receipt = await literal.send(text); applyReceipt(receipt.state, text); }
    catch (error) { preserveDraft(); setTextStatus(error instanceof Error ? error.message : 'No se pudo confirmar el envío.'); }
    finally { setSending(false); }
  };
  const checkText = async () => {
    if (!literal?.pending || sending || literal.busy || disabled) return;
    const text = literal.pending.text;
    setSending(true);
    try { const receipt = await literal.status(); applyReceipt(receipt.state, text); }
    catch { setTextStatus('El resultado sigue sin confirmarse. Revisá la computadora; tu borrador sigue acá.'); }
    finally { setSending(false); }
  };
  const finishMenu = (action: MenuAction | null) => {
    const wasActive = menuWasActive.current;
    menuInteraction.current = false;
    menuRequest.current += 1;
    menuWasActive.current = false;
    menuAnchorRef.current = null;
    setMenuAnchor(null);
    // A late modal dismissal after rotation must not reopen the hidden field.
    if (!visible || disabled) return;
    if (action === 'keyboard') {
      open();
      input.current?.focus();
    } else if (action) {
      close();
      choose(action);
    } else if (wasActive && active && !disabled) {
      open();
      input.current?.focus();
    }
  };
  const dismissMenu = () => {
    menuRequest.current += 1;
    menuAnchorRef.current = null;
    setMenuAnchor(null);
  };
  const onMenuDismiss = () => finishMenu(null);
  // ActionMenu invokes choose after its native transparent Modal has
  // dismissed. Attachments therefore close the keyboard only after the
  // dismissal, and keyboard selection can safely restore focus here.
  const chooseAction = (action: MenuAction) => finishMenu(action);
  const openMenu = () => {
    if (menuInteraction.current) {
      dismissMenu();
      return;
    }
    menuInteraction.current = true;
    menuWasActive.current = active && !disabled;
    ++menuRequest.current;
    menuAnchorRef.current = null;
    setMenuAnchor(null);
    // Capture the current frame synchronously so the first render is placed
    // correctly, then keep it current through layout and keyboard callbacks.
    measureAnchorRef.current();
  };
  return <View pointerEvents={visible ? 'box-none' : 'none'} style={{ position: 'absolute', inset: 0, display: visible ? 'flex' : 'none' }}>
    <ActionMenu anchor={visible ? menuAnchor : null} close={dismissMenu} choose={chooseAction} onDismiss={onMenuDismiss} />
    <Animated.View pointerEvents="box-none" style={[{ position: 'absolute', bottom, alignSelf: 'center', gap: 8 }, style]}>
      {lateDraft && <GlassSurface style={{ borderRadius: 18, padding: 12 }}>
        <Text accessibilityLiveRegion="polite" style={{ color: '#f4f5f7', fontSize: 14 }}>
          {lateDraft.duplicate
            ? 'La versión tardía coincide con el bloque confirmado. Revisala antes de decidir qué borrador conservar.'
            : 'Hay otra versión conservada del borrador. Podés elegirla sin perder el texto actual.'}
        </Text>
        <ScrollView style={{ maxHeight: 120 }} keyboardShouldPersistTaps="handled">
          <Text selectable style={{ color: '#f4f5f7', fontSize: 14, marginTop: 6 }}>{lateDraft.text || '(vacío)'}</Text>
        </ScrollView>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
          <GlassButton label="Usar versión tardía" disabled={disabled || sending} onPress={useLateDraft} />
          <GlassButton label="Descartar versión tardía" disabled={disabled || sending} onPress={discardLateDraft} />
        </View>
      </GlassSurface>}
      {deliveryIssue && <GlassSurface style={{ borderRadius: 18, padding: 12 }}>
        <Text accessibilityLiveRegion="polite" style={{ color: '#f4f5f7', fontSize: 14 }}>
          Envío interrumpido. Tu texto sigue acá. Revisá la computadora antes de continuar; podés seleccionar y copiar este borrador.
        </Text>
        <GlassButton label="Continuar sin reenviar" disabled={disabled || sending} onPress={reviewed} />
      </GlassSurface>}
      {literalMode && (textStatus || active) && <GlassSurface style={{ borderRadius: 18, padding: 10 }}>
        <Text accessibilityLiveRegion="polite" style={{ color: '#f4f5f7', fontSize: 14 }}>{textStatus || 'Escribí o dictá acá. Tocá Escribir para pasarlo a la computadora.'}</Text>
        {literal?.pending && <GlassButton label="Consultar envío" disabled={disabled || sending} onPress={() => { void checkText(); }} />}
      </GlassSurface>}
      {active && shortcuts && <Animated.View style={extrasStyle}><ScrollView keyboardShouldPersistTaps="always" bounces={false}>
      <GlassSurface style={{ borderRadius: 26, padding: 6, flexDirection: width > height ? 'row' : 'column', alignItems: width > height ? 'center' : 'stretch' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', flex: width > height ? 1 : undefined, gap: 4 }}>
          {['ctrl', 'alt', 'super', 'shift'].map(mod => <View key={mod} style={{ flex: 1, minWidth: 44, alignItems: 'center' }}>
            <GlassButton compact label={mod === 'super' ? 'Super' : mod[0].toUpperCase() + mod.slice(1)} selected={mods.includes(mod)} disabled={literalMode && (!!value || sending || deliveryIssue)}
              onPress={() => setMods(current => current.includes(mod) ? current.filter(m => m !== mod) : [...current, mod])} />
          </View>)}
          <View style={{ flex: 1, minWidth: 44, alignItems: 'center' }}><GlassButton compact label="Esc" onPress={() => special('Escape')} /></View>
          <View style={{ flex: 1, minWidth: 44, alignItems: 'center' }}><GlassButton compact label="Tab" onPress={() => special('Tab')} /></View>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', flex: width > height ? 1 : undefined, gap: 8 }}>
          <View style={{ width: 64 }}><GlassButton compact label="Copiar"
            onPress={() => clipboard('c')} /></View>
          <View style={{ width: 140 }}>
            <View style={{ width: 44, alignSelf: 'center' }}><GlassButton compact label="Arriba" symbol="arrow.up" onPress={() => special('ArrowUp')} /></View>
            <View style={{ flexDirection: 'row', gap: 4 }}>
              <GlassButton compact label="Izquierda" symbol="arrow.left" onPress={() => special('ArrowLeft')} />
              <GlassButton compact label="Abajo" symbol="arrow.down" onPress={() => special('ArrowDown')} />
              <GlassButton compact label="Derecha" symbol="arrow.right" onPress={() => special('ArrowRight')} />
            </View>
          </View>
          <View style={{ width: 64 }}><GlassButton compact label="Pegar"
            onPress={() => clipboard('v')} /></View>
        </View>
      </GlassSurface></ScrollView></Animated.View>}
      <GlassSurface style={{ borderRadius: 28, padding: 4 }}>
        <View style={{ position: 'relative', minHeight: 44, paddingBottom: active ? 44 : 0 }}>
          <TextInput key={inputGeneration} ref={input} value={value} onChangeText={text => {
              if (literalMode) {
                if (inputGeneration !== editorGeneration.current) {
                  // The callback belongs to the editor that was replaced at
                  // the receipt. Keep the complete event and require review
                  // because its origin is unknown.
                  const late = literal.noteLateDraft?.(text, confirmedText.current)
                    ?? { text, duplicate: text === confirmedText.current };
                  setLateDraft(late);
                  interrupted.current = true; setDeliveryIssue(true);
                  setTextStatus('El borrador cambió al confirmar el envío. Revisalo antes de continuar.');
                  return;
                }
                if (mods.length && !draft.current && Array.from(text).length === 1 && !/[\r\n]/.test(text) && canSendKey()) {
                  if (connection.send({ t: 'k', a: 'combo', mods, key: text })) {
                    setMods([]); resetContext(); return;
                  }
                  preserveDraft(text);
                }
                draft.current = text; literal.draft = text; setValue(text); return;
              }
              if (!canSend()) { preserveDraft(text); return; }
              const extra = text.startsWith(previous.current) ? Array.from(text.slice(previous.current.length)) : [];
              if (mods.length && extra.length === 1 && !/[\r\n]/.test(extra[0])) {
                if (!connection.send({ t: 'k', a: 'combo', mods, key: extra[0] })) { preserveDraft(text); return; }
                setMods([]); resetContext();
              } else {
                for (const command of textCommands(previous.current, text)) {
                  if (!connection.send(command)) { preserveDraft(text); return; }
                }
                if (mods.length) setMods([]);
                previous.current = text; draft.current = text; setValue(text);
              }
            }} editable={!disabled && !sending} multiline
            maxLength={literalMode ? undefined : 2048} autoCorrect={false} autoCapitalize="none" spellCheck={false}
            placeholder="Escribir…" placeholderTextColor="#b7bbc4" accessibilityLabel="Escribir en la computadora"
            onFocus={() => { if (visible && !menuInteraction.current) open(); }}
            onBlur={() => { if (!menuInteraction.current) close(); }}
            submitBehavior="newline" returnKeyType="default"
            onKeyPress={event => { if (!literalMode && event.nativeEvent.key === 'Backspace' && !previous.current) special('Backspace'); }}
            onContentSizeChange={event => setContentHeight(Math.ceil(event.nativeEvent.contentSize.height))}
            scrollEnabled={active && contentHeight > maxTextHeight}
            style={{ color: '#f4f5f7', fontSize: 16, lineHeight: 22, paddingHorizontal: active ? 12 : 44,
              paddingTop: active ? 10 : 11, paddingBottom: active ? 8 : 11,
              height: active ? Math.min(maxTextHeight, Math.max(44, contentHeight)) : 44,
              width: '100%', flexGrow: 0, flexShrink: 0,
              textAlignVertical: active ? 'top' : 'center' }} />
          <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 44,
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View ref={addButton} collapsable={false}
              onLayout={() => { if (menuInteraction.current) measureAnchorRef.current(); }}
              style={{ width: 44, height: 44, justifyContent: 'center' }}>
              <GlassButton compact label="Agregar" symbol="plus"
                disabled={disabled || choosing} onPress={openMenu} />
            </View>
            {active && <>
              <View style={{ width: 44, height: 44, justifyContent: 'center' }}><GlassButton compact label="Teclas extra" symbol="keyboard.badge.ellipsis" selected={shortcuts || mods.length > 0}
                onPress={() => setShortcuts(current => !current)} /></View>
              <View style={{ flex: 1 }} />
              {literalMode && <GlassButton label="Escribir" disabled={disabled || sending || deliveryIssue || !value || !!literal?.pending}
                onPress={() => { void writeText(); }} />}
            </>}
            <View style={{ width: 44, height: 44, justifyContent: 'center' }}><GlassButton compact label="Enter" symbol="return" disabled={disabled || sending || (literalMode && (!!value || !!literal?.pending))} onPress={submit} /></View>
          </View>
        </View>
      </GlassSurface>
    </Animated.View>
  </View>;
}
