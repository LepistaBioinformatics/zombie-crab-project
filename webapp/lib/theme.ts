import { createTheme } from "@mui/material/styles";

// CSS theme variables (MUI v6): "media" (the default, made explicit here)
// switches light/dark purely via the `prefers-color-scheme` media query,
// applied by the browser before React hydrates -- no useMediaQuery/JS
// toggle, no manual switcher, no SSR/client mismatch flash. Follows the
// user's OS setting automatically.
//
// Typography/shape/button overrides below exist because MUI's own defaults
// (system-font fallback, 4px corners, uppercase buttons) are MUI's legacy
// Material Design 2 baseline -- correct components, but doesn't visually
// read as Google's current Material Design without these: Roboto (MD's own
// typeface, loaded in app/layout.tsx), larger corner radii, sentence-case
// pill-shaped buttons (MD3 dropped MD2's all-caps button label).
const theme = createTheme({
  cssVariables: { colorSchemeSelector: "media" },
  colorSchemes: {
    light: { palette: { primary: { main: "#2b6cb0" } } },
    dark: { palette: { primary: { main: "#63b3ed" } } },
  },
  typography: {
    fontFamily: "var(--font-roboto), Roboto, Helvetica, Arial, sans-serif",
  },
  shape: {
    borderRadius: 12,
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: "none",
          borderRadius: 999,
          paddingLeft: 24,
          paddingRight: 24,
        },
      },
    },
    MuiTextField: {
      defaultProps: {
        variant: "outlined",
      },
    },
    MuiPaper: {
      styleOverrides: {
        rounded: {
          borderRadius: 16,
        },
      },
    },
  },
});

export default theme;
