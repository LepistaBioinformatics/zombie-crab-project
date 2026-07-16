"use client";

import { useEffect, useState } from "react";
import { Menu, MessageSquare } from "lucide-react";
import { useFragment, toWorkspace } from "./fragment";
import NavSidebar from "./nav-sidebar";
import HistorySidebar from "./history-sidebar";
import ChatView from "./chat-view";
import EmptyState from "./empty-state";
import ResizablePane from "./resizable-pane";
import { IconButton } from "@/components/ui/icon-button";
import { Spinner } from "@/components/ui/spinner";

const NAV_MIN = 220;
const NAV_DEFAULT = 280;
const HISTORY_MIN = 240;
const HISTORY_DEFAULT = 300;
const LAYOUT_KEY = "chat-sidebars";

// The whole /chat experience on one route: the nav drawer is always present;
// the history drawer + chat view mount only when the fragment carries a valid
// workspace. On desktop each sidebar collapses/resizes independently (persisted
// in localStorage); on mobile they are hamburger-toggled overlay drawers.
export default function ChatShell({ email }: { email: string }) {
  const fragment = useFragment();
  const resolved = fragment !== null;
  const workspace = fragment ? toWorkspace(fragment) : null;
  const sessionId = fragment?.sid;

  const [navOpen, setNavOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [navWidth, setNavWidth] = useState(NAV_DEFAULT);
  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  const [historyWidth, setHistoryWidth] = useState(HISTORY_DEFAULT);

  // Restore persisted desktop layout once on mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (typeof s.navWidth === "number") setNavWidth(s.navWidth);
      if (typeof s.historyWidth === "number") setHistoryWidth(s.historyWidth);
      if (typeof s.navCollapsed === "boolean") setNavCollapsed(s.navCollapsed);
      if (typeof s.historyCollapsed === "boolean") setHistoryCollapsed(s.historyCollapsed);
    } catch {
      // ignore malformed layout
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        LAYOUT_KEY,
        JSON.stringify({ navWidth, historyWidth, navCollapsed, historyCollapsed }),
      );
    } catch {
      // storage unavailable -- layout just won't persist
    }
  }, [navWidth, historyWidth, navCollapsed, historyCollapsed]);

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
          <div className="absolute inset-0 z-30 bg-black/40 md:hidden" onClick={closeDrawers} aria-hidden />
        )}

        <ResizablePane
          ariaLabel="Workspaces"
          open={navOpen}
          collapsed={navCollapsed}
          width={navWidth}
          minWidth={NAV_MIN}
          onExpand={() => setNavCollapsed(false)}
          onResize={setNavWidth}
        >
          <NavSidebar
            email={email}
            onSelect={closeDrawers}
            onCollapse={() => setNavCollapsed(true)}
          />
        </ResizablePane>

        {workspace && (
          <ResizablePane
            ariaLabel="Conversations"
            open={historyOpen}
            collapsed={historyCollapsed}
            width={historyWidth}
            minWidth={HISTORY_MIN}
            onExpand={() => setHistoryCollapsed(false)}
            onResize={setHistoryWidth}
          >
            <HistorySidebar
              workspace={workspace}
              onSelect={() => setHistoryOpen(false)}
              onCollapse={() => setHistoryCollapsed(true)}
            />
          </ResizablePane>
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
