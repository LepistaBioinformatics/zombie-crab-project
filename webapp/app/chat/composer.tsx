"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowUp,
  FileArchive,
  FileText,
  Files,
  Image as ImageIcon,
  Paperclip,
  Presentation,
  Reply,
  Table2,
  X,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { IconButton } from "@/components/ui/icon-button";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { MEDIA_ACCEPT, MEDIA_CATEGORIES, acceptFor, parseAnexos, type Attachment } from "@/lib/media";
import type { ReplyTo } from "@/app/chat/chat-view";

const MAX_HEIGHT = 200; // ~8 rows, then the field scrolls internally

const CATEGORY_ICON: Record<string, typeof ImageIcon> = {
  image: ImageIcon,
  doc: FileText,
  sheet: Table2,
  slides: Presentation,
  archive: FileArchive,
};

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
  replyTo: ReplyTo | null;
  onCancelReply: () => void;
}

// The signature element: a large, inviting chat box with the send action as a
// circular accent button, plus an attach menu (categories + "Outros") and
// attached-file chips. Owns auto-grow and the autofocus-on-open behavior.
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
  replyTo,
  onCancelReply,
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  useEffect(() => {
    if (!loadingHistory) ref.current?.focus();
  }, [sessionId, loadingHistory]);

  // Picking a message to reply to drops the cursor straight into the field.
  useEffect(() => {
    if (replyTo) ref.current?.focus();
  }, [replyTo]);

  const replyPreview = replyTo
    ? parseAnexos(replyTo.content).text.replace(/\s+/g, " ").trim()
    : "";

  const canSend =
    (value.trim().length > 0 || attachments.length > 0) && !sending && !loadingHistory && !uploading;

  // Open the OS picker filtered to `accept`, then let onChange handle the files.
  function pick(accept: string) {
    setMenuOpen(false);
    const el = fileRef.current;
    if (!el) return;
    el.accept = accept;
    el.click();
  }

  return (
    <div className="mx-auto w-full max-w-[720px]">
      {attachError && (
        <div className="mb-2">
          <Alert severity="error">{attachError}</Alert>
        </div>
      )}

      {replyTo && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border-l-2 border-brand bg-elevated px-3 py-1.5">
          <Reply size={14} className="shrink-0 text-fg-muted" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-fg">
              Respondendo a {replyTo.role === "user" ? "você" : "agente"}
            </div>
            <div className="truncate text-xs text-fg-muted">{replyPreview || "(sem texto)"}</div>
          </div>
          <button
            type="button"
            aria-label="Cancelar resposta"
            onClick={onCancelReply}
            className="shrink-0 text-fg-muted transition-colors hover:text-fg"
          >
            <X size={14} aria-hidden />
          </button>
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

        <div className="relative">
          <IconButton
            variant="ghost"
            size="md"
            aria-label="Attach file"
            title="Attach file"
            disabled={sending || loadingHistory}
            onClick={() => setMenuOpen((o) => !o)}
            className="mb-0.5 shrink-0"
          >
            <Paperclip size={20} aria-hidden />
          </IconButton>

          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} aria-hidden />
              <div className="absolute bottom-full left-0 z-20 mb-2 w-56 rounded-xl border border-brand bg-surface p-1 shadow-xl">
                {MEDIA_CATEGORIES.map((cat) => {
                  const Icon = CATEGORY_ICON[cat.key] ?? Files;
                  return (
                    <button
                      key={cat.key}
                      type="button"
                      onClick={() => pick(acceptFor(cat.exts))}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-fg transition-colors hover:bg-elevated"
                    >
                      <Icon size={16} className="shrink-0 text-fg-muted" aria-hidden />
                      {cat.label}
                    </button>
                  );
                })}
                <div className="my-1 border-t border-brand/20" />
                <button
                  type="button"
                  onClick={() => pick(MEDIA_ACCEPT)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-fg transition-colors hover:bg-elevated"
                >
                  <Files size={16} className="shrink-0 text-fg-muted" aria-hidden />
                  Outros tipos
                </button>
              </div>
            </>
          )}
        </div>

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
