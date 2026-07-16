"use client";

import { useEffect, useState } from "react";
import { MessageSquarePlus, PanelLeftClose, Search } from "lucide-react";
import {
  createConversation,
  listConversations,
  onConversationsUpdated,
  type ConversationSummary,
} from "@/lib/chatSession";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { cva } from "class-variance-authority";
import { useFragment, setFragmentSid, historyQuery, type Workspace } from "./fragment";

const conversationItem = cva(
  "flex w-full items-center rounded-lg px-3 py-2 text-left transition-colors",
  {
    variants: {
      active: { true: "bg-accent/12", false: "hover:bg-elevated/60" },
    },
    defaultVariants: { active: false },
  },
);

export default function HistorySidebar({
  workspace,
  onSelect,
  onCollapse,
}: {
  workspace: Workspace;
  onSelect?: () => void;
  onCollapse?: () => void;
}) {
  const fragment = useFragment();
  const activeSessionId = fragment?.sid;

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ConversationSummary[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const refresh = () => listConversations(workspace).then(setConversations);
    refresh();
    return onConversationsUpdated(refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.t, workspace.s, workspace.r]);

  // Full-content search: fires a debounced fetch of every conversation's
  // history and filters by substring match (title or message content) --
  // see .specs/features/chat-ui-redesign/spec.md "Full-content search".
  useEffect(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      setSearchResults(null);
      return;
    }

    let cancelled = false;
    const timeout = setTimeout(async () => {
      setSearching(true);
      const all = await listConversations(workspace);
      const results = await Promise.all(
        all.map(async (conversation) => {
          if (conversation.title.toLowerCase().includes(q)) return conversation;
          try {
            const res = await fetch(
              `/api/chat/${conversation.role}/history?${historyQuery(workspace, conversation.id)}`,
            );
            if (!res.ok) return null;
            const data = await res.json();
            const messages: { content?: string }[] = Array.isArray(data.messages) ? data.messages : [];
            const matches = messages.some(
              (m) => typeof m.content === "string" && m.content.toLowerCase().includes(q),
            );
            return matches ? conversation : null;
          } catch {
            return null;
          }
        }),
      );
      if (!cancelled) {
        setSearchResults(results.filter((c): c is ConversationSummary => c !== null));
        setSearching(false);
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, workspace.t, workspace.s, workspace.r]);

  const visible = searchResults ?? conversations;

  async function onNewChat() {
    const conversation = await createConversation(workspace);
    setFragmentSid(conversation.id);
    onSelect?.();
  }

  function onOpenConversation(id: string) {
    setFragmentSid(id);
    onSelect?.();
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex items-center gap-2 p-2">
        <Button variant="filled" size="md" className="flex-1" onClick={onNewChat}>
          <MessageSquarePlus size={18} />
          New chat
        </Button>
        {onCollapse && (
          <IconButton
            variant="ghost"
            size="md"
            aria-label="Collapse Conversations"
            title="Collapse"
            onClick={onCollapse}
            className="hidden md:inline-flex"
          >
            <PanelLeftClose size={18} aria-hidden />
          </IconButton>
        )}
      </div>

      <div className="px-2 pb-2">
        <div className="relative">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted"
          />
          <Input
            inputSize="sm"
            className="pl-9"
            placeholder="Search conversations"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="flex items-center gap-2 px-3 pb-1">
        <span className="h-2 w-2 shrink-0 bg-accent" />
        <span className="font-display text-xs font-semibold uppercase tracking-wide text-fg-muted">
          CONVERSATIONS
        </span>
        <span className="ml-auto truncate text-[11px] lowercase text-fg-muted" title={`agent ${workspace.r}`}>
          {workspace.r}
        </span>
      </div>

      <div className="flex-1 overflow-auto px-2 pb-2">
        {searching && (
          <div className="flex justify-center py-4">
            <Spinner size={20} />
          </div>
        )}
        {!searching && visible.length === 0 && (
          <p className="py-4 text-center text-sm text-fg-muted">
            {query.trim() ? "No matches." : "No conversations yet."}
          </p>
        )}
        {!searching &&
          visible.map((conversation) => {
            const active = conversation.id === activeSessionId;
            return (
              <button
                key={conversation.id}
                onClick={() => onOpenConversation(conversation.id)}
                className={conversationItem({ active })}
              >
                <span className="w-full truncate text-sm text-fg">{conversation.title}</span>
              </button>
            );
          })}
      </div>
    </div>
  );
}
