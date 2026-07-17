"use client";

import { useEffect, useState } from "react";
import { FileText, RefreshCw, X } from "lucide-react";
import { listWorkspaceMedia, type Attachment } from "@/lib/media";
import type { Workspace } from "./fragment";
import { IconButton } from "@/components/ui/icon-button";
import { Spinner } from "@/components/ui/spinner";
import { Alert } from "@/components/ui/alert";

function formatSize(bytes?: number): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// A permanent right-hand column (desktop) listing the files in the current
// workspace's uploads dir. Unlike the secrets slide-over, this is part of the
// layout, toggled open/closed. Refreshes when `refreshSignal` changes (e.g.
// after a new upload).
export default function UploadsSidebar({
  workspace,
  refreshSignal,
  onClose,
}: {
  workspace: Workspace;
  refreshSignal: number;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<Attachment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localRefresh, setLocalRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFiles(null);
    setError(null);
    listWorkspaceMedia(workspace)
      .then((list) => {
        if (!cancelled) setFiles(list);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace.t, workspace.s, workspace.r, refreshSignal, localRefresh]);

  return (
    <aside className="hidden w-[280px] shrink-0 flex-col border-l border-brand/30 bg-surface md:flex">
      <div className="flex items-center gap-2 border-b border-brand/30 px-3 py-2">
        <FileText size={16} className="text-accent" aria-hidden />
        <h2 className="flex-1 font-display text-sm font-semibold text-fg">Workspace files</h2>
        <IconButton
          variant="ghost"
          size="sm"
          aria-label="Refresh files"
          title="Refresh"
          onClick={() => setLocalRefresh((n) => n + 1)}
        >
          <RefreshCw size={15} aria-hidden />
        </IconButton>
        <IconButton variant="ghost" size="sm" aria-label="Close files panel" onClick={onClose}>
          <X size={16} aria-hidden />
        </IconButton>
      </div>

      <div className="flex-1 overflow-auto p-2">
        <p className="mb-2 px-1 text-[11px] leading-relaxed text-fg-muted">
          Files you uploaded to <strong className="text-fg">agent {workspace.r}</strong>&apos;s
          workspace. The agent reads them by their <code className="font-mono">uploads/…</code> path.
        </p>

        {error && <Alert severity="error">{error}</Alert>}

        {!error && files === null && (
          <div className="flex justify-center py-4">
            <Spinner size={20} />
          </div>
        )}

        {files !== null && files.length === 0 && (
          <p className="py-3 text-center text-sm text-fg-muted">No files uploaded yet.</p>
        )}

        <ul className="flex flex-col gap-1">
          {(files ?? []).map((f) => (
            <li
              key={f.path}
              className="flex items-center gap-2 rounded-lg border border-brand/30 bg-elevated px-2 py-1.5"
            >
              <FileText size={14} className="shrink-0 text-fg-muted" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-sm text-fg" title={f.path}>
                {f.name}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-fg-muted">{formatSize(f.size)}</span>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
