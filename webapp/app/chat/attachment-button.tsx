"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cva } from "class-variance-authority";
import { Download, Paperclip } from "lucide-react";
import { downloadMedia } from "@/lib/media";
import type { Workspace } from "./fragment";

// A clickable file reference. Clicking does NOT download directly — it opens a
// small menu offering "Baixar arquivo". The menu is portaled to <body> with
// fixed positioning so it never gets clipped by an overflow container (e.g. the
// files sidebar list or a chat bubble).
const trigger = cva("inline-flex min-w-0 items-center gap-1 text-left", {
  variants: {
    tone: {
      chip: "max-w-full rounded-lg border border-current/25 px-2 py-1 text-xs hover:bg-current/10",
      row: "flex-1 text-sm text-fg hover:underline",
    },
  },
  defaultVariants: { tone: "chip" },
});

export default function AttachmentButton({
  workspace,
  path,
  name,
  tone = "chip",
}: {
  workspace: Workspace;
  path: string;
  name: string;
  tone?: "chip" | "row";
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ x: r.left, y: r.bottom + 4 });
    }
    setError(null);
    setOpen((o) => !o);
  }

  async function onDownload() {
    setBusy(true);
    setError(null);
    try {
      await downloadMedia(workspace, path, name);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao baixar o arquivo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="relative inline-flex min-w-0">
      <button ref={btnRef} type="button" onClick={toggle} className={trigger({ tone })} title={name}>
        {tone === "chip" && <Paperclip size={12} className="shrink-0" aria-hidden />}
        <span className="truncate">{name}</span>
      </button>

      {open &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[55]" onClick={() => setOpen(false)} aria-hidden />
            <div
              style={{ position: "fixed", left: pos.x, top: pos.y }}
              className="z-[60] w-48 rounded-lg border border-brand bg-surface p-1 shadow-xl"
            >
              <button
                type="button"
                onClick={onDownload}
                disabled={busy}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-fg transition-colors hover:bg-elevated disabled:opacity-60"
              >
                <Download size={15} className="shrink-0 text-fg-muted" aria-hidden />
                {busy ? "Baixando…" : "Baixar arquivo"}
              </button>
              {error && <p className="px-2 py-1 text-xs text-red-500">{error}</p>}
            </div>
          </>,
          document.body,
        )}
    </span>
  );
}
