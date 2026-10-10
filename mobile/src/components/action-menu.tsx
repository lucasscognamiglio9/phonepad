import * as Clipboard from 'expo-clipboard';
import type { PasteEventPayload } from 'expo-clipboard';
import { readClipboardPaste } from '../lib/clipboard-paste';
import { appearance } from './appearance';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  InteractionManager,
  ActivityIndicator,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ActionIcon } from './action-icon';
import { ACTIONS, ATTACHMENT_MENU_ACTIONS } from '../lib/actions';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { FullWindowOverlay } from 'react-native-screens';
import { GlassSurface } from './glass-surface';
import type { AttachmentSource } from '../lib/attachments';
import type { ComposerColumn } from '../lib/control-layout';

export type ActionMenuAnchor = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type EdgeInsets = Pick<ReturnType<typeof useSafeAreaInsets>, 'top' | 'right' | 'bottom' | 'left'>;

export type ActionMenuLayout = {
  left: number;
  top: number;
  width: number;
  height: number;
  originX: number;
  originY: number;
};

export const ACTION_MENU_WIDTH = 248;
export const ACTION_MENU_ROW_HEIGHT = appearance.control.menuRowHeight;
export const ACTION_MENU_HEIGHT = ACTION_MENU_ROW_HEIGHT * ATTACHMENT_MENU_ACTIONS.length + appearance.shortcuts.padding * 2;
const ACTION_MENU_GAP = 10;
const ACTION_MENU_MARGIN = 12;

