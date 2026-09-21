export const MIN_TOUCH_TARGET = 44;
export const COMPOSER_CLOSED_MARGIN = 12;
export const COMPOSER_OPEN_GAP = 8;

function finite(value: number, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

export function keyboardWindowResize(
  preKeyboardHeight: number,
  viewportHeight: number,
  keyboardVisible: boolean,
) {
  if (!keyboardVisible) return 0;
  return Math.max(0, finite(preKeyboardHeight) - Math.max(0, finite(viewportHeight)));
}

export function keyboardOverlap(keyboardHeight: number, viewportHeight: number, windowResize = 0) {
  const height = Math.max(0, finite(keyboardHeight));
  const viewport = Math.max(0, finite(viewportHeight));
  const resize = Math.min(height, Math.max(0, finite(windowResize)));
  return Math.min(Math.max(0, height - resize), viewport);
}

export function keyboardStickyOpenedOffset(windowResize: number, closedBottom: number, openGap = COMPOSER_OPEN_GAP) {
  return Math.max(0, Math.max(0, finite(windowResize)) + Math.max(0, finite(closedBottom)) - Math.max(0, finite(openGap)));
}

export function keyboardAvailableHeight({
  viewportHeight,
  safeAreaTop,
  keyboardHeight,
  closedBottomInset,
  openGap = COMPOSER_OPEN_GAP,
  windowResize = 0,
}: {
  viewportHeight: number;
  safeAreaTop: number;
  keyboardHeight: number;
  closedBottomInset: number;
  openGap?: number;
  windowResize?: number;
}) {
  const viewport = Math.max(0, finite(viewportHeight));
  const top = Math.max(0, finite(safeAreaTop));
  const overlap = keyboardOverlap(keyboardHeight, viewport, windowResize);
  const bottom = overlap > 0
    ? viewport - overlap - Math.max(0, finite(openGap))
    : viewport - Math.max(0, finite(closedBottomInset));
  return Math.max(0, bottom - top);
}

export function editorMaxHeight(availableHeight: number, actionBarHeight: number) {
  const available = Math.max(0, finite(availableHeight));
  const actionBar = Math.max(MIN_TOUCH_TARGET, finite(actionBarHeight));
  return Math.max(MIN_TOUCH_TARGET, available - actionBar - COMPOSER_OPEN_GAP);
}

export function extrasMaxHeight(availableHeight: number, editorHeight: number, actionBarHeight: number) {
  const available = Math.max(0, finite(availableHeight));
  const editor = Math.max(MIN_TOUCH_TARGET, finite(editorHeight));
  const actionBar = Math.max(MIN_TOUCH_TARGET, finite(actionBarHeight));
  return Math.max(0, available - editor - actionBar - COMPOSER_OPEN_GAP);
}
