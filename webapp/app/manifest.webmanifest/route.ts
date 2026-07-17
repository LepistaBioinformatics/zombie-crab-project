import { NextResponse } from "next/server";
import { getAppName } from "@/lib/db";

// Force-dynamic: this GET takes no request arg and would otherwise be cached /
// prerendered at build (running a DB query at build time). The manifest must
// reflect the live branding app name, so always run per-request.
export const dynamic = "force-dynamic";

// Dynamic PWA manifest. name/short_name follow the branding app name; the icons
// point at the branding light-logo endpoint (served as-is, both sizes reuse it
// since there is no image processing). Colors are the app's dark surface (--bg)
// and structural violet (--brand) from globals.css.
export async function GET() {
  const appName = await getAppName();
  const manifest = {
    name: appName,
    short_name: appName,
    display: "standalone",
    start_url: "/chat",
    scope: "/",
    theme_color: "#663a88",
    background_color: "#14171a",
    icons: [
      {
        src: "/api/branding/logo/light",
        sizes: "192x192",
        purpose: "any maskable",
      },
      {
        src: "/api/branding/logo/light",
        sizes: "512x512",
        purpose: "any maskable",
      },
    ],
  };
  return NextResponse.json(manifest, {
    headers: { "content-type": "application/manifest+json" },
  });
}
