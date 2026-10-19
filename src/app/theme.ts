import { createTheme, type PaletteOptions, type Theme } from '@mui/material/styles'

/**
 * Application theme: the design foundation every screen builds on.
 *
 * Direction: a calm, border-based Minimalism / Swiss style for a professional
 * planning tool (see the UI redesign analysis). The existing dark-green primary
 * and brown secondary are kept; semantic colours, the full typography scale,
 * shape, and a few safe component defaults are made explicit here so screens
 * do not have to repeat them in `sx`.
 *
 * Boundaries this file deliberately respects:
 *
 * - `Typography.variantMapping` is untouched: a `variant="h3"` still renders an
 *   `<h3>`, so heading semantics never change from the theme alone.
 * - The theme changes visual tokens (type scale, radius, borders, Accordion
 *   gutters, Card variant) but never DOM structure or page-level layout:
 *   Buttons are never made full width, nothing is turned into a fixed action
 *   bar, and no default control `size` is reduced.
 * - Responsive rules follow `docs/UI_FLOW.md` 3.1: the small-screen value is the
 *   base and larger breakpoints add density.
 *
 * Light and Dark (`docs/UI_FLOW.md` 3.5) share everything except the palette:
 * typography, shape and component defaults are one definition, so switching
 * the mode changes colour tokens only and never layout or DOM structure.
 * Screens read colours through palette tokens (`background.paper`,
 * `text.secondary`, `divider`, ...) and keep no Dark style of their own.
 */

/** The user-selectable colour mode. Presentation-only; never persisted in AppSettings. */
export type ThemeMode = 'light' | 'dark'

/** System font stack: no web font is bundled or fetched. */
const fontFamily = [
  'system-ui',
  '-apple-system',
  '"Segoe UI"',
  'Roboto',
  '"Hiragino Sans"',
  '"Hiragino Kaku Gothic ProN"',
  '"Yu Gothic UI"',
  '"Noto Sans JP"',
  '"Noto Sans CJK JP"',
  'Meiryo',
  'sans-serif',
].join(', ')

const headingLineHeight = 1.35
const bodyLineHeight = 1.6

/** Breakpoint helpers from a default theme, usable before any app theme exists. */
const { breakpoints } = createTheme()

/**
 * Body text is 16px on small screens so iOS Safari does not zoom focused
 * inputs, and 15px from `md` up where the denser desktop layout benefits from
 * it. The media query lives inside `body1` itself, so `InputBase`,
 * `InputLabel` and the `CssBaseline` body, which all spread `body1`, follow it
 * without separate overrides.
 */
const body1 = {
  fontSize: '1rem',
  lineHeight: bodyLineHeight,
  [breakpoints.up('md')]: { fontSize: '0.9375rem' },
}

/**
 * The Light palette: the calm dark-green primary and brown secondary on a
 * warm off-white page, unchanged from before Dark was added.
 */
const lightPalette: PaletteOptions = {
  mode: 'light',
  primary: {
    main: '#394f46',
    light: '#5f7a6f',
    dark: '#263831',
    contrastText: '#ffffff',
  },
  secondary: {
    main: '#8a5a33',
    light: '#a67a52',
    dark: '#5e3c20',
    contrastText: '#ffffff',
  },
  success: { main: '#2e7d32' },
  warning: { main: '#a35a00', contrastText: '#ffffff' },
  error: { main: '#b3261e' },
  info: { main: '#35697a' },
  text: {
    primary: '#1c1f1d',
    secondary: '#5b615d',
  },
  divider: '#dfe2dc',
  background: { default: '#f5f5f1', paper: '#ffffff' },
}

/**
 * The Dark palette: the same brand hues as lighter, slightly desaturated
 * tonal variants on a green-tinted near-black surface, never an inversion of
 * the Light values (the Light primary `#394f46` would be unreadable on a dark
 * surface). Every text token and every semantic `main` keeps at least 4.5:1
 * against both `background.default` and `background.paper` (primary 7.6:1,
 * text.secondary 7.5:1 on paper), and the dark `contrastText` keeps a
 * contained Button label readable on the light `main`. The surfaces stay
 * border-based: outlined Paper and Card draw `divider`, not elevation shadows.
 */
const darkPalette: PaletteOptions = {
  mode: 'dark',
  primary: {
    main: '#8fb8a6',
    light: '#b1d0c2',
    dark: '#5f8a77',
    contrastText: '#10201a',
  },
  secondary: {
    main: '#d4a77e',
    light: '#e6c4a4',
    dark: '#a87b52',
    contrastText: '#2a1a0c',
  },
  success: { main: '#86c98a', contrastText: '#0f2411' },
  warning: { main: '#e6aa5c', contrastText: '#2b1a03' },
  error: { main: '#f2958c', contrastText: '#2e0b08' },
  info: { main: '#86bfd3', contrastText: '#0c232b' },
  text: {
    primary: '#e6e9e6',
    secondary: '#a9b0ab',
  },
  divider: '#343b37',
  background: { default: '#121614', paper: '#1a1f1c' },
}

