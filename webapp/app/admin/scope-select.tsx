"use client";

import { Building2, FolderClosed } from "lucide-react";
import { scopeKey, type AdminScope, type ScopeRef } from "@/lib/admin";

const selectClass =
  "h-11 w-full rounded-lg border border-brand bg-elevated px-3 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft";

export function scopeLabel(scope: AdminScope): string {
  if (scope.kind === "tenant") {
    return `Tenant · ${scope.tenantName ?? scope.tenantId}`;
  }
  return `Subscription · ${scope.accName ?? scope.subsAccId ?? ""}`;
}

// A labeled <select> over the caller's manageable scopes. Emits a ScopeRef
// (the addressing subset) on change. The selected scope drives the file/secret
// panels below it.
export function ScopeSelect({
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
  const selectedKey = value ? scopeKey(value) : "";
  const Icon = value?.kind === "tenant" ? Building2 : FolderClosed;

  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-fg-muted">{label}</span>
      <div className="relative">
        <Icon
          size={16}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted"
          aria-hidden
        />
        <select
          className={selectClass + " pl-9"}
          value={selectedKey}
          onChange={(e) => {
            const picked = scopes.find((s) => scopeKey(s) === e.target.value);
            if (picked) {
              onChange({ kind: picked.kind, tenantId: picked.tenantId, subsAccId: picked.subsAccId });
            }
          }}
        >
          {scopes.map((s) => {
            const key = scopeKey(s);
            return (
              <option key={key} value={key}>
                {scopeLabel(s)}
              </option>
            );
          })}
        </select>
      </div>
    </label>
  );
}
