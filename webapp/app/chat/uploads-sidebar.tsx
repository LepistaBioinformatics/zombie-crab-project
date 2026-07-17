"use client";

import { MouseEvent, useEffect, useState } from "react";
import { FileText, RefreshCw, Search, Trash2, X } from "lucide-react";
import { listWorkspaceMedia, deleteMedia, type Attachment } from "@/lib/media";
import type { Workspace } from "./fragment";
import AttachmentButton from "@/app/chat/attachment-button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Alert } from "@/components/ui/alert";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

const MIN_WIDTH = 240;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 280;
const WIDTH_KEY = "chat-files-width";

function formatSize(bytes?: number): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// A permanent, resizable right-hand column (desktop) listing the current
// workspace's uploads. Not an overlay -- part of the layout, toggled from the
// chat header. Filter box + per-file delete. Refreshes on `refreshSignal`.
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
  const [query, setQuery] = useState("");
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);

  useEffect(() => {
    const raw = Number(localStorage.getItem(WIDTH_KEY));
    if (raw >= MIN_WIDTH && raw <= MAX_WIDTH) setWidth(raw);
  }, []);
  useEffect(() => {
    localStorage.setItem(WIDTH_KEY, String(width));
  }, [width]);

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

  function startResize(e: MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const onMove = (ev: globalThis.MouseEvent) => {
      // Right-hand column: dragging the LEFT edge leftward widens it.
      const next = startWidth + (startX - ev.clientX);
      setWidth(Math.max(MIN_WIDTH, Math.min(next, MAX_WIDTH)));
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

  async function onDelete(path: string) {
    setDeleteError(null);
    try {
      await deleteMedia(workspace, path);
      setFiles((prev) => (prev ? prev.filter((f) => f.path !== path) : prev));
      setDeletingPath(null);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Couldn't delete this file.");
    }
  }

  const q = query.trim().toLowerCase();
  const visible = (files ?? []).filter((f) => !q || f.name.toLowerCase().includes(q));
  const pending = deletingPath ? (files ?? []).find((f) => f.path === deletingPath) : null;

  return (
    <>
      {/* On mobile the panel is an overlay drawer; the backdrop dismisses it. */}
      <div className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={onClose} aria-hidden />
      <aside
        style={{ width }}
        className="relative flex shrink-0 flex-col border-l border-brand/30 bg-surface max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-50 max-md:max-w-[90vw] max-md:shadow-xl"
      >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Workspace files"
        onMouseDown={startResize}
        className="absolute inset-y-0 left-0 z-10 hidden w-1.5 cursor-col-resize hover:bg-accent/40 md:block"
      />

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

      <div className="px-2 pt-2">
        <div className="relative">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted"
          />
          <Input
            variant="subtle"
            inputSize="sm"
            className="pl-9"
            placeholder="Filter files"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="flex-1 overflow-auto p-2">
        {error && <Alert severity="error">{error}</Alert>}

        {!error && files === null && (
          <div className="flex justify-center py-4">
            <Spinner size={20} />
          </div>
        )}

        {files !== null && visible.length === 0 && (
          <p className="py-3 text-center text-sm text-fg-muted">
            {q ? "No matches." : "No files uploaded yet."}
          </p>
        )}

        <ul className="flex flex-col gap-1">
          {visible.map((f) => (
            <li
              key={f.path}
              className="group flex items-center gap-2 rounded-lg border border-brand/30 bg-elevated px-2 py-1.5"
            >
              <FileText size={14} className="shrink-0 text-fg-muted" aria-hidden />
              <AttachmentButton workspace={workspace} path={f.path} name={f.name} tone="row" />
              <span className="shrink-0 font-mono text-[11px] text-fg-muted">{formatSize(f.size)}</span>
              <IconButton
                variant="ghost"
                size="sm"
                aria-label={`Delete ${f.name}`}
                title="Delete"
                onClick={() => {
                  setDeleteError(null);
                  setDeletingPath(f.path);
                }}
                className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
              >
                <Trash2 size={14} aria-hidden />
              </IconButton>
            </li>
          ))}
        </ul>
      </div>

      <ConfirmDialog
        open={deletingPath !== null}
        title="Delete file?"
        message={
          deleteError ??
          `"${pending?.name ?? "This file"}" is removed from the workspace. The agent can no longer read it.`
        }
        confirmLabel="Delete"
        onConfirm={() => deletingPath && onDelete(deletingPath)}
        onCancel={() => {
          setDeletingPath(null);
          setDeleteError(null);
        }}
      />
      </aside>
    </>
  );
}
