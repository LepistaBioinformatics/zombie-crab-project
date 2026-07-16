"use client";

import { useEffect, useState } from "react";
import { isInstance, type Instance } from "@/lib/mycelium";

// The selected workspace + session live ONLY in the URL fragment as a single
// `#` followed by `&`-separated `key=value` pairs
// (`#t=..&s=..&r=..&sid=..`), parsed with URLSearchParams -- the standard
// fragment-as-query convention (workspace-selection DEC-2). The fragment is
// never sent to any server: the client reads it and passes the ids explicitly
// in the chat POST body, so the workspace ids never appear in request logs.

export interface Workspace {
  t: string; // tenantId
  s: string; // subsAccId
  r: Instance; // role
}

export interface FragmentState {
  t?: string;
  s?: string;
  r?: string;
  sid?: string;
}

export function fragmentHash(workspace: Workspace, sid: string): string {
  const params = new URLSearchParams({ t: workspace.t, s: workspace.s, r: workspace.r, sid });
  return `#${params.toString()}`;
}

function readFragment(): FragmentState {
  const params = new URLSearchParams(window.location.hash.slice(1));
  return {
    t: params.get("t") ?? undefined,
    s: params.get("s") ?? undefined,
    r: params.get("r") ?? undefined,
    sid: params.get("sid") ?? undefined,
  };
}

// Sets `sid` on the current fragment while preserving t/s/r. Assigning
// `location.hash` (rather than router.push) fires a native `hashchange` so
// every subscriber re-renders, and adds a history entry so Back moves between
// conversations.
export function setFragmentSid(sid: string): void {
  const params = new URLSearchParams(window.location.hash.slice(1));
  params.set("sid", sid);
  window.location.hash = params.toString();
}

// `null` means "not read yet" (first client render, before the mount effect
// runs) -- distinct from "read and empty", so callers don't redirect a valid
// fragment away on the initial paint before the hash has been parsed.
export function useFragment(): FragmentState | null {
  const [fragment, setFragment] = useState<FragmentState | null>(null);

  useEffect(() => {
    const sync = () => setFragment(readFragment());
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  return fragment;
}

export function toWorkspace(fragment: FragmentState): Workspace | null {
  if (!fragment.t || !fragment.s || !fragment.r || !isInstance(fragment.r)) return null;
  return { t: fragment.t, s: fragment.s, r: fragment.r };
}

// History is fetched via the BFF, which forwards tenant_id/subs_acc_id (read
// here from the fragment) to the proxy's session-history route.
export function historyQuery(workspace: Workspace, sessionId: string): string {
  return new URLSearchParams({
    session_id: sessionId,
    tenant_id: workspace.t,
    subs_acc_id: workspace.s,
  }).toString();
}
