import type { Workspace } from "@/app/chat/fragment";

export interface Attachment {
  path: string; // workspace-relative, e.g. "uploads/ab12cd34-photo.png"
  name: string;
  size?: number;
}

// Attach categories shown in the composer's attach menu. Each opens the picker
// filtered to its extensions; "Outros" (rendered separately) uses MEDIA_ACCEPT
// (the full allowlist). Must stay in sync with the proxy's MediaAllowedExts.
export interface MediaCategory {
  key: string;
  label: string;
  exts: string[];
}

export const MEDIA_CATEGORIES: MediaCategory[] = [
  { key: "image", label: "Imagens", exts: ["png", "jpg", "jpeg", "webp", "gif"] },
  { key: "doc", label: "Documentos", exts: ["pdf", "txt", "md", "csv", "doc", "docx", "odt"] },
  { key: "sheet", label: "Planilhas", exts: ["xls", "xlsx", "ods"] },
  { key: "slides", label: "Apresentações", exts: ["ppt", "pptx", "odp"] },
  { key: "archive", label: "Comprimidos", exts: ["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar"] },
];

// The full allowlist (union of every category) — the proxy rejects anything
// outside it with 400.
export const MEDIA_ALL_EXTS = [...new Set(MEDIA_CATEGORIES.flatMap((c) => c.exts))];

// `accept` string for a set of extensions (e.g. ".png,.jpg").
export function acceptFor(exts: string[]): string {
  return exts.map((e) => `.${e}`).join(",");
}

// Full allowlist as an `accept` string (used by the "Outros" option).
export const MEDIA_ACCEPT = acceptFor(MEDIA_ALL_EXTS);

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

// Lists the files already stored in the workspace uploads dir (for the uploads
// sidebar).
export async function listWorkspaceMedia(workspace: Workspace): Promise<Attachment[]> {
  const query = new URLSearchParams({
    tenant_id: workspace.t,
    subs_acc_id: workspace.s,
    role: workspace.r,
  });
  const res = await fetch(`/api/media?${query.toString()}`);
  if (!res.ok) throw new Error(await errorMessage(res));
  const data = await res.json();
  return Array.isArray(data.files) ? data.files : [];
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
