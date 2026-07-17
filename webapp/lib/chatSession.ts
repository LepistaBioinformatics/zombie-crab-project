import type { Instance } from "@/lib/mycelium";
import type { Workspace } from "@/app/chat/fragment";

// Conversation metadata (title, agent, recency) now lives server-side in
// Postgres, scoped to the signed-in account's email AND the selected
// workspace (tenant + subscription + role) -- not localStorage, and no longer
// just email (workspace-selection resolved point 2). This module is just the
// client-side fetch wrapper.
// A per-conversation tag: a name, an optional value, and an arbitrary metadata
// blob (the front reads `metadata.color`/`metadata.description`).
export interface Tag {
  name: string;
  value: string | null;
  metadata: Record<string, unknown>;
}

export interface ConversationSummary {
  id: string; // == session_id (the fragment `sid`)
  role: Instance;
  tenantId: string;
  subsAccId: string;
  title: string;
  updatedAt: number;
  alias: string | null;
  tags: Tag[];
  sessionKey: string | null;
  sessionFile: string | null;
}

// The sidebar (a separate component from wherever a conversation is
// created/touched) needs to know when the list changes so it stays current
// without polling.
const UPDATED_EVENT = "chat-conversations-updated";

export function onConversationsUpdated(listener: () => void): () => void {
  window.addEventListener(UPDATED_EVENT, listener);
  return () => window.removeEventListener(UPDATED_EVENT, listener);
}

function notifyUpdated(): void {
  window.dispatchEvent(new Event(UPDATED_EVENT));
}

interface ConversationApiRow {
  id: string;
  instance: string;
  tenantId: string;
  subsAccId: string;
  title: string;
  updatedAt: string;
  alias: string | null;
  tags: Tag[];
  sessionKey: string | null;
  sessionFile: string | null;
}

function fromApiRow(row: ConversationApiRow): ConversationSummary {
  return {
    id: row.id,
    role: row.instance as Instance,
    tenantId: row.tenantId,
    subsAccId: row.subsAccId,
    title: row.title,
    updatedAt: new Date(row.updatedAt).getTime(),
    alias: row.alias ?? null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    sessionKey: row.sessionKey ?? null,
    sessionFile: row.sessionFile ?? null,
  };
}

function workspaceQuery(workspace: Workspace): string {
  return new URLSearchParams({
    tenant_id: workspace.t,
    subs_acc_id: workspace.s,
    role: workspace.r,
  }).toString();
}

export async function listConversations(workspace: Workspace): Promise<ConversationSummary[]> {
  const res = await fetch(`/api/conversations?${workspaceQuery(workspace)}`);
  if (!res.ok) return [];
  const data = await res.json();
  const rows: ConversationApiRow[] = Array.isArray(data.conversations) ? data.conversations : [];
  return rows.map(fromApiRow);
}

// Mints a conversation id client-side WITHOUT persisting anything. The
// postgres row is created lazily on the first sent message (touchConversation),
// so opening/selecting a conversation that never receives a message leaves no
// ghost row without a picoclaw transcript behind it.
export async function createConversation(workspace: Workspace): Promise<ConversationSummary> {
  return {
    id: crypto.randomUUID(),
    role: workspace.r,
    tenantId: workspace.t,
    subsAccId: workspace.s,
    title: "New chat",
    updatedAt: Date.now(),
    alias: null,
    tags: [],
    sessionKey: null,
    sessionFile: null,
  };
}

// Called after a message is sent -- creates the row on the first message
// (deferred creation) and bumps recency on later ones, so the sidebar list
// only ever shows conversations that were actually used. Carries the workspace
// so the row can be created if it doesn't exist yet.
export async function touchConversation(
  workspace: Workspace,
  id: string,
  firstUserMessage: string,
): Promise<void> {
  await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: firstUserMessage,
      tenant_id: workspace.t,
      subs_acc_id: workspace.s,
      role: workspace.r,
    }),
  });
  notifyUpdated();
}

// Renames a conversation via the dedicated PUT path (owner-scoped server-side).
// Returns the persisted title on success; throws the server error otherwise so
// the caller can surface it and keep the old title.
export async function renameConversation(id: string, title: string): Promise<string> {
  const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ? String(data.error) : "rename_failed");
  }
  const data = await res.json();
  notifyUpdated();
  return typeof data?.title === "string" ? data.title : title;
}

// Removes a conversation from the sidebar index (owner-scoped server-side).
// Throws the server error on failure so the caller can surface it.
export async function deleteConversation(id: string): Promise<void> {
  const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ? String(data.error) : "delete_failed");
  }
  notifyUpdated();
}

// Sets (or clears, with an empty string) a conversation's display alias
// (owner-scoped server-side). Throws the server error on failure.
export async function setAlias(id: string, alias: string): Promise<void> {
  const res = await fetch(`/api/conversations/${encodeURIComponent(id)}/alias`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ alias }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ? String(data.error) : "alias_failed");
  }
  notifyUpdated();
}

// Adds or updates a tag on a conversation (upsert by name, owner-scoped
// server-side). Throws the server error on failure.
export async function upsertTag(id: string, tag: Tag): Promise<void> {
  const res = await fetch(`/api/conversations/${encodeURIComponent(id)}/tags`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: tag.name, value: tag.value, metadata: tag.metadata }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ? String(data.error) : "tag_failed");
  }
  notifyUpdated();
}

// Removes a tag by name from a conversation (owner-scoped server-side). Throws
// the server error on failure.
export async function deleteTag(id: string, name: string): Promise<void> {
  const res = await fetch(
    `/api/conversations/${encodeURIComponent(id)}/tags?name=${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ? String(data.error) : "tag_delete_failed");
  }
  notifyUpdated();
}

// Asks the proxy (via the BFF) to resolve and persist the session identifiers
// behind a conversation, so the postgres row points at the exact picoclaw
// transcript. Best-effort: called after a turn completes; the caller swallows
// errors. Does not notify the sidebar (session refs aren't rendered).
export async function syncSessionRefs(workspace: Workspace, id: string): Promise<void> {
  await fetch(`/api/conversations/${encodeURIComponent(id)}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tenant_id: workspace.t,
      subs_acc_id: workspace.s,
      role: workspace.r,
      session_id: id,
    }),
  });
}
