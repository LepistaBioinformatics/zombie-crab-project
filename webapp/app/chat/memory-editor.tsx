"use client";

import { useEffect, useState } from "react";
import { Brain, Check, ChevronDown, ChevronRight, Save } from "lucide-react";
import { readMemory, writeMemory } from "@/lib/memory";
import type { Workspace } from "./fragment";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Alert } from "@/components/ui/alert";

const OPEN_KEY = "chat-memory-open";

// A collapsible editor for the workspace's MEMORY_CUSTOM.md -- standing notes
// the user writes for the agent, read at turn time. Lives at the top of the
// workspace panel, above the files list. The load is keyed to the workspace
// ONLY (never a file-refresh signal), so uploading a file can't clobber an
// in-progress edit.
export default function MemoryEditor({ workspace }: { workspace: Workspace }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOpen(localStorage.getItem(OPEN_KEY) === "1");
  }, []);

  // A real workspace switch drops the loaded doc so it reloads on next open.
  useEffect(() => {
    setLoaded(false);
    setValue("");
    setError(null);
    setSaved(false);
  }, [workspace.t, workspace.s, workspace.r]);

  // Load lazily the first time the section is open for this workspace. `loading`
  // is deliberately NOT a dependency: including it would make setLoading(true)
  // re-run this effect and its cleanup would cancel the in-flight fetch (spinner
  // stuck forever). The `loaded` guard already prevents a second fetch.
  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;
    setLoading(true);
    readMemory(workspace)
      .then((content) => {
        if (!cancelled) {
          setValue(content);
          setLoaded(true);
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loaded, workspace.t, workspace.s, workspace.r]);

  function toggle() {
    setOpen((o) => {
      const next = !o;
      localStorage.setItem(OPEN_KEY, next ? "1" : "0");
      return next;
    });
  }

  async function onSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await writeMemory(workspace, value);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the memory.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border-b border-brand/30">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-elevated"
      >
        {open ? (
          <ChevronDown size={14} className="shrink-0 text-fg-muted" aria-hidden />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-fg-muted" aria-hidden />
        )}
        <Brain size={16} className="shrink-0 text-accent" aria-hidden />
        <span className="flex-1 font-display text-sm font-semibold text-fg">Workspace memory</span>
      </button>

      {open && (
        <div className="px-3 pb-3">
          <p className="mb-2 text-[11px] leading-snug text-fg-muted">
            Saved to MEMORY_CUSTOM.md — the agent reads it on every message.
          </p>

          {loading ? (
            <div className="flex justify-center py-4">
              <Spinner size={20} />
            </div>
          ) : (
            <>
              <div className="rounded-lg border border-brand/30 bg-elevated p-2 focus-within:ring-2 focus-within:ring-accent-soft">
                <Textarea
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="e.g. Always answer in Portuguese. Our stack is Next.js + Go…"
                  className="h-40 overflow-auto font-mono text-xs leading-relaxed"
                />
              </div>

              {error && (
                <div className="mt-2">
                  <Alert severity="error">{error}</Alert>
                </div>
              )}

              <div className="mt-2 flex items-center gap-2">
                <Button size="sm" variant="filled" onClick={onSave} disabled={saving || !loaded}>
                  {saving ? <Spinner size={14} /> : <Save size={14} aria-hidden />}
                  Save
                </Button>
                {saved && (
                  <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
                    <Check size={13} aria-hidden /> Saved
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