function finite(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Keep the popup in the usable part of the modal window. `anchor` is expected
 * to be in window coordinates (for example, from measureInWindow()).
 */
export function getActionMenuLayout(
  anchor: ActionMenuAnchor | null,
  viewport: { width: number; height: number },
  insets: EdgeInsets,
  keyboardBottom = 0,
  rowCount: number = ATTACHMENT_MENU_ACTIONS.length,
  preferredWidth: number = ACTION_MENU_WIDTH,
  metrics?: { rowHeight: number; padding: number; attachToAnchor: boolean },
): ActionMenuLayout | null {
  if (!anchor) return null;

  const width = Math.max(0, finite(viewport.width, 0));
  const height = Math.max(0, finite(viewport.height, 0));
  const x = finite(anchor.x, 0);
  const y = finite(anchor.y, 0);
  const anchorWidth = Math.max(0, finite(anchor.width, 0));
  const anchorHeight = Math.max(0, finite(anchor.height, 0));
  const leftInset = Math.max(0, finite(insets.left, 0));
  const rightInset = Math.max(0, finite(insets.right, 0));
  const topInset = Math.max(0, finite(insets.top, 0));
  const bottomInset = Math.max(0, finite(insets.bottom, 0));

  const margin = metrics?.attachToAnchor ? appearance.control.gap : ACTION_MENU_MARGIN;
  const availableWidth = Math.max(1, width - leftInset - rightInset - margin * 2);
  const menuWidth = Math.min(Math.max(1, finite(preferredWidth, ACTION_MENU_WIDTH)), availableWidth);
  const minimumLeft = margin + leftInset;
  const maximumLeft = Math.max(
    minimumLeft,
    width - menuWidth - margin - rightInset,
  );
  const left = clamp(x + anchorWidth / 2 - menuWidth / 2, minimumLeft, maximumLeft);

  // The keyboard reports its screen Y coordinate. Converting it to a bottom
  // inset keeps the menu above an open keyboard when there is room to do so.
  const keyboardInset = Math.max(0, finite(keyboardBottom, 0));
  const minimumTop = margin + topInset;
  const minimumBottom = Math.max(margin + bottomInset, margin + keyboardInset);
  // In a short landscape window, keep the glass frame on-screen and make its
  // rows scrollable. The rows retain their 52pt touch targets, so every action
  // remains reachable without allowing the frame itself under the keyboard.
  const availableHeight = Math.max(1, height - minimumTop - minimumBottom);
  const menuHeight = Math.min((metrics?.rowHeight ?? ACTION_MENU_ROW_HEIGHT) * rowCount + (metrics?.padding ?? appearance.shortcuts.padding) * 2, availableHeight);
  const maximumTop = Math.max(minimumTop, height - menuHeight - minimumBottom);
  const above = y - menuHeight - ACTION_MENU_GAP;
  const below = y + anchorHeight + ACTION_MENU_GAP;
  const preferredTop = metrics?.attachToAnchor ? y : above >= minimumTop ? above : below;
  const top = clamp(preferredTop, minimumTop, maximumTop);

  // React Native's transformOrigin is a layout property in the 0.86 runtime
  // used by Expo SDK 57. It lets the scale animation start at the anchor edge
  // without animating opacity on a GlassView ancestor.
  const originInset = Math.min(16, menuWidth / 2);
  const originX = clamp(x + anchorWidth / 2 - left, originInset, menuWidth - originInset);
  const originY = clamp(y + anchorHeight / 2 - top, 8, Math.max(8, menuHeight - 8));
  return { left, top, width: menuWidth, height: menuHeight, originX, originY };
}

type Action = AttachmentSource;

const items = ATTACHMENT_MENU_ACTIONS.map(key => ({ key, ...ACTIONS[key] }));

export function ActionMenu({ anchor, presentationKey = 0, close, choose, onDismiss, attachmentsAllowed = true, textPasteAllowed = true, onPaste, bounds }: {
  anchor: ActionMenuAnchor | null;
  presentationKey?: number;
  close: () => void;
  choose: (action: Action) => void;
  onDismiss?: () => void;
  attachmentsAllowed?: boolean;
  textPasteAllowed?: boolean;
  onPaste?: (item: PasteEventPayload) => void;
  bounds?: ComposerColumn;
}) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [keyboardBottom, setKeyboardBottom] = useState(0);
  const scale = useSharedValue<number>(appearance.motion.popupScale);
  const anchorWasVisible = useRef(false);
  const presentedKey = useRef(presentationKey);
  const currentKey = useRef(presentationKey); currentKey.current = presentationKey;
  const overlayWasPresented = useRef(false);
  const dismissalFinished = useRef(false);
  const pendingAction = useRef<Action | null>(null);
  const pendingPaste = useRef<PasteEventPayload | null>(null);
  const pasteRead = useRef<object | null>(null);
  const [readingPaste, setReadingPaste] = useState(false);
  const [pasteNotice, setPasteNotice] = useState('');
  const pasteNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pasteRef = useRef(onPaste); pasteRef.current = onPaste;
  const hasPaste = !!onPaste && (textPasteAllowed || attachmentsAllowed);
  const anchorRef = useRef(anchor);
  const fallbackScheduled = useRef(false);
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeRef = useRef(close);
  const chooseRef = useRef(choose);
  const onDismissRef = useRef(onDismiss);
  closeRef.current = close;
  chooseRef.current = choose;
  onDismissRef.current = onDismiss;
  anchorRef.current = anchor;

  const anchorX = anchor?.x ?? null;
  const anchorY = anchor?.y ?? null;
  const anchorWidth = anchor?.width ?? null;
  const anchorHeight = anchor?.height ?? null;
  const currentAnchor = anchorX === null || anchorY === null || anchorWidth === null || anchorHeight === null
    ? null
    : { x: anchorX, y: anchorY, width: anchorWidth, height: anchorHeight };
  const layout = useMemo(() => getActionMenuLayout(
    currentAnchor,
    { width, height },
    bounds ? { left: bounds.left, top: bounds.top, right: Math.max(0, width - bounds.left - bounds.width),
      bottom: Math.max(0, height - bounds.top - bounds.height) } : insets,
    keyboardBottom,
    items.length + (hasPaste ? 1 : 0),
  ), [currentAnchor?.x, currentAnchor?.y, currentAnchor?.width, currentAnchor?.height,
    width, height, hasPaste, insets.top, insets.right, insets.bottom, insets.left, keyboardBottom,
    bounds?.left, bounds?.top, bounds?.width, bounds?.height]);

  const finishDismiss = useCallback(() => {
    // A native onDismiss from a previous presentation can arrive after a
    // parent has already opened the menu again. It must not dismiss the new
    // cycle or launch a stale picker.
    if (anchorRef.current !== null || !overlayWasPresented.current || dismissalFinished.current) return;
    dismissalFinished.current = true;
    overlayWasPresented.current = false;
    const action = pendingAction.current;
    pendingAction.current = null;
    const paste = pendingPaste.current; pendingPaste.current = null;
    if (paste) pasteRef.current?.(paste);
    else if (action) chooseRef.current(action);
    else onDismissRef.current?.();
  }, []);

  // React Native exposes Modal.onDismiss on iOS. Android's Modal API does not
  // provide that event, so wait until pending interactions have drained before
  // opening the system document/photo picker there.
  const scheduleOverlayDismiss = useCallback(() => {
    // Let the effect that observes anchor=null schedule completion after the
    // host has actually been removed. This prevents a callback queued during
    // the press from racing the parent's state commit on either platform.
    if (anchorRef.current !== null) return;
    if (fallbackScheduled.current) return;
    fallbackScheduled.current = true;
    InteractionManager.runAfterInteractions(() => {
      fallbackTimer.current = setTimeout(() => {
        fallbackTimer.current = null;
        fallbackScheduled.current = false;
        finishDismiss();
      }, 0);
    });
  }, [finishDismiss]);

  useEffect(() => () => {
    if (fallbackTimer.current !== null) clearTimeout(fallbackTimer.current);
    if (pasteNoticeTimer.current !== null) clearTimeout(pasteNoticeTimer.current);
    pasteRead.current = null;
    fallbackScheduled.current = false;
  }, []);

  useEffect(() => {
    const updateKeyboard = (event: { endCoordinates?: { screenY?: number } }) => {
      const screenY = event.endCoordinates?.screenY;
      if (typeof screenY === 'number' && Number.isFinite(screenY)) {
        setKeyboardBottom(Math.max(0, height - screenY));
      }
    };
    const hideKeyboard = () => setKeyboardBottom(0);
    const subscriptions = Platform.OS === 'ios'
      ? [
        Keyboard.addListener('keyboardWillChangeFrame', updateKeyboard),
        Keyboard.addListener('keyboardWillHide', hideKeyboard),
        Keyboard.addListener('keyboardDidChangeFrame', updateKeyboard),
      ]
      : [
        Keyboard.addListener('keyboardDidShow', updateKeyboard),
        Keyboard.addListener('keyboardDidHide', hideKeyboard),
      ];
    return () => subscriptions.forEach(subscription => subscription.remove());
  }, [height]);

  useEffect(() => {
    if (currentAnchor) {
      if (!anchorWasVisible.current || presentedKey.current !== presentationKey) {
        presentedKey.current = presentationKey;
        anchorWasVisible.current = true;
        overlayWasPresented.current = true;
        dismissalFinished.current = false;
        pendingAction.current = null; pendingPaste.current = null;
        pasteRead.current = null; setReadingPaste(false); setPasteNotice('');
        if (pasteNoticeTimer.current !== null) clearTimeout(pasteNoticeTimer.current);
        scale.value = appearance.motion.popupScale;
        scale.value = withTiming(1, {
          duration: appearance.motion.popupDuration,
          easing: Easing.out(Easing.cubic),
          reduceMotion: ReduceMotion.System,
        });
      }
      return;
    }

    if (anchorWasVisible.current) {
      anchorWasVisible.current = false;
      pasteRead.current = null;
      scheduleOverlayDismiss();
    }
  }, [currentAnchor?.x, currentAnchor?.y, currentAnchor?.width, currentAnchor?.height,
    presentationKey, scheduleOverlayDismiss, scale]);

  const dismiss = useCallback(() => {
    if (!overlayWasPresented.current || pendingAction.current || pendingPaste.current) return;
    pendingAction.current = null;
    closeRef.current();
    scheduleOverlayDismiss();
  }, [scheduleOverlayDismiss]);

  const select = useCallback((action: Action) => {
    if (!overlayWasPresented.current || pendingAction.current || pendingPaste.current || pasteRead.current) return;
    pendingAction.current = action;
    closeRef.current();
    scheduleOverlayDismiss();
  }, [scheduleOverlayDismiss]);

  const paste = async () => {
    if (!anchor || anchorRef.current !== anchor || !overlayWasPresented.current || pendingAction.current || pendingPaste.current || pasteRead.current) return;
    const request = {};
    pasteRead.current = request; setReadingPaste(true); setPasteNotice('');
    if (pasteNoticeTimer.current !== null) clearTimeout(pasteNoticeTimer.current);
    let item: PasteEventPayload | null = null;
    let notice = 'Sin contenido para pegar';
    try { item = await readClipboardPaste(Clipboard, textPasteAllowed, attachmentsAllowed); }
    catch { notice = 'No se pudo pegar'; }
    // Permission and image decoding are asynchronous. Ignore results after
    // dismissal, unmount, or a new menu presentation; never paste twice.
    if (pasteRead.current !== request || anchorRef.current === null || currentKey.current !== presentationKey) return;
    pasteRead.current = null; setReadingPaste(false);
    if (item) {
      pendingPaste.current = item; closeRef.current(); scheduleOverlayDismiss();
    } else {
      setPasteNotice(notice);
      pasteNoticeTimer.current = setTimeout(() => {
        pasteNoticeTimer.current = null; setPasteNotice('');
      }, appearance.transfer.toastDuration);
    }
  };

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const contents = <View
    style={[styles.modalRoot, anchor === null && styles.hiddenRoot]}
    pointerEvents={anchor === null ? 'none' : 'box-none'}
    accessibilityViewIsModal
  >
      <Pressable
        style={StyleSheet.absoluteFill}
        accessibilityRole="button"
        accessibilityLabel="Cerrar acciones"
        onPress={dismiss}
      />
      {layout && <Animated.View
        testID="phonepad-action-menu"
        style={[
          styles.menu,
          {
            left: layout.left,
            top: layout.top,
            width: layout.width,
            transformOrigin: [layout.originX, layout.originY, 0],
          },
          animatedStyle,
        ]}
      >
        <GlassSurface interactive style={[styles.surface, { width: layout.width, height: layout.height }]}>
          <ScrollView
            bounces={false}
            keyboardShouldPersistTaps="always"
            keyboardDismissMode="none"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.rows}
          >
            {hasPaste && <Pressable testID="phonepad-action-paste" accessibilityRole="button" accessibilityLabel="Pegar del iPhone"
              accessibilityState={{disabled:readingPaste,busy:readingPaste}} disabled={readingPaste}
              style={({pressed})=>[styles.row,pressed && styles.rowPressed]} onPress={paste}>
              <View style={styles.icon}>
                {readingPaste ? <ActivityIndicator color={appearance.color.text} /> : <ActionIcon action="paste" />}
              </View>
              <Text accessibilityLiveRegion="polite" style={styles.label}>{pasteNotice || ACTIONS.paste.label}</Text>
            </Pressable>}
            {items.map(item => <Pressable
              key={item.key}
              testID={`phonepad-action-${item.key}`}
              accessibilityRole="button"
              accessibilityLabel={item.label}
              disabled={!attachmentsAllowed || readingPaste}
              accessibilityState={{ disabled: !attachmentsAllowed || readingPaste }}
              onPress={() => select(item.key)}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed,
                (!attachmentsAllowed || readingPaste) && styles.rowDisabled]}
            >
              <View style={styles.icon}>
                <ActionIcon action={item.key} />
              </View>
              <Text style={styles.label}>{item.label}</Text>
            </Pressable>)}
          </ScrollView>
        </GlassSurface>
      </Animated.View>}
  </View>;

  // Presenting an iOS Modal creates a second view controller and can resign
  // the composer's first responder. FullWindowOverlay puts this transparent
  // layer directly in the existing window, keeping the keyboard and measured
  // composer position stable. Android retains the native Modal path because
  // FullWindowOverlay is an iOS-only native component.
  if (Platform.OS === 'ios') {
    // Keep the component mounted for its dismissal lifecycle while removing
    // the native window-level container as soon as the anchor is cleared.
    return anchor === null
      ? null
      : <FullWindowOverlay unstable_accessibilityContainerViewIsModal>{contents}</FullWindowOverlay>;
  }

  return <Modal
    visible={anchor !== null}
    transparent
    presentationStyle="overFullScreen"
    supportedOrientations={['portrait', 'landscape']}
    animationType="none"
    statusBarTranslucent
    navigationBarTranslucent
    onRequestClose={dismiss}
    onDismiss={finishDismiss}
  >
    {contents}
  </Modal>;
}

const styles = StyleSheet.create({
  modalRoot: {
    ...StyleSheet.absoluteFill,
  },
  hiddenRoot: {
    display: 'none',
  },
  menu: {
    position: 'absolute',
    width: ACTION_MENU_WIDTH,
  },
  surface: {
    width: ACTION_MENU_WIDTH,
    borderRadius: appearance.control.menuRadius,
    padding: appearance.shortcuts.padding,
  },
  rows: {
    flexGrow: 1,
  },
  row: {
    minHeight: ACTION_MENU_ROW_HEIGHT,
    paddingHorizontal: appearance.control.margin,
    borderRadius: appearance.control.menuRadius,
    flexDirection: 'row',
    alignItems: 'center',
  },
  rowPressed: {
    backgroundColor: appearance.color.pressed,
  },
  rowDisabled: { opacity: appearance.state.disabled },
  icon: {
    width: appearance.control.iconSize,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: appearance.control.margin,
  },
  label: {
    color: appearance.color.text,
    fontSize: appearance.text.body,
    flexShrink: 1,
  },
});
