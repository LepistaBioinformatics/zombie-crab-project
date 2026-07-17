"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { ArrowUp, Paperclip, X } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { IconButton } from "@/components/ui/icon-button";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { MEDIA_ACCEPT, type Attachment } from "@/lib/media";

const MAX_HEIGHT = 200; // ~8 rows, then the field scrolls internally

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  sending: boolean;
  loadingHistory: boolean;
  sessionId: string;
  attachments: Attachment[];
  uploading: boolean;
  attachError: string | null;
  onPickFiles: (files: FileList) => void;
  onRemoveAttachment: (path: string) => void;
}

// The signature element: a large, inviting chat box (rounded surface, violet
// border, cyan focus ring) with the send action integrated as a circular
// accent button, plus an attach control and attached-file chips. Owns auto-grow
// and the autofocus-on-open behavior.
export default function Composer({
  value,
  onChange,
  onSend,
  sending,
  loadingHistory,
  sessionId,
  attachments,
  uploading,
  attachError,
  onPickFiles,
  onRemoveAttachment,
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  useEffect(() => {
    if (!loadingHistory) ref.current?.focus();
  }, [sessionId, loadingHistory]);

  const canSend =
    (value.trim().length > 0 || attachments.length > 0) && !sending && !loadingHistory && !uploading;

  return (
    <div className="mx-auto w-full max-w-[720px]">
      {attachError && (
        <div className="mb-2">
          <Alert severity="error">{attachError}</Alert>
        </div>
      )}

      {(attachments.length > 0 || uploading) && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((a) => (
            <span
              key={a.path}
              className="inline-flex items-center gap-1 rounded-lg border border-brand/40 bg-elevated px-2 py-1 text-xs text-fg"
            >
              <Paperclip size={12} aria-hidden />
              <span className="max-w-[160px] truncate">{a.name}</span>
              <button
                type="button"
                aria-label={`Remove ${a.name}`}
                onClick={() => onRemoveAttachment(a.path)}
                className="text-fg-muted transition-colors hover:text-fg"
              >
                <X size={12} aria-hidden />
              </button>
            </span>
          ))}
          {uploading && (
            <span className="inline-flex items-center gap-1 rounded-lg border border-brand/40 bg-elevated px-2 py-1 text-xs text-fg-muted">
              <Spinner size={12} /> Uploading…
            </span>
          )}
        </div>
      )}

      <div className="flex items-end gap-2 rounded-2xl border border-brand bg-elevated px-3 py-2 transition-shadow focus-within:ring-2 focus-within:ring-accent-soft">
        <input
          ref={fileRef}
          type="file"
          accept={MEDIA_ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) onPickFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <IconButton
          variant="ghost"
          size="md"
          aria-label="Attach file"
          title="Attach file"
          disabled={sending || loadingHistory}
          onClick={() => fileRef.current?.click()}
          className="mb-0.5 shrink-0"
        >
          <Paperclip size={20} aria-hidden />
        </IconButton>
        <Textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (canSend) onSend();
            }
          }}
          placeholder="Message your agent…  (Shift+Enter for a new line)"
          className="max-h-[200px] py-1.5 leading-relaxed"
        />
        <IconButton
          variant="filled"
          size="md"
          aria-label="Send message"
          disabled={!canSend}
          onClick={onSend}
          className="mb-0.5 shrink-0"
        >
          <ArrowUp size={20} aria-hidden />
        </IconButton>
      </div>
    </div>
  );
}
