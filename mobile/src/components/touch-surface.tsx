import { CURSOR_POINTS, cursorPlacement, type CursorState } from '../lib/cursor';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { AppState, View, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';
import { Gesture, GestureDetector, type GestureTouchEvent, type TouchData } from 'react-native-gesture-handler';
import { scheduleOnRN } from 'react-native-worklets';
import { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import type { Connection } from '../lib/connection';
import type { TouchContact } from '../lib/protocol';
import {
  LEGACY_POINTER_GEOMETRY,
  mapPointerSnapshot,
  mapCalibratedPointerSnapshot,
  mapPointerToContact,
  type PointerGeometry,
  type PointerSurfaceSize,
} from '../lib/pointer-geometry';
import { directPoint, DirectPointerSequence } from '../lib/direct-pointer';
import { clampPreviewPan, clampPreviewScale, previewPanBounds, PREVIEW_ZOOM_MIN } from '../lib/preview-zoom';

export { LEGACY_POINTER_GEOMETRY, SQUARE_POINTER_GEOMETRY } from '../lib/pointer-geometry';

type TouchSurfaceSize = PointerSurfaceSize;

/**
 * Fit the complete phone surface inside the physical 100x70mm pad without
 * stretching either axis. The unused physical letterbox is centered; every
 * point on the phone remains sensitive, including its top and bottom edges.
 */
export function mapTouchToContact(
  touch: Pick<TouchData, 'id' | 'x' | 'y'>,
  size: TouchSurfaceSize,
  geometry: PointerGeometry = LEGACY_POINTER_GEOMETRY,
): TouchContact {
  'worklet';
  return mapPointerToContact({ id: touch.id, x: touch.x, y: touch.y }, size, geometry);
}

/** Build the complete active-contact snapshot for a down/move event. */
export function mapTouchSnapshot(
  touches: readonly Pick<TouchData, 'id' | 'x' | 'y'>[],
  size: TouchSurfaceSize,
  geometry: PointerGeometry = LEGACY_POINTER_GEOMETRY,
): TouchContact[] {
  'worklet';
  return mapPointerSnapshot(touches.map(touch => ({ id: touch.id, x: touch.x, y: touch.y })), size, geometry);
}

/**
 * `onTouchesUp` can expose the lifted pointer in `allTouches` for the event
 * boundary. Remove every changed id before forwarding the next snapshot.
 */
export function mapTouchReleaseSnapshot(
  allTouches: readonly Pick<TouchData, 'id' | 'x' | 'y'>[],
  changedTouches: readonly Pick<TouchData, 'id'>[],
  size: TouchSurfaceSize,
  geometry: PointerGeometry = LEGACY_POINTER_GEOMETRY,
): TouchContact[] {
  'worklet';
  return mapTouchSnapshot(
    allTouches.filter(touch => !changedTouches.some(changed => changed.id === touch.id)),
    size,
    geometry,
  );
}

/**
 * Remove only ids that are still part of the current native sequence. Native
 * up callbacks can arrive late with an old `allTouches` snapshot, so callers
 * must use the tracked contacts as the source of truth for this operation.
 */
export function removeChangedTouchContacts(
  trackedContacts: readonly TouchContact[],
  changedTouches: readonly Pick<TouchData, 'id'>[],
): TouchContact[] {
  'worklet';
  return trackedContacts
    .filter(contact => !changedTouches.some(changed => changed.id === contact.id))
    .sort((left, right) => left.id - right.id);
}

export function TouchSurface({ connection, children, preview, dismissKeyboard,
  pointerGeometry = LEGACY_POINTER_GEOMETRY, pointerGeometryEpoch = 0, mode = 'trackpad', gain, disabled = false, videoSize, viewportInsetBottom = 0, cursor = null, cursorScale = .75 }: {
  connection: Connection;
  children?: ReactNode;
  preview: boolean;
  dismissKeyboard?: () => void;
  pointerGeometry?: PointerGeometry;
  pointerGeometryEpoch?: number;
  mode?: 'direct' | 'trackpad';
  gain?: number;
  disabled?: boolean;
  videoSize?: { width?: number; height?: number };
  viewportInsetBottom?: number;
  cursor?: CursorState | null;
  cursorScale?: number;
}) {
  const width = useSharedValue(1);
  const height = useSharedValue(1);
  const sequenceGeneration = useSharedValue(0);
  const sequenceActive = useSharedValue(false);
  const keyboardConsumed = useSharedValue(false);
  const activeContacts = useSharedValue<TouchContact[]>([]);
  const previewScale = useSharedValue(PREVIEW_ZOOM_MIN);
  const previewOffsetX = useSharedValue(0);
  const previewOffsetY = useSharedValue(0);
  const pinchStartScale = useSharedValue(PREVIEW_ZOOM_MIN);
  const panStartX = useSharedValue(0);
  const panStartY = useSharedValue(0);
  const zoomOwns = useSharedValue(false);
  const initialSpan = useSharedValue(0);
  const initialCenterX = useSharedValue(0), initialCenterY = useSharedValue(0);
  const scrollOwns = useSharedValue(false);
  const direct = useMemo(() => new DirectPointerSequence(command => inputEpoch.current === connection.inputEpoch && connection.send(command)), [connection]);
  const inputEpoch = useRef<number | null>(null);
  const inputBlocked = useRef(false);
  const generationOnJS = useRef(0);

  const finishJSSequence = (generation: number, cancelled: boolean) => {
    if (generation < generationOnJS.current) return;
    // A newer generation invalidates the prior sequence. It must use the
    // protocol's cancellation frame so the daemon cannot interpret an
    // interrupted contact as a physical tap.
    if (inputEpoch.current !== null) {
      if (mode === 'direct') {
        if (cancelled || generation > generationOnJS.current || inputEpoch.current !== connection.inputEpoch) direct.cancel(); else direct.frame([]);
      } else {
      if (cancelled || generation > generationOnJS.current) {
        connection.cancelTouch(inputEpoch.current);
      } else {
        connection.touch(inputEpoch.current, []);
      }
      }
    }
    generationOnJS.current = generation;
    inputEpoch.current = null;
    inputBlocked.current = false;
  };

  const sendTouchFrame = (
    contacts: TouchContact[],
    generation: number,
    begins: boolean,
    releases: boolean,
    cancelled: boolean,
  ) => {
    if (generation < generationOnJS.current) return;
    if (releases || cancelled) {
      finishJSSequence(generation, cancelled);
      return;
    }
    if (generation > generationOnJS.current) finishJSSequence(generation, true);
    if (inputEpoch.current === null) {
      // Moves from a sequence whose first down callback was invalidated must
      // not capture a later transport epoch and resurrect a stale finger.
      if (!begins) return;
      inputEpoch.current = connection.inputEpoch;
      inputBlocked.current = false;
    }
    if (inputBlocked.current || disabled) return;
    if (mode === 'direct') {
      if (inputEpoch.current !== connection.inputEpoch) { inputBlocked.current = true; return; }
      direct.frame(contacts); return;
    }
    if (!connection.touch(inputEpoch.current, contacts)) inputBlocked.current = true;
  };

  const interruptSequence = () => {
    const generation = Math.max(generationOnJS.current, sequenceGeneration.value) + 1;
    generationOnJS.current = generation;
    sequenceGeneration.value = generation;
    sequenceActive.value = false;
    keyboardConsumed.value = false;
    zoomOwns.value = false;
    activeContacts.value = [];
    previewScale.value = PREVIEW_ZOOM_MIN;
    previewOffsetX.value = 0;
    previewOffsetY.value = 0;
    finishJSSequence(generation, true);
  };

  const previewStyle = useAnimatedStyle(() => ({
    transformOrigin: [width.value / 2, Math.max(1, height.value - viewportInsetBottom) / 2, 0],
    transform: [
      { translateX: previewOffsetX.value },
      { translateY: previewOffsetY.value },
      { scale: previewScale.value },
    ],
  })) as unknown as ViewStyle;

  const cursorStyle = useAnimatedStyle(() => cursorPlacement(cursor, width.value, Math.max(1,height.value-viewportInsetBottom), previewScale.value, previewOffsetX.value, previewOffsetY.value, CURSOR_POINTS * cursorScale));

  useEffect(() => {
    // A mode switch, including entering preview or changing the keyboard
    // overlay, invalidates any in-flight native sequence.
    return () => interruptSequence();
  }, [connection, preview, dismissKeyboard, pointerGeometry, pointerGeometryEpoch, mode, gain, disabled, viewportInsetBottom]);

  useEffect(() => {
    const listener = AppState.addEventListener('change', state => {
      if (state !== 'active') interruptSequence();
    });
    return () => listener.remove();
  }, [connection]);

  const gestures = useMemo(() => {
    const map = (touches: readonly TouchData[]) => {
      'worklet';
      if (mode === 'direct') return touches.map(touch => {
        const p=directPoint(touch.x,touch.y,width.value,Math.max(1,height.value-viewportInsetBottom),videoSize?.width??0,videoSize?.height??0,previewScale.value,previewOffsetX.value,previewOffsetY.value);
        return p ? {id:touch.id,...p} : null;
      }).filter((p): p is NonNullable<typeof p> => p !== null);
      const mapped=mapTouchSnapshot(touches,{width:width.value,height:height.value},pointerGeometry);
      if (gain === undefined) return mapped;
      return mapCalibratedPointerSnapshot(touches,{width:width.value,height:height.value},pointerGeometry,gain);
    };
    const claimZoom = () => {
      'worklet';
      if (zoomOwns.value) return;
      zoomOwns.value=true;
      scheduleOnRN(sendTouchFrame,[],sequenceGeneration.value,false,false,true);
    };
    const forward = Gesture.Manual()
      .onTouchesDown((event: GestureTouchEvent, manager) => {
        'worklet';
        if (disabled) return;
        manager?.activate();
        if (event.allTouches.length === 1) { zoomOwns.value = false; initialSpan.value = 0; scrollOwns.value = false; }
        if (event.allTouches.length === 2) { const [a,b]=event.allTouches; initialSpan.value=Math.hypot(a.x-b.x,a.y-b.y); initialCenterX.value=(a.x+b.x)/2; initialCenterY.value=(a.y+b.y)/2; }
        if (event.allTouches.length > 2) scrollOwns.value = true;
        if (zoomOwns.value) return;
        if (dismissKeyboard) {
          if (!keyboardConsumed.value) {
            keyboardConsumed.value = true;
            scheduleOnRN(dismissKeyboard);
          }
          return;
        }
        const contacts = map(event.allTouches);
        if (mode === 'direct' && contacts.length === 0) return;
        if (!sequenceActive.value) {
          sequenceGeneration.value += 1;
          sequenceActive.value = true;
          activeContacts.value = contacts;
          scheduleOnRN(sendTouchFrame, contacts, sequenceGeneration.value, true, false, false);
          return;
        }
        activeContacts.value = contacts;
        scheduleOnRN(sendTouchFrame, contacts, sequenceGeneration.value, false, false, false);
      })
      .onTouchesMove((event: GestureTouchEvent) => {
        'worklet';
        if (disabled || zoomOwns.value || dismissKeyboard || !sequenceActive.value) return;
        if (preview && event.allTouches.length === 2 && initialSpan.value > 0) {
          const [a,b]=event.allTouches;
          const travel = Math.hypot((a.x+b.x)/2-initialCenterX.value,(a.y+b.y)/2-initialCenterY.value);
          const spread = Math.abs(Math.hypot(a.x-b.x,a.y-b.y)-initialSpan.value);
          if (!scrollOwns.value && travel >= 8 && travel > spread) scrollOwns.value = true;
          if (!scrollOwns.value && (previewScale.value > 1 || (spread >= 12 && spread/initialSpan.value >= .12 && spread > travel))) { claimZoom(); return; }
        }
        const contacts = map(event.allTouches);
        if (mode === 'direct' && contacts.length === 0) {
          sequenceActive.value = false; activeContacts.value = [];
          scheduleOnRN(sendTouchFrame, [], sequenceGeneration.value, false, false, true); return;
        }
        activeContacts.value = contacts;
        scheduleOnRN(sendTouchFrame, contacts, sequenceGeneration.value, false, false, false);
      })
      .onTouchesUp((event: GestureTouchEvent, manager) => {
        'worklet';
        if (!event.allTouches.some(touch => !event.changedTouches.some(changed => changed.id === touch.id))) manager?.end();
        if (zoomOwns.value) {
          if (!event.allTouches.some(touch => !event.changedTouches.some(changed => changed.id === touch.id))) {
            sequenceActive.value = false; activeContacts.value = []; zoomOwns.value = false;
          }
          return;
        }
        if (disabled || zoomOwns.value || dismissKeyboard || !sequenceActive.value) return;
        const trackedIds = activeContacts.value.map(contact => contact.id);
        const changedIds = event.changedTouches.map(touch => touch.id);
        // A delayed native up from a previous sequence must not observe the
        // current generation and release its contacts. Ignore it unless one
        // of its changed ids is still tracked by this native sequence.
        if (!changedIds.some(id => trackedIds.some(trackedId => trackedId === id))) return;
        const contacts = removeChangedTouchContacts(activeContacts.value, event.changedTouches);
        activeContacts.value = contacts;
        const generation = sequenceGeneration.value;
        scheduleOnRN(sendTouchFrame, contacts, generation, false, contacts.length === 0, false);
        if (contacts.length === 0) sequenceActive.value = false;
      })
      .onTouchesCancelled(() => {
        'worklet';
        zoomOwns.value = false; initialSpan.value = 0;
        if (!sequenceActive.value) return;
        sequenceGeneration.value += 1;
        sequenceActive.value = false;
        activeContacts.value = [];
        scheduleOnRN(sendTouchFrame, [], sequenceGeneration.value, false, false, true);
      });
    const pinch = Gesture.Pinch()
      .enabled(preview && !disabled && !dismissKeyboard)
      .onBegin(() => {
        'worklet';
        pinchStartScale.value = previewScale.value;
      })
      .onUpdate(event => {
        'worklet';
        if (scrollOwns.value || (!zoomOwns.value && (Math.abs(event.scale - 1) < .12 || Math.abs(event.scale - 1)*initialSpan.value < 12))) return;
        claimZoom();
        const nextScale = clampPreviewScale(pinchStartScale.value * event.scale);
        previewScale.value = nextScale;
        const bounds = previewPanBounds({ width: width.value, height: Math.max(1, height.value - viewportInsetBottom) }, nextScale);
        previewOffsetX.value = Math.min(bounds.x, Math.max(-bounds.x, previewOffsetX.value));
        previewOffsetY.value = Math.min(bounds.y, Math.max(-bounds.y, previewOffsetY.value, CURSOR_POINTS * cursorScale));
      });
    const pan = Gesture.Pan()
      .enabled(preview && !disabled && !dismissKeyboard)
      .minPointers(2)
      .maxPointers(2)
      .onBegin(() => {
        'worklet';
        panStartX.value = previewOffsetX.value;
        panStartY.value = previewOffsetY.value;
      })
      .onUpdate(event => {
        'worklet';
        if (previewScale.value <= 1) return;
        claimZoom();
        const next = clampPreviewPan({ x: panStartX.value + event.translationX, y: panStartY.value + event.translationY },
          { width: width.value, height: Math.max(1, height.value - viewportInsetBottom) }, previewScale.value);
        previewOffsetX.value = next.x;
        previewOffsetY.value = next.y;
      });
    return Gesture.Simultaneous(forward, pinch, pan);
  }, [connection, dismissKeyboard, pointerGeometry, pointerGeometryEpoch, preview, mode, gain, disabled, videoSize?.width, videoSize?.height, viewportInsetBottom]);

  const onLayout = (event: { nativeEvent: { layout: { width: number; height: number } } }) => {
    width.value = event.nativeEvent.layout.width;
    height.value = event.nativeEvent.layout.height;
    // Geometry changes invalidate coordinates and any gesture classification
    // in the native recognizer. Release before the next touch begins.
    interruptSequence();
  };

  return <GestureDetector gesture={gestures}>
    <View
      onLayout={onLayout}
      collapsable={false}
      style={{ flex: 1, overflow: 'hidden' }}
      accessibilityLabel={mode === 'direct' ? 'Control directo de la pantalla. Tocá o arrastrá; dos dedos para scroll o clic derecho.' : 'Touchpad multitáctil. Los gestos físicos se procesan en la computadora.'}
    >
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', inset: 0 }, previewStyle]}>{children}</Animated.View>
      {preview && !!cursor?.image && <View pointerEvents="none" style={{position:'absolute',top:0,left:0,right:0,bottom:viewportInsetBottom,overflow:'hidden',zIndex:2}}>
        <Animated.Image accessible={false} fadeDuration={0} source={{uri:cursor.image}} resizeMode="stretch" style={[{position:'absolute'},cursorStyle]} />
      </View>}
    </View>
  </GestureDetector>;
}
