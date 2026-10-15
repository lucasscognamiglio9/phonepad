import type { GlassPointer } from './glass-reflection';
import { appearance } from './appearance';
import { useEffect, useRef, useState } from 'react';
import { Alert, Dimensions, Keyboard, Platform, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { KeyboardStickyView, useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassSurface } from './glass-surface';
import { GlassButton } from './glass-button';
import { ActionMenu } from './action-menu';
import { DismissibleNotice } from './dismissible-notice';
import { ShortcutPanel } from './shortcut-panel';
import { primaryModifier, type ComposerColumn } from '../lib/control-layout';
import { deliverText } from '../lib/text-delivery';
import {
  COMPOSER_CLOSED_MARGIN,
  COMPOSER_OPEN_GAP,
  composerTextHeight,
  keyboardAvailableHeight,
  keyboardOverlap,
  keyboardStickyOpenedOffset,
  KeyboardViewport,
  MIN_TOUCH_TARGET,
} from './keyboard-layout';
import type { Connection } from '../lib/connection';
import { readPhoneClipboardText, transferClipboard, validateClipboardText } from '../lib/clipboard-transfer';
import type { AttachmentSource } from '../lib/attachments';
import type { LateDraft } from '../lib/literal-transfer';
import type { ActionReceipt } from '../lib/protocol';
import { textCommands } from '../lib/protocol';
import { CARET_COLUMNS, CARET_CONTEXT, CARET_ORIGIN, caretInsertion, caretMovement, caretAtBoundary, type CaretSelection } from '../lib/native-caret';
import { noticeMessage } from '../lib/notice-message';

type MenuAnchor = { x: number; y: number; width: number; height: number };
type MenuAction = AttachmentSource;
type ActionDispatch = { accepted: boolean; receiptAware: boolean; operationId: string | null };

// Keep text state here: typing must not rerender the video or restart its stream.
export function NativeKeyboard({ connection, active, open, close, disabled, choosing, choose, visible = true, onPendingChange, onOcclusionChange,
  canReview = !disabled, allowAttachments = !disabled, column, glassPointer }: {
  connection: Connection; active: boolean; open: () => void; close: () => void;
  disabled: boolean; choosing: boolean; choose: (source: AttachmentSource) => void;
  visible?: boolean;
  onPendingChange?: (pending: boolean) => void;
  onOcclusionChange?: (height: number) => void;
  canReview?: boolean;
  allowAttachments?: boolean;
  column?: ComposerColumn;
  glassPointer?: GlassPointer;
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
  const [issueExpanded, setIssueExpanded] = useState(false);
  const [deliveryIssue, setDeliveryIssue] = useState(!!literal?.lateDraft);
  const hasPendingContent = !!value || sending || deliveryIssue || !!lateDraft || !!literal?.pending;
  useEffect(() => { onPendingChange?.(hasPendingContent); }, [hasPendingContent, onPendingChange]);
  const screen = Dimensions.get('screen');
  const landscape = !!column || screen.width > screen.height;
  const [shortcutsPreference, setShortcutsPreference] = useState<{ landscape: boolean; visible: boolean } | null>(null);
  const shortcuts = shortcutsPreference?.landscape === landscape ? shortcutsPreference.visible : (landscape && active && visible && !disabled);
  useEffect(() => { setShortcutsPreference(null); }, [landscape]);
  const [shortcutPage, setShortcutPage] = useState(0);
  const [caretSelection, setCaretSelection] = useState<CaretSelection | undefined>(undefined);
  const caretPosition = useRef(CARET_ORIGIN);
  const draftSelection = useRef<CaretSelection | null>(null);
  const clipboardBusy = useRef(false);
  const caretTyping = useRef(false);
  const caretTouch = useRef(false);
  const caretReset = useRef(false);
  const [menuAnchor, setMenuAnchor] = useState<MenuAnchor | null>(null);
  const [mods, setMods] = useState<string[]>([]);
  const [actionOperationId, setActionOperationId] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState('');
  useEffect(() => {
    if (!textStatus && !actionStatus) return;
    const timer = setTimeout(() => { setTextStatus(''); setActionStatus(''); }, appearance.transfer.toastDuration);
    return () => clearTimeout(timer);
  }, [textStatus, actionStatus]);
  const lastActionReceipt = useRef('');
  const draftSafeOperations = useRef(new Set<string>());
  const [contentHeight, setContentHeight] = useState(24);
  const keyboardViewport = useRef(new KeyboardViewport(width, height, Dimensions.get('screen').height));
  const [stackHeight, setStackHeight] = useState(0);
  const addButton = useRef<View>(null);
  const menuInteraction = useRef(false);
  const menuWasActive = useRef(false);
  const menuRequest = useRef(0);
  const menuAnchorRef = useRef<MenuAnchor | null>(null);
  const measureAnchorRef = useRef<() => void>(() => {});
  const available = column?.width ?? Math.max(0, width - insets.left - insets.right - appearance.control.margin * 2);
  const targetWidth = available;
  const animatedWidth = useSharedValue(targetWidth);
  const closedBottom = insets.bottom + COMPOSER_CLOSED_MARGIN;
  const followsKeyboard = active && visible && !disabled && keyboardHeight > 0;
  const windowResize = keyboardViewport.current.resize(width, height, Dimensions.get('screen').height, active && visible && !disabled);
  const residualKeyboardOverlap = keyboardOverlap(keyboardHeight, height, windowResize);
  const availableHeight = column?.height ?? keyboardAvailableHeight({
    viewportHeight: height,
    safeAreaTop: insets.top,
    keyboardHeight: residualKeyboardOverlap,
    closedBottomInset: closedBottom,
  });
  const caretMode = Platform.OS === 'ios' && active && visible && !disabled
    && connection.canInput !== false && !value && !draft.current && !sending && !literal?.pending && !literal?.busy && !interrupted.current && !lateDraft;
  const inputEpoch = connection.capabilities?.sessionEpoch;
  const latestInputEpoch = useRef(inputEpoch);
  latestInputEpoch.current = inputEpoch;
  const nativeInputEnabled = useRef(active && visible && !disabled);
  nativeInputEnabled.current = active && visible && !disabled && connection.canInput !== false && !sending && !literal?.busy;
  const caretEnabled = useRef(caretMode);
  caretEnabled.current = caretMode;
  const previousCaretMode = useRef(false);
  useEffect(() => {
    if (caretMode && !previousCaretMode.current) {
      caretPosition.current = CARET_ORIGIN; caretTyping.current = false; setContentHeight(24);
      caretReset.current = true; caretTouch.current = false;
      setCaretSelection({ start: CARET_ORIGIN, end: CARET_ORIGIN });
    }
    previousCaretMode.current = caretMode;
  }, [caretMode]);
  const textHeight = composerTextHeight(contentHeight, availableHeight, active, active && !!column, shortcuts);
  const compact = !active && !column && textHeight <= MIN_TOUCH_TARGET;
  const compactLeft = compact ? MIN_TOUCH_TARGET : 0;
  const compactRight = compact ? MIN_TOUCH_TARGET * 2 : 0;
  const style = useAnimatedStyle(() => ({ width: Math.min(available, animatedWidth.value) }));
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
    animatedWidth.value = withTiming(targetWidth, { duration: appearance.motion.composerDuration, reduceMotion: ReduceMotion.System });
  }, [animatedWidth, targetWidth]);
  useEffect(() => {
    if (active && visible && !disabled) {
      setShortcutPage(0); input.current?.focus();
    }
    else {
      input.current?.blur(); setShortcutsPreference(null); setMods([]); menuAnchorRef.current = null; setMenuAnchor(null);
      menuRequest.current += 1;
      menuInteraction.current = false; menuWasActive.current = false;
      // A disconnect can happen after only part of a correction was queued.
      // Keep the draft and require review; reconnect must never replay it.
      if (disabled && draft.current) { interrupted.current = true; setDeliveryIssue(true); }
      if (!interrupted.current && !literalMode) { previous.current = ''; draft.current = ''; setValue(''); setContentHeight(24); }
    }
  }, [active, visible, disabled, literalMode]);
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
    interrupted.current = true; setDeliveryIssue(true); setIssueExpanded(false);
  };
  const canSend = () => !disabled && visible && !interrupted.current && !sending && !literal?.busy;
  const canSendKey = () => !disabled && visible && !sending && !literal?.busy;
  const preserveActionContext = () => {
    // A key receipt can be rejected after a native edit callback has already
    // populated the editor. Preserve that local text, but do not manufacture
    // an interruption banner when there was no draft to protect.
    if (draft.current || value) preserveDraft();
  };
  const keysDisabled = disabled || !visible || sending || !!literal?.busy;
  const reviewAvailable = deliveryIssue || !!textStatus || !!actionStatus;
  const finishReview = () => {
    // This does not assert that the host applied anything and sends no input.
    // The user has reviewed the remote field; only later edits may be sent.
    previous.current = draft.current;
    setTextStatus('');
    interrupted.current = false; setDeliveryIssue(false); setIssueExpanded(false); setMods([]);
  };
  const useLateDraft = () => {
    const selected = literal?.useLateDraft ? literal.useLateDraft() : lateDraft;
    if (!selected) return;
    draft.current = selected.text; literal.draft = selected.text; setValue(selected.text);
    setLateDraft(literal.lateDraft ?? null);
    interrupted.current = false; setDeliveryIssue(false); setIssueExpanded(false); setMods([]);
    setTextStatus('');
  };
  const discardLateDraft = () => {
    literal?.discardLateDraft?.();
    setLateDraft(null);
    interrupted.current = false; setDeliveryIssue(false); setIssueExpanded(false); setMods([]);
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
  const dispatchAction = (key: string, selectedMods = mods): ActionDispatch => {
    if (!canSendKey()) return { accepted: false, receiptAware: false, operationId: null };
    const action = selectedMods.length
      ? { t: 'k' as const, a: 'combo' as const, mods: [...selectedMods], key }
      : { t: 'k' as const, a: 'special' as const, key };
    const operationId = connection.pressAction?.(action) ?? null;
    if (operationId) {
      draftSafeOperations.current.clear();
      if ((literalMode && (draft.current || literal?.pending)) || interrupted.current) draftSafeOperations.current.add(operationId);
      setActionOperationId(operationId);
      setActionStatus('');
      setMods([]);
      return { accepted: true, receiptAware: true, operationId };
    }
    if (!connection.send(action)) return { accepted: false, receiptAware: false, operationId: null };
    setMods([]); if (!interrupted.current && (!literalMode || (!draft.current && !literal?.pending))) resetContext();
    return { accepted: true, receiptAware: false, operationId: null };
  };
  const special = (key: string) => {
    if (!canSendKey()) return;
    const result = dispatchAction(key);
    if (!result.accepted) preserveActionContext();
  };
  const clipboard = (key: string) => {
    if (!canSendKey()) return;
    const result = dispatchAction(key, [primaryModifier(connection.capabilities?.hostPlatform)]);
    if (!result.accepted) preserveActionContext();
  };
  const copyClipboard = async (direction: 'phone' | 'host') => {
    if (!canSendKey() || !connection.canClipboard) return;
    if (clipboardBusy.current) return;
    clipboardBusy.current = true;
    setSending(true); setActionStatus('');
    try {
      await transferClipboard(connection, direction, new AbortController().signal);
      setActionStatus(direction === 'phone' ? 'Copiado al iPhone.' : 'Copiado al equipo.');
    } catch (error) {
      setActionStatus(noticeMessage(error, 'No se pudo copiar.'));
    } finally { clipboardBusy.current = false; setSending(false); }
  };
  const pasteClipboardIntoDraft = async () => {
    if (!canSendKey() || clipboardBusy.current || interrupted.current || literal?.pending) return;
    const generation = editorGeneration.current, original = draft.current;
    const selection = draftSelection.current;
    clipboardBusy.current = true;
    try {
      const copied = await readPhoneClipboardText();
      if (generation !== editorGeneration.current || original !== draft.current) return;
      const start = Math.min(original.length, Math.max(0, selection?.start ?? original.length));
      const end = Math.min(original.length, Math.max(start, selection?.end ?? start));
      const next = original.slice(0, start) + copied + original.slice(end);
      validateClipboardText(next);
      draft.current = next; if (literal) literal.draft = next;
      previous.current = next; setValue(next);
      const caret = {start: start + copied.length, end: start + copied.length};
      draftSelection.current = caret; setCaretSelection(caret);
      open(); input.current?.focus();
      setActionStatus('');
    } catch (error) { setActionStatus(noticeMessage(error, 'No se pudo pegar el texto.')); }
    finally { clipboardBusy.current = false; }
  };
  const submit = () => {
    if (interrupted.current || !canSendKey()) return;
    // Enter is the composer submit action; armed modifiers apply to explicit
    // shortcut keys, never to this dedicated button.
    const result = dispatchAction('Enter', []);
    if (!result.accepted) preserveActionContext();
  };
  const actionReceipt: ActionReceipt | null = actionOperationId
    ? connection.getActionReceipt?.(actionOperationId) ?? null : null;
  const receiptKey = actionReceipt
    ? `${actionReceipt.operationId}:${actionReceipt.phase}:${actionReceipt.state}:${actionReceipt.repeatCount}:${actionReceipt.detail ?? ''}:${actionReceipt.replayed ? 'replayed' : ''}` : '';
  useEffect(() => {
    if (!actionReceipt || !actionOperationId || lastActionReceipt.current === receiptKey) return;
    lastActionReceipt.current = receiptKey;
    const replayed = actionReceipt.replayed === true;
    if (replayed || actionReceipt.state === 'uncertain' || actionReceipt.state === 'rejected' || actionReceipt.state === 'cancelled') {
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
      if (actionReceipt.phase === 'press' && !draftSafeOperations.current.has(actionOperationId) && (!literalMode || !draft.current)) resetContext();
      setActionStatus('');
    }
  }, [actionOperationId, receiptKey]);
  const applyReceipt = (state: string, sentText: string) => {
    if (state === 'dispatched') {
      // Advance the callback generation while preserving the native editor and
      // its first responder. Old delivery callbacks cannot mutate a new draft.
      editorGeneration.current += 1;
      setInputGeneration(editorGeneration.current);
      confirmedText.current = sentText;
      literal.acknowledged?.();
      if (!draft.current || draft.current.startsWith(sentText)) {
        // Typing can append text while the snapshot is being delivered.
        // Keep only the unsent suffix, never resend the delivered block.
        const remaining = draft.current ? draft.current.slice(sentText.length) : '';
        draft.current = remaining; literal.draft = remaining; previous.current = '';
        setValue(remaining); setContentHeight(24);
        interrupted.current = false; setDeliveryIssue(false);
        setTextStatus('');
      } else {
        preserveDraft();
        setTextStatus('Borrador conservado. Revisá el envío.');
      }
    } else if (state === 'rejected' || state === 'cancelled') {
      literal.acknowledged?.();
      interrupted.current = false; setDeliveryIssue(false);
      setTextStatus('No se pudo enviar. El texto sigue acá.');
    } else {
      preserveDraft();
      setTextStatus(state === 'rejected' || state === 'cancelled'
        ? 'No se pudo escribir. Seleccioná un campo en el equipo.'
        : 'Envío sin confirmar.');
    }
  };
  const writeText = async () => {
    if (!canSend() || !literal || !draft.current) return;
    const text = draft.current;
    setSending(true); setTextStatus('');
    try { const receipt = await deliverText(connection, text); applyReceipt(receipt.state, text); }
    catch (error) { preserveDraft(); setTextStatus(noticeMessage(error, 'Envío sin confirmar.')); }
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
  const resetCaret = () => {
    caretPosition.current = CARET_ORIGIN;
    caretReset.current = true;
    const anchor = { start: CARET_ORIGIN, end: CARET_ORIGIN };
    setCaretSelection(anchor);
    // Text and selection are reconciled together by TextInput with its event count.
    // setNativeProps bypasses that ordering and can reset a newer edit.
  };
  return <View pointerEvents={visible ? 'box-none' : 'none'} style={{ position: 'absolute', inset: 0, display: visible ? 'flex' : 'none' }}>
    <ActionMenu anchor={visible ? menuAnchor : null} bounds={column} presentationKey={menuRequest.current} close={dismissMenu} choose={chooseAction} onDismiss={onMenuDismiss}
      attachmentsAllowed={allowAttachments} />
    <KeyboardStickyView pointerEvents="box-none" enabled={followsKeyboard}
      offset={{ closed: 0, opened: keyboardStickyOpenedOffset(windowResize, closedBottom, COMPOSER_OPEN_GAP) }}
      style={{ position: 'absolute', bottom: closedBottom, alignSelf: column ? undefined : 'center', left: column?.left }}>
      <Animated.View pointerEvents="box-none" onLayout={() => { if (menuInteraction.current) measureAnchorRef.current(); }} style={style}>
      <ScrollView testID="phonepad-composer-column" style={{ maxHeight: availableHeight }}
        contentContainerStyle={{ gap: appearance.composer.toolbarGap }} bounces={false} showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="always" keyboardDismissMode="none" scrollEnabled={!!column && stackHeight > availableHeight}
        onScroll={() => { if (menuInteraction.current) measureAnchorRef.current(); }} scrollEventThrottle={16}
        onContentSizeChange={(_width, contentHeight) => {
          setStackHeight(contentHeight);
          onOcclusionChange?.(Math.min(availableHeight, contentHeight) + COMPOSER_OPEN_GAP);
        }}>
      {shortcuts && <ShortcutPanel disabled={keysDisabled} clipboardDisabled={!connection.canClipboard}
        platform={connection.capabilities?.hostPlatform} modifiers={mods} page={shortcutPage} onPageChange={setShortcutPage}
        toggleModifier={mod => { if (canSendKey()) setMods(current => current.includes(mod) ? current.filter(m => m !== mod) : [...current, mod]); }}
        special={special} copy={() => clipboard('c')} paste={() => clipboard('v')}
        pasteDraft={() => { void pasteClipboardIntoDraft(); }}
        toPhone={() => { void copyClipboard('phone'); }} toHost={() => { void copyClipboard('host'); }} />}
      <GlassSurface glassPointer={glassPointer} style={{ borderRadius: compact ? appearance.control.capsuleRadius : appearance.control.menuRadius, padding: appearance.composer.padding }}>
        <View style={{ position: 'relative', marginLeft: compactLeft, marginRight: compactRight }}>
          <TextInput ref={input} value={caretMode ? CARET_CONTEXT : value} selection={caretMode || draft.current ? caretSelection : undefined}
            onChangeText={nativeText => {
              if (nativeText === CARET_CONTEXT) return;
              const text = caretMode ? caretInsertion(nativeText) : nativeText;
              if (inputGeneration !== editorGeneration.current) {
                if (!text || text === confirmedText.current || (text === '\n' && !draft.current)) return;
                // The callback belongs to an earlier draft generation.
                // Keep the complete event and require review
                // because its origin is unknown.
                const late = literal.noteLateDraft?.(text, confirmedText.current)
                  ?? { text, duplicate: text === confirmedText.current };
                setLateDraft(late);
                interrupted.current = true; setDeliveryIssue(true); setIssueExpanded(false);
                setTextStatus('El borrador cambió durante el envío.');
                return;
              }
              if (caretMode) {
                caretTyping.current = true;
                caretPosition.current = CARET_ORIGIN;
                // UIKit preserves selection relative to the old end when replacing text.
                // Removing the virtual suffix without translating the selection puts
                // the next character at zero, reversing "hola" into "aloh".
                setCaretSelection(text ? { start: text.length, end: text.length }
                  : { start: CARET_ORIGIN, end: CARET_ORIGIN });
                if (!text) return;
                draftSelection.current = {start: text.length, end: text.length};
              } else {
                // Once editing real text, UIKit owns selection and IME composition.
                setCaretSelection(undefined);
              }
              // Return on an empty composer belongs to the remote field.
              // With a draft it remains the OS's multiline editor operation.
              if (!draft.current && text === '\n') {
                if (caretMode) resetCaret();
                if (nativeInputEnabled.current && latestInputEpoch.current === inputEpoch
                  && inputGeneration === editorGeneration.current && !literal?.pending && !interrupted.current) special('Enter');
                return;
              }
              if (literalMode) {
                if (mods.length && !draft.current && Array.from(text).length === 1 && !/[\r\n]/.test(text) && canSendKey()) {
                  const result = dispatchAction(text, mods);
                  if (result.accepted) { if (caretMode) resetCaret(); return; }
                  preserveDraft(text);
                }
                if (!sending && ((!literal?.pending && !interrupted.current) || ['rejected', 'cancelled'].includes(literal?.pending?.receipt?.state ?? ''))) {
                  literal.acknowledged?.(); interrupted.current = false; setDeliveryIssue(false); setTextStatus(''); setActionStatus('');
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
            }} editable={!disabled} multiline
            contextMenuHidden={caretMode} caretHidden={false} selectionColor={caretMode ? 'transparent' : undefined} allowFontScaling={!caretMode}
            accessibilityValue={{ text: value }}
            onSelectionChange={event => {
              const next = event.nativeEvent.selection;
              if (!caretMode) { draftSelection.current = next; return; }
              // Ignore callbacks from an obsolete editor, programmatic resets,
              // native text insertion, revoked permissions or uncertain sends.
              if (!caretEnabled.current || latestInputEpoch.current !== inputEpoch || inputGeneration !== editorGeneration.current || !canSendKey() || draft.current || interrupted.current || literal?.pending) return;
              if (caretTouch.current) return;
              if (caretReset.current) {
                if (next.start !== next.end) return;
                if (next.start === CARET_ORIGIN) {
                  caretReset.current = false; setCaretSelection(undefined); return;
                }
                // Fabric sets selection with notifyDelegate:NO: there may be no
                // reset acknowledgement. Release ownership on the first nearby
                // user movement. A delayed focus callback at zero is not a drag.
                if (Math.abs(next.start - CARET_ORIGIN) > CARET_COLUMNS + 1) return;
                caretReset.current = false; setCaretSelection(undefined);
              }
              if (caretTyping.current) { caretTyping.current = false; return; }
              for (const key of caretMovement(caretPosition.current, next)) {
                if (!dispatchAction(key).accepted) { setActionStatus('No se pudo mover el cursor de texto.'); break; }
              }
              if (next.start === next.end && next.start >= 0 && next.start <= CARET_CONTEXT.length) {
                caretPosition.current = next.start;
                if (caretAtBoundary(next.start)) resetCaret();
              }
            }}
            onTouchStart={() => { if (caretMode) caretTouch.current = true; }}
            onTouchEnd={() => { if (caretEnabled.current && !draft.current) { caretTouch.current = false; resetCaret(); } }}
            onTouchCancel={() => { if (caretEnabled.current && !draft.current) { caretTouch.current = false; resetCaret(); } }}
            maxLength={literalMode ? undefined : 2048} autoCorrect={false} autoCapitalize="none" spellCheck={false}
            placeholder={caretMode ? undefined : "Escribir…"} placeholderTextColor={appearance.color.secondary} accessibilityLabel="Escribir en la computadora" accessibilityHint={caretMode ? 'Mantené Espacio y deslizá para mover el cursor de texto del equipo' : undefined}
            onFocus={() => { if (inputGeneration === editorGeneration.current && visible && !menuInteraction.current) { setTextStatus(''); setActionStatus(''); open(); } }}
            onBlur={() => { if (inputGeneration === editorGeneration.current && !menuInteraction.current) close(); }}
            submitBehavior="newline" returnKeyType="default"
            onKeyPress={event => {
              if (!nativeInputEnabled.current || latestInputEpoch.current !== inputEpoch) return;
              if (caretMode) caretTyping.current = true;
              // Native key repeat reaches this callback too. A nonempty local
              // draft is edited by the OS; never also delete the remote field.
              if (inputGeneration === editorGeneration.current && event.nativeEvent.key === 'Backspace'
                && !value && !draft.current && !literal?.pending && !interrupted.current) special('Backspace');
            }}
            onContentSizeChange={event => { if (inputGeneration === editorGeneration.current && !caretMode && !caretEnabled.current) setContentHeight(Math.ceil(event.nativeEvent.contentSize.height)); }}
            scrollEnabled
            style={{ color: caretMode ? 'transparent' : appearance.color.text, fontFamily: caretMode ? 'Courier' : undefined,
              // The invisible context must not acquire soft wraps in a narrow
              // landscape column. Real draft typography remains unchanged.
              fontSize: caretMode ? Math.min(appearance.text.body, Math.max(1,
                (available - compactLeft - compactRight - appearance.composer.padding * 2 - appearance.composer.textPadding * 2) / (CARET_COLUMNS * .6))) : appearance.text.body,
              lineHeight: appearance.text.bodyLineHeight,
              paddingLeft: appearance.composer.textPadding, paddingRight: appearance.composer.textPadding, paddingVertical: appearance.composer.textPadding,
              height: textHeight, textAlignVertical: 'top' }} />
          {caretMode && <Text pointerEvents="none" accessible={false} style={{ position: 'absolute', left: appearance.composer.textPadding,
            top: appearance.composer.textPadding, color: appearance.color.secondary, fontSize: appearance.text.body, lineHeight: appearance.text.bodyLineHeight }}>Escribir…</Text>}
        </View>
        <View pointerEvents="box-none" style={{ position: 'relative', height: MIN_TOUCH_TARGET, marginTop: compact ? -MIN_TOUCH_TARGET : 0 }}>
            <View ref={addButton} collapsable={false}
              onLayout={() => { if (menuInteraction.current) measureAnchorRef.current(); }}
              style={{ position: 'absolute', left: 0, bottom: 0, width: MIN_TOUCH_TARGET, height: MIN_TOUCH_TARGET, justifyContent: 'center' }}>
              <GlassButton compact label="Agregar" action="more"
                disabled={choosing || (disabled && !allowAttachments)} onPress={openMenu} />
            </View>
            <View style={{ position: 'absolute', left: compact ? undefined : MIN_TOUCH_TARGET, right: compact ? MIN_TOUCH_TARGET : undefined, bottom: 0, width: MIN_TOUCH_TARGET, height: MIN_TOUCH_TARGET, justifyContent: 'center' }}><GlassButton compact label="Teclas extra" action="shortcuts" selected={shortcuts || mods.length > 0}
              disabled={keysDisabled} onPress={() => { setShortcutPage(0); setShortcutsPreference({ landscape, visible: !shortcuts }); }} /></View>
            <View style={{ position: 'absolute', right: 0, bottom: 0, width: MIN_TOUCH_TARGET, height: MIN_TOUCH_TARGET, justifyContent: 'center' }}><GlassButton compact
              label={reviewAvailable ? 'Revisar envío' : 'Enviar texto'} action={reviewAvailable ? 'review' : 'send'} selected={deliveryIssue}
              disabled={reviewAvailable ? sending : literalMode ? disabled || !value || sending || !!literal?.pending : keysDisabled}
              onPress={() => { if (reviewAvailable) setIssueExpanded(true); else if (literalMode && draft.current) void writeText(); else if (!literalMode) submit(); }} /></View>
        </View>
      </GlassSurface>
      </ScrollView>
      {issueExpanded && !!(lateDraft || deliveryIssue || textStatus || actionStatus) && <View testID="phonepad-composer-review" style={{ position: 'absolute', left: 0, right: 0,
        bottom: MIN_TOUCH_TARGET + appearance.composer.padding, maxHeight: Math.max(MIN_TOUCH_TARGET, availableHeight - MIN_TOUCH_TARGET - appearance.composer.padding * 2) }}>
        <ScrollView bounces={false} keyboardShouldPersistTaps="always" keyboardDismissMode="none"
          contentContainerStyle={{ gap: appearance.composer.toolbarGap }}>
          {lateDraft && issueExpanded && <DismissibleNotice message={lateDraft.duplicate ? 'Este texto ya se envió.' : 'Otra versión del borrador.'} dismiss={() => { setIssueExpanded(false); }}>
            <ScrollView style={{ maxHeight: 120 }} keyboardShouldPersistTaps="handled">
              <Text selectable style={{ color: appearance.color.text, fontSize: appearance.text.body, marginTop: appearance.spacing.sm }}>{lateDraft.text || '(vacío)'}</Text>
            </ScrollView>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: appearance.control.gap, marginTop: appearance.control.gap }}>
              <GlassButton label="Usar este texto" disabled={sending} onPress={useLateDraft} />
              <GlassButton label="Descartar esta versión" disabled={sending} onPress={discardLateDraft} />
            </View>
          </DismissibleNotice>}
          {deliveryIssue && (!lateDraft || !issueExpanded) && (issueExpanded ? <DismissibleNotice message={textStatus || 'Revisá el envío en el equipo.'} dismiss={() => { setIssueExpanded(false); setTextStatus(''); setActionStatus(''); }}>
            <View style={{flexDirection:'row',flexWrap:'wrap',gap:appearance.control.gap}}>
              <GlassButton label="Ya revisé" disabled={sending || (!!literal?.pending && !canReview)} onPress={reviewed} />
              {!!value && !literal?.pending && <GlassButton label="Descartar borrador" disabled={sending} onPress={discardLocalDraft} />}
              {literal?.pending && <GlassButton label="Consultar envío" disabled={!canReview || sending} onPress={() => { void checkText(); }} />}
            </View>
          </DismissibleNotice> : null)}
          {issueExpanded && literalMode && !!textStatus && !deliveryIssue && <DismissibleNotice message={textStatus} dismiss={() => { setTextStatus(''); setIssueExpanded(false); }} />}
          {issueExpanded && !!actionStatus && !deliveryIssue && (!literalMode || !textStatus) && <DismissibleNotice message={actionStatus} dismiss={() => { setActionStatus(''); setIssueExpanded(false); }} />}
        </ScrollView>
      </View>}
      </Animated.View>
    </KeyboardStickyView>
  </View>;
}
