import { createTheme } from '@mui/material/styles';
import { cssVars, tokens } from './tokens';

export { cssVars, tokens };

/**
 * The app theme. The palette is the token module's, so MUI components,
 * plain CSS (via the custom properties in `cssVars`), CodeMirror, and the
 * canvas all resolve the same colors from one place.
 */
export const theme = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: tokens.accent.primary, contrastText: tokens.accent.onPrimary },
    success: { main: tokens.status.success },
    warning: { main: tokens.status.warning },
    error: { main: tokens.status.danger },
    background: { default: tokens.surface.background, paper: tokens.surface.paper },
    text: { primary: tokens.text.primary, secondary: tokens.text.secondary },
    divider: tokens.border.subtle,
  },
  typography: {
    fontFamily: 'Inter, system-ui, sans-serif',
    h5: { letterSpacing: '0.01em' },
    overline: { letterSpacing: '0.12em' },
  },
  shape: { borderRadius: 10 },
  components: {
    MuiChip: { styleOverrides: { root: { fontWeight: 600 } } },
    MuiTooltip: { defaultProps: { enterDelay: 300 } },
  },
});

/** GlobalStyles payload that publishes the palette as CSS custom properties. */
export const cssVarStyles = { ':root': cssVars };
