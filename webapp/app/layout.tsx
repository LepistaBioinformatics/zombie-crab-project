import type { Metadata } from "next";
import { Roboto } from "next/font/google";
import Providers from "./providers";

// Roboto is Material Design's own typeface -- without it, MUI's Material
// Design theme falls back to a generic system sans-serif and reads as
// "some component library," not distinctly Google's Material UI, even
// though the underlying MUI components/classes are correct. Self-hosted via
// next/font (no external Google Fonts request at runtime).
const roboto = Roboto({
  weight: ["300", "400", "500", "700"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-roboto",
});

export const metadata: Metadata = {
  title: "zombie-crab chat",
  description: "Test client for the zombie-crab-project picoclaw stack",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={roboto.variable}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
