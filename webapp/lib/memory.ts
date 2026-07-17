import type { Workspace } from "@/app/chat/fragment";

// Client wrapper for the workspace-memory file (MEMORY_CUSTOM.md), a document
// the user edits directly for the agent to read at turn time. Goes through the
// BFF (/api/memory), which attaches the session and picks the gateway path by
// role.

async function errorMessage(res: Response): Promise<string> {
  const data = await res.json().catch(() => null);
  const e = data?.error;
  if (e === "connectivity") return "Can't reach the gateway right now.";
  if (e === "session_expired") return "Your session expired — sign in again.";
  if (typeof e === "string" && e.trim()) return e;
  if (res.status === 413) return "This note is too long.";
  return "Couldn't save the workspace memory.";
}

export async function readMemory(workspace: Workspace): Promise<string> {
  const query = new URLSearchParams({
    tenant_id: workspace.t,
    subs_acc_id: workspace.s,
    role: workspace.r,
  });
  const res = await fetch(`/api/memory?${query.toString()}`);
  if (!res.ok) throw new Error(await errorMessage(res));
  const data = await res.json();
  return typeof data.content === "string" ? data.content : "";
}

export async function writeMemory(workspace: Workspace, content: string): Promise<void> {
  const res = await fetch(`/api/memory`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tenant_id: workspace.t,
      subs_acc_id: workspace.s,
      role: workspace.r,
      content,
    }),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
}
