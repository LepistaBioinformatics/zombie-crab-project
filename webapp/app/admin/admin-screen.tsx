"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { cva } from "class-variance-authority";
import { ArrowLeft, FileBox, KeyRound, ShieldCheck, Users } from "lucide-react";
import { listScopes, resolveScopeNames, type AdminScope, type ScopeRef } from "@/lib/admin";
import Logo from "@/app/logo";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { ScopeTree } from "./scope-tree";
import SharedFilesPanel from "./shared-files-panel";
import SharedSecretsPanel from "./shared-secrets-panel";
import MembersPanel from "./members-panel";

type Tab = "files" | "secrets" | "members";

const tabButton = cva(
  "flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
  {
    variants: {
      active: {
        true: "border-accent text-fg",
        false: "border-transparent text-fg-muted hover:text-fg",
      },
    },
    defaultVariants: { active: false },
  },
);

const TABS: { key: Tab; label: string; icon: React.ReactNode }[] = [
  { key: "files", label: "Shared files", icon: <FileBox size={16} aria-hidden /> },
  { key: "secrets", label: "Shared secrets", icon: <KeyRound size={16} aria-hidden /> },
  { key: "members", label: "Members", icon: <Users size={16} aria-hidden /> },
];

// The administrative screen (FR-9). Server-side authz in the proxy is the real
// gate (NFR-1); this screen is convenience. On load it fetches the caller's
// manageable scopes: empty -> "no admin access" (a direct visit stays graceful,
// never broken pickers). The nav entry link is likewise hidden when scopes are
// empty, so most users never see this route.
export default function AdminScreen() {
  const router = useRouter();
  const [scopes, setScopes] = useState<AdminScope[] | null>(null);
  const [selected, setSelected] = useState<ScopeRef | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("files");
  const [railWidth, setRailWidth] = useState(224);

  // Drag the rail's right edge to resize it (clamped); the scope tree truncates
  // within whatever width the rail has.
  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = railWidth;
    const onMove = (ev: MouseEvent) => {
      setRailWidth(Math.max(180, Math.min(startWidth + (ev.clientX - startX), 480)));
    };
    const cleanup = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", cleanup);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", cleanup);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  useEffect(() => {
    let cancelled = false;
    // Resolve tenant/subscription display names BEFORE rendering the tree so the
    // hierarchy never flashes raw uuids.
    listScopes()
      .then(resolveScopeNames)
      .then((s) => {
        if (cancelled) return;
        setScopes(s);
        const first = s[0];
        if (first) {
          setSelected({ kind: first.kind, tenantId: first.tenantId, subsAccId: first.subsAccId });
        }
      })
      .catch((e: Error) => {
        if (cancelled) return;
        if (e.message.includes("session expired")) {
          router.push("/signin");
          return;
        }
        setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  // The Members tab addresses only subscriptions (a tenant scope has no member
  // list). When it becomes active, snap the shared selection to a subscription
  // if the current one isn't already one, so the rail selection and the panel
  // always agree.
  useEffect(() => {
    if (tab !== "members" || !scopes) return;
    const subs = scopes.filter((s) => s.kind === "subscription");
    const ok =
      selected?.kind === "subscription" &&
      subs.some((s) => s.tenantId === selected.tenantId && s.subsAccId === selected.subsAccId);
    if (!ok && subs[0]) {
      setSelected({ kind: "subscription", tenantId: subs[0].tenantId, subsAccId: subs[0].subsAccId });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, scopes]);

  const subscriptionScopes = (scopes ?? []).filter((s) => s.kind === "subscription");

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-4 py-6">
      <header className="mb-6 flex items-center gap-3">
        <Link
          href="/chat"
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-fg-muted transition-colors hover:text-fg"
        >
          <ArrowLeft size={16} aria-hidden />
          Back to chat
        </Link>
        <div className="ml-auto flex items-center gap-2">
          <Logo size={26} />
          <span className="font-display text-sm font-semibold text-fg">zombie-crab</span>
        </div>
      </header>

      <div className="mb-5 flex items-center gap-2">
        <ShieldCheck size={22} className="text-accent" aria-hidden />
        <h1 className="font-display text-xl font-semibold text-fg">Administration</h1>
      </div>

      {error ? (
        <Alert severity="error">{error}</Alert>
      ) : scopes === null ? (
        <div className="flex justify-center py-16">
          <Spinner size={28} />
        </div>
      ) : scopes.length === 0 ? (
        <Alert severity="info">
          You don&apos;t have administrative authority over any scope. Ask a tenant or subscription
          manager if you think this is a mistake.
        </Alert>
      ) : (
        <>
          <nav
            className="mb-5 flex gap-1 overflow-x-auto border-b border-brand/30"
            aria-label="Admin sections"
          >
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                className={tabButton({ active: tab === t.key }) + " shrink-0"}
                onClick={() => setTab(t.key)}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </nav>

          {tab === "members" && subscriptionScopes.length === 0 ? (
            <Alert severity="info">
              You don&apos;t manage any subscriptions directly, so there are no member workspaces to
              list here.
            </Alert>
          ) : (
            // Shared shell for every tab: a scope rail beside the panel. Stacks
            // vertically on mobile (rail full-width above the panel) so the two
            // columns never sit side-by-side and overflow the screen.
            <div className="flex flex-col gap-4 md:flex-row md:gap-6">
              <aside
                style={{ width: railWidth }}
                className="relative min-w-0 overflow-hidden border-brand/20 max-md:!w-full max-md:border-b max-md:pb-4 md:shrink-0 md:border-r md:pr-4"
              >
                <ScopeTree
                  scopes={tab === "members" ? subscriptionScopes : scopes}
                  value={selected}
                  onChange={setSelected}
                  label={tab === "members" ? "Subscriptions" : "Scopes"}
                />
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize scopes"
                  onMouseDown={startResize}
                  className="absolute inset-y-0 right-0 hidden w-1.5 cursor-col-resize hover:bg-accent/40 md:block"
                />
              </aside>
              <section className="min-w-0 flex-1">
                {selected ? (
                  tab === "files" ? (
                    <SharedFilesPanel scope={selected} />
                  ) : tab === "secrets" ? (
                    <SharedSecretsPanel scope={selected} />
                  ) : (
                    <MembersPanel scope={selected} />
                  )
                ) : (
                  <p className="py-3 text-sm text-fg-muted">
                    Select a scope to manage its shared content.
                  </p>
                )}
              </section>
            </div>
          )}
        </>
      )}
    </div>
  );
}