const paletteByMode: Readonly<Record<ThemeMode, PaletteOptions>> = {
  light: lightPalette,
  dark: darkPalette,
}

/**
 * Builds the application theme for one colour mode. The App memoises the
 * result per mode, so a mode change replaces only the ThemeProvider value and
 * never remounts the routes below it.
 */
export function createAppTheme(mode: ThemeMode): Theme {
  return createTheme({
    /**
     * Keyboard focus ring. MUI 9 keeps this opt-in; without it a focused
     * Button, IconButton, Checkbox, Switch, Chip, MenuItem, ListItemButton or
     * AccordionSummary shows only its faint ripple, which is not a visible
     * focus indicator on a light surface. `true` applies the MUI default ring
     * (2px solid primary, 2px offset, inset automatically on clip-prone
     * components) to every focusable MUI control at once, so no screen needs
     * a `&.Mui-focusVisible` override of its own.
     */
    focusVisible: true,
    palette: paletteByMode[mode],
    shape: { borderRadius: 6 },
    typography: {
      fontFamily,
      h1: { fontSize: '1.5rem', fontWeight: 600, lineHeight: headingLineHeight },
      h2: { fontSize: '1.125rem', fontWeight: 600, lineHeight: headingLineHeight },
      h3: { fontSize: '1rem', fontWeight: 600, lineHeight: headingLineHeight },
      // The product's heading depth is h1 (page) > h2 (section) > h3 (card).
      // h4-h6 are defined for completeness and for MUI internals (DialogTitle,
      // CardHeader) as compact, label-grade headings that mirror subtitle1 /
      // subtitle2; on small screens they are not larger than body1, so a deeper
      // semantic heading should pair `component="h4"` with an h2 / h3 / subtitle
      // variant, as ProductionPlanConflictSection already does.
      h4: { fontSize: '0.9375rem', fontWeight: 600, lineHeight: headingLineHeight },
      h5: { fontSize: '0.875rem', fontWeight: 600, lineHeight: headingLineHeight },
      h6: { fontSize: '0.8125rem', fontWeight: 600, lineHeight: headingLineHeight },
      subtitle1: { fontSize: '0.9375rem', fontWeight: 600, lineHeight: 1.5 },
      subtitle2: { fontSize: '0.8125rem', fontWeight: 600, lineHeight: 1.5 },
      body1,
      body2: { fontSize: '0.8125rem', lineHeight: bodyLineHeight },
      button: { fontSize: '0.875rem', fontWeight: 600, textTransform: 'none' },
      caption: { fontSize: '0.75rem', lineHeight: 1.5 },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          // Opt-in helper for counters, positions and other aligned figures.
          '.tabular-nums': { fontVariantNumeric: 'tabular-nums' },
        },
      },
      MuiPaper: {
        styleOverrides: {
          // MUI lightens an elevated dark Paper (Dialog, Menu, Popover, the
          // temporary Drawer) with a white overlay. On this palette that
          // overlay pulls `text.secondary` below 4.5:1 inside a Dialog, so
          // Dark keeps the solid `background.paper` and separates raised
          // surfaces by a border instead, like the rest of the border-based
          // UI. Light is untouched.
          root: ({ theme, ownerState }) =>
            theme.palette.mode === 'dark' && ownerState.variant !== 'outlined' && (ownerState.elevation ?? 1) > 0
              ? { backgroundImage: 'none', border: `1px solid ${theme.palette.divider}` }
              : {},
        },
      },
      MuiButton: {
        defaultProps: { disableElevation: true },
      },
      MuiCard: {
        defaultProps: { variant: 'outlined' },
      },
      MuiChip: {
        styleOverrides: {
          label: { fontWeight: 500 },
        },
      },
      MuiAlert: {
        styleOverrides: {
          message: {
            // Hashes and IDs shown in notices must wrap instead of overflowing
            // a narrow screen.
            minWidth: 0,
            overflowWrap: 'anywhere',
          },
        },
      },
      MuiAccordion: {
        defaultProps: { disableGutters: true, elevation: 0 },
        styleOverrides: {
          root: ({ theme }) => ({
            border: `1px solid ${theme.palette.divider}`,
            '&::before': { display: 'none' },
          }),
        },
      },
      MuiDialogTitle: {
        styleOverrides: {
          // MUI's DialogTitle reuses the `h6` style, which is a minor heading
          // in this scale; a dialog title reads at section-heading size.
          root: ({ theme }) => ({ ...theme.typography.h2 }),
        },
      },
      MuiTable: {
        defaultProps: { size: 'small' },
      },
      MuiTableCell: {
        styleOverrides: {
          head: { fontWeight: 600 },
          alignRight: { fontVariantNumeric: 'tabular-nums' },
        },
      },
    },
  })
}

/** The Light theme, kept for callers (tests, the benchmark page) that need no mode. */
export const appTheme = createAppTheme('light')
