"use client";

import { useEffect, useState } from "react";
import {
  Bot,
  Check,
  MessageSquarePlus,
  PanelLeftClose,
  Pencil,
  Plus,
  Search,
  Tags,
  Trash2,
  X,
} from "lucide-react";
import {
  createConversation,
  deleteConversation,
  deleteTag,
  listConversations,
  onConversationsUpdated,
  renameConversation,
  setAlias,
  upsertTag,
  type ConversationSummary,
  type Tag,
} from "@/lib/chatSession";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cva } from "class-variance-authority";
import { useFragment, setFragmentSid, historyQuery, type Workspace } from "./fragment";

const conversationRow = cva(
  // Column on mobile (name on top, actions below); row on desktop with the
  // actions absolutely positioned so they reserve no width (the name never
  // truncates just to make room for hidden buttons).
  "group relative flex w-full flex-col rounded-lg transition-colors md:flex-row md:items-center md:pr-1",
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [enrichingId, setEnrichingId] = useState<string | null>(null);

  // Applies a change to a single conversation across both the base list and the
  // (optional) search results, mirroring the optimistic updates rename/delete do.
  function applyToLists(id: string, fn: (c: ConversationSummary) => ConversationSummary) {
    const map = (list: ConversationSummary[]) => list.map((c) => (c.id === id ? fn(c) : c));
    setConversations(map);
    setSearchResults((prev) => (prev ? map(prev) : prev));
  }

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

  function startRename(conversation: ConversationSummary) {
    setEditingId(conversation.id);
    setDraft(conversation.title);
    setRenameError(null);
  }

  function cancelRename() {
    setEditingId(null);
    setRenameError(null);
  }

  async function submitRename(id: string) {
    const title = draft.trim();
    if (!title) {
      setRenameError("Title can't be empty.");
      return;
    }
    try {
      const saved = await renameConversation(id, title);
      const apply = (list: ConversationSummary[]) =>
        list.map((c) => (c.id === id ? { ...c, title: saved } : c));
      setConversations(apply);
      setSearchResults((prev) => (prev ? apply(prev) : prev));
      setEditingId(null);
      setRenameError(null);
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : "Couldn't rename this chat.");
    }
  }

  async function onDelete(id: string) {
    setDeleteError(null);
    try {
      await deleteConversation(id);
      const drop = (list: ConversationSummary[]) => list.filter((c) => c.id !== id);
      setConversations(drop);
      setSearchResults((prev) => (prev ? drop(prev) : prev));
      setDeletingId(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Couldn't delete this chat.");
    }
  }

  const pendingDelete = deletingId ? visible.find((c) => c.id === deletingId) : null;

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex h-16 shrink-0 items-center gap-2 px-4">
        <Bot size={18} className="shrink-0 text-fg-muted" aria-hidden />
        <span
          className="min-w-0 flex-1 truncate font-display text-base font-semibold capitalize text-fg"
          title={`agent ${workspace.r}`}
        >
          {workspace.r}
        </span>
        {onCollapse && (
          <IconButton
            variant="ghost"
            size="sm"
            aria-label="Collapse Conversations"
            title="Collapse"
            onClick={onCollapse}
            className="hidden md:inline-flex"
          >
            <PanelLeftClose size={18} aria-hidden />
          </IconButton>
        )}
      </div>

      <div className="shrink-0 p-2">
        <div className="relative">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted"
          />
          <Input
            variant="subtle"
            inputSize="sm"
            className="pl-9"
            placeholder="Search conversations"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="px-3 pb-1">
        <Button
          variant="text"
          size="sm"
          className="-ml-1 gap-1.5 px-1 text-accent"
          onClick={onNewChat}
        >
          <MessageSquarePlus size={16} />
          New chat
        </Button>
      </div>

      <div className="flex items-center gap-2 px-3 pb-1 pt-1">
        <span className="h-2 w-2 shrink-0 bg-accent" />
        <span className="font-display text-xs font-semibold uppercase tracking-wide text-fg-muted">
          CONVERSATIONS
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
            if (editingId === conversation.id) {
              return (
                <form
                  key={conversation.id}
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitRename(conversation.id);
                  }}
                  className="flex flex-col gap-1 px-1 py-1"
                >
                  <div className="flex items-center gap-1">
                    <Input
                      inputSize="sm"
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") cancelRename();
                      }}
                      aria-label="Rename conversation"
                    />
                    <IconButton type="submit" variant="ghost" size="sm" aria-label="Save" title="Save">
                      <Check size={16} aria-hidden />
                    </IconButton>
                    <IconButton
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label="Cancel"
                      title="Cancel"
                      onClick={cancelRename}
                    >
                      <X size={16} aria-hidden />
                    </IconButton>
                  </div>
                  {renameError && <p className="px-1 text-xs text-red-500">{renameError}</p>}
                </form>
              );
            }
            const enriching = enrichingId === conversation.id;
            return (
              <div key={conversation.id}>
                <div className={conversationRow({ active })}>
                  <button
                    type="button"
                    onClick={() => onOpenConversation(conversation.id)}
                    className="flex min-w-0 flex-1 flex-col items-start gap-1 px-3 py-2 text-left"
                  >
                    <span className="w-full truncate text-sm text-fg">
                      {conversation.alias || conversation.title}
                    </span>
                    {conversation.tags.length > 0 && (
                      <span className="flex flex-wrap gap-1">
                        {conversation.tags.map((tag) => (
                          <TagChip key={tag.name} tag={tag} />
                        ))}
                      </span>
                    )}
                  </button>
                  {/* Mobile: an always-visible action row below the name. Desktop:
                      an absolute box on the right, revealed on hover, so it costs
                      the name no width. */}
                  <div className="flex items-center gap-0.5 border-t border-brand/10 px-2 py-1 md:absolute md:right-1 md:top-1/2 md:z-10 md:-translate-y-1/2 md:rounded-lg md:border-0 md:bg-surface/95 md:px-0.5 md:py-0.5 md:opacity-0 md:shadow-sm md:backdrop-blur md:transition-opacity md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                    <IconButton
                      variant="ghost"
                      size="sm"
                      aria-label="Alias and tags"
                      title="Alias and tags"
                      onClick={() => setEnrichingId(enriching ? null : conversation.id)}
                      aria-expanded={enriching}
                    >
                      <Tags size={14} aria-hidden />
                    </IconButton>
                    <IconButton
                      variant="ghost"
                      size="sm"
                      aria-label="Rename conversation"
                      title="Rename"
                      onClick={() => startRename(conversation)}
                    >
                      <Pencil size={14} aria-hidden />
                    </IconButton>
                    <IconButton
                      variant="ghost"
                      size="sm"
                      aria-label="Delete conversation"
                      title="Delete"
                      onClick={() => {
                        setDeleteError(null);
                        setDeletingId(conversation.id);
                      }}
                    >
                      <Trash2 size={14} aria-hidden />
                    </IconButton>
                  </div>
                </div>
                {enriching && (
                  <ConversationEditor
                    conversation={conversation}
                    onApply={(fn) => applyToLists(conversation.id, fn)}
                    onClose={() => setEnrichingId(null)}
                  />
                )}
              </div>
            );
          })}
      </div>

      <ConfirmDialog
        open={deletingId !== null}
        title="Delete chat?"
        message={
          deleteError ??
          `"${pendingDelete?.title ?? "This chat"}" is removed from your list. This can't be undone.`
        }
        confirmLabel="Delete"
        onConfirm={() => deletingId && onDelete(deletingId)}
        onCancel={() => {
          setDeletingId(null);
          setDeleteError(null);
        }}
      />
    </div>
  );
}

