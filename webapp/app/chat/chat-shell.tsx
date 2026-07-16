"use client";

import { useState } from "react";
import { Menu, MessageSquare } from "lucide-react";
import { useFragment, toWorkspace } from "./fragment";
import NavSidebar from "./nav-sidebar";
import HistorySidebar from "./history-sidebar";
import ChatView from "./chat-view";
import EmptyState from "./empty-state";
import { cva } from "class-variance-authority";
import { IconButton } from "@/components/ui/icon-button";
import { Spinner } from "@/components/ui/spinner";

// Sidebar column: static on desktop; an off-canvas left drawer on mobile that
// slides in when open.
const drawer = cva(
  "z-40 shrink-0 border-r border-brand/30 bg-surface max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:shadow-xl max-md:transition-transform md:static md:translate-x-0",
  {
    variants: {
      pane: { nav: "w-[280px]", history: "w-[300px]" },
      open: { true: "max-md:translate-x-0", false: "max-md:-translate-x-full" },
    },
    defaultVariants: { open: false },
  },
);

// The whole /chat experience on one route: the nav drawer is always present;
// the history drawer + chat view mount only when the fragment carries a valid
// workspace. All selection state lives in the URL fragment (never sent to the
// server -- workspace ids stay out of request logs).
//
// Desktop: three static columns. Mobile (< md): the two sidebars become
// left-slide overlay drawers toggled from a top bar, and auto-close once a
// workspace/conversation is picked so the chat is immediately in view.
export default function ChatShell({ email }: { email: string }) {
  const fragment = useFragment();
  // `null` = fragment not read yet (first client paint). Distinct from "read
  // and empty" so we don't flash the empty state over a valid bookmarked URL.
  const resolved = fragment !== null;
  const workspace = fragment ? toWorkspace(fragment) : null;
  const sessionId = fragment?.sid;

  const [navOpen, setNavOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const closeDrawers = () => {
    setNavOpen(false);
    setHistoryOpen(false);
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* Mobile top bar */}
      <div className="flex items-center gap-2 border-b border-brand/30 bg-surface px-3 py-2 md:hidden">
        <IconButton variant="ghost" size="sm" aria-label="Open workspaces" onClick={() => setNavOpen(true)}>
          <Menu size={20} aria-hidden />
        </IconButton>
        <span className="flex-1 truncate font-display text-sm font-semibold text-fg">
          {workspace ? `agente ${workspace.r}` : "zombie-crab"}
        </span>
        {workspace && (
          <IconButton variant="ghost" size="sm" aria-label="Conversations" onClick={() => setHistoryOpen(true)}>
            <MessageSquare size={20} aria-hidden />
          </IconButton>
        )}
      </div>

      <div className="relative flex min-h-0 flex-1">
        {/* Backdrop for mobile drawers */}
        {(navOpen || historyOpen) && (
          <div
            className="absolute inset-0 z-30 bg-black/40 md:hidden"
            onClick={closeDrawers}
            aria-hidden
          />
        )}

        <aside className={drawer({ pane: "nav", open: navOpen })}>
          <NavSidebar email={email} onSelect={closeDrawers} />
        </aside>

        {workspace && (
          <aside className={drawer({ pane: "history", open: historyOpen })}>
            <HistorySidebar workspace={workspace} onSelect={() => setHistoryOpen(false)} />
          </aside>
        )}

        <main className="min-w-0 flex-1">
          {!resolved ? (
            <div className="flex h-full items-center justify-center">
              <Spinner size={28} />
            </div>
          ) : workspace ? (
            <ChatView workspace={workspace} sessionId={sessionId} />
          ) : (
            <EmptyState />
          )}
        </main>
      </div>
    </div>
  );
}
