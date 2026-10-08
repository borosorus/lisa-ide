/**
 * The single source of truth for color. Every surface, text tier, border,
 * status, and port color lives here; the MUI theme, the CSS custom
 * properties consumed by styles.css, the CodeMirror theme, and the React
 * Flow canvas are all derived from these values. Nothing else should
 * hardcode a hex.
 *
 * Contrast contract (WCAG 2.1, computed against the surfaces above):
 * - text tiers reach >=4.5:1 on every surface they are used on;
 * - `faint` is reserved for disabled text and large labels (>=3:1), never
 *   for body copy;
 * - borders on interactive controls and the canvas grid reach >=3:1;
 * - port fills, which encode a type, reach >=3:1 against both the canvas
 *   and the node cards.
 */
export const tokens = {
  surface: {
    background: '#0b1220',
    paper: '#172236',
    sunken: '#101827',
    raised: '#1d2a40',
    /** Slightly lifted paper for hover/selected fills. */
    hover: 'rgba(142, 189, 255, 0.06)',
  },
  border: {
    /** Decorative separators; not load-bearing for meaning. */
    subtle: '#26354c',
    /** Outlines of interactive things: inputs, cards, ports, the grid. */
    strong: '#5d7499',
  },
  text: {
    primary: '#e9f0fa',
    secondary: '#b6c7de',
    muted: '#93a8c6',
    /** Disabled text and large uppercase labels only. */
    faint: '#7188a6',
  },
  accent: {
    primary: '#8ebdff',
    /** `primary` as an RGB triple, for CSS colors that need an alpha. */
    primaryRgb: '142, 189, 255',
    /** Dark ink for text/icons sitting on a filled primary surface. */
    onPrimary: '#08101f',
    /** Primary at low alpha — focus/selection glows. */
    glow: 'rgba(142, 189, 255, 0.35)',
  },
  status: {
    success: '#84dca9',
    warning: '#f6c177',
    /** As an RGB triple for CSS tints (see `primaryRgb`). */
    warningRgb: '246, 193, 119',
    danger: '#ff9d97',
    dangerRgb: '255, 157, 151',
  },
  /** Port fills double as the type legend: value/address/bool/condition. */
  port: {
    value: '#8ebdff',
    address: '#9fd89f',
    bool: '#ff9d97',
    condition: '#f6c177',
    blocked: '#5d7499',
  },
  edge: {
    idle: '#647ba1',
    selected: '#8ebdff',
  },
} as const;

/** `--lisa-*` custom properties, so plain CSS sees the same palette. */
export const cssVars: Record<string, string> = {
  '--lisa-bg': tokens.surface.background,
  '--lisa-paper': tokens.surface.paper,
  '--lisa-sunken': tokens.surface.sunken,
  '--lisa-raised': tokens.surface.raised,
  '--lisa-hover': tokens.surface.hover,
  '--lisa-border': tokens.border.subtle,
  '--lisa-border-strong': tokens.border.strong,
  '--lisa-text': tokens.text.primary,
  '--lisa-text-secondary': tokens.text.secondary,
  '--lisa-text-muted': tokens.text.muted,
  '--lisa-text-faint': tokens.text.faint,
  '--lisa-primary': tokens.accent.primary,
  '--lisa-primary-rgb': tokens.accent.primaryRgb,
  '--lisa-on-primary': tokens.accent.onPrimary,
  '--lisa-glow': tokens.accent.glow,
  '--lisa-success': tokens.status.success,
  '--lisa-warning': tokens.status.warning,
  '--lisa-warning-rgb': tokens.status.warningRgb,
  '--lisa-danger': tokens.status.danger,
  '--lisa-danger-rgb': tokens.status.dangerRgb,
  '--lisa-port-value': tokens.port.value,
  '--lisa-port-address': tokens.port.address,
  '--lisa-port-bool': tokens.port.bool,
  '--lisa-port-condition': tokens.port.condition,
  '--lisa-port-blocked': tokens.port.blocked,
  '--lisa-edge': tokens.edge.idle,
  '--lisa-edge-selected': tokens.edge.selected,
};
