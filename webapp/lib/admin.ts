import type { SecretNames, SecretFormat } from "@/lib/secrets";

// A scope the caller may administer (GET /api/admin/scopes). Modeled on the
// subscription-discovery shape (camelCase ids + display names) plus a `kind`
// discriminator, so the pickers show names rather than raw UUIDs. A `tenant`
// scope carries only tenantId; a `subscription` scope carries both.
export interface AdminScope {
  kind: "tenant" | "subscription";
  tenantId: string;
  subsAccId?: string;
  tenantName?: string;
  accName?: string;
}

// A resolved scope target passed to the shared-file / shared-secret calls.
export interface ScopeRef {
  kind: "tenant" | "subscription";
  tenantId: string;
  subsAccId?: string;
}

// FileMeta from the proxy -- metadata only, never bytes. Serves both shared
// files and (in the Members panel) a user's private files.
export interface FileMeta {
  name: string;
  size: number;
  modifiedAt?: string;
}

// An end user under a subscription (UserRef). `accId` is the mycelium account
// id; `name`/`email` are best-effort display fields.
export interface UserRef {
  accId: string;
  name?: string;
  email?: string;
}

function scopeParams(scope: ScopeRef): URLSearchParams {
  const q = new URLSearchParams({ scope: scope.kind, tenant_id: scope.tenantId });
  if (scope.kind === "subscription" && scope.subsAccId) q.set("subs_acc_id", scope.subsAccId);
  return q;
}

export function scopeKey(scope: ScopeRef): string {
  return scope.kind === "tenant" ? `t:${scope.tenantId}` : `s:${scope.tenantId}:${scope.subsAccId}`;
}

export async function listScopes(): Promise<AdminScope[]> {
  const res = await fetch("/api/admin/scopes");
  if (!res.ok) throw new Error(await errorMessage(res));
  const data = await res.json();
  return Array.isArray(data.scopes) ? (data.scopes as AdminScope[]) : [];
}

export async function listSharedFiles(scope: ScopeRef): Promise<FileMeta[]> {
  const res = await fetch(`/api/admin/shared?${scopeParams(scope).toString()}`);
  if (!res.ok) throw new Error(await errorMessage(res));
  const data = await res.json();
  return Array.isArray(data.files) ? (data.files as FileMeta[]) : [];
}

export async function uploadSharedFile(scope: ScopeRef, file: File): Promise<void> {
  const form = new FormData();
  form.set("scope", scope.kind);
  form.set("tenant_id", scope.tenantId);
  if (scope.kind === "subscription" && scope.subsAccId) form.set("subs_acc_id", scope.subsAccId);
  form.set("file", file, file.name);
  const res = await fetch("/api/admin/shared", { method: "POST", body: form });
  if (!res.ok) throw new Error(await errorMessage(res));
}

// URL for a shared-file download (bytes stream back through the BFF). Used as
// an <a href> so the browser handles the save.
export function sharedFileDownloadUrl(scope: ScopeRef, name: string): string {
  const q = scopeParams(scope);
  q.set("name", name);
  return `/api/admin/shared/content?${q.toString()}`;
}

export async function deleteSharedFile(scope: ScopeRef, name: string): Promise<void> {
  const q = scopeParams(scope);
  q.set("name", name);
  const res = await fetch(`/api/admin/shared?${q.toString()}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await errorMessage(res));
}

export async function listSharedSecrets(scope: ScopeRef): Promise<SecretNames> {
  const res = await fetch(`/api/admin/shared-secrets?${scopeParams(scope).toString()}`);
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

export async function setSharedSecret(
  scope: ScopeRef,
  input: { format: SecretFormat; name: string; value: string },
): Promise<void> {
  const res = await fetch("/api/admin/shared-secrets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scope: scope.kind,
      tenant_id: scope.tenantId,
      subs_acc_id: scope.subsAccId,
      format: input.format,
      name: input.name,
      value: input.value,
    }),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
}

export async function deleteSharedSecret(
  scope: ScopeRef,
  input: { format: SecretFormat; name: string },
): Promise<void> {
  const q = scopeParams(scope);
  q.set("format", input.format);
  q.set("name", input.name);
  const res = await fetch(`/api/admin/shared-secrets?${q.toString()}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await errorMessage(res));
}

