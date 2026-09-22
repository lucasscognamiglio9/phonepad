import { appearance } from './appearance';
import { useEffect, useRef, useState } from 'react';
import { Alert, Keyboard, Platform, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { KeyboardStickyView, useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassSurface } from './glass-surface';
import { GlassButton } from './glass-button';
import { ActionMenu } from './action-menu';
import {
  COMPOSER_CLOSED_MARGIN,
  COMPOSER_OPEN_GAP,
  editorMaxHeight,
  extrasMaxHeight,
  keyboardAvailableHeight,
  keyboardOverlap,
  keyboardStickyOpenedOffset,
  keyboardWindowResize,
  MIN_TOUCH_TARGET,
} from './keyboard-layout';
import type { Connection } from '../lib/connection';
import type { AttachmentSource } from '../lib/attachments';
import type { LateDraft } from '../lib/literal-transfer';
import type { ActionReceipt } from '../lib/protocol';
import { textCommands } from '../lib/protocol';

type MenuAnchor = { x: number; y: number; width: number; height: number };
type MenuAction = AttachmentSource;
type ActionDispatch = { accepted: boolean; receiptAware: boolean; operationId: string | null };
type HeldAction = { operationId: string; key: string; initialTimer?: ReturnType<typeof setTimeout>; repeatTimer?: ReturnType<typeof setInterval> };

// Only the visible navigation arrows have a reliable press-in/press-out pair.
// Enter, Escape, Tab, clipboard shortcuts, and modifier combinations stay
// single-shot so an accidental hold cannot repeat a destructive shortcut.
const REPEATABLE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const ACTION_REPEAT_INITIAL_DELAY_MS = 350;
const ACTION_REPEAT_INTERVAL_MS = 70;

// Keep text state here: typing must not rerender the video or restart its stream.
export function NativeKeyboard({ connection, active, open, close, disabled, choosing, choose, visible = true, onPendingChange, onOcclusionChange,
  canReview = !disabled, allowAttachments = !disabled }: {
  connection: Connection; active: boolean; open: () => void; close: () => void;
  disabled: boolean; choosing: boolean; choose: (source: AttachmentSource) => void;
  visible?: boolean;
  onPendingChange?: (pending: boolean) => void;
  onOcclusionChange?: (height: number) => void;
  canReview?: boolean;
  allowAttachments?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const keyboardHeight = useKeyboardState(state => state.isVisible ? state.height : 0);
  const input = useRef<TextInput>(null);
  const literal = connection.literal;
  const literalMode = connection.capabilities?.protocolVersion === 2 || !!connection.inputCapabilities || !!literal?.pending || !!literal?.draft || !!literal?.lateDraft;
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
  const [actionOperationId, setActionOperationId] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState('');
  const heldAction = useRef<HeldAction | null>(null);
  const repeatTouchGesture = useRef(false);
  const suppressRepeatPress = useRef(false);
  const lastActionReceipt = useRef('');
  const cancelledOperations = useRef(new Set<string>());
  const previousViewport = useRef({ width, height });
  const [contentHeight, setContentHeight] = useState(24);
  const [actionBarHeight, setActionBarHeight] = useState(0);
  const preKeyboardHeight = useRef(height);
  const preKeyboardWidth = useRef(width);
  if (preKeyboardWidth.current !== width) { preKeyboardWidth.current = width; preKeyboardHeight.current = height; }
  const previousActive = useRef(active);
  const addButton = useRef<View>(null);
  const menuInteraction = useRef(false);
  const menuWasActive = useRef(false);
  const menuRequest = useRef(0);
  const menuAnchorRef = useRef<MenuAnchor | null>(null);
  const measureAnchorRef = useRef<() => void>(() => {});
  const available = Math.max(0, width - insets.left - insets.right - 24);
  const compactWidth = Math.min(available, Math.max(240, available * .72));
  const targetWidth = active || shortcuts ? available : compactWidth;
  const animatedWidth = useSharedValue(targetWidth);
  const closedBottom = insets.bottom + COMPOSER_CLOSED_MARGIN;
  const followsKeyboard = active && visible && !disabled;
  const keyboardVisible = followsKeyboard && keyboardHeight > 0;
  const windowResize = keyboardWindowResize(preKeyboardHeight.current, height, keyboardVisible);
  const residualKeyboardOverlap = keyboardOverlap(keyboardHeight, height, windowResize);
  const availableHeight = keyboardAvailableHeight({
    viewportHeight: height,
    safeAreaTop: insets.top,
    keyboardHeight: residualKeyboardOverlap,
    closedBottomInset: closedBottom,
  });
  const maxTextHeight = editorMaxHeight(availableHeight, actionBarHeight);
  const extrasHeight = extrasMaxHeight(availableHeight, Math.max(MIN_TOUCH_TARGET, contentHeight), actionBarHeight);
  const style = useAnimatedStyle(() => ({ width: Math.min(available, animatedWidth.value) }));
  const extrasStyle = useAnimatedStyle(() => ({ maxHeight: extrasHeight }));
  useEffect(() => {
    if (!active) preKeyboardHeight.current = height;
    else if (!previousActive.current) preKeyboardHeight.current = height;
    previousActive.current = active;
  }, [active, height]);
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
  const preserveActionContext = () => {
    // A key receipt can be rejected after a native edit callback has already
    // populated the editor. Preserve that local text, but do not manufacture
    // an interruption banner when there was no draft to protect.
    if (draft.current || value) preserveDraft();
  };
  const keysDisabled = disabled || !visible || deliveryIssue || sending || !!literal?.busy
    || (literalMode && (!!value || !!literal?.pending));
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
    setTextStatus('');
  };
  const discardLateDraft = () => {
    literal?.discardLateDraft?.();
    setLateDraft(null);
    interrupted.current = false; setDeliveryIssue(false); setMods([]);
    setTextStatus('');
  };
  const reviewed = () => {
    if (!visible || (!!literal?.pending && !canReview)) return;
    if (sending) return;
    if (!literal?.pending) {
      finishReview();
      return;
    }
    setSending(true);
    Promise.resolve(literal.reviewed()).then(accepted => {
      setSending(false);
      if (accepted === false) {
        setTextStatus('No se pudo cancelar. Consultá el envío.');
        return;
      }
      finishReview();
    }).catch(() => {
      setSending(false);
      setTextStatus('No se pudo consultar el envío.');
    });
  };
  const cancelHeldAction = () => {
    const held = heldAction.current;
    if (!held) return;
    clearTimeout(held.initialTimer);
    clearInterval(held.repeatTimer);
    heldAction.current = null;
    // A cancel can race a provider receipt for the press or a repeat. Keep
    // the identity quarantined so an old executed receipt cannot reset a new
    // local draft/context after the user has released the control.
    cancelledOperations.current.add(held.operationId);
    connection.cancelAction?.(held.operationId);
    setActionStatus('');
  };
  const dispatchAction = (key: string, selectedMods = mods): ActionDispatch => {
    if (!canSendKey()) return { accepted: false, receiptAware: false, operationId: null };
    const action = selectedMods.length
      ? { t: 'k' as const, a: 'combo' as const, mods: [...selectedMods], key }
      : { t: 'k' as const, a: 'special' as const, key };
    const operationId = connection.pressAction?.(action) ?? null;
    if (operationId) {
      setActionOperationId(operationId);
      setActionStatus('');
      setMods([]);
      return { accepted: true, receiptAware: true, operationId };
    }
    if (!connection.send(action)) return { accepted: false, receiptAware: false, operationId: null };
    setMods([]); resetContext();
    return { accepted: true, receiptAware: false, operationId: null };
  };
  const special = (key: string) => {
    if (!canSendKey()) return;
    const result = dispatchAction(key);
    if (!result.accepted) preserveActionContext();
  };
  const clipboard = (key: string) => {
    if (!canSendKey()) return;
    const result = dispatchAction(key, ['ctrl']);
    if (!result.accepted) preserveActionContext();
  };
  const submit = () => {
    if (!canSendKey()) return;
    // Enter is the composer submit action; armed modifiers apply to explicit
    // shortcut keys, never to this dedicated button.
    const result = dispatchAction('Enter', []);
    if (!result.accepted) preserveActionContext();
  };
  const startRepeat = (key: string) => {
    if (!REPEATABLE_KEYS.has(key) || mods.length) return;
    const result = dispatchAction(key, []);
    if (!result.accepted || !result.operationId) return;
    const held: HeldAction = { operationId: result.operationId, key };
    heldAction.current = held;
    held.initialTimer = setTimeout(() => {
      if (heldAction.current !== held) return;
      held.repeatTimer = setInterval(() => {
        if (heldAction.current !== held) return;
        if (!connection.repeatAction?.(held.operationId)) cancelHeldAction();
      }, ACTION_REPEAT_INTERVAL_MS);
    }, ACTION_REPEAT_INITIAL_DELAY_MS);
  };
  const beginRepeatGesture = (key: string) => {
    // With modifiers armed, keep the arrow a one-shot combo. Native
    // accessibility activation calls onPress without this touch pair.
    repeatTouchGesture.current = REPEATABLE_KEYS.has(key) && mods.length === 0;
    if (repeatTouchGesture.current) startRepeat(key);
  };
  const endRepeatGesture = () => {
    if (!repeatTouchGesture.current) return;
    repeatTouchGesture.current = false;
    suppressRepeatPress.current = true;
    cancelHeldAction();
  };
  const pressRepeatable = (key: string) => {
    if (suppressRepeatPress.current) {
      suppressRepeatPress.current = false;
      return;
    }
    if (heldAction.current) return;
    if (!canSendKey()) return;
    const result = dispatchAction(key);
    if (!result.accepted) preserveActionContext();
  };
  const actionReceipt: ActionReceipt | null = actionOperationId
    ? connection.getActionReceipt?.(actionOperationId) ?? null : null;
  const receiptKey = actionReceipt
    ? `${actionReceipt.operationId}:${actionReceipt.phase}:${actionReceipt.state}:${actionReceipt.repeatCount}:${actionReceipt.detail ?? ''}:${actionReceipt.replayed ? 'replayed' : ''}` : '';
  useEffect(() => {
    if (!actionReceipt || !actionOperationId || lastActionReceipt.current === receiptKey) return;
    lastActionReceipt.current = receiptKey;
    if (cancelledOperations.current.has(actionOperationId) && actionReceipt.phase !== 'cancel') {
      // The provider may have crossed the cancel boundary before it emitted
      // the final press/repeat receipt. Keep the new local context intact and
      // surface the possibility instead of presenting a false success or
      // replaying the old action. `*_after_cancel` is the server's explicit
      // boundary marker; an unmarked late receipt remains quarantined.
      if (actionReceipt.detail?.endsWith('_after_cancel')) {
        preserveActionContext();
        setActionStatus(actionReceipt.state === 'uncertain'
          ? 'Resultado sin confirmar. Revisá el texto en el equipo.'
          : actionReceipt.state === 'admitted'
            ? 'Cancelación sin confirmar. Revisá el equipo.'
            : 'La tecla pudo ejecutarse. Revisá el equipo.');
      }
      return;
    }
    const replayed = actionReceipt.replayed === true;
    if (replayed || actionReceipt.state === 'uncertain' || actionReceipt.state === 'rejected' || actionReceipt.state === 'cancelled') {
      cancelHeldAction();
      preserveActionContext();
      setActionStatus(replayed || actionReceipt.state === 'uncertain'
        ? 'Resultado sin confirmar. Revisá el equipo.'
        : actionReceipt.state === 'rejected' ? 'Tecla rechazada.'
          : '');
      return;
    }
    if (actionReceipt.state === 'admitted') {
      setActionStatus('');
      return;
    }
    if (actionReceipt.state === 'executed') {
      if (actionReceipt.phase === 'press') resetContext();
      setActionStatus('');
    }
  }, [actionOperationId, receiptKey]);
  useEffect(() => {
    // Release a held operation when the composer disappears, loses focus,
    // rotates, or loses input permission. After Connection.clearActionState
    // on disconnect there may be no socket left for a cancel frame; stopping
    // locally is still safe because the operation identity is never replayed.
    const rotated = previousViewport.current.width !== width || previousViewport.current.height !== height;
    previousViewport.current = { width, height };
    if (rotated || !active || !visible || disabled || connection.canInput === false) cancelHeldAction();
  }, [active, visible, disabled, width, height, connection.canInput]);
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
        setTextStatus('');
      } else {
        preserveDraft();
        setTextStatus('El borrador cambió durante el envío. Revisalo antes de reenviar.');
      }
    } else {
      preserveDraft();
      setTextStatus(state === 'rejected' || state === 'cancelled'
        ? 'No se pudo escribir. Seleccioná un campo en el equipo.'
        : 'Envío sin confirmar. Revisá el texto en el equipo.');
    }
  };
  const writeText = async () => {
    if (!canSend() || !literal || !draft.current) return;
    const text = draft.current;
    setSending(true); setTextStatus('');
    try { const receipt = await literal.send(text); applyReceipt(receipt.state, text); }
    catch (error) { preserveDraft(); setTextStatus(error instanceof Error ? error.message : 'No se pudo confirmar el envío.'); }
    finally { setSending(false); }
  };
  const checkText = async () => {
    if (!literal?.pending || sending || literal.busy || !canReview) return;
    const text = literal.pending.text;
    setSending(true);
    try { const receipt = await literal.status(); applyReceipt(receipt.state, text); }
    catch { setTextStatus('Envío sin confirmar.'); }
    finally { setSending(false); }
  };
  const discardLocalDraft = () => {
    if (sending || literal?.busy || literal?.pending) return;
    Alert.alert('¿Descartar el borrador?', 'Se borrará el texto del teléfono.', [
      { text: 'Conservar', style: 'cancel' },
      { text: 'Descartar', style: 'destructive', onPress: () => {
        if (literal?.busy || literal?.pending) return;
        editorGeneration.current++; setInputGeneration(editorGeneration.current);
        if (literal) literal.draft = '';
        resetContext(); finishReview();
      } },
    ]);
  };
  const finishMenu = (action: MenuAction | null) => {
    const wasActive = menuWasActive.current;
    menuInteraction.current = false;
    menuRequest.current += 1;
    menuWasActive.current = false;
    menuAnchorRef.current = null;
    setMenuAnchor(null);
    // A late modal dismissal after rotation must not reopen the hidden field.
    if (!visible) return;
    if (action) {
      if (!allowAttachments) return;
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
    if (!visible || choosing || (disabled && !allowAttachments)) return;
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
    <ActionMenu anchor={visible ? menuAnchor : null} close={dismissMenu} choose={chooseAction} onDismiss={onMenuDismiss}
      attachmentsAllowed={allowAttachments} />
    <KeyboardStickyView pointerEvents="box-none" enabled={followsKeyboard}
      offset={{ closed: 0, opened: keyboardStickyOpenedOffset(windowResize, closedBottom, COMPOSER_OPEN_GAP) }}
      style={{ position: 'absolute', bottom: closedBottom, alignSelf: 'center' }}>
      <Animated.View pointerEvents="box-none" onLayout={event => onOcclusionChange?.(event.nativeEvent.layout.height + COMPOSER_OPEN_GAP)} style={[{ gap: 8 }, style]}>
      {lateDraft && <GlassSurface style={{ borderRadius: 18, padding: 12 }}>
        <Text accessibilityLiveRegion="polite" style={{ color: appearance.color.text, fontSize: 14 }}>
          {lateDraft.duplicate
            ? 'Este texto ya se envió.'
            : 'Hay otra versión del borrador.'}
        </Text>
        <ScrollView style={{ maxHeight: 120 }} keyboardShouldPersistTaps="handled">
          <Text selectable style={{ color: appearance.color.text, fontSize: 14, marginTop: 6 }}>{lateDraft.text || '(vacío)'}</Text>
        </ScrollView>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
          <GlassButton label="Usar este texto" disabled={sending} onPress={useLateDraft} />
          <GlassButton label="Descartar esta versión" disabled={sending} onPress={discardLateDraft} />
        </View>
      </GlassSurface>}
      {deliveryIssue && <GlassSurface style={{ borderRadius: 18, padding: 12 }}>
        <Text accessibilityLiveRegion="polite" style={{ color: appearance.color.text, fontSize: 14 }}>
          Envío interrumpido. Borrador guardado.
        </Text>
        <GlassButton label="Continuar sin reenviar" disabled={sending || (!!literal?.pending && !canReview)} onPress={reviewed} />
        {!!value && !literal?.pending && <GlassButton label="Descartar borrador" disabled={sending} onPress={discardLocalDraft} />}
      </GlassSurface>}
      {literalMode && !!textStatus && <GlassSurface style={{ borderRadius: 18, padding: 10 }}>
        <Text accessibilityLiveRegion="polite" style={{ color: appearance.color.text, fontSize: 14 }}>{textStatus}</Text>
        {literal?.pending && <GlassButton label="Consultar envío" disabled={!canReview || sending} onPress={() => { void checkText(); }} />}
      </GlassSurface>}
      {!!actionStatus && <GlassSurface style={{ borderRadius: 18, padding: 10 }}>
        <Text accessibilityLiveRegion="polite" style={{ color: appearance.color.text, fontSize: 14 }}>{actionStatus}</Text>
      </GlassSurface>}
      {shortcuts && <Animated.View style={extrasStyle}><ScrollView keyboardShouldPersistTaps="always" bounces={false}>
      <GlassSurface style={{ borderRadius: 26, padding: 6 }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" bounces={false}
          contentContainerStyle={{ flexGrow: 1, alignItems: 'center', gap: 4 }}>
          {['ctrl', 'alt', 'super', 'shift'].map(mod => <View key={mod} style={{ flex: 1, minWidth: MIN_TOUCH_TARGET, alignItems: 'center' }}>
            <GlassButton compact label={mod === 'super' ? 'Super' : mod[0].toUpperCase() + mod.slice(1)} selected={mods.includes(mod)} disabled={keysDisabled}
              onPress={() => { if (canSendKey()) setMods(current => current.includes(mod) ? current.filter(m => m !== mod) : [...current, mod]); }} />
          </View>)}
          <View style={{ flex: 1, minWidth: MIN_TOUCH_TARGET, alignItems: 'center' }}><GlassButton compact label="Esc" disabled={keysDisabled} onPress={() => special('Escape')} /></View>
          <View style={{ flex: 1, minWidth: MIN_TOUCH_TARGET, alignItems: 'center' }}><GlassButton compact label="Tab" disabled={keysDisabled} onPress={() => special('Tab')} /></View>
        </ScrollView>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" bounces={false}
          contentContainerStyle={{ flexGrow: 1, alignItems: 'center', gap: 4 }}>
          <View style={{ flex: 1, minWidth: MIN_TOUCH_TARGET, alignItems: 'center' }}><GlassButton compact label="Copiar" disabled={keysDisabled} onPress={() => clipboard('c')} /></View>
          {([
            ['Izquierda', 'left', 'ArrowLeft'], ['Derecha', 'right', 'ArrowRight'],
            ['Arriba', 'up', 'ArrowUp'], ['Abajo', 'down', 'ArrowDown'],
          ] as const).map(([label, action, key]) => <View key={key} style={{ flex: 1, minWidth: MIN_TOUCH_TARGET, alignItems: 'center' }}>
            <GlassButton compact label={label} action={action} disabled={keysDisabled}
              onPressIn={() => beginRepeatGesture(key)} onPressOut={endRepeatGesture} onPress={() => pressRepeatable(key)} />
          </View>)}
          <View style={{ flex: 1, minWidth: MIN_TOUCH_TARGET, alignItems: 'center' }}><GlassButton compact label="Pegar" disabled={keysDisabled} onPress={() => clipboard('v')} /></View>
        </ScrollView>
      </GlassSurface></ScrollView></Animated.View>}
      <GlassSurface style={{ borderRadius: 28, padding: 4 }}>
        <View style={{ position: 'relative', height: MIN_TOUCH_TARGET }}>
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
                  setTextStatus('El borrador cambió durante el envío.');
                  return;
                }
                if (mods.length && !draft.current && Array.from(text).length === 1 && !/[\r\n]/.test(text) && canSendKey()) {
                  const result = dispatchAction(text, mods);
                  if (result.accepted) return;
                  preserveDraft(text);
                }
                draft.current = text; literal.draft = text; setValue(text); return;
              }
              if (!canSend()) { preserveDraft(text); return; }
              const extra = text.startsWith(previous.current) ? Array.from(text.slice(previous.current.length)) : [];
              if (mods.length && extra.length === 1 && !/[\r\n]/.test(extra[0])) {
                const result = dispatchAction(extra[0], mods);
                if (!result.accepted) { preserveDraft(text); return; }
              } else {
                for (const command of textCommands(previous.current, text)) {
                  if (!connection.send(command)) { preserveDraft(text); return; }
                }
                if (mods.length) setMods([]);
                previous.current = text; draft.current = text; setValue(text);
              }
            }} editable={!disabled && !sending} multiline
            maxLength={literalMode ? undefined : 2048} autoCorrect={false} autoCapitalize="none" spellCheck={false}
            placeholder="Escribir…" placeholderTextColor={appearance.color.secondary} accessibilityLabel="Escribir en la computadora"
            onFocus={() => { if (visible && !menuInteraction.current) open(); }}
            onBlur={() => { cancelHeldAction(); if (!menuInteraction.current) close(); }}
            submitBehavior="newline" returnKeyType="default"
            onKeyPress={event => { if (!literalMode && event.nativeEvent.key === 'Backspace' && !previous.current) special('Backspace'); }}
            onContentSizeChange={event => setContentHeight(Math.ceil(event.nativeEvent.contentSize.height))}
            scrollEnabled={active}
            style={{ color: appearance.color.text, fontSize: 16, lineHeight: 22, marginLeft: 44, marginRight: 88, paddingHorizontal: 4, paddingVertical: 11, height: MIN_TOUCH_TARGET, textAlignVertical: 'center' }} />
        <View pointerEvents="box-none" onLayout={event => {
          const next = event.nativeEvent.layout.height;
          if (next > 0 && next !== actionBarHeight) setActionBarHeight(next);
        }} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 44,
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View ref={addButton} collapsable={false}
              onLayout={() => { if (menuInteraction.current) measureAnchorRef.current(); }}
              style={{ width: 44, height: 44, justifyContent: 'center' }}>
              <GlassButton compact label="Agregar" action="more"
                disabled={choosing || (disabled && !allowAttachments)} onPress={openMenu} />
            </View>
            <View pointerEvents="none" style={{ flex: 1 }} />
            {<>
              <View style={{ width: 44, height: 44, justifyContent: 'center' }}><GlassButton compact label="Teclas extra" action="shortcuts" selected={shortcuts || mods.length > 0}
                onPress={() => setShortcuts(current => !current)} /></View>
            </>}
            <View style={{ width: 44, height: 44, justifyContent: 'center' }}><GlassButton compact label={literalMode && value ? "Enviar texto" : "Enter"} action="send" disabled={literalMode && value ? disabled || sending || deliveryIssue || !!literal?.pending : keysDisabled} onPress={() => { if (literalMode && draft.current) void writeText(); else submit(); }} /></View>
          </View>
        </View>
      </GlassSurface>
      </Animated.View>
    </KeyboardStickyView>
  </View>;
}
