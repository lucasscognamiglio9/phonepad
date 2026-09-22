/** Shared native controls. GlassSurface owns material and accessibility fallback. */
export const appearance = {
  color: { background: '#090b0e', surface: '#24262b', text: '#f4f5f7', secondary: '#b7bbc4', success: '#70dbab', warning: '#ffd7a6' },
  control: { size: 44, iconSize: 22, sendIconSize: 32, capsuleRadius: 28, menuRadius: 24, gap: 8, margin: 12, menuWidth: 280 },
} as const;
