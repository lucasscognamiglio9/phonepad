export const PREVIEW_ZOOM_MIN = 1;
export const PREVIEW_ZOOM_MAX = 4;

export type PreviewViewport = { width: number; height: number };
export type PreviewPan = { x: number; y: number };

function finite(value: number, fallback: number) {
  'worklet';
  return Number.isFinite(value) ? value : fallback;
}

export function clampPreviewScale(value: number): number {
  'worklet';
  const scale = finite(value, PREVIEW_ZOOM_MIN);
  return Math.min(PREVIEW_ZOOM_MAX, Math.max(PREVIEW_ZOOM_MIN, scale));
}

export function previewPanBounds(viewport: PreviewViewport, scale: number): PreviewPan {
  'worklet';
  const width = Math.max(0, finite(viewport.width, 0));
  const height = Math.max(0, finite(viewport.height, 0));
  const boundedScale = clampPreviewScale(scale);
  return {
    x: Math.max(0, width * (boundedScale - 1) / 2),
    y: Math.max(0, height * (boundedScale - 1) / 2),
  };
}

export function clampPreviewPan(pan: PreviewPan, viewport: PreviewViewport, scale: number): PreviewPan {
  'worklet';
  const bounds = previewPanBounds(viewport, scale);
  const x = finite(pan.x, 0);
  const y = finite(pan.y, 0);
  return {
    x: bounds.x === 0 ? 0 : Math.min(bounds.x, Math.max(-bounds.x, x)),
    y: bounds.y === 0 ? 0 : Math.min(bounds.y, Math.max(-bounds.y, y)),
  };
}
