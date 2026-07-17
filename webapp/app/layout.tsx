import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Hanken_Grotesk, Space_Mono } from "next/font/google";
import { getAppName, DEFAULT_APP_NAME } from "@/lib/db";
import SwRegister from "./sw-register";
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

// Title is dynamic so a rebrand flows into the document title and the PWA
// (generateMetadata reads the branding name server-side). The rest of the head
// wiring -- manifest link, apple-touch-icon, apple-mobile-web-app metas -- is
// static and points at the branding endpoints.
export async function generateMetadata(): Promise<Metadata> {
  // The DB is unreachable during build-time prerender (the build container has
  // no Postgres); fall back to the default so static pages like /signin export.
  // At runtime the query succeeds and a rebrand flows into the title.
  let appName = DEFAULT_APP_NAME;
  try {
    appName = await getAppName();
  } catch {
    // keep the default
  }
  return {
    title: `${appName} chat`,
    description: "Test client for the zombie-crab-project picoclaw stack",
    manifest: "/manifest.webmanifest",
    appleWebApp: {
      capable: true,
      statusBarStyle: "default",
      title: appName,
    },
    icons: {
      apple: "/api/branding/logo/light",
    },
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#14171a" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body className="bg-bg text-fg font-sans antialiased">
        {children}
        <SwRegister />
      </body>
    </html>
  );
}