// A read-only chip for a tag: outlined + tinted in the tag's `metadata.color`
// when set (border + text colored rather than filled, so it stays legible in
// either theme), else the neutral Badge tone.
function TagChip({ tag }: { tag: Tag }) {
  const color = typeof tag.metadata.color === "string" ? tag.metadata.color : undefined;
  const description = typeof tag.metadata.description === "string" ? tag.metadata.description : undefined;
  const label = tag.value ? `${tag.name}: ${tag.value}` : tag.name;
  return (
    <Badge tone="neutral" title={description ?? label} style={color ? { borderColor: color, color } : undefined}>
      {label}
    </Badge>
  );
}

// The per-conversation alias + tag editor, expanded under a row. Local state for
// the alias draft and the new-tag fields; writes go through the owner-scoped
// client fns and update the parent lists optimistically.
function ConversationEditor({
  conversation,
  onApply,
  onClose,
}: {
  conversation: ConversationSummary;
  onApply: (fn: (c: ConversationSummary) => ConversationSummary) => void;
  onClose: () => void;
}) {
  const [aliasDraft, setAliasDraft] = useState(conversation.alias ?? "");
  const [tagName, setTagName] = useState("");
  const [tagValue, setTagValue] = useState("");
  const [tagColor, setTagColor] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function saveAlias() {
    const alias = aliasDraft.trim();
    setError(null);
    setBusy(true);
    try {
      await setAlias(conversation.id, alias);
      onApply((c) => ({ ...c, alias: alias || null }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the alias.");
    } finally {
      setBusy(false);
    }
  }

  async function addTag() {
    const name = tagName.trim();
    if (!name) {
      setError("Tag name can't be empty.");
      return;
    }
    const tag: Tag = {
      name,
      value: tagValue.trim() || null,
      metadata: tagColor ? { color: tagColor } : {},
    };
    setError(null);
    setBusy(true);
    try {
      await upsertTag(conversation.id, tag);
      onApply((c) => ({ ...c, tags: [...c.tags.filter((t) => t.name !== name), tag] }));
      setTagName("");
      setTagValue("");
      setTagColor("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add the tag.");
    } finally {
      setBusy(false);
    }
  }

  async function removeTag(name: string) {
    setError(null);
    setBusy(true);
    try {
      await deleteTag(conversation.id, name);
      onApply((c) => ({ ...c, tags: c.tags.filter((t) => t.name !== name) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't remove the tag.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-1 flex flex-col gap-3 rounded-lg bg-elevated/60 px-3 py-3">
      <div className="flex flex-col gap-1">
        <label className="font-display text-xs font-semibold uppercase tracking-wide text-fg-muted">
          Alias
        </label>
        <div className="flex items-center gap-1">
          <Input
            inputSize="sm"
            value={aliasDraft}
            placeholder={conversation.title}
            onChange={(e) => setAliasDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                saveAlias();
              }
            }}
            aria-label="Conversation alias"
          />
          <IconButton
            variant="ghost"
            size="sm"
            aria-label="Save alias"
            title="Save alias"
            onClick={saveAlias}
            disabled={busy}
          >
            <Check size={16} aria-hidden />
          </IconButton>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <span className="font-display text-xs font-semibold uppercase tracking-wide text-fg-muted">
          Tags
        </span>
        {conversation.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {conversation.tags.map((tag) => (
              <span key={tag.name} className="inline-flex items-center gap-0.5">
                <TagChip tag={tag} />
                <IconButton
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove tag ${tag.name}`}
                  title="Remove tag"
                  onClick={() => removeTag(tag.name)}
                  disabled={busy}
                  className="h-6 w-6"
                >
                  <X size={12} aria-hidden />
                </IconButton>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-center gap-1">
          <Input
            inputSize="sm"
            value={tagName}
            placeholder="name"
            onChange={(e) => setTagName(e.target.value)}
            aria-label="Tag name"
          />
          <Input
            inputSize="sm"
            value={tagValue}
            placeholder="value"
            onChange={(e) => setTagValue(e.target.value)}
            aria-label="Tag value"
          />
          <input
            type="color"
            value={tagColor || "#888888"}
            onChange={(e) => setTagColor(e.target.value)}
            aria-label="Tag color"
            title="Tag color"
            className="h-9 w-9 shrink-0 cursor-pointer rounded-lg border border-brand bg-elevated"
          />
          <IconButton
            variant="ghost"
            size="sm"
            aria-label="Add tag"
            title="Add tag"
            onClick={addTag}
            disabled={busy}
          >
            <Plus size={16} aria-hidden />
          </IconButton>
        </div>
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="flex justify-end">
        <Button variant="text" size="sm" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}
