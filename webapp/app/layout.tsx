import type { Metadata } from "next";
import { Bricolage_Grotesque, Hanken_Grotesk, Space_Mono } from "next/font/google";
import "./globals.css";

// Lepista Bioinformatics Lab design system typography
// (https://lepista.com.br/design-system.md): display / body / mono, each
// self-hosted via next/font. Exposed as --ff-* CSS variables and wired into
// Tailwind's font-{display,sans,mono} utilities in globals.css.
const display = Bricolage_Grotesque({
  weight: ["500", "600", "700"],
  subsets: ["latin"],
  display: "swap",
  variable: "--ff-display",
});

const sans = Hanken_Grotesk({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  display: "swap",
  variable: "--ff-sans",
});

const mono = Space_Mono({
  weight: ["400", "700"],
  subsets: ["latin"],
  display: "swap",
  variable: "--ff-mono",
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
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body className="bg-bg text-fg font-sans antialiased">{children}</body>
    </html>
  );
}
