import type { Instance } from "@/lib/mycelium";

// Conversation metadata (title, agent, recency) now lives server-side in
// Postgres, keyed by the signed-in account's email -- not localStorage. This
// is what makes the sidebar the same across browsers/devices for the same
// account, unlike the earlier client-only index (see .specs/project/STATE.md
// for that discussion). This module is just the client-side fetch wrapper.
export interface ConversationSummary {
  id: string; // == session_id sent to /api/chat/[instance]
  instance: Instance;
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
  title: string;
  updatedAt: string;
}

function fromApiRow(row: ConversationApiRow): ConversationSummary {
  return {
    id: row.id,
    instance: row.instance as Instance,
    title: row.title,
    updatedAt: new Date(row.updatedAt).getTime(),
  };
}

export async function listConversations(): Promise<ConversationSummary[]> {
  const res = await fetch("/api/conversations");
  if (!res.ok) return [];
  const data = await res.json();
  const rows: ConversationApiRow[] = Array.isArray(data.conversations) ? data.conversations : [];
  return rows.map(fromApiRow);
}

export async function createConversation(instance: Instance): Promise<ConversationSummary> {
  const res = await fetch("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instance }),
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
