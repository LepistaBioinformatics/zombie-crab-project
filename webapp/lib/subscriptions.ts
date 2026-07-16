import type { Instance } from "@/lib/mycelium";

// The row shape returned by /api/subscriptions (already filtered to
// isInstance(role) server-side). One row per (tenant, account, agent,
// permission) -- so a workspace the caller can both read and write shows up as
// two rows here.
export interface Subscription {
  tenantId: string;
  subsAccId: string;
  accName: string;
  role: string;
  perm: string;
  verified: boolean;
  scaffolded: boolean;
}

// A chattable workspace: the agent leaf. Permission is NOT part of its identity
// (chat-ui-material-refactor DEC-3) -- read/write rows collapse into one leaf
// with the union of permissions.
export interface AgentLeaf {
  tenantId: string;
  subsAccId: string;
  accName: string;
  role: Instance;
  perms: string[]; // normalized union, e.g. ["read", "write"]
  verified: boolean;
  scaffolded: boolean;
}

export interface AccountGroup {
  subsAccId: string;
  accName: string;
  agents: AgentLeaf[];
}

export interface TenantGroup {
  tenantId: string;
  accounts: AccountGroup[];
}

// `perm` comes from an external feed (crab-shell-proxy) with no guaranteed
// casing/spelling -- normalize defensively at this boundary. Anything
// containing "write"/"read" maps to that capability; unrecognized/empty
// contributes nothing.
function normalizePerms(raw: string): ("read" | "write")[] {
  const value = raw.toLowerCase();
  const out: ("read" | "write")[] = [];
  if (value.includes("read")) out.push("read");
  if (value.includes("write")) out.push("write");
  return out;
}

// Collapses subscription rows into a tenant -> account -> agent tree, keyed on
// `tenantId | subsAccId | role`. Insertion order is preserved at every level so
// the sidebar renders deterministically.
export function groupWorkspaces(subs: Subscription[]): TenantGroup[] {
  const tenants = new Map<string, TenantGroup>();
  const accounts = new Map<string, AccountGroup>();
  const leaves = new Map<string, AgentLeaf>();

  for (const sub of subs) {
    const tenant =
      tenants.get(sub.tenantId) ?? { tenantId: sub.tenantId, accounts: [] };
    if (!tenants.has(sub.tenantId)) tenants.set(sub.tenantId, tenant);

    const accKey = `${sub.tenantId}|${sub.subsAccId}`;
    let account = accounts.get(accKey);
    if (!account) {
      account = { subsAccId: sub.subsAccId, accName: sub.accName, agents: [] };
      accounts.set(accKey, account);
      tenant.accounts.push(account);
    }

    const leafKey = `${sub.tenantId}|${sub.subsAccId}|${sub.role}`;
    const leaf = leaves.get(leafKey);
    const perms = normalizePerms(sub.perm);
    if (!leaf) {
      const created: AgentLeaf = {
        tenantId: sub.tenantId,
        subsAccId: sub.subsAccId,
        accName: sub.accName,
        role: sub.role as Instance,
        perms: [...perms],
        verified: sub.verified,
        scaffolded: sub.scaffolded,
      };
      leaves.set(leafKey, created);
      account.agents.push(created);
    } else {
      for (const p of perms) if (!leaf.perms.includes(p)) leaf.perms.push(p);
      leaf.verified = leaf.verified || sub.verified;
      leaf.scaffolded = leaf.scaffolded || sub.scaffolded;
    }
  }

  return [...tenants.values()];
}

// Badge text for a leaf's permission union. Empty set -> "" (render no badge,
// mirroring the old picker's `sub.perm ?` guard). read-then-write ordering.
export function accessLabel(perms: string[]): string {
  const set = new Set(perms.map((p) => p.toLowerCase()));
  const parts: string[] = [];
  if (set.has("read")) parts.push("read");
  if (set.has("write")) parts.push("write");
  return parts.join("·"); // "read·write"
}
