import { appearance } from './appearance';
export const MIN_TOUCH_TARGET = appearance.control.size;
export const COMPOSER_CLOSED_MARGIN = appearance.control.margin;
export const COMPOSER_OPEN_GAP = appearance.control.gap;

/** Preserve the unoccluded window across a rotation with the keyboard up. */
export class KeyboardViewport {
  private width: number;
  private fullHeight: number;
  private systemInset: number;
  constructor(width: number, height: number, screenHeight: number) {
    this.width = width; this.fullHeight = height;
    this.systemInset = Math.max(0, screenHeight - height);
  }
  resize(width: number, height: number, screenHeight: number, editing: boolean) {
    if (width !== this.width) {
      this.width = width;
      this.fullHeight = editing ? Math.max(height, screenHeight - this.systemInset) : height;
    }
    if (!editing) {
      this.fullHeight = height;
      this.systemInset = Math.max(0, screenHeight - height);
    }
    return editing ? Math.max(0, this.fullHeight - height) : 0;
  }
}

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

/** Grow the same native editor; never swap it on focus or expansion. */
export function composerTextHeight(contentHeight: number, availableHeight: number, active: boolean, expanded: boolean, toolbar: boolean) {
  const toolbarHeight = toolbar ? appearance.composer.toolbarHeight + appearance.shortcuts.padding * 2 + appearance.composer.toolbarGap : 0;
  const budget = editorMaxHeight(availableHeight - toolbarHeight - appearance.composer.padding * 2,
    MIN_TOUCH_TARGET);
  const minimum = Math.max(MIN_TOUCH_TARGET, active ? appearance.text.bodyLineHeight * appearance.composer.focusedLines + appearance.composer.textPadding * 2 : MIN_TOUCH_TARGET);
  const natural = Math.max(minimum, finite(contentHeight, minimum));
  const compactLimit = appearance.text.bodyLineHeight * appearance.composer.collapsedLines + appearance.composer.textPadding * 2;
  return Math.min(budget, expanded ? budget : Math.min(natural, compactLimit));
}

export function extrasMaxHeight(availableHeight: number, editorHeight: number, actionBarHeight: number) {
  const available = Math.max(0, finite(availableHeight));
  const editor = Math.max(MIN_TOUCH_TARGET, finite(editorHeight));
  const actionBar = Math.max(MIN_TOUCH_TARGET, finite(actionBarHeight));
  return Math.max(0, available - editor - actionBar - COMPOSER_OPEN_GAP);
}
