import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { AppState, View } from 'react-native';
import { Gesture, GestureDetector, type GestureTouchEvent, type TouchData } from 'react-native-gesture-handler';
import { scheduleOnRN } from 'react-native-worklets';
import { useSharedValue } from 'react-native-reanimated';
import type { Connection } from '../lib/connection';
import type { TouchContact } from '../lib/protocol';

type TouchSurfaceSize = { width: number; height: number };

function clamp(value: number, minimum = 0, maximum = 1) {
  'worklet';
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * Fit the complete phone surface inside the physical 100x70mm pad without
 * stretching either axis. The unused physical letterbox is centered; every
 * point on the phone remains sensitive, including its top and bottom edges.
 */
export function mapTouchToContact(
  touch: Pick<TouchData, 'id' | 'x' | 'y'>,
  size: TouchSurfaceSize,
): TouchContact {
  'worklet';
  const width = Math.max(1, Number.isFinite(size.width) ? size.width : 1);
  const height = Math.max(1, Number.isFinite(size.height) ? size.height : 1);
  const scale = Math.min(100 / width, 70 / height);
  const offsetX = (100 - width * scale) / 2;
  const offsetY = (70 - height * scale) / 2;
  const pointX = Number.isFinite(touch.x) ? touch.x : 0;
  const pointY = Number.isFinite(touch.y) ? touch.y : 0;
  return {
    id: touch.id,
    x: clamp((offsetX + pointX * scale) / 100),
    y: clamp((offsetY + pointY * scale) / 70),
  };
}

/** Build the complete active-contact snapshot for a down/move event. */
export function mapTouchSnapshot(
  touches: readonly Pick<TouchData, 'id' | 'x' | 'y'>[],
  size: TouchSurfaceSize,
): TouchContact[] {
  'worklet';
  return touches
    .map(touch => mapTouchToContact(touch, size))
    .sort((left, right) => left.id - right.id);
}

/**
 * `onTouchesUp` can expose the lifted pointer in `allTouches` for the event
 * boundary. Remove every changed id before forwarding the next snapshot.
 */
export function mapTouchReleaseSnapshot(
  allTouches: readonly Pick<TouchData, 'id' | 'x' | 'y'>[],
  changedTouches: readonly Pick<TouchData, 'id'>[],
  size: TouchSurfaceSize,
): TouchContact[] {
  'worklet';
  return mapTouchSnapshot(
    allTouches.filter(touch => !changedTouches.some(changed => changed.id === touch.id)),
    size,
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

export function TouchSurface({ connection, children, preview, dismissKeyboard }: {
  connection: Connection;
  children?: ReactNode;
  preview: boolean;
  dismissKeyboard?: () => void;
}) {
  const width = useSharedValue(1);
  const height = useSharedValue(1);
  const sequenceGeneration = useSharedValue(0);
  const sequenceActive = useSharedValue(false);
  const keyboardConsumed = useSharedValue(false);
  const activeContacts = useSharedValue<TouchContact[]>([]);
  const inputEpoch = useRef<number | null>(null);
  const inputBlocked = useRef(false);
  const generationOnJS = useRef(0);

  const finishJSSequence = (generation: number, cancelled: boolean) => {
    if (generation < generationOnJS.current) return;
    // A newer generation invalidates the prior sequence. It must use the
    // protocol's cancellation frame so the daemon cannot interpret an
    // interrupted contact as a physical tap.
    if (inputEpoch.current !== null) {
      if (cancelled || generation > generationOnJS.current) {
        connection.cancelTouch(inputEpoch.current);
      } else {
        connection.touch(inputEpoch.current, []);
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
    if (inputBlocked.current) return;
    if (!connection.touch(inputEpoch.current, contacts)) inputBlocked.current = true;
  };

  const interruptSequence = () => {
    const generation = Math.max(generationOnJS.current, sequenceGeneration.value) + 1;
    generationOnJS.current = generation;
    sequenceGeneration.value = generation;
    sequenceActive.value = false;
    keyboardConsumed.value = false;
    activeContacts.value = [];
    finishJSSequence(generation, true);
  };

  useEffect(() => {
    // A mode switch, including entering preview or changing the keyboard
    // overlay, invalidates any in-flight native sequence.
    return () => interruptSequence();
  }, [connection, preview, dismissKeyboard]);

  useEffect(() => {
    const listener = AppState.addEventListener('change', state => {
      if (state !== 'active') interruptSequence();
    });
    return () => listener.remove();
  }, [connection]);

  const gestures = useMemo(() => {
    const forward = Gesture.Manual()
      .onTouchesDown((event: GestureTouchEvent) => {
        'worklet';
        if (dismissKeyboard) {
          if (!keyboardConsumed.value) {
            keyboardConsumed.value = true;
            scheduleOnRN(dismissKeyboard);
          }
          return;
        }
        if (!sequenceActive.value) {
          sequenceGeneration.value += 1;
          sequenceActive.value = true;
          const contacts = mapTouchSnapshot(event.allTouches, { width: width.value, height: height.value });
          activeContacts.value = contacts;
          scheduleOnRN(sendTouchFrame, contacts, sequenceGeneration.value, true, false, false);
          return;
        }
        const contacts = mapTouchSnapshot(event.allTouches, { width: width.value, height: height.value });
        activeContacts.value = contacts;
        scheduleOnRN(sendTouchFrame, contacts, sequenceGeneration.value, false, false, false);
      })
      .onTouchesMove((event: GestureTouchEvent) => {
        'worklet';
        if (dismissKeyboard || !sequenceActive.value) return;
        const contacts = mapTouchSnapshot(event.allTouches, { width: width.value, height: height.value });
        activeContacts.value = contacts;
        scheduleOnRN(sendTouchFrame, contacts, sequenceGeneration.value, false, false, false);
      })
      .onTouchesUp((event: GestureTouchEvent) => {
        'worklet';
        if (dismissKeyboard || !sequenceActive.value) return;
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
        if (!sequenceActive.value) return;
        sequenceGeneration.value += 1;
        sequenceActive.value = false;
        activeContacts.value = [];
        scheduleOnRN(sendTouchFrame, [], sequenceGeneration.value, false, false, true);
      });

    return forward;
  }, [connection, dismissKeyboard]);

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
      accessibilityLabel="Touchpad multitáctil. Los gestos físicos se procesan en la computadora."
    >
      <View pointerEvents="none" style={{ position: 'absolute', inset: 0 }}>{children}</View>
    </View>
  </GestureDetector>;
}