export async function listSubscriptionUsers(
  tenantId: string,
  subsAccId: string,
): Promise<UserRef[]> {
  const q = new URLSearchParams({ tenant_id: tenantId, subs_acc_id: subsAccId });
  const res = await fetch(`/api/admin/users?${q.toString()}`);
  if (!res.ok) throw new Error(await errorMessage(res));
  const data = await res.json();
  return Array.isArray(data.users) ? (data.users as UserRef[]) : [];
}

// Metadata only -- the API has no path to a private file's bytes (FR-7).
export async function listUserFiles(
  tenantId: string,
  subsAccId: string,
  userAccId: string,
): Promise<FileMeta[]> {
  const q = new URLSearchParams({
    tenant_id: tenantId,
    subs_acc_id: subsAccId,
    user_acc_id: userAccId,
  });
  const res = await fetch(`/api/admin/users/files?${q.toString()}`);
  if (!res.ok) throw new Error(await errorMessage(res));
  const data = await res.json();
  return Array.isArray(data.files) ? (data.files as FileMeta[]) : [];
}

export async function deleteUserFile(
  tenantId: string,
  subsAccId: string,
  userAccId: string,
  name: string,
): Promise<void> {
  const q = new URLSearchParams({
    tenant_id: tenantId,
    subs_acc_id: subsAccId,
    user_acc_id: userAccId,
    name,
  });
  const res = await fetch(`/api/admin/users/files?${q.toString()}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await errorMessage(res));
}

// Resolves display names before the scope tree renders (no uuid flash). Tenant
// names come from the mycelium tenant lookup (/api/tenants/[id]). Subscription
// account names ride in from /scopes when the caller is that subscription's
// manager; the rest are resolved via /api/accounts/[id] (the
// subscriptionsManager.accounts.get RPC, which a tenant/instance manager may
// call scoped by tenant). Anything unresolved falls back to its id, so the tree
// always renders.
export async function resolveScopeNames(scopes: AdminScope[]): Promise<AdminScope[]> {
  const tenantNames = new Map<string, string>();
  const accNames = new Map<string, string>();
  const tenantIds = Array.from(new Set(scopes.map((s) => s.tenantId)));
  const unnamedSubs = scopes.filter(
    (s) => s.kind === "subscription" && s.subsAccId && !s.accName,
  );

  await Promise.all([
    ...tenantIds.map(async (id) => {
      try {
        const res = await fetch(`/api/tenants/${encodeURIComponent(id)}`);
        if (!res.ok) return;
        const data = await res.json();
        const name = tenantDisplayName(data.tenant);
        if (name) tenantNames.set(id, name);
      } catch {
        // leave unresolved -> the tree shows the id
      }
    }),
    ...unnamedSubs.map(async (s) => {
      try {
        const q = new URLSearchParams({ tenant_id: s.tenantId });
        const res = await fetch(`/api/accounts/${encodeURIComponent(s.subsAccId!)}?${q.toString()}`);
        if (!res.ok) return;
        const data = await res.json();
        if (typeof data.name === "string" && data.name.trim()) {
          accNames.set(s.subsAccId!, data.name.trim());
        }
      } catch {
        // leave unresolved -> the tree shows the id
      }
    }),
  ]);

  return scopes.map((s) => ({
    ...s,
    tenantName: tenantNames.get(s.tenantId) ?? s.tenantName,
    accName: s.accName ?? (s.subsAccId ? accNames.get(s.subsAccId) : undefined),
  }));
}

function tenantDisplayName(tenant: unknown): string | null {
  if (tenant && typeof tenant === "object") {
    const name = (tenant as { name?: unknown }).name;
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  return null;
}

async function errorMessage(res: Response): Promise<string> {
  const data = await res.json().catch(() => null);
  const e = data?.error;
  if (e === "connectivity") return "Can't reach the gateway right now.";
  if (e === "session_expired") return "Your session expired — sign in again.";
  if (typeof e === "string" && e.trim()) return e;
  if (res.status === 413) return "File is too large.";
  return "Something went wrong.";
}
