/** Shared native controls. GlassSurface owns material and accessibility fallback. */
export const appearance = {
  color: { background: '#0a0a0a', surface: 'transparent', text: '#f5f5f5', secondary: '#ababab', pressed: 'transparent', success: '#70dbab', warning: '#ffd7a6', border: '#ffffff24' },
  glass: { edgeWidth: 1, edgeBase: 'rgba(255,255,255,0.09)', fallback: 'rgba(12,12,14,0.14)', accessibleFill: '#242424', restX: .5, restY: .78, followDuration: 90, settleDuration: 710 },
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
  text: { title: 24, heading: 17, body: 15, caption: 13, compact: 12, bodyLineHeight: 22, captionLineHeight: 18 },
  control: { size: 44, menuRowHeight: 52, iconSize: 22, sendIconSize: 32, capsuleRadius: 28, menuRadius: 24, gap: 8, margin: 12, menuWidth: 280, floatingMaterial: 'clear' },
  weight: { regular: '400', label: '500', strong: '600' },
  state: { pressed: .7, disabled: .4, muted: .3 },
  motion: { popupScale: .94, popupDuration: 180, composerDuration: 220 },
  launch: { logoSize: 192, background: '#080b0e', holdDuration: 1000, exitDuration: 320, fadeDuration: 160 },
  status: { size: 6, radius: 3 },
  notice: { fontSize: 13, lineHeight: 18, maxLines: 2, swipeStart: 12, swipeDismiss: 40 },
  slider: { min: 50, max: 150, hapticInterval: 25 },
  shortcuts: { gap: 4, padding: 4, iconSize: 18, textStyle: 'footnote', swipeDistance: 24, directionThreshold: 12 },
  composer: { padding: 4, textPadding: 8, collapsedLines: 4, focusedLines: 1, toolbarHeight: 44, toolbarGap: 8, landscapeFraction: .5 },
  transfer: { thumbnailSize: 48, maxVisibleFiles: 3, viewportFraction: .42, toastDuration: 5000 },
} as const;
