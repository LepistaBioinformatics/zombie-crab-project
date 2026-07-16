import type { Workspace } from "@/app/chat/fragment";

// Names only -- values are write-only and never returned by the proxy.
export interface SecretNames {
  dotenv: string[];
  json: string[];
  native: string[];
  file: string[];
}

export const SECRET_FORMATS = ["dotenv", "json", "file", "native"] as const;
export type SecretFormat = (typeof SECRET_FORMATS)[number];

// Fixed picoclaw web-search slots (crab-shell-proxy secrets.go webProviders).
// A native web slot is `web.<provider>`; the proxy rejects anything else.
export const WEB_PROVIDERS = [
  "brave",
  "tavily",
  "kagi",
  "gemini",
  "perplexity",
  "glm_search",
  "baidu_search",
] as const;

// dotenv/json/file names: safe charset (matches the proxy's validateSecretName)
// -- a fast client-side fail before the proxy's own 400.
export const SECRET_NAME_RE = /^[A-Za-z0-9._-]+$/;

function workspaceQuery(workspace: Workspace): URLSearchParams {
  return new URLSearchParams({
    tenant_id: workspace.t,
    subs_acc_id: workspace.s,
    role: workspace.r,
  });
}

export async function listSecrets(workspace: Workspace): Promise<SecretNames> {
  const res = await fetch(`/api/secrets?${workspaceQuery(workspace).toString()}`);
  if (!res.ok) throw new Error(await errorMessage(res));
  const data = await res.json();
  const s = data.secrets ?? {};
  return {
    dotenv: Array.isArray(s.dotenv) ? s.dotenv : [],
    json: Array.isArray(s.json) ? s.json : [],
    native: Array.isArray(s.native) ? s.native : [],
    file: Array.isArray(s.file) ? s.file : [],
  };
}

export async function setSecret(
  workspace: Workspace,
  input: { format: SecretFormat; name: string; value: string },
): Promise<void> {
  const res = await fetch("/api/secrets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tenant_id: workspace.t,
      subs_acc_id: workspace.s,
      role: workspace.r,
      format: input.format,
      name: input.name,
      value: input.value,
    }),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
}

export async function deleteSecret(
  workspace: Workspace,
  input: { format: SecretFormat; name: string },
): Promise<void> {
  const query = workspaceQuery(workspace);
  query.set("format", input.format);
  query.set("name", input.name);
  const res = await fetch(`/api/secrets?${query.toString()}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await errorMessage(res));
}

// Surfaces the proxy's real reason (400 bad name/slot, 403 unlicensed) rather
// than a masked "connectivity".
async function errorMessage(res: Response): Promise<string> {
  const data = await res.json().catch(() => null);
  const e = data?.error;
  if (e === "connectivity") return "Can't reach the gateway right now.";
  if (e === "session_expired") return "Your session expired — sign in again.";
  if (typeof e === "string" && e.trim()) return e;
  return "Something went wrong.";
}
