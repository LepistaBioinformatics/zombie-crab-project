import Image from "next/image";
import Box from "@mui/material/Box";

// Two images, toggled purely by the `prefers-color-scheme` media query (no
// JS, no flash) -- same mechanism the MUI theme itself uses
// (cssVariables.colorSchemeSelector: "media", see lib/theme.ts).
export default function Logo({ size = 32 }: { size?: number }) {
  return (
    <>
      <Box sx={{ "@media (prefers-color-scheme: dark)": { display: "none" } }}>
        <Image src="/logo-light.jpg" alt="zombie-crab" width={size} height={size} style={{ borderRadius: size / 4 }} />
      </Box>
      <Box
        sx={{
          display: "none",
          "@media (prefers-color-scheme: dark)": { display: "block" },
        }}
      >
        <Image
          src="/logo-dark.jpg"
          alt="zombie-crab"
          width={size}
          height={size}
          style={{ borderRadius: size / 4 }}
        />
      </Box>
    </>
  );
}
