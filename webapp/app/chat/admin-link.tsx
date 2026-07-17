"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";

// Entry point to the admin screen, shown ONLY when the caller has manage
// authority over at least one scope (FR-9). Probes GET /api/admin/scopes once;
// renders nothing until it confirms a non-empty result, so a member with no
// authority never sees the link. The proxy is still the real gate (NFR-1).
export default function AdminLink() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/scopes")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        if (Array.isArray(data.scopes) && data.scopes.length > 0) setShow(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!show) return null;

  return (
    <Link
      href="/admin"
      className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-fg-muted transition-colors hover:bg-elevated/60 hover:text-fg"
    >
      <ShieldCheck size={16} className="shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">Administration</span>
    </Link>
  );
}
