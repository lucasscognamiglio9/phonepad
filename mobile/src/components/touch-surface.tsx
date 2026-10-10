import { CURSOR_POINTS, cursorPlacement, cursorTransitionMs, type CursorState, type CursorFeed } from '../lib/cursor';
import { reflectionRest, type GlassPointer } from './glass-reflection';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, Image, View, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';
import { Gesture, GestureDetector, type GestureTouchEvent, type TouchData } from 'react-native-gesture-handler';
import { scheduleOnRN } from 'react-native-worklets';
import { cancelAnimation, Easing, useAnimatedStyle, useDerivedValue, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import type { Connection } from '../lib/connection';
import type { TouchContact } from '../lib/protocol';
import {
  LEGACY_POINTER_GEOMETRY,
  mapPointerSnapshot,
  mapCalibratedPointerSnapshot,
  mapPointerToContact,
  pointerMmPerPoint,
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
  pointerGeometry = LEGACY_POINTER_GEOMETRY, pointerGeometryEpoch = 0, mode = 'trackpad', gain, disabled = false, videoSize, viewportInsetBottom = 0, viewportInsetTop = 0, viewportInsetLeft = 0, viewportInsetRight = 0, keyboardMotion, cursor = null, cursorFeed, cursorScale = .75, glassPointer }: {
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
  viewportInsetTop?: number; viewportInsetLeft?: number; viewportInsetRight?: number;
  keyboardMotion?: { height: SharedValue<number>; windowResize: number; bottom: number; visible?: boolean };
  cursor?: CursorState | null;
  cursorFeed?: CursorFeed;
  cursorScale?: number; glassPointer?: GlassPointer;
}) {
  const width = useSharedValue(1);
  const height = useSharedValue(1);
  // Follow the native keyboard on the UI thread. Rendering, cursor overlay and
  // direct hit testing all consume this same inset, including during animation.
  const viewportBottom = useDerivedValue(() => keyboardMotion
    ? Math.max(keyboardMotion.bottom, keyboardMotion.visible === false ? 0 : -keyboardMotion.height.value - keyboardMotion.windowResize)
    : viewportInsetBottom);
  const viewportStyle = useAnimatedStyle(() => ({ position: 'absolute' as const,
    top: viewportInsetTop, left: viewportInsetLeft, right: viewportInsetRight,
    bottom: viewportBottom.value, overflow: 'hidden' as const,
  }));
  const sequenceGeneration = useSharedValue(0);
  const reflectionContact = useSharedValue(-1);
  const sequenceActive = useSharedValue(false);
  const keyboardConsumed = useSharedValue(false);
  const activeContacts = useSharedValue<TouchContact[]>([]);
  const pointerAnchor = useSharedValue({x:0,y:0});
  const rebased = useSharedValue(false);
  const segmented = useSharedValue(false);
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
  const prediction = useSharedValue({token:0, active:false, waiting:false, fenceUs:0, id:-1, x:0, y:0});
  const requestedFence = useRef(0);
  const reconciliationTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const predictionContract = connection.capabilities?.input.pointerPrediction;


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
    reconcileToken = 0,
  ) => {
    if (generation < generationOnJS.current) return;
    if (releases || cancelled) {
      finishJSSequence(generation, cancelled);
      if (reconcileToken) requestReconciliation(reconcileToken);
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
    if (!connection.touch(inputEpoch.current, contacts)) { inputBlocked.current = true; cancelPrediction(); }
    else if (reconcileToken) requestReconciliation(reconcileToken);
  };

  const resetReflection = () => {
    'worklet';
    reflectionContact.value = -1;
    if (glassPointer) glassPointer.value = { ...reflectionRest, active: false };
  };
  const interruptSequence = () => {
    resetReflection();
    const generation = Math.max(generationOnJS.current, sequenceGeneration.value) + 1;
    generationOnJS.current = generation;
    sequenceGeneration.value = generation;
    sequenceActive.value = false;
    keyboardConsumed.value = false;
    zoomOwns.value = false;
    activeContacts.value = [];
    rebased.value=false;
    previewScale.value = PREVIEW_ZOOM_MIN;
    previewOffsetX.value = 0;
    previewOffsetY.value = 0;
    finishJSSequence(generation, true);
    cancelPrediction();
  };

  const previewStyle = useAnimatedStyle(() => ({
    transformOrigin: [(width.value-viewportInsetLeft-viewportInsetRight) / 2, Math.max(1, height.value - viewportInsetTop - viewportBottom.value) / 2, 0],
    transform: [
      { translateX: previewOffsetX.value },
      { translateY: previewOffsetY.value },
      { scale: previewScale.value },
    ],
  })) as unknown as ViewStyle;

  const position = useSharedValue<CursorState | null>(cursor);
  const cursorX = useSharedValue(cursor?.x ?? 0);
  const cursorY = useSharedValue(cursor?.y ?? 0);
  const receivedCursor = useRef<{state: CursorState | null; at: number}>({state:null, at:0});
  const [bitmap, setBitmap] = useState<CursorState | null>(cursor);
  const bitmapId = useRef(cursor?.imageId ?? '');
  const settlePrediction = (token:number) => {
    const state=prediction.value;
    if (state.token !== token || state.active) return;
    clearTimeout(reconciliationTimer.current);
    prediction.value={...state,waiting:false,fenceUs:0};
    const next=receivedCursor.current.state;
    if (next?.visible) {
      cursorX.value=withTiming(next.x,{duration:64,easing:Easing.linear});
      cursorY.value=withTiming(next.y,{duration:64,easing:Easing.linear});
    }
  };
  const cancelPrediction = () => {
    const token=prediction.value.token;
    prediction.value={...prediction.value,active:false};
    settlePrediction(token);
    prediction.value={...prediction.value,token:token+1};
  };
  const requestReconciliation = (token:number) => {
    const state=prediction.value;
    if (state.token !== token || state.active || !state.waiting || state.token === requestedFence.current) return;
    requestedFence.current=state.token;
    clearTimeout(reconciliationTimer.current);
    connection.requestPointerFence(stamp => {
      if (prediction.value.token !== state.token || prediction.value.active || !prediction.value.waiting) return;
      if (stamp === null) { settlePrediction(state.token); return; }
      prediction.value={...prediction.value,fenceUs:stamp};
      const recent=(receivedCursor.current.state?.capturedAtUs ?? 0)>=stamp-50000;
      if (recent) settlePrediction(state.token);
      else {
        // Never correct the local cursor toward pre-fence backlog. Permit
        // the measured capture interval, then recover an unresponsive peer.
        reconciliationTimer.current=setTimeout(()=>{
          if (prediction.value.token !== state.token || prediction.value.active || !prediction.value.waiting) return;
          connection.recoverPointer();
        },3000);
      }
    });
  };
  useEffect(() => {
    const receive = (next: CursorState | null) => {
      const previous = receivedCursor.current;
      const now = performance.now();
      const duration = cursorTransitionMs(previous.state, next, now - previous.at);
      const local=prediction.value;
      const compatible=next?.visible && predictionContract && next.sourceWidth === predictionContract.width && next.sourceHeight === predictionContract.height;
      const hold=compatible && (local.active || (local.waiting && (!local.fenceUs || (next.capturedAtUs ?? 0) < local.fenceUs-50000)));
      if (!compatible && (local.active || local.waiting)) {
        clearTimeout(reconciliationTimer.current);
        prediction.value={...local,token:local.token+1,active:false,waiting:false,fenceUs:0};
      } else if (local.waiting && !hold) {
        clearTimeout(reconciliationTimer.current);
        prediction.value={...local,waiting:false,fenceUs:0};
      }
      if (hold) { /* Local UI motion remains independent of late echoes. */ }
      else if (!duration) {
        cancelAnimation(cursorX); cancelAnimation(cursorY);
        cursorX.value = next?.x ?? 0; cursorY.value = next?.y ?? 0;
      } else if (next && (next.x !== previous.state?.x || next.y !== previous.state?.y || local.waiting)) {
        cursorX.value = withTiming(next.x, {duration, easing:Easing.linear});
        cursorY.value = withTiming(next.y, {duration, easing:Easing.linear});
      }
      receivedCursor.current = {state:next, at:now};
      // The UI worklet needs geometry, not the PNG payload on every movement.
      position.value = next ? { ...next, image: next.image ? 'ready' : '' } : null;
      if (next?.image && bitmapId.current !== next.imageId) {
        bitmapId.current = next.imageId; setBitmap(next);
      }
    };
    const unsubscribe = cursorFeed?.subscribe(receive);
    if (!cursorFeed) receive(cursor);
    return () => { unsubscribe?.(); clearTimeout(reconciliationTimer.current); cancelAnimation(cursorX); cancelAnimation(cursorY); };
  }, [cursorFeed, cursor, position, cursorX, cursorY, predictionContract]);
  const cursorSize = CURSOR_POINTS * cursorScale;
  const cursorWidth = bitmap ? cursorSize * bitmap.w / Math.max(bitmap.w,bitmap.h) : cursorSize;
  const cursorHeight = bitmap ? cursorSize * bitmap.h / Math.max(bitmap.w,bitmap.h) : cursorSize;
  const cursorStyle = useAnimatedStyle(() => {
    const state = position.value;
    // React commits a changed bitmap separately from position updates. Keep
    // drawing the prior bitmap and its hotspot until that commit completes.
    const shape = state?.imageId === bitmap?.imageId ? state : bitmap;
    const current = state && shape ? {...state, x:cursorX.value, y:cursorY.value,
      w:shape.w, h:shape.h, hx:shape.hx, hy:shape.hy, image:'ready'} : state;
    const {left,top,opacity} = cursorPlacement(current, Math.max(1,width.value-viewportInsetLeft-viewportInsetRight), Math.max(1,height.value-viewportInsetTop-viewportBottom.value), previewScale.value, previewOffsetX.value, previewOffsetY.value, CURSOR_POINTS * cursorScale);
    return {left,top,opacity};
  });

  useEffect(() => {
    // A mode switch, including entering preview or changing the keyboard
    // overlay, invalidates any in-flight native sequence.
    return () => interruptSequence();
  }, [connection, preview, dismissKeyboard, pointerGeometry, pointerGeometryEpoch, mode, gain, disabled, viewportInsetBottom, viewportInsetTop, viewportInsetLeft, viewportInsetRight, viewportBottom, glassPointer]);

  useEffect(() => {
    const listener = AppState.addEventListener('change', state => {
      if (state !== 'active') interruptSequence();
    });
    return () => listener.remove();
  }, [connection, glassPointer]);

  const gestures = useMemo(() => {
    const reflect = (touches: readonly TouchData[]) => {
      'worklet';
      if (!glassPointer || !touches.length) return;
      // Stable contact order: a second finger cannot make the highlight jump.
      const touch = touches.find(t => t.id === reflectionContact.value) ?? touches[0];
      reflectionContact.value = touch.id;
      glassPointer.value = { x: Math.max(0, Math.min(1, touch.x / Math.max(1, width.value))),
        y: Math.max(0, Math.min(1, touch.y / Math.max(1, height.value))), active: true };
    };
    const map = (touches: readonly TouchData[]) => {
      'worklet';
      if (mode === 'direct') return touches.map(touch => {
        const p=directPoint(touch.x-viewportInsetLeft,touch.y-viewportInsetTop,Math.max(1,width.value-viewportInsetLeft-viewportInsetRight),Math.max(1,height.value-viewportInsetTop-viewportBottom.value),videoSize?.width??0,videoSize?.height??0,previewScale.value,previewOffsetX.value,previewOffsetY.value);
        return p ? {id:touch.id,...p} : null;
      }).filter((p): p is NonNullable<typeof p> => p !== null);
      const mapped=mapTouchSnapshot(touches,{width:width.value,height:height.value},pointerGeometry);
      if (gain === undefined || !touches.length) return mapped;
      const cx=touches.reduce((sum,p)=>sum+p.x,0)/touches.length;
      const cy=touches.reduce((sum,p)=>sum+p.y,0)/touches.length;
      if (!sequenceActive.value) { pointerAnchor.value={x:cx,y:cy}; segmented.value=false; }
      const shifted=touches.map(p=>({...p,x:width.value/2+p.x-pointerAnchor.value.x,y:height.value/2+p.y-pointerAnchor.value.y}));
      const calibrated=mapCalibratedPointerSnapshot(shifted,{width:width.value,height:height.value},pointerGeometry,gain);
      if (sequenceActive.value && calibrated.some(p=>p.x<=0 || p.x>=1 || p.y<=0 || p.y>=1)) {
        // Palm-cancel prevents a segment boundary from becoming a tap.
        pointerAnchor.value={x:cx,y:cy}; rebased.value=true;
        return mapCalibratedPointerSnapshot(touches.map(p=>({...p,x:width.value/2+p.x-cx,y:height.value/2+p.y-cy})),{width:width.value,height:height.value},pointerGeometry,gain);
      }
      return calibrated;
    };
    const endPrediction = () => {
      'worklet';
      if (prediction.value.active) prediction.value={...prediction.value,active:false,waiting:true,fenceUs:0};
    };
    const beginPrediction = (touches:readonly TouchData[]) => {
      'worklet';
      const state=position.value;
      if (!preview || mode !== 'trackpad' || touches.length !== 1 || !predictionContract
        || !state?.visible || !state.capturedAtUs || state.sourceWidth !== predictionContract.width
        || state.sourceHeight !== predictionContract.height) return;
      cancelAnimation(cursorX); cancelAnimation(cursorY);
      const touch=touches[0];
      prediction.value={token:prediction.value.token+1,active:true,waiting:false,fenceUs:0,id:touch.id,x:touch.x,y:touch.y};
    };
    const advancePrediction = (touches:readonly TouchData[], rebasing:boolean) => {
      'worklet';
      const local=prediction.value;
      if (!local.active) return;
      if (touches.length !== 1 || touches[0].id !== local.id || !predictionContract) { endPrediction(); return; }
      const touch=touches[0];
      const pixels=pointerMmPerPoint({width:width.value,height:height.value},pointerGeometry,gain)*predictionContract.pixelsPerMm;
      if (!rebasing) {
        cursorX.value=Math.max(0,Math.min(predictionContract.width-1,cursorX.value+(touch.x-local.x)*pixels));
        cursorY.value=Math.max(0,Math.min(predictionContract.height-1,cursorY.value+(touch.y-local.y)*pixels));
      }
      prediction.value={...local,x:touch.x,y:touch.y};
    };
    const claimZoom = () => {
      'worklet';
      if (zoomOwns.value) return;
      zoomOwns.value=true;
      resetReflection();
      endPrediction();
      scheduleOnRN(sendTouchFrame,[],sequenceGeneration.value,false,false,true,prediction.value.waiting ? prediction.value.token : 0);
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
          reflect(event.allTouches);
          sequenceGeneration.value += 1;
          sequenceActive.value = true;
          beginPrediction(event.allTouches);
          activeContacts.value = contacts;
          scheduleOnRN(sendTouchFrame, contacts, sequenceGeneration.value, true, false, false);
          return;
        }
        reflect(event.allTouches);
        advancePrediction(event.allTouches,rebased.value);
        if (rebased.value) {
          rebased.value=false; segmented.value=true;
          scheduleOnRN(sendTouchFrame,[],sequenceGeneration.value,false,false,true);
          sequenceGeneration.value+=1;
          activeContacts.value=contacts;
          scheduleOnRN(sendTouchFrame,contacts,sequenceGeneration.value,true,false,false);
          return;
        }
        activeContacts.value = contacts;
        scheduleOnRN(sendTouchFrame, contacts, sequenceGeneration.value, false, false, false,prediction.value.waiting ? prediction.value.token : 0);
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
          sequenceActive.value = false; activeContacts.value = []; resetReflection();
          scheduleOnRN(sendTouchFrame, [], sequenceGeneration.value, false, false, true); return;
        }
        reflect(event.allTouches);
        advancePrediction(event.allTouches,rebased.value);
        if (rebased.value) {
          rebased.value=false; segmented.value=true;
          scheduleOnRN(sendTouchFrame,[],sequenceGeneration.value,false,false,true);
          sequenceGeneration.value+=1;
          activeContacts.value=contacts;
          scheduleOnRN(sendTouchFrame,contacts,sequenceGeneration.value,true,false,false);
          return;
        }
        activeContacts.value = contacts;
        scheduleOnRN(sendTouchFrame, contacts, sequenceGeneration.value, false, false, false,prediction.value.waiting ? prediction.value.token : 0);
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
        if (!contacts.length) { resetReflection(); endPrediction(); }
        else reflect(event.allTouches.filter(touch => !changedIds.includes(touch.id)));
        scheduleOnRN(sendTouchFrame, contacts, generation, false, contacts.length === 0, contacts.length === 0 && segmented.value,prediction.value.waiting ? prediction.value.token : 0);
        if (contacts.length === 0) sequenceActive.value = false;
      })
      .onTouchesCancelled(() => {
        'worklet';
        resetReflection();
        zoomOwns.value = false; initialSpan.value = 0;
        endPrediction();
        if (!sequenceActive.value) return;
        sequenceGeneration.value += 1;
        sequenceActive.value = false;
        activeContacts.value = [];
        scheduleOnRN(sendTouchFrame, [], sequenceGeneration.value, false, false, true,prediction.value.waiting ? prediction.value.token : 0);
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
        const bounds = previewPanBounds({ width: Math.max(1,width.value-viewportInsetLeft-viewportInsetRight), height: Math.max(1, height.value - viewportInsetTop - viewportBottom.value) }, nextScale);
        previewOffsetX.value = Math.min(bounds.x, Math.max(-bounds.x, previewOffsetX.value));
        previewOffsetY.value = Math.min(bounds.y, Math.max(-bounds.y, previewOffsetY.value));
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
          { width: Math.max(1,width.value-viewportInsetLeft-viewportInsetRight), height: Math.max(1, height.value - viewportInsetTop - viewportBottom.value) }, previewScale.value);
        previewOffsetX.value = next.x;
        previewOffsetY.value = next.y;
      });
    return Gesture.Simultaneous(forward, pinch, pan);
  }, [connection, dismissKeyboard, pointerGeometry, pointerGeometryEpoch, preview, mode, gain, disabled, predictionContract, videoSize?.width, videoSize?.height, viewportInsetBottom, viewportInsetTop, viewportInsetLeft, viewportInsetRight, viewportBottom, glassPointer]);

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
      <Animated.View pointerEvents="none" style={viewportStyle}>
        <Animated.View pointerEvents="none" style={[{ position: 'absolute', inset: 0 }, previewStyle]}>{children}</Animated.View>
      </Animated.View>
      {preview && !!bitmap?.image && <Animated.View pointerEvents="none" style={[viewportStyle, { zIndex: 2 }]}>
        <Animated.View style={[{position:'absolute',width:cursorWidth,height:cursorHeight},cursorStyle]}>
          <Image accessible={false} fadeDuration={0} source={{uri:bitmap.image,width:bitmap.w,height:bitmap.h}} resizeMode="contain" style={{width:cursorWidth,height:cursorHeight}} />
        </Animated.View>
      </Animated.View>}
    </View>
  </GestureDetector>;
}
