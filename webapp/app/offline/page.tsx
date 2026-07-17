import { WifiOff } from "lucide-react";
import { Surface } from "@/components/ui/surface";

// Offline fallback served by the service worker when a navigation fails. It
// relies only on precached, bundled assets (no /api/* calls) so it renders
// without the network -- the bundled logo is used directly rather than the
// branding endpoint.
export const metadata = { title: "Offline" };

export default function OfflinePage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-4">
      <Surface bordered className="flex w-[380px] flex-col items-center gap-4 p-8 text-center">
        <span className="contents [@media(prefers-color-scheme:dark)]:hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-light.jpg" alt="" width={48} height={48} style={{ borderRadius: 12 }} />
        </span>
        <span className="hidden [@media(prefers-color-scheme:dark)]:contents">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-dark.jpg" alt="" width={48} height={48} style={{ borderRadius: 12 }} />
        </span>
        <div className="flex items-center gap-2 text-fg-muted">
          <WifiOff size={18} aria-hidden />
          <h1 className="font-display text-lg font-semibold text-fg">You&apos;re offline</h1>
        </div>
        <p className="text-sm text-fg-muted">
          The app can&apos;t reach the network right now. Check your connection and try again --
          your chats are waiting once you&apos;re back online.
        </p>
      </Surface>
    </div>
  );
}
