import { createTheme } from "@mui/material/styles";

// Lepista Bioinformatics Lab design system (https://lepista.com.br/design-system.md):
// zombie-crab sits under "Infrastructure / Mycelium" (it's a Mycelium-gated
// gateway product), so its accent is the infra cyan, not the lab-wide brand
// violet -- that violet is reserved for structural borders (brand-600),
// same role it plays across every other Lepista product.
//
// "Delicate neobrutalism": flat solid surfaces (no elevation shadows), 1px
// violet borders, ~8px rounding, and a signature hard-offset shadow in the
// accent color with no blur -- MuiButton/MuiPaper/MuiTextField overrides
// below exist to replace MUI's own Material Design defaults (soft
// elevation, borderless fields, no offset shadow) with that language.
const INFRA_ACCENT = "#64C5EB";
const INFRA_ACCENT_SOFT = "#9AD9F0"; // signature-shadow tint ("accent-400")
const BRAND_BORDER = "#663a88"; // brand-600, the lab-wide structural violet

const hardShadow = (color: string, offset = 4) => `${offset}px ${offset}px 0 0 ${color}`;

// The signature hard-offset shadow + hover-lift is reserved for the one
// screen outside the dashboard shell (signin) -- NOT applied to the
// dashboard itself (sidebar chrome included), where it's too much
// motion/depth stacked across a screen people sit in constantly. Opt in
// explicitly via `sx={signatureShadowSx}` (interactive elements) or
// `signatureShadow` (a static surface, e.g. a card) where it belongs.
export const signatureShadow = hardShadow(INFRA_ACCENT_SOFT);

export const signatureShadowSx = {
  boxShadow: hardShadow(INFRA_ACCENT_SOFT),
  transition: "transform 120ms ease, box-shadow 120ms ease",
  "&:hover": {
    transform: "translate(-2px, -2px)",
    boxShadow: hardShadow(INFRA_ACCENT_SOFT, 6),
  },
  "&:active": {
    transform: "translate(0, 0)",
    boxShadow: hardShadow(INFRA_ACCENT_SOFT, 2),
  },
} as const;

const theme = createTheme({
  cssVariables: { colorSchemeSelector: "media" },
  colorSchemes: {
    light: {
      palette: {
        primary: { main: INFRA_ACCENT, contrastText: "#0a2933" },
        background: { default: "#ffffff", paper: "#ffffff" },
        divider: BRAND_BORDER,
      },
    },
    dark: {
      // Not specified by the design system (no dark-mode guidance) --
      // same structure (flat surfaces, violet border, cyan accent), darkened
      // neutrals so it doesn't just invert into a generic MUI dark theme.
      palette: {
        primary: { main: INFRA_ACCENT, contrastText: "#0a2933" },
        background: { default: "#14171a", paper: "#1b1f23" },
        divider: "#a988c9",
      },
    },
  },
  typography: {
    fontFamily: "var(--font-sans), Hanken Grotesk, Helvetica, Arial, sans-serif",
    h1: { fontFamily: "var(--font-display), Bricolage Grotesque, sans-serif" },
    h2: { fontFamily: "var(--font-display), Bricolage Grotesque, sans-serif" },
    h3: { fontFamily: "var(--font-display), Bricolage Grotesque, sans-serif" },
    h4: { fontFamily: "var(--font-display), Bricolage Grotesque, sans-serif" },
    h5: { fontFamily: "var(--font-display), Bricolage Grotesque, sans-serif", fontWeight: 700 },
    h6: { fontFamily: "var(--font-display), Bricolage Grotesque, sans-serif", fontWeight: 700 },
  },
  shape: {
    borderRadius: 8,
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: "none",
          fontWeight: 600,
        },
        // Structural border only here -- that's lab-wide (applies
        // everywhere, content screens included). The signature shadow/lift
        // is opt-in (signatureShadowSx), used for nav chrome only.
        contained: {
          border: `1px solid ${BRAND_BORDER}`,
        },
        outlined: {
          borderWidth: 1,
          borderColor: BRAND_BORDER,
          "&:hover": { borderWidth: 1, borderColor: BRAND_BORDER },
        },
      },
    },
    MuiTextField: {
      defaultProps: {
        variant: "outlined",
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          "& fieldset": { borderColor: BRAND_BORDER },
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
        },
        rounded: {
          borderRadius: 8,
        },
        outlined: {
          borderColor: BRAND_BORDER,
        },
      },
      defaultProps: {
        elevation: 0,
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: 8,
        },
      },
    },
  },
});

export default theme;
