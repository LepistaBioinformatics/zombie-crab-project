"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Surface } from "@/components/ui/surface";

// Small confirmation modal. Rendered only when open; Escape and backdrop click
// cancel. Used to guard accidental destructive actions (e.g. logout).
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  // Portal to <body> so the overlay escapes the sidebar's stacking context
  // (a z-40 pane would otherwise paint over an in-tree modal regardless of its
  // own z-index).
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onCancel} aria-hidden />
      <Surface
        level={1}
        bordered
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative z-10 w-full max-w-sm p-5"
      >
        <h2 className="font-display text-lg font-semibold text-fg">{title}</h2>
        {message && <p className="mt-2 text-sm text-fg-muted">{message}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="text" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant="filled" onClick={onConfirm} autoFocus>
            {confirmLabel}
          </Button>
        </div>
      </Surface>
    </div>,
    document.body,
  );
}
