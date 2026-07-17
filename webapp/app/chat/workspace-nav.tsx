"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { cva, type VariantProps } from "class-variance-authority";
import { Building2, ChevronDown, ChevronRight, FolderClosed, Bot, Search } from "lucide-react";
import { createConversation } from "@/lib/chatSession";
import {
  groupWorkspaces,
  accessLabel,
  type Subscription,
  type TenantGroup,
  type AgentLeaf,
} from "@/lib/subscriptions";
import { useFragment, setWorkspace, type Workspace } from "./fragment";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Alert } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";

// Selectable agent leaf: active = M3 tonal selected fill (no border). Depth
// indentation comes from the hierarchy guide wrappers, not padding here.
const leafButton = cva(
  "flex w-full items-center gap-2 rounded-lg py-1.5 pr-2 pl-2 text-left text-sm transition-colors disabled:opacity-60",
  {
    variants: {
      active: {
        true: "bg-accent/12 font-medium text-fg",
        false: "text-fg hover:bg-elevated/60",
      },
    },
    defaultVariants: { active: false },
  },
);

// Collapsible tenant/account headers: only the label treatment varies by level
// (depth is drawn by the guide-line wrappers around the children).
const groupHeader = cva(
  "flex w-full items-center gap-1.5 rounded-lg py-1.5 pr-2 pl-2 text-left transition-colors hover:bg-elevated/60",
  {
    variants: { level: { tenant: "", account: "" } },
    defaultVariants: { level: "tenant" },
  },
);

const groupHeaderLabel = cva("min-w-0 flex-1 truncate", {
  variants: {
    level: {
      tenant: "font-mono text-xs text-fg-muted",
      account: "text-sm font-medium text-fg",
    },
  },
  defaultVariants: { level: "tenant" },
});

type GroupLevel = NonNullable<VariantProps<typeof groupHeader>["level"]>;

