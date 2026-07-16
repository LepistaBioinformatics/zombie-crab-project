import type { Instance } from "@/lib/mycelium";
import type { Workspace } from "@/app/chat/fragment";

// Conversation metadata (title, agent, recency) now lives server-side in
// Postgres, scoped to the signed-in account's email AND the selected
// workspace (tenant + subscription + role) -- not localStorage, and no longer
// just email (workspace-selection resolved point 2). This module is just the
// client-side fetch wrapper.
export interface ConversationSummary {
  id: string; // == session_id (the fragment `sid`)
  role: Instance;
  tenantId: string;
  subsAccId: string;
  title: string;
  updatedAt: number;
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
}

function fromApiRow(row: ConversationApiRow): ConversationSummary {
  return {
    id: row.id,
    role: row.instance as Instance,
    tenantId: row.tenantId,
    subsAccId: row.subsAccId,
    title: row.title,
    updatedAt: new Date(row.updatedAt).getTime(),
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

export async function createConversation(workspace: Workspace): Promise<ConversationSummary> {
  const res = await fetch("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenant_id: workspace.t, subs_acc_id: workspace.s, role: workspace.r }),
  });
  const data = await res.json();
  notifyUpdated();
  return fromApiRow(data.conversation);
}

// Called after a message is sent -- bumps the conversation to the top
// (most-recently-active ordering) and, the first time, derives a title from
// the message actually sent.
export async function touchConversation(id: string, firstUserMessageIfNew: string): Promise<void> {
  await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: firstUserMessageIfNew }),
  });
  notifyUpdated();
}
