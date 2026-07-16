"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, ChevronDown, ChevronRight, FolderClosed, Bot } from "lucide-react";
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
import { cn } from "@/lib/cn";

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

  const activeKey = fragment?.t && fragment?.s && fragment?.r
    ? `${fragment.t}|${fragment.s}|${fragment.r}`
    : null;

  function toggle(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
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

  if (error) {
    return (
      <div className="px-2">
        <Alert severity="error">{error}</Alert>
      </div>
    );
  }

  if (groups === null) {
    return (
      <div className="flex justify-center py-4">
        <Spinner size={20} />
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <p className="px-2 py-3 text-sm text-fg-muted">
        You aren&apos;t in any workspaces yet — ask an operator to add you to one.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {groups.map((tenant) => {
        const tKey = tenant.tenantId;
        const tOpen = !collapsed.has(tKey);
        return (
          <div key={tKey}>
            <GroupHeader
              icon={<Building2 size={15} aria-hidden />}
              label={tenant.tenantId}
              open={tOpen}
              depth={0}
              onClick={() => toggle(tKey)}
            />
            {tOpen &&
              tenant.accounts.map((account) => {
                const aKey = `${tenant.tenantId}|${account.subsAccId}`;
                const aOpen = !collapsed.has(aKey);
                return (
                  <div key={aKey}>
                    <GroupHeader
                      icon={<FolderClosed size={15} aria-hidden />}
                      label={account.accName || account.subsAccId}
                      open={aOpen}
                      depth={1}
                      onClick={() => toggle(aKey)}
                    />
                    {aOpen &&
                      account.agents.map((leaf) => {
                        const lKey = `${leaf.tenantId}|${leaf.subsAccId}|${leaf.role}`;
                        const active = lKey === activeKey;
                        const badge = accessLabel(leaf.perms);
                        return (
                          <button
                            key={lKey}
                            type="button"
                            disabled={entering}
                            onClick={() => onPick(leaf)}
                            className={cn(
                              "flex w-full items-center gap-2 rounded-lg border-l-4 py-1.5 pr-2 pl-8 text-left text-sm transition-colors",
                              "disabled:opacity-60",
                              active
                                ? "border-accent bg-elevated text-fg"
                                : "border-transparent text-fg hover:bg-elevated/60",
                            )}
                          >
                            <Bot size={15} className="shrink-0 text-fg-muted" aria-hidden />
                            <span className="min-w-0 flex-1 truncate capitalize">{leaf.role}</span>
                            {badge && <Badge tone="accent">{badge}</Badge>}
                          </button>
                        );
                      })}
                  </div>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}

function GroupHeader({
  icon,
  label,
  open,
  depth,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  open: boolean;
  depth: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-lg py-1.5 pr-2 text-left transition-colors hover:bg-elevated/60",
        depth === 0 ? "pl-2" : "pl-5",
      )}
    >
      {open ? (
        <ChevronDown size={14} className="shrink-0 text-fg-muted" aria-hidden />
      ) : (
        <ChevronRight size={14} className="shrink-0 text-fg-muted" aria-hidden />
      )}
      <span className="shrink-0 text-fg-muted">{icon}</span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          depth === 0
            ? "font-mono text-xs text-fg-muted"
            : "text-sm font-medium text-fg",
        )}
        title={label}
      >
        {label}
      </span>
    </button>
  );
}
