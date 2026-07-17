"use client";

import { useState } from "react";
import { Building2, ChevronDown, ChevronRight, FolderClosed } from "lucide-react";
import { cva } from "class-variance-authority";
import { scopeKey, type AdminScope, type ScopeRef } from "@/lib/admin";

// A selectable node (tenant header when it carries a tenant scope, or a
// subscription leaf): active = tonal selected fill, matching the workspace nav.
const nodeButton = cva(
  "flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 pr-2 pl-1.5 text-left text-sm transition-colors",
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

interface TenantGroup {
  tenantId: string;
  tenantName: string;
  // The selectable tenant scope, present only when the caller controls the
  // tenant itself (tenant/instance tier). A subscriptions-manager sees the
  // tenant purely as a grouping header (null) with selectable children.
  tenantScope: AdminScope | null;
  subscriptions: AdminScope[];
}

// Groups the flat /scopes list into tenant → subscription, preserving first-seen
// order so the tree is stable across reloads.
function groupScopes(scopes: AdminScope[]): TenantGroup[] {
  const order: string[] = [];
  const byId = new Map<string, TenantGroup>();
  for (const s of scopes) {
    let g = byId.get(s.tenantId);
    if (!g) {
      g = { tenantId: s.tenantId, tenantName: s.tenantName ?? s.tenantId, tenantScope: null, subscriptions: [] };
      byId.set(s.tenantId, g);
      order.push(s.tenantId);
    }
    if (s.tenantName && g.tenantName === g.tenantId) g.tenantName = s.tenantName;
    if (s.kind === "tenant") g.tenantScope = s;
    else g.subscriptions.push(s);
  }
  return order.map((id) => byId.get(id)!);
}

// A tenant → subscription tree for picking the scope to manage. Replaces the
// flat <select> so a caller sees which subscriptions belong to which tenant and
// selects within the hierarchy without getting lost. Emits a ScopeRef on click.
export function ScopeTree({
  scopes,
  value,
  onChange,
  label = "Scope",
}: {
  scopes: AdminScope[];
  value: ScopeRef | null;
  onChange: (scope: ScopeRef) => void;
  label?: string;
}) {
  const groups = groupScopes(scopes);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const selectedKey = value ? scopeKey(value) : "";

  function toggle(tenantId: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(tenantId)) next.delete(tenantId);
      else next.add(tenantId);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="font-display text-xs font-semibold uppercase tracking-wide text-fg-muted">
        {label}
      </span>
      <div role="tree" aria-label={label} className="flex min-w-0 flex-col gap-0.5">
        {groups.map((g) => {
          const open = !collapsed.has(g.tenantId);
          const tenantKey = g.tenantScope ? scopeKey(g.tenantScope) : "";
          return (
            <div key={g.tenantId} className="min-w-0">
              <div className="flex min-w-0 items-center">
                <button
                  type="button"
                  onClick={() => toggle(g.tenantId)}
                  aria-label={open ? "Collapse tenant" : "Expand tenant"}
                  aria-expanded={open}
                  className="shrink-0 rounded p-1 text-fg-muted transition-colors hover:bg-elevated/60"
                >
                  {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                </button>
                {g.tenantScope ? (
                  <button
                    type="button"
                    role="treeitem"
                    aria-selected={selectedKey === tenantKey}
                    onClick={() => onChange({ kind: "tenant", tenantId: g.tenantId })}
                    className={nodeButton({ active: selectedKey === tenantKey })}
                    title={`Tenant · ${g.tenantName}`}
                  >
                    <Building2 size={15} className="shrink-0 text-fg-muted" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{g.tenantName}</span>
                  </button>
                ) : (
                  <span
                    className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-1.5 pr-2 text-sm text-fg-muted"
                    title={`Tenant · ${g.tenantName}`}
                  >
                    <Building2 size={15} className="shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{g.tenantName}</span>
                  </span>
                )}
              </div>

              {open && (
                <div className="ml-[15px] mt-0.5 min-w-0 space-y-0.5 border-l border-brand/25 pl-2">
                  {g.subscriptions.length === 0 ? (
                    <p className="py-1 pl-1.5 text-xs text-fg-muted">No subscriptions yet.</p>
                  ) : (
                    g.subscriptions.map((sub) => {
                      const key = scopeKey(sub);
                      return (
                        <button
                          key={key}
                          type="button"
                          role="treeitem"
                          aria-selected={selectedKey === key}
                          onClick={() =>
                            onChange({ kind: "subscription", tenantId: sub.tenantId, subsAccId: sub.subsAccId })
                          }
                          className={nodeButton({ active: selectedKey === key })}
                          title={`Subscription · ${sub.accName ?? sub.subsAccId ?? ""}`}
                        >
                          <FolderClosed size={15} className="shrink-0 text-fg-muted" aria-hidden />
                          <span className="min-w-0 flex-1 truncate">{sub.accName ?? sub.subsAccId}</span>
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
