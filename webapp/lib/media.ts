import type { Workspace } from "@/app/chat/fragment";

export interface Attachment {
  path: string; // workspace-relative, e.g. "uploads/ab12cd34-photo.png"
  name: string;
  size?: number;
}

// Extension allowlist the proxy enforces (config default). Used as the file
// input's `accept` so the picker pre-filters.
export const MEDIA_ACCEPT = ".png,.jpg,.jpeg,.webp,.gif,.pdf,.txt,.md,.csv";

export async function uploadMedia(workspace: Workspace, file: File): Promise<Attachment> {
  const form = new FormData();
  form.set("role", workspace.r);
  form.set("tenant_id", workspace.t);
  form.set("subs_acc_id", workspace.s);
  form.set("file", file, file.name);

  const res = await fetch("/api/media", { method: "POST", body: form });
  if (!res.ok) throw new Error(await errorMessage(res));
  const data = await res.json();
  return { path: data.path, name: data.name, size: data.size };
}

async function errorMessage(res: Response): Promise<string> {
  const data = await res.json().catch(() => null);
  const e = data?.error;
  if (e === "connectivity") return "Can't reach the gateway right now.";
  if (e === "session_expired") return "Your session expired — sign in again.";
  if (typeof e === "string" && e.trim()) return e;
  if (res.status === 413) return "File is too large.";
  return "Upload failed.";
}
