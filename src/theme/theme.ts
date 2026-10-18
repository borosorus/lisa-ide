import { createTheme } from '@mui/material/styles';
import { cssVars, tokens } from './tokens';

export { cssVars, tokens };

/** One light palette shared by MUI, CSS, the editor, and the canvas. */
export const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: tokens.accent.primary, contrastText: tokens.accent.onPrimary },
    secondary: { main: tokens.accent.secondary, contrastText: tokens.accent.onSecondary },
    success: { main: tokens.status.success, contrastText: tokens.text.inverse },
    warning: { main: tokens.status.warning, contrastText: tokens.text.inverse },
    error: { main: tokens.status.danger, contrastText: tokens.text.inverse },
    info: { main: tokens.status.info, contrastText: tokens.text.inverse },
    background: { default: tokens.surface.background, paper: tokens.surface.paper },
    text: { primary: tokens.text.primary, secondary: tokens.text.secondary },
    divider: tokens.border.subtle,
    action: {
      hover: tokens.surface.hover,
      selected: tokens.accent.selected,
      focus: tokens.accent.selectedHover,
      disabled: tokens.text.faint,
      disabledBackground: tokens.surface.disabled,
    },
  },
  typography: {
    fontFamily: 'Inter, system-ui, sans-serif',
    h5: { letterSpacing: '0.01em' },
    overline: { letterSpacing: '0.12em' },
    button: { fontWeight: 650, textTransform: 'none' },
  },
  shape: { borderRadius: 10 },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        'html, body': { colorScheme: 'light' },
      },
    },
    MuiPaper: {
      styleOverrides: {
        outlined: { borderColor: tokens.border.subtle },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          boxShadow: 'none',
          '&:hover': { boxShadow: 'none' },
          '&:focus-visible': { outline: `2px solid ${tokens.accent.secondary}`, outlineOffset: 2 },
          '&.Mui-disabled': { color: tokens.text.faint },
        },
        outlined: {
          borderColor: tokens.border.strong,
          '&:hover': { borderColor: tokens.accent.primary, backgroundColor: tokens.surface.hover },
        },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: { '&:focus-visible': { outline: `2px solid ${tokens.accent.secondary}`, outlineOffset: 1 } },
      },
    },
    MuiToggleButton: {
      styleOverrides: {
        root: {
          color: tokens.text.secondary,
          borderColor: tokens.border.subtle,
          textTransform: 'none',
          '&.Mui-selected': {
            color: tokens.accent.primary,
            backgroundColor: tokens.accent.selected,
            fontWeight: 700,
          },
          '&.Mui-selected:hover': { backgroundColor: tokens.accent.selectedHover },
        },
      },
    },
    MuiTabs: {
      styleOverrides: { indicator: { height: 3, borderRadius: 3, backgroundColor: tokens.accent.primary } },
    },
    MuiTab: {
      styleOverrides: {
        root: { color: tokens.text.secondary, '&.Mui-selected': { color: tokens.accent.primary, fontWeight: 700 } },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: { fontWeight: 600 },
        outlined: { borderColor: tokens.border.strong },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          backgroundColor: tokens.surface.paper,
          '& .MuiOutlinedInput-notchedOutline': { borderColor: tokens.border.strong },
          '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: tokens.accent.primary },
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: { border: `1px solid ${tokens.border.subtle}`, boxShadow: `0 18px 56px rgba(${tokens.text.primaryRgb}, 0.18)` },
      },
    },
    MuiTooltip: {
      defaultProps: { enterDelay: 300 },
      styleOverrides: {
        tooltip: { backgroundColor: tokens.surface.tooltip, color: tokens.text.inverse, fontSize: '0.75rem' },
        arrow: { color: tokens.surface.tooltip },
      },
    },
  },
});

/** GlobalStyles payload that publishes the palette as CSS custom properties. */
export const cssVarStyles = { ':root': cssVars };
