/**
 * The single source of color. MUI, CSS, CodeMirror, React Flow, and wallet
 * onboarding all draw from these roles so the bright workbench stays coherent.
 *
 * Contrast contract (WCAG 2.1, computed against the surfaces above):
 * - body text and syntax colors reach >=4.5:1 on their working surfaces;
 * - `faint` is reserved for disabled text and large labels (>=3:1);
 * - interactive outlines and the canvas grid reach >=3:1;
 * - port fills, which encode a type, reach >=3:1 against cards and canvas.
 */
export const tokens = {
  surface: {
    background: '#E9F0ED',
    paper: '#FAFCFB',
    sunken: '#E3EBE8',
    raised: '#F0F5F3',
    disabled: '#DCE5E2',
    tooltip: '#1C3036',
    /** Slightly lifted paper for hover and selected fills. */
    hover: 'rgba(8, 115, 111, 0.08)',
  },
  border: {
    /** Decorative separators; not load-bearing for meaning. */
    subtle: '#CBD8D4',
    /** Outlines of interactive things and the canvas grid. */
    strong: '#70827F',
  },
  text: {
    primary: '#1C3036',
    primaryRgb: '28, 48, 54',
    inverse: '#FFFFFF',
    secondary: '#435960',
    muted: '#526970',
    /** Disabled text and large uppercase labels only. */
    faint: '#74878B',
  },
  accent: {
    primary: '#08736F',
    primaryRgb: '8, 115, 111',
    onPrimary: '#FFFFFF',
    /** Secondary ocean-blue action and information accent. */
    secondary: '#166DA8',
    secondaryRgb: '22, 109, 168',
    onSecondary: '#FFFFFF',
    glow: 'rgba(8, 115, 111, 0.22)',
    selected: 'rgba(8, 115, 111, 0.12)',
    selectedHover: 'rgba(8, 115, 111, 0.18)',
  },
  status: {
    success: '#267747',
    warning: '#855400',
    warningRgb: '133, 84, 0',
    danger: '#B3423B',
    dangerRgb: '179, 66, 59',
    info: '#166DA8',
  },
  /** Syntax roles meet AA against the editor surface. */
  syntax: {
    keyword: '#135B92',
    comment: '#4D6268',
    string: '#216B3B',
    number: '#825400',
    type: '#00645F',
    bool: '#A23D36',
    function: '#066A65',
    punctuation: '#4D6268',
  },
  /** Port fills double as the type legend: value/address/bool/condition. */
  port: {
    value: '#1875B8',
    address: '#267747',
    bool: '#B3423B',
    condition: '#825400',
    blocked: '#71888C',
  },
  edge: {
    idle: '#71888C',
    selected: '#08736F',
  },
  canvas: {
    grid: '#718784',
  },
} as const;

/** `--lisa-*` custom properties, so plain CSS sees the same palette. */
export const cssVars: Record<string, string> = {
  '--lisa-bg': tokens.surface.background,
  '--lisa-paper': tokens.surface.paper,
  '--lisa-sunken': tokens.surface.sunken,
  '--lisa-raised': tokens.surface.raised,
  '--lisa-disabled': tokens.surface.disabled,
  '--lisa-tooltip': tokens.surface.tooltip,
  '--lisa-hover': tokens.surface.hover,
  '--lisa-border': tokens.border.subtle,
  '--lisa-border-strong': tokens.border.strong,
  '--lisa-text': tokens.text.primary,
  '--lisa-text-rgb': tokens.text.primaryRgb,
  '--lisa-text-secondary': tokens.text.secondary,
  '--lisa-text-muted': tokens.text.muted,
  '--lisa-text-faint': tokens.text.faint,
  '--lisa-text-inverse': tokens.text.inverse,
  '--lisa-primary': tokens.accent.primary,
  '--lisa-primary-rgb': tokens.accent.primaryRgb,
  '--lisa-on-primary': tokens.accent.onPrimary,
  '--lisa-secondary': tokens.accent.secondary,
  '--lisa-secondary-rgb': tokens.accent.secondaryRgb,
  '--lisa-on-secondary': tokens.accent.onSecondary,
  '--lisa-glow': tokens.accent.glow,
  '--lisa-selected': tokens.accent.selected,
  '--lisa-selected-hover': tokens.accent.selectedHover,
  '--lisa-success': tokens.status.success,
  '--lisa-warning': tokens.status.warning,
  '--lisa-warning-rgb': tokens.status.warningRgb,
  '--lisa-danger': tokens.status.danger,
  '--lisa-danger-rgb': tokens.status.dangerRgb,
  '--lisa-info': tokens.status.info,
  '--lisa-port-value': tokens.port.value,
  '--lisa-port-address': tokens.port.address,
  '--lisa-port-bool': tokens.port.bool,
  '--lisa-port-condition': tokens.port.condition,
  '--lisa-port-blocked': tokens.port.blocked,
  '--lisa-edge': tokens.edge.idle,
  '--lisa-edge-selected': tokens.edge.selected,
  '--lisa-canvas-grid': tokens.canvas.grid,
};