// The "Workspaces" section body: fetches the caller's subscriptions, collapses
// permission-duplicated rows, and renders a tenant -> account -> agent tree.
// The agent leaf is the selectable workspace.
export default function WorkspaceNav({ onSelect }: { onSelect?: () => void }) {
  const router = useRouter();
  const fragment = useFragment();
  const [groups, setGroups] = useState<TenantGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entering, setEntering] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [tenantNames, setTenantNames] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/subscriptions");
        if (res.status === 401) {
          router.push("/signin");
          return;
        }
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          setError(data?.error ? String(data.error) : "Couldn't load your workspaces.");
          return;
        }
        const data = await res.json();
        const subs: Subscription[] = Array.isArray(data.subscriptions) ? data.subscriptions : [];
        setGroups(groupWorkspaces(subs));
      } catch {
        setError("Can't reach the gateway right now.");
      }
    })();
  }, [router]);

  // Resolve tenant display names lazily, per tenant, once the tree is grouped.
  // The tree renders immediately with uuids; names replace them as each fetch
  // lands -- never blocking the sidebar.
  useEffect(() => {
    if (!groups) return;
    let cancelled = false;
    for (const tenant of groups) {
      fetch(`/api/tenants/${encodeURIComponent(tenant.tenantId)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (cancelled || !data) return;
          const name = tenantDisplayName(data.tenant);
          if (name) setTenantNames((prev) => ({ ...prev, [tenant.tenantId]: name }));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [groups]);

  const activeKey =
    fragment?.t && fragment?.s && fragment?.r
      ? `${fragment.t}|${fragment.s}|${fragment.r}`
      : null;

  function toggle(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function onPick(leaf: AgentLeaf) {
    if (entering) return;
    setEntering(true);
    const workspace: Workspace = { t: leaf.tenantId, s: leaf.subsAccId, r: leaf.role };
    try {
      const conversation = await createConversation(workspace);
      setWorkspace(workspace, conversation.id);
      onSelect?.();
    } finally {
      setEntering(false);
    }
  }

  const q = filter.trim().toLowerCase();
  const visibleGroups = groups && q ? filterGroups(groups, tenantNames, q) : groups;

  return (
    <div className="flex h-full min-h-0 flex-col">
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
            placeholder="Filter workspaces"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>

      <div className="flex items-center gap-2 px-3 pb-1">
        <span className="h-2 w-2 shrink-0 bg-accent" aria-hidden />
        <span className="font-display text-xs font-semibold uppercase tracking-wide text-fg-muted">
          WORKSPACES
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2 pt-1">
        {error ? (
          <Alert severity="error">{error}</Alert>
        ) : groups === null ? (
          <div className="flex justify-center py-4">
            <Spinner size={20} />
          </div>
        ) : groups.length === 0 ? (
          <p className="px-2 py-3 text-sm text-fg-muted">
            You aren&apos;t in any workspaces yet — ask an operator to add you to one.
          </p>
        ) : visibleGroups!.length === 0 ? (
          <p className="px-2 py-3 text-sm text-fg-muted">No workspaces match your filter.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {visibleGroups!.map((tenant) => {
              const tKey = tenant.tenantId;
              const tOpen = q ? true : !collapsed.has(tKey);
              return (
                <div key={tKey}>
                  <GroupHeader
                    icon={<Building2 size={15} aria-hidden />}
                    label={tenantNames[tenant.tenantId] ?? tenant.tenantId}
                    open={tOpen}
                    level="tenant"
                    onClick={() => toggle(tKey)}
                  />
                  {tOpen && (
                    <div className="ml-[15px] mt-0.5 space-y-2 border-l border-brand/25 pl-2">
                      {tenant.accounts.map((account) => {
                        const aKey = `${tenant.tenantId}|${account.subsAccId}`;
                        const aOpen = q ? true : !collapsed.has(aKey);
                        return (
                          <div key={aKey}>
                            <GroupHeader
                              icon={<FolderClosed size={15} aria-hidden />}
                              label={account.accName || account.subsAccId}
                              open={aOpen}
                              level="account"
                              onClick={() => toggle(aKey)}
                            />
                            {aOpen && (
                              <div className="ml-[15px] mt-0.5 space-y-0.5 border-l border-brand/15 pl-2">
                                {account.agents.map((leaf) => {
                                  const lKey = `${leaf.tenantId}|${leaf.subsAccId}|${leaf.role}`;
                                  const active = lKey === activeKey;
                                  const badge = accessLabel(leaf.perms);
                                  return (
                                    <button
                                      key={lKey}
                                      type="button"
                                      disabled={entering}
                                      onClick={() => onPick(leaf)}
                                      className={leafButton({ active })}
                                    >
                                      <Bot size={15} className="shrink-0 text-fg-muted" aria-hidden />
                                      <span className="min-w-0 flex-1 truncate capitalize">{leaf.role}</span>
                                      {badge && <Badge tone="accent">{badge}</Badge>}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function GroupHeader({
  icon,
  label,
  open,
  level,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  open: boolean;
  level: GroupLevel;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className={groupHeader({ level })}>
      {open ? (
        <ChevronDown size={14} className="shrink-0 text-fg-muted" aria-hidden />
      ) : (
        <ChevronRight size={14} className="shrink-0 text-fg-muted" aria-hidden />
      )}
      <span className="shrink-0 text-fg-muted">{icon}</span>
      <span className={groupHeaderLabel({ level })} title={label}>
        {label}
      </span>
    </button>
  );
}

// Client-side narrowing of the already-loaded discovery tree (no refetch): a
// leaf survives if the query substring-matches its tenant display name, its
// account label, or its role -- the fields the card shows. Tenants/accounts
// with no surviving leaf drop out.
function filterGroups(
  groups: TenantGroup[],
  tenantNames: Record<string, string>,
  q: string,
): TenantGroup[] {
  return groups
    .map((tenant) => {
      const tenantLabel = (tenantNames[tenant.tenantId] ?? tenant.tenantId).toLowerCase();
      const tenantMatch = tenantLabel.includes(q);
      const accounts = tenant.accounts
        .map((account) => {
          const accMatch = (account.accName || account.subsAccId).toLowerCase().includes(q);
          const agents =
            tenantMatch || accMatch
              ? account.agents
              : account.agents.filter((leaf) => leaf.role.toLowerCase().includes(q));
          return { ...account, agents };
        })
        .filter((account) => account.agents.length > 0);
      return { ...tenant, accounts };
    })
    .filter((tenant) => tenant.accounts.length > 0);
}

// mycelium's public tenant object: { id, name, description, owners, ... }.
// Use `name`; fall back to null (keep the uuid) if it's missing/blank.
function tenantDisplayName(tenant: unknown): string | null {
  if (tenant && typeof tenant === "object") {
    const name = (tenant as { name?: unknown }).name;
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  return null;
}
